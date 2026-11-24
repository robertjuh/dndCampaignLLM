import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app';
import type { ChatGPTAuth } from '../server/auth';
import { openDatabase } from '../server/db';
import { PracticeGM } from '../server/providers';
import { templateCharacter, type Character, type Snapshot } from '../shared/schema';

// Only the PNG envelope is relevant to the local HTTP/storage contract.
const image = Buffer.alloc(24);
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image);
image.writeUInt32BE(512, 16);
image.writeUInt32BE(512, 20);
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function fixture() {
  vi.stubEnv('GATHER_ICON_URL', 'http://127.0.0.1:7861');
  vi.stubEnv('OPENAI_API_KEY', '');
  const fetcher = vi.fn(async () => new Response(image, { headers: { 'Content-Type': 'image/png' } }));
  vi.stubGlobal('fetch', fetcher);
  const db = openDatabase(':memory:');
  cleanup.push(() => { db.close(); });
  const sheet = templateCharacter('Mira', 'Clockwork moth');
  sheet.appearance = 'Brass antennae and large blue glass eyes.';
  sheet.selectedEquipmentIds = sheet.equipmentOptions.slice(0, 3).map((item) => item.id);
  const gm = new PracticeGM();
  const generate = vi.spyOn(gm, 'generate').mockImplementation(async () => structuredClone(sheet));
  const { app, game } = await createApp({ db, auth: {} as ChatGPTAuth, providers: () => gm });
  cleanup.push(() => app.close());
  const host = game.identify();
  const campaign = game.create(host.id, {
    name: 'Star travellers', setting: 'An orbital station', premise: '', tone: 'Hopeful science fiction',
    language: 'English', instructions: '', custom: [], provider: 'practice',
  });
  const cookies = { gather_session: host.token! };
  const request = () => app.inject({
    method: 'POST', url: '/api/characters/generate', cookies,
    headers: { 'x-gather-request': '1' },
    payload: { concept: 'A curious clockwork moth', name: 'Captain Mira', campaignId: campaign.id },
  });
  return { app, db, game, host, campaign, cookies, request, fetcher, generate };
}

it('returns character text immediately and generates a cached local portrait when requested', async () => {
  const f = await fixture();
  const response = await f.request();
  expect(response.statusCode, response.body).toBe(200);
  const character: Character = response.json();
  expect(character.portraitId).toMatch(/^[a-f0-9-]{36}$/);
  expect(character.portraitError).toBeUndefined();
  expect(f.fetcher).not.toHaveBeenCalled();
  const portrait = await f.app.inject(`/api/portraits/${character.portraitId}`);
  expect(portrait.statusCode, portrait.body).toBe(200);
  expect(portrait.headers['content-type']).toBe('image/png');
  expect(portrait.headers['cache-control']).toContain('immutable');
  expect(portrait.rawPayload).toEqual(image);
  const [url, init] = vi.mocked(fetch).mock.calls[0];
  expect(url).toBe('http://127.0.0.1:7861/generate');
  expect(init!.headers).toMatchObject({ 'X-Gather-Icons': '1' });
  expect(init!.headers).not.toHaveProperty('Authorization');
  expect(JSON.parse(init!.body as string)).toMatchObject({
    kind: 'portrait', name: 'Captain Mira', description: expect.stringContaining('Brass antennae'),
    theme: expect.stringContaining('An orbital station'),
  });
  expect((await f.app.inject(`/api/portraits/${character.portraitId}`)).rawPayload).toEqual(image);
  const saved = f.game.saveCharacter(f.host.id, character);
  f.game.join(f.campaign.inviteCode!, f.host.id, saved.id);
  const snapshot = (await f.app.inject({ url: `/api/campaigns/${f.campaign.id}`, cookies: f.cookies })).json<Snapshot>();
  expect(snapshot.members[0].character.portraitId).toBe(character.portraitId);
  expect(f.fetcher).toHaveBeenCalledOnce();
});

