import { test, expect } from '@playwright/test';

for (const width of [1280, 390]) {
  test(`theme follows the system and remembers an override at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    const theme = page.getByRole('combobox', { name: 'Theme', exact: true });
    const root = page.locator('html');
    await expect(theme).toBeVisible();
    await expect(theme).toHaveValue('system');
    await expect(root).toHaveCSS('background-color', 'rgb(20, 30, 24)');
    await expect(page.locator('.sidebar')).toHaveCSS('background-color', 'rgb(25, 37, 29)');

    await page.emulateMedia({ colorScheme: 'light' });
    await expect(root).toHaveCSS('background-color', 'rgb(246, 245, 239)');
    await theme.selectOption('dark');
    await expect(root).toHaveCSS('background-color', 'rgb(20, 30, 24)');
    await page.reload();
    await expect(theme).toHaveValue('dark');
    await page.screenshot({ path: `test-results/theme-dark-${width}.png`, fullPage: true });

    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(theme).toHaveValue('dark');
    await expect(page.locator('.form-panel').first()).toHaveCSS('background-color', 'rgb(29, 43, 35)');
    await expect(page.getByLabel('Display name', { exact: true })).toHaveCSS('color', 'rgb(225, 233, 223)');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await theme.selectOption('light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.reload();
    await expect(theme).toHaveValue('light');
    await expect(root).toHaveCSS('background-color', 'rgb(246, 245, 239)');
    await theme.selectOption('system');
    await expect(root).toHaveCSS('background-color', 'rgb(20, 30, 24)');
  });
}

test('theme remains usable when storage is blocked', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new Error('Storage blocked');
      },
    });
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  const theme = page.getByRole('combobox', { name: 'Theme', exact: true });
  await theme.selectOption('dark');
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(20, 30, 24)');
  await theme.selectOption('light');
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(246, 245, 239)');
});

test('the shared screen has its own theme control', async ({ page }) => {
  const response = await page.request.post('/api/campaigns', {
    headers: { 'x-gather-request': '1' },
    data: {
      ruleset: 'roguelike-v1',
      name: 'The moonlit road',
      setting: 'A forest at night',
      premise: '',
      tone: 'Atmospheric',
      language: 'English',
      instructions: '',
      custom: [],
      provider: 'practice',
      model: '',
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const snapshot = await response.json();
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(`/screen/${snapshot.id}#${snapshot.displayToken}`);
  await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('dark');
  await expect(page.locator('.story-column')).toHaveCSS('background-color', 'rgb(29, 43, 35)');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('combobox', { name: 'Theme', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
