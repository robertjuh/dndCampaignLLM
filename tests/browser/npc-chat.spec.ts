import { test, expect, type Page } from '@playwright/test';
import { templateCharacter, type Snapshot } from '../../shared/schema';

async function post<T>(page: Page, path: string, data: unknown): Promise<T> {
  const res = await page.request.post(path, { data, headers: { 'x-gather-request': '1' } });
  expect(res.ok(), await res.text()).toBe(true);
  return res.json();
}

test('two phones follow one live conversation while the shared screen keeps showing the table', async ({
  page: host,
  browser,
}) => {
  const campaign = await post<Snapshot>(host, '/api/campaigns', {
    name: 'Conversation table',
    setting: 'A lantern-lit harbor',
    provider: 'practice',
    premise: '',
    tone: '',
    instructions: '',
    language: 'English',
    custom: [],
  });
  const path = '/campaign/' + campaign.id;
  const options = {
    baseURL: campaign.partyOrigins?.[0] ?? 'http://127.0.0.1:3100',
    viewport: { width: 390, height: 844 },
    isMobile: true,
  };
  const contexts = await Promise.all([browser.newContext(options), browser.newContext(options)]);
  try {
    const [speaker, listener] = await Promise.all(
      contexts.map(async (ctx, i) => {
        const phone = await ctx.newPage();
        const sheet = templateCharacter(i ? 'Finn' : 'Aster');
        sheet.selectedEquipmentIds = sheet.equipmentOptions.slice(0, 3).map((item) => item.id);
        const character = await post<{ id: string }>(phone, '/api/characters', sheet);
        await post(phone, '/api/join', {
          code: campaign.inviteCode,
          characterId: character.id,
          playerName: sheet.name,
        });
        await phone.goto(path);
        return phone;
      }),
    );
    await post(host, '/api/campaigns/' + campaign.id + '/start', {});
    await host.goto('/screen/' + campaign.id);
    await speaker.getByRole('button', { name: 'Talk to Wayfinder' }).click();
    await speaker.getByLabel('Message to Wayfinder').fill('Can you help me?');
    await speaker.getByRole('button', { name: 'Send message' }).click();
    await listener.getByRole('button', { name: 'Listen in' }).click();
    const log = listener.getByRole('log');
    await expect(log).toContainText('Can you help me?');
    await expect(log).toContainText('I can point out the way.');
    await expect(listener.getByLabel('Message to Wayfinder')).toHaveCount(0);
    await expect(host.locator('.member-card').filter({ hasText: 'Aster' })).toContainText(
      'Talking to Wayfinder',
    );
    await expect(host.getByText('Can you help me?')).toHaveCount(0);
    await listener.getByRole('button', { name: 'Back to play' }).click();
    await expect(log).toHaveCount(0);
    await speaker.reload();
    await expect(speaker.getByRole('log')).toContainText('Can you help me?');
    await speaker.getByRole('button', { name: 'Ask for directions' }).click();
    await listener.getByRole('button', { name: 'Listen in' }).click();
    await expect(log).toContainText('Submitted for turn');
    await speaker.getByRole('button', { name: 'End conversation' }).click();
    await expect(listener.getByRole('button', { name: 'Talk to Wayfinder' })).toBeVisible();
    await expect(host.getByText('Talking to Wayfinder')).toHaveCount(0);
  } finally {
    await Promise.all(contexts.map((ctx) => ctx.close()));
  }
});
