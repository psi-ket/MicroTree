import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { E2E_MOCK_OLLAMA_URL, E2E_PAIRING_TOKEN, E2E_RUNTIME_URL, E2E_WEB_URL } from '../playwright.config';

const AXE = readFileSync(fileURLToPath(new URL('../apps/web/node_modules/axe-core/axe.min.js', import.meta.url)), 'utf8');
const shot = async (page: Page, name: string) => {
  if (process.env.RS_E2E_SHOTS) await page.screenshot({ path: `${process.env.RS_E2E_SHOTS}/${name}.png` });
};

async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ content: AXE });
  return page.evaluate(async () => {
    const res = await (window as unknown as { axe: { run(ctx: object, opts: object): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run(
      { exclude: [['[data-sonner-toaster]'], ['.monaco-editor']] },
      { resultTypes: ['violations'] },
    );
    return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

// A small synthetic PNG (the mock model does not read it; the runtime validates and stores it).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const MAIN = '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\nIntroduction.\n\\end{document}\n';

async function api(request: APIRequestContext) {
  const headers = { origin: E2E_WEB_URL };
  const session = await request.post(`${E2E_RUNTIME_URL}/api/v1/auth/session`, { headers, data: { pairingToken: E2E_PAIRING_TOKEN } });
  const auth = { ...headers, authorization: `Bearer ${((await session.json()) as { sessionToken: string }).sessionToken}` };
  return {
    get: async (p: string) => (await request.get(`${E2E_RUNTIME_URL}/api/v1${p}`, { headers: auth })).json(),
    post: async (p: string, data: unknown) => (await request.post(`${E2E_RUNTIME_URL}/api/v1${p}`, { headers: auth, data })).json(),
    put: async (p: string, data: unknown) => (await request.put(`${E2E_RUNTIME_URL}/api/v1${p}`, { headers: auth, data })).json(),
  };
}

test('reconstruct an equation and a plot locally, compile, approve, insert after review and roll back', async ({ page, request }) => {
  const rt = await api(request);
  const requestsBefore = ((await (await request.get(`${E2E_MOCK_OLLAMA_URL}/__stats`)).json()) as { requests: number }).requests;
  const { project } = (await rt.post('/projects', { name: 'Visual E2E', template: 'empty' })) as { project: { id: string } };
  await rt.put(`/projects/${project.id}/files/content`, { path: 'main.tex', content: MAIN });
  const { provider } = (await rt.post('/ai/providers', { kind: 'ollama', displayName: 'Mock Ollama', baseUrl: E2E_MOCK_OLLAMA_URL, defaultModel: 'llava-vision-mock' })) as { provider: { id: string } };

  await page.goto(`/#runtime=${encodeURIComponent(E2E_RUNTIME_URL)}&token=${E2E_PAIRING_TOKEN}`);
  await page.getByTestId('open-library').waitFor();
  await page.goto(`/#/visual?from=${project.id}`);
  const studio = page.getByTestId('visual-studio');
  await expect(studio.getByRole('heading', { name: 'Visual Studio' })).toBeVisible();

  // Upload and reconstruct an equation with the local (mock) vision model.
  await studio.getByTestId('file-input').setInputFiles({ name: 'schrodinger.png', mimeType: 'image/png', buffer: PNG });
  await expect(studio.getByTestId('input-image')).toBeVisible();
  await studio.getByTestId('task-type').selectOption('equation');
  await studio.getByTestId('provider').selectOption(provider.id);
  await expect(studio.getByTestId('model')).toHaveValue('llava-vision-mock');
  await expect(studio.getByText('Runs on this computer; nothing leaves it.')).toBeVisible();
  await studio.getByTestId('run-task').click();
  // Local: no consent dialog. The real pdfLaTeX compile runs in an isolated folder.
  await expect(studio.getByTestId('compile-status')).toHaveText('Compiled', { timeout: 90_000 });
  await expect(page.getByTestId('consent-dialog')).toHaveCount(0);
  await expect(studio.getByTestId('source-editor')).toContainText('hbar');
  await expect(studio.getByTestId('result-view').locator('canvas').first()).toBeVisible();
  await shot(page, 'visual-1-equation');
  expect(await axeViolations(page)).toEqual([]);

  // Approve, review the insertion, apply it, then undo it.
  await studio.getByTestId('approve').click();
  await expect(studio.getByTestId('approve')).toHaveText(/Approved/);
  await studio.getByTestId('open-insert').click();
  const dialog = page.getByTestId('insert-dialog');
  await dialog.getByLabel('Label').fill('eq:schrodinger');
  await dialog.getByTestId('review-insertion').click();
  await expect(dialog.getByTestId('insertion-plan')).toContainText('main.tex');
  let main = (await rt.get(`/projects/${project.id}/files/content?path=main.tex`)) as { content: string };
  expect(main.content).toBe(MAIN); // reviewing writes nothing
  await shot(page, 'visual-2-insert-review');
  await dialog.getByTestId('apply-insertion').click();
  await expect(dialog.getByTestId('rollback')).toBeVisible();
  main = (await rt.get(`/projects/${project.id}/files/content?path=main.tex`)) as { content: string };
  expect(main.content).toContain('\\label{eq:schrodinger}');
  expect(main.content).toContain('\\hat{H}');
  await dialog.getByTestId('rollback').click();
  await expect(dialog.getByText('undone')).toBeVisible();
  main = (await rt.get(`/projects/${project.id}/files/content?path=main.tex`)) as { content: string };
  expect(main.content).toBe(MAIN);
  await dialog.getByRole('button', { name: 'Close' }).first().click();

  // A plot: digitised values become CSV and PGFPlots; restyling makes a new version without asking the model.
  await studio.getByTestId('task-type').selectOption('plot');
  await studio.getByTestId('run-task').click();
  await expect(studio.getByRole('toolbar', { name: 'Result actions' })).toContainText('version 1', { timeout: 60_000 });
  await expect(studio.getByTestId('compile-status')).toHaveText('Compiled', { timeout: 90_000 });
  await studio.getByTestId('visual-source').getByRole('button', { name: 'CSV' }).click();
  await expect(studio.getByTestId('plot-csv')).toHaveValue(/s1_x/);
  await studio.getByTestId('visual-bottom').getByRole('button', { name: /Warnings/ }).click();
  await expect(studio.getByTestId('warnings')).toContainText('digitised from the image');
  await studio.getByTestId('visual-source').getByRole('button', { name: 'Axes & style' }).click();
  await studio.getByTestId('plot-settings').getByLabel('Black and white').check();
  await studio.getByTestId('apply-style').click();
  await expect(studio.getByRole('toolbar', { name: 'Result actions' })).toContainText('version 2');
  await expect(studio.getByTestId('compile-status')).toHaveText('Compiled', { timeout: 90_000 });
  const stats = (await (await request.get(`${E2E_MOCK_OLLAMA_URL}/__stats`)).json()) as { requests: number };
  expect(stats.requests - requestsBefore).toBe(2); // one per reconstruction, none for the restyle
  await studio.getByTestId('visual-bottom').getByRole('button', { name: /Versions/ }).click();
  await expect(studio.getByTestId('versions').locator('tbody tr')).toHaveCount(2);
  await shot(page, 'visual-3-plot');

  // Phone width: the panels become tabs and nothing scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(studio.getByRole('navigation', { name: 'Visual Studio panels' })).toBeVisible();
  for (const tab of ['input', 'preview', 'source', 'details']) {
    await studio.getByRole('navigation', { name: 'Visual Studio panels' }).getByRole('button', { name: tab }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
  expect(await axeViolations(page)).toEqual([]);
  await shot(page, 'visual-4-phone');
});
