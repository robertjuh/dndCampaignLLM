import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { templateCharacter, type Encounter, type Snapshot } from '../../shared/schema';
import { initialState } from '../../shared/rules';

test('players target local enemies while the shared screen shows each occupied fight once', async ({
  page,
  context,
}) => {
  const response = await page.request.post('/api/campaigns', {
    headers: { 'x-gather-request': '1' },
    data: {
      name: 'Separated encounters',
      setting: 'The old roads',
      premise: '',
      tone: '',
      language: 'English',
      instructions: '',
      custom: [],
      provider: 'practice',
    },
  });
  expect(response.ok()).toBe(true);
  const snapshot: Snapshot = await response.json();
  const [inn, ravine, tower] = [randomUUID(), randomUUID(), randomUUID()];
  const encounter = (name: string): Encounter => ({
    round: 2,
    victory: false,
    escaped: false,
    initiative: [],
    enemies: [
      {
        id: randomUUID(),
        name,
        tier: 'minor',
        hp: 8,
        maxHp: 8,
        defense: 10,
        attack: 1,
        damage: '1d4',
        description: 'An armed enemy.',
        tactic: 'Guard the road.',
        onHit: null,
        initiative: 10,
      },
    ],
  });
  snapshot.members = ['Mira', 'Rowan', 'Matthes', 'Cora'].map((name) => {
    const character = templateCharacter(name);
    return {
      id: randomUUID(),
      playerId: randomUUID(),
      playerName: name,
      characterId: randomUUID(),
      character,
      active: true,
      state: { ...initialState(character, name), equipmentChosen: true },
    };
  });
  snapshot.status = 'active';
  snapshot.myMemberId = snapshot.members[0].id;
  snapshot.scene.location = { id: inn, name: 'The inn', atmosphere: '', hazard: '' };
  snapshot.scene.encounter = null;
  snapshot.scene.places = {
    [ravine]: {
      location: { id: ravine, name: 'Ravine', atmosphere: '', hazard: '' },
      encounter: encounter('Ravine wolf'),
      loot: [],
    },
    [tower]: {
      location: { id: tower, name: 'Watchtower', atmosphere: '', hazard: '' },
      encounter: encounter('Tower guard'),
      loot: [],
    },
  };
  snapshot.scene.memberLocations = Object.fromEntries(
    snapshot.members.map((member, index) => [member.id, index < 2 ? ravine : index === 2 ? tower : inn]),
  );
  snapshot.turn = {
    id: randomUUID(),
    number: 3,
    phase: 'collecting',
    roster: snapshot.members.map((member) => member.id),
    actions: [],
    rolls: [],
    result: null,
    error: null,
  };
  const attach = async (view: Page, screen = false) => {
    await view.addInitScript(() =>
      Object.defineProperty(window, 'EventSource', {
        value: class {
          close() {}
        },
      }),
    );
    await view.route(`**/api/campaigns/${snapshot.id}`, (route) => route.fulfill({ json: snapshot }));
    await view.goto(`/${screen ? 'screen' : 'campaign'}/${snapshot.id}`);
  };
  await attach(page);
  await expect(page.getByRole('region', { name: 'Combat at Ravine', exact: true })).toBeVisible();
  await expect(page.locator('.combat-panel')).toHaveCount(1);
  await page.getByRole('button', { name: 'Add Ravine wolf to your action' }).click();
  await expect(page.getByRole('textbox', { name: 'Your action', exact: true })).toHaveValue(
    'I attack Ravine wolf.',
  );
  await expect(page.getByRole('button', { name: 'Add Tower guard to your action' })).toHaveCount(0);

  const shared = await context.newPage();
  await attach(shared, true);
  await expect(shared.locator('.combat-panel')).toHaveCount(2);
  await expect(shared.getByRole('region', { name: 'Combat at Ravine', exact: true })).toHaveCount(1);
  await expect(shared.getByRole('region', { name: 'Combat at Watchtower', exact: true })).toBeVisible();
  await expect(shared.getByRole('button', { name: /Add .+ to your action/ })).toHaveCount(0);

  snapshot.myMemberId = snapshot.members[3].id;
  await page.reload();
  await expect(page.locator('.combat-panel')).toHaveCount(0);
  snapshot.scene.places[ravine].encounter!.victory = true;
  await shared.reload();
  await expect(shared.locator('.combat-panel')).toHaveCount(1);
  await expect(shared.getByRole('region', { name: 'Combat at Watchtower', exact: true })).toBeVisible();
  snapshot.scene.places[tower].encounter!.escaped = true;
  await shared.reload();
  await expect(shared.locator('.combat-panel')).toHaveCount(0);
});
