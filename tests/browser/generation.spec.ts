import { test, expect } from '@playwright/test';
import { baseItem, rollCharacterCreation } from '../../shared/rules';
import { templateCharacter } from '../../shared/schema';

for (const failure of ['save', 'refresh'] as const) {
  test(`a failed character ${failure} keeps the draft and retries without duplicate saves`, async ({
    page,
  }) => {
    const sheet = templateCharacter('Returning explorer');
    await page.route('**/api/characters/generate', (route) => route.fulfill({ json: sheet }));
    await page.goto('/characters');
    await page.getByRole('button', { name: 'Create a character', exact: true }).click();
    await page.getByLabel('Character concept').fill('An explorer returning to the party');
    await page.getByRole('button', { name: 'Generate from my concept' }).click();
    await page.locator('.equipment-choices button').nth(0).click();
    await page.locator('.equipment-choices button').nth(1).click();
    let saveRequests = 0;
    let failed = false;
    await page.route('**/api/characters', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      saveRequests++;
      if (failure === 'save' && !failed) {
        failed = true;
        return route.fulfill({ status: 500, json: { error: '' } });
      }
      return route.continue();
    });
    await page.route('**/api/me', async (route) => {
      if (failure === 'refresh' && !failed) {
        failed = true;
        return route.fulfill({ status: 500, json: { error: '' } });
      }
      return route.continue();
    });
    const save = page.getByRole('button', { name: 'Save character', exact: true });
    await save.click();
    await expect(page.getByRole('alert')).toContainText('Something went wrong. Please try again.');
    if (failure === 'refresh')
      await expect(page.getByRole('alert')).toContainText('Your character was saved');
    await expect(page.getByRole('button', { name: 'Create a character', exact: true })).toBeDisabled();
    await expect(page.locator('.character-sheet')).toContainText(sheet.name);
    await expect(page.locator('.equipment-choices [aria-pressed="true"]')).toHaveCount(2);
    await save.click();
    await expect(page.locator('.character-editor')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create a character', exact: true })).toBeEnabled();
    await expect(page.locator('.library-card')).toHaveCount(1);
    await expect(page.locator('.library-card')).toContainText(sheet.name);
    expect(saveRequests).toBe(failure === 'save' ? 2 : 1);
    const me = await (await page.request.get('/api/me')).json();
    expect(me.characters.filter((character: { name: string }) => character.name === sheet.name)).toHaveLength(
      1,
    );
  });
}

