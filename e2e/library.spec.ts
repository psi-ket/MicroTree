import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { makePdf } from '../packages/research-library/test/fixtures/make-pdf';
import { E2E_PAIRING_TOKEN, E2E_RUNTIME_URL } from '../playwright.config';

const AXE = readFileSync(fileURLToPath(new URL('../apps/web/node_modules/axe-core/axe.min.js', import.meta.url)), 'utf8');

/** Set RS_E2E_SHOTS to a folder to keep screenshots for visual review. */
const shot = async (page: Page, name: string) => {
  if (process.env.RS_E2E_SHOTS) await page.screenshot({ path: `${process.env.RS_E2E_SHOTS}/${name}.png` });
};

async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ content: AXE });
  return page.evaluate(async () => {
    const res = await (window as unknown as { axe: { run(ctx: object, opts: object): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run(
      // Toasts fade in and out, and Monaco's own widgets are outside the app's control.
      { exclude: [['[data-sonner-toaster]'], ['.monaco-editor']] },
      { resultTypes: ['violations'] },
    );
    return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

const editor = (page: Page) => page.locator('.monaco-editor').first();

async function replaceEditorContent(page: Page, lines: string[]) {
  await editor(page).click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  for (const line of lines) {
    await page.keyboard.type(line);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
  }
}

async function compile(page: Page): Promise<string> {
  const response = page.waitForResponse((r) => r.url().endsWith('/compile') && r.request().method() === 'POST');
  await editor(page).click();
  await page.keyboard.press('Control+Enter');
  const { job } = (await (await response).json()) as { job: { id: string } };
  const status = page.locator(`[data-testid=compile-status][data-job-id="${job.id}"]`);
  await expect(status).toHaveAttribute('data-status', /succeeded|failed|error|cancelled/, { timeout: 120_000 });
  return (await status.getAttribute('data-status')) ?? '';
}

/** A PDF that states its title and author but no DOI or arXiv ID. */
const ATTENTION_PDF = makePdf({
  pages: [
    [
      { text: 'Attention Is All You Need', size: 20 },
      { text: 'Ashish Vaswani, Noam Shazeer, Niki Parmar', size: 11 },
      { text: 'Abstract', size: 12 },
      { text: 'The dominant sequence transduction models are based on recurrent or convolutional networks.', size: 10 },
    ],
  ],
  info: { Title: 'Attention Is All You Need' },
});

test('search, keep papers in the library, attach a PDF, resolve it, collect, cite in a project, update the .bib and compile', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(`/#runtime=${encodeURIComponent(E2E_RUNTIME_URL)}&token=${E2E_PAIRING_TOKEN}`);
  await page.getByTestId('new-project').click();
  await page.getByLabel('Name', { exact: true }).fill('Library E2E');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByTestId('project-title')).toHaveText('Library E2E');

  // 1. Search the literature and add a paper to the library.
  await page.getByRole('button', { name: 'Search literature' }).click();
  await page.getByTestId('literature-query').fill('10.1103/PhysRevA.52.R2493');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const work = page.getByTestId('work-details');
  await expect(work.getByRole('heading', { level: 2 })).toHaveText('Scheme for reducing decoherence in quantum computer memory');
  await work.getByTestId('add-to-library').click();
  await expect(work.getByTestId('add-to-library')).toHaveText('In your library');
  await page.getByRole('button', { name: 'Back to project' }).click();

  // 2. Open the library from the project and import a PDF; the import runs as a background job.
  await page.getByRole('button', { name: 'Open your library' }).click();
  const library = page.getByTestId('library');
  await expect(library.getByRole('heading', { name: 'Library' })).toBeVisible();
  await expect(library.getByTestId('library-overview')).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await library.getByRole('button', { name: 'Import', exact: true }).click();
  await library.locator('input[type=file][multiple]').setInputFiles({ name: 'attention.pdf', mimeType: 'application/pdf', buffer: ATTENTION_PDF });
  const job = library.getByTestId('library-job').first();
  await expect(job).toContainText('PDF import');
  await expect(job).not.toContainText('Starting', { timeout: 60_000 });
  await expect(job.getByRole('button', { name: 'Cancel' })).toHaveCount(0, { timeout: 60_000 });
  expect(await axeViolations(page)).toEqual([]);
  await shot(page, 'library-import');

  // 3. The PDF had no identifier: nothing is filled in until the user names the paper.
  await library.getByRole('button', { name: 'Papers', exact: true }).click();
  const items = library.getByTestId('library-items');
  await expect(items.getByRole('button')).toHaveCount(2);
  await items.getByRole('button', { name: /Attention Is All You Need/ }).click();
  const details = library.getByTestId('library-item');
  await expect(details.getByText(/Not identified|Check the match/).first()).toBeVisible();
  await expect(details.getByText('Unknown authors').or(details.getByText('Ashish Vaswani'))).toBeVisible();
  await details.getByLabel('DOI or arXiv ID of the right paper').fill('1706.03762');
  await details.getByRole('button', { name: 'Look up' }).click();
  await expect(details.getByText('Identified', { exact: true })).toBeVisible();
  await expect(details.getByRole('link', { name: /arXiv:1706\.03762/ })).toBeVisible();
  await expect(details.getByText('Ashish Vaswani', { exact: false }).first()).toBeVisible();

  // Reading the PDF records only when it was opened; the reading status stays the user's.
  await details.getByRole('button', { name: 'attention.pdf', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: 'Attention Is All You Need' });
  await expect(viewer.locator('canvas').first()).toBeVisible();
  await shot(page, 'library-pdf');
  await page.keyboard.press('Escape');
  await expect(details.getByRole('radio', { name: 'To read' })).toHaveAttribute('aria-checked', 'true');
  expect(await axeViolations(page)).toEqual([]);
  await shot(page, 'library-details');

  // 4. A collection holds both papers.
  await library.getByRole('button', { name: 'Collections', exact: true }).click();
  await library.getByRole('textbox', { name: 'New collection' }).fill('Thesis chapter 2');
  await library.getByRole('button', { name: 'Create' }).click();
  await expect(library.getByText('Thesis chapter 2')).toBeVisible();
  await library.getByRole('button', { name: 'Papers', exact: true }).click();
  await library.getByRole('checkbox', { name: 'Select all papers on this page' }).check();
  const bulk = library.getByRole('toolbar', { name: 'Selected papers' });
  await bulk.getByLabel('Add to collection').selectOption({ label: 'Thesis chapter 2' });
  const [download] = await Promise.all([page.waitForEvent('download'), bulk.getByRole('button', { name: 'BibTeX' }).click()]);
  const exported = readFileSync(await download.path(), 'utf8');
  expect(exported).toMatch(/@article\{shor1995scheme,/);
  expect(exported).toMatch(/1706\.03762/);
  await library.getByRole('button', { name: 'Collections', exact: true }).click();
  await expect(library.getByText('2 papers')).toBeVisible();

  // 5. Back in the project: attach the papers, cite one at the cursor, review and write the .bib.
  await library.getByRole('button', { name: 'Back to project' }).click();
  await expect(page.getByTestId('project-title')).toHaveText('Library E2E');
  await page.getByRole('button', { name: 'References', exact: true }).click();
  const panel = page.getByTestId('references-panel');
  await panel.getByRole('button', { name: 'Add Scheme for reducing decoherence in quantum computer memory to this project' }).click();
  await panel.getByRole('button', { name: /^Add Attention Is All You Need/ }).click();
  await expect(panel.getByRole('list', { name: 'Papers in this project' }).getByRole('listitem')).toHaveCount(2);
  // The PDF had no author or year when it was imported; its key comes from the title, once.
  await expect(panel.getByText('attention', { exact: true })).toBeVisible();

  await replaceEditorContent(page, [
    '\\documentclass{article}',
    '\\begin{document}',
    'Quantum memories can be protected ',
    '\\bibliographystyle{plain}',
    '\\bibliography{references}',
    '\\end{document}',
  ]);
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await panel.getByRole('button', { name: 'Insert \\cite{shor1995scheme}' }).click();
  // The line may be soft-wrapped into several view lines; "Cited 1×" below confirms the saved file.
  await expect(editor(page).locator('.view-lines')).toContainText('{shor1995scheme}');

  await panel.getByTestId('bib-review-open').click();
  const review = page.getByTestId('bib-review');
  await expect(review.getByText('shor1995scheme').first()).toBeVisible();
  await expect(review.getByText('New entry').first()).toBeVisible();
  await shot(page, 'library-bib-review');
  await review.getByTestId('bib-apply').click();
  await expect(page.getByText('references.bib updated')).toBeVisible();
  await expect(page.getByTestId('tree-references.bib')).toBeVisible();

  expect(await compile(page)).toBe('succeeded');
  await expect(page.getByTestId('pdf-viewer')).toHaveAttribute('data-state', 'ready');
  await expect(panel.getByText(/Cited 1×/)).toBeVisible();

  // 6. After a reload everything is still there, including the stored PDF.
  await page.reload();
  await page.getByRole('banner').getByRole('button', { name: 'Open your library' }).click();
  await library.getByRole('button', { name: 'Papers', exact: true }).click();
  await expect(library.getByTestId('library-items').getByRole('button')).toHaveCount(2);
  await library.getByTestId('library-items').getByRole('button', { name: /Attention Is All You Need/ }).click();
  await expect(library.getByTestId('library-item').getByRole('button', { name: 'attention.pdf', exact: true })).toBeEnabled();

  expect(pageErrors).toEqual([]);
});
