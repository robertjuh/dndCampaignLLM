import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { outcomeSchema, templateCharacter, type Snapshot } from '../../shared/schema';
import { initialState } from '../../shared/rules';

test('maps known routes and separate character positions on phones and the shared screen', async ({
  page,
  browser,
}) => {
  const response = await page.request.post('/api/campaigns', {
    headers: { 'x-gather-request': '1' },
    data: {
      name: 'Mapped roads',
      setting: 'A walled town',
      premise: 'Explore the courtyard.',
      tone: 'Adventure',
      language: 'English',
      instructions: '',
      custom: [],
      provider: 'practice',
    },
  });
  expect(response.ok()).toBe(true);
  const snapshot: Snapshot = await response.json();
  const [courtyard, road, tower, drain, oldCamp] = Array.from({ length: 5 }, () => randomUUID());
  snapshot.members = ['Mira', 'Rowan', 'Sir rexmen', 'Matthes'].map((name) => {
    const character = templateCharacter(name);
    return {
      id: randomUUID(),
      playerId: randomUUID(),
      playerName: name,
      characterId: randomUUID(),
      character,
      active: true,
      state: { ...initialState(character, randomUUID()), equipmentChosen: true },
    };
  });
  snapshot.myMemberId = snapshot.members[0].id;
  snapshot.scene.location = { id: courtyard, name: 'Courtyard', atmosphere: 'Stone paving.', hazard: '' };
  snapshot.scene.places = {
    [road]: {
      location: { id: road, name: 'Old checkpoint', atmosphere: 'A dusty road.', hazard: '' },
      encounter: null,
      loot: [],
    },
  };
  snapshot.scene.memberLocations = {
    [snapshot.members[0].id]: courtyard,
    [snapshot.members[1].id]: road,
    [snapshot.members[2].id]: road,
    [snapshot.members[3].id]: road,
  };
  snapshot.scene.worldMap = {
    nodes: {
      [courtyard]: { id: courtyard, name: 'Courtyard', visited: true },
      [road]: { id: road, name: 'Old checkpoint', visited: true },
      [tower]: { id: tower, name: 'Watchtower', visited: false },
      [drain]: { id: drain, name: 'Drain entrance', visited: false },
      [oldCamp]: { id: oldCamp, name: 'Distant camp', visited: true },
    },
    connections: [
      { from: courtyard, to: road, label: 'Road', blocked: false, bidirectional: true },
      { from: courtyard, to: tower, label: 'Stairs', blocked: false, bidirectional: false },
      { from: courtyard, to: drain, label: 'Locked gate', blocked: true, bidirectional: true },
    ],
  };
  snapshot.history = [0, 1].map((number) => ({
    id: randomUUID(),
    number,
    phase: 'complete',
    roster: [],
    actions: [],
    rolls: [],
    result: outcomeSchema.parse({
      narration: 'The courtyard lies ahead.',
      summary: 'Routes are visible.',
      choices: [],
      changes: [],
      journal: [],
    }),
    error: null,
  }));
  snapshot.turn = { ...snapshot.history[1], id: randomUUID(), number: 2, phase: 'collecting', result: null };
  const attach = async (target: Page, screen = false) => {
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
  await expect(page.getByRole('region', { name: 'World map', exact: true })).toHaveCount(0);
  snapshot.status = 'active';
  await page.reload();
  const displayContext = await browser.newContext();
  try {
    const display = await displayContext.newPage();
    await attach(display, true);
    await display.goto(`/screen/${snapshot.id}#${snapshot.displayToken}`);
    for (const view of [page, display]) {
      const map = view.getByRole('region', { name: 'World map', exact: true });
      await expect(map.getByRole('article')).toHaveCount(5);
      const current = map.getByRole('article', { name: 'Location: Courtyard', exact: true });
      await expect(current).toHaveAttribute('aria-current', 'location');
      await expect(current).toContainText('Mira');
      await expect(current).not.toContainText('Rowan');
      await expect(map.getByRole('article', { name: 'Location: Old checkpoint' })).toContainText('Rowan');
      for (const name of ['Sir rexmen', 'Matthes']) {
        await expect(map.getByRole('article', { name: 'Location: Old checkpoint' })).toContainText(name);
        await expect(current).not.toContainText(name);
      }
      const known = map.getByRole('article', { name: 'Location: Watchtower' });
      await expect(known).toContainText('Unvisited');
      await expect(map.locator('.world-map-route')).toHaveCount(3);
      await expect(map.locator('.world-map-route.blocked')).toHaveCount(1);
      await map.locator('summary').click();
      await expect(map.locator('.world-map-connections')).toContainText('Locked gate · Blocked');
      await expect(map.locator('.world-map-connections')).toContainText(
        'Courtyard → Watchtower · Stairs · One-way',
      );
      await view.getByRole('button', { name: 'Previous turn', exact: true }).click();
      await expect(map.getByRole('heading', { name: 'Current world map' })).toBeVisible();
      await expect(current).toContainText('Mira');
      expect(await view.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await expect(display.getByRole('button', { name: 'Submit action' })).toHaveCount(0);
  } finally {
    await displayContext.close();
  }
});
