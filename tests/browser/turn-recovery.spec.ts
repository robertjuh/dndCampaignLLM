import { test, expect } from '@playwright/test';
import { initialState } from '../../shared/rules';
import { campaignSchema, templateCharacter, outcomeSchema, type Snapshot } from '../../shared/schema';

for (const view of ['leader', 'player', 'screen'] as const) {
  test(`${view} can find failed-turn recovery above the dice and while browsing history`, async ({
    page,
  }) => {
    const response = await page.request.post('/api/campaigns', {
      headers: { 'x-gather-request': '1' },
      data: {
        ruleset: 'roguelike-v1',
        name: 'Recovery table',
        setting: 'Ocean',
        premise: '',
        tone: 'Adventurous',
        language: 'English',
        instructions: '',
        custom: [],
        provider: 'practice',
        model: '',
      },
    });
    expect(response.ok()).toBe(true);
    const snapshot: Snapshot = await response.json();
    const character = templateCharacter('Pirato');
    const member = {
      id: 'pirato',
      playerId: 'pirato-player',
      characterId: 'pirato-character',
      playerName: 'Roberto',
      character,
      state: { ...initialState(character, 'pirato'), equipmentChosen: true },
      active: true,
    };
    snapshot.status = 'active';
    snapshot.isHost = view !== 'player';
    snapshot.leaderName = 'Roberto';
    snapshot.members = [member];
    snapshot.myMemberId = view === 'screen' ? null : member.id;
    const complete = {
      id: 'opening',
      number: 0,
      phase: 'complete' as const,
      roster: [member.id],
      actions: [],
      rolls: [],
      error: null,
      result: outcomeSchema.parse({
        narration: 'The party approaches a ship.',
        summary: 'At sea.',
        choices: [],
        changes: [],
        journal: [],
      }),
    };
    snapshot.history = [complete, { ...complete, id: 'previous', number: 1 }];
    snapshot.turn = {
      ...complete,
      id: 'failed-turn',
      number: 2,
      phase: 'failed',
      result: null,
      error: 'adjudication: The model request timed out. Retry resumes from the last saved checkpoint.',
      rolls: Array.from({ length: 12 }, (_, index) => ({
        id: `roll-${index}`,
        memberId: member.id,
        stat: 'INT' as const,
        dc: 10 as const,
        mode: 'normal' as const,
        lethal: false,
        reason: 'Inspect the ship.',
        label: `Saved roll ${index}`,
        dice: [18],
        modifier: 0,
        total: 18,
        success: true,
        source: 'Test',
      })),
    };
    await page.addInitScript(() => {
      Object.defineProperty(window, 'EventSource', {
        value: class {
          close() {}
        },
      });
    });
    await page.route(`**/api/campaigns/${snapshot.id}`, (route) => route.fulfill({ json: snapshot }));
    let retries = 0;
    await page.route(`**/api/campaigns/${snapshot.id}/retry`, async (route) => {
      retries++;
      snapshot.turn!.phase = 'resolving';
      snapshot.turn!.error = null;
      snapshot.turn!.automaticRetry = true;
      snapshot.version++;
      await route.fulfill({ json: snapshot });
    });
    await page.goto(`/${view === 'screen' ? 'screen' : 'campaign'}/${snapshot.id}`);
    const failure = page.locator('.failed-turn');
    await expect(failure).toContainText('Your actions, dice and completed steps are saved.');
    const recovery =
      view === 'leader'
        ? failure.getByRole('button', { name: 'Retry saved turn', exact: true })
        : failure.getByRole('link', { name: 'Open player / leader controls', exact: true });
    await expect(recovery).toBeVisible();
    if (view !== 'leader') {
      await expect(failure).toContainText('Roberto can resume this turn');
      await expect(failure.getByRole('button', { name: 'Retry saved turn' })).toHaveCount(0);
    }
    const controlBox = await recovery.boundingBox();
    const diceBox = await failure.locator('.roll-receipt').first().boundingBox();
    expect(controlBox!.y + controlBox!.height).toBeLessThanOrEqual(diceBox!.y);
    await page.getByRole('button', { name: 'Previous turn', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('The current turn is on hold.');
    await page.getByRole('button', { name: 'View recovery controls', exact: true }).click();
    await expect(recovery).toBeVisible();
    if (view === 'leader') {
      await recovery.click();
      await expect(page.locator('.thinking')).toContainText('Resuming your saved turn from checkpoints');
      expect(retries).toBe(1);
    }
  });
}

test('a recovered turn shows debugging feedback while the next action stays available', async ({ page }) => {
  const response = await page.request.post('/api/campaigns', {
    headers: { 'x-gather-request': '1' },
    data: campaignSchema.parse({
      name: 'Graceful recovery',
      setting: 'Ocean',
      premise: '',
      tone: 'Adventurous',
      language: 'English',
      instructions: '',
      custom: [],
      provider: 'practice',
    }),
  });
  expect(response.ok()).toBe(true);
  const snapshot: Snapshot = await response.json();
  const character = templateCharacter('Black panterino');
  const member = {
    id: 'panterino',
    playerId: 'panterino-player',
    characterId: 'panterino-character',
    playerName: 'Panterino',
    character,
    state: { ...initialState(character, 'panterino'), equipmentChosen: true },
    active: true,
  };
  snapshot.status = 'active';
  snapshot.members = [member];
  snapshot.myMemberId = member.id;
  const feedback =
    'narration: Narration exhausted its two-attempt budget. The submitted groan is not established for Davyjaws.';
  snapshot.history = [
    {
      id: 'recovered-turn',
      number: 1,
      phase: 'complete',
      roster: [member.id],
      actions: [{ memberId: member.id, text: 'I signal Davyjaws.', passed: false, acceptsLethalRisk: false }],
      rolls: [],
      error: null,
      diagnostics: [feedback],
      result: outcomeSchema.parse({
        narration: 'Black panterino signals Davyjaws and waits for cannon fire.',
        summary: 'The cannon is ready.',
        choices: [],
        changes: [],
        journal: [],
      }),
    },
  ];
  snapshot.turn = {
    id: 'next-turn',
    number: 2,
    phase: 'collecting',
    roster: [member.id],
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
  await page.goto(`/campaign/${snapshot.id}`);
  await expect(page.locator('.gm-diagnostics')).toContainText('The GM recovered this turn.');
  await expect(page.locator('.gm-diagnostics').getByRole('alert')).toHaveText(feedback);
  await expect(page.locator('.narration')).toContainText('signals Davyjaws');
  await expect(page.getByRole('textbox', { name: 'Your action' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Retry saved turn' })).toHaveCount(0);
});
