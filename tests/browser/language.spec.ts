import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { templateCharacter, type CampaignConfig, type Snapshot } from '../../shared/schema';

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(path, { headers: { 'x-gather-request': '1' }, data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function joinReady(request: APIRequestContext, campaign: Snapshot) {
  const character = await post<{ id: string }>(request, '/api/characters', templateCharacter('Mira'));
  const joined = await post<Snapshot>(request, '/api/join', {
    code: campaign.inviteCode,
    playerName: 'Mira player',
    characterId: character.id,
  });
  const member = joined.members.find((member) => member.id === joined.myMemberId)!;
  await post(request, `/api/campaigns/${campaign.id}/character`, {
    type: 'starter',
    itemIds: member.state.starterEquipment.slice(0, 2).map((item) => item.id),
  });
}

async function snapshot(page: Page, id: string): Promise<Snapshot> {
  return (await page.request.get(`/api/campaigns/${id}`)).json();
}

const languageControl = (page: Page) =>
  page.getByRole('combobox', { name: 'GM output language', exact: true });

test('the host chooses Dutch at creation and keeps the choice after reloading', async ({ page, browser }) => {
  await page.goto('/new');
  await expect(languageControl(page)).toHaveValue('English');
  await languageControl(page).selectOption('Nederlands');
  await page.getByLabel('Campaign name', { exact: true }).fill('De stille poort');
  await page.getByLabel('Setting', { exact: true }).fill('Een stille stad');
  await page.getByLabel('Practice table').check();
  await page.getByRole('button', { name: 'Create campaign', exact: true }).click();
  await expect(page).toHaveURL(/\/campaign\//);
  const id = new URL(page.url()).pathname.split('/')[2];
  const campaign = await snapshot(page, id);
  expect(campaign.config.language).toBe('Nederlands');
  await page.reload();
  await expect(languageControl(page)).toHaveValue('Nederlands');

  const playerContext = await browser.newContext();
  const player = await playerContext.newPage();
  const displayContext = await browser.newContext();
  const display = await displayContext.newPage();
  try {
    await joinReady(player.request, campaign);
    await player.goto(`/campaign/${id}`);
    await expect(player.getByRole('heading', { name: 'Prepare your character' })).toBeVisible();
    await expect(languageControl(player)).toHaveCount(0);
    await display.goto(`/screen/${id}#${campaign.displayToken}`);
    await expect(display.getByText('Shared screen · viewing only', { exact: true })).toBeVisible();
    await expect(languageControl(display)).toHaveCount(0);
    await page.getByRole('button', { name: 'Begin the story', exact: true }).click();
    await expect(display.locator('.narration')).toContainText(
      'Dit is een offline oefening met de spelregels.',
    );
    await expect(languageControl(player)).toHaveCount(0);
    await expect(languageControl(display)).toHaveCount(0);
  } finally {
    await playerContext.close();
    await displayContext.close();
  }
});

test('a live host language change reaches the next GM output and preserves earlier turns', async ({
  page,
}) => {
  const campaign = await post<Snapshot>(page.request, '/api/campaigns', {
    ruleset: 'roguelike-v1',
    name: 'The bilingual road',
    setting: 'Een stille stad',
    premise: '',
    tone: '',
    language: 'English',
    instructions: '',
    custom: [],
    provider: 'practice',
    model: '',
  } satisfies CampaignConfig);
  await joinReady(page.request, campaign);
  await page.goto(`/campaign/${campaign.id}`);
  const peer = await page.context().newPage();
  try {
    await peer.goto(`/campaign/${campaign.id}`);
    await expect(languageControl(peer)).toHaveValue('English');
    await page.getByRole('button', { name: 'Begin the story', exact: true }).click();
    await expect(page.getByLabel('Your action', { exact: true })).toBeEnabled();
    const opening = (await snapshot(page, campaign.id)).history[0];
    expect(opening.result?.narration).toContain('This is an offline rules rehearsal.');

    await languageControl(page).selectOption('Nederlands');
    await expect(languageControl(peer)).toHaveValue('Nederlands');
    await page.getByLabel('Your action', { exact: true }).fill('Onderzoek de poort.');
    await page.getByRole('button', { name: 'Submit action', exact: true }).click();
    await expect(page.getByText('Turn 2', { exact: true })).toBeVisible();
    const updated = await snapshot(page, campaign.id);
    expect(updated.config.language).toBe('Nederlands');
    expect(updated.history[0]).toEqual(opening);
    expect(updated.history.at(-1)!.result!.summary).toContain(
      updated.scene.safeRest ? 'Veilig rusten is mogelijk.' : 'Veilig rusten is niet mogelijk.',
    );
    expect(updated.history.at(-1)!.result!.summary).toContain('XP-beloningen:');
    await expect(page.locator('.recap')).toContainText('+20 XP.');
    await expect(page.locator('.roll-receipt')).toContainText('INT');
    await page.reload();
    await expect(languageControl(page)).toHaveValue('Nederlands');
    await page.getByRole('button', { name: 'Previous turn', exact: true }).click();
    await expect(page.locator('.narration')).toContainText('This is an offline rules rehearsal.');
  } finally {
    await peer.close();
  }
});
