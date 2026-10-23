import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Game, type GMContext, type GameMaster } from '../server/game';
import { openDatabase } from '../server/db';
import { PracticeGM, ChatGPTGM } from '../server/providers';
import type { ChatGPTAuth } from '../server/auth';
import { engineComponents, engineEvents, validateAdjudication } from '../server/turn-resolution';
import { applyNPCUpdates, journalWithNPCInteractions, validateNPCUpdates } from '../server/npcs';
import { applyFeatureUpdates } from '../server/scene-state';
import { npcReactionCandidates, validateNPCReactions } from '../server/npc-reactions';
import { normalizeCombatInput } from '../server/combat';
import { retainAdjudicationProgress, applyAdjudicationRepair } from '../server/adjudication-recovery';
import { environmentalFacts } from '../server/environment';
import { validateWorldMap } from '../server/world-map';
import { validateWorldProgression } from '../server/world-progression';
import { prepareEncounterChecks } from '../server/encounters';
import { initialScene, initialState, baseItem } from '../shared/rules';
import { ensureLocations, registerMap } from '../shared/locations';
import { enemySchema, templateCharacter, type Scene } from '../shared/schema';
import {
  actionId,
  aggregateComponents,
  factualNarration,
  type TurnAdjudication,
} from '../shared/turn-resolution';
import { interruptNarration } from './narration-interruption';

const settings = [
  {
    place: 'Hilltop court',
    destination: 'Outer garden',
    feature: 'Garden gate',
    a: 'Archivist Iona',
    b: 'Warden Sol',
    group: 'Household of Ash',
    language: 'English' as const,
  },
  {
    place: 'Orbital laboratory',
    destination: 'Transfer hub',
    feature: 'Pressure iris',
    a: 'Dr Vale',
    b: 'Technician Kes',
    group: 'Survey team',
    language: 'English' as const,
  },
  {
    place: 'Bosherberg',
    destination: 'Dorpsplein',
    feature: 'Portiek',
    a: 'Herbergier Noor',
    b: 'Bode Fen',
    group: 'Dorpsraad',
    language: 'Nederlands' as const,
  },
];
type Setting = (typeof settings)[number];
const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);

function scenery(s: Setting, memberIds: string[]): Scene {
  const scene = ensureLocations(initialScene(s.place), memberIds);
  const other = randomUUID();
  scene.places![other] = {
    location: { id: other, name: s.destination, atmosphere: 'A public meeting place.', hazard: '' },
    loot: [],
    encounter: null,
  };
  scene.worldMap!.nodes[other] = { id: other, name: s.destination, visited: true };
  scene.worldMap!.connections.push({
    from: scene.location.id!,
    to: other,
    label: s.feature,
    blocked: false,
    bidirectional: true,
  });
  const enemy = {
    ...enemySchema.parse({
      id: 'a',
      name: s.a,
      tier: 'normal',
      hp: 7,
      defense: 10,
      attack: 1,
      damage: '1d4',
      description: 'A known injured person.',
      tactic: 'Protect colleagues.',
    }),
    maxHp: 14,
    initiative: 10,
    withdrawn: true,
    conditions: ['Weakened'],
    equipment: [baseItem('personal-tool', 'Personal tool', 'tool')],
  };
  scene.npcs = Object.fromEntries(
    [
      ['a', s.a],
      ['b', s.b],
    ].map(([id, name]) => [
      id,
      {
        id,
        name,
        aliases: [],
        locationId: scene.location.id!,
        status: 'alive',
        allegiance: s.group,
        fact: `${name} is present at ${s.place}.`,
        ...(id === 'a' ? { enemy } : {}),
      },
    ]),
  );
  scene.features = {
    access: {
      id: 'access',
      name: s.feature,
      aliases: [],
      locationId: scene.location.id!,
      properties: { control: s.group, objective: 'unfinished' },
      route: { from: scene.location.id!, to: other },
      fact: `${s.feature} is open.`,
    },
  };
  return scene;
}

