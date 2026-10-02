import { expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatGPTAuth } from '../server/auth';
import { createApp } from '../server/app';
import { openDatabase } from '../server/db';
import { templateCharacter } from '../shared/schema';

it('uses the saved host connection for a fresh phone’s library, invite generation, and game turns without exposing account controls', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gather-shared-host-'));
  const token = 'host-test-token';
  writeFileSync(
    join(directory, 'chatgpt.json'),
    JSON.stringify({
      hostId: 'test-host',
      accounts: {
        'host-profile': {
          clientId: 'test-client',
          subject: 'test-subject',
          email: 'private@example.test',
          accessToken: token,
          expires: Date.now() + 3600000,
          scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'],
        },
      },
    }),
  );
  const sheet = templateCharacter('Phone adventurer');
  const { equipmentOptions: _, selectedEquipmentIds: __, ...core } = sheet;
  let rejectAfterChecks = true;
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
    if (String(_url).endsWith('/models'))
      return Response.json({
        models: [{ slug: 'test-model', display_name: 'Test model', visibility: 'list' }],
      });
    const body = JSON.parse(init!.body as string);
    const completed = (output: unknown[]) =>
      new Response(
        output
          .map(
            (item, output_index) =>
              `data: ${JSON.stringify({ type: 'response.output_item.done', item, output_index })}\n\n`,
          )
          .join('') +
          `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [] } })}\n\n`,
      );
    const generating =
      body.instructions.startsWith('Generate') || body.instructions.startsWith('Name and describe');
    const context = JSON.parse(body.input[0].content);
    if (!generating && context.turn.number > 0) {
      if (!body.input.some((item: { type?: string }) => item.type === 'function_call_output')) {
        return completed(
          context.turn.actions.map((action: { memberId: string; text: string }) => ({
            type: 'function_call',
            namespace: 'game',
            name: 'roll_check',
            call_id: `check-${action.memberId}`,
            arguments: JSON.stringify({
              memberId: action.memberId,
              stat: 'INT',
              dc: 10,
              reason: action.text,
              mode: 'normal',
              lethal: false,
            }),
          })),
        );
      }
      if (rejectAfterChecks) {
        rejectAfterChecks = false;
        return new Response(
          `data: ${JSON.stringify({ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } })}\n\n`,
        );
      }
    }
    const result = generating
      ? context.rolledEquipment
        ? {
            items: context.rolledEquipment.map(
              ({ id, name, description }: { id: string; name: string; description: string }) => ({
                id,
                name,
                description,
              }),
            ),
          }
        : core
      : {
          narration: 'The party proceeds.',
          summary: 'A new journey.',
          choices: [],
          changes: [],
          journal: [],
          xp: context.turn.number > 0 ? 20 : 0,
        };
    return completed([{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }]);
  });
  vi.stubGlobal('fetch', fetcher);
  const auth = new ChatGPTAuth(directory, fetcher as typeof fetch);
  const db = openDatabase(':memory:');
  const { app, game } = await createApp({ db, auth });
  try {
    const me = await app.inject({ method: 'GET', url: '/api/me', remoteAddress: '192.168.2.20' });
    const owner = me.json().id;
    const cookies = { gather_session: me.cookies.find((c) => c.name === 'gather_session')!.value };
    const headers = { 'x-gather-request': '1' };
    const status = await app.inject({ method: 'GET', url: '/api/chatgpt', cookies });
    expect(status.json()).toMatchObject({ connected: true, shared: true, email: null });
    expect(status.body).not.toContain(token);
    expect(status.body).not.toContain('private@example.test');
    const generated = await app.inject({
      method: 'POST',
      url: '/api/characters/generate',
      remoteAddress: '192.168.2.20',
      cookies,
      headers,
      payload: { concept: 'sea warrior' },
    });
    expect(generated.statusCode).toBe(200);
    expect(generated.json()).toMatchObject(core);
    expect(generated.json().equipmentOptions).toHaveLength(5);
    const saved = game.saveCharacter(owner, generated.json());
    const campaign = game.create(owner, {
      name: 'Phone-led campaign',
      setting: 'A custom harbor',
      premise: '',
      tone: '',
      instructions: '',
      language: 'English',
      custom: [],
      provider: 'chatgpt',
      model: '',
    });
    const invited = await app.inject({
      method: 'POST',
      url: '/api/characters/generate',
      cookies,
      headers,
      payload: { concept: 'sea warrior', code: campaign.inviteCode },
    });
    expect(invited.statusCode).toBe(200);
    game.join(campaign.inviteCode!, owner, saved.id);
    const member = game.snapshot(campaign.id, owner).members[0];
    game.manageCharacter(campaign.id, owner, {
      type: 'starter',
      itemIds: member.state.starterEquipment.slice(0, 2).map((item) => item.id),
    });
    const second = game.identify();
    const secondCharacter = game.saveCharacter(second.id, { ...sheet, name: 'Second adventurer' });
    game.join(campaign.inviteCode!, second.id, secondCharacter.id);
    const secondMember = game.snapshot(campaign.id, second.id).members.find((m) => m.playerId === second.id)!;
    game.manageCharacter(campaign.id, second.id, {
      type: 'starter',
      itemIds: secondMember.state.starterEquipment.slice(0, 2).map((item) => item.id),
    });
    game.start(campaign.id, owner);
    await game.idle();
    const turn = game.snapshot(campaign.id, owner).turn!;
    expect(turn.phase).toBe('collecting');
    const beforeActions = fetcher.mock.calls.length;
    game.submit(campaign.id, owner, turn.id, 'Examine the gate mechanism.', false);
    await game.idle();
    expect(fetcher.mock.calls).toHaveLength(beforeActions);
    game.submit(campaign.id, second.id, turn.id, 'Read the inscriptions.', false);
    await game.idle();
    const failed = game.snapshot(campaign.id, owner).turn!;
    expect(failed.phase).toBe('failed');
    expect(failed.rolls).toHaveLength(2);
    expect(failed.error).toContain('subscription_sharing_usage_limit_exceeded');
    expect(game.snapshot(campaign.id, owner).members.every((m) => m.state.xp === 0)).toBe(true);
    game.retry(campaign.id, owner);
    await game.idle();
    const finished = game.snapshot(campaign.id, owner);
    expect(finished.turn?.number).toBe(turn.number + 1);
    expect(finished.history.find((t) => t.id === turn.id)?.rolls).toEqual(failed.rolls);
    expect(finished.members.every((m) => m.state.xp === 20)).toBe(true);
    const disconnect = await app.inject({
      method: 'POST',
      url: '/api/chatgpt/disconnect',
      remoteAddress: '192.168.2.20',
      cookies,
      headers,
      payload: {},
    });
    expect(disconnect.statusCode).toBe(403);
    // The host selection survives a restart, and phone usage has no account copy.
    expect(await new ChatGPTAuth(directory).accessToken(owner)).toBe(token);
    await auth.disconnect('host-profile');
    await expect(auth.accessToken(owner)).rejects.toThrow('Connect the leader');
  } finally {
    await app.close();
    db.close();
    vi.unstubAllGlobals();
  }
});
