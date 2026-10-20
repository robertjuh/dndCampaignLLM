import { expect, it } from 'vitest';
import type { GMContext } from '../server/game';
import { applyAdjudicationRepair } from '../server/adjudication-recovery';
import {
  advanceWorldProgression,
  validateWorldProgression,
  worldProgressionContext,
  JournalCapacityError,
  worldProgressDue,
} from '../server/world-progression';
import { initialScene, initialState } from '../shared/rules';
import { updateLocation } from '../shared/locations';
import { templateCharacter } from '../shared/schema';
import { actionId, type TurnAdjudication } from '../shared/turn-resolution';

function context(): GMContext {
  const members = ['a', 'b'].map((key) => {
    const character = templateCharacter(`Traveller ${key}`);
    character.motivation = 'Discover what happened to the missing caravan.';
    return {
      id: `member-${key}`,
      playerId: `player-${key}`,
      playerName: key,
      characterId: `character-${key}`,
      character,
      state: initialState(character, key),
      active: true,
    };
  });
  return {
    config: {
      ruleset: 'roguelike-v1',
      name: 'Caravan',
      setting: 'A trade road and an inn',
      premise: 'A caravan has disappeared from the road.',
      tone: 'Grounded',
      language: 'English',
      instructions: '',
      custom: [],
      provider: 'practice',
      model: '',
    },
    members,
    scene: {
      ...initialScene('Trade road'),
      location: { id: 'road', name: 'Trade road', atmosphere: 'A rain-soaked road.', hazard: '' },
      places: {
        inn: {
          location: { id: 'inn', name: 'Inn', atmosphere: 'An occupied inn.', hazard: '' },
          encounter: null,
          loot: [],
        },
      },
      memberLocations: { 'member-a': 'road', 'member-b': 'inn' },
    },
    turn: {
      id: 'turn-1',
      number: 1,
      phase: 'resolving',
      roster: members.map((member) => member.id),
      actions: members.map((member) => ({
        memberId: member.id,
        text: 'Investigate the caravan.',
        passed: false,
      })),
      rolls: [],
      result: null,
      error: null,
    },
    history: [],
    journal: [{ kind: 'quest', name: 'Missing caravan', detail: 'The caravan has not reached the inn.' }],
  };
}

function proposal(context: GMContext): TurnAdjudication {
  const actions = context.turn.actions.map((submitted) => {
    const id = actionId(context.turn.id, submitted.memberId);
    const component = {
      status: 'success' as const,
      basis: 'routine' as const,
      fact: 'The traveller investigates the visible surroundings.',
      reason: 'Ordinary investigation.',
      receiptRefs: [],
      eventIds: [`${id}:result`],
    };
    return {
      actionId: id,
      memberId: submitted.memberId,
      ...component,
      status: submitted.passed ? ('passed' as const) : component.status,
      components: { main: submitted.passed ? null : component, minor: null },
    };
  });
  return {
    version: 2,
    turnId: context.turn.id,
    actions,
    events: [],
    changes: [],
    journal: [],
    location: null,
    memberLocations: [],
    rewards: { xp: 0, gold: 0, reason: 'No new achievement.' },
    worldProgress: [],
  };
}

const resolve = (ref: string) => (ref === 'current' ? 'road' : ref === 'new:workshop' ? 'workshop' : ref);

function progress(value: TurnAdjudication, locationId = 'road') {
  const eventId = `world:survivor:${locationId}`;
  const fact = `A survivor at ${locationId} identifies the abandoned mill as the caravan's last stop.`;
  value.events.push({
    id: eventId,
    sequence: value.events.length,
    kind: 'world',
    actionId: null,
    memberId: null,
    locationRef: locationId,
    phase: 'aftermath',
    result: null,
    fact,
    receiptRefs: [],
    dependsOn: [],
  });
  value.journal.push({ kind: 'quest', name: 'Missing caravan', detail: fact });
  value.worldProgress!.push({
    locationId,
    eventId,
    kind: 'discovery',
    thread: 'quest:Missing caravan',
    journal: { kind: 'quest', name: 'Missing caravan' },
  });
  return value.events.at(-1)!;
}

it('counts once per occupied location and keeps pacing due without blocking a valid outcome', () => {
  const c = context();
  c.scene.memberLocations!['member-b'] = 'road';
  c.scene.worldProgression = advanceWorldProgression(c, proposal(c), resolve);
  expect(c.scene.worldProgression!.places.road.stalledTurns).toBe(1);
  c.scene.memberLocations!['member-b'] = 'inn';
  updateLocation(c.scene, { ...c.scene.places!.inn.location });
  c.turn.id = 'turn-2';
  c.turn.number = 2;
  c.turn.actions[1].passed = true;
  const value = proposal(c);
  expect(() => validateWorldProgression(c, value, resolve)).not.toThrow();
  expect(worldProgressDue(c, value, resolve)).toEqual(['road']);
  expect(advanceWorldProgression(c, value, resolve)!.places.road.stalledTurns).toBe(2);
  progress(value);
  expect(worldProgressDue(c, value, resolve)).toEqual([]);
  expect(() => validateWorldProgression(c, value, resolve)).not.toThrow();
  const state = advanceWorldProgression(c, value, resolve)!;
  expect(state.places.road.stalledTurns).toBe(0);
  expect(state.places.inn).toBeUndefined();
  expect(c.scene.worldProgression!.places.road.stalledTurns).toBe(1);
});