function context(s: Setting): GMContext {
  const members = ['Traveller', 'Companion'].map((name) => {
    const id = randomUUID(),
      character = templateCharacter(name);
    return {
      id,
      character,
      characterId: randomUUID(),
      playerId: randomUUID(),
      playerName: name,
      active: true,
      state: initialState(character, id),
    };
  });
  return {
    config: {
      ruleset: 'roguelike-v1',
      name: s.place,
      setting: s.place,
      premise: 'Meet the inhabitants.',
      language: s.language,
      tone: '',
      instructions: '',
      custom: [],
      provider: 'practice',
      model: '',
    },
    members,
    startingMembers: structuredClone(members),
    scene: scenery(
      s,
      members.map((member) => member.id),
    ),
    journal: [],
    history: [],
    receipts: {},
    turn: {
      id: randomUUID(),
      number: 1,
      phase: 'resolving',
      roster: members.map((member) => member.id),
      rolls: [],
      result: null,
      error: null,
      actions: members.map((member, i) => ({
        memberId: member.id,
        text: i ? '' : `Talk to ${s.a}.`,
        passed: !!i,
      })),
    },
  };
}

function proposal(c: GMContext): TurnAdjudication {
  const events = engineEvents(c);
  const actions = c.turn.actions.map((submitted, index) => {
    const id = actionId(c.turn.id, submitted.memberId);
    const expected = engineComponents(c, submitted.memberId);
    const own = events.filter((event) => event.actionId === id && event.phase === 'main');
    if (!own.length) {
      const event = {
        id: `act:${index}`,
        sequence: events.length,
        kind: 'action' as const,
        memberId: submitted.memberId,
        actionId: id,
        phase: submitted.passed ? null : ('main' as const),
        result: submitted.passed ? null : ('success' as const),
        fact: submitted.passed ? 'The companion waits.' : 'The traveller addresses the inhabitants.',
        receiptRefs: [],
        dependsOn: [],
        locationRef: c.scene.memberLocations![submitted.memberId],
      };
      events.push(event);
      own.push(event);
    }
    const main = submitted.passed
      ? null
      : {
          ...(expected.main ?? { status: 'success' as const, basis: 'routine' as const }),
          fact: own.map((event) => event.fact).join(' '),
          reason: 'The public circumstances support the outcome.',
          eventIds: own.map((event) => event.id),
          receiptRefs: [...new Set(own.flatMap((event) => event.receiptRefs))],
        };
    const components = { main, minor: null };
    return {
      actionId: id,
      memberId: submitted.memberId,
      ...aggregateComponents(components, submitted.passed),
      fact: own.map((event) => event.fact).join(' '),
      reason: 'The actual submitted act is resolved.',
      eventIds: own.map((event) => event.id),
      receiptRefs: main?.receiptRefs ?? [],
      components,
    };
  });
  return {
    version: 2,
    turnId: c.turn.id,
    actions,
    events,
    changes: [],
    journal: [],
    location: null,
    rewards: { xp: 0, currency: 0, reason: 'Conversation grants no automatic reward.' },
  };
}

function exchange(c: GMContext, value = proposal(c)) {
  const [a, b] = Object.values(c.scene.npcs!);
  value.events.push({
    id: 'exchange',
    sequence: value.events.length,
    kind: 'world',
    memberId: null,
    actionId: null,
    phase: null,
    result: null,
    locationRef: c.scene.location.id!,
    receiptRefs: [],
    dependsOn: [{ eventId: value.actions[0].eventIds[0], requires: 'occurrence' }],
    npcIds: [a.id, b.id],
    fact: `${a.name} asks ${b.name} about the local custom. ${b.name} explains it to the traveller and promises a meeting.`,
  });
  return value;
}
const resolve = (c: GMContext) => (ref: string) => (ref === 'current' ? c.scene.location.id! : ref);

