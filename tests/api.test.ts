import { expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app';
import { openDatabase } from '../server/db';
import { ChatGPTAuth } from '../server/auth';

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
