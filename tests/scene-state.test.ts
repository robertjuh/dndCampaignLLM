import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { Game, type GMContext, type GameMaster } from '../server/game';
import { openDatabase } from '../server/db';
import { PracticeGM } from '../server/providers';
import { validateAdjudication } from '../server/turn-resolution';
import { applyFeatureUpdates } from '../server/scene-state';
import { applyAdjudicationRepair, retainAdjudicationProgress } from '../server/adjudication-recovery';
import { environmentalFacts } from '../server/environment';
import { ensureLocations, registerMap } from '../shared/locations';
import { initialScene, initialState, baseItem } from '../shared/rules';
import { templateCharacter } from '../shared/schema';
import { projectJournal } from '../shared/journal';
import { actionId, factualNarration, type TurnAdjudication } from '../shared/turn-resolution';
import { interruptNarration } from './narration-interruption';

function context(): GMContext {
  const members = ['Ragman', 'Rustbeard'].map((name) => {
    const id = randomUUID(),
      character = templateCharacter(name);
    return {
      id,
      character,
      characterId: randomUUID(),
      playerId: randomUUID(),
      playerName: name,
      state: initialState(character, id),
      active: true,
    };
  });
  const scene = ensureLocations(
    initialScene('Ship deck'),
    members.map((member) => member.id),
  );
  const dock = randomUUID();
  scene.places![dock] = {
    location: { id: dock, name: 'Dock', atmosphere: 'A quiet landing.', hazard: '' },
    encounter: null,
    loot: [],
  };
  scene.worldMap!.nodes[dock] = { id: dock, name: 'Dock', visited: true };
  scene.worldMap!.connections.push({
    from: scene.location.id!,
    to: dock,
    label: 'Gangway',
    blocked: false,
    bidirectional: true,
  });
  scene.features = {
    ship: {
      id: 'ship',
      name: 'De Scheve Lepel',
      aliases: ['the ship'],
      locationId: scene.location.id!,
      properties: { control: 'Captain Mara', gangway: 'lowered', cargo: 'secured' },
      route: { from: scene.location.id!, to: dock },
      fact: 'De Scheve Lepel is moored at the dock under Captain Mara’s control.',
    },
  };
  return {
    config: {
      ruleset: 'roguelike-v1',
      name: 'Scene continuity',
      setting: 'Ship deck',
      premise: '',
      provider: 'practice',
      model: '',
      language: 'English',
      tone: '',
      instructions: '',
      custom: [],
    },
    members,
    scene,
    journal: [{ kind: 'fact', name: 'De Scheve Lepel', detail: scene.features.ship.fact }],
    history: [],
    receipts: {},
    turn: {
      id: randomUUID(),
      number: 2,
      phase: 'resolving',
      roster: members.map((member) => member.id),
      actions: members.map((member, i) => ({
        memberId: member.id,
        text: i ? '' : 'Take control and raise the gangway.',
        passed: !!i,
      })),
      rolls: [],
      result: null,
      error: null,
    },
  };
}

