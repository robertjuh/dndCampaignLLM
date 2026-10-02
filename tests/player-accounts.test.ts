import { expect, it } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleAuth, createGoogleCallbackApp } from '../server/google';
import { ChatGPTAuth } from '../server/auth';
import { openDatabase } from '../server/db';
import { createApp } from '../server/app';
import { templateCharacter } from '../shared/schema';

it('links existing characters, restores the same profile on another origin, and prevents account takeover/replay', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gather-google-'));
  const db = openDatabase(join(directory, 'test.sqlite'));
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  let nonce = '',
    subject = 'google-one',
    audience = 'test-client';
  const google = new GoogleAuth(
    db,
    {
      clientId: 'test-client',
      clientSecret: 'secret',
      redirectUri: 'https://gather.example/auth/google/callback',
    },
    async (url, init) => {
      if (String(url).endsWith('/certs')) return Response.json({ keys: [jwk] });
      expect(String(url)).toBe('https://oauth2.googleapis.com/token');
      const params = new URLSearchParams(String(init?.body));
      expect(params.get('client_secret')).toBe('secret');
      expect(params.get('code_verifier')).toBeTruthy();
      return Response.json({
        id_token: await new SignJWT({ nonce, email: 'same@example.test', email_verified: true })
          .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
          .setSubject(subject)
          .setAudience(audience)
          .setIssuer('https://accounts.google.com')
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey),
      });
    },
  );
  const { app, game } = await createApp({
    db,
    google,
    auth: new ChatGPTAuth(directory),
    partyOrigins: ['http://192.168.1.20:3000'],
  });
  const callbackApp = createGoogleCallbackApp(google);
  const origin = 'http://192.168.1.20:3000';
  const post = (url: string, token: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url,
      payload: JSON.stringify(payload),
      headers: {
        host: new URL(origin).host,
        origin,
        'x-gather-request': '1',
        'content-type': 'application/json',
        cookie: `gather_session=${token}`,
      },
    });
  async function begin(token: string) {
    const response = await post('/api/player-auth/google', token, { returnTo: '/characters' });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('secret');
    const url = new URL(response.json().url);
    nonce = url.searchParams.get('nonce')!;
    return {
      state: url.searchParams.get('state')!,
      cookie: response.cookies.find((c) => c.name === 'gather_google_state')!.value,
    };
  }
  async function callback(state: string) {
    return callbackApp.inject({
      url: `/auth/google/callback?state=${state}&code=test-code`,
      headers: { host: 'gather.example' },
    });
  }
  async function finish(state: string, cookie: string) {
    return app.inject({
      url: `/auth/google/finish?state=${state}`,
      headers: { host: new URL(origin).host, cookie: `gather_google_state=${cookie}` },
    });
  }
  try {
    expect((await callbackApp.inject('/')).headers['x-gather-service']).toBe('google-callback');
    expect((await callbackApp.inject('/api/me')).statusCode).toBe(404);
    expect((await callbackApp.inject('/api/chatgpt')).statusCode).toBe(404);
    expect((await callbackApp.inject('/auth/google/finish?state=anything')).statusCode).toBe(404);
    const first = game.identify();
    const saved = game.saveCharacter(first.id, templateCharacter('Existing phone character'));
    const flow = await begin(first.token!);
    const result = await callback(flow.state);
    expect(result.headers.location).toBe(`${origin}/auth/google/finish?state=${flow.state}`);
    expect(db.prepare('SELECT * FROM google_accounts').all()).toHaveLength(0);
    expect((await finish(flow.state, 'wrong-browser')).statusCode).toBe(400);
    const done = await finish(flow.state, flow.cookie);
    expect(done.headers.location).toBe(`${origin}/characters`);
    const signedToken = done.cookies.find((c) => c.name === 'gather_session')!.value;
    expect(game.identify(signedToken).id).toBe(first.id);
    expect(game.characters(first.id)[0].id).toBe(saved.id);
    expect((await finish(flow.state, flow.cookie)).statusCode).toBe(400);
    expect((await callback(flow.state)).statusCode).toBe(400);

    // A fresh browser recovers the first profile, never merges unrelated local data.
    const second = game.identify();
    game.saveCharacter(second.id, templateCharacter('Unrelated draft'));
    const secondFlow = await begin(second.token!);
    await callback(secondFlow.state);
    const secondDone = await finish(secondFlow.state, secondFlow.cookie);
    const secondToken = secondDone.cookies.find((c) => c.name === 'gather_session')!.value;
    expect(game.identify(secondToken).id).toBe(first.id);
    expect(game.characters(first.id)).toHaveLength(1);
    expect(game.characters(second.id)).toHaveLength(1);
    expect(
      (await post(`/api/characters/${saved.id}`, game.identify().token!, templateCharacter('Stolen')))
        .statusCode,
    ).toBe(404);

    // A different Google subject, even with the same email, cannot inherit this profile.
    subject = 'google-two';
    const other = await begin(secondToken);
    await callback(other.state);
    const otherDone = await finish(other.state, other.cookie);
    const otherToken = otherDone.cookies.find((c) => c.name === 'gather_session')!.value;
    const otherId = game.identify(otherToken).id;
    expect(otherId).not.toBe(first.id);
    expect(game.characters(otherId)).toEqual([]);
    expect(google.status(first.id).signedIn).toBe(true);

    // Wrong audience/nonce and declined consent never bind identities or replace sessions.
    for (const failure of ['audience', 'nonce', 'declined']) {
      const before = db.prepare('SELECT COUNT(*) AS n FROM google_accounts').get();
      const bad = await begin(otherToken);
      if (failure === 'audience') audience = 'wrong-client';
      if (failure === 'nonce') nonce = 'wrong-nonce';
      if (failure === 'declined')
        await app.inject({ url: `/auth/google/callback?state=${bad.state}&error=access_denied` });
      else await callback(bad.state);
      const denied = await finish(bad.state, bad.cookie);
      expect(denied.headers.location).toBe(`${origin}/characters?googleError=1`);
      expect(denied.cookies.some((c) => c.name === 'gather_session')).toBe(false);
      expect(db.prepare('SELECT COUNT(*) AS n FROM google_accounts').get()).toEqual(before);
      audience = 'test-client';
    }
    expect(
      (await post('/api/player-auth/google', otherToken, { returnTo: '//evil.example' })).statusCode,
    ).toBe(400);
    await post('/api/player-auth/logout', otherToken, {});
    expect(game.identify(otherToken).id).not.toBe(otherId);
    expect(game.characters(first.id)[0].id).toBe(saved.id);
    await app.close();
    db.close();
    const reopened = openDatabase(join(directory, 'test.sqlite'));
    expect(
      reopened.prepare('SELECT player_id FROM google_accounts WHERE subject = ?').get('google-one'),
    ).toEqual({ player_id: first.id });
    reopened.close();
  } finally {
    await callbackApp.close();
    await app.close();
    if (db.open) db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