it('does not advance or force pacing for passes, orientation, blocked actions or engine-only combat', () => {
  for (const mode of ['pass', 'orientation', 'blocked', 'combat'] as const) {
    const c = context();
    c.scene.worldProgression = {
      version: 1,
      places: { road: { stalledTurns: 1, recentFacts: [] } },
    };
    if (mode === 'pass') c.turn.actions.forEach((action) => (action.passed = true));
    const value = proposal(c);
    for (const action of value.actions) {
      if (mode === 'orientation') action.intent = 'orientation';
      if (mode === 'blocked') {
        action.status = 'blocked';
        action.components.main!.status = 'blocked';
        action.components.main!.basis = 'none';
      }
      if (mode === 'combat') action.components.main!.basis = 'engine';
    }
    expect(() => validateWorldProgression(c, value, resolve)).not.toThrow();
    expect(advanceWorldProgression(c, value, resolve)).toEqual(c.scene.worldProgression);
  }
});

it('accepts first arrivals without thread progress even outside shared focus', () => {
  const c = context();
  const value = proposal(c);
  const action = value.actions.find((action) => action.memberId === 'member-b')!;
  value.events.push({
    id: 'move:b',
    sequence: 0,
    kind: 'action',
    actionId: action.actionId,
    memberId: 'member-b',
    phase: 'main',
    effect: 'movement',
    result: 'success',
    locationRef: 'new:workshop',
    fact: 'The traveller reaches the workshop.',
    receiptRefs: [],
    dependsOn: [],
  });
  value.memberLocations = [{ memberId: 'member-b', locationId: 'new:workshop', movementEventId: 'move:b' }];
  value.arrivals = [{ locationId: 'new:workshop', eventId: 'world:arrival' }];
  expect(() => validateWorldProgression(c, value, resolve)).not.toThrow();
  expect(advanceWorldProgression(c, value, resolve)!.places.workshop.stalledTurns).toBe(1);
  progress(value, 'new:workshop');
  expect(() => validateWorldProgression(c, value, resolve)).not.toThrow();
  expect(advanceWorldProgression(c, value, resolve)!.places.workshop.stalledTurns).toBe(0);
});

it('rejects unknown threads and remote/bookkeeping events, and persists missing journal increments locally', () => {
  const c = context();
  const value = proposal(c);
  const event = progress(value);
  value.worldProgress![0].thread = 'quest:An invented replacement mystery';
  expect(() => validateWorldProgression(c, value, resolve)).toThrow('existing thread');
  value.worldProgress![0].thread = 'premise';
  event.locationRef = 'inn';
  expect(() => validateWorldProgression(c, value, resolve)).toThrow('stated location');
  event.locationRef = 'road';
  event.presentation = 'log';
  expect(() => validateWorldProgression(c, value, resolve)).toThrow('public world event');
  delete event.presentation;
  value.journal.push({ ...value.journal[0] });
  expect(() => validateWorldProgression(c, value, resolve)).toThrow('one canonical journal update');
  value.journal.pop();
  value.journal[0].detail = c.journal[0].detail;
  expect(() => validateWorldProgression(c, value, resolve)).not.toThrow();
  expect(value.journal[0].detail).toContain(event.fact);
  expect(value.journal[0].detail).toContain(c.journal[0].detail);
});

it('rejects recycled world or search facts even when a new event ID and journal text are supplied', () => {
  const c = context();
  const value = proposal(c);
  const event = progress(value);
  c.scene.searches = { 'cart-ruts': { information: event.fact.toUpperCase(), rewardRolled: true } };
  expect(() => validateWorldProgression(c, value, resolve)).toThrow('Repeated facts');
  delete c.scene.searches;
  c.scene.worldProgression = {
    version: 1,
    places: { road: { stalledTurns: 0, recentFacts: [event.fact] } },
  };
  expect(() => validateWorldProgression(c, value, resolve)).toThrow('Repeated facts');
});

it('persists canonical progress instead of unsupported journal prose, preserving history and remaining idempotent', () => {
  const c = context();
  const value = proposal(c);
  const event = progress(value);
  value.journal[0].detail = 'An unrelated change claims the captives’ exact hiding place is now known.';
  expect(() => validateWorldProgression(c, value, resolve)).not.toThrow();
  expect(value.journal[0].detail).not.toContain('exact hiding place');
  expect(value.journal[0].detail).toContain(event.fact);
  expect(value.journal[0].detail).toContain(c.journal[0].detail);
  const saved = value.journal[0].detail;
  validateWorldProgression(c, value, resolve);
  expect(value.journal[0].detail).toBe(saved);
  value.journal[0].detail = `${c.journal[0].detail} ${event.fact.toUpperCase()}`;
  expect(() => validateWorldProgression(c, value, resolve)).not.toThrow();
});

