import { expect, it, vi } from 'vitest';
import { ChatGPTGM } from '../server/providers';
import {
  engineEvents,
  normalizeAdjudicationStructure,
  validateAdjudication,
} from '../server/turn-resolution';
import { normalizeAdjudicationReferences } from '../server/world-map';
import { prepareEncounterChecks } from '../server/encounters';
import { initialState } from '../shared/rules';
import { templateCharacter, type Scene, type Roll } from '../shared/schema';
import type { GMContext, GameTools } from '../server/game';
import type { ChatGPTAuth } from '../server/auth';
import type { TurnAdjudication } from '../shared/turn-resolution';
import saved from './fixtures/rock-reeders-checked-passage.json';

function fixture() {
  const members = saved.members.map(({ id, name, personality, appearance }) => {
    const character = { ...templateCharacter(name), personality, appearance };
    return {
      id,
      playerId: id,
      characterId: id,
      playerName: name,
      active: true,
      character,
      state: initialState(character, id),
    };
  });
  const context: GMContext = {
    config: {
      ruleset: 'roguelike-v1',
      name: 'Checked passage',
      setting: 'Rock caverns',
      premise: '',
      language: 'Nederlands',
      tone: '',
      instructions: '',
      custom: [],
      provider: 'practice',
      model: '',
    },
    members,
    startingMembers: structuredClone(members),
    scene: structuredClone(saved.scene) as unknown as Scene,
    turn: {
      id: saved.turnId,
      number: saved.number,
      phase: 'resolving',
      roster: members.map((m) => m.id),
      actions: structuredClone(saved.actions),
      rolls: structuredClone(saved.rolls) as Roll[],
      result: null,
      error: null,
    },
    history: [],
    journal: [],
    receipts: {},
    requestBudget: { used: 0, limit: 8 },
  };
  const proposal = () => {
    const value = normalizeAdjudicationStructure(
      context,
      normalizeAdjudicationReferences(context, saved.adjudication),
    ) as TurnAdjudication;
    return { ...value, events: [...engineEvents(context), ...value.events] };
  };
  return { context, proposal };
}

it('resolves the recorded checked passage and its new preview in one request with unchanged natural twenties', async () => {
  const { context } = fixture();
  const before = structuredClone(context);
  const roll = vi.fn(() => {
    throw new Error('Saved checks must not roll again');
  });
  const encounter = vi.fn(() => 6);
  const tools = Object.assign(roll, {
    validateAdjudication: (value: unknown) => validateAdjudication(context, value),
    prepareEncounters: (value: TurnAdjudication) =>
      prepareEncounterChecks(context, value, {}, encounter).required,
  }) as unknown as GameTools;
  const fetcher = vi.fn(
    async () =>
      new Response(
        `data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(saved.adjudication) }] }] } })}\n\n`,
      ),
  ) as unknown as typeof fetch;
  const result = await new ChatGPTGM(
    { accessToken: async () => 'test' } as unknown as ChatGPTAuth,
    'owner',
    'model',
    fetcher,
  ).adjudicate(context, tools);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(roll).not.toHaveBeenCalled();
  expect(encounter).toHaveBeenCalledOnce();
  expect(result.memberLocations).toEqual(saved.adjudication.memberLocations);
  expect(result.events.filter((event) => event.effect === 'movement').map((event) => event.id)).toEqual([
    'move:kwal',
    'move:glerron',
  ]);
  expect(context.turn.rolls).toEqual(before.turn.rolls);
  expect(context.members).toEqual(before.members);
  expect(context.requestBudget!.fallback).toBeUndefined();
});

it.each(['failed check', 'missing prerequisite', 'unrelated action'])(
  'does not infer a checked move from a %s',
  (defect) => {
    const { context } = fixture();
    const raw = structuredClone(saved.adjudication);
    if (defect === 'failed check') context.turn.rolls[0].success = false;
    if (defect === 'missing prerequisite') raw.events[0].dependsOn = [];
    if (defect === 'unrelated action') context.turn.actions[0].text = 'Inspect the stone here.';
    const result = normalizeAdjudicationStructure(
      context,
      normalizeAdjudicationReferences(context, raw),
    ) as TurnAdjudication;
    expect(result.events.find((event) => event.id === 'move:kwal')!.effect).toBeUndefined();
    expect(() =>
      validateAdjudication(context, { ...result, events: [...engineEvents(context), ...result.events] }),
    ).toThrow();
  },
);

it.each(['blocked', 'one-way'])(
  'keeps %s route restrictions when an arrival describes the return connection',
  (restriction) => {
    const { context, proposal } = fixture();
    const value = proposal();
    const destination = value.memberLocations![0].locationId;
    const origin = context.scene.location.id!;
    if (restriction === 'blocked') {
      context.scene.worldMap!.nodes[destination] = {
        id: destination,
        name: 'Lage spleetgang',
        visited: true,
      };
      context.scene.worldMap!.connections.push({
        from: origin,
        to: destination,
        label: 'Closed passage',
        blocked: true,
        bidirectional: true,
      });
    } else {
      Object.assign(value.mapUpdates!.connections[0], {
        from: destination,
        to: origin,
        bidirectional: false,
      });
    }
    expect(() => validateAdjudication(context, value)).toThrow(
      restriction === 'blocked' ? 'blocked' : 'one-way',
    );
  },
);