describe.each(settings)('campaign-independent continuity at $place', (s) => {
  it('remembers player/NPC and NPC/NPC dialogue without rerolling or changing injuries and allegiance', () => {
    const c = context(s),
      before = structuredClone(c);
    const value = validateAdjudication(c, exchange(c));
    expect(c).toEqual(before);
    expect(validateAdjudication(c, value)).toEqual(value);
    applyNPCUpdates(c.scene, value, resolve(c));
    expect(c.scene.npcs!.a).toMatchObject({
      allegiance: s.group,
      enemy: { hp: 7, maxHp: 14, conditions: ['Weakened'] },
    });
    expect(c.scene.npcs!.b.fact).toBe(value.events.at(-1)!.fact);
    const previous = [{ kind: 'npc' as const, name: s.b, detail: 'An earlier promise remains binding.' }];
    const journal = journalWithNPCInteractions([], c.scene, value.events, previous);
    expect(journal.find((entry) => entry.name === s.b)!.detail).toContain(previous[0].detail);
    expect(journal.find((entry) => entry.name === s.b)!.detail).toContain('promises a meeting');
    expect(journalWithNPCInteractions(journal, c.scene, value.events, previous)).toEqual(journal);
    expect(c.turn.rolls).toHaveLength(0);
  });

  it('keeps failed persuasion failed while remembering an independently resolved NPC answer', () => {
    const c = context(s);
    c.turn.rolls.push({
      id: 'refusal',
      memberId: c.members[0].id,
      stat: 'CHA',
      dc: 15,
      mode: 'normal',
      lethal: false,
      reason: 'The request conflicts with an established commitment.',
      dice: [2],
      modifier: 0,
      total: 2,
      success: false,
      source: 'test',
    });
    const value = validateAdjudication(c, exchange(c));
    expect(value.actions[0]).toMatchObject({ status: 'failure', basis: 'check' });
    expect(value.events.at(-1)!.dependsOn[0]).toEqual({ eventId: 'check:refusal', requires: 'occurrence' });
    applyNPCUpdates(c.scene, value, resolve(c));
    expect(c.scene.npcs!.a.enemy!.hp).toBe(7);
    expect(value.rewards).toMatchObject({ xp: 0, currency: 0 });
    expect(c.turn.rolls).toHaveLength(1);
  });

  it('canonicalizes aliases consistently in both a dialogue event and its explicit state update', () => {
    const c = context(s),
      value = exchange(c);
    value.events.at(-1)!.npcIds![0] = 'alternate-a';
    value.npcUpdates = [
      { npcId: 'alternate-a', name: s.a, aliases: ['the host'], locationId: 'current', eventId: 'exchange' },
    ];
    const accepted = validateAdjudication(c, value);
    expect(accepted.events.at(-1)!.npcIds).toEqual(['a', 'b']);
    expect(accepted.npcUpdates!.map((update) => update.npcId).sort()).toEqual(['a', 'b']);
  });

  it('introduces a named new conversational NPC while retaining their public identity', () => {
    const c = context(s),
      value = exchange(c);
    value.events.at(-1)!.npcIds = ['new-guide'];
    value.events.at(-1)!.fact = 'Guide Ren introduces themself to the traveller and explains a local custom.';
    value.npcUpdates = [
      { npcId: 'new-guide', name: 'Guide Ren', locationId: 'current', eventId: 'exchange' },
    ];
    const accepted = validateAdjudication(c, value);
    applyNPCUpdates(c.scene, accepted, resolve(c));
    expect(c.scene.npcs!['new-guide']).toMatchObject({
      name: 'Guide Ren',
      status: 'alive',
      allegiance: null,
    });
  });

  it('allows a fighting NPC to speak without prose ending the fight or changing their HP', () => {
    const c = context(s),
      enemy = { ...c.scene.npcs!.a.enemy!, withdrawn: false };
    c.scene.encounter = { enemies: [enemy], round: 2, initiative: [], victory: false, escaped: false };
    const value = validateAdjudication(c, exchange(c));
    applyNPCUpdates(c.scene, value, resolve(c));
    expect(c.scene.encounter).toMatchObject({ victory: false, enemies: [{ hp: 7, withdrawn: false }] });
    expect(c.scene.npcs!.a).toMatchObject({ status: 'alive', enemy: { hp: 7 } });
  });

  it.each(['map', 'progress', 'danger'] as const)(
    'does not let a later arrival witness earlier remote %s evidence',
    (system) => {
      const c = context(s),
        value = exchange(c),
        other = c.scene.worldMap!.connections[0].to;
      const evidence = value.events.at(-1)!;
      evidence.npcIds = undefined;
      evidence.locationRef = other;
      const crossing = {
        ...value.events[0],
        id: 'late-arrival',
        sequence: value.events.length,
        effect: 'movement' as const,
        locationRef: other,
      };
      value.events.push(crossing);
      value.memberLocations = [
        { memberId: c.members[0].id, locationId: other, movementEventId: crossing.id },
      ];
      if (system === 'map') {
        value.mapUpdates = {
          locations: [{ ref: 'new:exit', name: 'Another exit' }],
          connections: [
            {
              from: other,
              to: 'new:exit',
              label: 'Exit',
              blocked: false,
              bidirectional: true,
              eventId: evidence.id,
            },
          ],
        };
        expect(() => validateWorldMap(c, value, resolve(c))).toThrow('occupied location');
      } else if (system === 'progress') {
        c.journal = [
          { kind: 'quest', name: 'Local agreement', detail: 'The meeting is still to be arranged.' },
        ];
        value.journal = [{ kind: 'quest', name: 'Local agreement', detail: evidence.fact }];
        value.worldProgress = [
          {
            locationId: other,
            eventId: evidence.id,
            kind: 'npc',
            thread: 'quest:Local agreement',
            journal: { kind: 'quest', name: 'Local agreement' },
          },
        ];
        expect(() => validateWorldProgression(c, value, resolve(c))).toThrow('character present');
      } else {
        value.encounterRisks = [
          {
            locationId: other,
            eventId: evidence.id,
            danger: 'dangerous',
            reason: 'An observed local threat.',
          },
        ];
        expect(() => prepareEncounterChecks(c, value, {})).toThrow('public local world evidence');
      }
    },
  );

  it.each(['closed-before', 'opens-before', 'closes-after'] as const)(
    'checks NPC movement at the actual event: %s',
    (timing) => {
      const c = context(s),
        value = proposal(c),
        route = c.scene.worldMap!.connections[0];
      c.scene.npcs!.b.locationId = route.to;
      route.blocked = timing === 'opens-before';
      const change = {
        id: 'access-change',
        sequence: 0,
        kind: 'world' as const,
        memberId: null,
        actionId: null,
        phase: null,
        result: null,
        locationRef: route.from,
        fact: `${s.feature} changes access.`,
        receiptRefs: [],
        dependsOn: [],
      };
      const arrival = { ...change, id: 'npc-arrival', fact: `${s.b} arrives at ${s.place}.` };
      value.events.push(...(timing === 'closes-after' ? [arrival, change] : [change, arrival]));
      value.events.forEach((event, sequence) => (event.sequence = sequence));
      value.mapUpdates = {
        locations: [],
        connections: [{ ...route, eventId: change.id, blocked: timing !== 'opens-before' }],
      };
      value.npcUpdates = [{ npcId: 'b', name: s.b, locationId: route.from, eventId: arrival.id }];
      if (timing === 'closed-before') expect(() => validateAdjudication(c, value)).toThrow('open adjacent');
      else expect(() => validateAdjudication(c, value)).not.toThrow();
    },
  );

  it('rejects an exchange observed only by a later arrival, and an earlier out-of-place participant', () => {
    const c = context(s),
      value = exchange(c),
      route = c.scene.worldMap!.connections[0];
    const conversation = value.events.at(-1)!;
    c.scene.npcs!.a.locationId = c.scene.npcs!.b.locationId = route.to;
    conversation.locationRef = route.to;
    const crossing = {
      ...value.events[0],
      id: 'late-arrival',
      locationRef: route.to,
      sequence: value.events.length,
      phase: 'movement' as const,
      effect: 'movement' as const,
    };
    value.events.push(crossing);
    value.memberLocations = [
      { memberId: c.members[0].id, locationId: route.to, movementEventId: crossing.id },
    ];
    expect(() => validateNPCUpdates(c, value, resolve(c))).toThrow('observed');
    // A later valid exchange cannot make the earlier impossible exchange disappear.
    value.npcUpdates = undefined;
    value.events.push({ ...conversation, id: 'later-exchange', sequence: value.events.length });
    expect(() => validateNPCUpdates(c, value, resolve(c))).toThrow('observer');
  });

  it('moves scenery only over a route open at its supporting event', () => {
    const c = context(s),
      value = exchange(c),
      route = c.scene.worldMap!.connections[0];
    c.scene.features!.access.locationId = route.to;
    value.events.push({
      ...value.events.at(-1)!,
      id: 'feature-arrival',
      sequence: value.events.length,
      npcIds: undefined,
      fact: `${s.feature} is moved to ${s.place}.`,
    });
    value.featureUpdates = [
      {
        featureId: 'access',
        name: s.feature,
        locationId: 'current',
        properties: {},
        eventId: 'feature-arrival',
      },
    ];
    value.mapUpdates = { locations: [], connections: [{ ...route, eventId: 'exchange', blocked: true }] };
    expect(() => validateAdjudication(c, value)).toThrow('open adjacent');
    route.blocked = true;
    value.mapUpdates.connections[0].blocked = false;
    expect(() => validateAdjudication(c, value)).not.toThrow();
  });

  it.each(['same-turn-npc', 'saved-feature', 'item', 'dead-speaker', 'unknown-speaker'] as const)(
    'rejects a conflicting identity or speaker: %s',
    (defect) => {
      const c = context(s),
        value = exchange(c);
      if (defect === 'same-turn-npc') {
        value.npcUpdates = [
          { npcId: 'new-entity', name: 'New entity', locationId: 'current', eventId: 'exchange' },
        ];
        value.featureUpdates = [
          {
            featureId: 'new-entity',
            name: 'New entity',
            locationId: 'current',
            properties: {},
            eventId: 'exchange',
          },
        ];
      }
      if (defect === 'saved-feature')
        value.npcUpdates = [{ npcId: 'access', name: s.feature, locationId: 'current', eventId: 'exchange' }];
      if (defect === 'item')
        value.npcUpdates = [
          { npcId: 'personal-tool', name: s.a, locationId: 'current', eventId: 'exchange' },
        ];
      if (defect === 'dead-speaker') c.scene.npcs!.b.status = 'dead';
      if (defect === 'unknown-speaker') value.events.at(-1)!.npcIds = ['invented'];
      expect(() => validateAdjudication(c, value)).toThrow();
    },
  );

  it('normalizes boolean access into a real route change and rejects contradictory values', () => {
    const c = context(s),
      value = exchange(c);
    value.featureUpdates = [
      {
        featureId: 'access',
        name: s.feature,
        locationId: 'current',
        properties: { Passable: false, objective: 'complete' },
        eventId: 'exchange',
      },
    ];
    const accepted = validateAdjudication(c, value);
    expect(accepted.mapUpdates!.connections[0].blocked).toBe(true);
    registerMap(c.scene, accepted.mapUpdates, {}, c.scene.location.id!);
    applyFeatureUpdates(c.scene, accepted, resolve(c));
    expect(c.scene.features!.access.properties).toEqual({ control: s.group, objective: 'complete' });
    c.scene.features!.access.properties.passable = true; // Legacy duplicate cannot override the map.
    expect(environmentalFacts(c)['feature:access']).toContain('Passage: blocked');
    expect(environmentalFacts(c)['feature:access']).not.toContain('"passable":true');
    value.featureUpdates![0].passable = true;
    expect(() => validateAdjudication(c, value)).toThrow('contradictory passability');
  });

  it('retains an independent NPC exchange when an unrelated action is invalid and prevents replacement', () => {
    const c = context(s);
    c.turn.actions[1] = { memberId: c.members[1].id, text: 'Cross to the next place.', passed: false };
    const candidate = exchange(c),
      route = c.scene.worldMap!.connections[0];
    candidate.events.at(-1)!.dependsOn = []; // A witnessed exchange is independent of that move.
    candidate.memberLocations = [
      { memberId: c.members[1].id, locationId: route.to, movementEventId: 'missing' },
    ];
    const validate = (input: unknown) => validateAdjudication(c, input);
    const retained = retainAdjudicationProgress(c, candidate, proposal(c), validate);
    expect(retained.value.events.some((event) => event.id === 'exchange')).toBe(true);
    expect(retained.value.npcUpdates!.map((update) => update.npcId).sort()).toEqual(['a', 'b']);
    expect(retained.value.memberLocations).toEqual([]);
    expect(() =>
      applyAdjudicationRepair(
        retained,
        { events: [{ ...candidate.events.at(-1), fact: 'A replacement conversation.' }] },
        c,
      ),
    ).toThrow('retained event');
  });

  it('discards an invalid standalone state change without discarding an independent conversation', () => {
    const c = context(s),
      candidate = exchange(c);
    candidate.events.at(-1)!.dependsOn = [];
    candidate.events.push({
      ...candidate.events.at(-1)!,
      npcIds: undefined,
      id: 'bad-state',
      sequence: candidate.events.length,
      fact: `${s.feature} has an unsupported state.`,
    });
    candidate.featureUpdates = [
      {
        featureId: 'access',
        name: s.feature,
        locationId: 'current',
        properties: { passable: false },
        passable: true,
        eventId: 'bad-state',
      },
    ];
    const retained = retainAdjudicationProgress(c, candidate, proposal(c), (input) =>
      validateAdjudication(c, input),
    );
    expect(retained.value.actions[0].status).toBe('success');
    expect(retained.value.events.some((event) => event.id === 'exchange')).toBe(true);
    expect(retained.value.featureUpdates).toEqual([]);
    expect(retained.value.npcUpdates!.map((update) => update.npcId).sort()).toEqual(['a', 'b']);
  });

  it('keeps witnessed progress before departure when an unrelated effect needs recovery', () => {
    const c = context(s);
    c.members = c.members.slice(0, 1);
    c.turn.actions = c.turn.actions.slice(0, 1);
    c.turn.roster = [c.members[0].id];
    const candidate = exchange(c),
      action = candidate.actions[0];
    const conversation = candidate.events.at(-1)!;
    const other = c.scene.worldMap!.connections[0].to;
    candidate.events.push({
      ...candidate.events[0],
      id: 'depart',
      sequence: candidate.events.length,
      effect: 'movement',
      phase: 'movement',
      locationRef: other,
      fact: 'The traveller leaves after the conversation.',
    });
    action.components.movement = {
      status: 'success',
      basis: 'routine',
      fact: 'The traveller crosses the open passage.',
      reason: 'The conversation precedes ordinary departure.',
      receiptRefs: [],
      eventIds: ['depart'],
    };
    action.eventIds.push('depart');
    candidate.memberLocations = [{ memberId: c.members[0].id, locationId: other, movementEventId: 'depart' }];
    candidate.journal = [{ kind: 'npc', name: s.b, detail: conversation.fact }];
    candidate.worldProgress = [
      {
        locationId: 'current',
        eventId: conversation.id,
        kind: 'npc',
        thread: 'premise',
        journal: { kind: 'npc', name: s.b },
      },
    ];
    candidate.events.push({
      ...conversation,
      id: 'bad-state',
      sequence: candidate.events.length,
      npcIds: undefined,
      dependsOn: [],
      locationRef: other,
      fact: `${s.feature} has an unsupported state.`,
    });
    candidate.featureUpdates = [
      {
        featureId: 'access',
        name: s.feature,
        locationId: other,
        properties: { passable: false },
        passable: true,
        eventId: 'bad-state',
      },
    ];
    const retained = retainAdjudicationProgress(c, candidate, proposal(c), (input) =>
      validateAdjudication(c, input),
    );
    expect(retained.value.memberLocations![0].locationId).toBe(other);
    expect(retained.value.worldProgress).toHaveLength(1);
    expect(retained.value.worldProgress![0].eventId).toBe(conversation.id);
    expect(retained.value.featureUpdates).toEqual([]);
  });

  it('accounts for established affected allies while allowing dialogue and deliberate nonintervention', () => {
    const c = context(s),
      enemy = { ...c.scene.npcs!.a.enemy!, withdrawn: false };
    c.scene.encounter = { enemies: [enemy], round: 1, initiative: [], victory: false, escaped: false };
    const [candidate] = npcReactionCandidates(c);
    expect(candidate.npcId).toBe('b');
    expect(() => validateNPCReactions(c, [], true)).toThrow('Account for affected NPCs');
    const response = {
      ...candidate,
      enemy: null,
      reason: 'An established commitment calls for negotiation.',
      fact: `${s.b} calls to ${s.a} and asks the traveller to explain the dispute.`,
    };
    expect(validateNPCReactions(c, [response], true)).toEqual([response]);
    const fallback = normalizeCombatInput(c, { actions: [{ memberId: c.members[0].id, main: 'interact' }] });
    expect(fallback.npcReactions).toHaveLength(1);
    expect(fallback.npcReactions![0].enemy).toBeNull();
    expect(c.scene.encounter.enemies).toHaveLength(1);
    expect(c.turn.rolls).toHaveLength(0);
    c.receipts = { npcReactionsByLocation: { [c.scene.location.id!]: { reactions: [response] } } };
    expect(validateNPCReactions(c, [response], true)).toEqual([response]);
    expect(() => validateNPCReactions(c, [], true)).toThrow('immutable');
  });

  it.each(['narrator-failure', 'storage-interruption'] as const)(
    'preserves a multi-turn social/access sequence through %s and restart',
    async (fault) => {
      const db = openDatabase(':memory:');
      cleanup.push(() => db.close());
      const practice = new PracticeGM(),
        draw = vi.fn((sides: number) => Math.min(sides, 12));
      let inject = true;
      const adjudicate = vi.fn(
        async (c: GMContext, tools: Parameters<NonNullable<GameMaster['adjudicate']>>[1]) => {
          if (!c.turn.number) return practice.adjudicate(c, tools);
          const value = exchange(c);
          if (c.turn.number > 1)
            expect(c.journal.find((entry) => entry.name === s.b)!.detail).toContain('promises a meeting');
          if (c.turn.number === 2)
            value.events.at(-1)!.fact =
              `${s.b} disagrees with ${s.a} about the custom, while acknowledging the earlier meeting agreement.`;
          if (c.turn.number === 1 || c.turn.number === 3)
            value.featureUpdates = [
              {
                featureId: 'access',
                name: s.feature,
                locationId: 'current',
                properties: { passable: c.turn.number === 3, objective: 'complete' },
                eventId: 'exchange',
              },
            ];
          return value;
        },
      );
      const provider: GameMaster = {
        adjudicate,
        narrate: async (resolution, config) => {
          if (resolution.npcStates?.some((npc) => npc.id === 'b') && inject) {
            inject = false;
            if (fault === 'storage-interruption')
              interruptNarration(db, 'Interrupted after a public exchange.');
            throw new Error('Narrator connection dropped.');
          }
          return factualNarration(resolution, config.language);
        },
      };
      let game = new Game(db, () => provider, draw);
      const host = game.identify(),
        players = [game.identify(), game.identify()];
      const campaign = game.create(host.id, context(s).config);
      for (const [i, player] of players.entries()) {
        const character = templateCharacter(i ? 'Companion' : 'Traveller');
        character.selectedEquipmentIds = character.equipmentOptions.slice(0, 2).map((item) => item.id);
        game.join(campaign.inviteCode!, player.id, game.saveCharacter(player.id, character).id);
      }
      game.start(campaign.id, host.id);
      await game.idle();
      const snapshot = () => game.snapshot(campaign.id, host.id);
      const scene = scenery(
        s,
        snapshot().members.map((member) => member.id),
      );
      db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(scene), campaign.id);
      const positions = structuredClone(scene.memberLocations),
        rolls = draw.mock.calls.length;
      for (let turn = 1; turn <= 3; turn++) {
        const turnId = snapshot().turn!.id;
        game.submit(campaign.id, players[0].id, turnId, `Ask ${s.a} about the local agreement.`, false);
        game.submit(campaign.id, players[1].id, turnId, '', true);
        await game.idle();
        if (turn === 1 && fault === 'storage-interruption') {
          expect(snapshot().turn!.phase).toBe('failed');
          expect(snapshot().scene.worldMap!.connections[0].blocked).toBe(false);
          const calls = adjudicate.mock.calls.length;
          game = new Game(db, () => provider, draw);
          game.retry(campaign.id, host.id);
          await game.idle();
          expect(adjudicate).toHaveBeenCalledTimes(calls);
        }
        expect(snapshot().turn!.phase, snapshot().turn!.error ?? '').toBe('collecting');
        expect(snapshot().scene.worldMap!.connections[0].blocked).toBe(turn !== 3);
        expect(snapshot().scene.features!.access.properties).toEqual({
          control: s.group,
          objective: 'complete',
        });
        expect(snapshot().scene.npcs!.a).toMatchObject({ allegiance: s.group, enemy: { hp: 7, maxHp: 14 } });
        expect(snapshot().scene.memberLocations).toEqual(positions);
        expect(snapshot().journal.find((entry) => entry.name === s.b)!.detail).toContain(
          'promises a meeting',
        );
        game = new Game(db, () => provider, draw);
      }
      expect(draw).toHaveBeenCalledTimes(rolls);
      expect(snapshot().history.filter((turn) => turn.number > 0)).toHaveLength(3);
    },
  );
});

