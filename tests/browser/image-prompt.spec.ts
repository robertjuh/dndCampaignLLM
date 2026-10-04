import { test, expect, type Page } from '@playwright/test';
import { initialState } from '../../shared/rules';
import { outcomeSchema, templateCharacter, type Snapshot, type Turn } from '../../shared/schema';

declare global {
  interface Window {
    imagePromptClipboard: { writes: string[]; mode: 'available' | 'rejected' | 'unavailable' };
  }
}

const copiedMessage = 'Image prompt copied. Paste it into ChatGPT to create an image.';
const fallbackMessage =
  'Clipboard access is unavailable. Copy this JSON and paste it into ChatGPT to create an image.';

async function setup(page: Page) {
  const response = await page.request.post('/api/campaigns', {
    headers: { 'x-gather-request': '1' },
    data: {
      ruleset: 'roguelike-v1',
      name: 'The illustrated road',
      setting: 'A tower above the clouds',
      premise: 'Find the lost lantern.',
      tone: 'Mysterious',
      language: 'English',
      instructions: 'Private game-master instructions must not be exported.',
      custom: [{ key: 'Architecture', value: 'Weathered silver arches' }],
      provider: 'practice',
      model: '',
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const snapshot: Snapshot = await response.json();
  const character = templateCharacter('Replacement Neri');
  character.appearance = 'A future character appearance that does not belong to old scenes.';
  const member = {
    id: 'illustrated-member',
    playerId: 'private-player-id',
    playerName: 'Private player name',
    characterId: 'private-character-id',
    character,
    state: { ...initialState(character, 'illustrated-road'), equipmentChosen: true },
    active: true,
  };
  const opening: Turn = {
    id: 'opening-scene-id',
    number: 0,
    phase: 'complete',
    roster: [member.id],
    actions: [],
    rolls: [],
    result: outcomeSchema.parse({
      narration: 'Fallen Ivo stands beneath a silver arch as clouds roll through the tower.',
      summary: 'The journey begins beneath the silver arch.',
      choices: [],
      changes: [],
      journal: [],
    }),
    error: null,
  };
  const latest: Turn = {
    ...opening,
    id: 'latest-scene-id',
    number: 1,
    actions: [
      {
        memberId: member.id,
        characterName: 'Fallen Ivo',
        text: 'Examine the lantern beside the arch.',
        passed: false,
        abilityName: 'Keen observation',
      },
      { memberId: 'unknown-actor-id', text: '', passed: true },
    ],
    result: outcomeSchema.parse({
      narration: 'Fallen Ivo lifts the glowing lantern while mist coils around the silver arch.',
      summary: 'The lost lantern lights the path.',
      choices: [],
      changes: [],
      journal: [],
    }),
  };
  snapshot.status = 'active';
  snapshot.members = [member];
  snapshot.myMemberId = member.id;
  snapshot.scene.location.name = 'A later location';
  snapshot.scene.location.atmosphere = 'A later location that must not appear in the saved scene.';
  snapshot.history = [opening, latest];
  snapshot.turn = {
    ...latest,
    id: 'pending-turn-id',
    number: 2,
    phase: 'collecting',
    actions: [{ memberId: member.id, text: 'A live submission for the next turn.', passed: false }],
    result: null,
  };
  await page.addInitScript(() => {
    window.imagePromptClipboard = { writes: [], mode: 'available' };
    const clipboard = {
      async writeText(text: string) {
        if (window.imagePromptClipboard.mode === 'rejected') throw new Error('Clipboard denied');
        window.imagePromptClipboard.writes.push(text);
      },
    };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      get: () => (window.imagePromptClipboard.mode === 'unavailable' ? undefined : clipboard),
    });
    Object.defineProperty(window, 'EventSource', {
      value: class {
        close() {}
      },
    });
  });
  await page.route(`**/api/campaigns/${snapshot.id}`, (route) => route.fulfill({ json: snapshot }));
  return { snapshot, opening, latest };
}

function expectPrompt(text: string, snapshot: Snapshot, turn: Turn) {
  const prompt = JSON.parse(text);
  expect(prompt).toEqual({
    task: 'Create an image',
    instructions: expect.any(String),
    campaign: {
      name: snapshot.config.name,
      setting: snapshot.config.setting,
      premise: snapshot.config.premise,
      tone: snapshot.config.tone,
      custom: snapshot.config.custom,
    },
    turn: {
      number: turn.number,
      narration: turn.result!.narration,
      summary: turn.result!.summary,
      actions: turn.actions.map((action) => ({
        character: action.characterName ?? 'Unnamed character',
        text: action.text,
        passed: action.passed,
        ability: action.abilityName ?? null,
      })),
    },
  });
  expect(prompt.instructions).toMatch(/narration/i);
  expect(prompt.instructions).toMatch(/moment/i);
  expect(prompt.instructions).toMatch(/text/i);
  expect(prompt.instructions).toMatch(/interface|\bUI\b/i);
}

test('image prompts copy the displayed opening, latest, and historical scenes without live state', async ({
  page,
}) => {
  const { snapshot, opening, latest } = await setup(page);
  snapshot.status = 'lobby';
  snapshot.history = [];
  snapshot.turn = null;
  await page.goto(`/campaign/${snapshot.id}`);
  const copy = page.getByRole('button', { name: 'Copy image prompt', exact: true });
  await expect(copy).toHaveCount(0);

  snapshot.status = 'active';
  snapshot.history = [opening];
  await page.reload();
  await copy.click();
  await expect(page.getByRole('status').filter({ hasText: copiedMessage })).toBeVisible();
  expectPrompt(await page.evaluate(() => window.imagePromptClipboard.writes.at(-1)!), snapshot, opening);

  snapshot.history = [opening, latest];
  snapshot.turn = {
    ...latest,
    id: 'pending-turn-id',
    number: 2,
    phase: 'collecting',
    actions: [
      { memberId: snapshot.myMemberId!, text: 'A live submission for the next turn.', passed: false },
    ],
    result: null,
  };
  await page.reload();
  await expect(page.getByText('Viewing turn 1', { exact: true })).toBeVisible();
  await expect(page.getByText('A live submission for the next turn.', { exact: true })).toBeVisible();
  await copy.click();
  expectPrompt(await page.evaluate(() => window.imagePromptClipboard.writes.at(-1)!), snapshot, latest);
  await page.getByRole('button', { name: 'Previous turn', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: copiedMessage })).toHaveCount(0);
  await copy.click();
  expectPrompt(await page.evaluate(() => window.imagePromptClipboard.writes.at(-1)!), snapshot, opening);

  snapshot.isHost = false;
  snapshot.myMemberId = null;
  await page.goto(`/screen/${snapshot.id}`);
  await copy.click();
  await expect(page.getByRole('status').filter({ hasText: copiedMessage })).toBeVisible();
  expectPrompt(await page.evaluate(() => window.imagePromptClipboard.writes.at(-1)!), snapshot, latest);

  snapshot.history = [{ ...opening, result: null }];
  await page.reload();
  await expect(copy).toBeDisabled();
});

