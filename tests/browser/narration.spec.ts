import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { templateCharacter, type CampaignConfig, type Snapshot } from '../../shared/schema';

type SpeechRecord = { text: string; lang: string; voiceURI: string | null };
declare global {
  interface Window {
    narrationSpeech: {
      spoken: SpeechRecord[];
      cancellations: number;
      loadVoices(): void;
      finish(index?: number): void;
      fail(): void;
    };
  }
}

async function mockSpeech(page: Page) {
  await page.addInitScript(() => {
    class Utterance extends EventTarget {
      lang = '';
      voice: SpeechSynthesisVoice | null = null;
      rate = 1;
      pitch = 1;
      volume = 1;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      constructor(public text: string) {
        super();
      }
    }
    const voices = [
      {
        name: 'English storyteller',
        lang: 'en-GB',
        voiceURI: 'voice:en-GB',
        default: true,
        localService: true,
      },
      {
        name: 'Dutch storyteller',
        lang: 'nl-NL',
        voiceURI: 'voice:nl-NL',
        default: false,
        localService: true,
      },
    ] as SpeechSynthesisVoice[];
    const queued: Utterance[] = [];
    let voicesLoaded = false;
    const synth = Object.assign(new EventTarget(), {
      speaking: false,
      paused: false,
      pending: false,
      onvoiceschanged: null as (() => void) | null,
      getVoices: () => (voicesLoaded ? voices : []),
      speak(utterance: Utterance) {
        queued.push(utterance);
        window.narrationSpeech.spoken.push({
          text: utterance.text,
          lang: utterance.lang,
          voiceURI: utterance.voice?.voiceURI ?? null,
        });
        synth.speaking = true;
        utterance.onstart?.();
        utterance.dispatchEvent(new Event('start'));
      },
      cancel() {
        window.narrationSpeech.cancellations++;
        synth.speaking = false;
      },
      resume() {},
    });
    window.narrationSpeech = {
      spoken: [],
      cancellations: 0,
      loadVoices() {
        voicesLoaded = true;
        synth.onvoiceschanged?.();
        synth.dispatchEvent(new Event('voiceschanged'));
      },
      finish(index = queued.length - 1) {
        synth.speaking = false;
        queued[index].onend?.();
        queued[index].dispatchEvent(new Event('end'));
      },
      fail() {
        synth.speaking = false;
        const utterance = queued.at(-1)!;
        utterance.onerror?.({ error: 'synthesis-failed' });
        utterance.dispatchEvent(Object.assign(new Event('error'), { error: 'synthesis-failed' }));
      },
    };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: Utterance });
  });
}

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(path, { headers: { 'x-gather-request': '1' }, data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function createCampaign(page: Page, overrides: Partial<CampaignConfig> = {}) {
  return post<Snapshot>(page.request, '/api/campaigns', {
    ruleset: 'roguelike-v1',
    name: 'The narrated road',
    setting: 'Een stille stad',
    premise: 'De tocht begint bij de poort.',
    tone: 'Mysterious',
    language: 'Nederlands',
    instructions: '',
    custom: [],
    provider: 'practice',
    model: '',
    ...overrides,
  } satisfies CampaignConfig);
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

const prose = (text: string) => text.replace(/\s+/g, ' ').trim();

test('the leader reads saved narration with a selected voice, stops, and replays older turns', async ({
  page,
}) => {
  await mockSpeech(page);
  const campaign = await createCampaign(page);
  await joinReady(page.request, campaign);
  await page.goto(`/campaign/${campaign.id}`);
  const read = page.getByRole('button', { name: 'Read latest turn', exact: true });
  const stop = page.getByRole('button', { name: 'Stop reading', exact: true });
  await expect(read).toBeDisabled();
  await page.getByRole('button', { name: 'Begin the story', exact: true }).click();
  await expect(read).toBeEnabled();
  const opening = (await snapshot(page, campaign.id)).history.at(-1)!.result!.narration;

  // Voices often arrive after the first render, especially in Chromium.
  await page.evaluate(() => window.narrationSpeech.loadVoices());
  const voice = page.getByRole('combobox', { name: 'Narrator voice', exact: true });
  await expect(voice.locator('option').filter({ hasText: 'English storyteller' })).toHaveCount(1);
  await expect(voice.locator('option').filter({ hasText: 'Dutch storyteller' })).toHaveCount(1);
  await page.screenshot({ path: '/tmp/narration-host.png', fullPage: true });
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/narration-host-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize(viewport);
  await read.click();
  await expect(stop).toBeVisible();
  let spoken = await page.evaluate(() => window.narrationSpeech.spoken);
  expect(prose(spoken[0].text)).toBe(prose(opening));
  expect(spoken[0].lang).toMatch(/^nl(?:-|$)/);
  expect(spoken[0].voiceURI).toBe('voice:nl-NL');
  await page.evaluate(() => window.narrationSpeech.finish());
  await expect(stop).toHaveCount(0);
  await expect(read).toBeEnabled();

  const english = await voice
    .locator('option')
    .filter({ hasText: 'English storyteller' })
    .getAttribute('value');
  await voice.selectOption(english!);
  await read.click();
  spoken = await page.evaluate(() => window.narrationSpeech.spoken);
  expect(spoken.at(-1)!.voiceURI).toBe('voice:en-GB');
  const cancellations = await page.evaluate(() => window.narrationSpeech.cancellations);
  await stop.click();
  expect(await page.evaluate(() => window.narrationSpeech.cancellations)).toBeGreaterThan(cancellations);
  await page.evaluate(() => window.narrationSpeech.finish());
  await expect(stop).toHaveCount(0);

  await page.getByLabel('Your action', { exact: true }).fill('Examine the lantern beside the gate.');
  await page.getByRole('button', { name: 'Submit action', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Read turn 1', exact: true })).toBeVisible();
  const latest = (await snapshot(page, campaign.id)).history.at(-1)!.result!.narration;
  await read.click();
  spoken = await page.evaluate(() => window.narrationSpeech.spoken);
  expect(prose(spoken.at(-1)!.text)).toBe(prose(latest));
  const replaced = spoken.length - 1;
  await page.getByRole('button', { name: 'Previous turn', exact: true }).click();
  await page.getByRole('button', { name: 'Read opening scene', exact: true }).click();
  spoken = await page.evaluate(() => window.narrationSpeech.spoken);
  expect(prose(spoken.at(-1)!.text)).toBe(prose(opening));
  await page.evaluate((index) => window.narrationSpeech.finish(index), replaced);
  await expect(stop).toBeVisible();
  await page.evaluate(() => window.narrationSpeech.finish());
  await expect(stop).toHaveCount(0);
});

test('shared screens read and stop narration while player campaign controls stay hidden', async ({
  page,
  browser,
}) => {
  await mockSpeech(page);
  const campaign = await createCampaign(page);
  const playerContext = await browser.newContext();
  const displayContext = await browser.newContext();
  const player = await playerContext.newPage();
  const display = await displayContext.newPage();
  try {
    await mockSpeech(player);
    await mockSpeech(display);
    await joinReady(player.request, campaign);
    await page.goto(`/campaign/${campaign.id}`);
    await page.getByRole('button', { name: 'Begin the story', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Read latest turn', exact: true })).toBeEnabled();
    const opening = (await snapshot(page, campaign.id)).history.at(-1)!.result!.narration;
    await player.goto(`/campaign/${campaign.id}`);
    await expect(player.getByLabel('Your action', { exact: true })).toBeVisible();
    await expect(
      player.getByRole('button', { name: /^Read (latest turn|opening scene|turn \d+)$/ }),
    ).toHaveCount(0);
    await expect(player.getByRole('combobox', { name: 'Narrator voice', exact: true })).toHaveCount(0);
    await page.goto(`/screen/${campaign.id}`);
    await display.goto(`/screen/${campaign.id}#${campaign.displayToken}`);
    for (const screen of [page, display]) {
      await expect(screen.getByText('Shared screen · viewing only', { exact: true })).toBeVisible();
      await expect(screen.getByRole('button', { name: 'Read latest turn', exact: true })).toBeEnabled();
      await expect(screen.getByRole('button', { name: 'Read opening scene', exact: true })).toBeEnabled();
      await expect(screen.getByRole('combobox', { name: 'Narrator voice', exact: true })).toBeVisible();
      await expect(screen.getByRole('combobox', { name: 'GM output language', exact: true })).toHaveCount(0);
      await expect(screen.getByRole('button', { name: 'Begin the story', exact: true })).toHaveCount(0);
      await expect(screen.getByLabel('Your action', { exact: true })).toHaveCount(0);
    }

    await display.evaluate(() => window.narrationSpeech.loadVoices());
    await display.screenshot({ path: '/tmp/narration-shared-screen.png', fullPage: true });
    const viewport = display.viewportSize()!;
    await display.setViewportSize({ width: 390, height: 844 });
    await display.screenshot({ path: '/tmp/narration-shared-screen-mobile.png', fullPage: true });
    expect(await display.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await display.setViewportSize(viewport);

    await player.getByLabel('Your action', { exact: true }).fill('Examine the lantern beside the gate.');
    await player.getByRole('button', { name: 'Submit action', exact: true }).click();
    await expect(display.getByRole('button', { name: 'Read turn 1', exact: true })).toBeEnabled();
    const latest = (await snapshot(page, campaign.id)).history.at(-1)!.result!.narration;
    const read = display.getByRole('button', { name: 'Read latest turn', exact: true });
    const stop = display.getByRole('button', { name: 'Stop reading', exact: true });
    await read.click();
    await expect(stop).toBeVisible();
    let spoken = await display.evaluate(() => window.narrationSpeech.spoken);
    expect(prose(spoken.at(-1)!.text)).toBe(prose(latest));
    expect(spoken.at(-1)!.voiceURI).toBe('voice:nl-NL');
    const cancellations = await display.evaluate(() => window.narrationSpeech.cancellations);
    await stop.click();
    await expect(stop).toHaveCount(0);
    expect(await display.evaluate(() => window.narrationSpeech.cancellations)).toBeGreaterThan(cancellations);

    await display.getByRole('button', { name: 'Previous turn', exact: true }).click();
    await display.getByRole('button', { name: 'Read opening scene', exact: true }).click();
    spoken = await display.evaluate(() => window.narrationSpeech.spoken);
    expect(prose(spoken.at(-1)!.text)).toBe(prose(opening));
    await display.evaluate(() => window.narrationSpeech.finish());
    await expect(stop).toHaveCount(0);
    expect(await page.evaluate(() => window.narrationSpeech.spoken)).toHaveLength(0);
    expect(await player.evaluate(() => window.narrationSpeech.spoken)).toHaveLength(0);
  } finally {
    await playerContext.close();
    await displayContext.close();
  }
});

test('an unsupported browser keeps narration unavailable without breaking the campaign', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: undefined });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: undefined });
  });
  const campaign = await createCampaign(page);
  await joinReady(page.request, campaign);
  await page.goto(`/campaign/${campaign.id}`);
  await page.getByRole('button', { name: 'Begin the story', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Read opening scene', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Read latest turn', exact: true })).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('Turn narration is unavailable in this browser.');
  await expect(page.getByLabel('Your action', { exact: true })).toBeEnabled();
});

