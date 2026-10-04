import { test, expect, type APIRequestContext } from '@playwright/test';
import { initialState } from '../../shared/rules';
import { templateCharacter, type Snapshot } from '../../shared/schema';

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(path, { headers: { 'x-gather-request': '1' }, data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test('helping and healing allies lock the turn, while self healing is instant during combat', async ({
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
  neri.state.inventory.find((item) => item.healing > 0)!.quantity = 2;
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
  const commands: Record<string, string>[] = [];
  await page.route(`**/api/campaigns/${campaign.id}/character`, async (route) => {
    const body = route.request().postDataJSON();
    commands.push(body);
    if (body.type === 'help-up' || body.targetId) {
      snapshot.turn!.actions.push({
        memberId: neri.id,
        text:
          body.type === 'help-up'
            ? 'I help up Mira.'
            : `I use ${neri.state.inventory.find((item) => item.id === body.itemId)!.name} on Mira.`,
        passed: false,
        supportAction:
          body.type === 'help-up'
            ? { type: 'help-up', targetId: mira.id }
            : { type: 'heal-ally', targetId: mira.id, itemId: body.itemId },
      });
    } else {
      const potion = neri.state.inventory.find((item) => item.id === body.itemId)!;
      neri.state.hp = Math.min(neri.state.maxHp, neri.state.hp + potion.healing);
      potion.quantity--;
    }
    snapshot.version++;
    await route.fulfill({ json: snapshot });
  });

  await page.goto(`/campaign/${campaign.id}`);
  await expect(page.getByRole('heading', { name: 'DOWNED · Mira' })).toBeVisible();
  await expect(page.getByText('Downed · needs help', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Next-turn character' })).toHaveCount(0);
  await expect(page.getByLabel('Your action', { exact: true })).toHaveCount(0);
  await expect(page.getByText("Your character's death is permanent.", { exact: false })).toHaveCount(0);

  snapshot.myMemberId = neri.id;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Help a downed ally' })).toBeVisible();
  await page.getByRole('button', { name: 'Help up Mira', exact: true }).click();
  expect(commands[0]).toEqual({ type: 'help-up', targetId: mira.id });
  await expect(page.getByLabel('Your action', { exact: true })).toHaveValue('I help up Mira.');
  await expect(page.getByLabel('Your action', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Pass', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Update action', exact: true })).toBeDisabled();
  await expect(page.getByText('Downed · needs help', { exact: true })).toBeVisible();

  mira.state.hp = 1;
  mira.state.conditions = [];
  snapshot.turn!.id = crypto.randomUUID();
  snapshot.turn!.number++;
  snapshot.turn!.actions = [];
  snapshot.turn!.roster.push(mira.id);
  snapshot.myMemberId = mira.id;
  await page.reload();
  await expect(page.getByLabel('Your action', { exact: true })).toBeEnabled();
  for (const stat of ['STR', 'DEX', 'INT', 'CHA', 'CON', 'WIS'])
    await expect(
      page.locator('.member-card').first().locator('.small-stats span', { hasText: stat }),
    ).toBeVisible();

  snapshot.myMemberId = neri.id;
  neri.state.hp = neri.state.maxHp - 7;
  snapshot.scene.encounter = { enemies: [], round: 1, initiative: [], victory: false, escaped: false };
  await page.reload();
  await page.getByRole('button', { name: 'Equipment & backpack' }).click();
  const potion = neri.state.inventory.find((item) => item.healing > 0)!;
  const item = page.getByRole('article', { name: potion.name, exact: true });
  await expect(item.getByRole('button', { name: 'Drop one', exact: true })).toBeDisabled();
  await item.getByRole('button', { name: 'Use on self', exact: true }).click();
  expect(commands[1]).toEqual({ type: 'heal', itemId: potion.id });
  await expect(page.getByLabel('Your action', { exact: true })).toBeEnabled();
  expect(snapshot.turn!.actions).toEqual([]);
  await item.getByLabel(`Healing target for ${potion.name}`).selectOption(mira.id);
  await page.getByRole('button', { name: 'Heal Mira', exact: true }).click();
  expect(commands[2]).toEqual({ type: 'heal', itemId: potion.id, targetId: mira.id });
  await expect(page.getByLabel('Your action', { exact: true })).toHaveValue(`I use ${potion.name} on Mira.`);
  await expect(page.getByLabel('Your action', { exact: true })).toBeDisabled();
  expect(mira.state.hp).toBe(1);

  snapshot.myMemberId = mira.id;
  mira.state.hp = 0;
  mira.state.conditions = ['Downed'];
  neri.state.hp = 0;
  neri.state.conditions = ['Downed'];
  snapshot.status = 'ended';
  snapshot.turn = null;
  await page.reload();
  await expect(page.getByText('The party has been defeated.', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'DOWNED · Mira' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Next-turn character' })).toHaveCount(0);
});
