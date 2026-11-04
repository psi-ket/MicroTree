import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { lines, makeLayoutPdf } from '../packages/document-intelligence/test/fixtures/make-pdf';
import { E2E_MOCK_OLLAMA_URL, E2E_PAIRING_TOKEN, E2E_RUNTIME_URL, E2E_WEB_URL } from '../playwright.config';

const AXE = readFileSync(fileURLToPath(new URL('../apps/web/node_modules/axe-core/axe.min.js', import.meta.url)), 'utf8');
const shot = async (page: Page, name: string) => {
  if (process.env.RS_E2E_SHOTS) await page.screenshot({ path: `${process.env.RS_E2E_SHOTS}/${name}.png` });
};
/** axe on the whole page, or (for the workspace, whose older panels are outside M5) on one part with page-level rules off. */
async function axeViolations(page: Page, include?: string): Promise<string[]> {
  await page.addScriptTag({ content: AXE });
  return page.evaluate(async (inc) => {
    const ctx = inc ? { include: [[inc]] } : { exclude: [['[data-sonner-toaster]'], ['.monaco-editor']] };
    const rules = inc ? { region: { enabled: false }, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } } : {};
    const res = await (window as unknown as { axe: { run(ctx: object, opts: object): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run(ctx, { resultTypes: ['violations'], rules });
    return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  }, include ?? null);
}

// A synthetic paper (constructed for this test, not real literature).
const PAPER = makeLayoutPdf(
  [{ texts: [{ x: 72, y: 720, text: 'Synthetic Threshold Notes', size: 18 }, ...lines(72, 680, ['We simulate planar codes with a matching decoder.', 'We find a threshold of about one percent for the surface code under depolarising noise.', 'Decoding time grows polynomially.'])] }],
  { Title: 'Synthetic Threshold Notes', Author: 'Ada Synthetic' },
);
const SENTENCE = 'The threshold of the surface code is about one percent for depolarising noise.';
const MAIN = `\\documentclass{article}\n\\begin{document}\n\\section{Introduction}\n${SENTENCE}\n\\end{document}\n`;

async function api(request: APIRequestContext) {
  const headers = { origin: E2E_WEB_URL };
  const session = await request.post(`${E2E_RUNTIME_URL}/api/v1/auth/session`, { headers, data: { pairingToken: E2E_PAIRING_TOKEN } });
  const auth = { ...headers, authorization: `Bearer ${((await session.json()) as { sessionToken: string }).sessionToken}` };
  const u = (p: string) => `${E2E_RUNTIME_URL}/api/v1${p}`;
  return {
    get: async (p: string) => (await request.get(u(p), { headers: auth })).json(),
    post: async (p: string, data: unknown) => (await request.post(u(p), { headers: auth, data })).json(),
    put: async (p: string, data: unknown) => (await request.put(u(p), { headers: auth, data })).json(),
    patch: async (p: string, data: unknown) => (await request.patch(u(p), { headers: auth, data })).json(),
    upload: async (p: string, name: string, bytes: Buffer) => (await request.post(u(p), { headers: auth, multipart: { file: { name, mimeType: 'application/pdf', buffer: bytes } } })).json(),
  };
}

test.afterAll(async ({ request }) => {
  const rt = await api(request);
  const list = (await rt.get('/library/items?q=Synthetic%20Threshold')) as { items: { id: string }[] };
  if (list.items.length) await rt.post('/library/items/delete', { itemIds: list.items.map((i) => i.id) });
});

test('select a sentence, find its claim and evidence, assess it locally, insert a reviewed citation and review coverage', async ({ page, request }) => {
  const rt = await api(request);
  const { project } = (await rt.post('/projects', { name: 'Evidence E2E', template: 'empty' })) as { project: { id: string } };
  await rt.put(`/projects/${project.id}/files/content`, { path: 'main.tex', content: MAIN });
  const { provider } = (await rt.post('/ai/providers', { kind: 'ollama', displayName: 'Mock Ollama (evidence)', baseUrl: E2E_MOCK_OLLAMA_URL, defaultModel: 'llama-mock' })) as { provider: { id: string } };
  await rt.patch(`/projects/${project.id}/evidence-settings`, { models: { assessment: { providerId: provider.id, model: 'llama-mock' } } });
  // The paper: imported and processed (PyMuPDF; there is no GROBID in the E2E environment).
  const imp = (await rt.upload('/library/imports/pdf', 'threshold.pdf', PAPER)) as { job: { id: string } };
  let itemId = '';
  await expect
    .poll(async () => {
      const j = (await rt.get(`/library/jobs/${imp.job.id}`)) as { job: { status: string; items: { libraryItemId: string | null }[] } };
      itemId = j.job.items[0]?.libraryItemId ?? '';
      return j.job.status;
    }, { timeout: 60_000 })
    .toMatch(/completed|partial/);
  const item = (await rt.get(`/library/items/${itemId}`)) as { item: { attachments: { id: string }[] } };
  await rt.post(`/documents/${item.item.attachments[0]!.id}/process`, {});
  await expect.poll(async () => ((await rt.get(`/documents/${item.item.attachments[0]!.id}/status`)) as { extraction: { status: string } | null }).extraction?.status ?? 'none', { timeout: 90_000 }).toMatch(/completed|partial/);

  await page.goto(`/#runtime=${encodeURIComponent(E2E_RUNTIME_URL)}&token=${E2E_PAIRING_TOKEN}`);
  await page.getByTestId('open-library').waitFor();
  await page.goto(`/#/p/${project.id}`);
  const editor = page.locator('.monaco-editor').first();
  await expect(editor).toContainText('depolarising noise', { timeout: 30_000 });

  // Select the claim's line and check its evidence from the context menu action.
  await editor.click();
  await page.keyboard.press('Control+Home');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Home');
  await page.keyboard.press('Control+L'); // select the whole logical line (it wraps on screen)
  await page.getByRole('button', { name: 'Evidence', exact: true }).click();
  const panel = page.getByTestId('evidence-panel');
  await expect(panel.getByTestId('selected-text')).toContainText(SENTENCE);
  await panel.getByTestId('extract-claims').click();
  const card = panel.getByTestId('claim-card').first();
  await expect(card.getByTestId('claim-text')).toHaveText(SENTENCE);
  await expect(card.getByTestId('claim-status')).toHaveText('Not checked');

  // Retrieve exact passages, then assess with the local (mock) model: no consent dialog.
  await card.getByTestId('find-evidence').click();
  await expect(card.getByTestId('evidence-item').first()).toContainText('Synthetic Threshold Notes');
  await expect(card.getByTestId('evidence-passage').first()).toContainText('about one percent');
  await card.getByTestId('assess-claim').click();
  await expect(card.getByTestId('claim-status')).toHaveText('Supporting evidence found', { timeout: 30_000 });
  await expect(page.getByTestId('evidence-consent')).toHaveCount(0);
  const supporting = card.getByRole('region', { name: 'Supporting literature' });
  await expect(supporting.locator('mark')).toContainText('one percent');
  await shot(page, 'evidence-1-panel');
  expect(await axeViolations(page, '[data-testid="evidence-panel"]')).toEqual([]);

  // Accept the assessment, get a citation recommendation, review both diffs, apply.
  await supporting.getByRole('button', { name: 'Accept assessment' }).click();
  await card.getByTestId('recommend-citations').click();
  await card.getByTestId('insert-citation').click();
  const dialog = page.getByTestId('evidence-proposal');
  await expect(dialog.getByTestId('proposal-diff')).toBeVisible();
  await expect(dialog.getByTestId('bib-diff')).toBeVisible();
  let main = (await rt.get(`/projects/${project.id}/files/content?path=main.tex`)) as { content: string };
  expect(main.content).toBe(MAIN); // nothing written before acceptance
  await shot(page, 'evidence-2-citation-review');
  await dialog.getByTestId('accept-proposal').click();
  await expect(dialog).toHaveCount(0);
  main = (await rt.get(`/projects/${project.id}/files/content?path=main.tex`)) as { content: string };
  expect(main.content).toMatch(/depolarising noise~\\cite\{[^}]+\}\./);
  const bib = (await rt.get(`/projects/${project.id}/files/content?path=references.bib`)) as { content: string };
  expect(bib.content).toContain('Synthetic Threshold Notes');

  // Evidence Review Mode: coverage with denominators.
  await page.getByTestId('open-review').click();
  const review = page.getByTestId('evidence-review');
  await expect(review.getByTestId('coverage')).toContainText('1 of 1');
  await expect(review.getByTestId('coverage')).toContainText('there is no overall score');
  await expect(review.getByTestId('claim-card')).toHaveCount(1);
  await shot(page, 'evidence-3-review');
  expect(await axeViolations(page)).toEqual([]);
});
