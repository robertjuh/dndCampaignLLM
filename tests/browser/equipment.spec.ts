import { test, expect, type APIRequestContext } from '@playwright/test';
import { templateCharacter, type Snapshot } from '../../shared/schema';
import { baseItem } from '../../shared/rules';

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(path, { headers: { 'x-gather-request': '1' }, data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test('mobile equipment previews swaps, equips nearby loot, and records free changes in the turn summary', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const character = templateCharacter('Mira');
  character.equipmentOptions = [
    { ...baseItem('coat', 'Moon coat', 'armour'), defense: 1, scaling: ['STR'] },
    {
      ...baseItem('coat-2', 'Iron coat', 'armour'),
      defense: 1,
      description: 'A shield etched with stars.',
    },
    { ...baseItem('boots', 'Leather boots', 'boots'), defense: 1 },
    { ...baseItem('helmet', 'Leather cap', 'helmet'), defense: 1 },
    { ...baseItem('armour', 'Leather coat', 'armour'), defense: 1 },
  ];
  const saved = await post<{ id: string }>(page.request, '/api/characters', character);
  const campaign = await post<Snapshot>(page.request, '/api/campaigns', {
    name: 'Equipment rehearsal',
    setting: 'A quiet tower',
    premise: '',
    tone: 'Adventurous',
    language: 'English',
    instructions: '',
    custom: [],
    provider: 'practice',
    model: '',
  });
  await post(page.request, '/api/join', {
    code: campaign.inviteCode,
    playerName: 'Mira player',
    characterId: saved.id,
  });
  await page.goto(`/campaign/${campaign.id}`);
  await page.locator('.equipment-choices button').nth(0).click();
  await page.locator('.equipment-choices button').nth(1).click();
  await expect(page.getByLabel('Starting loadout preview')).toContainText('Body: Moon coat');
  await expect(page.getByLabel('Starting loadout preview')).toContainText('Backpack: Iron coat');
  await page.getByRole('button', { name: 'Confirm starting equipment', exact: true }).click();
  await page.getByRole('button', { name: 'Equipment & backpack', exact: true }).click();
  await expect(
    page
      .getByRole('article', { name: 'Iron coat', exact: true })
      .getByRole('button', { name: 'Equip', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Equipment & backpack', exact: true }).click();
  await page.getByRole('button', { name: 'Begin the story', exact: true }).click();
  await expect(page.getByLabel('Your action')).toBeEnabled();
  const before: Snapshot = await (await page.request.get(`/api/campaigns/${campaign.id}`)).json();
  await page.getByRole('button', { name: 'Equipment & backpack', exact: true }).click();
  const gear = page.getByRole('region', { name: 'Equipment and backpack' });
  await expect(gear.getByRole('article', { name: 'Body', exact: true })).toContainText('Moon coat');
  await expect(gear.getByRole('article', { name: 'Head', exact: true })).toContainText('Empty');
  const shield = gear.getByRole('article', { name: 'Iron coat', exact: true });
  await expect(shield).toContainText('Stows Moon coat');
  await expect(shield).toContainText('Backpack 2/8 → 2/8');
  await expect(shield.getByText('A shield etched with stars.', { exact: true })).not.toBeVisible();
  await shield.getByText('Description', { exact: true }).click();
  await expect(shield.getByText('A shield etched with stars.', { exact: true })).toBeVisible();
  await shield.getByRole('button', { name: 'Equip', exact: true }).click();
  await expect(gear.getByRole('article', { name: 'Body', exact: true })).toContainText('Iron coat');
  await expect(gear.getByRole('article', { name: 'Left hand', exact: true })).toContainText('Empty');
  await expect(page.locator('.gear-feedback')).toContainText('Stowed: Moon coat');
  const after: Snapshot = await (await page.request.get(`/api/campaigns/${campaign.id}`)).json();
  expect(after.turn!.id).toBe(before.turn!.id);
  expect(after.turn!.actions).toEqual([]);
  await gear
    .getByRole('article', { name: 'Body', exact: true })
    .getByRole('button', { name: 'Stow item' })
    .click();
  await gear
    .getByRole('article', { name: 'Iron coat', exact: true })
    .getByRole('button', { name: 'Drop', exact: true })
    .click();
  const loot = page.getByRole('region', { name: 'Nearby loot' });
  await loot
    .getByRole('article', { name: 'Iron coat', exact: true })
    .getByRole('button', { name: 'Take & equip', exact: true })
    .click();
  await expect(loot).toHaveCount(0);
  await page.getByLabel('Your action').fill('Inspect the tower.');
  await page.getByRole('button', { name: 'Submit action', exact: true }).click();
  await expect(page.locator('.recap')).toContainText('Equipment changes:');
  await expect(page.locator('.recap')).toContainText('Mira: Equipped Iron coat (body). Stowed: Moon coat.');
  await expect(page.locator('.recap')).toContainText('Mira: Dropped Iron coat.');
  await expect(page.locator('.turn-equipment-changes')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/equipment-mobile.png', fullPage: true });
  await page.reload();
  await expect(page.locator('.recap')).toContainText('Mira: Stowed Iron coat.');
});

test('equipment controls explain combat, full backpacks, and unmet requirements before clicking', async ({
  page,
}) => {
  const character = templateCharacter('Mira');
  character.selectedEquipmentIds = character.equipmentOptions.slice(0, 2).map((item) => item.id);
  const saved = await post<{ id: string }>(page.request, '/api/characters', character);
  const campaign = await post<Snapshot>(page.request, '/api/campaigns', {
    name: 'Equipment limits',
    setting: 'A tower',
    premise: '',
    tone: '',
    language: 'English',
    instructions: '',
    custom: [],
    provider: 'practice',
    model: '',
  });
  const snapshot = await post<Snapshot>(page.request, '/api/join', {
    code: campaign.inviteCode,
    playerName: 'Mira player',
    characterId: saved.id,
  });
  const member = snapshot.members[0];
  snapshot.status = 'active';
  snapshot.turn = {
    id: crypto.randomUUID(),
    number: 1,
    phase: 'collecting',
    roster: [member.id],
    actions: [],
    rolls: [],
    result: null,
    error: null,
  };
  member.state.inventory = Array.from({ length: 8 }, (_, index) => ({
    ...baseItem(`spare-${index}`, `Spare ${index}`, 'relic'),
    quantity: 1,
  }));
  member.state.inventory[0].requirements.STR = 50;
  snapshot.scene.loot = [
    { ...baseItem('great', 'Two-handed loot', 'weapon'), hands: 2, quantity: 1 },
    { ...baseItem('boots', 'Empty-slot boots', 'boots'), quantity: 1 },
  ];
  await page.addInitScript(() =>
    Object.defineProperty(window, 'EventSource', {
      value: class {
        close() {}
      },
    }),
  );
  await page.route(`**/api/campaigns/${campaign.id}`, (route) => route.fulfill({ json: snapshot }));
  await page.goto(`/campaign/${campaign.id}`);
  await page.getByRole('button', { name: 'Equipment & backpack', exact: true }).click();
  const restricted = page.getByRole('article', { name: 'Spare 0', exact: true });
  await expect(restricted).toContainText('requires 50 STR');
  await expect(restricted.getByRole('button', { name: 'Equip', exact: true })).toBeDisabled();
  const great = page.getByRole('article', { name: 'Two-handed loot', exact: true });
  await expect(great.getByRole('button', { name: 'Take & equip' })).toBeDisabled();
  await great.getByText('Choose items to drop to make room', { exact: true }).click();
  await great.getByRole('checkbox', { name: 'Spare 1 ×1', exact: true }).check();
  await great.getByRole('checkbox', { name: 'Spare 2 ×1', exact: true }).check();
  await expect(great.getByRole('button', { name: 'Take & equip' })).toBeEnabled();
  await expect(great).toContainText('Backpack 8/8 → 8/8');
  const boots = page.getByRole('article', { name: 'Empty-slot boots', exact: true });
  await expect(boots.getByRole('button', { name: 'Take item' })).toBeDisabled();
  await expect(boots.getByRole('button', { name: 'Take & equip' })).toBeEnabled();
  snapshot.scene.encounter = { enemies: [], round: 1, initiative: [], victory: false, escaped: false };
  await page.reload();
  await page.getByRole('button', { name: 'Equipment & backpack', exact: true }).click();
  await expect(page.locator('.gear-lock')).toContainText('outside combat');
  for (const button of await page.locator('.equipment-manager .gear-actions button').all())
    await expect(button).toBeDisabled();
  snapshot.scene.encounter = null;
  snapshot.turn.actions = [{ memberId: member.id, text: 'Watch the tower', passed: false }];
  await page.reload();
  await page.getByRole('button', { name: 'Equipment & backpack', exact: true }).click();
  await expect(page.locator('.gear-lock')).toContainText('after submitting your action');
});
