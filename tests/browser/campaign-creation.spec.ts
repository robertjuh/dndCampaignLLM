import { test, expect } from '@playwright/test';
import { templateCharacter } from '../../shared/schema';

test('improves a short premise for review, preserves failed drafts and supports practice mode', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/new');
  await page
    .getByRole('textbox', { name: 'The premise', exact: true })
    .fill('pirates searching for treasure');
  await page.getByLabel('Tone & themes').fill('Whimsical mystery');
  await page.getByLabel('GM output language').selectOption('Nederlands');
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  const firstDraft = {
    setting: 'Een zee vol drijvende eilanden',
    premise: 'Een schatkaart tekent elke ochtend een verdwenen eiland.',
    tone: 'Speels mysterie',
    partyGoal: 'Vind het verdwenen eiland',
    instructions: 'Breng de groep samen bij een zinkende veerboot; iemand zit nog vast. Beschrijf omstanders kort en introduceer ze bij het eerste gesprek.',
  };
  const secondDraft = {
    setting: 'Een haven boven een verdronken stad',
    premise: 'Een wrak veilt elke nacht de schatten van morgen.',
    tone: 'Speels en geheimzinnig',
    partyGoal: 'Vind het veilingwrak',
    instructions: 'Breng de groep samen bij de kade terwijl het veilingwrak losraakt. Geef de groep direct iets om op te reageren.',
  };
  await page.route('**/api/campaigns/improve-premise', async (route) => {
    requests++;
    expect(route.request().postDataJSON()).toMatchObject({
      premise: 'pirates searching for treasure',
      tone: 'Whimsical mystery',
      language: 'Nederlands',
      instructions: '',
    });
    await pending;
    expect(route.request().postDataJSON().setting).toBe('');
    if (requests === 2) expect(route.request().postDataJSON().previousDraft).toEqual(firstDraft);
    await route.fulfill({ json: requests === 1 ? firstDraft : secondDraft });
  });
  await page.getByRole('button', { name: 'Improve prompt', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Improving campaign…' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Create campaign', exact: true })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'The premise', exact: true })).toBeDisabled();
  release();
  await expect(page.getByRole('textbox', { name: 'The premise', exact: true })).toHaveValue(
    'Een schatkaart tekent elke ochtend een verdwenen eiland.',
  );
  expect(requests).toBe(1);
  await expect(page.getByRole('textbox', { name: 'Setting', exact: true })).toHaveValue(firstDraft.setting);
  await expect(page.getByRole('textbox', { name: 'Tone & themes', exact: true })).toHaveValue(
    firstDraft.tone,
  );
  await expect(page.getByRole('textbox', { name: 'Party goal (optional)', exact: true })).toHaveValue(
    firstDraft.partyGoal,
  );
  await expect(page.getByRole('textbox', { name: 'Extra instructions', exact: true })).toHaveValue(
    firstDraft.instructions,
  );
  await page.getByRole('button', { name: 'Improve prompt', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'The premise', exact: true })).toHaveValue(
    secondDraft.premise,
  );
  await expect(page.getByRole('textbox', { name: 'Setting', exact: true })).toHaveValue(secondDraft.setting);
  await expect(page.getByRole('textbox', { name: 'Extra instructions', exact: true })).toHaveValue(
    secondDraft.instructions,
  );
  expect(requests).toBe(2);
  await expect(page).toHaveURL(/\/new$/);
  const me = await (await page.request.get('/api/me')).json();
  expect(me.campaigns).toHaveLength(0);
  await page.getByRole('textbox', { name: 'The premise', exact: true }).fill('My edited premise');
  await page.getByRole('textbox', { name: 'Extra instructions', exact: true }).fill('Keep my guidance.');
  await page.unroute('**/api/campaigns/improve-premise');
  await page.route('**/api/campaigns/improve-premise', (route) =>
    route.fulfill({ status: 503, json: { error: 'Connect ChatGPT first.' } }),
  );
  await page.getByRole('button', { name: 'Improve prompt', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Connect ChatGPT first.');
  await expect(page.getByRole('textbox', { name: 'The premise', exact: true })).toHaveValue(
    'My edited premise',
  );
  await expect(page.getByRole('textbox', { name: 'Extra instructions', exact: true })).toHaveValue(
    'Keep my guidance.',
  );
  await page.getByRole('radio', { name: /Practice table/ }).check();
  await expect(page.getByRole('button', { name: 'Improve prompt', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('starting equipment enforces separate weapon and non-weapon quotas with a three-item preview', async ({
  page,
}) => {
  const headers = { 'x-gather-request': '1' };
  const character = templateCharacter('Mira');
  character.traits[0].stats.DEX = 1;
  character.equipmentOptions[1].attributeBonus = { stat: 'STR', amount: 1 };
  character.equipmentOptions[2].attributeBonus = { stat: 'DEX', amount: 1 };
  const saved = await (await page.request.post('/api/characters', { headers, data: character })).json();
  const campaign = await (
    await page.request.post('/api/campaigns', {
      headers,
      data: {
        name: 'Harbor',
        setting: 'A coastal city',
        premise: '',
        tone: '',
        language: 'English',
        instructions: '',
        custom: [],
        provider: 'practice',
      },
    })
  ).json();
  await page.request.post('/api/join', {
    headers,
    data: { code: campaign.inviteCode, playerName: 'Mira player', characterId: saved.id },
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/campaign/${campaign.id}`);
  const weapons = page.getByRole('group', { name: 'Weapons', exact: true });
  const gear = page.getByRole('group', { name: 'Non-weapon equipment', exact: true });
  const weaponChoices = weapons.locator('.equipment-choice-select');
  const gearChoices = gear.locator('.equipment-choice-select');
  const confirm = page.getByRole('button', { name: 'Confirm starting equipment', exact: true });
  await expect(weaponChoices).toHaveCount(2);
  await expect(gearChoices).toHaveCount(5);
  await weaponChoices.nth(0).click();
  await expect(weaponChoices.nth(1)).toBeEnabled();
  await gearChoices.nth(0).click();
  await expect(confirm).toBeDisabled();
  await gearChoices.nth(1).click();
  await expect(gearChoices.nth(2)).toBeDisabled();
  await expect(weapons).toContainText('1/1 selected');
  await expect(gear).toContainText('2/2 selected');
  await expect(page.getByLabel('Starting loadout preview')).toContainText('Short sword');
  await expect(page.getByLabel('Starting loadout preview')).toContainText('Chainmail');
  await expect(page.getByLabel('Starting loadout preview')).toContainText('Travel boots');
  await expect(page.getByLabel('Starting loadout preview')).toContainText('Total Defense: 10 → 13');
  await expect(page.getByLabel('Starting loadout preview')).toContainText('DEX: 6 → 7');
  await expect(gear.getByRole('button', { name: '+1 STR', exact: true })).toBeVisible();
  await weaponChoices.nth(1).click();
  await expect(weaponChoices.nth(0)).toHaveAttribute('aria-pressed', 'false');
  await expect(weaponChoices.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(confirm).toBeEnabled();
  await weaponChoices.nth(1).click();
  await expect(confirm).toBeDisabled();
  await weaponChoices.nth(1).click();
  await expect(confirm).toBeEnabled();
  await page.screenshot({ path: 'test-results/starting-equipment-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await confirm.click();
  await expect(page.getByRole('button', { name: 'Begin the story', exact: true })).toBeEnabled();
  const snapshot = await (await page.request.get(`/api/campaigns/${campaign.id}`)).json();
  expect(snapshot.members[0].state.equipmentChosen).toBe(true);
  expect(snapshot.members[0].state.equipment.right.name).toBe('Hunting knife');
});