for (const failure of ['unavailable', 'rejected'] as const) {
  test(`a player can manually copy an image prompt when clipboard access is ${failure}, then retry`, async ({
    page,
  }) => {
    const { snapshot, latest } = await setup(page);
    snapshot.isHost = false;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/campaign/${snapshot.id}`);
    await page.evaluate((mode) => (window.imagePromptClipboard.mode = mode), failure);
    const copy = page.getByRole('button', { name: 'Copy image prompt', exact: true });
    await copy.click();
    const manual = page.getByRole('textbox', { name: 'Image prompt JSON', exact: true });
    await expect(page.getByRole('status').filter({ hasText: fallbackMessage })).toBeVisible();
    await expect(manual).toHaveAttribute('readonly', '');
    expectPrompt(await manual.inputValue(), snapshot, latest);
    await manual.focus();
    expect(
      await manual.evaluate(
        (element: HTMLTextAreaElement) =>
          element.selectionStart === 0 && element.selectionEnd === element.value.length,
      ),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (failure === 'unavailable')
      await page.screenshot({ path: '/tmp/image-prompt-mobile.png', fullPage: true });

    await page.getByRole('button', { name: 'Previous turn', exact: true }).click();
    await expect(manual).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: fallbackMessage })).toHaveCount(0);
    await page.getByRole('button', { name: 'Current turn', exact: true }).click();
    await copy.click();
    await expect(manual).toBeVisible();
    await page.evaluate(() => (window.imagePromptClipboard.mode = 'available'));
    await copy.click();
    await expect(page.getByRole('status').filter({ hasText: copiedMessage })).toBeVisible();
    await expect(manual).toHaveCount(0);
    expectPrompt(await page.evaluate(() => window.imagePromptClipboard.writes.at(-1)!), snapshot, latest);
  });
}
