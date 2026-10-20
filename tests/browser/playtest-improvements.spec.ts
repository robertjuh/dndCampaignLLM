import { test, expect, type Page } from '@playwright/test';
import { templateCharacter, type Snapshot } from '../../shared/schema';
import { baseItem } from '../../shared/rules';
import { ensureLocations, updateLocation } from '../../shared/locations';

async function table(page: Page, language: string) {
  const post = async (path: string, data: unknown) => {
    const response = await page.request.post(path, { headers: { 'x-gather-request': '1' }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const character = templateCharacter('Mira');
  character.selectedEquipmentIds = character.equipmentOptions.slice(0, 2).map((item) => item.id);
  const saved = await post('/api/characters', character);
  const campaign = await post('/api/campaigns', {
    name: 'Playtest improvements',
    setting: 'Checkpoint',
    language,
    premise: '',
    tone: '',
    instructions: '',
    custom: [],
    provider: 'practice',
    model: '',
  });
  const snapshot: Snapshot = await post('/api/join', {
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
  snapshot.scene.encounter = {
    round: 1,
    victory: false,
    escaped: false,
    initiative: [],
    enemies: [
      {
        id: 'drone',
        name: 'Checkpoint drone',
        tier: 'minor',
        hp: 8,
        maxHp: 8,
        defense: 10,
        attack: 1,
        damage: '1d4',
        description: 'A drone with a grabbing arm.',
        tactic: 'Guard the checkpoint.',
        onHit: null,
        initiative: 10,
      },
    ],
  };
  snapshot.scene.loot = [
    { ...baseItem('key', 'Service key', 'tool'), quantity: 1, description: 'Opens the maintenance hatch.' },
  ];
  await page.addInitScript(() =>
    Object.defineProperty(window, 'EventSource', {
      value: class {
        close() {}
      },
    }),
  );
  await page.route(`**/api/campaigns/${snapshot.id}`, (route) => route.fulfill({ json: snapshot }));
  await page.goto(`/campaign/${snapshot.id}`);
  return snapshot;
}

for (const language of ['English', 'Nederlands']) {
  test(`enemy cards preserve draft text and insert a localized attack in ${language}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const snapshot = await table(page, language);
    const input = page.getByRole('textbox', { name: 'Your action', exact: true });
    const target = page.getByRole('button', { name: 'Add Checkpoint drone to your action', exact: true });
    await target.click();
    await expect(input).toHaveValue(
      language === 'Nederlands' ? 'Ik val Checkpoint drone aan.' : 'I attack Checkpoint drone.',
    );
    await expect(input).toBeFocused();
    await input.fill('I throw oil at the arm.');
    await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(15, 22));
    await target.click();
    await expect(input).toHaveValue('I throw oil at Checkpoint drone the arm.');
    await input.fill('');
    await target.focus();
    await page.keyboard.press('Enter');
    await expect(input).toHaveValue(
      language === 'Nederlands' ? 'Ik val Checkpoint drone aan.' : 'I attack Checkpoint drone.',
    );
    await expect(page.getByText('Your action is submitted', { exact: true })).toHaveCount(0);
    snapshot.turn!.actions = [{ memberId: snapshot.myMemberId!, text: 'Attack the drone', passed: false }];
    await page.reload();
    await expect(page.getByRole('button', { name: 'Add Checkpoint drone to your action' })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('mobile toolbar opens action, abilities and equipment without covering the last player card', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const snapshot = await table(page, 'Nederlands');
  snapshot.factions = [
    { id: 'wardens', name: 'Gate Wardens', knownDescription: 'Guardians of the gate.', discoveredTurn: 0 },
  ];
  snapshot.members[0].state.lastLevelUp = 'Gained +1 STR and +1 DEX.';
  snapshot.members[0].character.abilities.push(
    ...Array.from({ length: 12 }, (_, index) => ({
      ...snapshot.members[0].character.abilities[0],
      name: `Extra ability ${index + 1}`,
    })),
  );
  await page.reload();
  await expect(page.locator('.character-controls .faction-relations')).toHaveCount(0);
  await expect(page.getByText(snapshot.members[0].state.lastLevelUp, { exact: true })).toHaveCount(0);
  await page.locator('.member-heading').click();
  await expect(page.locator('.member-card').getByRole('region', { name: 'Factierelaties' })).toContainText(
    'Gate Wardens',
  );
  await page.locator('.member-heading').click();

  const input = page.getByRole('textbox', { name: 'Your action', exact: true });
  const toggle = page.getByRole('button', { name: 'Open action input', exact: true });
  const close = page.getByRole('button', { name: 'Collapse action input', exact: true });
  const composer = page.getByRole('form', { name: 'Action composer', exact: true });
  const abilitiesToggle = page.getByRole('button', { name: 'Open abilities', exact: true });
  const abilities = page.getByRole('region', { name: 'Your abilities', exact: true });
  const abilitiesClose = page.getByRole('button', { name: 'Collapse abilities', exact: true });
  const toolbar = page.getByRole('group', { name: 'Player controls', exact: true });
  const equipmentToggle = toolbar.getByRole('button', { name: 'Equipment & backpack', exact: true });
  const equipment = page.getByRole('region', { name: 'Your equipment', exact: true });
  const equipmentClose = page.getByRole('button', { name: 'Collapse equipment', exact: true });
  await expect(input).toBeHidden();
  await expect(abilities).toBeHidden();
  await expect(equipment).toBeHidden();
  await expect(toolbar.getByRole('button')).toHaveCount(3);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(toggle).toBeInViewport();
  await expect(abilitiesToggle).toBeInViewport();
  await expect(equipmentToggle).toBeInViewport();
  const lastCard = (await page.locator('.member-card').last().boundingBox())!;
  expect(lastCard.y + lastCard.height).toBeLessThanOrEqual((await toolbar.boundingBox())!.y);
  expect(await toolbar.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
    'rgba(0, 0, 0, 0)',
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await toggle.click();
  await expect(input).toBeFocused();
  expect(await page.evaluate(() => scrollY)).toBe(0);
  const composerBox = (await composer.boundingBox())!;
  expect(composerBox.y + composerBox.height).toBeCloseTo((await toolbar.boundingBox())!.y, 0);
  await input.fill('I inspect the checkpoint.');
  await close.click();
  await expect(input).toBeHidden();
  await expect(toggle).toBeFocused();
  await toggle.click();
  await expect(input).toHaveValue('I inspect the checkpoint.');

  // A phone keyboard can shrink the visual viewport without resizing the page layout.
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 420 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  const keyboardBox = (await composer.boundingBox())!;
  const keyboardToolbar = (await toolbar.boundingBox())!;
  expect(keyboardToolbar.y + keyboardToolbar.height).toBeCloseTo(420, 0);
  expect(keyboardBox.y + keyboardBox.height).toBeCloseTo(keyboardToolbar.y, 0);
  await expect(input).toBeInViewport();
  await page.evaluate(() => {
    Reflect.deleteProperty(window.visualViewport!, 'height');
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await page.screenshot({ path: 'test-results/action-composer-mobile.png' });
  await input.press('Escape');
  await expect(input).toBeHidden();
  const storyHeight = await page.locator('.story-column').evaluate((element) => element.clientHeight);
  const storyScroll = await page.evaluate(() => scrollY);
  await abilitiesToggle.click();
  await expect(abilities).toBeVisible();
  await expect(abilitiesClose).toBeFocused();
  await expect(input).toBeHidden();
  expect(await page.evaluate(() => scrollY)).toBe(storyScroll);
  expect(await page.locator('.story-column').evaluate((element) => element.clientHeight)).toBe(storyHeight);
  expect(await abilities.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await abilities.evaluate((element) => (element.scrollTop = element.scrollHeight));
  await expect(abilitiesClose).toBeInViewport();
  await abilitiesClose.click();
  await expect(abilities).toBeHidden();
  await expect(abilitiesToggle).toBeFocused();
  await abilitiesToggle.click();
  await abilitiesClose.press('Escape');
  await expect(abilities).toBeHidden();
  await abilitiesToggle.click();
  await abilities.evaluate((element) => (element.scrollTop = 0));
  await page.screenshot({ path: 'test-results/abilities-mobile.png' });
  await page
    .locator('.character-controls')
    .getByRole('button', { name: 'Use ability', exact: true })
    .first()
    .click();
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('I inspect the checkpoint.');
  await expect(page.locator('.selected-ability')).toBeVisible();
  await expect(abilities).toBeHidden();

  await equipmentToggle.click();
  await expect(equipment).toBeVisible();
  await expect(input).toBeHidden();
  await expect(abilities).toBeHidden();
  await expect(equipmentClose).toBeFocused();
  await expect(equipment.getByRole('region', { name: 'Equipment and backpack', exact: true })).toBeVisible();
  const equipmentBox = (await equipment.boundingBox())!;
  expect(equipmentBox.y + equipmentBox.height).toBeCloseTo((await toolbar.boundingBox())!.y, 0);
  await equipment.evaluate((element) => (element.scrollTop = element.scrollHeight));
  await expect(equipmentClose).toBeInViewport();
  await equipmentClose.press('Escape');
  await expect(equipment).toBeHidden();
  await expect(equipmentToggle).toBeFocused();
  await equipmentToggle.click();
  await equipment.evaluate((element) => (element.scrollTop = 0));
  await page.screenshot({ path: 'test-results/equipment-toolbar-mobile.png' });
  await toggle.click();
  await expect(input).toHaveValue('I inspect the checkpoint.');
  await expect(page.locator('.selected-ability')).toBeVisible();
  await expect(equipment).toBeHidden();

  await page.route(`**/api/campaigns/${snapshot.id}/action`, async (route) => {
    const body = route.request().postDataJSON();
    expect(body).toMatchObject({
      turnId: snapshot.turn!.id,
      text: 'I inspect the checkpoint.',
      passed: false,
    });
    expect(body.abilityName).toBeTruthy();
    snapshot.turn!.actions = [{ ...body, memberId: snapshot.myMemberId! }];
    snapshot.version++;
    await route.fulfill({ json: snapshot });
  });
  await page.getByRole('button', { name: 'Submit action', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel action', exact: true })).toBeVisible();
  await close.click();
  await expect(input).toBeHidden();
  await expect(toggle).toBeInViewport();
  await page.screenshot({ path: 'test-results/action-bubble-mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.setViewportSize({ width: 320, height: 568 });
  const abilitiesButton = (await abilitiesToggle.boundingBox())!;
  const actionButton = (await toggle.boundingBox())!;
  const equipmentButton = (await equipmentToggle.boundingBox())!;
  expect(actionButton.x + actionButton.width).toBeLessThanOrEqual(abilitiesButton.x);
  expect(abilitiesButton.x + abilitiesButton.width).toBeLessThanOrEqual(equipmentButton.x);
  expect(equipmentButton.x + equipmentButton.width).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(input).toBeVisible();
  await expect(toggle).toBeHidden();
  await expect(abilitiesToggle).toBeHidden();
  await expect(toolbar).toBeHidden();
  await expect(abilities).toBeVisible();
  expect(await composer.evaluate((element) => getComputedStyle(element).position)).toBe('static');
});

test('combat hides scene loot and victory restores story-item backpack pickup', async ({ page }) => {
  const snapshot = await table(page, 'English');
  await expect(page.getByText('Loot at the scene', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Nearby loot')).toHaveCount(0);
  await page.getByRole('button', { name: 'Equipment & backpack', exact: true }).click();
  await expect(page.locator('.equipment-manager')).toBeVisible();
  snapshot.scene.encounter!.victory = true;
  snapshot.scene.encounter!.enemies[0].hp = 0;
  await page.reload();
  const key = page.getByRole('article', { name: 'Service key', exact: true });
  await key.getByText('Description', { exact: true }).click();
  await expect(key.getByText('Opens the maintenance hatch.', { exact: true })).toBeVisible();
  await expect(key.getByRole('button', { name: 'Take & equip' })).toHaveCount(0);
  await page.route(`**/api/campaigns/${snapshot.id}/character`, async (route) => {
    expect(route.request().postDataJSON()).toEqual({ type: 'take', itemId: 'key' });
    snapshot.members[0].state.inventory.push(snapshot.scene.loot[0]);
    snapshot.scene.loot = [];
    snapshot.version++;
    await route.fulfill({ json: snapshot });
  });
  await key.getByRole('button', { name: 'Take item', exact: true }).click();
  await expect(page.getByLabel('Nearby loot')).toHaveCount(0);
  await page.getByRole('button', { name: 'Equipment & backpack', exact: true }).click();
  const backpackKey = page.getByRole('article', { name: 'Service key', exact: true });
  await expect(backpackKey).toContainText('Carried in your backpack');
  await expect(backpackKey.getByRole('button', { name: 'Equip', exact: true })).toHaveCount(0);
});

test('completed enemies disappear and ground loot stays at the old location after travel', async ({
  page,
}) => {
  const snapshot = await table(page, 'English');
  ensureLocations(
    snapshot.scene,
    snapshot.members.map((member) => member.id),
  );
  const checkpoint = { ...snapshot.scene.location, atmosphere: 'Concrete and dust.' };
  snapshot.scene.encounter!.victory = true;
  snapshot.scene.encounter!.enemies[0].hp = 0;
  await page.reload();
  await expect(page.locator('.combat-panel')).toHaveCount(0);
  await expect(page.getByLabel('Nearby loot')).toBeVisible();
  updateLocation(snapshot.scene, {
    id: null,
    name: 'Bunker',
    atmosphere: 'Red emergency lights.',
    hazard: '',
  });
  snapshot.scene.memberLocations![snapshot.myMemberId!] = snapshot.scene.location.id!;
  const former = { ...structuredClone(snapshot.members[0]), id: crypto.randomUUID(), active: false };
  snapshot.members.push(former);
  snapshot.scene.memberLocations![former.id] = checkpoint.id!;
  await page.reload();
  await expect(page.locator('.location-banner')).toContainText('Bunker');
  await expect(page.locator('.location-banner')).not.toContainText('PARTY SPLIT');
  await expect(page.getByLabel('Nearby loot')).toHaveCount(0);
  await expect(page.locator('.combat-panel')).toHaveCount(0);
  updateLocation(snapshot.scene, checkpoint);
  snapshot.scene.memberLocations![snapshot.myMemberId!] = snapshot.scene.location.id!;
  await page.reload();
  await expect(page.getByLabel('Nearby loot')).toBeVisible();
  await expect(page.locator('.combat-panel')).toHaveCount(0);
});

test('the leader can save or clear an optional goal visible on the shared screen', async ({
  page,
  browser,
}) => {
  const snapshot = await table(page, 'English');
  await page.route(`**/api/campaigns/${snapshot.id}/goal`, async (route) => {
    const { partyGoal } = route.request().postDataJSON();
    snapshot.config.partyGoal = partyGoal;
    snapshot.version++;
    await route.fulfill({ json: snapshot });
  });
  await page.getByRole('button', { name: 'Set party goal', exact: true }).click();
  await page.getByLabel("Your group's goal (optional)").fill('Remove suspicion from our dossier.');
  await page.getByRole('button', { name: 'Save goal', exact: true }).click();
  await expect(page.getByLabel('Party goal')).toContainText('Remove suspicion from our dossier.');
  const context = await browser.newContext();
  const shared = await context.newPage();
  await shared.route(`**/api/campaigns/${snapshot.id}`, (route) => route.fulfill({ json: snapshot }));
  await shared.route(`**/api/campaigns/${snapshot.id}/events`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }),
  );
  await shared.goto(`/screen/${snapshot.id}`);
  await expect(shared.getByLabel('Party goal')).toContainText('Remove suspicion from our dossier.');
  await expect(shared.getByRole('button', { name: 'Edit party goal' })).toHaveCount(0);
  await context.close();
  await page.getByRole('button', { name: 'Edit party goal', exact: true }).click();
  await page.getByLabel("Your group's goal (optional)").fill('');
  await page.getByRole('button', { name: 'Save goal', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Set party goal', exact: true })).toBeVisible();
});

test('recovery and rewards are available in a closed mechanics log beside the situation', async ({
  page,
}) => {
  const snapshot = await table(page, 'English');
  snapshot.history = [
    {
      ...snapshot.turn!,
      id: 'victory-turn',
      number: 0,
      phase: 'complete',
      result: {
        narration: 'The drone falls silent. The checkpoint gate is accessible again.',
        summary: 'The gate is accessible again.\n\nXP rewards:\nMira: +15 XP.',
        choices: [],
        changes: [],
        journal: [],
        xp: 0,
        gold: 0,
        lethalWarning: null,
        location: null,
      },
      resolution: {
        version: 2,
        turnId: 'victory-turn',
        actions: [],
        characters: [],
        rewards: [],
        changes: [],
        journal: [],
        location: null,
        factualRecap: 'The fight has ended.',
        events: [
          {
            id: 'recovery',
            sequence: 0,
            kind: 'mechanics',
            memberId: null,
            actionId: null,
            phase: 'aftermath',
            result: null,
            fact: 'Mira restores one ability charge.',
            receiptRefs: [],
            dependsOn: [],
            presentation: 'log',
          },
        ],
      },
    },
  ];
  await page.reload();
  const log = page.locator('.turn-mechanics');
  await expect(log).not.toHaveAttribute('open', '');
  await expect(page.getByText('Mira restores one ability charge.', { exact: true })).not.toBeVisible();
  await expect(page.getByText('Mira: +15 XP.', { exact: true })).not.toBeVisible();
  await expect(page.locator('.recap > p')).toHaveText('The gate is accessible again.');
  await log.locator('summary').click();
  await expect(page.getByText('Mira restores one ability charge.', { exact: true })).toBeVisible();
  await expect(log).toContainText('Mira: +15 XP.');
});

test('pickup explains the acting player’s submission lock beside the disabled control', async ({ page }) => {
  const snapshot = await table(page, 'English');
  snapshot.scene.encounter!.victory = true;
  snapshot.turn!.actions = [
    {
      memberId: snapshot.myMemberId!,
      text: 'Wait here.',
      passed: false,
      submittedAt: new Date().toISOString(),
    },
  ];
  await page.reload();
  const item = page.getByRole('article', { name: 'Service key', exact: true });
  const take = item.getByRole('button', { name: 'Take item', exact: true });
  await expect(take).toBeDisabled();
  await expect(item).toContainText('Equipment is locked after submitting your action, until the next turn.');
  await expect(take).toHaveAccessibleDescription(/Equipment is locked after submitting your action/);
});

test('linked journal discovery displays the current holder without changing discovery prose', async ({
  page,
}) => {
  const snapshot = await table(page, 'English');
  snapshot.journal = [
    {
      kind: 'fact',
      name: 'Service key discovery',
      detail: 'Found at the checkpoint; opens the maintenance hatch.',
      itemId: 'key',
      itemStatus: 'Carried by Mira.',
    },
  ];
  await page.reload();
  await page.getByRole('button', { name: /World journal/ }).click();
  await expect(
    page.getByText('Found at the checkpoint; opens the maintenance hatch.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Carried by Mira.', { exact: true })).toBeVisible();
});
