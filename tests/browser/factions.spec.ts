import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { templateCharacter, type Snapshot } from '../../shared/schema';
import { initialState } from '../../shared/rules';

const headers = { 'x-gather-request': '1' };
const config = {
  name: 'Faction table',
  setting: 'Harbor',
  premise: 'A contested gate.',
  tone: 'Intrigue',
  language: 'English',
  instructions: '',
  custom: [],
  provider: 'practice',
};

test('stores the player’s starting connection preference in the lobby', async ({ page }) => {
  await page.request.get('/api/me');
  const response = await page.request.post('/api/campaigns', { headers, data: config });
  const campaign: Snapshot = await response.json();
  const sheet = templateCharacter('Mira');
  const saved = await page.request.post('/api/characters', { headers, data: sheet });
  await page.request.post('/api/join', {
    headers,
    data: { code: campaign.inviteCode, playerName: 'Mira', characterId: (await saved.json()).id },
  });
  await page.goto(`/campaign/${campaign.id}`);
  const preference = page.getByRole('checkbox', { name: 'Allow a possible starting faction connection' });
  await expect(preference).toBeChecked();
  await preference.click();
  await expect(preference).not.toBeChecked();
  const stored: Snapshot = await (await page.request.get(`/api/campaigns/${campaign.id}`)).json();
  expect(stored.members[0].state.factionConnectionPreference).toBe('unaffiliated');
  await preference.click();
  await expect(preference).toBeChecked();
});

test('shows gradual faction discovery and different individual attitudes on a phone and shared display', async ({
  page,
  browser,
}) => {
  await page.request.get('/api/me');
  const response = await page.request.post('/api/campaigns', { headers, data: config });
  const snapshot: Snapshot = await response.json();
  const ids = [randomUUID(), randomUUID()];
  snapshot.status = 'active';
  snapshot.members = ['Mira', 'Rowan'].map((name) => {
    const character = templateCharacter(name);
    return {
      id: randomUUID(),
      playerId: randomUUID(),
      playerName: name,
      characterId: randomUUID(),
      character,
      active: true,
      state: {
        ...initialState(character, randomUUID()),
        equipmentChosen: true,
        factionReputation: { [ids[0]]: name === 'Mira' ? 2 : -2 },
      },
    };
  });
  snapshot.myMemberId = snapshot.members[0].id;
  snapshot.factions = [
    {
      id: ids[0],
      name: 'Gate Wardens',
      knownDescription: 'Their envoys negotiate passage through the gate.',
      discoveredTurn: 0,
    },
  ];
  snapshot.journal = [
    { kind: 'faction', name: 'Gate Wardens', detail: snapshot.factions[0].knownDescription },
  ];
  snapshot.turn = {
    id: randomUUID(),
    number: 1,
    phase: 'collecting',
    roster: snapshot.members.map((member) => member.id),
    actions: [],
    rolls: [],
    result: null,
    error: null,
  };
  const attach = async (target: typeof page, screen = false) => {
    await target.route(`**/api/campaigns/${snapshot.id}`, (route) =>
      route.fulfill({ json: { ...snapshot, ...(screen ? { myMemberId: null } : {}) } }),
    );
    await target.route(`**/api/campaigns/${snapshot.id}/events`, (route) =>
      route.fulfill({
        contentType: 'text/event-stream',
        body: `data: ${JSON.stringify({ ...snapshot, ...(screen ? { myMemberId: null } : {}) })}\n\n`,
      }),
    );
  };
  await attach(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/campaign/${snapshot.id}`);
  await page.getByRole('button', { name: /World journal/ }).click();
  const card = page.getByRole('article', { name: 'Faction: Gate Wardens' });
  await expect(card).toContainText('Mira · Friendly (+2)');
  await expect(card).toContainText('Rowan · Hostile (-2)');
  await expect(page.getByRole('article', { name: 'Faction: Harbor League' })).toHaveCount(0);
  snapshot.factions.push({
    id: ids[1],
    name: 'Harbor League',
    knownDescription: 'Independent traders seeking a safer route.',
    discoveredTurn: 2,
  });
  snapshot.journal.push({
    kind: 'faction',
    name: 'Harbor League',
    detail: snapshot.factions[1].knownDescription,
  });
  await page.reload();
  await page.getByRole('button', { name: /World journal/ }).click();
  await expect(page.getByRole('article', { name: 'Faction: Harbor League' })).toContainText('Neutral (0)');
  const displayContext = await browser.newContext();
  const display = await displayContext.newPage();
  await attach(display, true);
  await display.goto(`/screen/${snapshot.id}#${snapshot.displayToken}`);
  await display.getByRole('button', { name: /World journal/ }).click();
  await expect(display.getByRole('article', { name: 'Faction: Gate Wardens' })).toContainText(
    'Rowan · Hostile (-2)',
  );
  await displayContext.close();
});
