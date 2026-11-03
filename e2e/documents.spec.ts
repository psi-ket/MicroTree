import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { lines, makeLayoutPdf } from '../packages/document-intelligence/test/fixtures/make-pdf';
import { E2E_PAIRING_TOKEN, E2E_RUNTIME_URL, E2E_WEB_URL } from '../playwright.config';

const AXE = readFileSync(fileURLToPath(new URL('../apps/web/node_modules/axe-core/axe.min.js', import.meta.url)), 'utf8');

const shot = async (page: Page, name: string) => {
  if (process.env.RS_E2E_SHOTS) await page.screenshot({ path: `${process.env.RS_E2E_SHOTS}/${name}.png` });
};

async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ content: AXE });
  return page.evaluate(async () => {
    const res = await (window as unknown as { axe: { run(ctx: object, opts: object): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run(
      { exclude: [['[data-sonner-toaster]']] },
      { resultTypes: ['violations'] },
    );
    return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

/**
 * A synthetic two-column paper (no copyrighted text). The e2e runtime has no
 * GROBID, so this exercises the real PyMuPDF fallback: layout extraction,
 * column order, headings by font size, coordinates and highlights.
 */
const para = (prefix: string) => [`${prefix} studies bosonic codes and the Lindblad`, 'master equation for open quantum systems', 'with tensor networks and Majorana modes.'];
const PAPER = makeLayoutPdf([
  {
    texts: [
      { x: 110, y: 730, text: 'Synthetic Notes on Open Quantum Systems', size: 18 },
      { x: 72, y: 680, text: '1 Introduction', size: 13, bold: true },
      ...lines(72, 660, para('The left column')),
      ...lines(320, 660, ['Hamiltonian simulation of the H_2 molecule', 'needs only a few hundred gates in', 'a minimal basis set for this test.']),
      { x: 72, y: 560, text: '2 Results', size: 13, bold: true },
      ...lines(72, 540, ['Dephasing destroys coherence quickly', 'while amplitude damping drives the', 'system to its ground state here.']),
    ],
  },
], { Title: 'Synthetic Notes on Open Quantum Systems' });

// The specs share one data directory: remove the paper this spec added, so later specs see the library they expect.
test.afterAll(async ({ request }) => {
  const headers = { origin: E2E_WEB_URL };
  const session = await request.post(`${E2E_RUNTIME_URL}/api/v1/auth/session`, { headers, data: { pairingToken: E2E_PAIRING_TOKEN } });
  const auth = { ...headers, authorization: `Bearer ${((await session.json()) as { sessionToken: string }).sessionToken}` };
  const list = (await (await request.get(`${E2E_RUNTIME_URL}/api/v1/library/items?q=Synthetic%20Notes`, { headers: auth })).json()) as { items: { id: string }[] };
  if (list.items.length) await request.post(`${E2E_RUNTIME_URL}/api/v1/library/items/delete`, { headers: auth, data: { itemIds: list.items.map((i) => i.id) } });
});

test('extract full text, search it and open the passage at its place in the PDF', async ({ page }) => {
  await page.goto(`/#runtime=${encodeURIComponent(E2E_RUNTIME_URL)}&token=${E2E_PAIRING_TOKEN}`);
  await page.getByTestId('open-library').click();
  const library = page.getByTestId('library');
  await library.getByRole('button', { name: 'Import', exact: true }).click();
  await library.locator('input[type=file][multiple]').setInputFiles({ name: 'synthetic-notes.pdf', mimeType: 'application/pdf', buffer: PAPER });
  await expect(library.getByTestId('library-job').first().getByRole('button', { name: 'Cancel' })).toHaveCount(0, { timeout: 60_000 });

  // Paper details: extract the full text.
  await library.getByRole('button', { name: 'Papers', exact: true }).click();
  await library.getByTestId('library-items').getByRole('button', { name: /Synthetic Notes/ }).first().click();
  const details = library.getByTestId('library-item');
  await details.getByRole('button', { name: /Extract full text/ }).click();
  await expect(details.getByText(/Extracted with gaps|Full text extracted/)).toBeVisible({ timeout: 90_000 });
  await expect(details.getByText(/PyMuPDF/).first()).toBeVisible();
  await shot(page, 'documents-1-details');

  // Full-text view.
  await details.getByRole('button', { name: 'Full text', exact: true }).click();
  const full = page.getByTestId('full-text');
  await expect(full.getByRole('heading', { name: '1 Introduction' })).toBeVisible();
  await expect(full.getByRole('heading', { name: '2 Results' })).toBeVisible();
  await expect(full.getByText(/Structured extraction \(GROBID\) was not available/)).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await shot(page, 'documents-2-full-text');
  await page.keyboard.press('Escape');

  // Search across the library.
  await library.getByRole('button', { name: 'Search text', exact: true }).click();
  await page.getByTestId('research-query').fill('"Lindblad master equation"');
  await page.getByRole('radio', { name: 'Keyword' }).click();
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const result = page.getByTestId('search-result').first();
  await expect(result).toContainText('The left column studies bosonic codes');
  await expect(result).toContainText('1 Introduction');
  // The right column is a different passage: columns are not merged.
  await expect(result).not.toContainText('Hamiltonian simulation');
  expect(await axeViolations(page)).toEqual([]);
  await shot(page, 'documents-3-search');

  // Source navigation with highlight.
  await result.getByRole('button', { name: /Open in PDF/ }).click();
  const highlight = page.getByTestId('pdf-highlight').first();
  await expect(highlight).toBeVisible({ timeout: 30_000 });
  const pageBox = await page.locator('[data-page="1"]').boundingBox();
  const hBox = await highlight.boundingBox();
  expect(pageBox && hBox).toBeTruthy();
  // The passage is in the left column, in the top half of the page.
  expect(hBox!.x - pageBox!.x).toBeLessThan(pageBox!.width / 2);
  expect(hBox!.y - pageBox!.y).toBeLessThan(pageBox!.height / 2);
  await expect(page.getByTestId('source-panel')).toContainText('PyMuPDF');
  await shot(page, 'documents-4-source');
  await page.getByTestId('back-to-results').click();
  await expect(page.getByTestId('search-result').first()).toBeVisible();

  // Dashboard.
  await library.getByRole('button', { name: 'Full text', exact: true }).click();
  const dash = page.getByTestId('extraction-dashboard');
  await expect(dash).toContainText('Processed');
  await expect(dash.getByText('GROBID', { exact: true })).toBeVisible();
  await expect(dash).toContainText('grobid/grobid:0.9.1-crf');
  expect(await axeViolations(page)).toEqual([]);
  await shot(page, 'documents-5-dashboard');

  // Phone width: the search workspace and the dashboard do not scroll sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  for (const tab of ['Search text', 'Full text']) {
    await library.getByRole('button', { name: tab, exact: true }).click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${tab} at 390 px`).toBeLessThanOrEqual(0);
  }
  await shot(page, 'documents-6-phone');
});
