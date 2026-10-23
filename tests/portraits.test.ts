import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app';
import type { ChatGPTAuth } from '../server/auth';
import { openDatabase } from '../server/db';
import { generatePortrait } from '../server/portraits';
import { PracticeGM } from '../server/providers';
import { templateCharacter, type Character } from '../shared/schema';

// Only the JPEG envelope is relevant to the API/storage contract in these tests.
const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function fixture(provider: 'chatgpt' | 'practice' = 'chatgpt') {
  vi.stubEnv('OPENAI_API_KEY', 'test-portrait-key');
  const fetcher = vi.fn(async () => Response.json({ data: [{ b64_json: image.toString('base64') }] }));
  vi.stubGlobal('fetch', fetcher);
  const directory = mkdtempSync(join(tmpdir(), 'gather-portraits-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'test.sqlite');
  const db = openDatabase(filename);
  cleanup.push(() => {
    if (db.open) db.close();
  });
  const sheet = templateCharacter('Mira', 'Clockwork moth');
  sheet.appearance = 'Brass antennae and large blue glass eyes.';
  sheet.selectedEquipmentIds = sheet.equipmentOptions.slice(0, 2).map((item) => item.id);
  const gm = new PracticeGM();
  const generate = vi.spyOn(gm, 'generate').mockImplementation(async () => structuredClone(sheet));
  const { app, game } = await createApp({ db, auth: {} as ChatGPTAuth, providers: () => gm });
  cleanup.push(() => app.close());
  const host = game.identify();
  const campaign = game.create(host.id, {
    name: 'Star travellers',
    setting: 'An orbital station',
    premise: '',
    tone: 'Hopeful science fiction',
    language: 'English',
    instructions: '',
    custom: [],
    provider,
  });
  const request = () =>
    app.inject({
      method: 'POST',
      url: '/api/characters/generate',
      headers: { 'x-gather-request': '1' },
      cookies: { gather_session: host.token! },
      payload: { concept: 'A curious clockwork moth', name: 'Captain Mira', campaignId: campaign.id },
    });
  return { db, filename, app, game, host, campaign, fetcher, generate, request };
}

it('generates one low-quality portrait, saves it across restarts, and reuses it when joining and displaying', async () => {
  const f = await fixture();
  const response = await f.request();
  expect(response.statusCode, response.body).toBe(200);
  const character: Character = response.json();
  expect(character.portraitId).toMatch(/^[a-f0-9-]{36}$/);
  expect(character.portraitError).toBeUndefined();
  expect(f.fetcher).toHaveBeenCalledOnce();
  const [url, init] = vi.mocked(fetch).mock.calls[0];
  expect(url).toBe('https://api.openai.com/v1/images/generations');
  expect(init!.headers).toMatchObject({ Authorization: 'Bearer test-portrait-key' });
  const body = JSON.parse(init!.body as string);
  expect(body).toMatchObject({
    model: 'gpt-image-2',
    quality: 'low',
    size: '1024x1024',
    n: 1,
    output_format: 'jpeg',
  });
  expect(body.prompt).toContain('Captain Mira');
  expect(body.prompt).toContain('Brass antennae');
  expect(body.prompt).toContain('An orbital station');
  expect(body.prompt).not.toContain(f.host.id);
  expect(response.body).not.toContain('test-portrait-key');

  const saved = await f.app.inject({
    method: 'POST',
    url: '/api/characters',
    headers: { 'x-gather-request': '1' },
    cookies: { gather_session: f.host.token! },
    payload: character,
  });
  expect(saved.statusCode, saved.body).toBe(200);
  f.game.join(f.campaign.inviteCode!, f.host.id, saved.json().id);
  expect(f.game.members(f.campaign.id)[0].character.portraitId).toBe(character.portraitId);
  const portrait = await f.app.inject(`/api/portraits/${character.portraitId}`);
  expect(portrait.statusCode).toBe(200);
  expect(portrait.headers['content-type']).toBe('image/jpeg');
  expect(portrait.headers['cache-control']).toContain('immutable');
  expect(portrait.rawPayload).toEqual(image);
  expect((await f.app.inject(`/api/portraits/${randomUUID()}`)).statusCode).toBe(404);
  expect((await f.app.inject('/api/portraits/invalid-id')).statusCode).toBe(400);
  expect(f.fetcher).toHaveBeenCalledOnce();
  await f.app.close();
  f.db.close();
  const reopened = openDatabase(f.filename);
  try {
    expect(
      (
        reopened.prepare('SELECT image FROM character_portraits WHERE id = ?').get(character.portraitId) as {
          image: Buffer;
        }
      ).image,
    ).toEqual(image);
    expect(
      JSON.parse(
        (
          reopened.prepare('SELECT sheet FROM characters WHERE id = ?').get(saved.json().id) as {
            sheet: string;
          }
        ).sheet,
      ).portraitId,
    ).toBe(character.portraitId);
  } finally {
    reopened.close();
  }
});

it('keeps character generation usable without an API key and never sends an image request', async () => {
  const f = await fixture();
  vi.stubEnv('OPENAI_API_KEY', '');
  const response = await f.request();
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    name: 'Captain Mira',
    portraitError: expect.stringContaining('OPENAI_API_KEY'),
  });
  expect(response.json().portraitId).toBeUndefined();
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.game.saveCharacter(f.host.id, response.json()).name).toBe('Captain Mira');
});

