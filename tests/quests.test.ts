import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { Game, type GMContext, type GameMaster } from '../server/game';
import { openDatabase } from '../server/db';
import { PracticeGM } from '../server/providers';
import { compileSceneTurn, type SceneTurn } from '../server/scene-turn';
import { planQuests, applyQuestPlan } from '../server/quests';
import { applyFeatureUpdates } from '../server/scene-state';
import { saveNPCEncounter } from '../server/npcs';
import { baseItem, initialScene, initialState, takeItem } from '../shared/rules';
import { ensureLocations } from '../shared/locations';
import { templateCharacter, enemySchema, type Scene, type Snapshot } from '../shared/schema';
import { questDefinitionSchema, type QuestDefinition, type QuestOperation } from '../shared/quests';
import { factionExample } from '../server/factions';
import { QuestJournal } from '../src/QuestJournal';
import { EquipmentPanel } from '../src/EquipmentPanel';

function fixture(): GMContext {
  const members = ['Mira', 'Rowan'].map((name) => {
    const id = randomUUID();
    const character = templateCharacter(name);
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
  const scene = ensureLocations(
    initialScene('Workshop'),
    members.map((m) => m.id),
  );
  scene.currencyName = 'guild scrip';
  scene.encounterRisk = { danger: 'safe', reason: 'A peaceful workshop.' };
  scene.npcs = {
    ada: {
      id: 'ada',
      name: 'Ada',
      aliases: [],
      locationId: scene.location.id!,
      status: 'alive',
      allegiance: null,
      fact: 'Ada runs the workshop.',
    },
  };
  scene.features = {
    pump: {
      id: 'pump',
      name: 'Pump',
      aliases: [],
      locationId: scene.location.id!,
      properties: { repaired: false },
      fact: 'The pump is broken.',
    },
  };
  return {
    sceneProtocol: true,
    gmMemory: [],
    members,
    startingMembers: structuredClone(members),
    scene,
    journal: [],
    history: [],
    receipts: {},
    config: {
      ruleset: 'roguelike-v1',
      name: 'Requests',
      setting: 'Workshop',
      premise: '',
      tone: 'Hopeful',
      instructions: '',
      language: 'English',
      custom: [],
      provider: 'practice',
      model: '',
    },
    turn: {
      id: randomUUID(),
      number: 1,
      phase: 'resolving',
      roster: members.map((m) => m.id),
      actions: [],
      rolls: [],
      result: null,
      error: null,
    },
  };
}
function definition(overrides: Partial<QuestDefinition> = {}): QuestDefinition {
  return questDefinitionSchema.parse({
    id: 'repair-pump',
    name: 'Repair the pump',
    description: 'Restore the workshop pump and report to Ada.',
    giverId: 'ada',
    recipientId: 'ada',
    objectives: [
      {
        id: 'repair',
        description: 'Repair the pump.',
        condition: { kind: 'state', featureId: 'pump', property: 'repaired', value: true },
      },
    ],
    reward: {
      description: '25 guild scrip and a healing potion.',
      currency: 25,
      items: [
        {
          name: 'Workshop tonic',
          kind: 'consumable',
          scaling: [],
          hands: 1,
          light: true,
          description: 'A healing tonic.',
        },
      ],
      access: [],
    },
    ...overrides,
  });
}
function sceneTurn(context: GMContext, operations: QuestOperation[] = [], repair = false): SceneTurn {
  return {
    version: 3,
    notes: [],
    summary: 'Ada and Mira discuss the pump.',
    beats: [
      {
        kind: 'act',
        slot: 'main',
        intent: 'action',
        actor: context.members[0].id,
        fact: repair
          ? 'Mira repairs the Pump; Ada observes the restored water flow.'
          : 'Ada and Mira discuss the request and its agreed terms.',
        text: repair
          ? 'Water flows through the repaired pump as Ada watches.'
          : 'Ada listens as Mira discusses the request.',
        ...(context.scene.npcs?.ada && context.scene.npcs.ada.status !== 'dead'
          ? { npcs: [{ npcId: 'ada', name: 'Ada' }] }
          : {}),
        quests: operations,
        ...(repair
          ? { features: [{ featureId: 'pump', name: 'Pump', properties: { repaired: true } }] }
          : {}),
      },
    ],
  };
}
function action(context: GMContext, text: string) {
  context.turn.actions = context.members.map((m, i) => ({
    memberId: m.id,
    text: i ? '' : text,
    passed: !!i,
  }));
}
function step(context: GMContext, text: string, operations: QuestOperation[] = [], repair = false) {
  action(context, text);
  const value = compileSceneTurn(context, sceneTurn(context, operations, repair));
  const plan = planQuests(context, value);
  applyFeatureUpdates(context.scene, value, (ref) => ref);
  const result = applyQuestPlan(
    context,
    value,
    plan,
    context.scene,
    context.members,
    (ref) => ref,
    () => 1,
  );
  context.turn.number++;
  context.turn.id = randomUUID();
  return { value, result };
}
function accepted(context: GMContext, quest = definition()) {
  step(context, 'Ask Ada about her request.', [{ type: 'offer', quest }]);
  step(context, 'I accept Ada’s request.', [{ type: 'accept', questId: quest.id }]);
}

it('saves and fulfills a concrete social agreement without inventing mechanical rewards', () => {
  const context = fixture();
  const reward = {
    description: 'Ada now recognizes the group as trusted helpers and will vouch for their work.',
    currency: 0,
    items: [],
    access: [],
  };
  const quest = definition({ reward });
  const beforeMembers = structuredClone(context.members);
  const beforeLoot = structuredClone(context.scene.loot);
  accepted(context, quest);
  step(context, 'I repair the pump.', [], true);
  const { result } = step(context, 'I report the completed repair to Ada.', [
    { type: 'turnIn', questId: quest.id },
  ]);
  expect(context.scene.quests![quest.id]).toMatchObject({ status: 'completed', reward });
  expect(result.facts.some(({ fact }) => fact.includes(reward.description))).toBe(true);
  expect(context.members).toEqual(beforeMembers);
  expect(context.scene.loot).toEqual(beforeLoot);
  expect(() => step(context, 'I claim Ada’s reward again.', [
    { type: 'turnIn', questId: quest.id },
  ])).toThrow(/already claimed/);
  expect(questDefinitionSchema.safeParse({ ...quest, reward: { description: '' } }).success).toBe(false);
});

it('persists a new role-based giver and their prepared retrieval offer in the first observed meeting', () => {
  const context = fixture();
  context.scene.npcs = {};
  action(context, 'I ask the canal workshop mechanic whether they need help.');
  const request = definition({
    id: 'retrieve-tool-case',
    name: 'Retrieve the workshop tool case',
    description: 'Find the missing workshop tool case and return it to the canal workshop mechanic.',
    giverId: 'new:canal-mechanic',
    recipientId: 'new:canal-mechanic',
    objectives: [{
      id: 'case', description: 'Return the tool case.',
      condition: { kind: 'deliver', sourceId: 'new:workshop-tool-case', quantity: 1 },
    }],
    reward: { description: 'The mechanic recognizes the group as trusted helpers.', currency: 0, items: [], access: [] },
  });
  const turn: SceneTurn = {
    version: 3,
    summary: 'The canal workshop mechanic requests their missing tool case.',
    notes: [],
    beats: [{
      kind: 'meet',
      actor: context.members[0].id,
      person: { npcId: 'new:canal-mechanic', name: 'Canal workshop mechanic' },
      fact: 'The Canal workshop mechanic asks Mira to retrieve the workshop tool case from the nearby engine rack.',
      text: '“Please bring me the case from that engine rack,” the mechanic says. “I will vouch for your work.”',
      features: [{
        featureId: 'new:workshop-tool-case', name: 'Workshop tool case',
        properties: { visible: true },
      }],
      quests: [{ type: 'offer', quest: request }],
    }],
  };
  const value = compileSceneTurn(context, turn);
  const plan = planQuests(context, value);
  expect(value.npcUpdates).toContainEqual(expect.objectContaining({ npcId: request.giverId }));
  expect(plan.quests[request.id]).toMatchObject({ status: 'offered', giverId: request.giverId, reward: request.reward });
  expect(context.scene.npcs).toEqual({});
  expect(context.members[0].state.inventory.some((item) => item.sourceId === 'new:workshop-tool-case')).toBe(false);
});

it('tracks a group repair, leaves rewards locally, unlocks access, and improves faction status exactly once', () => {
  const context = fixture();
  const at = context.scene.location.id!;
  const vault = randomUUID();
  context.scene.worldMap!.nodes[vault] = { id: vault, name: 'Vault', visited: false };
  context.scene.worldMap!.connections.push({
    from: at,
    to: vault,
    label: 'Workshop vault',
    blocked: true,
    bidirectional: true,
  });
  context.factions = factionExample(['guild', 'traders', 'scholars'], 'Workshop', [], 0);
  context.factions.factions[0].discoveredTurn = 0;
  context.factions.factions[0].knownDescription = 'The workshop guild.';
  context.scene.npcs!.ada.factionId = 'guild';
  context.members.forEach((m) => {
    m.state.factionInitialized = true;
  });
  const quest = definition({
    reward: {
      ...definition().reward,
      access: [{ from: at, to: vault }],
      faction: { factionId: 'guild', reputation: 2 },
    },
  });
  accepted(context, quest);
  expect(context.scene.quests![quest.id].status).toBe('active');
  step(context, 'I repair the pump.', [], true);
  expect(context.scene.quests![quest.id].status).toBe('ready');
  expect(context.scene.loot).toHaveLength(0);
  const { result } = step(context, 'I report the repair to Ada and claim the reward.', [
    { type: 'turnIn', questId: quest.id },
  ]);
  expect(context.scene.quests![quest.id].status).toBe('completed');
  expect(context.scene.loot[0].currencyValue).toBe(25);
  expect(context.scene.loot[0].name).toBe('guild scrip');
  expect(context.scene.loot[0].description).toContain('25 guild scrip');
  const equipment = renderToStaticMarkup(createElement(EquipmentPanel, {
    member: context.members[0],
    snapshot: { ...context, status: 'active' } as unknown as Snapshot,
    lockReason: '',
    healingLockReason: '',
    command: async () => undefined,
  }));
  expect(equipment).toContain('Collect guild scrip');
  expect(equipment).toContain('25 guild scrip');
  expect(context.scene.loot[1].name).toBe('Workshop tonic');
  expect(context.members.map((m) => m.state.currency)).toEqual([0, 0]);
  expect(context.members.map((m) => m.state.factionReputation?.guild)).toEqual([2, 2]);
  expect(result.reputation).toHaveLength(2);
  expect(context.scene.worldMap!.connections[0].blocked).toBe(false);
  // Anyone present can collect it, even the member who did not report the completion.
  const collector = context.members[1];
  collector.state.inventory = [];
  for (let i = 0; i < 8; i++)
    collector.state.inventory.push({ ...baseItem(`full-${i}`, 'Rock', 'tool'), quantity: 1 });
  takeItem(collector.character, collector.state, context.scene, context.scene.loot[0].id);
  expect(collector.state.currency).toBe(25);
  expect(collector.state.inventory).toHaveLength(8);
  expect(() =>
    step(context, 'I claim the reward from Ada again.', [{ type: 'turnIn', questId: quest.id }]),
  ).toThrow(/already claimed/);
  const html = renderToStaticMarkup(
    createElement(QuestJournal, { snapshot: { scene: context.scene, config: context.config } as Snapshot }),
  );
  expect(html).toContain('Completed');
  expect(html).toContain('Repair the pump. (1/1)');
});

it('requires explicit acceptance and cannot complete a quest from a player’s success claim', () => {
  const context = fixture();
  step(context, 'Ask Ada about the request.', [{ type: 'offer', quest: definition() }]);
  expect(() => step(context, 'What does Ada need?', [{ type: 'accept', questId: 'repair-pump' }])).toThrow(
    /explicit/,
  );
  step(context, 'I accept the job.', [{ type: 'accept', questId: 'repair-pump' }]);
  expect(() =>
    step(context, 'I tell Ada the pump is repaired and claim payment.', [
      { type: 'turnIn', questId: 'repair-pump' },
    ]),
  ).toThrow(/not ready/);
  expect(context.scene.loot).toHaveLength(0);
});

it('consumes the specified delivery quantity and requires the actual holder’s local consent', () => {
  const context = fixture();
  const item = { ...baseItem('letter', 'Letter', 'tool'), quantity: 2 };
  context.members[1].state.inventory.push(item);
  const quest = definition({
    objectives: [
      {
        id: 'letter',
        description: 'Deliver one letter.',
        condition: { kind: 'deliver', itemId: item.id, quantity: 1 },
      },
    ],
  });
  accepted(context, quest);
  expect(context.scene.quests![quest.id].status).toBe('ready');
  expect(() => step(context, 'I give Ada the letter.', [{ type: 'turnIn', questId: quest.id }])).toThrow(
    /explicitly hand/,
  );
  action(context, 'I report to Ada.');
  context.turn.actions[1] = {
    memberId: context.members[1].id,
    text: 'I give Ada one letter.',
    passed: false,
  };
  const scene = sceneTurn(context, [{ type: 'turnIn', questId: quest.id }]);
  scene.beats.push({
    kind: 'act',
    slot: 'main',
    intent: 'action',
    actor: context.members[1].id,
    fact: 'Rowan gives Ada the letter.',
    text: 'Rowan hands Ada the letter.',
  });
  const value = compileSceneTurn(context, scene);
  const plan = planQuests(context, value);
  applyQuestPlan(
    context,
    value,
    plan,
    context.scene,
    context.members,
    (ref) => ref,
    () => 1,
  );
  expect(context.members[1].state.inventory.find((i) => i.id === item.id)?.quantity).toBe(1);
});

it('counts distinct actual deaths for enemy categories, excluding prior kills and living withdrawals', () => {
  const context = fixture();
  const at = context.scene.location.id!;
  const enemy = (id: string, dead = false) => ({
    id,
    name: id,
    aliases: [],
    locationId: at,
    status: dead ? ('dead' as const) : ('alive' as const),
    allegiance: null,
    fact: 'A wolf.',
    enemy: {
      ...enemySchema.parse({
        id,
        name: id,
        tags: ['wolf'],
        tier: 'minor',
        hp: 5,
        defense: 10,
        attack: 0,
        damage: '1d4',
        description: 'A wolf.',
        tactic: 'Bite.',
      }),
      hp: dead ? 0 : 5,
      maxHp: 5,
      initiative: 10,
    },
  });
  context.scene.npcs!.old = enemy('old', true);
  context.scene.npcs!.first = enemy('first');
  context.scene.npcs!.second = enemy('second');
  const quest = definition({
    objectives: [
      {
        id: 'wolves',
        description: 'Kill two wolves at the workshop.',
        condition: { kind: 'hunt', tag: 'wolf', locationId: at, count: 2 },
      },
    ],
  });
  accepted(context, quest);
  context.scene.npcs!.first = enemy('first', true);
  context.scene.npcs!.fled = { ...enemy('fled'), status: 'withdrawn' };
  step(context, 'Ask Ada about progress.');
  expect(context.scene.quests![quest.id].progress.wolves.current).toBe(1);
  step(context, 'Ask Ada about progress again.');
  expect(context.scene.quests![quest.id].progress.wolves.current).toBe(1);
  context.scene.npcs!.second = enemy('second', true);
  step(context, 'Ask Ada about progress.');
  expect(context.scene.quests![quest.id].status).toBe('ready');
});

it.each(['giver', 'escort', 'deadline'] as const)(
  'fails requests only for an established %s consequence',
  (reason) => {
    const context = fixture();
    const other = randomUUID();
    context.scene.worldMap!.nodes[other] = { id: other, name: 'Courtyard', visited: false };
    context.scene.worldMap!.connections.push({
      from: context.scene.location.id!,
      to: other,
      label: 'Courtyard path',
      blocked: false,
      bidirectional: true,
    });
    context.scene.npcs!.traveler = { ...context.scene.npcs!.ada, id: 'traveler', name: 'Traveler' };
    const quest = definition({
      deadlineTurn: 8,
      deadlineDescription: 'Return before the eighth turn ends.',
      ...(reason === 'escort'
        ? {
            objectives: [
              {
                id: 'escort',
                description: 'Escort the traveler to the courtyard.',
                condition: { kind: 'escort' as const, npcId: 'traveler', locationId: other },
              },
            ],
          }
        : {}),
    });
    accepted(context, quest);
    if (reason === 'giver') context.scene.npcs!.ada.status = 'dead';
    else if (reason === 'escort') context.scene.npcs!.traveler.status = 'dead';
    else context.turn.number = 9;
    action(context, 'Look at the pump.');
    const value = compileSceneTurn(context, sceneTurn(context));
    const plan = planQuests(context, value);
    expect(plan.quests[quest.id].status).toBe('failed');
    expect(plan.quests[quest.id].failureReason).toBeTruthy();
    expect(plan.claims).toHaveLength(0);
  },
);

it('rejects impossible and circular objectives and renamed copies', () => {
  const context = fixture();
  const remote = randomUUID();
  context.scene.worldMap!.nodes[remote] = { id: remote, name: 'Sealed vault', visited: false };
  context.scene.worldMap!.connections.push({
    from: context.scene.location.id!,
    to: remote,
    label: 'Sealed door',
    blocked: true,
    bidirectional: true,
  });
  const quest = definition({
    objectives: [
      {
        id: 'visit',
        description: 'Enter the sealed vault.',
        condition: { kind: 'visit', locationId: remote },
      },
    ],
  });
  expect(() => step(context, 'Ask Ada about work.', [{ type: 'offer', quest }])).toThrow(/reachable/);
  accepted(context);
  expect(() => step(context, 'Ask Ada again.', [{ type: 'offer', quest: definition() }])).toThrow(/replaced/);
  expect(() =>
    step(context, 'Ask Ada again.', [
      { type: 'offer', quest: definition({ id: 'copy', name: 'A renamed request' }) },
    ]),
  ).toThrow(/renamed copies/);
});

it.each(['visit', 'escort', 'discover', 'kill'] as const)(
  'recognizes %s objectives from saved world state',
  (kind) => {
    const context = fixture();
    const at = context.scene.location.id!;
    const destination = randomUUID();
    context.scene.places![destination] = {
      location: { id: destination, name: 'Courtyard', atmosphere: '', hazard: '' },
      loot: [],
      encounter: null,
      encounterRisk: { danger: 'safe', reason: 'A quiet courtyard.' },
    };
    context.scene.worldMap!.nodes[destination] = { id: destination, name: 'Courtyard', visited: true };
    context.scene.worldMap!.connections.push({
      from: at,
      to: destination,
      label: 'Courtyard path',
      blocked: false,
      bidirectional: true,
    });
    context.scene.npcs!.traveler = { ...context.scene.npcs!.ada, id: 'traveler', name: 'Traveler' };
    context.gmMemory = [
      {
        id: 'mystery',
        locationId: at,
        cause: 'A broken valve.',
        discoveries: ['The valve is jammed.'],
        actors: 'Ada',
        nextChange: 'Ada waits.',
        dueTurn: null,
        status: 'open',
      },
    ];
    const condition =
      kind === 'visit'
        ? { kind, locationId: destination }
        : kind === 'escort'
          ? { kind, npcId: 'traveler', locationId: destination }
          : kind === 'discover'
            ? { kind, hookId: 'mystery', answer: 0 }
            : { kind, npcId: 'traveler' };
    const quest = definition({
      objectives: [{ id: 'task', description: 'Complete the agreed task.', condition }],
    });
    accepted(context, quest);
    expect(context.scene.quests![quest.id].status).toBe('active');
    if (kind === 'visit') context.scene.memberLocations![context.members[1].id] = destination;
    if (kind === 'escort') context.scene.npcs!.traveler.locationId = destination;
    if (kind === 'discover') context.gmMemory[0].revealed = [0];
    if (kind === 'kill')
      saveNPCEncounter(context.scene, at, {
        enemies: [
          {
            ...enemySchema.parse({
              id: 'traveler',
              name: 'Traveler',
              tier: 'normal',
              hp: 8,
              defense: 10,
              attack: 1,
              damage: '1d4',
              description: 'An enemy.',
              tactic: 'Fight.',
            }),
            hp: 0,
            maxHp: 8,
            initiative: 10,
          },
        ],
        round: 1,
        initiative: [],
        victory: true,
        escaped: false,
      });
    step(context, 'Ask Ada about progress.');
    expect(context.scene.quests![quest.id].status).toBe('ready');
  },
);

it.each(['decline', 'abandon'] as const)(
  'saves an explicit %s without issuing a replacement request',
  (type) => {
    const context = fixture();
    step(context, 'Ask Ada about work.', [{ type: 'offer', quest: definition() }]);
    if (type === 'abandon') step(context, 'I accept the job.', [{ type: 'accept', questId: 'repair-pump' }]);
    step(context, type === 'decline' ? 'I decline Ada’s request.' : 'I abandon the job.', [
      { type, questId: 'repair-pump' },
    ]);
    expect(Object.keys(context.scene.quests!)).toHaveLength(1);
    expect(context.scene.quests!['repair-pump'].status).toBe(type === 'decline' ? 'declined' : 'abandoned');
    expect(context.scene.loot).toHaveLength(0);
  },
);

it('matches a retrieved story item to its prepared collectible source', () => {
  const context = fixture();
  context.scene.features!.letter = {
    id: 'letter',
    name: 'Letter',
    aliases: [],
    locationId: context.scene.location.id!,
    properties: { text: 'A supply order.' },
    fact: 'A letter lies on the desk.',
  };
  const quest = definition({
    objectives: [
      {
        id: 'letter',
        description: 'Bring Ada the letter.',
        condition: { kind: 'deliver', sourceId: 'letter', quantity: 1 },
      },
    ],
  });
  accepted(context, quest);
  context.members[0].state.inventory.push({
    ...baseItem('collected-letter', 'Letter', 'tool'),
    sourceId: 'letter',
    quantity: 1,
  });
  step(context, 'I give Ada the letter.', [{ type: 'turnIn', questId: quest.id }]);
  expect(context.members[0].state.inventory.some((i) => i.sourceId === 'letter')).toBe(false);
  expect(context.scene.quests![quest.id].status).toBe('completed');
});

function preparedRetrieval(context: GMContext) {
  context.gmMemory = [{
    id: 'workshop-case-preparation',
    locationId: context.scene.location.id!,
    cause: 'The mechanic lost the workshop tool case while repairing the nearby wreck.',
    discoveries: ['The missing workshop tool case is beneath the loose engine cover in the wreck.'],
    actors: 'The workshop mechanic knows the way to the wreck.',
    nextChange: 'The mechanic waits for news of the case.',
    dueTurn: null,
    status: 'open',
  }];
  return definition({
    id: 'retrieve-missing-case', name: 'Retrieve the missing tool case',
    description: 'Find the tool case at the nearby wreck and return it to Ada.',
    objectives: [{
      id: 'case', description: 'Return the missing workshop tool case.',
      condition: {
        kind: 'deliver', sourceId: 'missing-workshop-tool-case', quantity: 1,
        preparation: { hookId: context.gmMemory[0].id, answer: 0 },
      },
    }],
    reward: { description: 'Ada recognizes the group as reliable helpers.', currency: 0, items: [], access: [] },
  });
}

it('offers a prepared future retrieval without exposing or spawning its collectible, then requires the real consenting holder', () => {
  const context = fixture();
  const quest = preparedRetrieval(context);
  const beforeMap = structuredClone(context.scene.worldMap);
  const beforeInventory = context.members.map((member) => structuredClone(member.state.inventory));
  accepted(context, quest);
  expect(context.scene.quests![quest.id].status).toBe('active');
  expect(context.members.map((member) => member.state.inventory)).toEqual(beforeInventory);
  expect(context.scene.worldMap).toEqual(beforeMap);
  expect(context.scene.features!['missing-workshop-tool-case']).toBeUndefined();
  expect(context.scene.loot).toHaveLength(0);
  expect(JSON.stringify(context.scene.quests![quest.id])).not.toContain('loose engine cover');
  expect(() => step(context, 'I give Ada the missing tool case.', [
    { type: 'turnIn', questId: quest.id },
  ])).toThrow(/not ready/);
  const item = { ...baseItem('actual-tool-case', 'Workshop tool case', 'tool'), sourceId: 'missing-workshop-tool-case', quantity: 1 };
  context.members[1].state.inventory.push(item);
  expect(() => step(context, 'I give Ada the missing tool case.', [
    { type: 'turnIn', questId: quest.id },
  ])).toThrow(/explicitly hand them over/);
  context.members[1].state.inventory.pop();
  context.members[0].state.inventory.push(item);
  step(context, 'I give Ada the missing tool case.', [{ type: 'turnIn', questId: quest.id }]);
  expect(context.scene.quests![quest.id].status).toBe('completed');
  expect(context.members[0].state.inventory).toEqual(beforeInventory[0]);
  expect(context.scene.loot).toHaveLength(0);
});

it.each([
  'I return the tool case to Ada.',
  'Ik geef Ada de koffer terug.',
  'Ik breng de koffer terug naar Ada.',
])('treats the actual offered delivery "%s" as agreement without a separate acceptance phrase', (text) => {
  const context = fixture();
  const quest = preparedRetrieval(context);
  step(context, 'Ask Ada about the missing case.', [{ type: 'offer', quest }]);
  const inventory = structuredClone(context.members[0].state.inventory);
  context.members[0].state.inventory.push({
    ...baseItem('actual-case', 'Workshop tool case', 'tool'), sourceId: 'missing-workshop-tool-case', quantity: 1,
  });
  expect(context.scene.quests![quest.id].status).toBe('offered');
  const turn = context.turn.number;
  step(context, text, [{ type: 'turnIn', questId: quest.id }]);
  expect(context.scene.quests![quest.id]).toMatchObject({ status: 'completed', acceptedTurn: turn, completedTurn: turn });
  expect(context.members[0].state.inventory).toEqual(inventory);
  expect(() => step(context, text, [{ type: 'turnIn', questId: quest.id }])).toThrow(/already claimed/);
});

it.each([
  'I return to the garage with the tool case.',
  'I bring the tool case with me.',
  'Ik ga terug naar de garage met de koffer.',
  'Ik breng de koffer met me mee.',
])('does not turn movement or carrying "%s" into delivery agreement', (text) => {
  const context = fixture();
  const quest = preparedRetrieval(context);
  step(context, 'Ask Ada about the missing case.', [{ type: 'offer', quest }]);
  context.members[0].state.inventory.push({
    ...baseItem('actual-case', 'Workshop tool case', 'tool'), sourceId: 'missing-workshop-tool-case', quantity: 1,
  });
  action(context, text);
  // Use the already compiled action to isolate handover consent from travel compilation.
  const value = compileSceneTurn(context, sceneTurn(context));
  value.questUpdates = [{ operation: { type: 'turnIn', questId: quest.id }, eventId: value.events.find((event) => event.memberId === context.members[0].id && event.phase === 'main')!.id }];
  expect(() => planQuests(context, value)).toThrow(/not ready/);
  expect(context.scene.quests![quest.id].status).toBe('offered');
  expect(context.members[0].state.inventory.some((item) => item.id === 'actual-case')).toBe(true);
});

it('does not implicitly accept a delivery without an actual local holder, or reopen a declined request', () => {
  const context = fixture();
  const quest = preparedRetrieval(context);
  step(context, 'Ask Ada about the missing case.', [{ type: 'offer', quest }]);
  expect(() => step(context, 'I return the tool case to Ada.', [{ type: 'turnIn', questId: quest.id }])).toThrow(/not ready/);
  const caseItem = { ...baseItem('actual-case', 'Workshop tool case', 'tool'), sourceId: 'missing-workshop-tool-case', quantity: 1 };
  context.members[1].state.inventory.push(caseItem);
  const remote = randomUUID();
  context.scene.places![remote] = {
    location: { id: remote, name: 'Wreck', atmosphere: 'A separate salvage site.', hazard: '' },
    encounter: null, loot: [], encounterRisk: { danger: 'safe', reason: 'Salvagers have secured the inspected wreck.' },
  };
  context.scene.memberLocations![context.members[1].id] = remote;
  expect(() => step(context, 'I return the tool case to Ada.', [{ type: 'turnIn', questId: quest.id }])).toThrow(/not ready/);
  expect(context.scene.quests![quest.id].status).toBe('offered');
  context.scene.memberLocations![context.members[1].id] = context.scene.location.id!;
  context.members[1].state.inventory.pop();
  context.members[0].state.inventory.push(caseItem);
  step(context, 'I decline Ada’s request.', [{ type: 'decline', questId: quest.id }]);
  expect(() => step(context, 'I return the tool case to Ada.', [{ type: 'turnIn', questId: quest.id }])).toThrow(/not ready/);
  expect(context.scene.quests![quest.id].status).toBe('declined');
  expect(context.members[0].state.inventory.some((item) => item.id === caseItem.id)).toBe(true);
});

it('keeps nondelivery requests dependent on explicit acceptance', () => {
  const context = fixture();
  const quest = definition();
  step(context, 'Ask Ada about the request.', [{ type: 'offer', quest }]);
  context.scene.features!.pump.properties.repaired = true;
  expect(() => step(context, 'I report the completed repair to Ada.', [{ type: 'turnIn', questId: quest.id }])).toThrow(/not ready/);
  expect(context.scene.quests![quest.id].status).toBe('offered');
});

it('keeps a future collectible bound to real immutable preparation and prevents renamed source duplicates', () => {
  const context = fixture();
  const quest = preparedRetrieval(context);
  const missing = structuredClone(quest);
  if (missing.objectives[0].condition.kind === 'deliver') missing.objectives[0].condition.preparation!.answer = 1;
  expect(() => step(context, 'Ask Ada about the case.', [{ type: 'offer', quest: missing }])).toThrow(/prepared answer/);
  accepted(context, quest);
  const copy = structuredClone(quest);
  copy.id = 'another-case-job';
  copy.name = 'A renamed job';
  if (copy.objectives[0].condition.kind === 'deliver') copy.objectives[0].condition.preparation!.hookId = 'different-hook';
  expect(() => step(context, 'Ask Ada for another case job.', [{ type: 'offer', quest: copy }])).toThrow(/renamed copies/);
  action(context, 'Ask Ada to change where the tool case was lost.');
  const altered = sceneTurn(context);
  altered.notes = [{ id: context.gmMemory![0].id, cause: 'The case was actually never lost.' }];
  expect(() => compileSceneTurn(context, altered)).toThrow(/cause cannot be rewritten/);
  const batch = structuredClone(quest);
  if (batch.objectives[0].condition.kind === 'deliver') batch.objectives[0].condition.quantity = 2;
  expect(questDefinitionSchema.safeParse(batch).success).toBe(false);
});

it('rejects a prepared retrieval whose known approach needs its own promised access reward', () => {
  const context = fixture();
  const quest = preparedRetrieval(context);
  const sealed = randomUUID();
  const here = context.scene.location.id!;
  context.scene.worldMap!.nodes[sealed] = { id: sealed, name: 'Sealed landing', visited: false };
  context.scene.worldMap!.connections.push({ from: here, to: sealed, label: 'Sealed gate', blocked: true, bidirectional: true });
  context.gmMemory![0].locationId = sealed;
  quest.reward.access = [{ from: here, to: sealed }];
  expect(() => step(context, 'Ask Ada about the missing case.', [{ type: 'offer', quest }])).toThrow(/reachable/);
});

it('persists a complete turn-in through a Game restart and preserves local shared collection', async () => {
  const db = openDatabase(':memory:');
  const practice = new PracticeGM();
  const definitionForGame = definition();
  const provider: GameMaster = {
    sceneTurns: true,
    adjudicate: async (context, tools) => {
      if (!context.turn.number) return practice.adjudicate(context, tools);
      const n = context.turn.number;
      return compileSceneTurn(
        context,
        sceneTurn(
          context,
          n === 1
            ? [{ type: 'offer', quest: definitionForGame }]
            : n === 2
              ? [{ type: 'accept', questId: definitionForGame.id }]
              : n === 4
                ? [{ type: 'turnIn', questId: definitionForGame.id }]
                : [],
          n === 3,
        ),
      );
    },
    narrate: practice.narrate.bind(practice),
  };
  const draw = vi.fn(() => 1);
  let game = new Game(db, () => provider, draw);
  try {
    const host = game.identify();
    const c = game.create(host.id, fixture().config);
    const players = [game.identify(), game.identify()];
    for (const [i, p] of players.entries()) {
      const character = game.saveCharacter(p.id, templateCharacter(['Mira', 'Rowan'][i]));
      game.join(c.inviteCode!, p.id, character.id);
      const m = game.members(c.id).find((m) => m.playerId === p.id)!;
      game.manageCharacter(c.id, p.id, {
        type: 'starter',
        itemIds: m.state.starterEquipment.slice(0, 2).map((item) => item.id),
      });
    }
    game.start(c.id, host.id);
    await game.idle();
    const initial = fixture().scene;
    initial.memberLocations = Object.fromEntries(game.members(c.id).map((m) => [m.id, initial.location.id!]));
    db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(initial), c.id);
    const submit = async (text: string, interrupted = false) => {
      const turn = game.pending(c.id)!;
      game.submit(c.id, players[0].id, turn.id, text, false);
      game.submit(c.id, players[1].id, turn.id, '', true);
      await game.idle();
      if (!interrupted) {
        expect(game.snapshot(c.id, host.id).turn?.error).toBeNull();
        expect(game.snapshot(c.id, host.id).turn?.phase).toBe('collecting');
      }
    };
    await submit('Ask Ada about work.');
    await submit('I accept Ada’s request.');
    await submit('I repair the pump.');
    expect(game.snapshot(c.id, host.id).scene.quests![definitionForGame.id].status).toBe('ready');
    db.exec(
      "CREATE TRIGGER interrupt_quest BEFORE UPDATE OF phase ON turns WHEN NEW.phase = 'complete' BEGIN SELECT RAISE(ABORT, 'quest publication interrupted'); END;",
    );
    await submit('I report to Ada and claim the reward.', true);
    expect(game.snapshot(c.id, host.id).turn?.phase).toBe('failed');
    expect(game.snapshot(c.id, host.id).scene.quests![definitionForGame.id].status).toBe('ready');
    expect(game.snapshot(c.id, host.id).scene.loot).toHaveLength(0);
    const rollsBeforeRetry = draw.mock.calls.length;
    db.exec('DROP TRIGGER interrupt_quest');
    game = new Game(db, () => provider, draw);
    game.retry(c.id, host.id);
    await game.idle();
    expect(game.snapshot(c.id, host.id).turn?.phase, game.snapshot(c.id, host.id).turn?.error ?? '').toBe(
      'collecting',
    );
    expect(draw.mock.calls.length).toBe(rollsBeforeRetry);
    const before = game.snapshot(c.id, host.id);
    expect(before.scene.loot).toHaveLength(2);
    expect(before.history.at(-1)?.result?.narration).toContain('available to collect');
    const rolls = draw.mock.calls.length;
    game = new Game(db, () => provider, draw);
    const restored = game.snapshot(c.id, players[1].id);
    expect(restored.scene.quests![definitionForGame.id].status).toBe('completed');
    expect(restored.scene.loot).toEqual(before.scene.loot);
    game.manageCharacter(c.id, players[1].id, {
      type: 'take',
      itemId: restored.scene.loot.find((item) => item.currencyValue)!.id,
    });
    expect(game.members(c.id).find((m) => m.playerId === players[1].id)!.state.currency).toBe(25);
    expect(() =>
      game.manageCharacter(c.id, players[0].id, {
        type: 'take',
        itemId: restored.scene.loot.find((item) => item.currencyValue)!.id,
      }),
    ).toThrow(/no longer available/);
    expect(draw.mock.calls.length).toBe(rolls);
  } finally {
    db.close();
  }
});