it('preserves an already validated encounter checkpoint journal exactly when resuming older saves', () => {
  const c = context();
  const value = proposal(c);
  progress(value);
  c.receipts = { encounterProposal: structuredClone(value) };
  c.journal[0].detail = 'Earlier knowledge in different wording.';
  const frozen = structuredClone(value.journal);
  validateWorldProgression(c, value, resolve);
  expect(value.journal).toEqual(frozen);
});

it('accepts a supplied consolidation at the journal limit and requests bounded repair when canonical append cannot fit', () => {
  const c = context();
  const value = proposal(c);
  const event = progress(value);
  c.journal[0].detail = 'Earlier observation. '.repeat(70);
  const consolidated = `Earlier observations are retained. ${event.fact}`;
  value.journal[0].detail = consolidated;
  validateWorldProgression(c, value, resolve);
  expect(value.journal[0].detail).toBe(consolidated);
  expect(c.journal[0].detail).toHaveLength(1470);
  value.journal[0].detail = 'A paraphrase of the new observation.';
  expect(() => validateWorldProgression(c, value, resolve)).toThrow(JournalCapacityError);
});

it('keeps failed searches failed while accepting a distinct opportunity dependent on the failed attempt occurring', () => {
  const c = context();
  const value = proposal(c);
  const event = progress(value);
  const action = value.actions[0];
  action.status = 'failure';
  action.components.main!.status = 'failure';
  action.components.main!.basis = 'check';
  action.components.main!.fact = 'The precise trail cannot be read.';
  action.intent = 'search';
  action.search = { sourceId: 'cart-ruts', locationId: 'road', informationEventId: event.id, reward: null };
  c.turn.rolls.push({
    id: 'failed-trail',
    memberId: 'member-a',
    stat: 'WIS',
    dc: 10,
    mode: 'normal',
    lethal: false,
    reason: 'Read the precise trail.',
    dice: [2],
    modifier: 0,
    total: 2,
    success: false,
    source: 'check',
  });
  // The witness supplies a different opportunity; the failed trail never reveals its answer.
  expect(() => validateWorldProgression(c, value, resolve)).toThrow('failed-check dependency');
  event.dependsOn = [{ eventId: 'check:failed-trail', requires: 'success' }];
  expect(() => validateWorldProgression(c, value, resolve)).toThrow('never its success');
  event.dependsOn[0].requires = 'occurrence';
  expect(() => validateWorldProgression(c, value, resolve)).not.toThrow();
  expect(action.components.main!.status).toBe('failure');
  event.fact = action.components.main!.fact;
  value.journal[0].detail = event.fact;
  expect(() => validateWorldProgression(c, value, resolve)).toThrow('distinct lesser opportunity');
});

it('does not increment or reset again on retry and preserves old checkpoint compatibility', () => {
  const c = context();
  const value = proposal(c);
  const state = advanceWorldProgression(c, value, resolve)!;
  c.scene.worldProgression = state;
  expect(advanceWorldProgression(c, value, resolve)).toEqual(state);
  const legacy = { ...value };
  delete legacy.worldProgress;
  expect(() => validateWorldProgression(c, legacy, resolve)).not.toThrow();
  expect(advanceWorldProgression(c, legacy, resolve)).toBe(state);
});

it('supplies premise, journal, motivations and factual history without needing a party goal', () => {
  const c = context();
  c.history = [{ summary: 'The caravan departed toward the mill.', source: 'resolution' }];
  const input = worldProgressionContext(c);
  expect(input.threads.map((thread) => thread.id)).toEqual([
    'premise',
    'quest:Missing caravan',
    'motivation:member-a',
    'motivation:member-b',
    'history:0',
  ]);
  expect(input.places.map((place) => place.locationId)).toEqual(['road', 'inn']);
});

it('keeps canonical progress journal facts when a recovery patch adds a different observation', () => {
  const c = context();
  const value = proposal(c);
  progress(value);
  const added = {
    kind: 'fact' as const,
    name: 'Visible loading ramp',
    detail: 'An accessible loading ramp joins the mill yard.',
  };
  const repaired = applyAdjudicationRepair({ value, locked: new Set<string>() }, { journal: [added] }, c);
  expect(repaired.journal).toContainEqual(value.journal[0]);
  expect(repaired.journal).toContainEqual(added);
  expect(() => validateWorldProgression(c, repaired, resolve)).not.toThrow();
});

it('rejects recovery patches rewriting canonical facts attached to retained progress evidence', () => {
  const c = context();
  const value = proposal(c);
  progress(value);
  const rewritten = {
    ...value.journal[0],
    detail: 'The failed search somehow reveals the captives’ exact hiding place.',
  };
  expect(() =>
    applyAdjudicationRepair({ value, locked: new Set<string>() }, { journal: [rewritten] }, c),
  ).toThrow('retained world evidence');
});
