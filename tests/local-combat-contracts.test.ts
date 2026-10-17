import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { CombatReceipt, GMContext } from '../server/game';
import { combatFact, narrationBeats } from '../server/narration';
import { repairTurnCheckpoints } from '../server/turn-recovery';
import { applyAdjudicationRepair, retainAdjudicationProgress } from '../server/adjudication-recovery';
import { engineComponents, engineEvents, validateAdjudication } from '../server/turn-resolution';
import { initialScene, initialState } from '../shared/rules';
import { campaignSchema, enemySchema, templateCharacter, type Encounter } from '../shared/schema';
import { actionId, type TurnAdjudication } from '../shared/turn-resolution';

function splitCombat() {
  const members = ['Amon', 'Bera', 'Cora'].map((name, index) => {
    const character = templateCharacter(name);
    return {
      id: `actor-${index}`,
      playerId: `player-${index}`,
      playerName: name,
      characterId: `character-${index}`,
      character,
      state: initialState(character, name),
      active: true,
    };
  });
  const scene = initialScene('The inn');
  scene.location.id = randomUUID();
  const ravine = randomUUID();
  const tower = randomUUID();
  const encounter = (id: string, hp: number): Encounter => ({
    enemies: [
      {
        ...enemySchema.parse({
          id,
          name: 'Road guard',
          tier: 'normal',
          hp: 8,
          defense: 10,
          attack: 2,
          damage: '1d4',
          description: 'An armed guard.',
          tactic: 'Guard the road.',
        }),
        hp,
        maxHp: 8,
        initiative: 10,
      },
    ],
    round: 2,
    initiative: [],
    victory: hp === 0,
    escaped: false,
  });
  const first = encounter('ravine-guard', 0);
  const second = encounter('tower-guard', 5);
  scene.places = {
    [ravine]: {
      location: { id: ravine, name: 'Ravine', atmosphere: '', hazard: '' },
      encounter: first,
      loot: [],
    },
    [tower]: {
      location: { id: tower, name: 'Tower', atmosphere: '', hazard: '' },
      encounter: second,
      loot: [],
    },
  };
  scene.memberLocations = { 'actor-0': ravine, 'actor-1': tower, 'actor-2': scene.location.id };
  const local = (index: number, locationId: string, encounter: Encounter, fact: string): CombatReceipt => ({
    locationId,
    participantIds: [members[index].id],
    encounter,
    logs: [fact],
    events: [{ actorId: members[index].id, locationId, phase: 'main', status: 'success', fact }],
    characters: [{ id: members[index].id, name: members[index].character.name, state: members[index].state }],
    loot: [],
  });
  const a = local(0, ravine, first, 'Amon kills Road guard.');
  const b = local(1, tower, second, 'Bera hits Road guard for 3.');
  const combat: CombatReceipt = {
    encounter: first,
    encounters: { [ravine]: first, [tower]: second },
    participantIds: ['actor-0', 'actor-1'],
    logs: [...a.logs, ...b.logs],
    events: [...a.events!, ...b.events!],
    characters: [...a.characters, ...b.characters],
    loot: [],
  };
  const context: GMContext = {
    config: campaignSchema.parse({
      name: 'Separated fights',
      setting: 'Old roads',
      provider: 'practice',
      language: 'English',
      premise: '',
      tone: '',
      instructions: '',
      custom: [],
    }),
    members,
    startingMembers: structuredClone(members),
    scene,
    combatResult: combat,
    receipts: { combat, combatByLocation: { [ravine]: a, [tower]: b } },
    history: [],
    journal: [],
    turn: {
      id: 'turn',
      number: 3,
      phase: 'resolving',
      roster: members.map((member) => member.id),
      actions: members.map((member, index) => ({
        memberId: member.id,
        text: index < 2 ? 'Attack the guard.' : 'Ask the innkeeper about the missing caravan.',
        passed: false,
      })),
      rolls: [],
      result: null,
      error: null,
    },
  };
  const events = engineEvents(context);
  events.push({
    id: 'innkeeper',
    sequence: 2,
    kind: 'action',
    phase: 'main',
    result: 'success',
    memberId: 'actor-2',
    actionId: actionId('turn', 'actor-2'),
    fact: 'Cora learns that the caravan left for the old bridge.',
    locationRef: scene.location.id,
    receiptRefs: [],
    dependsOn: [],
  });
  const proposal: TurnAdjudication = {
    version: 2,
    turnId: 'turn',
    actions: events.map((event, index) => {
      const basis = index < 2 ? ('engine' as const) : ('routine' as const);
      const component = {
        status: 'success' as const,
        basis,
        fact: event.fact,
        reason: 'The recorded action succeeds.',
        receiptRefs: event.receiptRefs,
        eventIds: [event.id],
      };
      return {
        actionId: actionId('turn', members[index].id),
        memberId: members[index].id,
        ...component,
        components: { main: component, minor: null },
      };
    }),
    events,
    changes: [],
    journal: [],
    location: null,
    rewards: { xp: 0, gold: 0, reason: 'Combat rewards are already applied.' },
  };
  return { context, proposal, ravine, tower };
}

