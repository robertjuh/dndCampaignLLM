import { expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app';
import { openDatabase } from '../server/db';
import { ChatGPTAuth } from '../server/auth';
import { templateCharacter, type Snapshot } from '../shared/schema';

it('rejects cross-origin mutations and keeps display access read-only', async () => {
  const db = openDatabase(':memory:');
  const { app, game } = await createApp({
    db,
    auth: new ChatGPTAuth(mkdtempSync(join(tmpdir(), 'gather-api-'))),
    partyOrigins: ['http://192.0.2.10:3000'],
  });
  try {
    const me = await app.inject({ method: 'GET', url: '/api/me' });
    expect(me.json()).not.toHaveProperty('token');
    const session = me.cookies.find((c) => c.name === 'gather_session')!.value;
    const owner = me.json().id;
    const campaign = game.create(owner, {
      name: 'Test',
      setting: 'Forest',
      premise: '',
      tone: '',
      instructions: '',
      language: 'English',
      custom: [],
      provider: 'practice',
      model: '',
    });
    const evil = await app.inject({
      method: 'POST',
      url: '/api/profile',
      headers: { origin: 'https://evil.example', 'x-gather-request': '1' },
      cookies: { gather_session: session },
      payload: { name: 'Changed' },
    });
    expect(evil.statusCode).toBe(403);
    const noHeader = await app.inject({ method: 'POST', url: '/api/profile', payload: { name: 'Changed' } });
    expect(noHeader.statusCode).toBe(403);
    const stranger = await app.inject({ method: 'GET', url: '/api/me' });
    const strangerSession = stranger.cookies.find((c) => c.name === 'gather_session')!.value;
    const read = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaign.id}`,
      cookies: { gather_session: strangerSession, [`display_${campaign.id}`]: campaign.displayToken! },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).not.toHaveProperty('displayToken');
    expect(read.json().isHost).toBe(false);
    expect(read.json()).not.toHaveProperty('partyOrigins');
    const hostRead = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaign.id}`,
      cookies: { gather_session: session },
    });
    expect(hostRead.json().partyOrigins).toEqual(['http://192.0.2.10:3000']);
    const write = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${campaign.id}/start`,
      headers: { 'x-gather-request': '1' },
      cookies: { gather_session: strangerSession, [`display_${campaign.id}`]: campaign.displayToken! },
      payload: {},
    });
    expect(write.statusCode).toBe(403);
    const exportResult = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaign.id}/export`,
      cookies: { gather_session: session },
    });
    expect(exportResult.statusCode).toBe(200);
    expect(exportResult.body).not.toContain(campaign.displayToken);
    expect(exportResult.body).not.toContain(campaign.inviteCode);
  } finally {
    await app.close();
    db.close();
  }
});

it('lets only the host persist a supported output language between GM generations', async () => {
  const db = openDatabase(':memory:');
  const { app, game } = await createApp({
    db,
    auth: new ChatGPTAuth(mkdtempSync(join(tmpdir(), 'gather-language-api-'))),
  });
  try {
    const host = game.identify();
    const player = game.identify();
    const display = game.identify();
    const campaign = game.create(host.id, {
      name: 'Language table',
      setting: 'Forest',
      premise: '',
      tone: '',
      instructions: 'Keep the mystery alive.',
      language: 'English',
      custom: [],
      provider: 'practice',
      model: '',
    });
    const character = game.saveCharacter(player.id, templateCharacter('Mira'));
    game.join(campaign.inviteCode!, player.id, character.id);
    const member = game.snapshot(campaign.id, player.id).members[0];
    game.manageCharacter(campaign.id, player.id, {
      type: 'starter',
      itemIds: member.state.starterEquipment.slice(0, 2).map((item) => item.id),
    });
    const endpoint = `/api/campaigns/${campaign.id}/language`;
    const change = (payload: Record<string, unknown>, token = host.token!, extraCookies = {}) =>
      app.inject({
        method: 'POST',
        url: endpoint,
        headers: { 'x-gather-request': '1' },
        cookies: { gather_session: token, ...extraCookies },
        payload,
      });
    const updates: Snapshot[] = [];
    game.subscribe(campaign.id, () => updates.push(game.snapshot(campaign.id, player.id)));
    const before = game.snapshot(campaign.id, host.id);

    for (const payload of [
      { language: 'French' },
      { language: 'nl' },
      {},
      { language: 'Nederlands', extra: true },
    ])
      expect((await change(payload)).statusCode).toBe(400);
    expect((await change({ language: 'Nederlands' }, player.token!)).statusCode).toBe(403);
    expect(
      (
        await change({ language: 'Nederlands' }, display.token!, {
          [`display_${campaign.id}`]: campaign.displayToken!,
        })
      ).statusCode,
    ).toBe(403);
    expect(game.snapshot(campaign.id, host.id).config).toEqual(before.config);
    expect(updates).toEqual([]);

    const changed = await change({ language: 'Nederlands' });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().config).toEqual({ ...before.config, language: 'Nederlands' });
    expect(changed.json().version).toBe(before.version + 1);
    expect(JSON.parse(game.campaign(campaign.id).config).language).toBe('Nederlands');
    expect(updates).toHaveLength(1);
    expect(updates[0].config.language).toBe('Nederlands');
    const read = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaign.id}`,
      cookies: { gather_session: player.token! },
    });
    expect(read.json().config.language).toBe('Nederlands');

    game.start(campaign.id, host.id);
    await game.idle();
    const collecting = game.snapshot(campaign.id, host.id);
    expect(collecting.turn?.phase).toBe('collecting');
    expect((await change({ language: 'English' })).statusCode).toBe(200);
    expect(game.snapshot(campaign.id, host.id).history).toEqual(collecting.history);

    for (const phase of ['queued', 'resolving']) {
      db.prepare('UPDATE turns SET phase = ? WHERE id = ?').run(phase, collecting.turn!.id);
      const version = game.snapshot(campaign.id, host.id).version;
      const updateCount = updates.length;
      expect((await change({ language: 'Nederlands' })).statusCode).toBe(409);
      expect(game.snapshot(campaign.id, host.id).version).toBe(version);
      expect(game.snapshot(campaign.id, host.id).config.language).toBe('English');
      expect(updates).toHaveLength(updateCount);
    }
    db.prepare("UPDATE turns SET phase = 'failed' WHERE id = ?").run(collecting.turn!.id);
    expect((await change({ language: 'Nederlands' })).statusCode).toBe(200);
    expect(game.snapshot(campaign.id, host.id).history).toEqual(collecting.history);
    expect(game.snapshot(campaign.id, host.id).turn?.phase).toBe('failed');
  } finally {
    await app.close();
    db.close();
  }
});
