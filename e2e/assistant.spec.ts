import { expect, test, type Page } from '@playwright/test';
import { E2E_MOCK_AI_KEY, E2E_MOCK_AI_URL, E2E_PAIRING_TOKEN, E2E_RUNTIME_URL } from '../playwright.config';

const editor = (page: Page) => page.locator('.monaco-editor').first();
/** Set RS_E2E_SHOTS to a folder to keep screenshots of the assistant for visual review. */
const shot = async (page: Page, name: string) => {
  if (process.env.RS_E2E_SHOTS) await page.screenshot({ path: `${process.env.RS_E2E_SHOTS}/${name}.png` });
};

async function typeLines(page: Page, lines: string[]) {
  for (const line of lines) {
    await page.keyboard.type(line);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
  }
}

/** Select one whole line in the editor (1-based). */
async function selectLine(page: Page, line: number) {
  // Near the top: the assistant may be docked over the bottom of the code.
  await editor(page).click({ position: { x: 80, y: 12 } });
  await page.keyboard.press('Control+Home');
  for (let i = 1; i < line; i++) await page.keyboard.press('ArrowDown');
  // Arrow keys and End stop at soft wraps; Ctrl+L selects the whole line (with
  // its newline), and Shift+Left steps back over the newline.
  await page.keyboard.press('Control+L');
  await page.keyboard.press('Shift+ArrowLeft');
}

test('configure a model, ask about a selection, review and accept an edit, then compile', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(`/#runtime=${encodeURIComponent(E2E_RUNTIME_URL)}&token=${E2E_PAIRING_TOKEN}`);
  await page.getByTestId('new-project').click();
  await page.getByLabel('Name', { exact: true }).fill('AI Paper');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByTestId('tab-main.tex')).toBeVisible();

  await editor(page).click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await typeLines(page, [
    '\\documentclass{article}',
    '\\begin{document}',
    'It can be shown that the proposed method does in fact converge in all of the cases that we considered.',
    '\\end{document}',
  ]);

  // 1. Configure an API model (an OpenAI-compatible mock on loopback).
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const panel = page.getByTestId('assistant-panel');
  await panel.getByRole('button', { name: 'Set up the assistant' }).click();
  const setup = page.getByRole('dialog', { name: 'Assistant setup' });
  await setup.getByLabel('Service').selectOption('openai-compatible');
  await setup.getByLabel('Name').fill('Mock model');
  await setup.getByLabel('Base URL').fill(E2E_MOCK_AI_URL);
  await setup.getByLabel('API key').fill(E2E_MOCK_AI_KEY);
  await setup.getByLabel('Default model').fill('mock-writer');
  await setup.getByRole('button', { name: 'Add provider' }).click();
  await expect(setup.getByTestId('provider-row')).toContainText('Mock model');
  await expect(setup.getByTestId('provider-row')).toContainText('Key held in memory');
  await shot(page, 'setup');
  await page.keyboard.press('Escape');

  // The key never reaches browser storage.
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored).not.toContain(E2E_MOCK_AI_KEY);

  // 2. The model is selected.
  await expect(panel.getByLabel('Assistant', { exact: true })).toHaveValue(/^model:/);
  await expect(panel.getByLabel('Model')).toHaveValue('mock-writer');

  // 3–4. Ask about the selected LaTeX and receive a streamed answer.
  await selectLine(page, 3);
  await expect(panel.getByTestId('context-chips')).toContainText('line 3 selected');
  await panel.getByRole('button', { name: 'Explain selection' }).click();
  const answer = panel.getByTestId('assistant-message').first();
  await expect(answer).toHaveAttribute('data-status', 'complete');
  await expect(answer).toContainText('converges');
  await expect(answer).toContainText('321 in · 42 out');

  // The assistant sits over the bottom of the code; the conversation moves into a tab and back.
  await expect(page.getByTestId('assistant-dock')).toHaveAttribute('data-dock', 'overlay');
  await panel.getByRole('button', { name: 'Open as a tab' }).click();
  await expect(page.getByTestId('tab-assistant')).toHaveAttribute('aria-selected', 'true');
  await expect(answer).toContainText('converges');
  await page.getByTestId('tab-main.tex').click();
  await expect(panel).toBeHidden();
  await page.getByTestId('tab-assistant').click();
  await expect(answer).toBeVisible();
  await panel.getByRole('button', { name: 'Dock below the code' }).click();
  await expect(page.getByTestId('tab-assistant')).toHaveCount(0);
  await expect(page.getByTestId('assistant-dock')).toHaveAttribute('data-dock', 'overlay');

  // 5–6. Request a modification and review the structured diff.
  await selectLine(page, 3);
  await panel.getByRole('button', { name: 'Make more concise' }).click();
  const card = panel.getByTestId('proposal-card');
  await expect(card).toHaveAttribute('data-status', 'pending');
  await expect(card).toContainText('main.tex');
  await expect(card).toContainText('The method converges.');
  await shot(page, 'proposal');
  // Nothing has been written yet.
  await expect(editor(page)).toContainText('does in fact converge');
  await card.getByRole('button', { name: 'Review diff' }).click();
  const review = page.getByTestId('review-dialog');
  await expect(review.locator('.monaco-diff-editor')).toBeVisible();
  await shot(page, 'review');

  // 7. Accept it; the editor shows the new text.
  await review.getByTestId('review-accept').click();
  await expect(review).toBeHidden();
  await expect(card).toHaveAttribute('data-status', 'accepted');
  await expect(editor(page)).toContainText('The method converges.');
  await expect(editor(page)).not.toContainText('does in fact converge');

  // 8. Compile the result.
  const response = page.waitForResponse((r) => r.url().endsWith('/compile') && r.request().method() === 'POST');
  await page.keyboard.press('Control+Enter');
  const { job } = (await (await response).json()) as { job: { id: string } };
  await expect(page.locator(`[data-testid=compile-status][data-job-id="${job.id}"]`)).toHaveAttribute('data-status', 'succeeded', { timeout: 120_000 });

  // Revert restores the original sentence.
  await card.getByRole('button', { name: 'Revert' }).click();
  await expect(card).toHaveAttribute('data-status', 'reverted');
  await expect(editor(page)).toContainText('does in fact converge');

  // Archive the conversation: it leaves the history list but can be reopened and restored.
  const history = panel.getByLabel('Conversation history');
  const title = (await history.locator('option:checked').textContent())!;
  await panel.getByRole('button', { name: 'Conversation options' }).click();
  await page.getByRole('menuitem', { name: 'Archive conversation' }).click();
  await expect(history).toHaveValue('');
  await expect(history.locator('optgroup[label="Archived"] option')).toHaveText([title]);
  await history.selectOption({ label: title });
  await expect(panel.getByTestId('archived-banner')).toBeVisible();
  await expect(answer).toContainText('converges');
  await panel.getByTestId('archived-banner').getByRole('button', { name: 'Restore' }).click();
  await expect(panel.getByTestId('archived-banner')).toBeHidden();
  await expect(history.locator('optgroup[label="Archived"]')).toHaveCount(0);

  // Delete it, after confirming.
  page.once('dialog', (dialog) => void dialog.accept());
  await panel.getByRole('button', { name: 'Conversation options' }).click();
  await page.getByRole('menuitem', { name: 'Delete conversation…' }).click();
  await expect(history).toHaveValue('');
  await expect(history.locator('option', { hasText: title })).toHaveCount(0);
  await expect(panel.getByTestId('assistant-message')).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});
