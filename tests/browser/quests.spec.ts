import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { templateCharacter, type Snapshot } from '../../shared/schema';
import { baseItem, initialState } from '../../shared/rules';
import { ensureLocations } from '../../shared/locations';
import { questDefinitionSchema } from '../../shared/quests';

test('shows group request progress on phones and the shared display, and collectible currency with a full backpack', async ({
  page,
  browser,
}) => {
  const response = await page.request.post('/api/campaigns', {
    headers: { 'x-gather-request': '1' },
    data: {
      name: 'Group requests',
      setting: 'Workshop',
      premise: '',
      tone: 'Hopeful',
      language: 'English',
      instructions: '',
      custom: [],
      provider: 'practice',
    },
  });
  expect(response.ok()).toBe(true);
  const snapshot: Snapshot = await response.json();
  const character = templateCharacter('Mira');
  const member = {
    id: randomUUID(),
    playerId: randomUUID(),
    playerName: 'Mira',
    characterId: randomUUID(),
    character,
    active: true,
    state: {
      ...initialState(character, randomUUID()),
      equipmentChosen: true,
      inventory: Array.from({ length: 8 }, (_, i) => ({
        ...baseItem(`rock-${i}`, 'Rock', 'tool'),
        quantity: 1,
      })),
    },
  };
  snapshot.members = [member];
  snapshot.myMemberId = member.id;
  snapshot.status = 'active';
  ensureLocations(snapshot.scene, [member.id]);
  snapshot.scene.currencyName = 'credits';
  snapshot.scene.npcs = {
    ada: {
      id: 'ada',
      name: 'Ada',
      aliases: [],
      locationId: snapshot.scene.location.id!,
      status: 'alive',
      allegiance: null,
      fact: 'The workshop keeper.',
    },
  };
  const quest = questDefinitionSchema.parse({
    id: 'pump',
    name: 'Repair the pump',
    description: 'Repair the workshop pump and report to Ada.',
    giverId: 'ada',
    recipientId: 'ada',
    objectives: [
      {
        id: 'repair',
        description: 'Restore water flow.',
        condition: { kind: 'state', featureId: 'pump', property: 'repaired', value: true },
      },
    ],
    reward: { description: '25 credits and access to the vault.', currency: 25, items: [], access: [] },
  });
  snapshot.scene.quests = {
    pump: {
      ...quest,
      status: 'ready',
      offeredTurn: 1,
      acceptedTurn: 2,
      priorDeaths: [],
      progress: { repair: { current: 1, complete: true, evidence: [] } },
    },
  };
  snapshot.scene.loot = [{ ...baseItem('reward-currency', 'credits', 'tool'), currencyValue: 25, quantity: 1 }];
  snapshot.turn = {
    id: randomUUID(),
    number: 4,
    phase: 'collecting',
    roster: [member.id],
    actions: [],
    rolls: [],
    result: null,
    error: null,
  };
  const attach = async (target: typeof page, display = false) => {
    await target.route(`**/api/campaigns/${snapshot.id}`, (route) =>
      route.fulfill({ json: { ...snapshot, myMemberId: display ? null : member.id } }),
    );
    await target.route(`**/api/campaigns/${snapshot.id}/events`, (route) =>
      route.fulfill({ contentType: 'text/event-stream', body: '' }),
    );
  };
  await attach(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/campaign/${snapshot.id}`);
  await page.getByRole('button', { name: /World journal/ }).click();
  const requests = page.getByRole('region', { name: 'Group requests' });
  await expect(requests).toContainText('Ready to turn in');
  await expect(requests).toContainText('Restore water flow. (1/1)');
  await expect(requests).toContainText('25 credits and access to the vault.');
  await expect(page.getByText('The world is still unfolding.')).toHaveCount(0);
  await page.getByRole('button', { name: 'The story', exact: true }).click();
  await page.getByRole('button', { name: 'Equipment & backpack', exact: true }).click();
  const currency = page.getByRole('article', { name: 'credits', exact: true });
  await expect(currency.getByRole('button', { name: 'Collect credits' })).toBeEnabled();
  await expect(currency).toContainText('credits: 0 → 25');
  await expect(currency).not.toContainText('Take into backpack');
  const display = await browser.newPage();
  try {
    await attach(display, true);
    await display.goto(`/screen/${snapshot.id}#${snapshot.displayToken}`);
    await display.getByRole('button', { name: /World journal/ }).click();
    await expect(display.getByRole('region', { name: 'Group requests' })).toContainText('Ready to turn in');
  } finally {
    await display.close();
  }
});