test('an entered character name survives generation, regeneration, renaming, and saving', async ({
  page,
}) => {
  const requests: Record<string, unknown>[] = [];
  await page.route('**/api/characters/generate', async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: templateCharacter(`Invented name ${requests.length}`) });
  });
  await page.goto('/characters');
  await page.getByRole('button', { name: 'Create a character', exact: true }).click();
  const name = page.getByLabel('Character name (optional)');
  await name.fill('  Ária Starfall  ');
  await page.getByLabel('Character concept').fill('A curious explorer with a clockwork heart');
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByRole('button', { name: 'Generate from my concept' }).click();
    await expect(page.getByRole('heading', { name: 'Ária Starfall', exact: true })).toBeVisible();
    expect(requests[attempt].name).toBe('Ária Starfall');
  }
  await name.fill('Captain Ária');
  await expect(page.getByRole('heading', { name: 'Captain Ária', exact: true })).toBeVisible();
  await page.locator('.equipment-choices button').nth(0).click();
  await page.locator('.equipment-choices button').nth(1).click();
  await page.getByRole('button', { name: 'Save character', exact: true }).click();
  await page.reload();
  await expect(
    page.locator('.library-card').getByRole('heading', { name: 'Captain Ária', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Review saved character', exact: true }).click();
  await expect(name).toHaveValue('Captain Ária');
  await page.getByRole('button', { name: 'Generate from my concept' }).click();
  await expect(
    page.locator('.character-sheet').getByRole('heading', { name: 'Captain Ária', exact: true }),
  ).toBeVisible();
  expect(requests[2].name).toBe('Captain Ária');
});

test('library creation can attach, switch, and remove an existing campaign context', async ({ page }) => {
  const createCampaign = async (name: string, setting: string) => {
    const response = await page.request.post('/api/campaigns', {
      headers: { 'x-gather-request': '1' },
      data: {
        ruleset: 'roguelike-v1',
        name,
        setting,
        premise: 'Discover your place in this world.',
        tone: 'Mysterious',
        language: 'English',
        instructions: '',
        custom: [],
        provider: 'chatgpt',
        model: '',
      },
    });
    expect(response.ok()).toBe(true);
    return response.json() as Promise<{ id: string }>;
  };
  const ocean = await createCampaign('The Sunken Court', 'A kingdom beneath the sea');
  const stars = await createCampaign('The Starbound Court', 'An ancient city aboard a starship');
  const requests: Record<string, unknown>[] = [];
  await page.route('**/api/characters/generate', async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: templateCharacter(`Themed explorer ${requests.length}`) });
  });
  await page.goto('/characters');
  await page.getByRole('button', { name: 'Create a character', exact: true }).click();
  const selector = page.getByRole('combobox', { name: 'Campaign context (optional)' });
  await expect(selector).toHaveValue('');
  await page.getByLabel('Character concept').fill('A curious explorer with a clockwork heart');
  await selector.selectOption(ocean.id);
  await expect(page.getByText(/A kingdom beneath the sea · Mysterious/)).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'ChatGPT model' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Generate from my concept' }).click();
  await expect(page.getByRole('heading', { name: 'Themed explorer 1', exact: true })).toBeVisible();
  expect(requests[0]).toMatchObject({
    campaignId: ocean.id,
    concept: 'A curious explorer with a clockwork heart',
  });
  await selector.selectOption(stars.id);
  await page.getByRole('button', { name: 'Generate from my concept' }).click();
  await expect(page.getByRole('heading', { name: 'Themed explorer 2', exact: true })).toBeVisible();
  expect(requests[1].campaignId).toBe(stars.id);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/campaign-context-mobile.png', fullPage: true });
  await selector.selectOption('');
  await expect(page.getByRole('combobox', { name: 'ChatGPT model' })).toBeVisible();
  await page.getByRole('button', { name: 'Generate from my concept' }).click();
  await expect(page.getByRole('heading', { name: 'Themed explorer 3', exact: true })).toBeVisible();
  expect(requests[2]).not.toHaveProperty('campaignId');
  await page.locator('.equipment-choices button').nth(0).click();
  await page.locator('.equipment-choices button').nth(1).click();
  await page.getByRole('button', { name: 'Save character', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Themed explorer 3', exact: true })).toBeVisible();
});

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
  const base = templateCharacter('Generated warrior', 'Sea creature');
  base.abilities.push(
    {
      ...base.abilities[0],
      name: 'Hold the line',
      description: 'Brace yourself or an ally against an attack.',
    },
    {
      ...base.abilities[1],
      name: 'Read the tides',
      description: 'Find safe routes across open water.',
      stat: 'WIS',
    },
  );
  base.traits[0].blocked = ['body'];
  const sheet = rollCharacterCreation(base, 'strike', 1, (sides) => (sides === 3 ? 2 : 1));
  sheet.equipmentOptions[0] = {
    ...baseItem('fork', 'Sighting fork', 'focus'),
    scaling: ['INT'],
    attackBonus: 1,
  };
  sheet.equipmentOptions[1] = {
    ...baseItem('oath', 'Throne oath', 'relic'),
    scaling: ['INT'],
    checkBonus: 1,
  };
  await page.route('**/api/characters/generate', async (route) => {
    await ready;
    await route.fulfill({ json: sheet });
  });
  await page.getByRole('button', { name: 'Generate from my concept' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'ChatGPT is creating your character' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel generation' })).toBeVisible();
  release();
  await expect(page.getByRole('heading', { name: sheet.name, exact: true })).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'ChatGPT is creating your character' }),
  ).toHaveCount(0);
  await expect(page.locator('.character-editor textarea')).toHaveCount(1);
  await expect(page.locator('.character-sheet input, .character-sheet select')).toHaveCount(0);
  await expect(page.locator('.equipment-choices button')).toHaveCount(5);
  await expect(page.locator('.ability-choices button')).toHaveCount(4);
  await expect(page.locator('.ability-mechanics').nth(0)).toContainText('2d6 + STR modifier');
  await expect(page.locator('.ability-power').first()).toHaveText('4–14 damage');
  await expect(page.locator('.creation-compensation')).toContainText('Cannot wear body armour (major)');
  await expect(page.locator('.creation-compensation')).toContainText('+4 STR (+2 STR modifier)');
  await expect(page.locator('.ability-mechanics').nth(2)).toContainText('Advantage');
  await expect(page.locator('.equipment-choices button').nth(0)).toContainText(
    '+1 INT attack rolls while equipped',
  );
  await expect(page.locator('.equipment-choices button').nth(1)).toContainText(
    '+1 INT out-of-combat checks while equipped',
  );
  await expect(page.getByRole('button', { name: 'Save character', exact: true })).toBeDisabled();
  await page.locator('.equipment-choices button').nth(0).click();
  await expect(page.getByRole('button', { name: 'Save character', exact: true })).toBeDisabled();
  await page.locator('.equipment-choices button').nth(1).click();
  await expect(page.locator('.equipment-choices button').nth(2)).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save character', exact: true })).toBeDisabled();
  await page.locator('.ability-choices button').nth(0).click();
  await expect(page.getByRole('button', { name: 'Save character', exact: true })).toBeDisabled();
  await page.locator('.ability-choices button').nth(2).click();
  await expect(page.getByRole('button', { name: 'Save character', exact: true })).toBeEnabled();
  await page.locator('.ability-choices button').nth(1).click();
  await expect(page.locator('.ability-choices [aria-pressed="true"]')).toHaveCount(2);
  await expect(page.locator('.ability-choices button').nth(0)).toHaveAttribute('aria-pressed', 'false');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/character-result.png', fullPage: true });
  await page.unroute('**/api/characters/generate');
  await page.route('**/api/characters/generate', (route) =>
    route.fulfill({ status: 504, json: { error: 'ChatGPT took too long. Please try again.' } }),
  );
  await page.getByRole('button', { name: 'Generate from my concept' }).click();
  await expect(page.locator('.generate-box').getByRole('alert')).toContainText('ChatGPT took too long');
  await expect(page.getByRole('heading', { name: sheet.name, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate from my concept' })).toBeEnabled();
  await expect(page.locator('.ability-choices [aria-pressed="true"]')).toHaveCount(2);
  await page.getByRole('button', { name: 'Save character', exact: true }).click();
  await expect(page.locator('.character-editor')).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Review saved character', exact: true }).click();
  await expect(page.locator('.ability-choices [aria-pressed="true"]')).toHaveCount(2);
  const me = await (await page.request.get('/api/me')).json();
  expect(me.characters[0].abilities.map((a: { name: string }) => a.name)).toEqual([
    'Hold the line',
    'Keen observation',
  ]);
  expect(me.characters[0].abilities).toHaveLength(2);
  await page.unroute('**/api/characters/generate');
  await page.route('**/api/characters/generate', (route) => route.fulfill({ json: sheet }));
  await page.getByRole('button', { name: 'Generate from my concept' }).click();
  await expect(page.locator('.ability-choices [aria-pressed="true"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save character', exact: true })).toBeDisabled();
});

