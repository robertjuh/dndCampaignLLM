import { test, expect, type APIRequestContext } from '@playwright/test';
import { applyCondition, initialState } from '../../shared/rules';
import { templateCharacter, type Snapshot } from '../../shared/schema';

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(path, { headers: { 'x-gather-request': '1' }, data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

for (const condition of ['Stunned', 'Frozen', 'Electrocuted']) {
  test(`${condition} disables actions and excludes the player from readiness until recovery`, async ({
    page,
  }) => {
    const character = templateCharacter('Mira');
    character.selectedEquipmentIds = character.equipmentOptions.slice(0, 2).map((item) => item.id);
    const saved = await post<{ id: string }>(page.request, '/api/characters', character);
    const campaign = await post<Snapshot>(page.request, '/api/campaigns', {
      ruleset: 'roguelike-v1',
      name: 'Skipped turns',
      setting: 'A quiet forest',
      premise: '',
      tone: 'Mysterious',
      language: 'English',
      instructions: '',
      custom: [],
      provider: 'practice',
      model: '',
    });
    const snapshot = await post<Snapshot>(page.request, '/api/join', {
      code: campaign.inviteCode,
      playerName: 'Mira player',
      characterId: saved.id,
    });
    const mira = snapshot.members[0];
    const allyCharacter = templateCharacter('Rowan');
    const ally = {
      ...mira,
      id: crypto.randomUUID(),
      character: allyCharacter,
      state: initialState(allyCharacter, 'ally'),
    };
    ally.state.equipmentChosen = true;
    snapshot.members.push(ally);
    snapshot.status = 'active';
    snapshot.isHost = false;
    mira.state.hp -= 4;
    applyCondition(mira.state, condition);
    snapshot.turn = {
      id: crypto.randomUUID(),
      number: 1,
      phase: 'collecting',
      roster: [mira.id, ally.id],
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
    await page.route(`**/api/campaigns/${campaign.id}`, (route) => route.fulfill({ json: snapshot }));
    await page.goto(`/campaign/${campaign.id}`);
    await expect(page.getByText(`${condition} · turn skipped automatically`, { exact: true })).toBeVisible();
    await expect(
      page.getByText('No action is needed; the party does not have to wait for you.', { exact: false }),
    ).toBeVisible();
    await expect(page.getByLabel('Your action', { exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Submit action', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Pass', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Use ability', exact: true })).toHaveCount(0);
    await expect(page.getByText('0 / 1 ready', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Equipment & backpack' }).click();
    const potion = mira.state.inventory.find((item) => item.healing > 0)!;
    await expect(
      page
        .getByRole('article', { name: potion.name, exact: true })
        .getByRole('button', { name: 'Use on self' }),
    ).toBeDisabled();

    mira.state.conditions = [];
    mira.state.conditionTurns = {};
    snapshot.turn.number++;
    await page.reload();
    await expect(page.getByLabel('Your action', { exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Pass', exact: true })).toBeEnabled();
    await expect(page.getByText('0 / 2 ready', { exact: true })).toBeVisible();
  });
}
