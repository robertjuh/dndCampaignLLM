import { templateCharacter } from '../../shared/schema';
import { test, expect, type Browser, type Page } from '@playwright/test';

async function join(browser: Browser, code: string, name: string, origin: string) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(`${origin}/join/${code}`);
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
  await expect(page.locator('.lobby-invite')).toContainText(
    `${snapshot.partyOrigins[0]}/join/${snapshot.inviteCode}`,
  );
  const first = await join(browser, snapshot.inviteCode, 'Mira', snapshot.partyOrigins[0]);
  const second = await join(browser, snapshot.inviteCode, 'Rowan', snapshot.partyOrigins[0]);
  const displayContext = await browser.newContext();
  const display = await displayContext.newPage();
  await display.goto(`/screen/${id}#${snapshot.displayToken}`);
  await expect(display.getByRole('heading', { name: 'The Lantern Road', exact: true })).toBeVisible();
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
  await expect(observation.locator('.ability-mechanics')).toContainText('Advantage');
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
  await expect(observation.locator('.ability-uses')).toContainText('1/1 uses remaining');
  await expect(observation.getByRole('button', { name: 'Use ability', exact: true })).toBeEnabled();
  await first.page.reload();
  await expect(
    first.page
      .locator('.character-controls .ability-card')
      .filter({ hasText: 'Keen observation' })
      .locator('.ability-uses'),
  ).toContainText('1/1 uses remaining');
  await expect(display.getByRole('button', { name: 'Submit action' })).toHaveCount(0);
  await display.screenshot({ path: 'test-results/shared-screen.png', fullPage: true });
  await first.page.setViewportSize({ width: 390, height: 844 });
  await first.page.screenshot({ path: 'test-results/player-mobile.png', fullPage: true });
  expect(await first.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload();
  await expect(page.getByText('Turn 2', { exact: true })).toBeVisible();
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
  await expect(first.page.locator('.reward-result')).toContainText('Practice combat ability 3');
  await first.page.reload();
  await expect(first.page.locator('.character-controls .ability-card')).toHaveCount(3);
  await expect(first.page.getByLabel('Your action')).toBeEnabled();
  await second.page.getByRole('button', { name: 'Gain 2 random attribute points', exact: true }).click();
  await expect(second.page.locator('.reward-result')).toContainText('+1');
  await expect(second.page.getByLabel('Your action')).toBeEnabled();
  expect(errors).toEqual([]);
  await first.context.close();
  await second.context.close();
  await displayContext.close();
});