test('the host can compare ability pick rates in Settings on desktop and mobile', async ({ page }) => {
  await page.route('**/api/chatgpt', (route) =>
    route.fulfill({
      json: { connected: false, shared: false, email: null, usageUrl: 'https://chatgpt.com/settings/usage' },
    }),
  );
  let loads = 0;
  await page.route('**/api/characters/ability-stats', (route) => {
    loads++;
    return route.fulfill({
      json: {
        characters: 2,
        offers: 8,
        selections: 4,
        rows: [
          { kind: 'combat', effect: 'strike', stat: 'STR', dice: '2d4', bonus: 2, offered: 2, selected: 2 },
          { kind: 'combat', effect: 'mend', stat: 'CON', dice: '1d8', bonus: 0, offered: 2, selected: 0 },
          { kind: 'utility', effect: 'assist', stat: 'WIS', dice: null, bonus: 1, offered: 4, selected: 2 },
        ],
      },
    });
  });
  await page.goto('/settings');
  const report = page.getByRole('region', { name: 'Ability choice statistics', exact: true });
  await expect(report).toContainText('2 saved characters · 8 offers · 4 selections');
  await expect(report.getByRole('row', { name: /strike · STR/ })).toContainText('100%');
  await expect(report.getByRole('row', { name: /mend · CON/ })).toContainText('0%');
  await expect(report.getByRole('row', { name: /Utility · WIS/ })).toContainText('50%');
  await report.getByRole('button', { name: 'Refresh statistics' }).click();
  await expect(report.getByRole('button', { name: 'Refresh statistics' })).toBeEnabled();
  expect(loads).toBe(2);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/ability-balance-mobile.png', fullPage: true });
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
