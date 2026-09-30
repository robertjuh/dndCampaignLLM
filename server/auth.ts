import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import { GameError, secretEqual } from './game';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const tokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  id_token: z.string().optional(),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
  token_type: z.string(),
});
type Tokens = z.infer<typeof tokenSchema>;
type Account = {
  clientId: string;
  subject: string;
  email: string;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expires: number;
  scopes: string[];
};
type Store = { hostId: string; accounts: Record<string, Account> };
type Pending = {
  owner: string;
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  clientId?: string;
  subject?: string;
  expires: number;
};

export class ChatGPTAuth {
  private store: Store;
  private pending = new Map<string, Pending>();
  private refreshing = new Map<string, Promise<string>>();
  private filename: string;
  constructor(
    directory: string,
    private fetcher: typeof fetch = fetch,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.filename = join(directory, 'chatgpt.json');
    try {
      this.store = JSON.parse(readFileSync(this.filename, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('Could not read the ChatGPT credential store.');
      this.store = { hostId: `urn:uuid:${randomUUID()}`, accounts: {} };
      this.save();
    }
  }
  private save() {
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.store), { mode: 0o600 });
    renameSync(temporary, this.filename);
  }
  status(owner: string) {
    const a = this.store.accounts[owner];
    return {
      connected: !!a?.accessToken,
      email: a?.email ?? null,
      usageUrl: 'https://chatgpt.com/settings/usage',
    };
  }
  begin(owner: string, port: number) {
    for (const [key, value] of this.pending)
      if (value.expires < Date.now() || value.owner === owner) this.pending.delete(key);
    const a = this.store.accounts[owner];
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
    this.pending.set(state, {
      owner,
      state,
      verifier,
      nonce,
      redirectUri,
      clientId: a?.clientId,
      subject: a?.subject,
      expires: Date.now() + 10 * 60_000,
    });
    const url = new URL(`${issuer}/api/accounts/authorize`);
    const parameters: Record<string, string> = {
      client_id: a?.clientId ?? 'dynamic_agent_client',
      ext_agent_host_id: this.store.hostId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: scopes,
      resource,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    };
    if (!a) parameters.agent_name_hint = 'Gather RPG';
    if (a?.idToken) parameters.id_token_hint = a.idToken;
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    return url.toString();
  }
  async callback(query: Record<string, string | undefined>) {
    const p = query.state ? this.pending.get(query.state) : undefined;
    if (!p || !secretEqual(p.state, query.state!) || p.expires < Date.now())
      throw new GameError('This sign-in attempt expired or could not be verified. Start again.');
    this.pending.delete(p.state);
    if (query.error) throw new GameError('ChatGPT sign-in was not completed. You can try again from Gather.');
    const clientId = query.client_id ?? p.clientId;
    if (
      !query.code ||
      !clientId ||
      clientId === 'dynamic_agent_client' ||
      (p.clientId && clientId !== p.clientId)
    )
      throw new GameError('ChatGPT did not return the expected client registration.');
    const tokens = await this.exchange({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: query.code,
      code_verifier: p.verifier,
      redirect_uri: p.redirectUri,
      resource,
    });
    if (!tokens.id_token) throw new GameError('ChatGPT did not return a verifiable identity.');
    const response = await this.fetcher(`${issuer}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new GameError('Could not verify ChatGPT identity discovery.');
    const discovery = (await response.json()) as { issuer: string; jwks_uri: string };
    const jwksUrl = new URL(discovery.jwks_uri);
    if (discovery.issuer !== issuer || jwksUrl.origin !== issuer)
      throw new GameError('Unexpected ChatGPT identity configuration.');
    const { payload } = await jwtVerify(tokens.id_token, createRemoteJWKSet(jwksUrl), {
      issuer,
      audience: clientId,
      requiredClaims: ['exp', 'sub', 'nonce'],
    });
    if (payload.nonce !== p.nonce || !payload.sub || (p.subject && payload.sub !== p.subject))
      throw new GameError('The signed-in ChatGPT identity did not match this attempt.');
    const granted = tokens.scope?.split(' ') ?? [];
    if (!granted.includes('chatgpt.tokens.use.direct') || !granted.includes('resource.invoke'))
      throw new GameError(
        'ChatGPT plan usage was not enabled for this connection. Sign in again and grant plan access.',
      );
    this.store.accounts[p.owner] = {
      clientId,
      subject: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : 'ChatGPT account',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token,
      expires: Date.now() + tokens.expires_in * 1000,
      scopes: granted,
    };
    this.save();
    return p.owner;
  }
  private async exchange(parameters: Record<string, string>): Promise<Tokens> {
    const response = await this.fetcher(`${issuer}/api/accounts/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(parameters),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw new GameError(
        'ChatGPT could not authorize this connection. Reconnect from the host computer.',
        502,
      );
    const tokens = tokenSchema.parse(await response.json());
    if (tokens.token_type.toLowerCase() !== 'bearer') throw new GameError('Unexpected ChatGPT token type.');
    return tokens;
  }
  async accessToken(owner: string): Promise<string> {
    const a = this.store.accounts[owner];
    if (!a?.accessToken)
      throw new GameError('Connect the leader’s ChatGPT account in Settings before starting a live session.');
    if (a.expires > Date.now() + 60_000) return a.accessToken;
    const existing = this.refreshing.get(owner);
    if (existing) return existing;
    const task = (async () => {
      if (!a.refreshToken) throw new GameError('Your ChatGPT connection expired. Reconnect in Settings.');
      const tokens = await this.exchange({
        grant_type: 'refresh_token',
        client_id: a.clientId,
        refresh_token: a.refreshToken,
        resource,
      });
      const granted = tokens.scope?.split(' ') ?? a.scopes;
      if (!granted.includes('chatgpt.tokens.use.direct'))
        throw new GameError('ChatGPT plan access is no longer available.');
      if (this.store.accounts[owner] !== a) throw new GameError('This ChatGPT connection was disconnected.');
      Object.assign(a, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? a.refreshToken,
        idToken: tokens.id_token ?? a.idToken,
        expires: Date.now() + tokens.expires_in * 1000,
        scopes: granted,
      });
      this.save();
      return tokens.access_token;
    })();
    this.refreshing.set(owner, task);
    try {
      return await task;
    } finally {
      this.refreshing.delete(owner);
    }
  }
  async disconnect(owner: string) {
    const inFlight = this.refreshing.get(owner);
    if (inFlight) await inFlight.catch(() => undefined);
    const a = this.store.accounts[owner];
    let revoked = !a?.refreshToken;
    if (a?.refreshToken) {
      try {
        const discoveryResponse = await this.fetcher(`${issuer}/.well-known/openid-configuration`, {
          signal: AbortSignal.timeout(10000),
        });
        const discovery = (await discoveryResponse.json()) as { revocation_endpoint: string };
        const endpoint = new URL(discovery.revocation_endpoint);
        if (endpoint.origin !== issuer) throw new Error('Unexpected revocation endpoint');
        const result = await this.fetcher(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            token: a.refreshToken,
            token_type_hint: 'refresh_token',
            client_id: a.clientId,
          }),
          signal: AbortSignal.timeout(10000),
        });
        revoked = result.ok;
      } catch {
        revoked = false;
      }
    }
    if (a) {
      this.store.accounts[owner] = {
        ...a,
        accessToken: undefined,
        refreshToken: undefined,
        idToken: undefined,
        expires: 0,
      };
      this.save();
    }
    return {
      revoked,
      message: revoked
        ? 'ChatGPT disconnected.'
        : 'Disconnected locally. Remote revocation could not be confirmed; disconnect Gather in ChatGPT settings too.',
    };
  }
  async models(owner: string) {
    const response = await this.fetcher(`${resource}/models`, {
      headers: { Authorization: `Bearer ${await this.accessToken(owner)}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new GameError('Could not load models for this ChatGPT plan.', 502);
    const body = (await response.json()) as {
      models?: { slug: string; display_name: string; visibility: string }[];
    };
    if (!Array.isArray(body.models))
      throw new GameError('ChatGPT returned an unsupported model catalog.', 502);
    return body.models
      .filter((m) => m.visibility === 'list')
      .map((m) => ({ id: m.slug, name: m.display_name }));
  }
}
