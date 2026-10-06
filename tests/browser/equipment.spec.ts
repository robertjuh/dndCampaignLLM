import { test, expect, type APIRequestContext } from '@playwright/test';
import { templateCharacter, type Snapshot } from '../../shared/schema';
import { baseItem, randomLoot } from '../../shared/rules';
import { conditionDescription } from '../../shared/ailments';

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(path, { headers: { 'x-gather-request': '1' }, data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test('shared-screen item inspection exposes types and mechanics without changing equipment', async ({
  page,
}) => {
  const character = templateCharacter('Fransinator');
  character.equipmentOptions[0] = {
    ...baseItem('focus', 'Pijnreservoir', 'focus'),
    scaling: ['CHA'],
    attackBonus: 1,
    description: 'A reservoir that channels conviction.',
  };
  character.equipmentOptions[1] = {
    ...baseItem('shield', 'Afkickkliniekdeur', 'shield'),
    defense: 1,
    description: 'A clinic door repurposed as a shield.',
  };
  character.selectedEquipmentIds = character.equipmentOptions.slice(0, 2).map((item) => item.id);
  character.healingItemName = 'Verzegelde ontwenningsampul';
  const saved = await post<{ id: string }>(page.request, '/api/characters', character);
  const campaign = await post<Snapshot>(page.request, '/api/campaigns', {
    name: 'Item inspection',
    setting: 'An ash wasteland',
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
    playerName: 'Fransinator player',
    characterId: saved.id,
  });
  const before = structuredClone(snapshot.members[0].state);
  snapshot.members[0].state.conditions = ['Weakened', 'Stunned', 'Burning', 'Custom curse'];
  // Include a stowed weapon to verify that backpack items can also be inspected.
  snapshot.members[0].state.inventory.push({
    ...baseItem('spare-weapon', 'Spare blade', 'weapon'),
    rarity: 'Legendary',
    onHit: { ailment: 'Burning', chance: 25 },
    grantedAbility: { ...character.abilities[0], name: 'Flame surge' },
    damage: '2d4',
    scaling: ['STR'],
    requirements: { STR: 7, DEX: 0, INT: 0, CHA: 0, CON: 0, WIS: 0 },
    hands: 2,
    description: 'A heavy spare blade.',
    quantity: 1,
  });
  for (const kind of ['armour', 'helmet', 'boots', 'relic', 'tool'] as const)
    snapshot.members[0].state.inventory.push({
      ...baseItem(`spare-${kind}`, `Spare ${kind}`, kind),
      quantity: 1,
    });
  snapshot.isHost = false;
  snapshot.myMemberId = null;
  await page.addInitScript(() =>
    Object.defineProperty(window, 'EventSource', {
      value: class {
        close() {}
      },
    }),
  );
  await page.route(`**/api/campaigns/${campaign.id}`, (route) => route.fulfill({ json: snapshot }));
  await page.goto(`/screen/${campaign.id}#${campaign.displayToken}`);
  const card = page.locator('.member-card');
  const weakened = card.locator('.conditions span').filter({ hasText: 'Weakened' });
  await weakened.hover();
  await expect(weakened).toHaveText('Weakened · 2 turns');
  await expect(card.locator('.conditions span').filter({ hasText: 'Burning' })).toHaveAttribute(
    'title',
    /blanket/,
  );
  await expect(weakened).toHaveAttribute('title', conditionDescription('Weakened')!);
  await expect(weakened).toHaveAttribute('aria-label', /^Weakened: -2 to attack rolls/);
  await expect(card.locator('.conditions span').filter({ hasText: 'Stunned' })).toHaveAttribute(
    'title',
    conditionDescription('Stunned')!,
  );
  await expect(card.locator('.conditions span').filter({ hasText: 'Burning' })).toHaveAttribute(
    'title',
    conditionDescription('Burning')!,
  );
  await expect(card.locator('.conditions span').filter({ hasText: 'Custom curse' })).toHaveAttribute(
    'aria-label',
    'Custom curse',
  );
  await card.getByRole('button', { name: 'Fransinator' }).click();
  const itemIcons = card.locator('.item-inspection summary .item-icon');
  await expect(itemIcons).toHaveCount(9);
  for (const icon of await itemIcons.all()) {
    await expect(icon).toBeVisible();
    await expect(icon).toHaveAttribute('aria-hidden', 'true');
  }
  expect(new Set(await itemIcons.evaluateAll((icons) => icons.map((icon) => icon.innerHTML))).size).toBe(9);
  const focus = card.locator('.item-inspection').filter({ hasText: 'Pijnreservoir' });
  await expect(focus.locator('summary')).toHaveText('Pijnreservoir (focus)');
  await expect(focus.getByText(character.equipmentOptions[0].description, { exact: true })).not.toBeVisible();
  await focus.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(focus.getByText(character.equipmentOptions[0].description, { exact: true })).toBeVisible();
  await expect(focus).toContainText('+1 CHA attack rolls while equipped');
  await expect(focus).not.toContainText('1d4');
  const shield = card.locator('.item-inspection').filter({ hasText: 'Afkickkliniekdeur' });
  await expect(shield.locator('summary')).toHaveText('Afkickkliniekdeur (shield)');
  await shield.locator('summary').click();
  await expect(shield).toContainText('+1 defense');
  await expect(shield).toContainText('1d4 block per enemy hit while equipped');
  await expect(shield).toContainText('disabled while Stunned, Frozen or Electrocuted');
  await expect(card.locator('li').filter({ hasText: 'Body' })).toHaveText('BodyNone');
  const potion = card.locator('.item-inspection').filter({ hasText: character.healingItemName });
  await expect(potion.locator('summary')).toContainText('(consumable)');
  await expect(potion.locator('..')).toContainText('×1');
  await potion.locator('summary').click();
  await expect(potion).toContainText('Heal 6 HP');
  const weapon = card.locator('.item-inspection').filter({ hasText: 'Spare blade' });
  await expect(weapon.locator('summary')).toHaveText('Spare blade (weapon)');
  await weapon.locator('summary').click();
  await expect(weapon).toContainText('Innate dice + 2d4 + 2 × STR modifier');
  await expect(weapon).toContainText('Two-handed');
  await expect(weapon).toContainText('Requires 7 STR');
  await expect(weapon).toContainText('25% chance to inflict Burning on weapon hits (100% on critical hits)');
  await expect(weapon).toContainText('Grants Flame surge while equipped');
  await focus.locator('summary').click();
  await expect(focus.getByText(character.equipmentOptions[0].description, { exact: true })).not.toBeVisible();
  await expect(card.getByRole('button', { name: /Equip|Drop|Stow/ })).toHaveCount(0);
  const after: Snapshot = await (await page.request.get(`/api/campaigns/${campaign.id}`)).json();
  expect(after.members[0].state).toEqual(before);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/shared-item-inspection.png', fullPage: true });
});

test('starting and stowed relics use the designated relic slot without a hand selector', async ({ page }) => {
  const character = templateCharacter('Relic bearer');
  character.equipmentOptions[0] = {
    ...baseItem('oath', 'Remembered oath', 'relic'),
    scaling: ['INT'],
    checkBonus: 1,
  };
  character.equipmentOptions[1].name = 'Oath blade';
  const saved = await post<{ id: string }>(page.request, '/api/characters', character);
  const campaign = await post<Snapshot>(page.request, '/api/campaigns', {
    name: 'Relic equipment',
    setting: 'A quiet tower',
    premise: '',
    tone: '',
    language: 'English',
    instructions: '',
    custom: [],
    provider: 'practice',
    model: '',
  });
  await post(page.request, '/api/join', {
    code: campaign.inviteCode,
    playerName: 'Relic player',
    characterId: saved.id,
  });
  await page.goto(`/campaign/${campaign.id}`);
  await page.locator('.equipment-choices button').nth(0).click();
  await page.locator('.equipment-choices button').nth(1).click();
  await expect(page.locator('.equipment-choices button .item-icon')).toHaveCount(5);
  await expect(page.getByLabel('Starting loadout preview')).toContainText('Relic: Remembered oath');
  await expect(page.getByLabel('Starting loadout preview')).toContainText('Right hand: Oath blade');
  await page.getByRole('button', { name: 'Confirm starting equipment', exact: true }).click();
  await page.getByRole('button', { name: 'Begin the story', exact: true }).click();
  await expect(page.getByLabel('Your action')).toBeEnabled();
  await page.getByRole('button', { name: 'Equipment & backpack', exact: true }).click();
  const relicSlot = page.getByRole('article', { name: 'Relic', exact: true });
  await expect(relicSlot).toContainText('Remembered oath');
  await expect(relicSlot.locator('.item-icon')).toBeVisible();
  await expect(page.getByRole('article', { name: 'Left hand', exact: true })).toContainText('Empty');
  await expect(page.getByRole('article', { name: 'Right hand', exact: true })).toContainText('Oath blade');
  await relicSlot.getByRole('button', { name: 'Stow item' }).click();
  await expect(relicSlot).toContainText('Empty');
  const stowed = page.getByRole('article', { name: 'Remembered oath', exact: true });
  await expect(stowed.locator('.item-icon')).toBeVisible();
  await expect(stowed.getByRole('combobox')).toHaveCount(0);
  await stowed.getByRole('button', { name: 'Equip', exact: true }).click();
  await expect(relicSlot).toContainText('Remembered oath');
  await expect(page.locator('.gear-feedback')).toHaveText('Equipped Remembered oath (relic slot).');
  const snapshot: Snapshot = await (await page.request.get(`/api/campaigns/${campaign.id}`)).json();
  expect(snapshot.members[0].state.equipment.relic?.name).toBe('Remembered oath');
  expect(snapshot.members[0].state.equipment.left).toBeNull();
  expect(snapshot.members[0].state.equipment.right?.name).toBe('Oath blade');
});

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
    { ...baseItem('oath', 'Empty-slot relic', 'relic'), quantity: 1 },
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
  const relic = page.getByRole('article', { name: 'Empty-slot relic', exact: true });
  await expect(relic.locator('.gear-item-info > b .item-icon')).toBeVisible();
  await expect(relic.getByRole('combobox')).toHaveCount(0);
  await expect(relic.getByRole('button', { name: 'Take item' })).toBeDisabled();
  await expect(relic.getByRole('button', { name: 'Take & equip' })).toBeEnabled();
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

test('Legendary gear exposes equipped abilities with the correct combat scope and item charge', async ({
  page,
}) => {
  const character = templateCharacter('Mira');
  character.selectedEquipmentIds = character.equipmentOptions.slice(0, 2).map((item) => item.id);
  const saved = await post<{ id: string }>(page.request, '/api/characters', character);
  const campaign = await post<Snapshot>(page.request, '/api/campaigns', {
    name: 'Legendary gear',
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
  const boots = randomLoot(
    'legendary-boots',
    1,
    () => 1,
    { name: 'Ember boots', kind: 'boots', scaling: [], hands: 1, light: false, description: '' },
    'Legendary',
  );
  const focus = randomLoot(
    'legendary-focus',
    1,
    () => 1,
    { name: 'Ember focus', kind: 'focus', scaling: ['INT'], hands: 1, light: false, description: '' },
    'Legendary',
  );
  member.character.abilities.push(
    ...(['combat', 'utility'] as const).map((kind) => ({
      name: `${kind} field mend`,
      description: 'Heal and cure Burning.',
      kind,
      effect: 'mend' as const,
      stat: 'WIS' as const,
      level: 1,
      cures: ['Burning' as const],
    })),
  );
  member.state.equipment.boots = boots;
  member.state.equipment.right = focus;
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
  await page.addInitScript(() =>
    Object.defineProperty(window, 'EventSource', {
      value: class {
        close() {}
      },
    }),
  );
  await page.route(`**/api/campaigns/${campaign.id}`, (route) => route.fulfill({ json: snapshot }));
  await page.goto(`/campaign/${campaign.id}`);
  const bootAbility = page.locator('.ability-card').filter({ hasText: 'Ember boots: insight' });
  const focusAbility = page.locator('.ability-card').filter({ hasText: 'Ember focus: surge' });
  await expect(bootAbility).toContainText('Utility');
  await expect(bootAbility.getByRole('button', { name: 'Use ability' })).toBeEnabled();
  await expect(focusAbility).toContainText('Combat');
  await expect(focusAbility.getByRole('button', { name: 'Use ability' })).toBeDisabled();
  for (const kind of ['combat', 'utility']) {
    const healing = page
      .locator('.character-controls .ability-card')
      .filter({ hasText: `${kind} field mend` });
    await expect(healing).toContainText('In or out of combat');
    await expect(healing.getByRole('button', { name: 'Use ability' })).toBeEnabled();
  }
  member.state.abilityUses = { 'equipment:legendary-boots': 1 };
  await page.reload();
  await expect(bootAbility).toContainText('0/1 uses remaining');
  await expect(bootAbility.getByRole('button', { name: 'Use ability' })).toBeDisabled();
  member.state.equipment.boots = null;
  member.state.inventory.push({ ...boots, quantity: 1 });
  snapshot.scene.encounter = { enemies: [], round: 1, initiative: [], victory: false, escaped: false };
  await page.reload();
  await expect(bootAbility).toHaveCount(0);
  await expect(focusAbility.getByRole('button', { name: 'Use ability' })).toBeEnabled();
  const utility = page.locator('.character-controls .ability-card').filter({ hasText: 'Keen observation' });
  await expect(utility).toContainText('Advantage and +2');
  await expect(utility.getByRole('button', { name: 'Use ability' })).toBeEnabled();
  for (const kind of ['combat', 'utility']) {
    const healing = page
      .locator('.character-controls .ability-card')
      .filter({ hasText: `${kind} field mend` });
    await expect(healing.getByRole('button', { name: 'Use ability' })).toBeEnabled();
  }
  member.state.equipment.left = focus;
  await page.reload();
  await expect(focusAbility).toHaveCount(1);
});
