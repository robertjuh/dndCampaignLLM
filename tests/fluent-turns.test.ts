import { expect, it, vi } from 'vitest';
import type { GMContext, GameTools } from '../server/game';
import type { ChatGPTAuth } from '../server/auth';
import { ChatGPTGM } from '../server/providers';
import { assertEncounterProposal, completedEncounterProposal } from '../server/encounters';
import { normalizeAdjudicationStructure, validateAdjudication } from '../server/turn-resolution';
import { resolvePickups, requestsPickup } from '../server/turn-pickups';
import { baseItem, initialScene, initialState } from '../shared/rules';
import { ensureLocations } from '../shared/locations';
import { templateCharacter, type Encounter } from '../shared/schema';
import { actionId, type TurnAdjudication } from '../shared/turn-resolution';
import { advanceWorldProgression, worldProgressDue } from '../server/world-progression';
import { applyAdjudicationRepair, retainAdjudicationProgress } from '../server/adjudication-recovery';

it.each([false, true])(
  'expands a compact repair without replaying a retained action or pass (%s)',
  (passed) => {
    const { context, value } = fixture([
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ]);
    value.pickups = [];
    const [actor, companion] = value.actions;
    const here = context.scene.location.id!;
    const destination = '11111111-1111-4111-8111-111111111111';
    context.scene.encounterRisk = { danger: 'safe', reason: 'The dock is quiet.' };
    context.scene.places![destination] = {
      location: { id: destination, name: 'Control room', atmosphere: 'A staffed control room.', hazard: '' },
      encounter: null,
      loot: [],
      encounterRisk: { danger: 'safe', reason: 'An open public control room.' },
    };
    context.scene.worldMap!.nodes[destination] = { id: destination, name: 'Control room', visited: true };
    context.scene.worldMap!.connections.push({
      from: here,
      to: destination,
      label: 'Open passage',
      blocked: false,
      bidirectional: true,
    });
    context.turn.actions[0].text = 'Read the departure board and go to the control room.';
    actor.fact = actor.components.main!.fact = value.events[0].fact = 'Ragman reads the departure board.';
    if (passed) {
      context.turn.actions[1].passed = true;
      companion.status = 'passed';
      companion.basis = 'none';
      companion.fact = value.events[1].fact = 'Rustbeard waits.';
      companion.components = { main: null, minor: null };
      value.events[1].phase = null;
      value.events[1].result = null;
    }
    const retained = {
      value: validateAdjudication(context, value),
      locked: new Set([`${actor.memberId}:main`, `${companion.memberId}:main`]),
    };
    const before = structuredClone(retained.value);
    const move = {
      id: 'move-to-controls',
      sequence: 2,
      kind: 'action',
      actionId: actor.actionId,
      memberId: actor.memberId,
      phase: 'movement',
      effect: 'movement',
      result: 'success',
      locationRef: destination,
      fact: 'Ragman reaches the control room.',
      receiptRefs: [],
      dependsOn: [{ eventId: value.events[0].id, requires: 'success' }],
    };
    const main = { ...actor.components.main! } as Record<string, unknown>;
    delete main.fact; // Its fact is already retained, not duplicated in the repair's events.
    const patch = {
      actions: [
        {
          actionId: actor.actionId,
          memberId: actor.memberId,
          components: {
            main,
            minor: null,
            movement: {
              status: 'success',
              basis: 'routine',
              reason: 'The passage is open.',
              eventIds: [move.id],
              receiptRefs: [],
            },
          },
        },
      ],
      events: [move],
      memberLocations: [{ memberId: actor.memberId, locationId: destination, movementEventId: move.id }],
      separations: [{ memberIds: [actor.memberId, companion.memberId], eventId: move.id }],
    };
    const result = validateAdjudication(context, applyAdjudicationRepair(retained, patch, context));
    expect(result.actions[0].components.main).toEqual(before.actions[0].components.main);
    expect(result.actions[0].components.movement).toMatchObject({ status: 'success', fact: move.fact });
    expect(result.actions[1]).toEqual(before.actions[1]);
    expect(result.memberLocations).toEqual(patch.memberLocations);
    expect(result.events.slice(0, before.events.length)).toEqual(before.events);
    expect(result.events.some((event) => event.id === move.id)).toBe(true);
    expect(result.events.find((event) => event.id === result.separations![0].eventId)).toMatchObject({
      kind: 'world',
      actionId: null,
    });
    expect(retained.value).toEqual(before);
    expect(context.turn.rolls).toEqual([]);
  },
);

