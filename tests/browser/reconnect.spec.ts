import { test, expect, type APIRequestContext } from '@playwright/test';
import { templateCharacter, type Snapshot } from '../../shared/schema';

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(path, { headers: { 'x-gather-request': '1' }, data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test('players resume their saved seat after closing a tab or reopening their browser', async ({
  page,
  browser,
}) => {
  const create = (name: string) =>
    post<Snapshot>(page.request, '/api/campaigns', {
      name,
      setting: 'A quiet harbor',
      premise: '',
      tone: '',
      language: 'English',
      instructions: '',
      custom: [],
      provider: 'practice',
    });
  const active = await create('The Lantern Road');
  const lobby = await create('A very long campaign name that should wrap comfortably on a phone screen');
  await create('Another party’s campaign');
  const hostSnapshot: Snapshot = await (await page.request.get(`/api/campaigns/${active.id}`)).json();
  const origin = hostSnapshot.partyOrigins![0];
  const options = { baseURL: origin, viewport: { width: 390, height: 844 }, isMobile: true };
  let context = await browser.newContext(options);
  try {
    let player = await context.newPage();
    const sheet = templateCharacter('Returning traveler');
    sheet.selectedEquipmentIds = sheet.equipmentOptions.slice(0, 3).map((item) => item.id);
    const character = await post<{ id: string }>(player.request, '/api/characters', sheet);
    const joinData = { playerName: 'Returning player', characterId: character.id };
    const joined = await post<Snapshot>(player.request, '/api/join', {
      code: active.inviteCode,
      ...joinData,
    });
    await post(player.request, '/api/join', { code: lobby.inviteCode, ...joinData });
    await page.goto(`/campaign/${active.id}`);
    await page.getByRole('button', { name: 'Begin the story', exact: true }).click();
    await expect(page.locator('.host-bar .session-code')).toContainText(active.inviteCode!);
    await player.goto(`/campaign/${active.id}`);
    await expect(player.getByLabel('Your action', { exact: true })).toBeEnabled();
    const before: Snapshot = await (await player.request.get(`/api/campaigns/${active.id}`)).json();
    expect(before.myMemberId).toBe(joined.myMemberId);
    await player.close();

    player = await context.newPage();
    await player.goto('/');
    const resume = player.getByRole('region', { name: 'Resume a campaign', exact: true });
    await expect(resume.getByRole('link')).toHaveCount(2);
    await expect(
      resume.getByRole('link', { name: `Resume ${lobby.config.name}`, exact: true }),
    ).toBeVisible();
    await expect(resume).not.toContainText('Another party’s campaign');
    const activeLink = resume.getByRole('link', { name: `Resume ${active.config.name}`, exact: true });
    await expect(activeLink).toBeInViewport();
    expect(await player.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await player.screenshot({ path: 'test-results/resume-campaign-mobile.png', fullPage: true });
    await activeLink.click();
    await expect(player).toHaveURL(`${origin}/campaign/${active.id}`);
    await expect(player.getByLabel('Your action', { exact: true })).toBeEnabled();

    const storageState = await context.storageState();
    expect(storageState.cookies.find((cookie) => cookie.name === 'gather_session')!.expires).toBeGreaterThan(
      Date.now() / 1000,
    );
    await context.close();
    context = await browser.newContext({ ...options, storageState });
    player = await context.newPage();
    await player.goto('/join');
    await player.getByRole('link', { name: `Resume ${active.config.name}`, exact: true }).click();
    await expect(player).toHaveURL(`${origin}/campaign/${active.id}`);
    await expect(player.getByLabel('Your action', { exact: true })).toBeEnabled();

    await player.goto(`/${active.inviteCode}`);
    await expect(player.getByRole('button', { name: 'Join the party', exact: true })).toHaveCount(0);
    await player.getByRole('link', { name: `Resume ${active.config.name}`, exact: true }).click();
    await expect(player).toHaveURL(`${origin}/campaign/${active.id}`);
    const after: Snapshot = await (await player.request.get(`/api/campaigns/${active.id}`)).json();
    expect(after.myMemberId).toBe(before.myMemberId);
    expect(after.members).toEqual(before.members);
    expect(after.turn!.id).toBe(before.turn!.id);

    await player.goto('/campaigns');
    await expect(player.locator('.campaign-card').filter({ hasText: active.config.name })).toContainText(
      'Resume',
    );
  } finally {
    await context.close();
  }
});
