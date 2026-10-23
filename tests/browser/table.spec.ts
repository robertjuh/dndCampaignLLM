import { templateCharacter } from '../../shared/schema';
import { test, expect, type Browser, type Page } from '@playwright/test';

async function join(browser: Browser, code: string, name: string, origin: string, entry = 'link') {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(entry === 'code' ? origin : `${origin}/${code}`);
  if (entry === 'code') {
    await page.getByRole('textbox', { name: 'Session code', exact: true }).fill(code.toLowerCase());
    await page.getByRole('button', { name: 'Join session', exact: true }).click();
    await expect(page).toHaveURL(`${origin}/${code}`);
  }
  await page.getByLabel('Your player name').fill(name + ' player');
  await page.getByRole('button', { name: 'Create a new character' }).click();
  await page.route('**/api/characters/generate', (route) =>
    route.fulfill({ json: templateCharacter(name, name + ' custom species') }),
  );
  await page.getByLabel('Character concept').fill(name + ' the adventurer');
  await page.getByRole('button', { name: 'Generate from my concept' }).click();
  await page.locator('.equipment-choices button').nth(0).click();
  await page.locator('.equipment-choices button').nth(1).click();
  await page.getByRole('button', { name: 'Save character', exact: true }).click();
  await page.getByRole('button', { name: 'Join the party', exact: true }).click();
  await expect(page).toHaveURL(/\/campaign\//);
  await expect(page.getByRole('heading', { name: 'Prepare your character' })).toBeVisible();
  await page.getByRole('button', { name: 'Review my character', exact: true }).click();
  await expect(page.locator('.equipment-choices [aria-pressed="true"]')).toHaveCount(2);
  await expect(page.locator('.character-sheet input, .character-sheet textarea')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save character', exact: true }).click();
  await expect(
    page.getByText('You are ready. Waiting for the campaign leader to begin the story.'),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  return { context, page };
}

test('a phone can join from the lobby QR link or a four-character code', async ({ page, browser }) => {
  const headers = { 'x-gather-request': '1' };
  const created = await page.request.post('/api/campaigns', {
    headers,
    data: {
      name: 'Easy to join',
      setting: 'A lantern-lit harbor',
      premise: '',
      tone: '',
      language: 'English',
      instructions: '',
      custom: [],
      provider: 'practice',
    },
  });
  expect(created.ok()).toBe(true);
  const campaign = await created.json();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/campaign/${campaign.id}`);
  const invite = page.getByRole('region', { name: 'Join this session', exact: true });
  await expect(invite.locator('b')).toHaveText(/^[A-HJ-NP-Z2-9]{4}$/);
  await expect(invite.getByRole('img', { name: 'Scan to join this session' })).toBeVisible();
  const joinLink = (await invite.getByRole('link', { name: 'Open join page' }).getAttribute('href'))!;
  const origin = new URL(joinLink).origin;
  expect(new URL(joinLink).pathname).toBe(`/${campaign.inviteCode}`);
  expect(new URL(joinLink).hostname).not.toBe('localhost');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await invite.screenshot({ path: 'test-results/invite-qr-mobile.png' });

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  try {
    const player = await context.newPage();
    const character = templateCharacter('QR traveler');
    character.selectedEquipmentIds = character.equipmentOptions.slice(0, 2).map((item) => item.id);
    const saved = await player.request.post(`${origin}/api/characters`, { headers, data: character });
    expect(saved.ok()).toBe(true);
    await player.goto(joinLink);
    await expect(player.getByRole('heading', { name: 'Easy to join', exact: true })).toBeVisible();
    await player.goto(origin);
    await expect(player.getByRole('heading', { name: 'Join a session', exact: true })).toBeVisible();
    await expect(player.getByRole('textbox', { name: 'Session code', exact: true })).toBeInViewport();
    await player.screenshot({ path: 'test-results/join-entry-mobile.png' });
    await player
      .getByRole('textbox', { name: 'Session code', exact: true })
      .fill(campaign.inviteCode.toLowerCase());
    await player.getByRole('button', { name: 'Join session', exact: true }).click();
    await expect(player).toHaveURL(joinLink);
    await expect(player.getByRole('heading', { name: 'Easy to join', exact: true })).toBeVisible();
    await player.getByLabel('Your player name').fill('QR player');
    await player.getByRole('button', { name: 'Join the party', exact: true }).click();
    await expect(player).toHaveURL(new RegExp(`/campaign/${campaign.id}$`));
    await expect(page.locator('.member-card')).toContainText('QR traveler');
  } finally {
    await context.close();
  }
});

test('the dedicated join page keeps the four-character field above the fold', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/join');
  await expect(page.getByRole('heading', { name: 'Join a session', exact: true })).toBeVisible();
  const code = page.getByRole('textbox', { name: 'Session code', exact: true });
  await expect(code).toBeInViewport();
  await code.fill('ABC');
  await page.getByRole('button', { name: 'Join session', exact: true }).click();
  await expect(page).toHaveURL(/\/join$/);
  expect(await code.evaluate((element: HTMLInputElement) => element.validity.patternMismatch)).toBe(true);
  await page.getByRole('link', { name: 'Your campaigns', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your campaigns', exact: true })).toBeVisible();
});

test('a shared screen follows two players and advances only after both submit', async ({ page, browser }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your campaigns' })).toBeVisible();
  await page.screenshot({ path: 'test-results/dashboard.png', fullPage: true });
  await page.getByRole('link', { name: 'Start an adventure' }).click();
  await page.getByLabel('Campaign name', { exact: true }).fill('The Lantern Road');
  await page.getByLabel('Setting', { exact: true }).fill('A glass city suspended above a violet ocean');
  await page.getByLabel('Practice table').check();
  await page.getByRole('button', { name: 'Create campaign', exact: true }).click();
  await expect(page).toHaveURL(/\/campaign\//);
  const id = new URL(page.url()).pathname.split('/')[2];
  const snapshot = await page.evaluate(async (id) => (await fetch(`/api/campaigns/${id}`)).json(), id);
  expect(snapshot.inviteCode).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
  await expect(page.getByRole('img', { name: 'Scan to join this session', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open join page', exact: true })).toHaveAttribute(
    'href',
    `${snapshot.partyOrigins[0]}/${snapshot.inviteCode}`,
  );
  await expect(page.locator('.lobby-invite')).toContainText(
    `${snapshot.partyOrigins[0]}/${snapshot.inviteCode}`,
  );
  const first = await join(browser, snapshot.inviteCode, 'Mira', snapshot.partyOrigins[0]);
  const second = await join(browser, snapshot.inviteCode, 'Rowan', snapshot.partyOrigins[0], 'code');
  const displayContext = await browser.newContext();
  const display = await displayContext.newPage();
  await display.goto(`/screen/${id}#${snapshot.displayToken}`);
  await expect(display.getByRole('heading', { name: 'The party', exact: true })).toBeVisible();
  await expect(display.getByText('Shared screen · viewing only', { exact: true })).toBeVisible();
  await expect(display.getByRole('link', { name: 'Open player / leader controls' })).toBeVisible();
  await expect(display.getByRole('button', { name: 'Begin the story' })).toHaveCount(0);
  await expect(display.getByRole('button', { name: 'Review my character' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Begin the story' })).toBeEnabled();
  await page.getByRole('button', { name: 'Begin the story' }).click();
  await expect(first.page.getByLabel('Your action')).toBeEnabled();
  const observation = first.page
    .locator('.character-controls .ability-card')
    .filter({ hasText: 'Keen observation' });
  await first.page.getByRole('button', { name: 'Open abilities', exact: true }).click();
  await expect(observation.locator('.ability-effect')).toContainText('Advantage');
  await observation.getByRole('button', { name: 'Use ability', exact: true }).click();
  await expect(first.page.locator('.selected-ability')).toContainText('Keen observation');
  await first.page.getByLabel('Your action').fill('Mira examines the brass key.');
  await first.page.getByRole('button', { name: 'Submit action' }).click();
  await expect(display.getByText('Mira examines the brass key.', { exact: true })).toBeVisible();
  await expect(display.getByText('1 / 2 ready', { exact: true })).toBeVisible();
  await first.page.getByRole('button', { name: 'Cancel action', exact: true }).click();
  await expect(display.getByText('0 / 2 ready', { exact: true })).toBeVisible();
  await expect(first.page.getByLabel('Your action')).toHaveValue('Mira examines the brass key.');
  await expect(second.page.getByLabel('Your action')).toBeEnabled();
  await second.page.getByRole('button', { name: 'Open action input', exact: true }).click();
  await second.page.getByLabel('Your action').fill('Rowan watches the doorway.');
  await second.page.getByRole('button', { name: 'Submit action' }).click();
  await expect(display.getByText('1 / 2 ready', { exact: true })).toBeVisible();
  await expect(display.getByText('Turn 1', { exact: true })).toBeVisible();
  await expect(first.page.getByRole('button', { name: 'Submit action' })).toBeEnabled();
  await first.page.getByRole('button', { name: 'Submit action' }).click();
  await expect(display.getByText('CHAPTER IN MOTION · TURN 1')).toBeVisible();
  await expect(display.getByText('Turn 2', { exact: true })).toBeVisible();
  await expect(display.locator('.roll-receipt')).toHaveCount(2);
  const completedTurn = display.locator('.story-turn').last();
  await expect(completedTurn.locator('.recap')).toContainText('Mira: +20 XP.');
  await expect(completedTurn.locator('.recap')).toContainText('Rowan: +20 XP.');
  await expect(completedTurn.locator('.narration')).not.toContainText(/\b(?:XP|DC)\b/);
  expect(
    await completedTurn.evaluate((element) => {
      const rolls = element.querySelector('.rolls')!;
      const narrator = element.querySelector('.narrator')!;
      return !!(rolls.compareDocumentPosition(narrator) & Node.DOCUMENT_POSITION_FOLLOWING);
    }),
  ).toBe(true);
  await expect(first.page.getByText('1 encounters completed', { exact: true })).toBeVisible();
  await first.page.getByRole('button', { name: 'Collapse action input', exact: true }).click();
  await first.page.getByRole('button', { name: 'Open abilities', exact: true }).click();
  await expect(observation.locator('.ability-uses')).toContainText('1/1 available');
  await expect(observation.getByRole('button', { name: 'Use ability', exact: true })).toBeEnabled();
  await first.page.reload();
  await expect(
    first.page
      .locator('.character-controls .ability-card')
      .filter({ hasText: 'Keen observation' })
      .locator('.ability-uses'),
  ).toContainText('1/1 available');
  await expect(display.getByRole('button', { name: 'Submit action' })).toHaveCount(0);
  await display.screenshot({ path: 'test-results/shared-screen.png', fullPage: true });
  await first.page.setViewportSize({ width: 390, height: 844 });
  await first.page.screenshot({ path: 'test-results/player-mobile.png', fullPage: true });
  expect(await first.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload();
  await expect(page.getByText('Turn 2', { exact: true })).toBeVisible();
  await first.page.getByRole('button', { name: 'Open action input', exact: true }).click();
  for (let round = 2; round <= 5; round++) {
    for (const player of [first, second]) {
      await expect(player.page.getByLabel('Your action')).toBeEnabled();
      await player.page.getByLabel('Your action').fill(`Study the road, round ${round}.`);
      await player.page.getByRole('button', { name: 'Submit action' }).click();
    }
    await expect(display.getByText(`Turn ${round + 1}`, { exact: true })).toBeVisible();
  }
  await expect(first.page.locator('.level-up-choices button')).toHaveCount(5);
  await expect(first.page.getByLabel('Your action')).toBeDisabled();
  await first.page.screenshot({ path: 'test-results/level-up-mobile.png', fullPage: true });
  await first.page.getByRole('button', { name: 'Gain a new in-combat ability', exact: true }).click();
  await expect(first.page.locator('.character-controls')).toContainText('Practice combat ability 3');
  await expect(first.page.locator('.reward-result')).toHaveCount(0);
  await first.page.reload();
  await expect(first.page.locator('.character-controls .ability-card')).toHaveCount(3);
  await expect(first.page.getByLabel('Your action')).toBeEnabled();
  await second.page.getByRole('button', { name: 'Gain 2 random attribute points', exact: true }).click();
  await expect(second.page.locator('.level-up-choices')).toHaveCount(0);
  await expect(second.page.locator('.reward-result')).toHaveCount(0);
  await expect(second.page.getByLabel('Your action')).toBeEnabled();
  expect(errors).toEqual([]);
  await first.context.close();
  await second.context.close();
  await displayContext.close();
});