it('preserves existing JPEG portraits and assigns portraits to missing library characters', async () => {
  const f = await fixture();
  const id = randomUUID();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  f.db.prepare('INSERT INTO character_portraits(id, image) VALUES(?, ?)').run(id, jpeg);
  f.game.saveCharacter(f.host.id, { ...templateCharacter('Existing portrait'), portraitId: id });
  f.game.saveCharacter(f.host.id, templateCharacter('Missing portrait'));
  const response = await f.app.inject({ url: '/api/me', cookies: f.cookies });
  const characters = response.json().characters as Character[];
  expect(characters.find((person) => person.name === 'Existing portrait')?.portraitId).toBe(id);
  expect(characters.find((person) => person.name === 'Missing portrait')?.portraitId).toBeTruthy();
  const portrait = await f.app.inject(`/api/portraits/${id}`);
  expect(portrait.headers['content-type']).toBe('image/jpeg');
  expect(portrait.rawPayload).toEqual(jpeg);
  expect(f.fetcher).not.toHaveBeenCalled();
  expect((await f.app.inject('/api/portraits/invalid-id')).statusCode).toBe(400);
  expect((await f.app.inject(`/api/portraits/${randomUUID()}`)).statusCode).toBe(404);
});

it('keeps character text usable when local images are disabled or generation fails', async () => {
  const f = await fixture();
  const character: Character = (await f.request()).json();
  f.fetcher.mockResolvedValue(new Response('private diagnostic', { status: 503 }));
  const failed = await f.app.inject(`/api/portraits/${character.portraitId}`);
  expect(failed.statusCode).toBe(503);
  expect(failed.body).not.toContain('private diagnostic');
  f.fetcher.mockResolvedValue(new Response('<script>bad</script>', { headers: { 'Content-Type': 'image/png' } }));
  expect((await f.app.inject(`/api/portraits/${character.portraitId}`)).statusCode).toBe(503);
  expect(f.game.saveCharacter(f.host.id, character).name).toBe('Captain Mira');
  f.generate.mockRejectedValue(new Error('Text generation failed'));
  const before = f.fetcher.mock.calls.length;
  expect((await f.request()).statusCode).toBe(500);
  expect(f.fetcher).toHaveBeenCalledTimes(before);
  await f.app.close();
  vi.stubEnv('GATHER_ICON_URL', '');
  const { app } = await createApp({ db: f.db, auth: {} as ChatGPTAuth, providers: () => new PracticeGM() });
  cleanup.push(() => app.close());
  const existing = (await app.inject({ url: '/api/me', cookies: f.cookies })).json().characters as Character[];
  expect(existing.find((person) => person.name === 'Captain Mira')?.portraitId).toBe(character.portraitId);
});

it('adds one stable portrait per public NPC, shared across journal aliases and updates', async () => {
  const f = await fixture();
  const scene = f.game.snapshot(f.campaign.id, f.host.id).scene;
  scene.npcs = {
    keeper: { id: 'keeper', name: 'Sable', aliases: ['The keeper'], locationId: scene.location.id!,
      status: 'alive', allegiance: null, fact: 'Private background that is not a portrait source.' },
    hidden: { id: 'hidden', name: 'Unseen stranger', aliases: [], locationId: null,
      status: 'alive', allegiance: null, fact: 'Secret identity.' },
  };
  f.db.prepare('UPDATE campaigns SET scene = ? WHERE id = ?').run(JSON.stringify(scene), f.campaign.id);
  for (const name of ['Sable', 'The keeper'])
    f.db.prepare('INSERT INTO journal(campaign_id, kind, name, detail) VALUES(?, ?, ?, ?)')
      .run(f.campaign.id, 'npc', name, 'A silver-haired keeper with amber eyes and a blue coat.');
  const snapshot = () => f.app.inject({ url: `/api/campaigns/${f.campaign.id}`, cookies: f.cookies });
  const first = (await snapshot()).json<Snapshot>();
  expect(first.journal[0].portraitId).toBeTruthy();
  expect(first.journal[1].portraitId).toBe(first.journal[0].portraitId);
  expect(f.db.prepare('SELECT id FROM generated_icons').all()).toHaveLength(1);
  expect(f.fetcher).not.toHaveBeenCalled();
  const portrait = await f.app.inject(`/api/portraits/${first.journal[0].portraitId}`);
  expect(portrait.statusCode, portrait.body).toBe(200);
  const subject = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
  expect(subject.description).toContain('silver-haired');
  expect(subject.description).not.toContain('Private background');
  expect(subject.description).not.toContain('Secret identity');
  f.db.prepare('UPDATE journal SET detail = ? WHERE campaign_id = ?').run('Later conversation.', f.campaign.id);
  const later = (await snapshot()).json<Snapshot>();
  expect(later.journal.every((entry) => entry.portraitId === first.journal[0].portraitId)).toBe(true);
  expect((await f.app.inject(`/api/portraits/${later.journal[0].portraitId}`)).rawPayload).toEqual(image);
  expect(f.fetcher).toHaveBeenCalledOnce();
});
