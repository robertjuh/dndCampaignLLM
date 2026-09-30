import { test, expect } from '@playwright/test';
import { templateCharacter } from '../../shared/schema';

test('character generation shows progress, populates the draft, and keeps failures beside Generate', async ({
  page,
}) => {
  await page.goto('/characters');
  await page.getByRole('button', { name: 'Create a character', exact: true }).click();
  await page.getByLabel('Character concept').fill('sea warrior');
  let release: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sheet = templateCharacter('Generated warrior', 'Sea creature');
  await page.route('**/api/characters/generate', async (route) => {
    await ready;
    await route.fulfill({ json: sheet });
  });
  await page.getByRole('button', { name: 'Generate from my concept' }).click();
  await expect(page.getByRole('status')).toContainText('ChatGPT is creating your character');
  await expect(page.getByRole('button', { name: 'Cancel generation' })).toBeVisible();
  release();
  await expect(page.getByLabel('Character name', { exact: true })).toHaveValue(sheet.name);
  await expect(page.getByRole('status')).toHaveCount(0);
  await page.unroute('**/api/characters/generate');
  await page.route('**/api/characters/generate', (route) =>
    route.fulfill({ status: 504, json: { error: 'ChatGPT took too long. Please try again.' } }),
  );
  await page.getByRole('button', { name: 'Generate from my concept' }).click();
  await expect(page.locator('.generate-box').getByRole('alert')).toContainText('ChatGPT took too long');
  await expect(page.getByLabel('Character name', { exact: true })).toHaveValue(sheet.name);
  await expect(page.getByRole('button', { name: 'Generate from my concept' })).toBeEnabled();
});

test('cancelling generation preserves the draft and allows another attempt', async ({ page }) => {
  await page.goto('/characters');
  await page.getByRole('button', { name: 'Create a character', exact: true }).click();
  await page.getByLabel('Character name', { exact: true }).fill('My draft');
  await page.getByLabel('Character concept').fill('sea warrior');
  await page.route('**/api/characters/generate', () => {});
  await page.getByRole('button', { name: 'Generate from my concept' }).click();
  await page.getByRole('button', { name: 'Cancel generation' }).click();
  await expect(page.locator('.generate-box').getByRole('alert')).toContainText('Generation cancelled');
  await expect(page.getByLabel('Character name', { exact: true })).toHaveValue('My draft');
  await expect(page.getByRole('button', { name: 'Generate from my concept' })).toBeEnabled();
});
