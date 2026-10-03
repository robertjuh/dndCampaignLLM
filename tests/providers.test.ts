import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatGPTAuth } from '../server/auth';
import { ChatGPTGM, PracticeGM, readResponseStream } from '../server/providers';
import { initialState, initialScene } from '../shared/rules';
import { GameError, type GMContext, type GameTools } from '../server/game';
import { randomUUID } from 'node:crypto';
import {
  templateCharacter,
  blankTrait,
  outcomeSchema,
  combatSchema,
  type Check,
  type Roll,
} from '../shared/schema';

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
function resolveContext(memberId = randomUUID()): GMContext {
  return {
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
}
function combatContext(): GMContext {
  const context = resolveContext();
  context.members[0].state.equipment.left = {
    ...context.members[0].character.equipmentOptions[0],
    name: 'Boarding knife',
  };
  context.turn.actions[0].text = 'Attack, defend, or use a special lunge. Found a box of rifles.';
  context.scene.encounter = {
    enemies: [
      {
        id: 'gatekeeper',
        name: 'Gatekeeper',
        tier: 'normal',
        hp: 15,
        maxHp: 15,
        defense: 10,
        attack: 0,
        damage: '1d4',
        description: 'An armed guard.',
        tactic: 'Attack the nearest intruder.',
        onHit: null,
        initiative: 5,
      },
    ],
    initiative: [
      { id: context.members[0].id, total: 10 },
      { id: 'gatekeeper', total: 5 },
    ],
    round: 1,
    victory: false,
    escaped: false,
  };
  return context;
}
function combatTools(): GameTools {
  return Object.assign(vi.fn(), {
    startCombat: vi.fn(),
    combat: vi.fn(),
    completeChallenge: vi.fn(),
    offerLoot: vi.fn(),
    useResource: vi.fn(),
    validateResolution: vi.fn(),
  });
}
describe('practice natural-language resources', () => {
  it('keeps ordinary inspection from consuming an owned healing item', async () => {
    const context = resolveContext();
    context.turn.actions[0].text = `Inspect my ${context.members[0].state.inventory[0].name}.`;
    const roll = vi.fn((input: Check): Roll => ({
      ...input,
      id: randomUUID(),
      dice: [12],
      modifier: 0,
      total: 12,
      success: true,
      source: 'Test',
    }));
    const useResource = vi.fn();
    const tools = Object.assign(roll, {
      startCombat: vi.fn(),
      combat: vi.fn(),
      completeChallenge: vi.fn(),
      offerLoot: vi.fn(),
      useResource,
    });
    await new PracticeGM().resolve(context, tools);
    expect(useResource).not.toHaveBeenCalled();
    expect(roll).toHaveBeenCalledOnce();
  });
  it('uses the saved utility ability for a generic investigation request', async () => {
    const context = resolveContext();
    const ability = context.members[0].character.abilities.find((ability) => ability.kind === 'utility')!;
    context.turn.actions[0].text = 'I used my ability to investigate the platform.';
    const roll = vi.fn((input: Check): Roll => ({
      ...input,
      id: randomUUID(),
      dice: [12],
      modifier: 0,
      total: 12,
      success: true,
      source: 'Test',
    }));
    const tools = Object.assign(roll, {
      startCombat: vi.fn(),
      combat: vi.fn(),
      completeChallenge: vi.fn(),
      offerLoot: vi.fn(),
    });
    await new PracticeGM().resolve(context, tools);
    expect(roll).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ abilityName: ability.name, stat: ability.stat }),
    );
  });
  it.each(['item', 'Mend'])(
    'routes a pure %s action through authoritative consumption instead of a check',
    async (source) => {
      const context = resolveContext();
      const member = context.members[0];
      const item = member.state.inventory.find((item) => item.healing > 0)!;
      const ability = { ...member.character.abilities[0], name: 'Field Mend', effect: 'mend' as const };
      member.character.abilities.push(ability);
      context.turn.actions[0].text =
        source === 'item' ? 'I drink a potion.' : 'I use Field Mend to heal myself.';
      const tools = combatTools();
      tools.useResource = vi.fn((usage) => ({
        ...usage,
        targetId: member.id,
        sourceName: source === 'item' ? item.name : ability.name,
        restored: 6,
        state: member.state,
        targetState: member.state,
      }));
      const outcome = await new PracticeGM().resolve(context, tools);
      expect(tools).not.toHaveBeenCalled();
      expect(tools.useResource).toHaveBeenCalledExactlyOnceWith({
        memberId: member.id,
        itemId: source === 'item' ? item.id : null,
        abilityName: source === 'Mend' ? ability.name : null,
        targetId: null,
      });
      expect(outcome.narration).toContain('restoring 6 HP');
      expect(outcome.changes).toEqual([]);
    },
  );
  it('reuses a consumed final potion receipt when practice narration is retried', async () => {
    const context = resolveContext();
    const member = context.members[0];
    const item = member.state.inventory.find((item) => item.healing > 0)!;
    context.turn.actions[0].text = 'I drink a potion.';
    member.state.inventory = [];
    context.resourceUses = [
      {
        memberId: member.id,
        itemId: item.id,
        abilityName: null,
        targetId: member.id,
        sourceName: item.name,
        restored: 6,
        state: member.state,
        targetState: member.state,
      },
    ];
    const tools = combatTools();
    const outcome = await new PracticeGM().resolve(context, tools);
    expect(tools).not.toHaveBeenCalled();
    expect(tools.useResource).not.toHaveBeenCalled();
    expect(outcome.narration).toContain(`uses ${item.name}, restoring 6 HP`);
  });
});
describe('campaign output language', () => {
  it('retains Dutch authoritative combat facts when narration repairs fail', async () => {
    const context = combatContext();
    context.config.language = 'Nederlands';
    context.combatResult = {
      logs: ['Mira misses Gatekeeper (5 vs defense 10).'],
      encounter: context.scene.encounter!,
      characters: [],
      loot: [],
    };
    const fetcher = vi.fn(async () =>
      stream([
        event({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }],
          },
        }),
      ]),
    );
    const gm = new ChatGPTGM(
      { accessToken: async () => 'test-token' } as unknown as ChatGPTAuth,
      'owner',
      'test-model',
      fetcher as unknown as typeof fetch,
    );
    const outcome = await gm.resolve(context, combatTools());
    expect(outcome.narration).toContain('Mira mist Gatekeeper (5 vs defense 10).');
    expect(outcome.summary).toBe('De combatronde is afgehandeld.');
    expect(outcome).toMatchObject({ changes: [], xp: 0, gold: 0 });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('localizes offline GM prose and upgrade descriptions while preserving saved names and mechanics', async () => {
    const gm = new PracticeGM();
    const context = resolveContext();
    context.config.language = 'Nederlands';
    context.members[0].character.name = 'Ária Starfall';
    const tools = combatTools();
    vi.mocked(tools).mockImplementation((input: Check): Roll => ({
      ...input,
      id: randomUUID(),
      dice: [1],
      modifier: 0,
      total: 1,
      success: false,
      critical: 'failure',
      source: 'Test',
    }));
    const opening = await gm.resolve({ ...context, turn: { ...context.turn, number: 0 } }, tools);
    expect(opening.narration).toContain('Dit is een offline oefening met de spelregels.');
    expect(opening.summary).toBe('De groep begint in Forest.');
    const outcome = await gm.resolve(context, tools);
    expect(outcome.narration).toContain('Ária Starfall: Inspect the gate.');
    expect(outcome.narration).toContain('Natural 1: rampzalige tegenslag, 4 damage.');
    expect(outcome.summary).toBe('De groep heeft een nieuwe oefenronde afgerond.');
    expect(outcome.changes[0].reason).toBe('Een rampzalige tegenslag tijdens de poging.');
    const target = context.members[0].character.abilities[0];
    const reward = await gm.levelUp({
      config: context.config,
      character: context.members[0].character,
      state: context.members[0].state,
      choice: 'upgrade-combat',
      target,
      attributes: [],
    });
    expect(reward.ability).toMatchObject({ name: target.name, effect: 'strike', stat: 'STR', level: 2 });
    expect(reward.ability!.description).toBe(
      `Je beheerst ${target.name} met meer controle en veelzijdigheid.`,
    );
    expect(reward.description).toBe('Beloning voor de oefencampagne.');
  });
  it.each(['English', 'Nederlands'] as const)(
    'keeps the %s language contract across GM phases and repairs',
    async (language) => {
      for (const phase of ['opening', 'turn', 'planning', 'combat', 'level-up']) {
        const context = phase === 'planning' || phase === 'combat' ? combatContext() : resolveContext();
        context.config.language = language;
        context.config.instructions = 'Write the story in French.';
        context.members[0].character.name = 'Ária Starfall';
        if (phase === 'opening') context.turn = { ...context.turn, number: 0, actions: [] };
        if (phase === 'combat')
          context.combatResult = {
            logs: ['Ária Starfall hits Gatekeeper for 4 damage (11 vs defense 10).'],
            encounter: context.scene.encounter!,
            characters: [],
            loot: [],
          };
        let attempt = 0;
        const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
          const request = JSON.parse(init!.body as string);
          const data = JSON.parse(request.input[0].content);
          return stream([
            event({
              type: 'response.completed',
              response: {
                status: 'completed',
                output: [
                  {
                    type: 'message',
                    content: [
                      {
                        type: 'output_text',
                        text: attempt++ === 0 ? '{}' : JSON.stringify(data.schemaExample ?? result),
                      },
                    ],
                  },
                ],
              },
            }),
          ]);
        });
        const gm = new ChatGPTGM(
          { accessToken: async () => 'test-token' } as unknown as ChatGPTAuth,
          'owner',
          'test-model',
          fetcher as typeof fetch,
        );
        const tools = combatTools();
        if (phase === 'turn')
          tools.validateResolution = vi.fn().mockImplementationOnce(() => {
            throw new GameError('Missing utility check.');
          });
        if (phase === 'planning') await gm.planCombat(context);
        else if (phase === 'level-up')
          await gm.levelUp({
            config: context.config,
            character: context.members[0].character,
            state: context.members[0].state,
            choice: 'attributes',
            target: null,
            attributes: ['STR', 'DEX'],
          });
        else await gm.resolve(context, tools);
        expect(fetcher).toHaveBeenCalledTimes(phase === 'turn' ? 3 : 2);
        const requests = fetcher.mock.calls.map(([, init]) => JSON.parse(init!.body as string));
        for (const request of requests) {
          expect(request.instructions).toContain(
            `Write all generated player-facing prose in ${language === 'Nederlands' ? 'Dutch (Nederlands)' : 'English'}`,
          );
          expect(request.instructions).toContain(
            'Keep core game mechanics terms in English: STR, DEX, INT, HP, XP, DC, attack, strike, mend, guard, assist',
          );
          expect(request.instructions).toContain('Preserve existing proper names');
          expect(request.instructions).toContain('Never translate JSON property names, enum values, IDs');
          expect(request.instructions).toContain('every tool call and every retry or corrected response');
          expect(request.input[0].content).toContain('Ária Starfall');
        }
        expect(requests[1].input.at(-1).content).toMatch(/validation errors|required JSON schema/);
        if (phase === 'turn') expect(requests[2].input.at(-1).content).toContain('rules engine rejected');
      }
    },
  );
});
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
    const ctx = resolveContext(memberId);
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
    ).toMatchObject({ ...outcomeSchema.parse(result), narration: expect.stringContaining(result.narration) });
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
describe('GM narration validation', () => {
  it('routes an unselected investigation ability through the saved utility check', async () => {
    const context = resolveContext();
    const member = context.members[0];
    const ability = member.character.abilities.find((ability) => ability.kind === 'utility')!;
    context.turn.actions[0].text = 'I used my ability to investigate the platform.';
    const check = {
      memberId: member.id,
      stat: ability.stat,
      abilityName: ability.name,
      dc: 10,
      reason: context.turn.actions[0].text,
      mode: 'normal',
      lethal: false,
    };
    const outputs = [
      [
        {
          type: 'function_call',
          namespace: 'game',
          name: 'roll_check',
          call_id: 'investigate',
          arguments: JSON.stringify(check),
        },
      ],
      [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }],
    ];
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      stream([
        event({ type: 'response.completed', response: { status: 'completed', output: outputs.shift() } }),
      ]),
    );
    const roll = vi.fn((input: Check): Roll => ({
      ...input,
      id: randomUUID(),
      dice: [12, 8],
      modifier: 0,
      total: 12,
      success: true,
      source: 'Test',
    }));
    const tools = Object.assign(roll, {
      startCombat: vi.fn(),
      combat: vi.fn(),
      completeChallenge: vi.fn(),
      offerLoot: vi.fn(),
    });
    const gm = new ChatGPTGM(
      { accessToken: async () => 'test-token' } as unknown as ChatGPTAuth,
      'owner',
      'test-model',
      fetcher as typeof fetch,
    );
    await gm.resolve(context, tools);
    expect(roll).toHaveBeenCalledExactlyOnceWith(check);
    expect(context.turn.actions[0].abilityName).toBeUndefined();
    const request = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(request.instructions).toContain(
      "matching the acting character's saved ability names and descriptions",
    );
    expect(request.tools[0].tools[0].parameters.properties.abilityName.description).toContain(
      'inferred from their natural-language intent',
    );
  });
  it.each(['item', 'Mend'])(
    'executes a naturally requested %s through use_resource and retains its receipt',
    async (source) => {
      const context = resolveContext();
      const member = context.members[0];
      const item = member.state.inventory.find((item) => item.healing > 0)!;
      const ability = { ...member.character.abilities[0], name: 'Field Mend', effect: 'mend' as const };
      member.character.abilities.push(ability);
      context.turn.actions[0].text =
        source === 'item' ? 'I drink my potion.' : 'I use Field Mend to heal myself.';
      const usage = {
        memberId: member.id,
        itemId: source === 'item' ? item.id : null,
        abilityName: source === 'Mend' ? ability.name : null,
        targetId: null,
      };
      const receipt = {
        ...usage,
        targetId: member.id,
        sourceName: source === 'item' ? item.name : ability.name,
        restored: 6,
        state: { ...member.state, hp: member.state.maxHp },
        targetState: { ...member.state, hp: member.state.maxHp },
      };
      const outputs = [
        [
          {
            type: 'function_call',
            namespace: 'game',
            name: 'use_resource',
            call_id: 'healing',
            arguments: JSON.stringify(usage),
          },
        ],
        [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({ ...result, narration: `${receipt.sourceName} restores 6 HP.` }),
              },
            ],
          },
        ],
      ];
      const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) =>
        stream([
          event({ type: 'response.completed', response: { status: 'completed', output: outputs.shift() } }),
        ]),
      );
      const tools = combatTools();
      tools.useResource = vi.fn(() => receipt);
      const gm = new ChatGPTGM(
        { accessToken: async () => 'test-token' } as unknown as ChatGPTAuth,
        'owner',
        'test-model',
        fetcher as typeof fetch,
      );
      const outcome = await gm.resolve(context, tools);
      expect(tools.useResource).toHaveBeenCalledExactlyOnceWith(usage);
      expect(outcome.changes).toEqual([]);
      expect(outcome.narration).toContain(
        source === 'item' ? 'consuming one item' : 'spending its ability use',
      );
      expect(outcome.narration).toContain(`restoring 6 HP to ${member.character.name}`);
      const requests = fetcher.mock.calls.map(([_url, init]) => JSON.parse(init!.body as string));
      expect(requests[0].tools[0].tools.some((tool: { name: string }) => tool.name === 'use_resource')).toBe(
        true,
      );
      expect(requests[0].instructions).toContain('Positive narrative HP changes are forbidden');
      const saved = requests[1].input.find(
        (entry: { type: string; call_id?: string }) =>
          entry.type === 'function_call_output' && entry.call_id === 'healing',
      );
      expect(JSON.parse(saved.output)).toEqual(receipt);
    },
  );
  it('corrects an omitted utility check and keeps earlier tool results', async () => {
    const ctx = resolveContext();
    const memberId = ctx.members[0].id;
    const ability = ctx.members[0].character.abilities.find((ability) => ability.kind === 'utility')!;
    ctx.turn.actions[0].abilityName = ability.name;
    const check = {
      memberId,
      stat: ability.stat,
      abilityName: ability.name,
      dc: 10,
      reason: 'Inspect the gate.',
      mode: 'normal',
      lethal: false,
    };
    const message = {
      type: 'message',
      content: [{ type: 'output_text', text: JSON.stringify(result) }],
    };
    const call = (call_id: string, args: unknown) => ({
      type: 'function_call',
      namespace: 'game',
      name: 'roll_check',
      call_id,
      arguments: JSON.stringify(args),
    });
    const priorCheck = { ...check, memberId: randomUUID(), abilityName: null };
    const outputs = [[call('saved-check', priorCheck)], [message], [call('missing-tool', check)], [message]];
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      stream([
        event({ type: 'response.completed', response: { status: 'completed', output: outputs.shift() } }),
      ]),
    );
    const auth = { accessToken: async () => 'test-token' } as unknown as ChatGPTAuth;
    const roll = vi.fn((input: Check): Roll => ({
      ...input,
      id: randomUUID(),
      dice: [12],
      modifier: 1,
      total: 13,
      success: true,
      source: 'Test',
    }));
    const error = `The GM skipped Mira's utility ability "${ability.name}" (INT) for "Inspect the gate.".`;
    const validateResolution = vi.fn(() => {
      if (!roll.mock.calls.some(([input]) => input.memberId === memberId)) throw new GameError(error);
    });
    const tools: GameTools = Object.assign(roll, {
      startCombat: vi.fn(),
      combat: vi.fn(),
      completeChallenge: vi.fn(),
      offerLoot: vi.fn(),
      validateResolution,
    });
    const gm = new ChatGPTGM(auth, 'owner', 'test-model', fetcher as typeof fetch);
    await expect(gm.resolve(ctx, tools)).resolves.toMatchObject({
      ...outcomeSchema.parse(result),
      narration: expect.stringContaining(result.narration),
    });
    expect(validateResolution).toHaveBeenCalledTimes(2);
    expect(roll).toHaveBeenCalledTimes(2);
    const requests = fetcher.mock.calls.map(([_url, init]) => JSON.parse(init!.body as string));
    const correction = requests.at(-2).input.at(-1).content;
    expect(correction).toContain(error);
    expect(correction).toContain('Reuse existing saved checks and tool receipts');
    const saved = requests
      .at(-1)
      .input.find(
        (input: { call_id?: string; type: string }) =>
          input.type === 'function_call_output' && input.call_id === 'saved-check',
      );
    expect(JSON.parse(saved.output)).toMatchObject({ total: 13, memberId: priorCheck.memberId });
    expect(requests[0].tools[0].tools.map((tool: { name: string }) => tool.name)).not.toContain(
      'resolve_combat',
    );
  });
  it('keeps the named action in a mechanical failure after the model exhausts its retries', async () => {
    const fetcher = vi.fn(async () =>
      stream([
        event({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }],
          },
        }),
      ]),
    );
    const error = 'The GM skipped Mira’s utility check for "Inspect the gate.".';
    const tools: GameTools = Object.assign(vi.fn(), {
      startCombat: vi.fn(),
      combat: vi.fn(),
      completeChallenge: vi.fn(),
      offerLoot: vi.fn(),
      validateResolution: () => {
        throw new GameError(error);
      },
    });
    const auth = { accessToken: async () => 'test-token' } as unknown as ChatGPTAuth;
    const gm = new ChatGPTGM(auth, 'owner', 'test-model', fetcher as typeof fetch);
    await expect(gm.resolve(resolveContext(), tools)).rejects.toThrow(error);
    expect(fetcher).toHaveBeenCalledTimes(8);
  });
});
describe('server-driven combat phases', () => {
  it('interprets a named combat ability without requiring a UI selection', async () => {
    const context = combatContext();
    const ability = context.members[0].character.abilities.find((ability) => ability.kind === 'combat')!;
    ability.name = 'Cross Slash';
    context.turn.actions[0].text = 'Use the Cross Slash ability on the Gatekeeper.';
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(init!.body as string);
      const plan = JSON.parse(request.input[0].content).schemaExample;
      return stream([
        event({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(plan) }] }],
          },
        }),
      ]);
    });
    const gm = new ChatGPTGM(
      { accessToken: async () => 'test-token' } as unknown as ChatGPTAuth,
      'owner',
      'test-model',
      fetcher as typeof fetch,
    );
    const plan = await gm.planCombat(context);
    expect(plan.actions[0]).toMatchObject({ main: 'ability', abilityName: ability.name, stat: ability.stat });
    expect(context.turn.actions[0].abilityName).toBeUndefined();
  });
  it('requires JSON interpretation of vague normal attacks without optional function calls', async () => {
    const context = combatContext();
    const plan = await new PracticeGM().planCombat(context);
    const outputs = [result, plan];
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      stream([
        event({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [
              { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(outputs.shift()) }] },
            ],
          },
        }),
      ]),
    );
    const auth = { accessToken: async () => 'test-token' } as unknown as ChatGPTAuth;
    const gm = new ChatGPTGM(auth, 'owner', 'test-model', fetcher as typeof fetch);
    await expect(gm.planCombat(context)).resolves.toEqual(combatSchema.parse(plan));
    expect(plan.actions[0]).toMatchObject({
      main: 'attack',
      abilityName: null,
      weaponSlot: 'left',
      targetId: 'gatekeeper',
    });
    const requests = fetcher.mock.calls.map(([_url, init]) => JSON.parse(init!.body as string));
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => !request.tools)).toBe(true);
    expect(requests[0].instructions).toContain('Creatively fill unspecified action details');
    expect(requests[0].instructions).toContain('normal weapon attack');
    expect(requests[0].instructions).toContain('Never translate diplomacy into an attack');
    expect(requests[0].instructions).toContain('infer a requested combat ability');
    expect(requests[0].instructions).toContain('Never activate an ability the player did not request');
    expect(requests[1].input.at(-1).content).toContain('Correct these validation errors');
  });
  it('lets the server fill malformed combat interpretations after schema corrections fail', async () => {
    const fetcher = vi.fn(async () =>
      stream([
        event({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: '{"actions":[]}' }] }],
          },
        }),
      ]),
    );
    const auth = { accessToken: async () => 'test-token' } as unknown as ChatGPTAuth;
    const gm = new ChatGPTGM(auth, 'owner', 'test-model', fetcher as typeof fetch);
    await expect(gm.planCombat(combatContext())).resolves.toMatchObject({
      actions: [{ main: 'attack', abilityName: null, weaponSlot: 'left', targetId: 'gatekeeper' }],
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('preserves selected abilities and includes Downed healing targets without inventing their actions', async () => {
    const context = combatContext();
    const selected = context.members[0].character.abilities.find((ability) => ability.kind === 'combat')!;
    context.turn.actions[0].abilityName = selected.name;
    context.turn.actions.push({ memberId: randomUUID(), text: '', passed: true });
    const downed = resolveContext().members[0];
    downed.state.hp = 0;
    downed.state.conditions = ['Downed'];
    context.members.push(downed);
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      const value = JSON.parse(body.input[0].content).schemaExample;
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
    const gm = new ChatGPTGM(
      { accessToken: async () => 'test-token' } as unknown as ChatGPTAuth,
      'owner',
      'test-model',
      fetcher as typeof fetch,
    );
    const plan = await gm.planCombat(context);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({
      main: 'ability',
      abilityName: selected.name,
      stat: selected.stat,
    });
    const request = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    const supplied = JSON.parse(request.input[0].content);
    expect(supplied.members).toContainEqual(downed);
    expect(supplied.turn.roster).not.toContain(downed.id);
    expect(request.instructions).toContain('never invent actions for them');
    expect(request.instructions).toContain('optional minorTargetId');
    expect(request.instructions).toContain("Healing consumes the healer's item");
    expect(request.instructions).toContain('dead characters cannot be healed');
  });
  it('interprets local movement and a crying farewell without inventing attacks or routine checks', async () => {
    const context = combatContext();
    context.members[0].character.name = 'Vex';
    context.turn.actions[0].text = 'Move toward the nearby exit within this room.';
    const companion = resolveContext().members[0];
    companion.character.name = 'Ilyan';
    context.members.push(companion);
    context.turn.roster.push(companion.id);
    context.turn.actions.push({
      memberId: companion.id,
      text: 'Cry over our fallen friend and kiss them farewell.',
      passed: false,
    });
    context.scene.floor.atmosphere = 'Their fallen friend lies beside a nearby exit.';
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(init!.body as string);
      const data = JSON.parse(request.input[0].content);
      return stream([
        event({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: JSON.stringify(data.schemaExample) }],
              },
            ],
          },
        }),
      ]);
    });
    const gm = new ChatGPTGM(
      { accessToken: async () => 'test-token' } as unknown as ChatGPTAuth,
      'owner',
      'test-model',
      fetcher as typeof fetch,
    );
    const plan = await gm.planCombat(context);
    expect(plan.actions.map((action) => action.main)).toEqual(['move', 'interact']);
    for (const [index, action] of plan.actions.entries()) {
      expect(action).toMatchObject({
        description: context.turn.actions[index].text,
        abilityName: null,
        minor: 'none',
        minorItemId: null,
        weaponSlot: null,
        targetId: null,
      });
      expect(action.dc).toBeUndefined();
      expect(action.effect).toBeUndefined();
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
    const request = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(request).not.toHaveProperty('tools');
    expect(request.instructions).toContain("Preserve the player's primary intent");
    expect(request.instructions).toContain(
      'Movement, crying, kissing farewell and other gestures are not attacks',
    );
    expect(request.instructions).toContain('do not add arbitrary blockers or checks');
    expect(request.instructions).toContain('omit dc for routine acts');
    expect(request.instructions).toContain('Explicit attempts to leave the fight use main:"flee"');
    expect(request.instructions).toContain("taking out an enemy's heart is an attempted attack");
  });
  it('accepts a meaningful risky movement check without replacing its intended act', async () => {
    const context = combatContext();
    context.turn.actions[0].text = 'Climb over the shattered railing toward the nearby exit.';
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(init!.body as string);
      const plan = JSON.parse(request.input[0].content).schemaExample;
      plan.actions[0] = { ...plan.actions[0], main: 'move', stat: 'DEX', dc: 15 };
      return stream([
        event({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(plan) }] }],
          },
        }),
      ]);
    });
    const gm = new ChatGPTGM(
      { accessToken: async () => 'test-token' } as unknown as ChatGPTAuth,
      'owner',
      'test-model',
      fetcher as typeof fetch,
    );
    const plan = await gm.planCombat(context);
    expect(plan.actions[0]).toMatchObject({
      main: 'move',
      stat: 'DEX',
      dc: 15,
      description: context.turn.actions[0].text,
      minor: 'none',
      weaponSlot: null,
    });
    expect(plan.actions[0].effect).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const request = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(request.instructions).toContain('only meaningful uncertain risk justifies a dc');
    expect(request.instructions).toContain('A character still fighting stays in the encounter');
    expect(request.instructions).toContain('An already Escaped character can keep exploring');
  });
  it.each([
    ['Move toward the nearby exit within this room.', 'move'],
    ['Cry over our fallen friend and kiss them farewell.', 'interact'],
  ])('preserves "%s" after malformed planning exhausts schema retries', async (text, main) => {
    const context = combatContext();
    context.turn.actions[0].text = text;
    const fetcher = vi.fn(async () =>
      stream([
        event({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: '{"actions":[]}' }] }],
          },
        }),
      ]),
    );
    const gm = new ChatGPTGM(
      { accessToken: async () => 'test-token' } as unknown as ChatGPTAuth,
      'owner',
      'test-model',
      fetcher as typeof fetch,
    );
    const plan = await gm.planCombat(context);
    expect(plan.actions[0]).toMatchObject({ main, description: text, minor: 'none', weaponSlot: null });
    expect(plan.actions[0].dc).toBeUndefined();
    expect(plan.actions[0].effect).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('narrates the authoritative receipt with no tools or duplicate mechanical effects', async () => {
    const context = combatContext();
    context.combatResult = {
      logs: ['Mira hits Gatekeeper for 5.', 'Gatekeeper misses Mira.'],
      encounter: context.scene.encounter!,
      characters: context.members.map((member) => ({
        id: member.id,
        name: member.character.name,
        state: member.state,
      })),
      loot: [],
    };
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      stream([
        event({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text: JSON.stringify({
                      ...result,
                      narration:
                        'Mira drives her boarding knife into the gatekeeper for 5 damage. Its counterattack misses.',
                      changes: [
                        {
                          type: 'hp',
                          memberId: context.members[0].id,
                          amount: -5,
                          reason: 'Duplicate damage.',
                        },
                      ],
                      xp: 40,
                      gold: 100,
                      safeRest: true,
                      nextFloor: { biome: 'Desert', atmosphere: 'Sunny', hazard: '' },
                    }),
                  },
                ],
              },
            ],
          },
        }),
      ]),
    );
    const tools = combatTools();
    const gm = new ChatGPTGM(
      { accessToken: async () => 'test-token' } as unknown as ChatGPTAuth,
      'owner',
      'test-model',
      fetcher as typeof fetch,
    );
    const outcome = await gm.resolve(context, tools);
    expect(outcome).toMatchObject({ changes: [], xp: 0, gold: 0, safeRest: false, nextFloor: null });
    expect(outcome.narration).toContain('boarding knife');
    expect(tools).not.toHaveBeenCalled();
    expect(tools.combat).not.toHaveBeenCalled();
    const request = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(request).not.toHaveProperty('tools');
    expect(JSON.parse(request.input[0].content).combatResult.logs).toEqual(context.combatResult.logs);
    expect(request.instructions).toContain('Never infer a death merely from zero HP');
    expect(request.instructions).toContain('only spent compatible ally healing helps a Downed character up');
  });
  it('narrates the original failed movement and a missed selected strike with its use spent', async () => {
    const context = combatContext();
    const ability = context.members[0].character.abilities.find((ability) => ability.kind === 'combat')!;
    context.turn.actions[0].abilityName = ability.name;
    context.members[0].state.abilityUses = { [ability.name]: 1 };
    const companion = resolveContext().members[0];
    companion.character.name = 'Vex';
    context.members.push(companion);
    context.turn.roster.push(companion.id);
    const movement = 'Climb over the shattered railing toward the nearby exit.';
    context.turn.actions.push({ memberId: companion.id, text: movement, passed: false });
    context.combatResult = {
      logs: [
        `Mira uses ${ability.name}; its encounter use is spent.`,
        `Mira misses Gatekeeper with ${ability.name}.`,
        `Vex fails to carry out their movement: ${movement}`,
        'Gatekeeper misses Vex.',
      ],
      encounter: context.scene.encounter!,
      characters: context.members.map((member) => ({
        id: member.id,
        name: member.character.name,
        state: member.state,
      })),
      loot: [],
    };
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      stream([
        event({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text: JSON.stringify({
                      ...result,
                      narration: '',
                      eventNarrations: {
                        'combat:1': 'Mira commits her technique, but the gatekeeper steps outside its reach.',
                        'combat:2':
                          'Vex attempts the climb, but loose stone prevents progress toward the exit.',
                      },
                    }),
                  },
                ],
              },
            ],
          },
        }),
      ]),
    );
    const gm = new ChatGPTGM(
      { accessToken: async () => 'test-token' } as unknown as ChatGPTAuth,
      'owner',
      'test-model',
      fetcher as typeof fetch,
    );
    const tools = combatTools();
    const outcome = await gm.resolve(context, tools);
    for (const fact of context.combatResult.logs) expect(outcome.narration).toContain(fact);
    expect(outcome.narration).toContain('loose stone prevents progress');
    expect(outcome.narration).not.toContain('remains available');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(tools).not.toHaveBeenCalled();
    const request = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(request).not.toHaveProperty('tools');
    expect(request.instructions).toContain('A failed movement check is failed movement, not a weapon attack');
    expect(request.instructions).toContain(
      'An attempted selected strike consumes its encounter use on a miss as well as a hit',
    );
    expect(request.instructions).toContain('Failure changes the result, not the intended act');
    const data = JSON.parse(request.input[0].content);
    expect(data.combatResult.characters[0].state.abilityUses[ability.name]).toBe(1);
    expect(data.turn.actions[1].text).toBe(movement);
  });
  it.each(['invalid JSON', 'tool request'])(
    'uses saved combat facts after repeated %s, and keeps provider outages retryable',
    async (failure) => {
      const context = combatContext();
      context.combatResult = {
        logs: ['Mira hits Gatekeeper for 5.'],
        encounter: context.scene.encounter!,
        characters: [],
        loot: [],
      };
      const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) =>
        stream([
          event({
            type: 'response.completed',
            response: {
              status: 'completed',
              output:
                failure === 'invalid JSON'
                  ? [{ type: 'message', content: [{ type: 'output_text', text: 'invalid JSON' }] }]
                  : [
                      {
                        type: 'function_call',
                        namespace: 'game',
                        name: 'resolve_combat',
                        call_id: 'repeat',
                        arguments: '{}',
                      },
                    ],
            },
          }),
        ]),
      );
      const auth = { accessToken: async () => 'test-token' } as unknown as ChatGPTAuth;
      const gm = new ChatGPTGM(auth, 'owner', 'test-model', fetcher as typeof fetch);
      const outcome = await gm.resolve(context, combatTools());
      expect(outcome.narration).toBe('Mira hits Gatekeeper for 5.');
      expect(fetcher).toHaveBeenCalledTimes(3);
      const correction = JSON.parse(fetcher.mock.calls[1][1]!.body as string);
      expect(correction.input.some((item: { type?: string }) => item.type === 'function_call')).toBe(false);
      const offline = new ChatGPTGM(
        auth,
        'owner',
        'test-model',
        vi.fn(async () => new Response('', { status: 503 })) as typeof fetch,
      );
      await expect(offline.resolve(context, combatTools())).rejects.toThrow('temporarily unavailable');
    },
  );
});
describe('complete player narration', () => {
  it.each([
    { 'combat:1': 'The gatekeeper clips Mira with its shield, dealing 5 damage.' },
    { 'combat:0': 123, 'combat:1': '   ', unknown: 'An unrelated invented event.' },
    null,
  ])(
    'retains a missing failed attack when prose only covers the character being hit',
    async (eventNarrations) => {
      const context = combatContext();
      const logs = ['Mira misses Gatekeeper with Boarding knife.', 'Gatekeeper hits Mira for 5.'];
      context.combatResult = { logs, encounter: context.scene.encounter!, characters: [], loot: [] };
      const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) =>
        stream([
          event({
            type: 'response.completed',
            response: {
              status: 'completed',
              output: [
                {
                  type: 'message',
                  content: [
                    {
                      type: 'output_text',
                      text: JSON.stringify({
                        ...result,
                        narration: 'Mira staggers as the gatekeeper strikes her.',
                        eventNarrations,
                      }),
                    },
                  ],
                },
              ],
            },
          }),
        ]),
      );
      const gm = new ChatGPTGM(
        { accessToken: async () => 'test-token' } as unknown as ChatGPTAuth,
        'owner',
        'test-model',
        fetcher as typeof fetch,
      );
      const tools = combatTools();
      const outcome = await gm.resolve(context, tools);
      expect(outcome.narration).toContain(logs[0]);
      expect(outcome.narration).not.toContain('An unrelated invented event.');
      expect(outcome).not.toHaveProperty('eventNarrations');
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(tools.combat).not.toHaveBeenCalled();
      const request = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
      expect(JSON.parse(request.input[0].content).narrationBeats).toEqual([
        { id: 'combat:0', fact: logs[0] },
        { id: 'combat:1', fact: logs[1] },
      ]);
      expect(request.instructions).toContain('unsuccessful attack');
    },
  );
  it.each(['Smoke hangs between the fighter and the locked gate.', ''])(
    'preserves detailed event prose in engine order with intro %j',
    async (intro) => {
      const context = combatContext();
      context.combatResult = {
        logs: ['Mira misses Gatekeeper with Boarding knife.', 'Gatekeeper hits Mira for 5.'],
        encounter: context.scene.encounter!,
        characters: [],
        loot: [],
      };
      const miss =
        'Mira lunges with her boarding knife, aiming for a gap beneath the gatekeeper’s raised shield. The guard pivots at the last moment, and her blade scrapes harmlessly across the iron rim. Her attack misses, leaving her exposed in the narrow passage.';
      const hit =
        'The gatekeeper answers immediately with a heavy shield strike. Mira tries to recover her footing, but the edge catches her shoulder and forces her back against the stonework. She suffers 5 damage, though she remains ready to fight.';
      const fetcher = vi.fn(async () =>
        stream([
          event({
            type: 'response.completed',
            response: {
              status: 'completed',
              output: [
                {
                  type: 'message',
                  content: [
                    {
                      type: 'output_text',
                      text: JSON.stringify({
                        ...result,
                        narration: intro,
                        eventNarrations: { 'combat:1': hit, 'combat:0': miss },
                      }),
                    },
                  ],
                },
              ],
            },
          }),
        ]),
      );
      const gm = new ChatGPTGM(
        { accessToken: async () => 'test-token' } as unknown as ChatGPTAuth,
        'owner',
        'test-model',
        fetcher as typeof fetch,
      );
      const outcome = await gm.resolve(context, combatTools());
      expect(outcome.narration).toContain(miss);
      expect(outcome.narration).toContain(hit);
      expect(outcome.narration).toContain(context.combatResult.logs[0]);
      expect(outcome.narration).toContain(context.combatResult.logs[1]);
      expect(outcome.narration.indexOf(miss)).toBeLessThan(outcome.narration.indexOf(hit));
      expect(outcome.narration.indexOf(context.combatResult.logs[0])).toBeLessThan(
        outcome.narration.indexOf(miss),
      );
      expect(outcome.narration.indexOf(context.combatResult.logs[1])).toBeLessThan(
        outcome.narration.indexOf(hit),
      );
      if (intro) expect(outcome.narration.startsWith(intro)).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('covers a newly rolled noncombat failure without asking the model to repair omitted prose', async () => {
    const context = resolveContext();
    const memberId = context.members[0].id;
    const waiting = resolveContext().members[0];
    waiting.character.name = 'Rowan';
    context.members.push(waiting);
    context.turn.roster.push(waiting.id);
    context.turn.actions.push({ memberId: waiting.id, text: '', passed: true });
    const initiative: Roll = {
      id: randomUUID(),
      memberId,
      stat: 'DEX',
      dc: 10,
      reason: 'Mira: initiative',
      mode: 'normal',
      lethal: false,
      dice: [19],
      modifier: 0,
      total: 19,
      success: true,
      source: 'Test',
      notation: '1d20',
    };
    context.turn.rolls.push(initiative);
    const ability = context.members[0].character.abilities.find((ability) => ability.kind === 'utility')!;
    context.turn.actions[0].abilityName = ability.name;
    const check = {
      memberId,
      stat: ability.stat,
      abilityName: ability.name,
      dc: 10,
      reason: 'Inspect the gate.',
      mode: 'normal',
      lethal: false,
    };
    const responses = [
      {
        type: 'function_call',
        namespace: 'game',
        name: 'roll_check',
        call_id: 'check',
        arguments: JSON.stringify(check),
      },
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: JSON.stringify({
              ...result,
              narration: 'The gate remains shrouded in shadow.',
              changes: [{ type: 'hp', memberId, amount: -4, reason: 'A catastrophic setback.' }],
              eventNarrations: {},
            }),
          },
        ],
      },
    ];
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      stream([
        event({
          type: 'response.completed',
          response: { status: 'completed', output: [responses.shift()] },
        }),
      ]),
    );
    const roll = vi.fn((input: Check): Roll => ({
      ...input,
      id: randomUUID(),
      dice: [1],
      modifier: 0,
      total: 1,
      success: false,
      critical: 'failure',
      source: 'Test',
    }));
    const tools = Object.assign(roll, {
      startCombat: vi.fn(),
      combat: vi.fn(),
      completeChallenge: vi.fn(),
      offerLoot: vi.fn(),
    });
    const gm = new ChatGPTGM(
      { accessToken: async () => 'test-token' } as unknown as ChatGPTAuth,
      'owner',
      'test-model',
      fetcher as typeof fetch,
    );
    const outcome = await gm.resolve(context, tools);
    expect(outcome.narration).toContain('Mira attempts: Inspect the gate.');
    expect(outcome.narration).toContain(ability.name);
    expect(outcome.narration).toContain("Mira's INT check fails (1 against DC 10)");
    expect(outcome.narration).toContain('natural 1');
    expect(outcome.narration).toContain('4 HP');
    expect(outcome.narration).toContain('A catastrophic setback.');
    expect(outcome.narration).toContain('Rowan waits and takes no action.');
    expect(outcome.narration).not.toContain('DEX check');
    expect(outcome.narration).not.toContain('19 against DC 10');
    expect(outcome.narration).not.toContain('Mira: initiative');
    expect(roll).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(context.turn.rolls).toEqual([initiative]);
    const request = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(JSON.parse(request.input[0].content).narrationBeats[0].id).toBe(`action:${memberId}`);
    expect(outcomeSchema.parse(outcome)).toEqual(outcome);
  });
});
describe('setting and character interactions', () => {
  it.each(['opening', 'noncombat', 'planning', 'combat'])(
    'applies ongoing lore immediately during %s without a confirmation stage',
    async (phase) => {
      const context = ['planning', 'combat'].includes(phase) ? combatContext() : resolveContext();
      context.config.setting = 'The fictional kingdom of Echoes';
      context.config.instructions = 'Resonant beings feel a chill beside grounding sigils.';
      context.config.custom = [{ key: 'House rule', value: 'Grounding never damages a resonant being.' }];
      context.members[0].character.species = 'Resonant being';
      context.members[0].character.concept = 'An explorer attuned to living echoes';
      context.members[0].character.traits[0] = {
        ...blankTrait('Resonance'),
        description: 'Nearby grounding sigils mute the resonant glow and cause a strong chill.',
      };
      const companion = resolveContext().members[0];
      companion.character.name = 'Rowan';
      companion.character.concept = 'A traveller carrying a grounding sigil';
      companion.character.traits[0] = {
        ...blankTrait('Grounding sigil'),
        description: 'A visible iron sigil carried openly.',
      };
      context.members.push(companion);
      context.turn.roster.push(companion.id);
      const fact = {
        kind: 'fact' as const,
        name: 'Resonance and grounding',
        detail: 'Rowan’s grounding sigil mutes Mira’s glow and causes a strong chill without damage.',
      };
      context.journal = [fact];
      if (phase === 'opening') {
        context.turn.number = 0;
        context.turn.actions = [];
      }
      if (phase === 'combat')
        context.combatResult = {
          logs: ['Mira misses Gatekeeper with Boarding knife.'],
          encounter: context.scene.encounter!,
          characters: [],
          loot: [],
        };
      const effect =
        'The iron sigil immediately mutes Mira’s glow, chilling her skin as its runes drink away the visible resonance.';
      const question = 'Mira, how do you respond?';
      const narration = `${effect} ${question}`;
      const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const request = JSON.parse(init!.body as string);
        const input = JSON.parse(request.input[0].content);
        return stream([
          event({
            type: 'response.completed',
            response: {
              status: 'completed',
              output: [
                {
                  type: 'message',
                  content: [
                    {
                      type: 'output_text',
                      text: JSON.stringify(
                        phase === 'planning'
                          ? input.schemaExample
                          : { ...result, narration, journal: [fact] },
                      ),
                    },
                  ],
                },
              ],
            },
          }),
        ]);
      });
      const gm = new ChatGPTGM(
        { accessToken: async () => 'test-token' } as unknown as ChatGPTAuth,
        'owner',
        'test-model',
        fetcher as typeof fetch,
      );
      const tools = combatTools();
      const before = structuredClone(context);
      if (phase === 'planning') {
        const plan = await gm.planCombat(context);
        expect(plan).toEqual(combatSchema.parse(await new PracticeGM().planCombat(context)));
      } else {
        const outcome = await gm.resolve(context, tools);
        expect(outcome.narration).toContain(narration);
        expect(outcome.narration.indexOf(effect)).toBeLessThan(outcome.narration.indexOf(question));
        expect(outcome.journal).toEqual([fact]);
        expect(outcome).toMatchObject({ choices: [], changes: [], xp: 0, gold: 0, nextFloor: null });
        for (const log of context.combatResult?.logs ?? []) expect(outcome.narration).toContain(log);
        if (phase === 'noncombat')
          expect(outcome.narration).toContain(`Mira attempts: ${context.turn.actions[0].text}`);
      }
      expect(context).toEqual(before);
      for (const tool of [
        tools,
        tools.combat,
        tools.startCombat,
        tools.completeChallenge,
        tools.offerLoot,
        tools.useResource,
      ])
        expect(tool).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(1);
      const request = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
      const input = JSON.parse(request.input[0].content);
      expect(input).toMatchObject({ config: context.config, members: context.members, journal: [fact] });
      const policy = request.instructions.match(
        /Setting and character continuity:[\s\S]*?contradict a resolved result\./,
      )?.[0];
      expect(policy).toContain('concepts, species, traits, abilities, equipment and conditions');
      expect(policy).toContain('Check passive interactions at the opening and when proximity');
      expect(policy).toContain('Explicit campaign lore and overrides take precedence');
      expect(policy).toContain('do not impose an effect by assuming proximity unsupported by the scene');
      expect(policy).toContain('brief open-ended question within the story');
      expect(policy).toContain('immediate and meaningful');
      expect(policy).toContain('within the current turn and supported mechanics');
      expect(policy).toContain('never wait for consent, confirmation or a separate reaction');
      expect(policy).toContain('Explain what changes, what the affected characters perceive');
      expect(policy).toContain('optional invitation for the normal next turn');
      expect(policy).toContain(
        'it must not require an extra response or submission, defer an effect or action',
      );
      expect(policy).toContain(
        'Do not introduce extra checks, obstacles or penalties merely to showcase lore',
      );
      expect(policy).toContain("without deciding a character's thoughts, dialogue or response");
      expect(policy).toContain(
        'Resolve already submitted actions and their consequences without a confirmation round',
      );
      expect(policy).toContain('public journal entries of kind:"fact", using a stable name');
      expect(policy).toContain('never expose hidden motives or undiscovered facts');
      expect(policy).toContain('saved tool/combat receipts remain authoritative');
    },
  );
});
describe('free-form player decisions', () => {
  it.each(['opening', 'noncombat', 'combat'])(
    'discards stale suggestions and warnings during %s without another model request',
    async (phase) => {
      const context = phase === 'combat' ? combatContext() : resolveContext();
      if (phase === 'opening') {
        context.turn.number = 0;
        context.turn.actions = [];
      }
      if (phase === 'combat')
        context.combatResult = {
          logs: ['Mira misses Gatekeeper with Boarding knife.'],
          encounter: context.scene.encounter!,
          characters: [],
          loot: [],
        };
      const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) =>
        stream([
          event({
            type: 'response.completed',
            response: {
              status: 'completed',
              output: [
                {
                  type: 'message',
                  content: [
                    {
                      type: 'output_text',
                      text: JSON.stringify({
                        ...result,
                        choices: ['Investigate the gate.', 'Attack the gatekeeper.'],
                        lethalWarning: { message: 'Confirm the danger before acting.' },
                      }),
                    },
                  ],
                },
              ],
            },
          }),
        ]),
      );
      const gm = new ChatGPTGM(
        { accessToken: async () => 'test-token' } as unknown as ChatGPTAuth,
        'owner',
        'test-model',
        fetcher as typeof fetch,
      );
      const outcome = await gm.resolve(context, combatTools());
      expect(outcome.choices).toEqual([]);
      expect(outcome.lethalWarning).toBeNull();
      expect(outcomeSchema.parse(outcome)).toEqual(outcome);
      expect(fetcher).toHaveBeenCalledTimes(1);
      const request = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
      expect(request.instructions).toContain('Do not provide action suggestions');
      expect(request.instructions).toContain('always return choices:[]');
      expect(request.instructions).toContain('creatively fill unspecified details');
      expect(request.instructions).not.toContain('choices must suit');
      expect(JSON.parse(request.input[0].content).task).not.toContain('offer the next choices');
    },
  );
  it('introduces practice scenes without suggested actions or instructions about what to do next', async () => {
    const context = resolveContext();
    context.turn.number = 0;
    context.turn.actions = [];
    const outcome = await new PracticeGM().resolve(context, combatTools());
    expect(outcome.choices).toEqual([]);
    expect(outcome.lethalWarning).toBeNull();
    expect(outcome.narration).not.toContain('describe their first action');
    expect(outcome.narration).not.toContain('Describe your approach');
  });
  it('resolves fatal risk in the submitted turn through a lethal check without a warning or confirmation round', async () => {
    const context = resolveContext();
    const memberId = context.members[0].id;
    const text = 'Leap across the shattered bridge above the lava.';
    context.turn.actions[0].text = text;
    const check = {
      memberId,
      stat: 'DEX',
      abilityName: null,
      dc: 20,
      reason: text,
      mode: 'normal',
      lethal: true,
    };
    const responses = [
      {
        type: 'function_call',
        namespace: 'game',
        name: 'roll_check',
        call_id: 'leap',
        arguments: JSON.stringify(check),
      },
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: JSON.stringify({
              ...result,
              narration: 'The broken bridge gives way beneath Mira.',
              lethalWarning: 'Are you sure you want to risk this leap?',
              eventNarrations: {},
            }),
          },
        ],
      },
    ];
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      stream([
        event({
          type: 'response.completed',
          response: { status: 'completed', output: [responses.shift()] },
        }),
      ]),
    );
    const roll = vi.fn((input: Check): Roll => ({
      ...input,
      id: randomUUID(),
      dice: [1],
      modifier: 0,
      total: 1,
      success: false,
      critical: 'failure',
      source: 'Test',
    }));
    const tools = Object.assign(roll, {
      startCombat: vi.fn(),
      combat: vi.fn(),
      completeChallenge: vi.fn(),
      offerLoot: vi.fn(),
    });
    const gm = new ChatGPTGM(
      { accessToken: async () => 'test-token' } as unknown as ChatGPTAuth,
      'owner',
      'test-model',
      fetcher as typeof fetch,
    );
    const outcome = await gm.resolve(context, tools);
    expect(roll).toHaveBeenCalledExactlyOnceWith(check);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(outcome.lethalWarning).toBeNull();
    expect(outcome.narration).toContain(text);
    expect(outcome.narration).toContain('natural 1');
    expect(outcome.narration).toContain('Mira dies');
    expect(context.turn.actions[0]).not.toHaveProperty('acceptsLethalRisk');
    const request = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(request.instructions).toContain('Resolve dangerous submitted actions immediately');
    expect(request.instructions).toContain('Never defer a submitted action');
    expect(request.tools[0].tools[0].parameters.properties.lethal.description).toContain(
      'submitted action and current situation',
    );
    expect(request.tools[0].tools[0].parameters.properties.lethal.description).toContain(
      'without a confirmation step',
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