it('scopes simultaneous combat facts to their own place, including enemies with the same name', () => {
  const { context, proposal, ravine, tower } = splitCombat();
  expect(engineEvents(context).map((event) => event.locationRef)).toEqual([ravine, tower]);
  expect(engineComponents(context, 'actor-0').main).toEqual({ status: 'success', basis: 'engine' });
  expect(engineComponents(context, 'actor-1').main).toEqual({ status: 'success', basis: 'engine' });
  expect(engineComponents(context, 'actor-2').main).toBeUndefined();
  expect(() => validateAdjudication(context, proposal)).not.toThrow();
  proposal.actions[1].fact = 'Road guard is dead.';
  expect(() => validateAdjudication(context, proposal)).toThrow('still has 5/8 HP');
});

it('uses each final receipt instead of a stale remote scene or the focused encounter', () => {
  const { context, proposal, tower } = splitCombat();
  context.scene.places![tower].encounter = {
    ...structuredClone(context.scene.places![tower].encounter!),
    victory: true,
    enemies: context.scene.places![tower].encounter!.enemies.map((enemy) => ({ ...enemy, hp: 0 })),
  };
  proposal.events.push({
    id: 'false-victory',
    sequence: proposal.events.length,
    kind: 'world',
    phase: 'aftermath',
    memberId: null,
    actionId: null,
    result: null,
    locationRef: tower,
    fact: 'The fight ends.',
    receiptRefs: [],
    dependsOn: [],
  });
  expect(() => validateAdjudication(context, proposal)).toThrow('Combat at Tower is still active');
});

it('rejects remote enemy deaths claimed by an investigator outside every fight', () => {
  const { context, proposal } = splitCombat();
  proposal.actions[2].fact = 'Cora kills Road guard.';
  expect(() => validateAdjudication(context, proposal)).toThrow('still has 5/8 HP');
});

it('checks the actors own local combat plan before accepting an orientation answer', () => {
  const { context, proposal, ravine, tower } = splitCombat();
  context.receipts!.combatInput = { actions: [{ memberId: 'actor-0', main: 'interact', minor: 'none' }] };
  context.receipts!.combatInputByLocation = {
    [ravine]: context.receipts!.combatInput,
    [tower]: { actions: [{ memberId: 'actor-1', main: 'attack', minor: 'none' }] },
  };
  proposal.actions[1].intent = 'orientation';
  expect(() => validateAdjudication(context, proposal)).toThrow('Orientation cannot reinterpret');
});

it('preserves a separated investigator in narration and permits rewards for that local success', () => {
  const { context, proposal } = splitCombat();
  expect(narrationBeats(context).map((beat) => beat.id)).toEqual(['combat:0', 'combat:1', 'action:actor-2']);
  proposal.rewards = { xp: 10, gold: 0, reason: 'The innkeeper identifies the caravan route.' };
  expect(() => validateAdjudication(context, proposal)).not.toThrow();
  proposal.actions.pop();
  context.turn.actions.pop();
  proposal.events.pop();
  expect(() => validateAdjudication(context, proposal)).toThrow('Combat rewards come from the engine');
});

