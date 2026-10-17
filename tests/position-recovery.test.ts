import { expect, it, vi } from 'vitest';
import { templateCharacter, type Scene, type Roll } from '../shared/schema';
import { initialState } from '../shared/rules';
import { turnAdjudicationSchema } from '../shared/turn-resolution';
import { ChatGPTGM } from '../server/providers';
import {
  assertMovementPositions,
  normalizeAdjudicationStructure,
  validateAdjudication,
} from '../server/turn-resolution';
import { applyAdjudicationRepair } from '../server/adjudication-recovery';
import type { GMContext, GameTools } from '../server/game';
import type { ChatGPTAuth } from '../server/auth';
import cases from './fixtures/warhammer-movement.json';

const auth = { accessToken: async () => 'test' } as unknown as ChatGPTAuth;

function replay(saved: (typeof cases)[number]) {
  const members = saved.members.map(({ id, name }) => {
    const character = templateCharacter(name);
    return {
      id,
      playerId: id,
      playerName: name,
      characterId: id,
      character,
      active: true,
      state: initialState(character, id),
    };
  });
  const context: GMContext = {
    config: {
      ruleset: 'roguelike-v1',
      name: 'Movement replay',
      setting: 'Mountain roads',
      premise: '',
      tone: '',
      language: 'English',
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
      roster: members.map((member) => member.id),
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
  const tools = Object.assign(vi.fn(), {
    validateAdjudication: (input: unknown) => validateAdjudication(context, input),
  }) as unknown as GameTools;
  const value = turnAdjudicationSchema.parse(saved.adjudication);
  return { context, tools, value };
}

function completed(output: unknown) {
  return new Response(
    `data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }],
      },
    })}\n\n`,
  );
}

it.each(cases)('resolves recorded turn $number locally in one adjudication call', async (saved) => {
  const { context, tools, value } = replay(saved);
  const original = structuredClone(value);
  const fetcher = vi.fn(async () => completed(value)) as unknown as typeof fetch;
  const result = await new ChatGPTGM(auth, 'owner', 'model', fetcher).adjudicate(context, tools);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(context.requestBudget!.used).toBe(1);
  expect(tools).not.toHaveBeenCalled();
  expect(result.memberLocations).toEqual(original.memberLocations);
  for (const position of result.memberLocations!) {
    const proof = result.events.find((event) => event.id === position.movementEventId)!;
    expect(proof.phase === 'movement' || proof.effect === 'movement').toBe(true);
  }
  const normalized = normalizeAdjudicationStructure(context, value);
  expect(normalizeAdjudicationStructure(context, normalized)).toEqual(normalized);
  expect(value).toEqual(original);
  expect(context.turn.rolls).toEqual(saved.rolls);
  expect(context.turn.rolls.every((roll) => !roll.success)).toBe(true);
  if (saved.number === 6) {
    const split = result.events.filter((event) => event.id.startsWith('world:positions:'));
    expect(split).toHaveLength(1);
    expect(result.separations!.every((separation) => separation.eventId === split[0].id)).toBe(true);
    expect(result.actions.find((action) => action.components.movement)?.components.main?.status).toBe(
      'failure',
    );
  }
});

it('repairs an unresolved move with its actor and omitted event sequence, preserving other moves', async () => {
  const { context, tools, value } = replay(cases[0]);
  const corrected = turnAdjudicationSchema.parse(normalizeAdjudicationStructure(context, value));
  const rexmen = context.members.find((member) => member.character.name === 'Sir rexmen')!.id;
  const proof = value.events.find((event) => event.memberId === rexmen && event.kind === 'action')!;
  delete proof.locationRef; // Ambiguous metadata stays unresolved instead of inferring a move.
  let retained: Parameters<typeof applyAdjudicationRepair>[0];
  const requests: any[] = [];
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    requests.push(body);
    if (requests.length === 1) return completed(value);
    const input = JSON.parse(body.input[0].content);
    retained = { value: input.retained, locked: new Set(input.lockedComponents) };
    expect(input.unresolvedActions.map((action: any) => action.memberId)).toContain(rexmen);
    expect(input.lockedComponents).not.toContain(`${rexmen}:main`);
    expect(
      input.retained.events.some((event: any) => event.id === proof.id || event.id === 'party-split'),
    ).toBe(false);
    const { sequence: _sequence, ...event } = corrected.events.find((event) => event.id === proof.id)!;
    return completed({
      actions: corrected.actions.filter((action) => action.memberId === rexmen),
      events: [event],
      memberLocations: corrected.memberLocations!.filter((position) => position.memberId === rexmen),
    });
  }) as unknown as typeof fetch;
  const result = await new ChatGPTGM(auth, 'owner', 'model', fetcher).adjudicate(context, tools);
  expect(fetcher).toHaveBeenCalledTimes(2); // The existing single repair, never a new retry.
  expect(result.memberLocations).toEqual(expect.arrayContaining(corrected.memberLocations!));
  expect(result.events.map((event) => event.sequence)).toEqual(result.events.map((_, index) => index));
  expect(() =>
    applyAdjudicationRepair(
      retained!,
      {
        memberLocations: [{ ...retained!.value.memberLocations![0], locationId: 'current' }],
      },
      context,
    ),
  ).toThrow('cannot replace retained world evidence');
});

it.each(['missing', 'contradictory'])(
  'drops an incoherent %s position locally without a repair call',
  async (defect) => {
    const { context, tools, value } = replay(cases[0]);
    const normalized = turnAdjudicationSchema.parse(normalizeAdjudicationStructure(context, value));
    const rexmen = context.members.find((member) => member.character.name === 'Sir rexmen')!.id;
    const move = normalized.memberLocations!.find((position) => position.memberId === rexmen)!;
    const proofId = move.movementEventId;
    if (defect === 'missing')
      normalized.memberLocations = normalized.memberLocations!.filter((position) => position !== move);
    else move.locationId = normalized.memberLocations![0].locationId;
    const fetcher = vi.fn(async () => completed(normalized)) as unknown as typeof fetch;
    const result = await new ChatGPTGM(auth, 'owner', 'model', fetcher).adjudicate(context, tools);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.actions.find((action) => action.memberId === rexmen)?.status).toBe('blocked');
    expect(result.memberLocations!.some((position) => position.memberId === rexmen)).toBe(false);
    expect(result.events.some((event) => event.id === proofId || event.id === 'party-split')).toBe(false);
    expect(result.memberLocations).toHaveLength(2);
  },
);

it.each(['Inspect the footprints.', 'Do not go to the inn.'])('never infers movement for %s', (text) => {
  const { context, value } = replay(cases[0]);
  const actor = context.members.find((member) => member.character.name === 'Sir rexmen')!;
  context.turn.actions.find((action) => action.memberId === actor.id)!.text = text;
  expect(() => validateAdjudication(context, value)).toThrow('explicit movement effect');
});

it('allows movement within the current place without requiring a location change', () => {
  const { context, value } = replay(cases[1]);
  const move = value.events.find((event) => event.phase === 'movement')!;
  move.locationRef = context.scene.memberLocations![move.memberId!];
  value.events = [move];
  value.memberLocations = [];
  expect(() => assertMovementPositions(context, value)).not.toThrow();
});
