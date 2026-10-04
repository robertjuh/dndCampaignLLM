import { test, expect, type APIRequestContext } from '@playwright/test';
import { initialState } from '../../shared/rules';
import { outcomeSchema, templateCharacter, type Character, type Snapshot } from '../../shared/schema';

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(path, { headers: { 'x-gather-request': '1' }, data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test('a fallen player queues and cancels a fresh character without changing the story or past actions', async ({
  page,
}) => {
  const fallen = templateCharacter('Fallen Ivo');
  fallen.selectedEquipmentIds = fallen.equipmentOptions.slice(0, 2).map((item) => item.id);
  const oldSaved = await post<Character & { id: string }>(page.request, '/api/characters', fallen);
  let newSaved: Character & { id: string };
  await post(page.request, '/api/characters', templateCharacter('Unfinished character'));
  const campaign = await post<Snapshot>(page.request, '/api/campaigns', {
    ruleset: 'roguelike-v1',
    name: 'The road ahead',
    setting: 'A tower',
    premise: 'Follow the road.',
    tone: 'Adventurous',
    language: 'English',
    instructions: '',
    custom: [],
    provider: 'practice',
    model: '',
  });
  const snapshot = await post<Snapshot>(page.request, '/api/join', {
    code: campaign.inviteCode,
    playerName: 'Returning player',
    characterId: oldSaved.id,
  });
  await post(page.request, `/api/campaigns/${campaign.id}/start`, {});
  const member = snapshot.members.find((candidate) => candidate.id === snapshot.myMemberId)!;
  snapshot.status = 'active';
  snapshot.scene.encounters = 2;
  member.state.hp = 0;
  member.state.deathReason = 'The bridge collapsed.';
  snapshot.history = [
    {
      id: crypto.randomUUID(),
      number: 1,
      phase: 'complete',
      roster: [member.id],
      actions: [
        { memberId: member.id, characterName: fallen.name, text: 'Cross the bridge.', passed: false },
      ],
      rolls: [],
      result: outcomeSchema.parse({
        narration: 'Fallen Ivo fell while crossing the bridge.',
        summary: 'The bridge collapsed beneath Fallen Ivo.',
        choices: ['Search the ruins', 'Follow the bridge'],
        changes: [],
        journal: [],
      }),
      error: null,
    },
  ];
  await page.addInitScript(() => {
    Object.defineProperty(window, 'EventSource', {
      value: class {
        close() {}
      },
    });
  });
  await page.route(`**/api/campaigns/${campaign.id}`, (route) => route.fulfill({ json: snapshot }));
  const selections: (string | null)[] = [];
  await page.route(`**/api/campaigns/${campaign.id}/replacement`, async (route) => {
    const { characterId } = route.request().postDataJSON() as { characterId: string | null };
    selections.push(characterId);
    member.replacement = characterId ? { characterId, character: newSaved } : null;
    snapshot.version++;
    await route.fulfill({ json: snapshot });
  });
  await page.goto(`/campaign/${campaign.id}`);
  await expect(page.getByRole('heading', { name: `FALLEN · ${fallen.name}` })).toBeVisible();
  await expect(page.getByText('Fallen Ivo fell while crossing the bridge.', { exact: true })).toBeVisible();
  for (const suggestion of ['Search the ruins', 'Follow the bridge'])
    await expect(page.getByRole('button', { name: suggestion, exact: true })).toHaveCount(0);
  const picker = page.getByRole('region', { name: 'Next-turn character' });
  const select = picker.getByRole('combobox', { name: 'Replacement character' });
  await expect(select).toBeEnabled();
  await expect(select.locator('option', { hasText: 'Unfinished character' })).toHaveCount(0);
  await expect(picker.getByRole('link', { name: 'Create a character' })).toHaveAttribute(
    'href',
    '/characters',
  );
  const popup = page.waitForEvent('popup');
  await picker.getByRole('link', { name: 'Create a character' }).click();
  const library = await popup;
  await library.getByRole('button', { name: 'Create a character', exact: true }).click();
  await library.getByLabel('Character name (optional)').fill('New Neri');
  await library.getByLabel('Character concept').fill('A traveller returning to the changing tower');
  await library.getByLabel('Campaign context (optional)').selectOption(campaign.id);
  await expect(
    library.getByText('This practice campaign creates a scripted character without AI.'),
  ).toBeVisible();
  const generated = library.waitForResponse((response) =>
    response.url().endsWith('/api/characters/generate'),
  );
  await library.getByRole('button', { name: 'Generate from my concept' }).click();
  const generationResponse = await generated;
  expect(generationResponse.ok(), await generationResponse.text()).toBe(true);
  expect(generationResponse.request().postDataJSON()).toMatchObject({
    campaignId: campaign.id,
    name: 'New Neri',
  });
  await expect(
    library.locator('.character-sheet').getByRole('heading', { name: 'New Neri', exact: true }),
  ).toBeVisible();
  await library.locator('.ability-choices button').nth(0).click();
  await library.locator('.ability-choices button').nth(2).click();
  await library.locator('.equipment-choices button').nth(0).click();
  await library.locator('.equipment-choices button').nth(1).click();
  const saved = library.waitForResponse(
    (response) => response.url().endsWith('/api/characters') && response.request().method() === 'POST',
  );
  await library.getByRole('button', { name: 'Save character', exact: true }).click();
  const saveResponse = await saved;
  expect(saveResponse.ok(), await saveResponse.text()).toBe(true);
  newSaved = await saveResponse.json();
  expect(newSaved.selectedEquipmentIds).toHaveLength(2);
  await expect(
    library.locator('.library-card').getByRole('heading', { name: 'New Neri', exact: true }),
  ).toBeVisible();
  await library.close();
  await picker.getByRole('button', { name: 'Refresh saved characters' }).click();
  await expect(select.locator('option', { hasText: 'New Neri' })).toHaveCount(1);
  await select.selectOption(newSaved.id);
  await picker.getByRole('button', { name: 'Queue for next turn', exact: true }).click();
  await expect(picker.getByRole('status')).toContainText('New Neri');
  await expect(picker.getByRole('status')).toContainText('Level 1 · 0 XP · Fresh starting equipment');
  await expect(page.getByRole('heading', { name: `FALLEN · ${fallen.name}` })).toBeVisible();
  await page.reload();
  await expect(select).toHaveValue(newSaved.id);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/replacement-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await picker.getByRole('button', { name: 'Cancel replacement', exact: true }).click();
  await expect(picker.getByRole('status')).toHaveCount(0);
  await select.selectOption(newSaved.id);
  await picker.getByRole('button', { name: 'Queue for next turn', exact: true }).click();
  expect(selections).toEqual([newSaved.id, null, newSaved.id]);

  // The server introduces the queued character on the turn after a successful encounter.
  snapshot.scene.encounters++;
  member.character = newSaved;
  member.state = initialState(newSaved, 'new-turn');
  member.replacement = null;
  await page.reload();
  await expect(picker).toHaveCount(0);
  await expect(page.locator('.member-heading').filter({ hasText: 'New Neri' })).toBeVisible();
  await expect(page.locator('.past-actions b')).toHaveText('Fallen Ivo');

  member.state.hp = 0;
  snapshot.status = 'ended';
  await page.reload();
  await expect(picker).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Start a new run' })).toBeVisible();
});
