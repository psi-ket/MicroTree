import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_PAIRING_TOKEN, E2E_RUNTIME_URL, E2E_WEB_URL } from '../playwright.config';

/** Direct runtime API access, as a separate (non-browser) client. */
async function runtimeApi() {
  const res = await fetch(`${E2E_RUNTIME_URL}/api/v1/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: E2E_WEB_URL },
    body: JSON.stringify({ pairingToken: E2E_PAIRING_TOKEN }),
  });
  const { sessionToken } = (await res.json()) as { sessionToken: string };
  return async <T>(method: string, url: string, body?: unknown): Promise<T> => {
    const r = await fetch(`${E2E_RUNTIME_URL}/api/v1${url}`, {
      method,
      headers: { authorization: `Bearer ${sessionToken}`, origin: E2E_WEB_URL, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return (await r.json()) as T;
  };
}

const editorText = (page: Page) => page.locator('.monaco-editor .view-lines').first();

test('changes made outside the app reach the editor, and never overwrite unsaved edits', async ({ page }) => {
  const api = await runtimeApi();
  // Keep typed text unsaved so the conflict can happen.
  await api('PATCH', '/settings', { autosave: false });
  try {
    await page.goto(`/#runtime=${encodeURIComponent(E2E_RUNTIME_URL)}&token=${E2E_PAIRING_TOKEN}`);
    await page.getByTestId('new-project').click();
    await page.getByLabel('Name', { exact: true }).fill('External Edits');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByTestId('tab-main.tex')).toBeVisible();
    const { projects } = await api<{ projects: { name: string; rootPath: string }[] }>('GET', '/projects');
    const root = projects.find((p) => p.name === 'External Edits')!.rootPath;
    const main = path.join(root, 'main.tex');

    // 1. No unsaved edits: the editor follows the file on disk.
    await writeFile(main, '\\documentclass{article}\n\\begin{document}\nChanged by another editor.\n\\end{document}\n');
    await expect(editorText(page)).toContainText('Changed by another editor.');
    await expect(page.getByTestId('conflict-bar')).toHaveCount(0);

    // 2. Unsaved edits: the editor keeps them and flags the conflict.
    await page.locator('.monaco-editor').first().click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('My unsaved sentence.');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('save-state')).toHaveText('Edited');
    const theirs = '\\documentclass{article}\n\\begin{document}\nTheir version from git.\n\\end{document}\n';
    await writeFile(main, theirs);
    await expect(page.getByTestId('conflict-bar')).toContainText('changed on disk while you had unsaved edits');
    await expect(editorText(page)).toContainText('My unsaved sentence.');
    await expect(page.getByTestId('save-state')).toHaveText('Changed on disk');
    // Nothing was written over their version.
    expect(await readFile(main, 'utf8')).toBe(theirs);

    // Compare, then keep mine.
    await page.getByTestId('conflict-compare').click();
    const dialog = page.getByTestId('compare-dialog');
    await expect(dialog).toContainText('Their version from git.');
    await expect(dialog).toContainText('My unsaved sentence.');
    await page.getByTestId('compare-keep-mine').click();
    await expect(page.getByTestId('conflict-bar')).toHaveCount(0);
    await expect.poll(() => readFile(main, 'utf8')).toContain('My unsaved sentence.');
    await expect(page.getByTestId('save-state')).toHaveText('Saved');

    // 3. A rename outside the app follows the open tab.
    await rename(main, path.join(root, 'paper.tex'));
    await expect(page.getByTestId('tab-paper.tex')).toBeVisible();
    await expect(page.getByTestId('tab-main.tex')).toHaveCount(0);
    await expect(editorText(page)).toContainText('My unsaved sentence.');

    // 4. Deleted on disk while edited: the edits stay, and can be saved again.
    await page.locator('.monaco-editor').first().click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' More.');
    await page.keyboard.press('Escape');
    await rm(path.join(root, 'paper.tex'));
    await expect(page.getByTestId('conflict-bar')).toContainText('was deleted on disk');
    await page.getByRole('button', { name: 'Keep mine and save' }).click();
    await expect(page.getByTestId('conflict-bar')).toHaveCount(0);
    await expect.poll(() => readFile(path.join(root, 'paper.tex'), 'utf8').catch(() => '')).toContain('More.');
  } finally {
    await api('PATCH', '/settings', { autosave: true });
  }
});
