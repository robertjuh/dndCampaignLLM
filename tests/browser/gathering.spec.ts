import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { templateCharacter, type Snapshot } from '../../shared/schema';
import { initialState } from '../../shared/rules';

test('calls, joins and cancels a gathering on phones, disables combat travel and shows status on the shared screen', async ({
  page,
  browser,
}) => {
  const response = await page.request.post('/api/campaigns', {
    headers: { 'x-gather-request': '1' },
    data: {
      name: 'Gather here',
      setting: 'Inn',
      premise: '',
      tone: '',
      language: 'English',
      instructions: '',
      custom: [],
      provider: 'practice',
    },
  });
  const s: Snapshot = await response.json();
  const [inn, road, camp] = Array.from({ length: 3 }, () => randomUUID());
  s.status = 'active';
  s.members = ['Marta', 'Rexmen'].map((name) => {
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
  s.myMemberId = s.members[0].id;
  s.scene.location = { id: inn, name: 'Inn', atmosphere: 'A familiar inn.', hazard: '' };
  s.scene.places = Object.fromEntries(
    [
      [road, 'Road'],
      [camp, 'Camp'],
    ].map(([id, name]) => [
      id,
      {
        location: { id, name, atmosphere: 'A familiar route.', hazard: '' },
        encounter: null,
        loot: [],
        encounterRisk: { danger: 'safe', reason: 'Patrolled road.' },
      },
    ]),
  );
  s.scene.memberLocations = { [s.members[0].id]: inn, [s.members[1].id]: camp };
  s.scene.worldMap = {
    nodes: Object.fromEntries(
      [
        [inn, 'Inn'],
        [road, 'Road'],
        [camp, 'Camp'],
      ].map(([id, name]) => [id, { id, name, visited: true }]),
    ),
    connections: [
      [inn, road],
      [road, camp],
    ].map(([from, to]) => ({ from, to, label: 'Road', blocked: false, bidirectional: true })),
  };
  s.history = [];
  s.turn = {
    id: randomUUID(),
    number: 1,
    phase: 'collecting',
    roster: s.members.map((member) => member.id),
    actions: [],
    rolls: [],
    result: null,
    error: null,
  };
  const attach = async (target: Page, screen = false) => {
    const snapshot = () => ({ ...s, ...(screen ? { myMemberId: null } : {}) });
    await target.route(`**/api/campaigns/${s.id}`, (route) => route.fulfill({ json: snapshot() }));
    await target.route(`**/api/campaigns/${s.id}/events`, (route) =>
      route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify(snapshot())}\n\n` }),
    );
  };
  await attach(page);
  await page.route(`**/api/campaigns/${s.id}/gathering`, async (route) => {
    expect(route.request().postDataJSON()).toEqual({ turnId: s.turn!.id });
    s.scene.gathering = { id: randomUUID(), memberId: s.members[0].id, locationId: inn };
    s.version++;
    await route.fulfill({ json: s });
  });
  await page.route(`**/api/campaigns/${s.id}/gathering/join`, async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      turnId: s.turn!.id,
      gatheringId: s.scene.gathering!.id,
    });
    s.turn!.actions = [
      {
        memberId: s.myMemberId!,
        text: 'I travel to the gathering at Inn.',
        passed: false,
        gathering: { id: s.scene.gathering!.id, locationId: inn, route: [camp, road, inn] },
      },
    ];
    s.version++;
    await route.fulfill({ json: s });
  });
  await page.route(`**/api/campaigns/${s.id}/action/cancel`, async (route) => {
    s.turn!.actions = [];
    s.version++;
    await route.fulfill({ json: s });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/campaign/${s.id}`);
  await page.getByRole('button', { name: 'Gather here', exact: true }).click();
  const gathering = page.getByRole('region', { name: 'Gathering', exact: true });
  await expect(gathering).toContainText('Called by Marta');
  await expect(gathering).toContainText('Marta · Arrived');
  expect(s.turn!.actions).toEqual([]);
  s.myMemberId = s.members[1].id;
  await page.reload();
  const action = page.getByRole('textbox', { name: 'Your action', exact: true });
  await page.getByRole('button', { name: 'Open action input', exact: true }).click();
  await action.fill('My unfinished draft.');
  await page.getByRole('button', { name: 'Collapse action input', exact: true }).click();
  await page.getByRole('button', { name: 'Join gathering', exact: true }).click();
  await expect(gathering).toContainText('Rexmen · Travelling');
  await page.getByRole('button', { name: 'Open action input', exact: true }).click();
  await expect(action).toBeDisabled();
  await expect(action).toHaveValue('I travel to the gathering at Inn.');
  await page.getByRole('button', { name: 'Cancel action', exact: true }).click();
  await expect(action).toBeEnabled();
  await expect(action).toHaveValue('My unfinished draft.');
  s.scene.places![camp].encounter = { enemies: [], round: 1, initiative: [], victory: false, escaped: false };
  s.version++;
  await page.reload();
  await expect(page.getByRole('button', { name: 'Join gathering', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Gather here', exact: true })).toBeDisabled();
  await expect(gathering).toContainText('Rexmen · In combat');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const displayContext = await browser.newContext();
  try {
    const display = await displayContext.newPage();
    await attach(display, true);
    await display.goto(`/screen/${s.id}#${s.displayToken}`);
    await expect(display.getByRole('region', { name: 'Gathering', exact: true })).toContainText(
      'Rexmen · In combat',
    );
    await expect(display.getByRole('button', { name: 'Gather here', exact: true })).toHaveCount(0);
    await expect(display.getByRole('button', { name: 'Join gathering', exact: true })).toHaveCount(0);
  } finally {
    await displayContext.close();
  }
});
