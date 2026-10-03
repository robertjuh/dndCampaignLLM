import { test, expect, type APIRequestContext } from '@playwright/test';
import { templateCharacter, type CampaignConfig, type Snapshot } from '../../shared/schema';

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(path, { headers: { 'x-gather-request': '1' }, data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test('turn pages follow the latest scene and preserve older scenes while browsing', async ({
  page,
  browser,
}) => {
  const campaign = await post<Snapshot>(page.request, '/api/campaigns', {
    ruleset: 'roguelike-v1',
    name: 'The turning road',
    setting: 'A quiet city',
    premise: 'The journey begins at the gate.',
    tone: 'Mysterious',
    language: 'English',
    instructions: '',
    custom: [],
    provider: 'practice',
    model: '',
  } satisfies CampaignConfig);
  const playerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const displayContext = await browser.newContext();
  const player = await playerContext.newPage();
  const display = await displayContext.newPage();
  try {
    const character = await post<{ id: string }>(
      player.request,
      '/api/characters',
      templateCharacter('Mira'),
    );
    const joined = await post<Snapshot>(player.request, '/api/join', {
      code: campaign.inviteCode,
      playerName: 'Mira player',
      characterId: character.id,
    });
    const member = joined.members.find((m) => m.id === joined.myMemberId)!;
    await post(player.request, `/api/campaigns/${campaign.id}/character`, {
      type: 'starter',
      itemIds: member.state.starterEquipment.slice(0, 2).map((item) => item.id),
    });
    await page.goto(`/campaign/${campaign.id}`);
    await player.goto(`/campaign/${campaign.id}`);
    await display.goto(`/screen/${campaign.id}#${campaign.displayToken}`);
    await page.getByRole('button', { name: 'Begin the story', exact: true }).click();

    const views = [page, player, display];
    for (const view of views) {
      await expect(view.getByText('Viewing opening scene', { exact: true })).toBeVisible();
      await expect(view.getByRole('button', { name: 'Previous turn', exact: true })).toBeDisabled();
      await expect(view.getByRole('button', { name: 'Next turn', exact: true })).toBeDisabled();
    }

    async function advance(round: number) {
      const current: Snapshot = await (await player.request.get(`/api/campaigns/${campaign.id}`)).json();
      await post(player.request, `/api/campaigns/${campaign.id}/action`, {
        turnId: current.turn!.id,
        text: `Examine the road, round ${round}.`,
        passed: false,
      });
      await expect(page.getByText(`Turn ${round + 1}`, { exact: true })).toBeVisible();
    }

    await advance(1);
    for (const view of views) {
      await expect(view.locator('.story-turn')).toHaveCount(1);
      await expect(view.getByText('Viewing turn 1', { exact: true })).toBeVisible();
      await expect(view.getByText('THE OPENING SCENE', { exact: true })).toHaveCount(0);
      await view.getByRole('button', { name: 'Previous turn', exact: true }).click();
      await expect(view.getByText('Viewing opening scene', { exact: true })).toBeVisible();
      await expect(view.locator('.current-turn')).toHaveCount(0);
    }
    await expect(player.getByLabel('Your action', { exact: true })).toHaveCount(0);

    // New turns must not interrupt a player or display reviewing the opening.
    await advance(2);
    for (const view of views) {
      await expect(view.getByText('Viewing opening scene', { exact: true })).toBeVisible();
      await view.getByRole('button', { name: 'Next turn', exact: true }).click();
      await expect(view.getByText('Viewing turn 1', { exact: true })).toBeVisible();
      await expect(view.getByRole('button', { name: 'Next turn', exact: true })).toBeEnabled();
      await view.getByRole('button', { name: 'Current turn', exact: true }).click();
      await expect(view.getByText('Viewing turn 2', { exact: true })).toBeVisible();
      await expect(view.getByRole('button', { name: 'Next turn', exact: true })).toBeDisabled();
      await expect(view.locator('.current-turn')).toBeVisible();
    }
    await expect(player.getByLabel('Your action', { exact: true })).toBeEnabled();
    expect(await player.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await player.reload();
    await expect(player.getByText('Viewing turn 2', { exact: true })).toBeVisible();
    await advance(3);
    for (const view of views) {
      await expect(view.getByText('Viewing turn 3', { exact: true })).toBeVisible();
      await expect(view.locator('.story-turn')).toHaveCount(1);
    }
  } finally {
    await playerContext.close();
    await displayContext.close();
  }
});
