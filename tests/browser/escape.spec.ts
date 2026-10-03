import { test, expect } from '@playwright/test';
import { initialState } from '../../shared/rules';
import { templateCharacter, type Action, type Snapshot } from '../../shared/schema';

test('an escaped player can explore, update, pass, and reengage while the encounter continues', async ({
  page,
}) => {
  const response = await page.request.post('/api/campaigns', {
    headers: { 'x-gather-request': '1' },
    data: {
      ruleset: 'roguelike-v1',
      name: 'The split party',
      setting: 'A ruined tower',
      premise: 'One adventurer escapes while another fights.',
      tone: 'Adventurous',
      language: 'English',
      instructions: '',
      custom: [],
      provider: 'practice',
      model: '',
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const snapshot: Snapshot = await response.json();
  const members = ['Escaped Mira', 'Fighting Ivo'].map((name, index) => {
    const character = templateCharacter(name);
    return {
      id: `member-${index}`,
      playerId: `player-${index}`,
      playerName: name,
      characterId: `character-${index}`,
      character,
      state: { ...initialState(character, `escape-${index}`), equipmentChosen: true },
      active: true,
    };
  });
  const escaped = members[0];
  escaped.state.conditions = ['Escaped'];
  escaped.state.conditionTurns.Escaped = 999;
  snapshot.status = 'active';
  snapshot.members = members;
  snapshot.myMemberId = escaped.id;
  snapshot.isHost = false;
  snapshot.scene.encounter = {
    round: 2,
    victory: false,
    escaped: false,
    initiative: [
      { id: members[1].id, total: 15 },
      { id: 'tower-guard', total: 10 },
    ],
    enemies: [
      {
        id: 'tower-guard',
        name: 'Tower guard',
        tier: 'normal',
        hp: 12,
        maxHp: 12,
        defense: 10,
        attack: 2,
        damage: '1d4',
        description: 'A guard blocking the stairs.',
        tactic: 'Defend the stairs.',
        onHit: null,
        initiative: 10,
      },
    ],
  };
  snapshot.turn = {
    id: 'escape-turn',
    number: 2,
    phase: 'collecting',
    roster: members.map((member) => member.id),
    actions: [],
    rolls: [],
    result: null,
    error: null,
  };
  await page.addInitScript(() => {
    Object.defineProperty(window, 'EventSource', {
      value: class {
        close() {}
      },
    });
  });
  await page.route(`**/api/campaigns/${snapshot.id}`, (route) => route.fulfill({ json: snapshot }));
  const submissions: (Omit<Action, 'memberId'> & { turnId: string })[] = [];
  await page.route(`**/api/campaigns/${snapshot.id}/action`, async (route) => {
    const payload = route.request().postDataJSON();
    submissions.push(payload);
    snapshot.turn!.actions = [{ memberId: escaped.id, ...payload }];
    snapshot.version++;
    await route.fulfill({ json: snapshot });
  });
  await page.goto(`/campaign/${snapshot.id}`);
  const action = page.getByLabel('Your action', { exact: true });
  await expect(action).toBeEnabled();
  await expect(page.getByText('Combat · Round 2', { exact: true })).toBeVisible();
  await expect(page.getByText('0 / 2 ready', { exact: true })).toBeVisible();

  const exploration = 'Explore the corridor beyond the fight.';
  await action.fill(exploration);
  await page.getByRole('button', { name: 'Submit action', exact: true }).click();
  await expect(page.locator('.action-bubble')).toContainText(exploration);
  await expect(page.getByText('1 / 2 ready', { exact: true })).toBeVisible();
  await expect(action).toBeEnabled();

  const update = 'Move farther down the corridor and search for a passage.';
  await action.fill(update);
  await page.getByRole('button', { name: 'Update action', exact: true }).click();
  await expect(page.locator('.action-bubble')).toContainText(update);
  await page.getByRole('button', { name: 'Pass', exact: true }).click();
  await expect(page.locator('.action-bubble')).toContainText('Passes this turn.');
  await expect(action).toBeEnabled();

  snapshot.turn = { ...snapshot.turn!, id: 'reengage-turn', number: 3, actions: [] };
  snapshot.scene.encounter.round++;
  await page.reload();
  await expect(action).toBeEnabled();
  const reengage = 'Return to the fight and attack the tower guard.';
  await action.fill(reengage);
  await page.getByRole('button', { name: 'Submit action', exact: true }).click();
  await expect(page.locator('.action-bubble')).toContainText(reengage);
  expect(submissions).toEqual([
    { turnId: 'escape-turn', text: exploration, passed: false, abilityName: null },
    { turnId: 'escape-turn', text: update, passed: false, abilityName: null },
    { turnId: 'escape-turn', text: '', passed: true },
    { turnId: 'reengage-turn', text: reengage, passed: false, abilityName: null },
  ]);
});