it.each([401, 429, 500])(
  'preserves the character and hides provider diagnostics on image HTTP %s',
  async (status) => {
    const f = await fixture();
    f.fetcher.mockResolvedValue(
      Response.json({ error: { message: 'test-portrait-key: private diagnostic' } }, { status }),
    );
    const response = await f.request();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ name: 'Captain Mira', portraitError: expect.any(String) });
    expect(response.json().portraitId).toBeUndefined();
    expect(response.body).not.toContain('test-portrait-key');
    expect(response.body).not.toContain('private diagnostic');
    expect(f.db.prepare('SELECT id FROM character_portraits').all()).toEqual([]);
    expect(f.game.saveCharacter(f.host.id, response.json()).name).toBe('Captain Mira');
  },
);

it('does not store malformed image data or expose network errors', async () => {
  const f = await fixture();
  f.fetcher.mockResolvedValue(
    Response.json({ data: [{ b64_json: Buffer.from('<script>bad</script>').toString('base64') }] }),
  );
  expect((await f.request()).json().portraitId).toBeUndefined();
  f.fetcher.mockRejectedValue(new Error('private diagnostic: test-portrait-key'));
  const response = await f.request();
  expect(response.statusCode).toBe(200);
  expect(response.json().portraitError).toContain('ready to save');
  expect(response.body).not.toContain('test-portrait-key');
  expect(f.db.prepare('SELECT id FROM character_portraits').all()).toEqual([]);
});

it('keeps offline practice free of image requests, even with an API key configured', async () => {
  const f = await fixture('practice');
  const response = await f.request();
  expect(response.statusCode).toBe(200);
  expect(response.json().portraitId).toBeUndefined();
  expect(response.json().portraitError).toBeUndefined();
  expect(f.fetcher).not.toHaveBeenCalled();
});

it('does not make a paid image request after failed character generation', async () => {
  const f = await fixture();
  f.generate.mockRejectedValue(new Error('Text generation failed'));
  expect((await f.request()).statusCode).toBe(500);
  expect(f.fetcher).not.toHaveBeenCalled();
});

it('propagates cancellation into the image request', async () => {
  const controller = new AbortController();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        }),
    ),
  );
  const pending = generatePortrait(templateCharacter(), undefined, controller.signal, 'test-key');
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(vi.mocked(fetch).mock.calls[0][1]!.signal!.aborted).toBe(true);
});

it('adds portrait storage to an existing version 19 database without changing saved characters', async () => {
  const f = await fixture();
  const saved = f.game.saveCharacter(f.host.id, templateCharacter('Existing character'));
  await f.app.close();
  f.db.exec('DROP TABLE character_portraits; PRAGMA user_version = 19;');
  f.db.close();
  const reopened = openDatabase(f.filename);
  try {
    expect(reopened.pragma('user_version', { simple: true })).toBe(22);
    expect(reopened.prepare('SELECT * FROM character_portraits').all()).toEqual([]);
    expect(
      JSON.parse(
        (reopened.prepare('SELECT sheet FROM characters WHERE id = ?').get(saved.id) as { sheet: string })
          .sheet,
      ).name,
    ).toBe('Existing character');
  } finally {
    reopened.close();
  }
});
