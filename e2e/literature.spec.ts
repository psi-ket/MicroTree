import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { E2E_MOCK_LITERATURE_URL, E2E_PAIRING_TOKEN, E2E_RUNTIME_URL } from '../playwright.config';

const AXE = readFileSync(fileURLToPath(new URL('../apps/web/node_modules/axe-core/axe.min.js', import.meta.url)), 'utf8');

/** Set RS_E2E_SHOTS to a folder to keep screenshots for visual review. */
const shot = async (page: Page, name: string) => {
  if (process.env.RS_E2E_SHOTS) await page.screenshot({ path: `${process.env.RS_E2E_SHOTS}/${name}.png` });
};

const mock = {
  scenario: (s: Record<string, string>) => fetch(`${E2E_MOCK_LITERATURE_URL}/__scenario`, { method: 'POST', body: JSON.stringify(s) }),
  reset: () => fetch(`${E2E_MOCK_LITERATURE_URL}/__scenario`, { method: 'DELETE' }),
  requests: async () => (await (await fetch(`${E2E_MOCK_LITERATURE_URL}/__requests`)).json()) as { provider: string; headers: Record<string, string | null>; query: Record<string, string> }[],
  clearRequests: () => fetch(`${E2E_MOCK_LITERATURE_URL}/__requests`, { method: 'DELETE' }),
  abandoned: async () => ((await (await fetch(`${E2E_MOCK_LITERATURE_URL}/__stats`)).json()) as { abandoned: number }).abandoned,
};