function fixture(ids = ['actor-0', 'actor-1']) {
  const members = ['Ragman', 'Rustbeard'].map((name, index) => {
    const character = templateCharacter(name);
    return {
      id: ids[index],
      playerId: `player-${index}`,
      playerName: name,
      characterId: `character-${index}`,
      character,
      state: initialState(character, name),
      active: true,
    };
  });
  const scene = ensureLocations(
    initialScene('Dock'),
    members.map((member) => member.id),
  );
  scene.loot = [{ ...baseItem('ampoules', 'Sealed ampoules', 'tool'), quantity: 1 }];
  const context: GMContext = {
    config: {
      ruleset: 'roguelike-v1',
      name: 'Fluent',
      setting: 'Dock',
      premise: 'Find a ship.',
      tone: '',
      language: 'English',
      instructions: '',
      custom: [],
      provider: 'chatgpt',
      model: 'test',
    },
    members,
    startingMembers: structuredClone(members),
    scene,
    history: [],
    journal: [],
    receipts: {},
    turn: {
      id: 'turn',
      number: 1,
      phase: 'resolving',
      roster: members.map((member) => member.id),
      actions: members.map((member) => ({
        memberId: member.id,
        text: 'I take the ampoules.',
        passed: false,
      })),
      rolls: [],
      result: null,
      error: null,
    },
  };
  const value: TurnAdjudication = {
    version: 2,
    turnId: 'turn',
    changes: [],
    journal: [],
    location: null,
    rewards: { xp: 0, currency: 0, reason: 'No reward.' },
    events: [],
    actions: [],
    pickups: [],
  };
  for (const member of members) {
    const id = `pickup:${member.id}`;
    const component = {
      status: 'success' as const,
      basis: 'routine' as const,
      fact: 'Collects ampoules.',
      reason: 'Accessible item.',
      eventIds: [id],
      receiptRefs: [],
    };
    value.actions.push({
      actionId: actionId('turn', member.id),
      memberId: member.id,
      ...component,
      components: { main: component, minor: null },
    });
    value.events.push({
      id,
      sequence: value.events.length,
      kind: 'action',
      actionId: actionId('turn', member.id),
      memberId: member.id,
      phase: 'main',
      result: 'success',
      fact: component.fact,
      receiptRefs: [],
      dependsOn: [],
      locationRef: scene.location.id,
    });
    value.pickups!.push({ eventId: id, memberId: member.id, itemId: 'ampoules' });
  }
  return { context, value };
}

function travelFixture() {
  const { context, value } = fixture([
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
  ]);
  value.pickups = [];
  const actor = value.actions[0];
  const destination = '11111111-1111-4111-8111-111111111111';
  context.turn.actions[0].text = 'Go to the control room.';
  context.scene.places![destination] = {
    location: { id: destination, name: 'Control room', atmosphere: 'An open control room.', hazard: '' },
    encounter: null,
    loot: [],
    encounterRisk: { danger: 'safe', reason: 'The staffed room is safe.' },
  };
  context.scene.worldMap!.nodes[destination] = { id: destination, name: 'Control room', visited: true };
  context.scene.worldMap!.connections.push({
    from: context.scene.location.id!,
    to: destination,
    label: 'Open passage',
    blocked: false,
    bidirectional: true,
  });
  const movement = { ...actor.components.main!, fact: 'Ragman reaches the control room.' };
  actor.components = { main: null, minor: null, movement };
  actor.fact = movement.fact;
  Object.assign(value.events[0], {
    phase: 'movement',
    effect: 'movement',
    locationRef: destination,
    fact: movement.fact,
  });
  value.memberLocations = [
    { memberId: actor.memberId, locationId: destination, movementEventId: movement.eventIds[0] },
  ];
  value.sceneFocus = destination;
  return { context, value };
}

