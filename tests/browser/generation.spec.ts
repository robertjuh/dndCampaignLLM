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
  await expect(page.getByRole('heading', { name: sheet.name, exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.locator('.character-editor textarea')).toHaveCount(1);
  await expect(page.locator('.character-editor input, .character-editor select')).toHaveCount(0);
  await expect(page.locator('.equipment-choices button')).toHaveCount(5);
  await expect(page.locator('.ability-card')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Save character', exact: true })).toBeDisabled();
  await page.locator('.equipment-choices button').nth(0).click();
  await expect(page.getByRole('button', { name: 'Save character', exact: true })).toBeDisabled();
  await page.locator('.equipment-choices button').nth(1).click();
  await expect(page.locator('.equipment-choices button').nth(2)).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save character', exact: true })).toBeEnabled();
  await page.screenshot({ path: 'test-results/character-result.png', fullPage: true });
  await page.unroute('**/api/characters/generate');
  await page.route('**/api/characters/generate', (route) =>
    route.fulfill({ status: 504, json: { error: 'ChatGPT took too long. Please try again.' } }),
  );
  await page.getByRole('button', { name: 'Generate from my concept' }).click();
  await expect(page.locator('.generate-box').getByRole('alert')).toContainText('ChatGPT took too long');
  await expect(page.getByRole('heading', { name: sheet.name, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate from my concept' })).toBeEnabled();
});

test('cancelling generation preserves the draft and allows another attempt', async ({ page }) => {
  await page.goto('/characters');
  await page.getByRole('button', { name: 'Create a character', exact: true }).click();
  await page.route('**/api/characters/generate', (route) =>
    route.fulfill({ json: templateCharacter('My draft') }),
  );
  await page.getByRole('button', { name: 'Surprise me with ChatGPT' }).click();
  await expect(page.getByRole('heading', { name: 'My draft', exact: true })).toBeVisible();
  await page.unroute('**/api/characters/generate');
  await page.getByLabel('Character concept').fill('sea warrior');
  await page.route('**/api/characters/generate', () => {});
  await page.getByRole('button', { name: 'Generate from my concept' }).click();
  await page.getByRole('button', { name: 'Cancel generation' }).click();
  await expect(page.locator('.generate-box').getByRole('alert')).toContainText('Generation cancelled');
  await expect(page.getByRole('heading', { name: 'My draft', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate from my concept' })).toBeEnabled();
});

test('a usage rejection preserves a generated result and its selected equipment', async ({ page }) => {
  let requests = 0;
  const sheet = templateCharacter('Saved adventurer', 'Custom sea creature');
  await page.route('**/api/characters/generate', (route) => {
    requests++;
    if (requests === 1) return route.fulfill({ json: sheet });
    return route.fulfill({
      status: 429,
      json: {
        error: 'ChatGPT reports a plan-sharing usage limit for Gather.',
        provider: { code: 'subscription_sharing_usage_limit_exceeded', upstreamStatus: 200 },
      },
    });
  });
  await page.goto('/characters');
  await page.getByRole('button', { name: 'Create a character', exact: true }).click();
  await page.getByLabel('Character concept').fill('sea warrior');
  await page.getByRole('button', { name: 'Generate from my concept' }).click();
  await page.locator('.equipment-choices button').nth(0).click();
  await page.locator('.equipment-choices button').nth(1).click();
  await page.getByRole('button', { name: 'Generate from my concept' }).click();
  await expect(page.getByRole('link', { name: 'Manage ChatGPT usage' })).toHaveAttribute(
    'href',
    'https://chatgpt.com/settings/usage',
  );
  await expect(page.getByRole('alert')).toContainText('preserved');
  await expect(
    page.locator('.character-sheet input, .character-sheet textarea, .character-sheet select'),
  ).toHaveCount(0);
  await expect(page.locator('.equipment-choices [aria-pressed="true"]')).toHaveCount(2);
  await page.getByRole('button', { name: 'Save character', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: sheet.name, exact: true })).toBeVisible();
  expect(requests).toBe(2);
  await page.getByRole('button', { name: 'Review saved character', exact: true }).click();
  await expect(page.locator('.equipment-choices [aria-pressed="true"]')).toHaveCount(2);
  await expect(page.locator('.library-card')).toHaveCount(1);
});

test('phone settings distinguish host sign-in from usable generation', async ({ page }) => {
  await page.route('**/api/chatgpt', (route) =>
    route.fulfill({
      json: { connected: true, shared: true, email: null, usageUrl: 'https://chatgpt.com/settings/usage' },
    }),
  );
  await page.route('**/api/chatgpt/models', (route) =>
    route.fulfill({ json: [{ id: 'test-model', name: 'Test model' }] }),
  );
  await page.goto('/settings');
  await expect(page.getByText('Host signed in', { exact: true })).toBeVisible();
  await expect(page.locator('.connected-account')).toContainText('Using the host’s ChatGPT connection');
  await expect(page.getByText(/signing in does not confirm that generation is available/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue with Google', exact: true })).toBeDisabled();
  await expect(page.getByText(/Google sign-in needs host setup/)).toBeVisible();
});
