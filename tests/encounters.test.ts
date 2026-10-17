import { expect, it, vi } from 'vitest';
import type { GMContext } from '../server/game';
import { prepareEncounterChecks, saveEncounterRisks, type EncounterChecks } from '../server/encounters';
import { initialScene, initialState } from '../shared/rules';
import { placeScene, updateLocation } from '../shared/locations';
import { templateCharacter, type Encounter } from '../shared/schema';
import { actionId, type TurnAdjudication } from '../shared/turn-resolution';

function context(): GMContext {
  const members = ['a', 'b'].map((id) => {
    const character = templateCharacter(id);
    return {
      id,
      character,
      state: initialState(character, id),
      playerId: id,
      playerName: id,
      characterId: id,
      active: true,
    };
  });
  return {
    config: {
      ruleset: 'roguelike-v1',
      name: 'Road',
      setting: 'A contested trade road',
      premise: '',
      tone: 'Grounded',
      language: 'English',
      instructions: '',
      custom: [],
      provider: 'practice',
      model: '',
    },
    members,
    scene: {
      ...initialScene('Road'),
      location: { id: 'road', name: 'Road', atmosphere: 'An exposed road.', hazard: 'Patrols' },
      encounterRisk: { danger: 'dangerous', reason: 'Hostile patrols use this exposed road.' },
      memberLocations: { a: 'road', b: 'road' },
      places: {
        forest: {
          location: { id: 'forest', name: 'Forest', atmosphere: 'A contested forest.', hazard: 'Raiders' },
          encounter: null,
          loot: [],
          encounterRisk: { danger: 'dangerous', reason: 'Raiders hold this forest.' },
        },
        inn: {
          location: { id: 'inn', name: 'Inn', atmosphere: 'A guarded inn.', hazard: '' },
          encounter: null,
          loot: [],
          encounterRisk: { danger: 'safe', reason: 'The guarded interior is secure.' },
        },
      },
    },
    turn: {
      id: 'turn-1',
      number: 1,
      phase: 'resolving',
      roster: ['a', 'b'],
      actions: members.map((member) => ({ memberId: member.id, text: 'Follow the road.', passed: false })),
      rolls: [],
      result: null,
      error: null,
    },
    journal: [],
    history: [],
  };
}

function proposal(c: GMContext): TurnAdjudication {
  return {
    version: 2,
    turnId: c.turn.id,
    actions: c.turn.actions.map((submitted) => {
      const main = {
        status: 'success' as const,
        basis: 'routine' as const,
        fact: 'The traveller follows the established route.',
        reason: 'An open route.',
        receiptRefs: [],
        eventIds: [],
      };
      return {
        actionId: actionId(c.turn.id, submitted.memberId),
        memberId: submitted.memberId,
        ...main,
        status: submitted.passed ? ('passed' as const) : main.status,
        components: { main: submitted.passed ? null : main, minor: null },
      };
    }),
    events: [],
    changes: [],
    journal: [],
    location: null,
    memberLocations: [],
    rewards: { xp: 0, gold: 0, reason: 'No achievement.' },
  };
}

function risk(value: TurnAdjudication, locationId: string, danger: 'safe' | 'dangerous') {
  const eventId = `world:risk:${locationId}`;
  value.events.push({
    id: eventId,
    sequence: value.events.length,
    kind: 'world',
    actionId: null,
    memberId: null,
    phase: 'aftermath',
    result: null,
    locationRef: locationId,
    receiptRefs: [],
    dependsOn: [],
    fact:
      danger === 'dangerous'
        ? 'An established patrol crosses this place.'
        : 'The secured interior remains guarded.',
  });
  value.encounterRisks = [
    ...(value.encounterRisks ?? []),
    { locationId, danger, reason: value.events.at(-1)!.fact, eventId },
  ];
  return value.events.at(-1)!;
}

const fight = (): Encounter => ({ enemies: [], initiative: [], round: 1, victory: false, escaped: false });

