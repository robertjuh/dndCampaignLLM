import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  actionId,
  aggregateComponents,
  savedTurnAdjudicationSchema,
  validateReferences,
  type ActionComponent,
  type TurnAdjudication,
} from '../shared/turn-resolution';
import { combatSchema, enemySchema, templateCharacter, type Encounter, type Member } from '../shared/schema';
import { initialScene, initialState, runCombat, type CombatEvent } from '../shared/rules';
import {
  engineComponents,
  engineEvents,
  resourceSlot,
  validateAdjudication,
} from '../server/turn-resolution';
import type { GMContext, ResourceReceipt } from '../server/game';

function context(): GMContext {
  const members: Member[] = ['Amon', 'Zafir'].map((name, index) => {
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
  return {
    config: {
      ruleset: 'roguelike-v1',
      name: 'Contracts',
      setting: 'Sanctuary',
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
    scene: initialScene('Sanctuary'),
    history: [],
    journal: [],
    receipts: {},
    turn: {
      id: 'turn',
      number: 1,
      phase: 'resolving',
      roster: members.map((member) => member.id),
      actions: [
        { memberId: members[0].id, text: 'Try to open the seal and drink the potion.', passed: false },
      ],
      rolls: [],
      result: null,
      error: null,
    },
  };
}

/** Independent proposal: never builds its status or events using the receipt adapters. */
function failedMainWithPotion(): TurnAdjudication {
  const main: ActionComponent = {
    status: 'failure',
    basis: 'routine',
    fact: 'The seal stays shut.',
    reason: 'The locking pin snaps.',
    eventIds: ['seal'],
    receiptRefs: [],
  };
  const minor: ActionComponent = {
    status: 'success',
    basis: 'routine',
    fact: 'Amon swallows the potion.',
    reason: 'The potion is within reach.',
    eventIds: ['potion'],
    receiptRefs: [],
  };
  return {
    version: 2,
    turnId: 'turn',
    actions: [
      {
        actionId: actionId('turn', 'actor-0'),
        memberId: 'actor-0',
        status: 'partial',
        basis: 'routine',
        fact: 'The seal remains shut, and Amon drinks.',
        reason: 'Only the minor action succeeds.',
        receiptRefs: [],
        eventIds: ['seal', 'potion'],
        components: { main, minor },
      },
    ],
    events: [
      {
        id: 'seal',
        sequence: 0,
        kind: 'action',
        memberId: 'actor-0',
        actionId: actionId('turn', 'actor-0'),
        phase: 'main',
        result: 'failure',
        fact: main.fact,
        receiptRefs: [],
        dependsOn: [],
      },
      {
        id: 'potion',
        sequence: 1,
        kind: 'action',
        memberId: 'actor-0',
        actionId: actionId('turn', 'actor-0'),
        phase: 'minor',
        result: 'success',
        fact: minor.fact,
        receiptRefs: [],
        dependsOn: [],
      },
      {
        id: 'alarm',
        sequence: 2,
        kind: 'world',
        memberId: null,
        actionId: null,
        phase: null,
        result: 'success',
        fact: 'The broken locking pin triggers the alarm.',
        receiptRefs: [],
        dependsOn: [{ eventId: 'seal', requires: 'occurrence' }],
      },
    ],
    changes: [],
    journal: [],
    location: null,
    safeRest: false,
    rewards: { xp: 0, gold: 0, reason: 'No progress.' },
  };
}

it.each([
  ['success', null, 'success'],
  ['success', 'success', 'success'],
  ['failure', 'success', 'partial'],
  ['blocked', 'success', 'partial'],
  ['success', 'blocked', 'partial'],
  ['success', 'failure', 'partial'],
  [null, 'success', 'success'],
  ['blocked', 'blocked', 'blocked'],
  ['failure', 'blocked', 'failure'],
  ['partial', 'success', 'partial'],
] as const)('derives main %s and minor %s as %s', (main, minor, status) => {
  expect(
    aggregateComponents({
      main: main ? { status: main, basis: 'check' } : null,
      minor: minor ? { status: minor, basis: 'engine' } : null,
    }),
  ).toEqual({ status, basis: main ? 'check' : 'engine' });
});

it('keeps a failed main as a cause without letting its successful minor satisfy that main prerequisite', () => {
  const value = failedMainWithPotion();
  expect(() => validateReferences(value, ['actor-0'], new Set())).not.toThrow();
  value.events[2].dependsOn[0].requires = 'success';
  expect(() => validateReferences(value, ['actor-0'], new Set())).toThrow(/successful prerequisite/);
  value.events[2].dependsOn[0].eventId = 'potion';
  expect(() => validateReferences(value, ['actor-0'], new Set())).not.toThrow();
});

it('rejects a contradictory successful effect appended to a failed main component', () => {
  const value = failedMainWithPotion();
  value.events[0].result = 'success';
  expect(() => validateReferences(value, ['actor-0'], new Set())).toThrow(/contradicts its action component/);
});

it('rejects duplicate dependencies and component references to another action slot', () => {
  const value = failedMainWithPotion();
  value.events[2].dependsOn.push({ ...value.events[2].dependsOn[0] });
  expect(() => validateReferences(value, ['actor-0'], new Set())).toThrow(
    /Dependency references must be unique/,
  );
  value.events[2].dependsOn.pop();
  value.actions[0].components.main!.eventIds.push('potion');
  expect(() => validateReferences(value, ['actor-0'], new Set())).toThrow(/same actor and action slot/);
});

it('reads a saved v1 proposal without interpreting ambiguous dependencies as new v2 metadata', () => {
  const value = failedMainWithPotion();
  const legacy = {
    ...value,
    version: 1,
    actions: value.actions.map(({ components: _components, ...action }) => action),
    events: value.events.map(({ phase: _phase, result: _result, ...event }) => ({
      ...event,
      dependsOn: event.dependsOn.map((edge) => edge.eventId),
    })),
  };
  expect(savedTurnAdjudicationSchema.parse(legacy)).toEqual(legacy);
});

it('refreshes cached healing facts from frozen identities while preserving order', () => {
  const c = context();
  const [actor, target] = c.members;
  const receipt: ResourceReceipt = {
    memberId: actor.id,
    targetId: target.id,
    itemId: 'potion',
    abilityName: null,
    sourceName: 'Red Potion',
    restored: 4,
    state: actor.state,
    targetState: target.state,
  };
  c.receipts![`resource:item:${actor.id}`] = receipt;
  const original = engineEvents(c);
  c.receipts!.executionEvents = original.map((event) => ({
    ...event,
    fact: 'Amon uses Red Potion; Amon recovers 4 HP.',
  }));
  c.members = [actor]; // A filtered current view must never replace the saved target identity.
  expect(engineEvents(c)).toEqual(original);
  expect(original[0].fact).toContain('Zafir recovers 4 HP');
  receipt.targetId = 'unknown';
  expect(() => engineEvents(c)).toThrow(/unknown party member/);
});

it('lets executed checks override both starting Stunned and current downing after a lethal failure', () => {
  const c = context();
  c.startingMembers![0].state.conditions.push('Stunned');
  c.turn.rolls.push({
    id: 'roll',
    memberId: 'actor-0',
    stat: 'WIS',
    dc: 10,
    reason: 'Read the mechanism.',
    mode: 'normal',
    lethal: false,
    dice: [12],
    modifier: 0,
    total: 12,
    success: true,
    source: 'Test RNG',
  });
  expect(engineComponents(c, 'actor-0').main).toEqual({ status: 'success', basis: 'check' });
  c.turn.rolls[0].success = false;
  c.members[0].state.hp = 0;
  c.members[0].state.conditions.push('Downed');
  expect(engineComponents(c, 'actor-0').main).toEqual({ status: 'failure', basis: 'check' });
});

it.each(['Frozen', 'Electrocuted'])('blocks a fabricated successful minor during %s', (condition) => {
  const c = context();
  c.members[0].state.conditions.push(condition);
  const value = failedMainWithPotion();
  value.actions[0].components.main!.status = 'blocked';
  value.actions[0].components.main!.basis = 'none';
  value.actions[0].basis = 'none';
  value.events[0].result = 'blocked';
  expect(() => validateAdjudication(c, value)).toThrow(/incapacity blocks/);
});

it('classifies legacy resource slots and rejects a contradictory saved slot', () => {
  const self = { memberId: 'actor', targetId: null, itemId: 'potion', abilityName: null };
  expect(resourceSlot(self)).toBe('minor');
  expect(resourceSlot({ ...self, targetId: 'ally' })).toBe('main');
  expect(resourceSlot({ ...self, itemId: null, abilityName: 'Mend' })).toBe('main');
  expect(() => resourceSlot({ ...self, slot: 'main' })).toThrow(/slot contradicts/);
});

it('prevents a failed action from hiding a successful effect outside its main component', () => {
  const value = failedMainWithPotion();
  value.events[0].phase = null;
  value.events[0].result = 'success';
  value.actions[0].components.main!.eventIds = [];
  expect(() => validateReferences(value, ['actor-0'], new Set())).toThrow(/requested slot/);
  value.events[0].kind = 'world';
  expect(() => validateReferences(value, ['actor-0'], new Set())).toThrow(/World consequences/);
});

it('reserves new mechanical events for the engine', () => {
  const value = failedMainWithPotion();
  value.events[2].kind = 'mechanics';
  expect(() => validateAdjudication(context(), value)).toThrow(/mechanics come from the server/);
});

function combatFixture() {
  const c = context();
  for (const member of c.members) member.id = randomUUID();
  c.startingMembers = structuredClone(c.members);
  const [actor, ally] = c.members;
  c.turn.actions = [{ memberId: actor.id, text: 'Act and use a minor action.', passed: false }];
  c.turn.roster = c.members.map((member) => member.id);
  const enemy = {
    ...enemySchema.parse({
      id: 'enemy',
      name: 'Guardian',
      tier: 'normal',
      hp: 30,
      defense: 10,
      attack: 15,
      damage: '1d4',
      description: 'A sentinel.',
      tactic: '',
      onHit: null,
    }),
    maxHp: 30,
    initiative: 20,
  };
  const encounter: Encounter = {
    enemies: [enemy],
    initiative: [
      { id: enemy.id, total: 20 },
      { id: actor.id, total: 10 },
      { id: ally.id, total: 1 },
    ],
    round: 1,
    victory: false,
    escaped: false,
  };
  const plan = combatSchema.parse({
    actions: [
      {
        memberId: actor.id,
        main: 'attack',
        targetId: enemy.id,
        stat: 'STR',
        description: 'Strike.',
        minor: 'heal',
        minorItemId: 'potion',
        minorSlot: null,
      },
    ],
    enemyTargets: [{ enemyId: enemy.id, memberId: actor.id }],
    loot: {
      name: 'Relic',
      kind: 'weapon',
      scaling: ['STR'],
      hands: 1,
      light: false,
      description: 'A relic.',
    },
  });
  return { c, actor, ally, encounter, plan };
}

it.each(['heal', 'offhand'] as const)(
  'records a requested %s minor blocked when an enemy downs its actor before initiative',
  (minor) => {
    const { c, actor, encounter, plan } = combatFixture();
    actor.state.hp = 1;
    plan.actions[0].minor = minor;
    const events: CombatEvent[] = [];
    const logs = runCombat(
      c.members,
      encounter,
      plan,
      (sides) => sides,
      (event) => events.push(event),
    );
    expect(events.map((event) => event.fact)).toEqual(logs);
    expect(
      events.filter((event) => event.actorId === actor.id).map((event) => [event.phase, event.status]),
    ).toEqual([
      ['main', 'blocked'],
      ['minor', 'blocked'],
    ]);
    c.combatResult = { events, logs, encounter, characters: [], loot: [] };
    expect(engineComponents(c, actor.id)).toEqual({
      main: { status: 'blocked', basis: 'engine' },
      minor: { status: 'blocked', basis: 'engine' },
    });
  },
);

it('records a requested minor blocked when the entire submitted interaction is skipped across the escape boundary', () => {
  const { c, actor, ally, encounter, plan } = combatFixture();
  encounter.initiative = [
    { id: actor.id, total: 20 },
    { id: ally.id, total: 10 },
    { id: 'enemy', total: 1 },
  ];
  ally.state.conditions.push('Escaped');
  plan.actions[0].main = 'interact';
  plan.actions[0].targetId = ally.id;
  const events: CombatEvent[] = [];
  const logs = runCombat(
    c.members,
    encounter,
    plan,
    () => 2,
    (event) => events.push(event),
  );
  expect(events.map((event) => event.fact)).toEqual(logs);
  expect(
    events.filter((event) => event.actorId === actor.id).map((event) => [event.phase, event.status]),
  ).toEqual([
    ['main', 'blocked'],
    ['minor', 'blocked'],
  ]);
});

it('assigns a rejected equipment-change request to the minor slot while preserving its existing text', () => {
  const { c, actor, encounter, plan } = combatFixture();
  encounter.initiative = [
    { id: actor.id, total: 20 },
    { id: 'enemy', total: 1 },
  ];
  plan.actions[0].main = 'defend';
  plan.actions[0].minor = 'equip';
  const events: CombatEvent[] = [];
  runCombat(
    c.members,
    encounter,
    plan,
    () => 2,
    (event) => events.push(event),
  );
  expect(events.find((event) => event.fact.includes('cannot change equipment'))).toMatchObject({
    actorId: actor.id,
    phase: 'minor',
    status: 'blocked',
  });
});

it('keeps a passed combat actor outside both requested action components', () => {
  const c = context();
  c.turn.actions[0].passed = true;
  c.combatResult = {
    logs: ['Amon holds position.'],
    events: [{ actorId: 'actor-0', phase: 'main', status: null, fact: 'Amon holds position.' }],
    encounter: combatFixture().encounter,
    characters: [],
    loot: [],
  };
  const event = engineEvents(c)[0];
  expect(event).toMatchObject({ actionId: actionId('turn', 'actor-0'), phase: null, result: null });
  const value = failedMainWithPotion();
  value.events = [event];
  value.actions = [
    {
      ...value.actions[0],
      status: 'passed',
      basis: 'none',
      components: { main: null, minor: null },
      receiptRefs: ['tool:combat'],
      eventIds: [event.id],
    },
  ];
  c.receipts = { combat: c.combatResult };
  expect(() => validateAdjudication(c, value)).not.toThrow();
});
