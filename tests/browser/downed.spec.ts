import { test, expect, type APIRequestContext } from '@playwright/test';
import { initialState } from '../../shared/rules';
import { templateCharacter, type Snapshot } from '../../shared/schema';

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(path, { headers: { 'x-gather-request': '1' }, data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test('downed players watch, allies target healing items and abilities, and recovered players can act', async ({
  page,
}) => {
  const character = templateCharacter('Mira');
  character.selectedEquipmentIds = character.equipmentOptions.slice(0, 2).map((item) => item.id);
  const saved = await post<{ id: string }>(page.request, '/api/characters', character);
  const campaign = await post<Snapshot>(page.request, '/api/campaigns', {
    ruleset: 'roguelike-v1',
    name: 'A helping hand',
    setting: 'An abandoned tower',
    premise: 'Help the party survive.',
    tone: 'Adventurous',
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
  const mira = snapshot.members.find((member) => member.id === snapshot.myMemberId)!;
  const healerCharacter = templateCharacter('Neri');
  healerCharacter.selectedEquipmentIds = healerCharacter.equipmentOptions.slice(0, 2).map((item) => item.id);
  healerCharacter.abilities[0] = {
    ...healerCharacter.abilities[0],
    name: 'Restoring touch',
    effect: 'mend',
  };
  const neri = {
    ...mira,
    id: crypto.randomUUID(),
    character: healerCharacter,
    state: initialState(healerCharacter, 'healer'),
  };
  snapshot.members.push(neri);
  snapshot.status = 'active';
  snapshot.isHost = false;
  mira.state.hp = 0;
  mira.state.conditions = ['Downed'];
  snapshot.turn = {
    id: crypto.randomUUID(),
    number: 1,
    phase: 'collecting',
    roster: [neri.id],
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
  const commands: unknown[] = [];
  await page.route(`**/api/campaigns/${campaign.id}/character`, async (route) => {
    const body = route.request().postDataJSON();
    commands.push(body);
    mira.state.hp = 6;
    mira.state.conditions = [];
    snapshot.turn!.roster.push(mira.id);
    if (body.abilityName) neri.state.abilityUses = { [body.abilityName]: 1 };
    snapshot.version++;
    await route.fulfill({ json: snapshot });
  });

  await page.goto(`/campaign/${campaign.id}`);
  await expect(page.getByRole('heading', { name: 'DOWNED · Mira' })).toBeVisible();
  await expect(page.getByText('Downed · needs healing', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Next-floor character' })).toHaveCount(0);
  await expect(page.getByLabel('Your action', { exact: true })).toHaveCount(0);
  await expect(page.getByText("Your character's death is permanent.", { exact: false })).toHaveCount(0);

  snapshot.myMemberId = neri.id;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Help a downed ally' })).toBeVisible();
  await page.getByRole('button', { name: 'Equipment & backpack' }).click();
  const potion = neri.state.inventory.find((item) => item.healing > 0)!;
  await page.getByRole('button', { name: 'Heal Mira', exact: true }).click();
  await expect(page.getByText('Downed · needs healing', { exact: true })).toHaveCount(0);
  expect(commands[0]).toEqual({ type: 'heal', itemId: potion.id, targetId: mira.id });

  mira.state.hp = 0;
  mira.state.conditions = ['Downed'];
  snapshot.turn.roster = [neri.id];
  await page.reload();
  await page.getByRole('button', { name: 'Restoring touch · Help Mira', exact: true }).click();
  await expect(page.getByText('Downed · needs healing', { exact: true })).toHaveCount(0);
  expect(commands[1]).toEqual({ type: 'heal', abilityName: 'Restoring touch', targetId: mira.id });

  snapshot.myMemberId = mira.id;
  await page.reload();
  await expect(page.getByLabel('Your action', { exact: true })).toBeEnabled();

  mira.state.hp = 0;
  mira.state.conditions = ['Downed'];
  neri.state.hp = 0;
  neri.state.conditions = ['Downed'];
  snapshot.status = 'ended';
  snapshot.turn = null;
  await page.reload();
  await expect(page.getByText('The party has been defeated.', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'DOWNED · Mira' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Next-floor character' })).toHaveCount(0);
});
