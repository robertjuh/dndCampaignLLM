import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { Game, type GMContext, type GameMaster } from '../server/game';
import { openDatabase } from '../server/db';
import { PracticeGM, adjudicationInput } from '../server/providers';
import {
  applyNPCUpdates,
  knownNPCs,
  persistentEnemy,
  saveNPCEncounter,
  validateNPCUpdates,
} from '../server/npcs';
import { environmentalFacts } from '../server/environment';
import { normalizeCombatInput } from '../server/combat';
import { engineEvents } from '../server/turn-resolution';
import { projectJournal } from '../shared/journal';
import { ensureLocations } from '../shared/locations';
import { baseItem, initialScene, initialState } from '../shared/rules';
import { enemySchema, templateCharacter, type Enemy } from '../shared/schema';
import { factualNarration, turnAdjudicationSchema } from '../shared/turn-resolution';

function context(): GMContext {
  const id = randomUUID(),
    character = templateCharacter('Pirate');
  const scene = ensureLocations(initialScene('Dock'), [id]);
  const captain: Enemy = {
    ...enemySchema.parse({
      id: 'captain',
      name: 'Captain Mara',
      tier: 'normal',
      hp: 7,
      defense: 10,
      attack: 2,
      damage: '1d6',
      description: 'The captain of De Scheve Lepel.',
      tactic: 'Defend the ship.',
    }),
    maxHp: 18,
    initiative: 10,
    withdrawn: true,
    conditions: ['Weakened'],
    conditionTurns: { Weakened: 2 },
    equipment: [baseItem('captain-sword', 'Captain’s sword', 'weapon')],
  };
  scene.encounter = { enemies: [captain], initiative: [], round: 3, victory: true, escaped: false };
  return {
    config: {
      ruleset: 'roguelike-v1',
      name: 'Ship crew',
      setting: 'Dock',
      premise: '',
      language: 'English',
      provider: 'practice',
      model: '',
      tone: '',
      instructions: '',
      custom: [],
    },
    scene,
    members: [
      {
        id,
        playerId: randomUUID(),
        characterId: randomUUID(),
        playerName: 'Player',
        character,
        state: initialState(character, id),
        active: true,
      },
    ],
    journal: [{ kind: 'npc', name: 'Captain Mara', detail: 'Captain Mara stands on her ship.' }],
    history: [],
    receipts: {},
    turn: {
      id: randomUUID(),
      number: 3,
      phase: 'resolving',
      roster: [id],
      actions: [{ memberId: id, text: 'Watch the captain.', passed: false }],
      rolls: [],
      result: null,
      error: null,
    },
  };
}
function update(c: GMContext) {
  const value = turnAdjudicationSchema.parse(adjudicationInput(c).schemaExample);
  value.events.push({
    id: 'captain-decision',
    sequence: value.events.length,
    kind: 'world',
    memberId: null,
    actionId: null,
    phase: null,
    result: null,
    receiptRefs: [],
    dependsOn: [],
    locationRef: 'current',
    fact: 'Captain Mara, also known as de kapitein, surrenders and remains with De Scheve Lepel’s crew.',
  });
  value.npcUpdates = [
    {
      npcId: 'captain',
      name: 'Captain Mara',
      aliases: ['de kapitein'],
      locationId: 'current',
      status: 'surrendered',
      allegiance: 'De Scheve Lepel’s crew',
      eventId: 'captain-decision',
    },
  ];
  return value;
}
const closes: (() => void)[] = [];
afterEach(() => closes.splice(0).forEach((close) => close()));

it('backfills an old encounter, binds aliases and preserves injuries and equipment across a new fight', () => {
  const c = context(),
    before = structuredClone(c.scene);
  const value = update(c),
    resolve = (ref: string) => (ref === 'current' ? c.scene.location.id! : ref);
  validateNPCUpdates(c, value, resolve);
  applyNPCUpdates(c.scene, value, resolve);
  expect(c.scene.npcs!.captain).toMatchObject({
    id: 'captain',
    aliases: ['de kapitein'],
    status: 'surrendered',
    allegiance: 'De Scheve Lepel’s crew',
    enemy: { hp: 7, maxHp: 18, conditions: ['Weakened'] },
  });
  const proposed = {
    ...enemySchema.strip().parse(before.encounter!.enemies[0]),
    id: 'new-captain',
    name: 'de kapitein',
    hp: 300,
    attack: 15,
    damage: '4d12',
  };
  expect(persistentEnemy(c, proposed, c.scene.location.id!)).toMatchObject({
    id: 'captain',
    name: 'Captain Mara',
    hp: 7,
    maxHp: 18,
    attack: 2,
    damage: '1d6',
    equipment: before.encounter!.enemies[0].equipment,
  });
  const journal = projectJournal(
    [{ kind: 'npc', name: 'de kapitein', detail: 'Earlier prose.' }],
    c.scene,
    c.members,
    'English',
  );
  expect(journal[0]).toMatchObject({ npcId: 'captain' });
  expect(journal[0].npcStatus).toContain('Surrendered');
  expect(journal[0].npcStatus).toContain('7/18 HP');
});

