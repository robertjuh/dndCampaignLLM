import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import { z } from 'zod';
import type { DB } from './db';
import { Game, GameError, secretEqual, type ProviderFactory } from './game';
import { ChatGPTAuth } from './auth';
import { ChatGPTGM, PracticeGM, ProviderError } from './providers';
import { RuleError } from '../shared/rules';
import { localDice } from './random';
import { characterSchema, levelUpChoiceSchema, slots } from '../shared/schema';
import type { GoogleAuth } from './google';
import { tokenHash } from './game';

declare module 'fastify' {
  interface FastifyRequest {
    player: { id: string; name: string };
  }
}
const idParams = z.object({ id: z.string().uuid() });
const actionInput = z
  .object({
    turnId: z.string().uuid(),
    text: z.string().trim().max(2000),
    passed: z.boolean(),
    acceptsLethalRisk: z.boolean().default(false),
    abilityName: z.string().min(1).max(80).nullable().default(null),
  })
  .strict()
  .refine((a) => a.passed || a.text.length > 0, 'Write an action or choose Pass.');
const loopback = (ip: string) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);

export async function createApp(options: {
  db: DB;
  auth: ChatGPTAuth;
  port?: number;
  providers?: ProviderFactory;
  partyOrigins?: string[];
  google?: GoogleAuth;
}) {
  const app = Fastify({ logger: false, bodyLimit: 100_000 });
  const providers: ProviderFactory =
    options.providers ??
    ((owner, config) =>
      config.provider === 'practice' ? new PracticeGM() : new ChatGPTGM(options.auth, owner, config.model));
  const game = new Game(options.db, providers, undefined, () => localDice);
  const streams = new Set<() => void>();
  const requests = new Map<string, { start: number; count: number }>();
  const googleOrigin = options.google ? new URL(options.google.config.redirectUri).origin : undefined;
  const sessionCookie = (request: FastifyRequest) => ({
    path: '/',
    httpOnly: true,
    sameSite: 'strict' as const,
    maxAge: 60 * 60 * 24 * 365,
    secure:
      request.protocol === 'https' ||
      (googleOrigin?.startsWith('https:') === true && new URL(googleOrigin).host === request.headers.host),
  });
  await app.register(cookie);
  app.decorateRequest('player');
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Referrer-Policy', 'no-referrer').header('X-Content-Type-Options', 'nosniff');
    if (!request.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    const origin = request.headers.origin;
    if (origin && new URL(origin).host !== request.headers.host)
      throw new GameError('Cross-origin requests are not allowed.', 403);
    if (request.method !== 'GET' && request.headers['x-gather-request'] !== '1')
      throw new GameError('Missing request verification.', 403);
    const now = Date.now();
    const rate = requests.get(request.ip);
    if (!rate || now - rate.start > 60_000) requests.set(request.ip, { start: now, count: 1 });
    else if (++rate.count > 240) throw new GameError('Too many requests. Please wait a moment.', 429);
    if (requests.size > 1000)
      for (const [key, value] of requests) if (now - value.start > 60_000) requests.delete(key);
    const player = game.identify(request.cookies.gather_session);
    request.player = { id: player.id, name: player.name };
    if (player.token) reply.setCookie('gather_session', player.token, sessionCookie(request));
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError)
      return reply
        .code(400)
        .send({ error: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (error instanceof RuleError) return reply.code(400).send({ error: error.message });
    if (error instanceof ProviderError)
      return reply.code(error.status).send({ error: error.message, provider: error.diagnostics });
    if (error instanceof GameError) return reply.code(error.status).send({ error: error.message });
    if ((error as { statusCode?: number }).statusCode === 413)
      return reply.code(413).send({ error: 'This request is too large.' });
    // Provider and internal errors can contain credentials or personal data; never serialize them.
    return reply.code(500).send({ error: 'The server could not complete this request.' });
  });
  const campaignId = (req: FastifyRequest) => idParams.parse(req.params).id;
  const authorizeRead = (req: FastifyRequest) => {
    const id = campaignId(req);
    game.canRead(id, req.player.id, req.cookies[`display_${id}`]);
    return id;
  };
  const snap = (id: string, req: FastifyRequest) => {
    const snapshot = game.snapshot(id, req.player.id);
    return { ...snapshot, ...(snapshot.isHost ? { partyOrigins: options.partyOrigins ?? [] } : {}) };
  };
  app.get('/api/me', async (request) => ({
    ...request.player,
    characters: game.characters(request.player.id),
    campaigns: game.list(request.player.id),
  }));
  app.post('/api/profile', async (request) => {
    const { name } = z
      .object({ name: z.string().trim().min(1).max(60) })
      .strict()
      .parse(request.body);
    game.rename(request.player.id, name);
    return { ok: true };
  });
  app.get(
    '/api/player-auth',
    async (request) =>
      options.google?.status(request.player.id) ?? {
        configured: false,
        signedIn: false,
        email: null,
      },
  );
  app.post('/api/player-auth/google', async (request, reply) => {
    if (!options.google) throw new GameError('The host needs to configure Google sign-in first.', 503);
    const { returnTo } = z
      .object({
        returnTo: z
          .string()
          .max(300)
          .regex(/^\/(?:settings|characters|join\/[a-fA-F0-9]{12}|campaign\/[a-f0-9-]{36})?$/)
          .default('/settings'),
      })
      .strict()
      .parse(request.body);
    if (!request.cookies.gather_session) throw new GameError('Reload this page before signing in.', 400);
    const allowed = [
      googleOrigin,
      ...(options.partyOrigins ?? []),
      `http://127.0.0.1:${options.port ?? 3000}`,
      `http://localhost:${options.port ?? 3000}`,
    ];
    const origin =
      request.headers.origin ?? allowed.find((o) => o && new URL(o).host === request.headers.host);
    if (!origin || !allowed.includes(origin))
      throw new GameError(
        'Open Gather using the host’s configured invitation address before signing in.',
        400,
      );
    const result = options.google.begin(request.player.id, request.cookies.gather_session, origin, returnTo);
    reply.setCookie('gather_google_state', result.browserSecret, {
      path: '/auth/google',
      httpOnly: true,
      sameSite: 'lax',
      secure: origin.startsWith('https:'),
      maxAge: 600,
    });
    return { url: result.url };
  });
  app.post('/api/player-auth/logout', async (request, reply) => {
    if (request.cookies.gather_session)
      options.db
        .prepare('DELETE FROM sessions WHERE hash = ?')
        .run(tokenHash(request.cookies.gather_session));
    const fresh = game.identify();
    reply.setCookie('gather_session', fresh.token!, sessionCookie(request));
    return { ok: true };
  });
  app.get('/auth/google/callback', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!options.google) throw new GameError('Google sign-in is not configured.', 503);
    return reply.redirect(await options.google.callback(z.record(z.string()).parse(request.query)));
  });
  app.get('/auth/google/finish', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!options.google) throw new GameError('Google sign-in is not configured.', 503);
    const { state } = z.object({ state: z.string().max(100) }).parse(request.query);
    const result = options.google.finish(state, request.cookies.gather_google_state);
    reply.clearCookie('gather_google_state', { path: '/auth/google' });
    if (result.token) reply.setCookie('gather_session', result.token, sessionCookie(request));
    return reply.redirect(result.url);
  });
  app.post('/api/characters', async (request) => game.saveCharacter(request.player.id, request.body));
  app.post('/api/characters/:id', async (request) =>
    game.updateCharacter(request.player.id, campaignId(request), request.body),
  );
  app.post('/api/campaigns/:id/template', async (request) =>
    game.editLobbyCharacter(campaignId(request), request.player.id, request.body),
  );
  app.post('/api/characters/generate', async (request, reply) => {
    const { concept, model, code, campaignId } = z
      .object({
        concept: z.string().trim().max(1000),
        model: z.string().max(100).default(''),
        campaignId: z.string().uuid().optional(),
        code: z
          .string()
          .regex(/^[a-fA-F0-9]{12}$/)
          .optional(),
      })
      .strict()
      .parse(request.body);
    let provider = new ChatGPTGM(options.auth, request.player.id, model) as import('./game').GameMaster;
    let context = concept || 'Surprise me with a completely randomized protagonist.';
    if (code || campaignId) {
      if (campaignId) game.canRead(campaignId, request.player.id);
      const campaign = game.campaign(campaignId ?? game.invite(code!).id);
      provider = providers(campaign.owner_id, JSON.parse(campaign.config));
      context = JSON.stringify({ playerConcept: context, campaign: JSON.parse(campaign.config) });
    }
    if (!provider.generate) throw new GameError('Character generation is not available.');
    const controller = new AbortController();
    const cancel = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    reply.raw.on('close', cancel);
    try {
      return characterSchema.parse(await provider.generate(context, controller.signal));
    } finally {
      reply.raw.off('close', cancel);
    }
  });
  app.post('/api/campaigns', async (request) => game.create(request.player.id, request.body));
  app.get('/api/invites/:code', async (request) =>
    game.invite(z.object({ code: z.string().regex(/^[a-fA-F0-9]{12}$/) }).parse(request.params).code),
  );
  app.post('/api/join', async (request) => {
    const input = z
      .object({
        code: z.string().regex(/^[a-fA-F0-9]{12}$/),
        playerName: z.string().trim().min(1).max(60),
        characterId: z.string().uuid(),
      })
      .strict()
      .parse(request.body);
    game.rename(request.player.id, input.playerName);
    return game.join(input.code, request.player.id, input.characterId);
  });
  app.get('/api/campaigns/:id', async (request) => snap(authorizeRead(request), request));
  app.post('/api/campaigns/:id/display', async (request, reply) => {
    const id = campaignId(request);
    const { token } = z
      .object({ token: z.string().min(20).max(100) })
      .strict()
      .parse(request.body);
    if (!secretEqual(game.campaign(id).display_token, token))
      throw new GameError('This display link is invalid.', 403);
    reply.setCookie(`display_${id}`, token, {
      path: `/api/campaigns/${id}`,
      httpOnly: true,
      sameSite: 'strict',
      secure: request.protocol === 'https',
      maxAge: 60 * 60 * 24 * 30,
    });
    return { ok: true };
  });
  app.post('/api/campaigns/:id/start', async (request) => {
    const id = campaignId(request);
    game.start(id, request.player.id);
    return snap(id, request);
  });
  app.post('/api/campaigns/:id/action', async (request) => {
    const id = campaignId(request);
    const action = actionInput.parse(request.body);
    game.submit(id, request.player.id, action.turnId, action.text, action.passed, action.acceptsLethalRisk, action.abilityName);
    return snap(id, request);
  });
  app.post('/api/campaigns/:id/pause', async (request) => {
    const id = campaignId(request);
    const { paused } = z.object({ paused: z.boolean() }).strict().parse(request.body);
    game.pause(id, request.player.id, paused);
    return snap(id, request);
  });
  app.post('/api/campaigns/:id/member', async (request) => {
    const id = campaignId(request);
    const { memberId, active } = z
      .object({ memberId: z.string().uuid(), active: z.boolean() })
      .strict()
      .parse(request.body);
    game.setActive(id, request.player.id, memberId, active);
    return snap(id, request);
  });
  app.post('/api/campaigns/:id/character', async (request) => {
    const action = z
      .object({
        type: z.enum(['starter', 'equip', 'unequip', 'heal', 'drop', 'take', 'rest']),
        itemId: z.string().optional(),
        itemIds: z.array(z.string()).length(2).optional(),
        slot: z.enum(slots).optional(),
      })
      .strict()
      .parse(request.body);
    return game.manageCharacter(campaignId(request), request.player.id, action);
  });
  app.post('/api/campaigns/:id/level-up', async (request) => {
    const { choice } = z.object({ choice: levelUpChoiceSchema }).strict().parse(request.body);
    return game.levelUp(campaignId(request), request.player.id, choice);
  });
  app.post('/api/campaigns/:id/retry', async (request) => {
    const id = campaignId(request);
    game.retry(id, request.player.id);
    return snap(id, request);
  });
  app.get('/api/campaigns/:id/export', async (request, reply) => {
    const id = campaignId(request);
    return reply
      .header('Content-Disposition', `attachment; filename="gather-${id}.json"`)
      .send(game.export(id, request.player.id));
  });
  app.get('/api/campaigns/:id/events', async (request, reply) => {
    const id = authorizeRead(request);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Referrer-Policy': 'no-referrer',
    });
    const send = () => {
      if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(snap(id, request))}\n\n`);
    };
    send();
    const unsubscribe = game.subscribe(id, send);
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n');
    }, 15000);
    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
      streams.delete(close);
      reply.raw.end();
    };
    streams.add(close);
    request.raw.on('close', close);
  });
  app.get('/api/chatgpt', async (request) => options.auth.status(request.player.id));
  app.get('/api/chatgpt/models', async (request) => options.auth.models(request.player.id));
  app.post('/api/chatgpt/connect', async (request) => {
    if (!loopback(request.ip))
      throw new GameError(
        'Connect ChatGPT on the host computer at http://127.0.0.1. Players join through the session link.',
        403,
      );
    return { url: options.auth.begin(request.player.id, options.port ?? 3000) };
  });
  app.post('/api/chatgpt/disconnect', async (request) => {
    if (!loopback(request.ip) || options.auth.status(request.player.id).shared)
      throw new GameError('Only the connected host can disconnect ChatGPT.', 403);
    return options.auth.disconnect(request.player.id);
  });
  app.get('/auth/callback', async (request, reply) => {
    const html = (message: string) =>
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Gather · ChatGPT</title><body style="background:#111914;color:#eee9d7;font:18px system-ui;padding:10vw;max-width:700px"><h1>Gather</h1><p>${message}</p><p>You can close this tab and return to Gather.</p></body></html>`;
    if (!loopback(request.ip))
      return reply.code(403).type('text/html').send(html('Complete sign-in on the host computer.'));
    try {
      const query = z.record(z.string()).parse(request.query);
      await options.auth.callback(query);
      return reply
        .type('text/html')
        .header('Cache-Control', 'no-store')
        .send(
          html(
            'ChatGPT is connected. Eligible AI requests will use your ChatGPT plan. Manage limits in your ChatGPT settings.',
          ),
        );
    } catch {
      return reply
        .code(400)
        .type('text/html')
        .send(html('The connection could not be verified. Please start sign-in again from Gather.'));
    }
  });
  app.addHook('onClose', async () => {
    streams.forEach((close) => close());
    await game.idle();
  });
  game.resumeQueued();
  return { app, game };
}
