import { expect, it } from 'vitest';
import type { GMContext } from '../server/game';
import { assertEncounterProposal, prepareEncounterChecks } from '../server/encounters';
import { initialScene, initialState } from '../shared/rules';
import { templateCharacter } from '../shared/schema';
import { actionId, type TurnAdjudication } from '../shared/turn-resolution';

function fixture() {
  const members = ['scout', 'traveller'].map((id) => {
    const character = templateCharacter(id);
    return {
      id,
      playerId: id,
      playerName: id,
      characterId: id,
      character,
      state: initialState(character, id),
      active: true,
    };
  });
  const context: GMContext = {
    config: {
      ruleset: 'roguelike-v1',
      name: 'Review',
      setting: 'Old roads',
      premise: '',
      tone: '',
      language: 'English',
      instructions: '',
      custom: [],
      provider: 'practice',
      model: '',
    },
    members,
    scene: {
      ...initialScene('Road'),
      location: { id: 'road', name: 'Road', atmosphere: '', hazard: '' },
      encounterRisk: { danger: 'dangerous', reason: 'Raiders patrol this route.' },
      places: {
        inn: {
          location: { id: 'inn', name: 'Inn', atmosphere: '', hazard: '' },
          encounter: null,
          loot: [],
          encounterRisk: { danger: 'safe', reason: 'A town watch patrol guards the courtyard.' },
        },
      },
      memberLocations: { scout: 'road', traveller: 'inn' },
    },
    journal: [],
    history: [],
    receipts: {},
    turn: {
      id: 'turn',
      number: 1,
      phase: 'resolving',
      roster: members.map((member) => member.id),
      actions: members.map((member) => ({
        memberId: member.id,
        text: 'Look for the caravan.',
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
    actions: members.map((member, index) => {
      const main = {
        status: index ? ('blocked' as const) : ('success' as const),
        basis: index ? ('none' as const) : ('routine' as const),
        fact: index ? 'The traveller waits.' : 'The scout follows the trail.',
        reason: 'The established situation.',
        eventIds: ['action'],
        receiptRefs: [],
      };
      return {
        actionId: actionId('turn', member.id),
        memberId: member.id,
        ...main,
        components: { main, minor: null },
      };
    }),
    events: [],
    changes: [],
    journal: [],
    location: null,
    rewards: { xp: 0, gold: 0, reason: 'No completed objective.' },
  };
  return { context, value };
}

it('freezes the whole projected encounter group, including later arrivals', () => {
  const { context, value } = fixture();
  const saved = prepareEncounterChecks(context, value, {}, () => 1).checks;
  expect(saved.road.memberIds).toEqual(['scout']);
  value.memberLocations = [{ memberId: 'traveller', locationId: 'road' }];
  value.actions[1].components.main!.status = 'success';
  value.actions[1].components.main!.basis = 'routine';
  expect(() => prepareEncounterChecks(context, value, saved, () => 6)).toThrow(/group|destination/i);
});

it('requires a fresh assessment when established danger changes at a saved safe place', () => {
  const { context, value } = fixture();
  context.scene.memberLocations!.scout = 'inn';
  value.placeUpdates = [
    {
      ref: 'inn',
      location: { name: 'Inn', atmosphere: '', hazard: 'Raiders have seized the unguarded courtyard.' },
    },
  ];
  expect(() => prepareEncounterChecks(context, value, {}, () => 6)).toThrow(/assess|encounterRisks|danger/i);
  const eventId = 'world:new-danger';
  value.events.push({
    id: eventId,
    sequence: 0,
    kind: 'world',
    memberId: null,
    actionId: null,
    phase: 'aftermath',
    result: null,
    fact: 'Raiders have seized the unguarded courtyard.',
    locationRef: 'inn',
    receiptRefs: [],
    dependsOn: [],
  });
  value.encounterRisks = [
    { locationId: 'inn', danger: 'dangerous', reason: 'Raiders control this courtyard.', eventId },
  ];
  expect(prepareEncounterChecks(context, value, {}, () => 1).checks.inn.triggered).toBe(true);
});

function pendingIntroduction() {
  const { context, value: baseline } = fixture();
  baseline.events.push({
    id: 'world:trail',
    sequence: 0,
    kind: 'world',
    memberId: null,
    actionId: null,
    phase: 'aftermath',
    result: null,
    fact: 'The caravan trail reaches the old bridge.',
    locationRef: 'road',
    receiptRefs: [],
    dependsOn: [],
  });
  baseline.journal = [{ kind: 'fact', name: 'Caravan trail', detail: baseline.events[0].fact }];
  const value = structuredClone(baseline);
  context.receipts!.startCombatByLocation = {
    road: { enemies: [], round: 1, initiative: [], victory: false, escaped: false },
  };
  value.events.push({
    id: 'world:raiders',
    sequence: 1,
    kind: 'world',
    memberId: null,
    actionId: null,
    phase: 'aftermath',
    result: null,
    fact: 'A raider steps onto the road and blocks passage.',
    locationRef: 'road',
    receiptRefs: ['tool:startCombatByLocation'],
    dependsOn: [],
  });
  value.placeUpdates = [
    {
      ref: 'road',
      location: {
        name: 'Road',
        atmosphere: 'A raider steps onto the trail.',
        hazard: 'An armed raider blocks passage.',
      },
    },
  ];
  value.journal.push({ kind: 'fact', name: 'Road raider', detail: value.events[1].fact });
  return { context, baseline, value };
}

it('permits the encounter introduction and local description without changing checked exploration', () => {
  const { context, baseline, value } = pendingIntroduction();
  expect(() => assertEncounterProposal(context, value, baseline)).not.toThrow();
  expect(() => assertEncounterProposal(context, value, undefined)).not.toThrow();
});

it.each(['action', 'damage', 'reward', 'position', 'focus', 'event', 'journal', 'place name'])(
  'prevents a triggered encounter continuation from rewriting its prior %s',
  (field) => {
    const { context, baseline, value } = pendingIntroduction();
    if (field === 'action') value.actions[0].components.main!.status = 'failure';
    if (field === 'damage')
      value.changes.push({
        type: 'hp',
        memberId: 'scout',
        amount: -4,
        reason: 'The raider attacks on arrival.',
      });
    if (field === 'reward') value.rewards.xp = 30;
    if (field === 'position') value.memberLocations = [{ memberId: 'scout', locationId: 'inn' }];
    if (field === 'focus') value.sceneFocus = 'inn';
    if (field === 'event') value.events[0].fact = 'The caravan trail is lost.';
    if (field === 'journal') value.journal[0].detail = 'The caravan trail is lost.';
    if (field === 'place name') value.placeUpdates![0].location.name = 'A different road';
    expect(() => assertEncounterProposal(context, value, baseline)).toThrow();
  },
);

it.each(['remote', 'missing receipt', 'new action', 'hidden event'])(
  'rejects a %s appended after the checked exploration',
  (defect) => {
    const { context, baseline, value } = pendingIntroduction();
    const introduction = value.events[1];
    if (defect === 'remote') introduction.locationRef = 'inn';
    if (defect === 'missing receipt') introduction.receiptRefs = [];
    if (defect === 'new action') {
      introduction.kind = 'action';
      introduction.memberId = 'scout';
      introduction.actionId = actionId('turn', 'scout');
    }
    if (defect === 'hidden event') introduction.presentation = 'log';
    expect(() => assertEncounterProposal(context, value, baseline)).toThrow('Append only');
  },
);
