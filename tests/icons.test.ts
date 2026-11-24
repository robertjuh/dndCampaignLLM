import { afterEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/db';
import { LocalIcons } from '../server/icons';
import { createApp } from '../server/app';
import { PracticeGM } from '../server/providers';
import type { ChatGPTAuth } from '../server/auth';
import {
  abilitySchema,
  campaignSchema,
  templateCharacter,
  type Character,
  type Snapshot,
} from '../shared/schema';
import { baseItem } from '../shared/rules';
import { modelSchema } from '../server/model-schema';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAAA+UlEQVR4nO3RQQ0AIAzAwGnBE+Jwi4w9ekkFNLl592ixWT+IBwBAOwAA2gEA0A4AgHYAALQDAKAdAADtAABoBwBAOwAA2gEA0A4AgHYAALQDAKAdAADtAABoBwBAOwAA2gEA0A4AgHYAALQDAKAdAADtAABoBwBAOwAA2gEA0A4AgHYAALQDAKAdAADtAABoBwBAOwAA2gEA0A4AgHYAALQDAKAdAADtAABoBwBAOwAA2gEA0A4AgHYAALQDAKAdAADtAABoBwBAOwAA2gEA0A4AgHYAALQDAKAdAADtAABoBwBAOwAA2gEA0A4AgHYAALQDAKAdAADtPhfCA/1UaQlNAAAAAElFTkSuQmCC',
  'base64',
);
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('generates each distinct icon once, serializes GPU work, and reuses saved PNGs after a restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gather-icons-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'icons.sqlite');
  const db = openDatabase(filename);
  cleanup.push(() => {
    if (db.open) db.close();
  });
  const icons = new LocalIcons(db, 'http://127.0.0.1:7861');
  cleanup.push(() => icons.close());
  const character = icons.attach(templateCharacter('Icon tester'));
  const ability = character.abilities[0];
  const item = character.equipmentOptions[0];
  expect(ability.iconId).toBeTruthy();
  expect(icons.attach({ ...item, id: 'transferred-item' }).iconId).toBe(item.iconId);
  let active = 0;
  let peak = 0;
  const fetcher = vi.fn(async () => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  });
  vi.stubGlobal('fetch', fetcher);
  const results = await Promise.all([
    icons.image(ability.iconId!),
    icons.image(ability.iconId!),
    icons.image(item.iconId!),
  ]);
  expect(results).toEqual([png, png, png]);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(peak).toBe(1);
  const [url, init] = vi.mocked(fetch).mock.calls[0];
  expect(url).toBe('http://127.0.0.1:7861/generate');
  expect(JSON.parse(init!.body as string)).toMatchObject({
    name: ability.name,
    kind: ability.kind,
    seed: expect.any(Number),
    ability: {
      effect: ability.effect,
      targeting: ability.targeting ?? 'single',
      inflicts: ability.inflicts ?? null,
      cures: ability.cures ?? [],
    },
  });
  expect(init!.headers).toMatchObject({ 'X-Gather-Icons': '1' });
  await icons.close();
  db.close();
  const reopened = openDatabase(filename);
  cleanup.push(() => {
    reopened.close();
  });
  const cached = new LocalIcons(reopened, '');
  expect(await cached.image(ability.iconId!)).toEqual(png);
  expect(await cached.image(randomUUID())).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('adds icons to generated drafts, new loot and equipment abilities without delaying or changing game state', async () => {
  vi.stubEnv('GATHER_ICON_URL', 'http://127.0.0.1:7861');
  const fetcher = vi.fn(async () => new Response(png, { headers: { 'Content-Type': 'image/png' } }));
  vi.stubGlobal('fetch', fetcher);
  const db = openDatabase(':memory:');
  cleanup.push(() => {
    db.close();
  });
  const gm = new PracticeGM();
  const { app, game } = await createApp({ db, auth: {} as ChatGPTAuth, providers: () => gm });
  cleanup.push(() => app.close());
  const host = game.identify();
  const cookies = { gather_session: host.token! };
  const headers = { 'x-gather-request': '1' };
  const campaign = game.create(host.id, {
    name: 'Icon campaign',
    setting: 'Clockwork islands',
    premise: '',
    tone: '',
    language: 'English',
    instructions: '',
    custom: [],
    provider: 'practice',
  });
  const generated = await app.inject({
    method: 'POST',
    url: '/api/characters/generate',
    cookies,
    headers,
    payload: { concept: 'Clockwork explorer', campaignId: campaign.id },
  });
  expect(generated.statusCode, generated.body).toBe(200);
  const character: Character = generated.json();
  expect(character.abilityOptions?.every((ability) => ability.iconId)).toBe(true);
  expect(character.equipmentOptions.every((item) => item.iconId)).toBe(true);
  const generatedItem = db
    .prepare('SELECT subject FROM generated_icons WHERE id = ?')
    .get(character.equipmentOptions[0].iconId) as { subject: string };
  expect(JSON.parse(generatedItem.subject).theme).toContain('Clockwork islands');
  expect(fetcher).not.toHaveBeenCalled();
  const sheet = templateCharacter('Saved explorer');
  const saved = game.saveCharacter(host.id, sheet);
  game.join(campaign.inviteCode!, host.id, saved.id);
  const before = game.members(campaign.id)[0];
  const state = game.snapshot(campaign.id, host.id).scene;
  state.loot.push({
    ...baseItem('new-loot', 'Moonsteel blade', 'weapon'),
    rarity: 'Legendary',
    grantedAbility: { ...sheet.abilities[0], name: 'Moonbeam strike' },
    quantity: 1,
  });
  db.prepare('UPDATE campaigns SET scene = ? WHERE id = ?').run(JSON.stringify(state), campaign.id);
  const response = await app.inject({ url: `/api/campaigns/${campaign.id}`, cookies });
  const snapshot: Snapshot = response.json();
  expect(snapshot.members[0].character.abilities.every((ability) => ability.iconId)).toBe(true);
  const loot = snapshot.scene.loot.find((item) => item.id === 'new-loot')!;
  expect(loot.iconId).toBeTruthy();
  expect(loot.grantedAbility?.iconId).toBeTruthy();
  expect(game.members(campaign.id)[0]).toEqual(before);
  const image = await app.inject(`/api/icons/${loot.iconId}`);
  expect(image.statusCode, image.body).toBe(200);
  expect(image.headers['cache-control']).toContain('immutable');
  expect(image.headers['content-type']).toBe('image/png');
  expect(image.rawPayload).toEqual(png);
  expect((await app.inject(`/api/icons/${loot.iconId}`)).rawPayload).toEqual(png);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).theme).toContain('Clockwork islands');
  expect((await app.inject('/api/icons/not-an-id')).statusCode).toBe(400);
  expect((await app.inject(`/api/icons/${randomUUID()}`)).statusCode).toBe(404);
  expect(modelSchema(abilitySchema).properties).not.toHaveProperty('iconId');
});

