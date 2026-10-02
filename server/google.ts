import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import type { DB } from './db';
import Fastify from 'fastify';
import { z } from 'zod';
import { GameError, secretEqual, tokenHash } from './game';

export type GoogleConfig = { clientId: string; clientSecret: string; redirectUri: string };

// Tunnel this listener, not the gameplay server: it exposes only Google's return URL.
export function createGoogleCallbackApp(google: GoogleAuth) {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (_request, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Gather-Service', 'google-callback');
  });
  app.get('/auth/google/callback', async (request, reply) =>
    reply.redirect(await google.callback(z.record(z.string()).parse(request.query))),
  );
  app.setErrorHandler((_error, _request, reply) =>
    reply
      .code(400)
      .send({ error: 'Google sign-in could not finish. Return to Gather Settings and try again.' }),
  );
  return app;
}
type Pending = {
  playerId: string;
  sessionHash: string;
  origin: string;
  returnTo: string;
  browserSecret: string;
  nonce: string;
  verifier: string;
  expires: number;
  phase: 'pending' | 'exchanging' | 'complete';
  identity?: { subject: string; email: string };
  error?: boolean;
};

export class GoogleAuth {
  private pending = new Map<string, Pending>();
  private keys;
  constructor(
    private db: DB,
    readonly config: GoogleConfig,
    private fetcher: typeof fetch = fetch,
  ) {
    const redirect = new URL(config.redirectUri);
    if (
      redirect.pathname !== '/auth/google/callback' ||
      redirect.search ||
      redirect.hash ||
      redirect.username ||
      redirect.password ||
      (redirect.protocol !== 'https:' &&
        !(redirect.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname)))
    )
      throw new Error(
        'GOOGLE_REDIRECT_URI must be an HTTPS URL ending in /auth/google/callback (HTTP is allowed only for localhost).',
      );
    this.keys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), {
      [customFetch]: fetcher,
    });
  }
  status(playerId: string) {
    const account = this.db.prepare('SELECT email FROM google_accounts WHERE player_id = ?').get(playerId) as
      { email: string } | undefined;
    return { configured: true, signedIn: !!account, email: account?.email ?? null };
  }
  begin(playerId: string, sessionToken: string, origin: string, returnTo: string) {
    for (const [state, p] of this.pending)
      if (p.expires <= Date.now() || p.sessionHash === tokenHash(sessionToken)) this.pending.delete(state);
    if (this.pending.size >= 500)
      throw new GameError('Too many sign-ins in progress. Try again shortly.', 429);
    const state = randomBytes(32).toString('base64url');
    const browserSecret = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    this.pending.set(state, {
      playerId,
      sessionHash: tokenHash(sessionToken),
      origin,
      returnTo,
      browserSecret,
      nonce,
      verifier,
      expires: Date.now() + 10 * 60_000,
      phase: 'pending',
    });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: 'openid email',
      state,
      nonce,
      prompt: 'select_account',
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    }).toString();
    return { url: url.toString(), browserSecret };
  }
  private attempt(state?: string) {
    const p = state ? this.pending.get(state) : undefined;
    if (!p || p.expires <= Date.now())
      throw new GameError('Google sign-in expired. Start again from Settings.', 400);
    return p;
  }
  async callback(query: Record<string, string | undefined>) {
    const p = this.attempt(query.state);
    if (p.phase !== 'pending') throw new GameError('This sign-in response was already used.', 400);
    p.phase = 'exchanging';
    try {
      if (query.error || !query.code) throw new Error('Consent declined');
      const response = await this.fetcher('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: query.code,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          redirect_uri: this.config.redirectUri,
          code_verifier: p.verifier,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error('Token exchange failed');
      const body = (await response.json()) as { id_token?: string };
      if (!body.id_token) throw new Error('Missing identity');
      const { payload } = await jwtVerify(body.id_token, this.keys, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: this.config.clientId,
        algorithms: ['RS256'],
        requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
      });
      if (
        payload.nonce !== p.nonce ||
        !payload.sub ||
        typeof payload.email !== 'string' ||
        payload.email_verified !== true
      )
        throw new Error('Identity verification failed');
      p.identity = { subject: payload.sub, email: payload.email };
    } catch {
      p.error = true;
    }
    p.phase = 'complete';
    // Return to the initiating origin to verify its HttpOnly browser cookie before linking anything.
    // This also preserves existing LAN/localhost profiles when Google's callback uses an HTTPS domain.
    return `${p.origin}/auth/google/finish?state=${encodeURIComponent(query.state!)}`;
  }
  finish(state: string, browserSecret?: string) {
    const p = this.attempt(state);
    if (p.phase !== 'complete' || !browserSecret || !secretEqual(p.browserSecret, browserSecret))
      throw new GameError('Complete Google sign-in in the same browser where you started it.', 400);
    this.pending.delete(state);
    const destination = new URL(p.returnTo, p.origin);
    if (p.error || !p.identity) {
      destination.searchParams.set('googleError', '1');
      return { url: destination.toString() };
    }
    const identity = p.identity;
    const token = this.db.transaction(() => {
      const original = this.db.prepare('SELECT player_id FROM sessions WHERE hash = ?').get(p.sessionHash) as
        { player_id: string } | undefined;
      if (original?.player_id !== p.playerId)
        throw new GameError('Your original session ended. Start sign-in again.', 400);
      const existing = this.db
        .prepare('SELECT player_id FROM google_accounts WHERE subject = ?')
        .get(identity.subject) as { player_id: string } | undefined;
      let playerId = existing?.player_id ?? p.playerId;
      if (!existing) {
        // A different Google identity must never inherit a previously linked profile.
        if (this.db.prepare('SELECT 1 FROM google_accounts WHERE player_id = ?').get(playerId)) {
          playerId = randomUUID();
          this.db.prepare('INSERT INTO players(id) VALUES (?)').run(playerId);
        }
        this.db
          .prepare('INSERT INTO google_accounts VALUES (?, ?, ?)')
          .run(identity.subject, playerId, identity.email);
      } else
        this.db
          .prepare('UPDATE google_accounts SET email = ? WHERE subject = ?')
          .run(identity.email, identity.subject);
      const fresh = randomBytes(32).toString('base64url');
      this.db.prepare('INSERT INTO sessions VALUES (?, ?)').run(tokenHash(fresh), playerId);
      this.db.prepare('DELETE FROM sessions WHERE hash = ?').run(p.sessionHash);
      return fresh;
    })();
    return { url: destination.toString(), token };
  }
}