it.each(['repair', 'fallback'] as const)(
  'handles missing reaction coverage through the existing planner %s without forcing combat',
  async (mode) => {
    const s = settings[1],
      c = context(s),
      enemy = { ...c.scene.npcs!.a.enemy!, withdrawn: false };
    c.scene.encounter = { enemies: [enemy], round: 1, initiative: [], victory: false, escaped: false };
    const candidate = npcReactionCandidates(c)[0];
    const response = {
      ...candidate,
      reason: 'Known colleagues can discuss the dispute.',
      fact: `${s.b} asks ${s.a} to hear the traveller out.`,
      enemy: null,
    };
    const output = normalizeCombatInput(c, {
      npcReactions: [response],
      actions: [{ memberId: c.members[0].id, main: 'interact' }],
    });
    c.requestBudget = { used: 0, limit: 8 };
    let calls = 0;
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.instructions).toContain('NPC storytelling');
      expect(body.instructions).toContain('do not force violence');
      const data = JSON.parse(body.input[0].content);
      expect(data.affectedNPCs[0].npcId).toBe('b');
      const value = { ...output, npcReactions: calls++ && mode === 'repair' ? [response] : [] };
      return new Response(
        `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] } })}\n\n`,
      );
    }) as unknown as typeof fetch;
    const gm = new ChatGPTGM(
      { accessToken: async () => 'test' } as unknown as ChatGPTAuth,
      'owner',
      'test',
      fetcher,
    );
    const plan = await gm.planCombat(c);
    expect(fetcher).toHaveBeenCalledTimes(mode === 'repair' ? 2 : 3);
    if (mode === 'repair') expect(plan.npcReactions).toEqual([response]);
    else {
      expect(plan.npcReactions![0]).toMatchObject({ npcId: 'b', enemy: null });
      expect(plan.npcReactions![0].fact).toContain('last observed position');
      expect(c.requestBudget.fallback).toContain('NPC');
    }
    expect(plan.actions[0].main).toBe('interact');
  },
);
