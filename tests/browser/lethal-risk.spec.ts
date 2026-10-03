import { test, expect, type APIRequestContext } from '@playwright/test';
import { templateCharacter, type Snapshot } from '../../shared/schema';

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(path, { headers: { 'x-gather-request': '1' }, data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test('legacy lethal warnings do not add a warning or acceptance step to action submission', async ({
  page,
}) => {
  const character = templateCharacter('Mira');
  character.selectedEquipmentIds = character.equipmentOptions.slice(0, 2).map((item) => item.id);
  const saved = await post<{ id: string }>(page.request, '/api/characters', character);
  const campaign = await post<Snapshot>(page.request, '/api/campaigns', {
    ruleset: 'roguelike-v1',
    name: 'The dangerous bridge',
    setting: 'A ruined tower',
    premise: 'The party approaches a damaged bridge.',
    tone: 'Adventurous',
    language: 'English',
    instructions: '',
    custom: [],
    provider: 'practice',
    model: '',
  });
  let snapshot = await post<Snapshot>(page.request, '/api/join', {
    code: campaign.inviteCode,
    playerName: 'Mira player',
    characterId: saved.id,
  });
  await post(page.request, `/api/campaigns/${campaign.id}/start`, {});
  await expect
    .poll(async () => {
      snapshot = await (await page.request.get(`/api/campaigns/${campaign.id}`)).json();
      return snapshot.turn?.phase;
    })
    .toBe('collecting');
  const turnId = snapshot.turn!.id;
  const warning = 'The collapsing bridge could kill anyone who attempts to cross.';
  const legacySnapshot = { ...snapshot, scene: { ...snapshot.scene, lethalWarning: warning } };
  await page.addInitScript(() => {
    Object.defineProperty(window, 'EventSource', {
      value: class {
        close() {}
      },
    });
  });
  await page.route(`**/api/campaigns/${campaign.id}`, (route) => route.fulfill({ json: legacySnapshot }));
  await page.goto(`/campaign/${campaign.id}`);
  await expect(page.getByLabel('Your action', { exact: true })).toBeEnabled();
  await expect(page.getByText('0 / 1 ready', { exact: true })).toBeVisible();
  await expect(page.getByText('WARNING: FAILURE HERE COULD BE FATAL.', { exact: true })).toHaveCount(0);
  await expect(page.getByText(warning, { exact: true })).toHaveCount(0);
  await expect(page.locator('.risk-accept')).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: /accept.*lethal/i })).toHaveCount(0);

  const action = 'Cross the damaged bridge and search the far platform.';
  await page.getByLabel('Your action', { exact: true }).fill(action);
  const submitted = page.waitForRequest(
    (request) =>
      request.url().endsWith(`/api/campaigns/${campaign.id}/action`) && request.method() === 'POST',
  );
  await page.getByRole('button', { name: 'Submit action', exact: true }).click();
  const request = await submitted;
  const payload = request.postDataJSON();
  expect(payload).toMatchObject({ turnId, text: action, passed: false });
  expect(payload).not.toHaveProperty('acceptsLethalRisk');
  await expect
    .poll(async () => {
      const current: Snapshot = await (await page.request.get(`/api/campaigns/${campaign.id}`)).json();
      return current.history.some(
        (turn) => turn.id === turnId && turn.actions.some((submitted) => submitted.text === action),
      );
    })
    .toBe(true);
});
