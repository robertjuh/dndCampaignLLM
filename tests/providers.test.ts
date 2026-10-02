import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatGPTAuth } from '../server/auth';
import { ChatGPTGM, readResponseStream } from '../server/providers';
import { initialState, initialScene } from '../shared/rules';
import type { GMContext } from '../server/game';
import { randomUUID } from 'node:crypto';
import { templateCharacter, blankTrait, outcomeSchema, type Roll } from '../shared/schema';

const result = {
  narration: 'The gate opens.',
  summary: 'You may enter.',
  choices: [],
  changes: [],
  journal: [],
};
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
function stream(chunks: string[]) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
  );
}
describe('subscription response handling', () => {
  it('waits for completed inference and handles arbitrary SSE chunk boundaries', async () => {
    const data = event({ type: 'response.completed', response: { status: 'completed', output: [] } }).replace(
      /\n/g,
      '\r\n',
    );
    expect(await readResponseStream(stream([...data]))).toEqual({ status: 'completed', output: [] });
  });
  it('does not commit partial text when a usage-limit failure follows', async () => {
    await expect(
      readResponseStream(
        stream([
          event({ type: 'response.output_text.delta', delta: 'You find a sword.' }),
          event({
            type: 'response.failed',
            response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } },
          }),
        ]),
      ),
    ).rejects.toThrow('usage limit');
  });
  it('rejects disconnected streams and incomplete terminal events', async () => {
    await expect(
      readResponseStream(stream([event({ type: 'response.output_text.delta', delta: 'Partial' })])),
    ).rejects.toThrow('disconnected');
    await expect(readResponseStream(stream([event({ type: 'response.incomplete' })]))).rejects.toThrow(
      'could not complete',
    );
  });
  it('executes a real application tool and sends its output and reasoning back without paid API credentials', async () => {
    const memberId = randomUUID();
    const check = {
      memberId,
      stat: 'INT',
      dc: 10,
      reason: 'Inspect the gate.',
      mode: 'normal',
      lethal: false,
    };
    const responses = [
      {
        status: 'completed',
        output: [
          { type: 'reasoning', id: 'r1', summary: [] },
          {
            type: 'function_call',
            namespace: 'game',
            name: 'roll_check',
            call_id: 'call1',
            arguments: JSON.stringify(check),
          },
        ],
      },
      {
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }],
      },
    ];
    const fetcher = vi.fn(async () =>
      stream([event({ type: 'response.completed', response: responses.shift() })]),
    );
    const auth = {
      accessToken: async () => 'test-subscription-token',
      models: async () => [{ id: 'account-model', name: 'Available model' }],
    } as unknown as ChatGPTAuth;
    const gm = new ChatGPTGM(auth, 'owner', '', fetcher as unknown as typeof fetch);
    const ctx: GMContext = {
      config: {
        ruleset: 'roguelike-v1',
        name: 'Test',
        setting: 'Forest',
        premise: '',
        tone: '',
        instructions: '',
        language: 'English',
        custom: [],
        provider: 'chatgpt',
        model: '',
      },
      members: [
        {
          id: memberId,
          playerId: randomUUID(),
          playerName: 'Mira',
          characterId: randomUUID(),
          character: templateCharacter('Mira'),
          active: true,
          state: initialState(templateCharacter('Mira'), memberId),
        },
      ],
      turn: {
        id: randomUUID(),
        number: 1,
        phase: 'resolving',
        roster: [memberId],
        actions: [{ memberId, text: 'Inspect the gate.', passed: false }],
        rolls: [],
        result: null,
        error: null,
      },
      history: [],
      journal: [],
      scene: initialScene('Forest'),
    };
    const roll = vi.fn(
      () =>
        ({
          ...check,
          id: randomUUID(),
          dice: [12],
          modifier: 1,
          total: 13,
          success: true,
          source: 'Test',
        }) as Roll,
    );
    expect(
      await gm.resolve(
        ctx,
        Object.assign(roll, {
          startCombat: vi.fn(),
          combat: vi.fn(),
          completeChallenge: vi.fn(),
          offerLoot: vi.fn(),
        }),
      ),
    ).toEqual(outcomeSchema.parse(result));
    expect(roll).toHaveBeenCalledTimes(1);
    const second = (fetcher.mock.calls as unknown as [string, RequestInit][])[1];
    const body = JSON.parse(second[1].body as string);
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.tools[0].type).toBe('namespace');
    expect(body).not.toHaveProperty('previous_response_id');
    expect(body.input.some((x: { type: string }) => x.type === 'reasoning')).toBe(true);
    expect(body.input.find((x: { type: string }) => x.type === 'function_call_output').output).toContain(
      '13',
    );
  });
});
describe('ChatGPT registration boundaries', () => {
  it('persists the host ID, uses PKCE, and does not treat identity alone as a connection', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gather-auth-'));
    const auth = new ChatGPTAuth(directory);
    const first = new URL(auth.begin('owner', 3000));
    const second = new URL(new ChatGPTAuth(directory).begin('owner', 3000));
    expect(first.searchParams.get('ext_agent_host_id')).toBe(second.searchParams.get('ext_agent_host_id'));
    expect(first.searchParams.get('code_challenge_method')).toBe('S256');
    expect(first.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:3000/auth/callback');
    expect(first.searchParams.get('state')).not.toBe(second.searchParams.get('state'));
    expect(auth.status('owner').connected).toBe(false);
  });
  it('rejects invalid state, denial, and missing issued registration before exchanging tokens', async () => {
    const fetcher = vi.fn();
    const auth = new ChatGPTAuth(mkdtempSync(join(tmpdir(), 'gather-auth-')), fetcher);
    await expect(auth.callback({ state: 'wrong', code: 'invalid' })).rejects.toThrow('verified');
    let url = new URL(auth.begin('owner', 3000));
    await expect(
      auth.callback({ state: url.searchParams.get('state')!, error: 'access_denied' }),
    ).rejects.toThrow('not completed');
    url = new URL(auth.begin('owner', 3000));
    await expect(auth.callback({ state: url.searchParams.get('state')!, code: 'invalid' })).rejects.toThrow(
      'registration',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});

it('generates a balanced custom template from the supplied concept without a species catalog', async () => {
  const sheet = templateCharacter('Roberto', 'Elf spider');
  sheet.traits = [
    {
      ...blankTrait('Chaotic anatomy'),
      stats: { STR: 3, DEX: -1, INT: 1 },
      description: 'Powerful limbs, careful spellcraft, and awkward footing.',
    },
  ];
  sheet.traits.push(blankTrait('Silk instinct'));
  const { equipmentOptions: _, selectedEquipmentIds: __, ...core } = sheet;
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const context = JSON.parse(JSON.parse(init!.body as string).input[0].content);
    const value = context.rolledEquipment
      ? {
          items: context.rolledEquipment.map((item: { id: string }, i: number) => ({
            id: item.id,
            name: `Silk-bound equipment ${i}`,
            description: 'Woven silk equipment.',
          })),
        }
      : core;
    return stream([
      event({
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
        },
      }),
    ]);
  });
  const auth = {
    accessToken: async () => 'subscription-only',
    models: async () => [{ id: 'account-model', name: 'Available' }],
  } as unknown as ChatGPTAuth;
  const gm = new ChatGPTGM(auth, 'owner', '', fetcher as unknown as typeof fetch);
  const concept = 'chaotic warlord elf spider with a tendency to randomly cast spells';
  const result = await gm.generate(concept);
  expect(result).toMatchObject({ name: 'Roberto', species: 'Elf spider', stats: { STR: 8, DEX: 4, INT: 6 } });
  expect(result.equipmentOptions[0].name).toBe('Silk-bound equipment 0');
  const request = (fetcher.mock.calls as unknown as [string, RequestInit][])[0];
  expect(request[1].body).toContain(concept);
  expect(request[1].body).not.toContain('api_key');
});