function introduction(value: TurnAdjudication, locationId: string) {
  value.events.push({
    id: `world:encounter:${locationId}`,
    sequence: value.events.length,
    kind: 'world',
    actionId: null,
    memberId: null,
    phase: 'aftermath',
    result: null,
    locationRef: locationId,
    fact: 'The armed patrol emerges and confronts the present travellers.',
    receiptRefs: ['tool:startCombatByLocation'],
    dependsOn: [],
  });
}

it('draws once for a shared group and independently for separated occupied locations', () => {
  const c = context();
  const draw = vi.fn(() => 1);
  const together = prepareEncounterChecks(c, proposal(c), {}, draw);
  expect(draw).toHaveBeenCalledExactlyOnceWith('road');
  expect(together.checks.road.memberIds).toEqual(['a', 'b']);
  expect(together.required.map((check) => check.locationId)).toEqual(['road']);
  c.scene.memberLocations!.b = 'forest';
  const separate = vi.fn((locationId: string) => (locationId === 'road' ? 1 : 6));
  const split = prepareEncounterChecks(c, proposal(c), {}, separate);
  expect(separate.mock.calls).toEqual([['road'], ['forest']]);
  expect(split.checks.road.memberIds).toEqual(['a']);
  expect(split.checks.forest.memberIds).toEqual(['b']);
  expect(split.required.map((check) => check.locationId)).toEqual(['road']);
});

it('skips safe locations, opening turns, passes, orientation and fully blocked actions', () => {
  for (const mode of ['safe', 'opening', 'pass', 'orientation', 'blocked'] as const) {
    const c = context();
    if (mode === 'safe') c.scene.encounterRisk!.danger = 'safe';
    if (mode === 'opening') c.turn.number = 0;
    if (mode === 'pass') c.turn.actions.forEach((action) => (action.passed = true));
    const value = proposal(c);
    if (mode === 'orientation') value.actions.forEach((action) => (action.intent = 'orientation'));
    if (mode === 'blocked')
      value.actions.forEach((action) => {
        action.status = 'blocked';
        action.components.main!.status = 'blocked';
        action.components.main!.basis = 'none';
      });
    const draw = vi.fn(() => 1);
    const result = prepareEncounterChecks(c, value, {}, draw);
    expect(draw, mode).not.toHaveBeenCalled();
    expect(result.required, mode).toEqual([]);
    if (mode === 'safe') expect(result.checks.road.die).toBeNull();
  }
});

it('skips existing fights and already started encounters even on legacy places without saved risk', () => {
  for (const mode of ['existing', 'started'] as const) {
    const c = context();
    delete c.scene.encounterRisk;
    if (mode === 'existing') c.scene.encounter = fight();
    else c.receipts = { startCombatByLocation: { road: fight() } };
    const value = proposal(c);
    if (mode === 'started') introduction(value, 'road');
    const draw = vi.fn(() => 1);
    expect(() => prepareEncounterChecks(c, value, {}, draw)).not.toThrow();
    expect(draw).not.toHaveBeenCalled();
  }
});

it('does not treat engine-owned support or minor-only acts as meaningful exploration', () => {
  for (const mode of ['support', 'minor-only'] as const) {
    const c = context();
    const value = proposal(c);
    value.actions.forEach((action) => {
      if (mode === 'support') action.components.main!.basis = 'engine';
      else {
        action.components.minor = action.components.main;
        action.components.main = null;
      }
    });
    const draw = vi.fn(() => 1);
    prepareEncounterChecks(c, value, {}, draw);
    expect(draw).not.toHaveBeenCalled();
  }
});

it('uses the latest character state to skip inactive, incapacitated or already-resolved fighters', () => {
  for (const mode of ['inactive', 'downed', 'stunned', 'fought'] as const) {
    const c = context();
    c.turn.actions[1].passed = true;
    if (mode === 'inactive') c.members[0].active = false;
    if (mode === 'downed') c.members[0].state.hp = 0;
    if (mode === 'stunned') c.members[0].state.conditions.push('Stunned');
    if (mode === 'fought')
      c.combatResult = {
        participantIds: ['a'],
        logs: [],
        encounter: { ...fight(), victory: true },
        characters: [],
        loot: [],
      };
    const draw = vi.fn(() => 1);
    expect(prepareEncounterChecks(c, proposal(c), {}, draw).required).toEqual([]);
    expect(draw).not.toHaveBeenCalled();
  }
});