async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ content: AXE });
  return page.evaluate(async () => {
    // Toasts (the app-wide sonner toaster) fade in and out; contrast measured mid-animation is meaningless.
    const res = await (window as unknown as { axe: { run(ctx: object, opts: object): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run(
      { exclude: [['[data-sonner-toaster]']] },
      { resultTypes: ['violations'] },
    );
    return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

async function search(page: Page, text: string) {
  await page.getByTestId('literature-query').fill(text);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
}

test.afterEach(async () => {
  await mock.reset();
});

test('search the literature, inspect a merged work and copy its BibTeX', async ({ page, context }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  await page.goto(`/#runtime=${encodeURIComponent(E2E_RUNTIME_URL)}&token=${E2E_PAIRING_TOKEN}`);
  await page.getByTestId('open-literature').click();
  await expect(page.getByRole('heading', { name: 'Literature' })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // A text search fans out to all four sources and merges duplicates.
  await search(page, 'quantum error correction');
  const status = page.getByRole('list', { name: 'Sources searched' });
  for (const name of ['OpenAlex', 'Semantic Scholar', 'arXiv', 'Crossref']) await expect(status).toContainText(name);
  const results = page.getByRole('list', { name: 'Search results' });
  await expect(results.getByRole('button').first()).toBeVisible();
  const shor = results.getByRole('button', { name: /Scheme for reducing decoherence in quantum computer memory/ });
  await expect(shor.getByRole('img', { name: 'Found in Semantic Scholar and Crossref' })).toBeVisible();
  await shot(page, 'literature-results');

  await shor.click();
  const details = page.getByTestId('work-details');
  await expect(details.getByRole('heading', { level: 2 })).toHaveText('Scheme for reducing decoherence in quantum computer memory');
  await expect(details.getByRole('link', { name: /10\.1103\/physreva\.52\.r2493/ })).toHaveAttribute('href', 'https://doi.org/10.1103/physreva.52.r2493');
  await details.getByRole('button', { name: 'Copy BibTeX' }).click();
  await expect(page.getByText('BibTeX copied')).toBeVisible();
  // The Windows clipboard returns CRLF line endings; the entry itself uses LF.
  const bibtex = (await page.evaluate(() => navigator.clipboard.readText())).replaceAll('\r\n', '\n');
  expect(bibtex).toMatch(/^@article\{shor1995scheme,/);
  expect(bibtex).toContain('Physical Review A');
  const [download] = await Promise.all([page.waitForEvent('download'), details.getByRole('button', { name: 'Download .bib' }).click()]);
  expect(download.suggestedFilename()).toBe('shor1995scheme.bib');
  expect(readFileSync(await download.path(), 'utf8')).toBe(bibtex);
  expect(await axeViolations(page)).toEqual([]);
  await shot(page, 'literature-details');

  // A DOI resolves to one work, merged from every source that knows it, and opens directly.
  await search(page, 'https://doi.org/10.1103/PhysRevA.52.R2493');
  await expect(details.getByRole('heading', { level: 2 })).toHaveText('Scheme for reducing decoherence in quantum computer memory');
  const sources = details.locator('[data-source]');
  await expect(sources).toHaveCount(3);
  await expect(sources.nth(0)).toContainText('OpenAlex');
  await expect(sources.nth(1)).toContainText('Semantic Scholar');
  await expect(sources.nth(2)).toContainText('Crossref');
  await expect(status.locator('[data-provider="arxiv"]')).toHaveAttribute('data-status', 'skipped');

  // References and citing works come from the source that has them.
  await details.getByRole('button', { name: /^Cited by/ }).click();
  await expect(details.getByText(/from OpenAlex$/)).toBeVisible();

  // Recent searches remember both searches; running one again is served from the cache.
  const recent = page.getByRole('region', { name: 'Recent searches' });
  await expect(recent.getByRole('button', { name: /^quantum error correction/ })).toBeVisible();
  await recent.getByRole('button', { name: /^quantum error correction/ }).click();
  await expect(status.locator('[data-provider="openalex"]')).toContainText('cached');

  expect(pageErrors).toEqual([]);
});

test('a rate-limited source does not stop the search, and a slow one can be cancelled', async ({ page }) => {
  await page.goto(`/#runtime=${encodeURIComponent(E2E_RUNTIME_URL)}&token=${E2E_PAIRING_TOKEN}`);
  await page.getByTestId('open-literature').click();

  await mock.scenario({ 'semantic-scholar': 'rate_limited' });
  await search(page, 'decoherence rate limit check');
  const status = page.getByRole('list', { name: 'Sources searched' });
  await expect(status.locator('[data-provider="semantic-scholar"]')).toHaveAttribute('data-status', 'rate_limited');
  await expect(status.locator('[data-provider="openalex"]')).toHaveAttribute('data-status', 'success');
  await expect(page.getByTestId('provider-status')).toContainText('Semantic Scholar: rate limit');
  await expect(page.getByRole('list', { name: 'Search results' }).getByRole('button').first()).toBeVisible();
  await shot(page, 'literature-rate-limited');

  // Cancelling closes the runtime's request to the provider.
  await mock.reset();
  await mock.scenario({ openalex: 'slow' });
  const before = await mock.abandoned();
  await page.getByRole('checkbox', { name: 'Semantic Scholar' }).uncheck();
  await page.getByRole('checkbox', { name: 'arXiv' }).uncheck();
  await page.getByRole('checkbox', { name: 'Crossref' }).uncheck();
  await search(page, 'a search that never finishes');
  await expect(page.getByText('Press Esc to stop.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText(/Search stopped/)).toBeVisible();
  await expect.poll(mock.abandoned, { timeout: 5_000 }).toBeGreaterThan(before);
});

test('keys are kept by the runtime and sent only to their provider', async ({ page }) => {
  await page.goto(`/#runtime=${encodeURIComponent(E2E_RUNTIME_URL)}&token=${E2E_PAIRING_TOKEN}`);
  await page.getByTestId('open-literature').click();
  await page.getByRole('button', { name: 'Sources', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Sources' });
  const s2 = dialog.getByTestId('source-semantic-scholar');
  await s2.getByLabel('API key (optional)').fill('e2e-s2-key-0123456789');
  await s2.getByRole('button', { name: 'Save key' }).click();
  await expect(s2.getByText(/A key is saved in the runtime’s secret store/)).toBeVisible();
  await expect(s2.getByLabel('API key (optional)')).toHaveValue('');
  expect(await axeViolations(page)).toEqual([]);
  await shot(page, 'literature-sources');
  await page.keyboard.press('Escape');

  await mock.clearRequests();
  await search(page, 'key header check');
  await expect(page.getByRole('list', { name: 'Search results' }).getByRole('button').first()).toBeVisible();
  const sent = await mock.requests();
  expect(sent.filter((r) => r.provider === 'semantic-scholar').every((r) => r.headers['x-api-key'] === 'e2e-s2-key-0123456789')).toBe(true);
  expect(sent.filter((r) => r.provider !== 'semantic-scholar').some((r) => r.headers['x-api-key'] !== null)).toBe(false);
  expect(JSON.stringify(sent.map((r) => r.query))).not.toContain('e2e-s2-key');

  await page.getByRole('button', { name: 'Sources', exact: true }).click();
  await dialog.getByTestId('source-semantic-scholar').getByRole('button', { name: 'Remove' }).click();
  await expect(dialog.getByTestId('source-semantic-scholar').getByText('Kept in the runtime’s secret store, never in the browser.')).toBeVisible();
});

test('on a phone-sized screen in dark mode, results and details take turns', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#runtime=${encodeURIComponent(E2E_RUNTIME_URL)}&token=${E2E_PAIRING_TOKEN}`);
  await page.getByTestId('open-literature').click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  // Filters sit behind a toggle.
  await expect(page.getByRole('form', { name: 'Filters' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Filters' })).toBeVisible();
  await page.getByRole('button', { name: 'Filters', exact: true }).click();

  await search(page, 'quantum error correction');
  const results = page.getByRole('list', { name: 'Search results' });
  await results.getByRole('button', { name: /Scheme for reducing decoherence/ }).click();
  await expect(results).toHaveCount(0);
  await expect(page.getByTestId('work-details').getByRole('heading', { level: 2 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(await axeViolations(page)).toEqual([]);
  await shot(page, 'literature-phone-dark');
  await page.getByRole('button', { name: 'Back to results' }).click();
  await expect(results).toBeVisible();
});
