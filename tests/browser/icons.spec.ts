import { expect, test } from '@playwright/test';
import { templateCharacter } from '../../shared/schema';

test('local icons load while choices stay usable, fall back on failure, and survive saving', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const sheet = templateCharacter('Icon explorer');
  const combatId = 'b6105cc8-8ccd-4c66-a966-43854b12ff01';
  const itemId = 'b6105cc8-8ccd-4c66-a966-43854b12ff02';
  const failedId = 'b6105cc8-8ccd-4c66-a966-43854b12ff03';
  sheet.abilityOptions = [
    { ...sheet.abilities[0], iconId: combatId },
    { ...sheet.abilities[0], name: 'Protective ward', effect: 'barrier', iconId: failedId },
    sheet.abilities[1],
    { ...sheet.abilities[1], name: 'Hidden insight' },
  ];
  sheet.abilities = [];
  sheet.equipmentOptions[0].iconId = itemId;
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=',
    'base64',
  );
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/characters/generate', (route) => route.fulfill({ json: sheet }));
  await page.route('**/api/icons/*', async (route) => {
    if (route.request().url().endsWith(combatId)) await pending;
    await route.fulfill(
      route.request().url().endsWith(failedId)
        ? { status: 503, json: { error: 'Local service unavailable' } }
        : { contentType: 'image/png', body: png },
    );
  });
  await page.goto('/characters');
  await page.getByRole('button', { name: 'Create a character', exact: true }).click();
  await page.getByLabel('Character concept').fill('A curious explorer');
  await page.getByRole('button', { name: 'Generate from my concept' }).click();
  const combat = page
    .locator('.ability-choices .ability-card')
    .filter({ hasText: sheet.abilityOptions[0].name });
  await expect(combat.locator('.generated-icon')).toHaveCount(0);
  await combat.click();
  await expect(combat).toHaveAttribute('aria-pressed', 'true');
  release();
  await expect(combat.locator('.generated-icon')).toBeVisible();
  await expect
    .poll(() => combat.locator('.generated-icon').evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  const failed = page.locator('.ability-choices .ability-card').filter({ hasText: 'Protective ward' });
  await expect(failed.locator('b .item-icon')).toBeVisible();
  await expect(failed.locator('.generated-icon')).toHaveCount(0);
  await page
    .locator('.ability-choices .ability-card')
    .filter({ hasText: sheet.abilityOptions[2].name })
    .click();
  await expect(page.locator('.equipment-choices .generated-icon')).toBeVisible();
  for (const index of [0, 2, 3]) await page.locator('.equipment-choice-select').nth(index).click();
  await expect
    .poll(() => combat.evaluate((element) => element.scrollWidth <= element.clientWidth))
    .toBe(true);
  await page.getByRole('button', { name: 'Save character', exact: true }).click();
  await page.reload();
  const me = await (await page.request.get('/api/me')).json();
  expect(me.characters[0].abilities[0].iconId).toBe(combatId);
  expect(me.characters[0].equipmentOptions[0].iconId).toBe(itemId);
});