it('triggers only on d6 one, rejects invalid dice and reuses both hits and misses on retry', () => {
  for (const die of [1, 2, 6]) {
    const c = context();
    const saved: EncounterChecks = {};
    const first = prepareEncounterChecks(c, proposal(c), saved, () => die);
    expect(first.checks.road.triggered).toBe(die === 1);
    const draw = vi.fn(() => 1);
    expect(prepareEncounterChecks(c, proposal(c), saved, draw).checks).toBe(saved);
    expect(draw).not.toHaveBeenCalled();
  }
  for (const die of [0, 7, 1.5, NaN]) {
    const c = context();
    expect(() => prepareEncounterChecks(c, proposal(c), {}, () => die)).toThrow('valid d6');
  }
});

it('checks actual final group locations and first arrivals independently of screen focus', () => {
  const c = context();
  const value = proposal(c);
  value.sceneFocus = 'current';
  value.memberLocations = [
    { memberId: 'a', locationId: 'forest' },
    { memberId: 'b', locationId: 'inn' },
  ];
  const draw = vi.fn(() => 1);
  const result = prepareEncounterChecks(c, value, {}, draw);
  expect(draw).toHaveBeenCalledExactlyOnceWith('forest');
  expect(Object.keys(result.checks)).toEqual(['forest', 'inn']);
  expect(result.required[0].memberIds).toEqual(['a']);
  const arrival = proposal(c);
  arrival.sceneFocus = 'current';
  arrival.memberLocations = [{ memberId: 'a', locationId: 'new:ruins' }];
  arrival.arrivals = [{ locationId: 'new:ruins', eventId: 'world:risk:new:ruins' }];
  risk(arrival, 'new:ruins', 'dangerous');
  const checks = prepareEncounterChecks(c, arrival, {}, () => 6).checks;
  expect(checks['new:ruins'].memberIds).toEqual(['a']);
  expect(checks.road.memberIds).toEqual(['b']);
});

it('requires grounded risk evidence for unassessed known and new places before spending dice', () => {
  for (const place of ['road', 'new:ruins']) {
    const c = context();
    const value = proposal(c);
    if (place === 'road') delete c.scene.encounterRisk;
    else value.memberLocations = [{ memberId: 'a', locationId: place }];
    const draw = vi.fn(() => 1);
    expect(() => prepareEncounterChecks(c, value, {}, draw)).toThrow('Supply encounterRisks');
    expect(draw).not.toHaveBeenCalled();
    const evidence = risk(value, place, 'dangerous');
    evidence.locationRef = 'forest';
    expect(() => prepareEncounterChecks(c, value, {}, draw)).toThrow('public local world evidence');
    evidence.locationRef = place;
    expect(() => prepareEncounterChecks(c, value, {}, draw)).not.toThrow();
  }
});

it('requires a fresh risk assessment when saved local hazards change', () => {
  const c = context();
  c.scene.encounterRisk = { danger: 'safe', reason: 'The secured road is guarded.' };
  const value = proposal(c);
  value.placeUpdates = [
    {
      ref: 'road',
      location: {
        name: 'Road',
        atmosphere: c.scene.location.atmosphere,
        hazard: 'An enemy patrol occupies the road.',
      },
    },
  ];
  const draw = vi.fn(() => 1);
  expect(() => prepareEncounterChecks(c, value, {}, draw)).toThrow('fresh encounterRisks');
  expect(draw).not.toHaveBeenCalled();
  risk(value, 'road', 'dangerous');
  expect(prepareEncounterChecks(c, value, {}, draw).required.map((check) => check.locationId)).toEqual([
    'road',
  ]);
});