test('long narration finishes in full and a speech failure allows another attempt', async ({ page }) => {
  await mockSpeech(page);
  const campaign = await createCampaign(page, {
    premise: 'De lantaarns verlichten de smalle weg. Een schaduw beweegt achter de poort. '.repeat(20),
  });
  await joinReady(page.request, campaign);
  await page.goto(`/campaign/${campaign.id}`);
  await page.getByRole('button', { name: 'Begin the story', exact: true }).click();
  const read = page.getByRole('button', { name: 'Read latest turn', exact: true });
  const stop = page.getByRole('button', { name: 'Stop reading', exact: true });
  await expect(read).toBeEnabled();
  const opening = (await snapshot(page, campaign.id)).history.at(-1)!.result!.narration;
  await read.click();
  await page.evaluate(() => window.narrationSpeech.fail());
  await expect(page.getByRole('alert')).toContainText('Could not read this turn aloud');
  await expect(stop).toHaveCount(0);
  await expect(read).toBeEnabled();

  const previous = await page.evaluate(() => window.narrationSpeech.spoken.length);
  await read.click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  for (let chunk = 0; chunk < 30 && (await stop.count()) > 0; chunk++) {
    await page.evaluate(() => window.narrationSpeech.finish());
  }
  await expect(stop).toHaveCount(0);
  const spoken = await page.evaluate((start) => window.narrationSpeech.spoken.slice(start), previous);
  expect(spoken.length).toBeGreaterThan(1);
  expect(spoken.every((utterance) => utterance.text.length <= 240)).toBe(true);
  expect(prose(spoken.map((utterance) => utterance.text).join(' '))).toBe(prose(opening));
  await expect(read).toBeEnabled();
});