it('falls back safely when disabled, unavailable, or receiving malformed images', async () => {
  const db = openDatabase(':memory:');
  cleanup.push(() => {
    db.close();
  });
  const disabled = new LocalIcons(db, '');
  expect(disabled.attach(templateCharacter()).abilities[0].iconId).toBeUndefined();
  expect(db.prepare('SELECT id FROM generated_icons').all()).toHaveLength(0);
  expect(() => new LocalIcons(db, 'https://example.com')).toThrow('on this computer');
  const icons = new LocalIcons(db, 'http://127.0.0.1:7861');
  cleanup.push(() => icons.close());
  const id = icons.attach(templateCharacter()).abilities[0].iconId!;
  const fetcher = vi.fn(
    async () => new Response('<script>bad</script>', { headers: { 'Content-Type': 'image/png' } }),
  );
  vi.stubGlobal('fetch', fetcher);
  await expect(icons.image(id)).rejects.toThrow('invalid icon');
  fetcher.mockResolvedValue(new Response('private diagnostic', { status: 500 }));
  await expect(icons.image(id)).rejects.toThrow('unavailable');
  expect(db.prepare('SELECT image FROM generated_icons WHERE id = ?').get(id)).toEqual({ image: null });
  fetcher.mockResolvedValue(new Response(png, { headers: { 'Content-Type': 'image/png' } }));
  expect(await icons.image(id)).toEqual(png);
});

it('migrates an existing database without rewriting saved characters', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gather-icon-migration-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'test.sqlite');
  const db = openDatabase(filename);
  const original = JSON.stringify(templateCharacter('Existing explorer'));
  const owner = randomUUID();
  db.prepare('INSERT INTO players(id) VALUES(?)').run(owner);
  db.prepare('INSERT INTO characters(id, owner_id, sheet) VALUES(?, ?, ?)').run(
    randomUUID(),
    owner,
    original,
  );
  db.exec('DROP TABLE generated_icons; PRAGMA user_version = 26;');
  db.close();
  const migrated = openDatabase(filename);
  cleanup.push(() => {
    migrated.close();
  });
  expect(migrated.pragma('user_version', { simple: true })).toBe(29);
  expect(migrated.prepare('SELECT sheet FROM characters').get()).toEqual({ sheet: original });
  expect(migrated.prepare('SELECT * FROM generated_icons').all()).toEqual([]);
});