it('rejects a safety claim from a failed check, including through an intermediate action event', () => {
  for (const indirect of [false, true]) {
    const c = context();
    const value = proposal(c);
    c.turn.rolls.push({
      id: 'failed-watch',
      memberId: 'a',
      stat: 'WIS',
      dc: 10,
      reason: 'Check for danger.',
      mode: 'normal',
      lethal: false,
      dice: [1],
      modifier: 0,
      total: 1,
      success: false,
      source: 'check',
    });
    const evidence = risk(value, 'road', 'safe');
    evidence.dependsOn = [{ eventId: 'check:failed-watch', requires: 'occurrence' }];
    if (indirect) {
      value.events.unshift({
        ...evidence,
        id: 'world:failed-observation',
        fact: 'The patrol cannot be located.',
        dependsOn: evidence.dependsOn,
      });
      evidence.dependsOn = [{ eventId: 'world:failed-observation', requires: 'occurrence' }];
    }
    expect(() => prepareEncounterChecks(c, value, {}, () => 1)).toThrow('failed check');
  }
});

it('retains a triggered destination and clears required encounters only when started locally', () => {
  const c = context();
  c.scene.memberLocations!.b = 'forest';
  const saved: EncounterChecks = {};
  prepareEncounterChecks(c, proposal(c), saved, () => 1);
  const changed = proposal(c);
  changed.memberLocations = [{ memberId: 'a', locationId: 'inn' }];
  expect(() => prepareEncounterChecks(c, changed, saved, () => 6)).toThrow('validated destination');
  c.receipts = { startCombatByLocation: { forest: fight() } };
  const forestStarted = proposal(c);
  introduction(forestStarted, 'forest');
  expect(
    prepareEncounterChecks(c, forestStarted, saved, () => 6).required.map((check) => check.locationId),
  ).toEqual(['road']);
  c.receipts = { startCombatByLocation: { forest: fight(), road: fight() } };
  const bothStarted = proposal(c);
  introduction(bothStarted, 'forest');
  introduction(bothStarted, 'road');
  expect(prepareEncounterChecks(c, bothStarted, saved, () => 6).required).toEqual([]);
});

it('rejects newly started encounters without a present character or their own public local introduction', () => {
  const c = context();
  c.receipts = { startCombatByLocation: { forest: fight() } };
  const value = proposal(c);
  expect(() => prepareEncounterChecks(c, value, {}, () => 1)).toThrow('actually present');
  c.scene.memberLocations!.b = 'forest';
  expect(() => prepareEncounterChecks(c, value, {}, () => 1)).toThrow('public local world event');
  introduction(value, 'road');
  expect(() => prepareEncounterChecks(c, value, {}, () => 1)).toThrow('public local world event');
  introduction(value, 'forest');
  expect(() => prepareEncounterChecks(c, value, {}, () => 1)).not.toThrow();
});

it('persists evidence-backed risk on its own place across focus swaps', () => {
  const c = context();
  const value = proposal(c);
  risk(value, 'inn', 'dangerous');
  saveEncounterRisks(c.scene, value, (ref) => ref);
  expect(c.scene.encounterRisk!.reason).toBe('Hostile patrols use this exposed road.');
  expect(placeScene(c.scene, 'inn').encounterRisk!.danger).toBe('dangerous');
  updateLocation(c.scene, { ...c.scene.places!.inn.location });
  expect(c.scene.encounterRisk!.danger).toBe('dangerous');
  expect(placeScene(c.scene, 'road').encounterRisk!.reason).toBe('Hostile patrols use this exposed road.');
});

it('uses the actual known destination for legacy named location updates rather than checking the origin', () => {
  const c = context();
  const value = proposal(c);
  value.location = { name: 'Forest', atmosphere: 'The established contested forest.', hazard: 'Raiders' };
  value.memberLocations = c.members.map((member) => ({ memberId: member.id, locationId: 'destination' }));
  const draw = vi.fn(() => 1);
  const result = prepareEncounterChecks(c, value, {}, draw);
  expect(draw).toHaveBeenCalledExactlyOnceWith('forest');
  expect(result.required.map((check) => check.locationId)).toEqual(['forest']);
});