function proposal(c: GMContext, blocked = false): TurnAdjudication {
  const events: TurnAdjudication['events'] = [];
  const actions = c.turn.actions.map((submitted, index): TurnAdjudication['actions'][number] => {
    const id = actionId(c.turn.id, submitted.memberId),
      eventId = `act:${index}`;
    const name = c.members.find((member) => member.id === submitted.memberId)!.character.name;
    const fact = submitted.passed
      ? `${name} waits.`
      : blocked
        ? `${name} cannot complete the action.`
        : `${name} takes control of De Scheve Lepel and raises the gangway.`;
    const status = submitted.passed ? 'passed' : blocked ? 'blocked' : 'success';
    const component = {
      status: blocked ? ('blocked' as const) : ('success' as const),
      basis: blocked ? ('none' as const) : ('routine' as const),
      fact,
      reason: 'The public scene supports this outcome.',
      receiptRefs: [],
      eventIds: [eventId],
    };
    events.push({
      id: eventId,
      sequence: events.length,
      kind: 'action',
      memberId: submitted.memberId,
      actionId: id,
      phase: submitted.passed ? null : 'main',
      result: submitted.passed ? null : component.status,
      locationRef: c.scene.memberLocations![submitted.memberId],
      fact,
      receiptRefs: [],
      dependsOn: [],
    });
    return {
      actionId: id,
      memberId: submitted.memberId,
      ...component,
      status,
      basis: submitted.passed ? 'none' : component.basis,
      components: { main: submitted.passed ? null : component, minor: null },
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
    rewards: { xp: 0, currency: 0, reason: 'No repeated reward.' },
  };
}
function changed(c: GMContext) {
  const value = proposal(c);
  value.featureUpdates = [
    {
      featureId: 'ship',
      name: 'the ship',
      locationId: 'current',
      properties: { Control: 'Ragman’s crew', gangway: 'raised' },
      passable: false,
      eventId: 'act:0',
    },
  ];
  return value;
}
function commit(c: GMContext, value: TurnAdjudication) {
  const resolve = (ref: string) => (ref === 'current' ? c.scene.location.id! : ref);
  registerMap(c.scene, value.mapUpdates, {}, c.scene.location.id!);
  applyFeatureUpdates(c.scene, value, resolve);
}
const close: (() => void)[] = [];
afterEach(() => close.splice(0).forEach((fn) => fn()));

it('saves current control and passage state, keeps unchanged facts, and projects status beside historical prose', () => {
  const c = context(),
    before = structuredClone(c.scene);
  const value = validateAdjudication(c, changed(c));
  expect(c.scene).toEqual(before);
  expect(value.mapUpdates!.connections).toHaveLength(1);
  expect(value.mapUpdates!.connections[0]).toMatchObject({ blocked: true, eventId: 'act:0' });
  expect(validateAdjudication(c, value)).toEqual(value);
  commit(c, value);
  commit(c, value);
  expect(c.scene.features!.ship).toMatchObject({
    id: 'ship',
    name: 'De Scheve Lepel',
    properties: {
      control: 'Ragman’s crew',
      gangway: 'raised',
      cargo: 'secured',
    },
  });
  expect(c.scene.worldMap!.connections[0].blocked).toBe(true);
  const journal = projectJournal(c.journal, c.scene, c.members, 'English');
  expect(journal[0].detail).toContain('Captain Mara');
  expect(journal[0].featureStatus).toContain('Ragman’s crew');
  expect(journal[0].featureStatus).toContain('passage: blocked');
  expect(environmentalFacts(c)['feature:ship']).toContain('"control":"Ragman’s crew"');
});

it('closes the old boarding route when rebinding, while preserving passengers and inventory', () => {
  const c = context(),
    port = randomUUID(),
    here = c.scene.location.id!;
  c.scene.places![port] = {
    location: { id: port, name: 'New port', atmosphere: 'A known berth.', hazard: '' },
    encounter: null,
    loot: [],
  };
  c.scene.worldMap!.nodes[port] = { id: port, name: 'New port', visited: true };
  c.scene.worldMap!.connections.push({
    from: here,
    to: port,
    blocked: true,
    label: 'New berth',
    bidirectional: true,
  });
  const positions = structuredClone(c.scene.memberLocations),
    members = structuredClone(c.members);
  const value = changed(c);
  value.featureUpdates![0].route = { from: 'current', to: port };
  value.featureUpdates![0].passable = true;
  value.featureUpdates![0].properties = { berth: 'New port', gangway: 'lowered' };
  const accepted = validateAdjudication(c, value);
  commit(c, accepted);
  expect(c.scene.worldMap!.connections.map((edge) => edge.blocked)).toEqual([true, false]);
  expect(c.scene.features!.ship.route).toEqual({ from: here, to: port });
  expect(c.scene.memberLocations).toEqual(positions);
  expect(c.members).toEqual(members);
});

it('keeps known remote controls causal and rejects an unsupported remote state change', () => {
  const c = context(),
    dock = c.scene.worldMap!.connections[0].to;
  c.scene.features!.ship.locationId = dock;
  const value = proposal(c);
  value.events.push({
    id: 'remote-gangway',
    sequence: value.events.length,
    kind: 'world',
    actionId: null,
    memberId: null,
    phase: null,
    result: null,
    locationRef: dock,
    fact: 'De Scheve Lepel’s gangway rises in response to the deck control.',
    receiptRefs: [],
    dependsOn: [{ eventId: 'act:0', requires: 'success' }],
  });
  value.featureUpdates = [
    {
      featureId: 'ship',
      name: 'De Scheve Lepel',
      locationId: dock,
      properties: { gangway: 'raised' },
      passable: false,
      eventId: 'remote-gangway',
    },
  ];
  expect(() => validateAdjudication(c, value)).not.toThrow();
  value.events.at(-1)!.dependsOn = [];
  expect(() => validateAdjudication(c, value)).toThrow('known feature');
});

it.each([
  'missing-event',
  'failed-event',
  'new-remote-feature',
  'invented-route',
  'contradictory-route',
  'player',
  'item',
])('rejects an unsupported %s feature change', (defect) => {
  const c = context(),
    value = changed(c),
    update = value.featureUpdates![0];
  if (defect === 'missing-event') update.eventId = 'invented';
  if (defect === 'failed-event') value.events[0].result = 'failure';
  if (defect === 'new-remote-feature') {
    update.featureId = 'unknown-ship';
    update.name = 'Another ship';
    update.locationId = c.scene.worldMap!.connections[0].to;
  }
  if (defect === 'invented-route') update.route = { from: 'current', to: randomUUID() };
  if (defect === 'contradictory-route')
    value.mapUpdates = {
      locations: [],
      connections: [{ ...c.scene.worldMap!.connections[0], blocked: false, eventId: 'act:0' }],
    };
  if (defect === 'player') update.featureId = c.members[0].id;
  if (defect === 'item') {
    const item = baseItem('owned-tool', 'Owned tool', 'tool');
    c.members[0].state.inventory.push({ ...item, quantity: 1 });
    update.featureId = item.id;
  }
  expect(() => validateAdjudication(c, value)).toThrow();
});

it('keeps successful feature changes and route changes when an unrelated movement cannot be retained', () => {
  const c = context();
  c.turn.actions[1] = { ...c.turn.actions[1], text: 'Walk to the dock.', passed: false };
  const candidate = changed(c),
    failed = candidate.events[1];
  failed.effect = 'movement';
  failed.locationRef = c.scene.worldMap!.connections[0].to;
  const retained = retainAdjudicationProgress(c, candidate, proposal(c, true), (value) =>
    validateAdjudication(c, value),
  );
  expect(retained.value.actions[0].status).toBe('success');
  expect(retained.value.actions[1].status).toBe('blocked');
  expect(retained.value.featureUpdates).toHaveLength(1);
  expect(retained.value.mapUpdates!.connections[0].blocked).toBe(true);
  expect(() =>
    applyAdjudicationRepair(
      retained,
      {
        featureUpdates: [
          { ...retained.value.featureUpdates![0], properties: { control: 'An invented owner' } },
        ],
      },
      c,
    ),
  ).toThrow('validated scene state');
});

it('does not use a causally later opening to authorize an earlier crossing', () => {
  const c = context(),
    dock = c.scene.worldMap!.connections[0].to;
  c.scene.worldMap!.connections[0].blocked = true;
  c.turn.actions[1] = { ...c.turn.actions[1], text: 'Operate the opening control.', passed: false };
  const value = changed(c),
    crossing = value.events[0];
  crossing.effect = 'movement';
  crossing.locationRef = dock;
  value.memberLocations = [{ memberId: c.members[0].id, locationId: dock, movementEventId: crossing.id }];
  value.events.push({
    id: 'gate-opening',
    sequence: value.events.length,
    kind: 'world',
    memberId: null,
    actionId: null,
    phase: null,
    result: null,
    fact: 'De Scheve Lepel’s gangway opens after Rustbeard operates the control.',
    locationRef: 'current',
    receiptRefs: [],
    dependsOn: [{ eventId: 'act:1', requires: 'success' }],
  });
  value.featureUpdates![0].eventId = 'gate-opening';
  value.featureUpdates![0].passable = true;
  expect(() => validateAdjudication(c, value)).toThrow('blocked');
});

it.each(['after', 'before'] as const)(
  'uses passage state at crossing time when the route closes %s the crossing',
  (when) => {
    const c = context(),
      dock = c.scene.worldMap!.connections[0].to,
      value = changed(c);
    const crossing = value.events[0];
    crossing.fact = 'Ragman crosses the gangway to the dock.';
    crossing.effect = 'movement';
    crossing.locationRef = dock;
    value.actions[0].components.main!.fact = crossing.fact;
    value.actions[0].fact = crossing.fact;
    value.memberLocations = [{ memberId: c.members[0].id, locationId: dock, movementEventId: crossing.id }];
    const closure = {
      id: 'close-gangway',
      sequence: 0,
      kind: 'world' as const,
      actionId: null,
      memberId: null,
      phase: null,
      result: null,
      locationRef: c.scene.location.id!,
      fact: 'De Scheve Lepel’s gangway rises.',
      receiptRefs: [],
      dependsOn: [],
    };
    if (when === 'before') value.events.unshift(closure);
    else value.events.push(closure);
    value.events.forEach((event, sequence) => (event.sequence = sequence));
    value.featureUpdates![0].eventId = closure.id;
    if (when === 'before') expect(() => validateAdjudication(c, value)).toThrow('blocked');
    else {
      const accepted = validateAdjudication(c, value);
      commit(c, accepted);
      expect(c.scene.worldMap!.connections[0].blocked).toBe(true);
    }
  },
);

it('resumes finalized scene state after restart without another adjudication or passenger movement', async () => {
  const db = openDatabase(':memory:');
  close.push(() => db.close());
  const practice = new PracticeGM(),
    draw = vi.fn((sides: number) => Math.min(12, sides));
  const adjudicate = vi.fn(
    async (c: GMContext, tools: Parameters<NonNullable<GameMaster['adjudicate']>>[1]) =>
      c.turn.number === 0
        ? practice.adjudicate(c, tools)
        : c.turn.actions.every((action) => action.passed)
          ? proposal(c)
          : changed(c),
  );
  const provider: GameMaster = { adjudicate, narrate: practice.narrate.bind(practice) };
  let game = new Game(db, () => provider, draw);
  const host = game.identify(),
    players = [game.identify(), game.identify()],
    campaign = game.create(host.id, context().config);
  for (const [i, player] of players.entries()) {
    const character = templateCharacter(i ? 'Rustbeard' : 'Ragman');
    character.selectedEquipmentIds = character.equipmentOptions.slice(0, 2).map((item) => item.id);
    game.join(campaign.inviteCode!, player.id, game.saveCharacter(player.id, character).id);
  }
  game.start(campaign.id, host.id);
  await game.idle();
  const snapshot = () => game.snapshot(campaign.id, host.id);
  const scene = snapshot().scene,
    original = context().scene,
    dock = original.worldMap!.connections[0].to;
  scene.places![dock] = original.places![dock];
  scene.worldMap!.nodes[dock] = original.worldMap!.nodes[dock];
  scene.worldMap!.connections = [{ ...original.worldMap!.connections[0], from: scene.location.id! }];
  scene.features = {
    ship: {
      ...original.features!.ship,
      locationId: scene.location.id!,
      route: { from: scene.location.id!, to: dock },
    },
  };
  db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(scene), campaign.id);
  const turnId = snapshot().turn!.id;
  provider.narrate = async () => interruptNarration(db, 'Crash after scene finalization');
  const positions = structuredClone(scene.memberLocations);
  game.submit(campaign.id, players[0].id, turnId, 'Take control and raise the gangway.', false);
  game.submit(campaign.id, players[1].id, turnId, '', true);
  await game.idle();
  expect(snapshot().turn!.phase).toBe('failed');
  const saved = JSON.parse(
    (db.prepare('SELECT draft FROM turns WHERE id=?').get(turnId) as { draft: string }).draft,
  );
  expect(saved.resolution.featureStates[0].properties.control).toBe('Ragman’s crew');
  expect(snapshot().scene.features!.ship.properties.control).toBe('Captain Mara');
  const calls = adjudicate.mock.calls.length,
    rolls = draw.mock.calls.length;
  provider.narrate = (resolution, config) => Promise.resolve(factualNarration(resolution, config.language));
  game = new Game(db, () => provider, draw);
  game.retry(campaign.id, host.id);
  await game.idle();
  expect(snapshot().turn!.phase, snapshot().turn!.error ?? '').toBe('collecting');
  expect(snapshot().scene.features!.ship.properties.control).toBe('Ragman’s crew');
  expect(snapshot().scene.worldMap!.connections[0].blocked).toBe(true);
  expect(snapshot().scene.memberLocations).toEqual(positions);
  expect(adjudicate).toHaveBeenCalledTimes(calls);
  expect(draw).toHaveBeenCalledTimes(rolls);
  const next = snapshot().turn!.id;
  for (const player of players) game.submit(campaign.id, player.id, next, '', true);
  await game.idle();
  expect(snapshot().turn!.phase).toBe('collecting');
  expect(snapshot().scene.features!.ship.properties.gangway).toBe('raised');
});
