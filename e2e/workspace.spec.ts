import { deflateSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { E2E_PAIRING_TOKEN, E2E_RUNTIME_URL } from '../playwright.config';

/** A small valid RGB PNG (no external fixture files needed). */
function makePng(width = 64, height = 40): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.concat(
    Array.from({ length: height }, (_, y) =>
      Buffer.concat([Buffer.from([0]), ...Array.from({ length: width }, (_, x) => Buffer.from([x * 4, y * 6, 160]))]),
    ),
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const editor = (page: Page) => page.locator('.monaco-editor').first();

/** Types lines into Monaco, closing the suggest widget before each newline. */
async function typeLines(page: Page, lines: string[]) {
  for (const line of lines) {
    await page.keyboard.type(line);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
  }
}

async function replaceEditorContent(page: Page, lines: string[]) {
  await editor(page).click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await typeLines(page, lines);
}

/** Starts a compile with Ctrl+Enter and waits for that specific job to finish. */
async function compile(page: Page): Promise<string> {
  const response = page.waitForResponse((r) => r.url().endsWith('/compile') && r.request().method() === 'POST');
  await page.keyboard.press('Control+Enter');
  const { job } = (await (await response).json()) as { job: { id: string } };
  const status = page.locator(`[data-testid=compile-status][data-job-id="${job.id}"]`);
  await expect(status).toHaveAttribute('data-status', /succeeded|failed|error|cancelled/, { timeout: 120_000 });
  return (await status.getAttribute('data-status')) ?? '';
}

test('create a project, edit several files, upload an image, compile, inspect errors and reload', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // Pair through the link printed by the runtime; the token is scrubbed from the URL.
  await page.goto(`/#runtime=${encodeURIComponent(E2E_RUNTIME_URL)}&token=${E2E_PAIRING_TOKEN}`);
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  expect(page.url()).not.toContain('token=');

  // Create a project from the article template.
  await page.getByTestId('new-project').click();
  await page.getByLabel('Name', { exact: true }).fill('E2E Paper');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByTestId('project-title')).toHaveText('E2E Paper');
  await expect(page.getByTestId('tab-main.tex')).toBeVisible();
  await expect(editor(page)).toBeVisible();

  // A second .tex file, created from the explorer.
  await page.getByRole('button', { name: 'New file' }).click();
  await page.getByPlaceholder('New file name, e.g. methods.tex').fill('methods.tex');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('tab-methods.tex')).toBeVisible();
  await editor(page).click();
  await typeLines(page, ['\\section{Methods}', 'The sample is shown in Figure~\\ref{fig:sample}.']);

  // Upload an image into figures/.
  await page.getByTestId('upload-input').setInputFiles({ name: 'sample.png', mimeType: 'image/png', buffer: makePng() });
  await expect(page.getByTestId('tree-figures/sample.png')).toBeVisible();

  // Reference everything from main.tex and compile.
  await page.getByTestId('tab-main.tex').click();
  await replaceEditorContent(page, [
    '\\documentclass{article}',
    '\\usepackage{graphicx}',
    '\\begin{document}',
    '\\input{methods}',
    '\\begin{figure}[h]',
    '\\centering',
    '\\includegraphics[width=4cm]{figures/sample.png}',
    '\\caption{A sample.}\\label{fig:sample}',
    '\\end{figure}',
    '\\end{document}',
  ]);
  expect(await compile(page)).toBe('succeeded');
  await expect(page.getByTestId('pdf-viewer')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('pdf-pages')).toHaveText('1 / 1');
  await expect(page.locator('[data-testid=pdf-viewer] canvas').first()).toBeVisible();

  // Introduce an error and inspect it.
  await editor(page).click();
  await page.keyboard.press('Control+Home');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Home');
  await page.keyboard.type('\\undefinedmacro');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  expect(await compile(page)).toBe('failed');
  const problem = page.getByTestId('diagnostic').filter({ hasText: 'Undefined control sequence' });
  await expect(problem).toHaveCount(1);
  await expect(problem).toContainText('main.tex:4');
  await page.keyboard.press('Control+Home');
  await problem.click();
  await expect(page.getByTestId('status-bar')).toContainText('Ln 4');

  // The log tab shows the latexmk output.
  await page.getByRole('tab', { name: 'Raw log' }).click();
  await expect(page.getByTestId('compile-log')).toContainText('Latexmk');

  // Everything was saved: reload and check the files and the last result are still there.
  await expect(page.getByTestId('save-state')).toHaveText('Saved');
  await page.reload();
  await expect(page.getByTestId('project-title')).toHaveText('E2E Paper');
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('\\undefinedmacro');
  await expect(page.getByTestId('tree-methods.tex')).toBeVisible();
  await page.getByTestId('tree-figures').click();
  await expect(page.getByTestId('tree-figures/sample.png')).toBeVisible();
  await expect(page.getByTestId('compile-status')).toHaveAttribute('data-status', 'failed');

  expect(pageErrors).toEqual([]);
});