it('keeps aliases targetable in a later combat round', () => {
  const c = context();
  c.scene.npcs = knownNPCs(c.scene);
  c.scene.npcs.captain.aliases = ['de kapitein'];
  c.scene.encounter!.victory = false;
  c.scene.encounter!.enemies[0].withdrawn = false;
  c.turn.actions[0].text = 'Ik val de kapitein aan.';
  const plan = normalizeCombatInput(c, {
    actions: [{ memberId: c.members[0].id, main: 'attack', targetId: 'de kapitein' }],
  });
  expect(plan.actions[0]).toMatchObject({ main: 'attack', targetId: 'captain' });
  expect(plan.actions[0].blockedReason).toBeUndefined();
});

it('keeps death authoritative after the old encounter is replaced', () => {
  const c = context();
  c.scene.encounter!.enemies[0].hp = 0;
  saveNPCEncounter(c.scene, c.scene.location.id!, c.scene.encounter!);
  c.scene.npcs!.captain.aliases = ['de kapitein'];
  c.scene.encounter = null;
  const proposed = enemySchema.parse({
    id: 'different-id',
    name: 'de kapitein',
    tier: 'boss',
    hp: 100,
    defense: 20,
    attack: 10,
    damage: '4d6',
    description: '',
    tactic: '',
  });
  expect(() => persistentEnemy(c, proposed, c.scene.location.id!)).toThrow('permanently dead');
  const value = update(c);
  expect(() => validateNPCUpdates(c, value, () => c.scene.location.id!)).toThrow('permanent');
});

it('moves observed NPC state over an open route and excludes stale journal presence at the old place', () => {
  const c = context(),
    deck = randomUUID();
  c.scene.places![deck] = {
    location: { id: deck, name: 'Deck', atmosphere: '', hazard: '' },
    encounter: null,
    loot: [],
  };
  c.scene.worldMap!.nodes[deck] = { id: deck, name: 'Deck', visited: true };
  const route = {
    from: c.scene.location.id!,
    to: deck,
    blocked: false,
    bidirectional: true,
    label: 'Gangway',
  };
  c.scene.worldMap!.connections.push(route);
  const value = update(c);
  value.events.at(-1)!.locationRef = deck;
  value.events.at(-1)!.fact = 'Captain Mara walks onto the deck with her crew.';
  const crossing = value.events.find(
    (event) => event.memberId === c.members[0].id && event.kind === 'action',
  )!;
  crossing.effect = 'movement';
  crossing.locationRef = deck;
  value.memberLocations = [{ memberId: c.members[0].id, locationId: deck, movementEventId: crossing.id }];
  value.npcUpdates![0].locationId = deck;
  const resolve = (ref: string) => (ref === 'current' ? c.scene.location.id! : ref);
  route.blocked = true;
  expect(() => validateNPCUpdates(c, value, resolve)).toThrow('open adjacent');
  route.blocked = false;
  validateNPCUpdates(c, value, resolve);
  applyNPCUpdates(c.scene, value, resolve);
  expect(environmentalFacts(c)['journal:npc:Captain Mara']).toBeUndefined();
  saveNPCEncounter(c.scene, c.scene.location.id!, c.scene.encounter!);
  expect(c.scene.npcs!.captain.locationId).toBe(deck);
  const returning = persistentEnemy(
    c,
    enemySchema.strip().parse(c.scene.encounter!.enemies[0]),
    c.scene.location.id!,
  );
  expect(returning).toMatchObject({ id: 'captain', hp: 7 });
  route.blocked = true;
  expect(() =>
    persistentEnemy(c, enemySchema.strip().parse(c.scene.encounter!.enemies[0]), c.scene.location.id!),
  ).toThrow('not at');
});

it('keeps a long alias history without enlarging the optional update beyond its input limit', () => {
  const c = context();
  c.scene.npcs = knownNPCs(c.scene);
  c.scene.npcs.captain.aliases = Array.from({ length: 15 }, (_, i) => `Known title ${i}`);
  const value = update(c),
    resolve = () => c.scene.location.id!;
  validateNPCUpdates(c, value, resolve);
  expect(() => turnAdjudicationSchema.parse(value)).not.toThrow();
  applyNPCUpdates(c.scene, value, resolve);
  expect(c.scene.npcs.captain.aliases).toHaveLength(16);
});