it.each([false, true])(
  'retains a completed movement-only action without inventing a main action (other invalid=%s)',
  (otherInvalid) => {
    const { context, value } = travelFixture();
    const fallback = structuredClone(value);
    fallback.memberLocations = [];
    delete fallback.sceneFocus;
    for (const [index, action] of fallback.actions.entries()) {
      const part = {
        status: 'blocked' as const,
        basis: 'none' as const,
        processingFailure: true as const,
        fact: 'The action has not been processed.',
        reason: 'Processing failed.',
        eventIds: [`pending:${index}`],
        receiptRefs: [],
      };
      action.components = { main: part, minor: null };
      const { processingFailure: _pending, ...aggregate } = part;
      Object.assign(action, aggregate);
      fallback.events[index] = {
        id: part.eventIds[0],
        sequence: index,
        kind: 'action',
        memberId: action.memberId,
        actionId: action.actionId,
        phase: 'main',
        result: 'blocked',
        fact: part.fact,
        receiptRefs: [],
        dependsOn: [],
      };
    }
    if (otherInvalid) value.actions[1].components.main!.receiptRefs = ['invented-receipt'];
    const retained = retainAdjudicationProgress(context, value, fallback, (input) =>
      validateAdjudication(context, input),
    );
    expect(retained.value.actions[0].components.main).toBeNull();
    expect(retained.value.actions[0].components.movement).toEqual(value.actions[0].components.movement);
    expect(retained.value.actions[0].status).toBe('success');
    expect(retained.value.events.some((event) => event.id === 'pending:0')).toBe(false);
    expect(retained.value.memberLocations).toEqual(value.memberLocations);
    if (otherInvalid) expect(retained.value.actions[1].components.main?.processingFailure).toBe(true);
    else expect(retained.value.sceneFocus).toBe(value.sceneFocus);
  },
);

