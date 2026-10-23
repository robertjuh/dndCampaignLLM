import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInviteCode, openDatabase } from '../server/db';
import { Game } from '../server/game';
import { PracticeGM } from '../server/providers';
import { createApp } from '../server/app';
import { ChatGPTAuth } from '../server/auth';
import { templateCharacter } from '../shared/schema';

const config = {
  name: 'An easy table to join',
  setting: 'A quiet forest',
  premise: '',
  tone: '',
  language: 'English',
  instructions: '',
  custom: [],
  provider: 'practice',
};

it('retries an occupied code and allocates four readable characters', () => {
  const db = openDatabase(':memory:');
  try {
    const occupied = db.prepare('SELECT 1 FROM campaigns WHERE code = ?');
    const lookup = vi.spyOn(occupied, 'get').mockReturnValueOnce({ exists: true });
    const prepare = vi.spyOn(db, 'prepare').mockReturnValueOnce(occupied);
    expect(createInviteCode(db)).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
    expect(lookup).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledTimes(2);
  } finally {
    vi.restoreAllMocks();
    db.close();
  }
});

it('gives existing campaigns stable short codes while preserving old invitations and player state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gather-invite-migration-'));
  const filename = join(directory, 'test.sqlite');
  let db = openDatabase(filename);
  try {
    let game = new Game(db, () => new PracticeGM());
    const host = game.identify();
    const campaign = game.create(host.id, config);
    const player = game.identify();
    const character = game.saveCharacter(player.id, templateCharacter('Mira'));
    game.join(campaign.inviteCode!, player.id, character.id);
    const members = game.members(campaign.id);
    const legacyCode = 'B010FC976768';
    db.prepare('UPDATE campaigns SET code = ? WHERE id = ?').run(legacyCode, campaign.id);
    db.exec(`DROP INDEX campaign_legacy_code;
      ALTER TABLE campaigns DROP COLUMN legacy_code;
      PRAGMA user_version = 17;`);
    db.close();

    db = openDatabase(filename);
    game = new Game(db, () => new PracticeGM());
    const shortCode = game.snapshot(campaign.id, host.id).inviteCode!;
    expect(shortCode).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
    expect(game.invite(shortCode.toLowerCase()).id).toBe(campaign.id);
    expect(game.invite(legacyCode.toLowerCase()).id).toBe(campaign.id);
    expect(game.members(campaign.id)).toEqual(members);
    db.close();

    db = openDatabase(filename);
    game = new Game(db, () => new PracticeGM());
    expect(game.snapshot(campaign.id, host.id).inviteCode).toBe(shortCode);
    expect(game.invite(legacyCode).id).toBe(campaign.id);
    db.prepare("UPDATE campaigns SET status = 'archived' WHERE id = ?").run(campaign.id);
    expect(() => game.invite(shortCode)).toThrow('not available');
    expect(() => game.invite(legacyCode)).toThrow('not available');
  } finally {
    if (db.open) db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('accepts short and legacy invitations through the API and rejects malformed codes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gather-invite-api-'));
  const db = openDatabase(':memory:');
  const { app, game } = await createApp({
    db,
    auth: new ChatGPTAuth(directory),
    partyOrigins: ['http://g'],
  });
  try {
    for (const [host, expected] of [
      ['g', true],
      ['127.0.0.1:3000', false],
      ['other', false],
    ] as const) {
      const profile = await app.inject({ url: '/api/me', headers: { host } });
      expect(profile.statusCode).toBe(200);
      expect(profile.json().joinAtRoot).toBe(expected);
    }
    const host = game.identify();
    const campaign = game.create(host.id, config);
    const legacyCode = 'A123456789BC';
    db.prepare('UPDATE campaigns SET legacy_code = ? WHERE id = ?').run(legacyCode, campaign.id);
    const player = game.identify();
    const character = game.saveCharacter(player.id, templateCharacter('Mira'));
    for (const code of [campaign.inviteCode!.toLowerCase(), legacyCode.toLowerCase()]) {
      const invite = await app.inject(`/api/invites/${code}`);
      expect(invite.statusCode).toBe(200);
      expect(invite.json().id).toBe(campaign.id);
      const joined = await app.inject({
        method: 'POST',
        url: '/api/join',
        headers: { 'x-gather-request': '1' },
        cookies: { gather_session: player.token! },
        payload: { code, playerName: 'Mira player', characterId: character.id },
      });
      expect(joined.statusCode).toBe(200);
      expect(joined.json().members).toHaveLength(1);
    }
    for (const code of ['ABC', 'ABCDE', 'A!BC', '0123456789ABC'])
      expect((await app.inject(`/api/invites/${code}`)).statusCode).toBe(400);
  } finally {
    await app.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