it.each(['player', 'false-death', 'active-withdrawal', 'missing-event', 'merged-people'])(
  'rejects an unsupported %s state change',
  (defect) => {
    const c = context(),
      value = update(c);
    if (defect === 'player') value.npcUpdates![0].npcId = c.members[0].id;
    if (defect === 'false-death') value.npcUpdates![0].status = 'dead';
    if (defect === 'active-withdrawal') {
      c.scene.encounter!.victory = false;
      c.scene.encounter!.enemies[0].withdrawn = false;
    }
    if (defect === 'missing-event') value.npcUpdates![0].eventId = 'invented';
    if (defect === 'merged-people') {
      c.scene.npcs = knownNPCs(c.scene);
      c.scene.npcs.other = { ...structuredClone(c.scene.npcs.captain), id: 'other', name: 'Other captain' };
      value.npcUpdates![0].aliases = ['Other captain'];
    }
    expect(() => validateNPCUpdates(c, value, () => c.scene.location.id!)).toThrow();
  },
);

it('restores a returning opponent through the real start tool, without new loot, then prevents resurrection', async () => {
  const db = openDatabase(':memory:');
  closes.push(() => db.close());
  const practice = new PracticeGM(),
    draw = vi.fn((sides: number) => Math.min(12, sides));
  const provider: GameMaster = {
    adjudicate: async (c, tools) => {
      if (c.turn.number)
        tools.startCombat([
          {
            ...enemySchema.strip().parse(context().scene.encounter!.enemies[0]),
            id: 'replacement-id',
            name: 'de kapitein',
            hp: 200,
          },
        ]);
      const value = adjudicationInput(c).schemaExample;
      const result = turnAdjudicationSchema.parse({
        ...value,
        events: [...engineEvents(c), ...value.events],
        arrivals: undefined,
        encounterRisks: undefined,
        worldProgress: undefined,
      });
      if (!c.turn.number) {
        result.events.push({
          id: 'captain-present',
          sequence: result.events.length,
          kind: 'world',
          memberId: null,
          actionId: null,
          phase: null,
          result: null,
          receiptRefs: [],
          dependsOn: [],
          locationRef: 'current',
          fact: 'Captain Mara, called de kapitein, stands on the dock with De Scheve Lepel’s crew.',
        });
        result.npcUpdates = [
          {
            npcId: 'captain',
            name: 'Captain Mara',
            aliases: ['de kapitein'],
            locationId: 'current',
            allegiance: 'De Scheve Lepel’s crew',
            eventId: 'captain-present',
          },
        ];
        result.journal = [{ kind: 'npc', name: 'Captain Mara', detail: result.events.at(-1)!.fact }];
      }
      return result;
    },
    narrate: practice.narrate.bind(practice),
  };
  let game = new Game(db, () => provider, draw);
  const host = game.identify(),
    player = game.identify(),
    campaign = game.create(host.id, context().config);
  const character = templateCharacter('Pirate');
  character.selectedEquipmentIds = character.equipmentOptions.slice(0, 2).map((item) => item.id);
  game.join(campaign.inviteCode!, player.id, game.saveCharacter(player.id, character).id);
  game.start(campaign.id, host.id);
  await game.idle();
  const snapshot = () => game.snapshot(campaign.id, host.id);
  expect(snapshot().turn!.phase).toBe('collecting');
  expect(snapshot().scene.npcs!.captain).toMatchObject({
    status: 'alive',
    aliases: ['de kapitein'],
    allegiance: 'De Scheve Lepel’s crew',
  });
  expect(snapshot().journal[0].npcStatus).toContain('Alive');
  const scene = snapshot().scene;
  scene.encounter = context().scene.encounter;
  saveNPCEncounter(scene, scene.location.id!, scene.encounter!);
  db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(scene), campaign.id);
  game = new Game(db, () => provider, draw);
  draw.mockClear();
  game.submit(campaign.id, player.id, snapshot().turn!.id, '', true);
  await game.idle();
  expect(snapshot().turn!.phase, snapshot().turn!.error ?? '').toBe('collecting');
  expect(snapshot().scene.encounter!.enemies[0]).toMatchObject({
    id: 'captain',
    name: 'Captain Mara',
    hp: 7,
    maxHp: 18,
    conditions: ['Weakened'],
    equipment: scene.encounter!.enemies[0].equipment,
  });
  expect(draw.mock.calls.filter(([sides]) => sides === 100)).toHaveLength(0);
  const dead = snapshot().scene;
  dead.encounter!.victory = true;
  dead.encounter!.enemies[0].hp = 0;
  saveNPCEncounter(dead, dead.location.id!, dead.encounter!);
  dead.encounter = null;
  db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(dead), campaign.id);
  game = new Game(db, () => provider, draw);
  draw.mockClear();
  game.submit(campaign.id, player.id, snapshot().turn!.id, '', true);
  await game.idle();
  expect(snapshot().turn!.phase).toBe('failed');
  expect(snapshot().turn!.error).toContain('permanently dead');
  expect(draw).not.toHaveBeenCalled();
});