it.each(
  (['progress', 'empty', 'malformed', 'incomplete', 'unavailable'] as const).flatMap((repair) =>
    [false, true].map((movementOnly) => ({ repair, movementOnly })),
  ),
)(
  'tries pacing once and preserves legal actions when repair=$repair, movement-only=$movementOnly',
  async ({ repair, movementOnly }) => {
    const { context, value } = movementOnly ? travelFixture() : fixture();
    value.pickups = [];
    value.worldProgress = [];
    value.encounterRisks = [];
    for (const action of value.actions) {
      if (action.components.movement) continue;
      context.turn.actions.find((submitted) => submitted.memberId === action.memberId)!.text =
        'Inspect the controls.';
      action.fact = action.components.main!.fact = 'The traveller inspects the visible controls.';
      value.events.find((event) => event.actionId === action.actionId)!.fact = action.fact;
    }
    context.scene.encounterRisk = { danger: 'safe', reason: 'The dock is quiet.' };
    const location = context.scene.location.id!;
    context.scene.worldProgression = {
      version: 1,
      places: { [location]: { stalledTurns: 1, recentFacts: [] } },
    };
    const budget = (context.requestBudget = { used: 0, limit: 8 } as NonNullable<GMContext['requestBudget']>);
    const fact = 'The controls display an open departure channel and the dock release is ready.';
    const patch = {
      events: [
        {
          id: 'controls',
          kind: 'world',
          memberId: null,
          actionId: null,
          phase: 'aftermath',
          result: null,
          locationRef: location,
          fact,
          receiptRefs: [],
          dependsOn: [{ eventId: value.events[0].id, requires: 'occurrence' }],
        },
      ],
      worldProgress: [
        {
          locationId: location,
          eventId: 'controls',
          kind: 'discovery',
          thread: 'premise',
          journal: { kind: 'fact', name: 'Departure controls' },
        },
      ],
      journal: [{ kind: 'fact', name: 'Departure controls', detail: fact }],
    };
    const fetcher = vi.fn(async () => {
      if (repair === 'unavailable' && fetcher.mock.calls.length > 1)
        throw new Error('Pacing service unavailable.');
      const text =
        fetcher.mock.calls.length === 1
          ? JSON.stringify(value)
          : repair === 'malformed'
            ? '{'
            : repair === 'incomplete'
              ? JSON.stringify({
                  events: [{ id: 'unfinished-world', kind: 'world', fact: 'An incomplete repair.' }],
                })
              : JSON.stringify(repair === 'progress' ? patch : {});
      return new Response(
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
          },
        })}\n\n`,
      );
    });
    const tools = Object.assign(vi.fn(), {
      validateAdjudication: (input: unknown) => validateAdjudication(context, input),
      prepareEncounters: vi.fn(() => []),
    }) as unknown as GameTools;
    expect(() => validateAdjudication(context, value)).not.toThrow();
    const gm = new ChatGPTGM(
      { accessToken: async () => 'test' } as unknown as ChatGPTAuth,
      'owner',
      'test',
      fetcher,
    );
    const result = await gm.adjudicate(context, tools);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      budget.corrections?.filter((item) => item.feedback.startsWith('World progression is due')),
    ).toHaveLength(1);
    expect(result.actions.map((action) => action.components)).toEqual(
      value.actions.map((action) => action.components),
    );
    expect(context.turn.rolls).toEqual([]);
    expect(result.rewards.xp).toBe(0);
    const resolve = (ref: string) => (ref === 'current' ? location : ref);
    expect(() => validateAdjudication(context, result)).not.toThrow();
    expect(advanceWorldProgression(context, result, resolve)!.places[location].stalledTurns).toBe(
      repair === 'progress' ? 0 : 2,
    );
    expect(worldProgressDue(context, result, resolve)).toEqual(repair === 'progress' ? [] : [location]);
    if (repair !== 'progress') {
      expect(result.journal).toEqual([]);
      expect(budget.corrections?.some((item) => item.feedback.startsWith('Story progression deferred'))).toBe(
        true,
      );
      expect(budget.fallback).toBeUndefined(); // Ordinary narration still runs for legal outcomes.
    }
  },
);

it('resolves competing explicit pickups without mutating the frozen context or duplicating the item', () => {
  const { context, value } = fixture();
  const result = resolvePickups(context, value);
  expect(result.results).toHaveLength(1);
  expect(result.members[0].state.inventory.some((item) => item.id === 'ampoules')).toBe(true);
  expect(result.members[1].state.inventory.some((item) => item.id === 'ampoules')).toBe(false);
  expect(result.value.actions.map((action) => action.status)).toEqual(['success', 'blocked']);
  expect(result.scene.loot).toHaveLength(0);
  expect(context.scene.loot).toHaveLength(1);
  expect(value.actions[1].status).toBe('success');
  expect(resolvePickups(context, result.value).results).toHaveLength(1);
});

it('rejects inferred pickup, negative taking intent and invented effects, while expanding compact routine outcomes', () => {
  const { context, value } = fixture();
  for (const text of [
    'I inspect the ampoules.',
    'Ik neem de ampullen niet.',
    "I don't take them.",
    'I take a look.',
  ])
    expect(requestsPickup(text), text).toBe(false);
  for (const text of ['Ik neem een paar ampullen uit het krat.', 'I pick them up.', 'Pak het krat.'])
    expect(requestsPickup(text), text).toBe(true);
  context.turn.actions[0].text = 'I inspect the ampoules.';
  const declined = resolvePickups(context, value);
  expect(declined.value.actions[0].status).toBe('blocked');
  expect(declined.members[0].state.inventory.some((item) => item.id === 'ampoules')).toBe(false);
  delete value.pickups;
  const raw = structuredClone(value) as any;
  for (const action of raw.actions)
    for (const field of ['status', 'basis', 'fact', 'reason', 'receiptRefs', 'eventIds'])
      delete action[field];
  for (const action of raw.actions)
    for (const component of Object.values(action.components) as any[]) if (component) delete component.fact;
  raw.events[0].effect = 'interact';
  delete raw.events[0].receiptRefs;
  delete raw.events[0].memberId;
  delete raw.events[0].dependsOn;
  raw.narration = 'This prose must never become the accepted story.';
  const normalized = validateAdjudication(context, raw);
  expect(normalized.actions[0].status).toBe('success');
  expect(normalized.events[0].effect).toBeUndefined();
  expect(normalizeAdjudicationStructure(context, normalized)).toEqual(normalized);
  raw.events[0].effect = 'teleport';
  expect(() => validateAdjudication(context, raw)).toThrow('Invalid enum');
});

it('keeps capacity/quantity failure atomic and blocks success-dependent travel and discoveries', () => {
  const { context, value } = fixture();
  value.pickups = value.pickups!.slice(0, 1);
  context.members[0].state.inventory = Array.from({ length: 8 }, (_, i) => ({
    ...baseItem(`full-${i}`, `Full ${i}`, 'tool'),
    quantity: 1,
  }));
  const action = value.actions[0];
  value.events.push({
    id: 'move',
    sequence: value.events.length,
    kind: 'action',
    actionId: action.actionId,
    memberId: action.memberId,
    phase: 'movement',
    result: 'success',
    effect: 'movement',
    locationRef: 'new:deck',
    fact: 'Boards with the item.',
    receiptRefs: [],
    dependsOn: [{ eventId: action.eventIds[0], requires: 'success' }],
  });
  value.events.push({
    id: 'discovery',
    sequence: value.events.length,
    kind: 'world',
    actionId: null,
    memberId: null,
    phase: null,
    result: null,
    locationRef: 'new:deck',
    fact: 'A secret is revealed.',
    receiptRefs: [],
    dependsOn: [{ eventId: 'move', requires: 'success' }],
  });
  action.components.movement = {
    status: 'success',
    basis: 'routine',
    fact: 'Boards.',
    reason: 'With the key.',
    eventIds: ['move'],
    receiptRefs: [],
  };
  action.eventIds = [...action.eventIds, 'move'];
  value.memberLocations = [{ memberId: action.memberId, locationId: 'new:deck', movementEventId: 'move' }];
  value.placeUpdates = [{ ref: 'new:deck', location: { name: 'Deck', atmosphere: '', hazard: '' } }];
  value.arrivals = [{ locationId: 'new:deck', eventId: 'discovery' }];
  const result = resolvePickups(context, value);
  expect(result.results).toEqual([]);
  expect(result.scene.loot).toHaveLength(1);
  expect(result.value.memberLocations).toEqual([]);
  expect(result.value.placeUpdates).toEqual([]);
  expect(result.value.events.find((event) => event.id === 'move')!.result).toBe('blocked');
  expect(result.value.events.some((event) => event.id === 'discovery')).toBe(false);
  expect(result.value.actions[0].status).toBe('blocked');
  expect(() => validateAdjudication(context, result.value)).not.toThrow();
  context.members[0].state.inventory = [];
  value.pickups![0].quantity = 2;
  const insufficient = resolvePickups(context, value);
  expect(insufficient.results).toEqual([]);
  expect(insufficient.scene.loot[0].quantity).toBe(1);
  expect(insufficient.members[0].state.inventory).toEqual([]);
});

it('derives omitted pass outcomes locally without inventing an action or asking for another model response', () => {
  const { context, value } = fixture();
  delete value.pickups;
  context.turn.actions[1].passed = true;
  context.turn.actions[1].text = '';
  value.actions.pop();
  value.events.pop();
  const result = validateAdjudication(context, value);
  expect(result.actions[1]).toMatchObject({
    memberId: 'actor-1',
    status: 'passed',
    basis: 'none',
    components: { main: null, minor: null },
  });
  expect(result.events.at(-1)).toMatchObject({ memberId: 'actor-1', phase: null, result: null });
  expect(result.actions[1].eventIds).toHaveLength(1);
});

it('collects at the origin before independent movement and uses newly offered destination loot once', () => {
  const { context, value } = fixture();
  value.pickups = value.pickups!.slice(0, 1);
  const action = value.actions[0];
  value.events.push({
    id: 'move',
    sequence: value.events.length,
    kind: 'action',
    actionId: action.actionId,
    memberId: action.memberId,
    phase: 'movement',
    result: 'success',
    effect: 'movement',
    locationRef: 'new:deck',
    fact: 'Boards.',
    receiptRefs: [],
    dependsOn: [],
  });
  value.memberLocations = [{ memberId: action.memberId, locationId: 'new:deck', movementEventId: 'move' }];
  let result = resolvePickups(context, value);
  expect(result.results[0].locationId).toBe(context.scene.location.id);
  expect(result.value.memberLocations![0].locationId).toBe('new:deck');
  value.events = [value.events.at(-1)!, ...value.events.slice(0, -1)];
  value.events.forEach((event, sequence) => (event.sequence = sequence));
  value.events[1].locationRef = 'new:deck';
  value.placeUpdates = [{ ref: 'new:deck', location: { name: 'Deck', atmosphere: '', hazard: '' } }];
  context.receipts!.loot = {
    item: baseItem('ampoules', 'Sealed ampoules', 'tool'),
    locationId: 'new:deck',
    pendingPlacement: true,
  };
  result = resolvePickups(context, value);
  expect(result.results[0].locationId).toBe('new:deck');
  expect(result.members[0].state.inventory.filter((item) => item.id === 'ampoules')).toHaveLength(1);
  const known = '11111111-1111-4111-8111-111111111111';
  for (const event of value.events) if (event.locationRef === 'new:deck') event.locationRef = known;
  value.memberLocations![0].locationId = known;
  context.scene.places![known] = {
    location: { id: known, name: 'Known dock', atmosphere: '', hazard: '' },
    encounter: null,
    loot: [{ ...baseItem('existing', 'Existing cargo', 'tool'), quantity: 1 }],
  };
  (context.receipts!.loot as { locationId: string }).locationId = known;
  result = resolvePickups(context, value);
  expect(result.results[0].locationId).toBe(known);
  expect(result.scene.places![known].loot.map((item) => item.id)).toEqual(['existing']);
  expect(context.scene.places![known].loot.map((item) => item.id)).toEqual(['existing']);
});

it('resumes a complete encounter checkpoint with zero model requests and exact frozen actions/rewards', async () => {
  const { context, value } = fixture();
  delete value.pickups;
  context.receipts!.encounterProposal = structuredClone(value);
  const locationId = context.scene.location.id!;
  context.receipts!.encounterChecks = {
    [locationId]: {
      locationId,
      memberIds: context.turn.roster,
      danger: 'dangerous',
      reason: 'The captain saw the intruders.',
      die: 1,
      triggered: true,
    },
  };
  const encounter: Encounter = {
    enemies: [
      {
        id: 'captain',
        name: 'Captain',
        tier: 'normal',
        hp: 18,
        maxHp: 18,
        defense: 12,
        attack: 2,
        damage: '1d8',
        description: 'A captain.',
        tactic: 'Defend the ship.',
        onHit: null,
        initiative: 20,
        conditions: [],
      },
    ],
    round: 1,
    initiative: [],
    victory: false,
    escaped: false,
  };
  context.receipts!.startCombatByLocation = { [locationId]: encounter };
  const fetcher = vi.fn();
  const gm = new ChatGPTGM({} as ChatGPTAuth, 'owner', 'test', fetcher as typeof fetch);
  const tools = Object.assign(vi.fn(), {
    startCombat: vi.fn(),
    combat: vi.fn(),
    offerLoot: vi.fn(),
    completeChallenge: vi.fn(),
    validateAdjudication: (next: unknown) => validateAdjudication(context, next),
    prepareEncounters: (next: TurnAdjudication) => {
      assertEncounterProposal(context, next, value);
      return [];
    },
  }) as GameTools;
  const result = await gm.adjudicate(context, tools);
  expect(fetcher).not.toHaveBeenCalled();
  expect(tools.startCombat).not.toHaveBeenCalled();
  expect(result.actions).toEqual(value.actions);
  expect(result.rewards).toEqual(value.rewards);
  expect(result.events.slice(0, value.events.length)).toEqual(value.events);
  expect(result.events.at(-1)).toMatchObject({
    phase: 'aftermath',
    receiptRefs: ['tool:startCombatByLocation'],
  });
  expect(encounter.round).toBe(1);
  delete (context.receipts!.startCombatByLocation as Record<string, Encounter>)[locationId];
  expect(completedEncounterProposal(context)).toBeUndefined();
});

it('keeps pickup before a subsequently triggered encounter while still blocking pickup in an existing fight', () => {
  const { context, value } = fixture();
  value.pickups = value.pickups!.slice(0, 1);
  const baseline = validateAdjudication(context, value);
  context.scene.encounter = { enemies: [], round: 1, initiative: [], victory: false, escaped: false };
  expect(resolvePickups(context, baseline).results).toEqual([]);
  context.receipts!.encounterProposal = structuredClone(baseline);
  context.receipts!.startCombatByLocation = { [context.scene.location.id!]: context.scene.encounter };
  const resumed = resolvePickups(context, baseline);
  expect(resumed.results).toHaveLength(1);
  expect(resumed.value.actions).toEqual(baseline.actions);
  expect(context.scene.loot).toHaveLength(1);
});

it('creates a missing progress journal entry from public evidence while rejecting invented thread identities', () => {
  const { context, value } = fixture();
  delete value.pickups;
  value.events.push({
    id: 'public-clue',
    sequence: value.events.length,
    kind: 'world',
    memberId: null,
    actionId: null,
    phase: null,
    result: null,
    locationRef: context.scene.location.id,
    receiptRefs: [],
    dependsOn: [],
    fact: 'A public departure board names the next boarding point.',
  });
  value.worldProgress = [
    {
      eventId: 'public-clue',
      locationId: context.scene.location.id!,
      kind: 'discovery',
      thread: 'premise',
      journal: { kind: 'fact', name: 'Departure board' },
    },
  ];
  const saved = validateAdjudication(context, value);
  expect(saved.journal).toContainEqual({
    kind: 'fact',
    name: 'Departure board',
    detail: value.events.at(-1)!.fact,
  });
  value.worldProgress[0].thread = 'invented:thread';
  expect(() => validateAdjudication(context, value)).toThrow('existing thread');
});