it('upgrades the icon profile while preserving previously saved image URLs', async () => {
  const db = openDatabase(':memory:');
  cleanup.push(() => {
    db.close();
  });
  const ability = templateCharacter().abilities[0];
  const subject = JSON.stringify({
    name: ability.name,
    kind: ability.kind,
    description: ability.description,
    theme: '',
  });
  const oldId = randomUUID();
  const oldKey = createHash('sha256')
    .update('context-rpg-icon-sdxl-lightning-single-4step-v5\n' + subject)
    .digest('hex');
  db.prepare('INSERT INTO generated_icons(id, key, subject, image) VALUES(?, ?, ?, ?)').run(
    oldId,
    oldKey,
    subject,
    png,
  );
  const icons = new LocalIcons(db, 'http://127.0.0.1:7861');
  cleanup.push(() => icons.close());
  const upgraded = icons.attach({ ...ability, iconId: oldId });
  expect(upgraded.iconId).not.toBe(oldId);
  expect(await icons.image(oldId)).toEqual(png);
  expect(db.prepare('SELECT image FROM generated_icons WHERE id = ?').get(upgraded.iconId)).toEqual({
    image: null,
  });
});

it('separates campaign item styles and character ability themes, including gear, replacements and library reloads', () => {
  const db = openDatabase(':memory:');
  cleanup.push(() => {
    db.close();
  });
  const icons = new LocalIcons(db, 'http://127.0.0.1:7861');
  const campaign = (setting: string) =>
    campaignSchema.parse({
      name: 'Visual context',
      setting,
      tone: 'Moody painterly illustration',
      premise: '',
      instructions: '',
      language: 'English',
      provider: 'practice',
      custom: [{ key: 'Materials', value: 'Copper and blue glass' }],
    });
  const forest = campaign('Ancient enchanted forest, carved wood and living vines');
  const space = campaign('Futuristic space station, neon circuitry and chrome');
  const wizard = templateCharacter('Shared name', 'Human');
  wizard.concept = 'A fire mage in crimson robes';
  wizard.appearance = 'Burning runes and red silk gloves';
  const robot = structuredClone(wizard);
  robot.concept = 'A frost-powered mechanical guardian';
  robot.appearance = 'Blue ice crystals and steel claws';
  const first = icons.attach(structuredClone(wizard), { campaign: forest });
  const otherWorld = icons.attach(structuredClone(wizard), { campaign: space });
  const otherCharacter = icons.attach(structuredClone(robot), { campaign: forest });
  expect(first.equipmentOptions[0].iconId).not.toBe(otherWorld.equipmentOptions[0].iconId);
  expect(first.equipmentOptions[0].iconId).toBe(otherCharacter.equipmentOptions[0].iconId);
  expect(first.abilities[0].iconId).not.toBe(otherCharacter.abilities[0].iconId);
  expect(first.abilities[0].iconId).toBe(otherWorld.abilities[0].iconId);
  const subject = (id: string) =>
    JSON.parse(
      (db.prepare('SELECT subject FROM generated_icons WHERE id = ?').get(id) as { subject: string }).subject,
    );
  expect(subject(first.equipmentOptions[0].iconId!).theme).toContain('Ancient enchanted forest');
  expect(subject(first.equipmentOptions[0].iconId!).theme).toContain('Moody painterly');
  expect(subject(first.equipmentOptions[0].iconId!).theme).toContain('Copper and blue glass');
  expect(subject(first.abilities[0].iconId!).theme).toContain('fire mage');
  expect(subject(first.abilities[0].iconId!).theme).toContain('red silk gloves');
  // The library has no active campaign; reuse the style stored with the generated icon.
  const reloaded = icons.attach(JSON.parse(JSON.stringify(first)) as Character);
  expect(reloaded.equipmentOptions[0].iconId).toBe(first.equipmentOptions[0].iconId);
  const gear = { ...baseItem('theme-gear', 'Shared relic', 'relic'), grantedAbility: wizard.abilities[0] };
  const snapshot = icons.attach({
    config: forest,
    members: [
      { character: wizard, state: { inventory: [structuredClone(gear)] }, replacement: { character: robot } },
      { character: robot, state: { inventory: [structuredClone(gear)] } },
    ],
    scene: { loot: [structuredClone(gear)] },
  });
  const [firstMember, secondMember] = snapshot.members;
  expect(firstMember.state.inventory[0].iconId).toBe(secondMember.state.inventory[0].iconId);
  expect(subject(firstMember.state.inventory[0].grantedAbility.iconId!).theme).toContain('fire mage');
  expect(subject(secondMember.state.inventory[0].grantedAbility.iconId!).theme).toContain('frost-powered');
  expect(subject(firstMember.replacement!.character.abilities[0].iconId!).theme).toContain('frost-powered');
  expect(subject(snapshot.scene.loot[0].iconId!).theme).toContain('Ancient enchanted forest');
});