it('recovers legacy mixed turns using only the fighting actors combat dispositions', () => {
  const { context, proposal } = splitCombat();
  const legacy = {
    ...proposal,
    version: 1 as const,
    actions: proposal.actions.map(({ components: _components, ...action }) => action),
    events: proposal.events.map(({ phase: _phase, result: _result, locationRef: _place, ...event }) => ({
      ...event,
      dependsOn: [],
    })),
  };
  const draft = { receipts: context.receipts!, adjudication: legacy };
  expect(() => repairTurnCheckpoints(draft, context)).not.toThrow();
  expect(draft.adjudication.actions[2]).toMatchObject({
    memberId: 'actor-2',
    basis: 'routine',
    status: 'success',
  });
});

it('protects enemy names from translation in every local encounter', () => {
  const { context, tower } = splitCombat();
  context.config.language = 'Nederlands';
  context.combatResult!.encounters![tower].enemies[0].name = 'Knife with advantage';
  expect(combatFact(context, 'Bera hits Knife with advantage for 3.')).toBe(
    'Bera raakt Knife with advantage voor 3.',
  );
});

it('retains independent local danger and progression evidence with its journal through repair', () => {
  const { context, proposal } = splitCombat();
  const locationId = context.scene.location.id!;
  const fallback = structuredClone(proposal);
  fallback.events[2].id = 'pause';
  fallback.events[2].result = 'blocked';
  fallback.events[2].fact = 'Cora pauses at the inn.';
  const action = fallback.actions[2];
  action.status = 'blocked';
  action.basis = 'none';
  action.fact = fallback.events[2].fact;
  action.eventIds = ['pause'];
  action.components.main = {
    status: 'blocked',
    basis: 'none',
    fact: action.fact,
    reason: 'No established outcome yet.',
    eventIds: ['pause'],
    receiptRefs: [],
  };
  proposal.events.push(
    {
      id: 'world:clue',
      sequence: 3,
      kind: 'world',
      phase: 'aftermath',
      result: null,
      memberId: null,
      actionId: null,
      locationRef: locationId,
      fact: 'The innkeeper identifies the old bridge as the caravan destination.',
      receiptRefs: [],
      dependsOn: [],
    },
    {
      id: 'world:safety',
      sequence: 4,
      kind: 'world',
      phase: 'aftermath',
      result: null,
      memberId: null,
      actionId: null,
      locationRef: locationId,
      fact: 'Town watch patrols the inn courtyard.',
      receiptRefs: [],
      dependsOn: [],
    },
  );
  proposal.journal = [
    {
      kind: 'fact',
      name: 'Caravan destination',
      detail: 'The innkeeper identifies the old bridge as the caravan destination.',
    },
  ];
  proposal.worldProgress = [
    {
      locationId,
      eventId: 'world:clue',
      kind: 'discovery',
      thread: 'premise',
      journal: { kind: 'fact', name: 'Caravan destination' },
    },
  ];
  proposal.encounterRisks = [
    { locationId, eventId: 'world:safety', danger: 'safe', reason: 'The town watch guards this courtyard.' },
  ];
  const retained = retainAdjudicationProgress(context, proposal, fallback, (value) =>
    validateAdjudication(context, value),
  );
  expect(retained.locked).toContain('actor-2:main');
  expect(retained.value.journal).toEqual(proposal.journal);
  expect(retained.value.worldProgress).toEqual(proposal.worldProgress);
  expect(retained.value.encounterRisks).toEqual(proposal.encounterRisks);
  expect(() =>
    applyAdjudicationRepair(
      retained,
      {
        encounterRisks: [{ ...proposal.encounterRisks![0], danger: 'dangerous' }],
      },
      context,
    ),
  ).toThrow('cannot replace retained world evidence');
});
