import { interruptNarration } from './narration-interruption';
import { afterEach, expect, it, vi } from 'vitest';
import { openDatabase } from '../server/db';
import { Game, type GameMaster, type GMContext, type GameTools } from '../server/game';
import { engineEvents, validateAdjudication } from '../server/turn-resolution';
import { migrateWorldMaps, migrateWorldMapPositions } from '../server/location-migration';
import { ensureWorldMapPositions } from '../shared/world-map-layout';
import {
  actionId,
  factualNarration,
  turnAdjudicationSchema,
  type TurnAdjudication,
} from '../shared/turn-resolution';
import { baseItem } from '../shared/rules';
import { memberScene } from '../shared/locations';
import { templateCharacter, type Scene } from '../shared/schema';
import savedKraterwereld from './fixtures/kraterwereld-exploration.json';
import { travelNextHop, locationReferences, normalizeAdjudicationReferences } from '../server/world-map';
import { validateExploration } from '../server/exploration';
import { adjudicationInput, ChatGPTGM } from '../server/providers';
import type { ChatGPTAuth } from '../server/auth';

const close: (() => void)[] = [];
afterEach(() => close.splice(0).forEach((fn) => fn()));

function routine(context: GMContext): TurnAdjudication {
  const events = engineEvents(context);
  const actions = context.turn.actions.map((submitted): TurnAdjudication['actions'][number] => {
    const id = actionId(context.turn.id, submitted.memberId);
    const eventId = `${id}:result`;
    const fact = submitted.passed ? 'The character waits.' : 'The character follows the open route.';
    events.push({
      id: eventId,
      sequence: events.length,
      kind: 'action',
      actionId: id,
      memberId: submitted.memberId,
      fact,
      receiptRefs: [],
      dependsOn: [],
      phase: submitted.passed ? null : 'main',
      result: submitted.passed ? null : 'success',
      ...(submitted.passed ? {} : { effect: 'movement' as const }),
    });
    const component = {
      status: 'success' as const,
      basis: 'routine' as const,
      fact,
      reason: 'The established route is open.',
      receiptRefs: [],
      eventIds: [eventId],
    };
    return {
      actionId: id,
      memberId: submitted.memberId,
      ...component,
      status: submitted.passed ? 'passed' : 'success',
      basis: submitted.passed ? 'none' : 'routine',
      components: { main: submitted.passed ? null : component, minor: null },
    };
  });
  events.push({
    id: 'world:routes',
    sequence: events.length,
    kind: 'world',
    actionId: null,
    memberId: null,
    fact: 'Visible paths lead to the watchtower, market and drain entrance.',
    receiptRefs: [],
    dependsOn: [],
    phase: 'aftermath',
    result: null,
    locationRef: context.scene.location.id!,
  });
  return {
    version: 2,
    turnId: context.turn.id,
    actions,
    events,
    changes: [],
    journal: [],
    location: null,
    memberLocations: [],
    rewards: { xp: 0, gold: 0, reason: 'No new achievement.' },
  };
}

function exits(context: GMContext): TurnAdjudication {
  return {
    ...routine(context),
    mapUpdates: {
      locations: [
        { ref: 'new:tower', name: 'Watchtower' },
        { ref: 'new:market', name: 'Market street' },
        { ref: 'new:drain', name: 'Drain entrance' },
      ],
      connections: ['tower', 'market', 'drain'].map((ref) => ({
        from: 'current',
        to: `new:${ref}`,
        label: ref === 'drain' ? 'Locked gate' : 'Open path',
        blocked: ref === 'drain',
        bidirectional: true,
        eventId: 'world:routes',
      })),
    },
  };
}

function arrival(context: GMContext, ref: string, name: string): TurnAdjudication {
  const value = routine(context);
  value.placeUpdates = [{ ref, location: { name, atmosphere: 'A quiet room.', hazard: '' } }];
  value.sceneFocus = ref;
  value.memberLocations = value.actions
    .filter((action) => action.status !== 'passed')
    .map((action) => ({
      memberId: action.memberId,
      locationId: ref,
      movementEventId: action.eventIds[0],
    }));
  return value;
}

async function table(opening?: (context: GMContext) => TurnAdjudication) {
  const db = openDatabase(':memory:');
  close.push(() => db.close());
  const provider: GameMaster = {
    adjudicate: async (context) =>
      context.turn.number === 0 && opening ? opening(context) : routine(context),
    narrate: async (resolution, config) => factualNarration(resolution, config.language),
  };
  const game = new Game(db, () => provider);
  const host = game.identify();
  const players = [game.identify(), game.identify()];
  const campaign = game.create(host.id, {
    name: 'Mapped world',
    setting: 'Courtyard',
    premise: '',
    tone: '',
    language: 'English',
    instructions: '',
    custom: [],
    provider: 'practice',
  });
  for (const [i, player] of players.entries()) {
    const character = templateCharacter(`Player ${i}`);
    character.selectedEquipmentIds = character.equipmentOptions.slice(0, 2).map((item) => item.id);
    const saved = game.saveCharacter(player.id, character);
    game.join(campaign.inviteCode!, player.id, saved.id);
  }
  game.start(campaign.id, host.id);
  await game.idle();
  const snapshot = () => game.snapshot(campaign.id, host.id);
  expect(snapshot().turn?.phase, snapshot().turn?.error ?? '').toBe('collecting');
  const saveScene = (scene: Scene) =>
    db.prepare('UPDATE campaigns SET scene = ? WHERE id = ?').run(JSON.stringify(scene), campaign.id);
  const turn = async (texts = ['Follow the open route.', 'Follow the open route.']) => {
    const id = snapshot().turn!.id;
    players.forEach((player, i) => game.submit(campaign.id, player.id, id, texts[i], !texts[i]));
    await game.idle();
    return id;
  };
  const context = (): GMContext => {
    const state = snapshot();
    return {
      config: state.config,
      scene: state.scene,
      members: game.members(campaign.id),
      turn: {
        ...state.turn!,
        actions: game.members(campaign.id).map((member) => ({
          memberId: member.id,
          text: 'Walk along the open path.',
          passed: false,
        })),
      },
      journal: [],
      history: [],
    };
  };
  return { db, game, host, campaign, provider, snapshot, saveScene, turn, context };
}

it('saves three observable adjacent previews once through a narration restart without generating their rooms', async () => {
  const f = await table();
  const origin = f.snapshot().scene.location.id!;
  const adjudicate = vi.fn(async (context: GMContext) => exits(context));
  f.provider.adjudicate = adjudicate;
  const narrate = f.provider.narrate!;
  f.provider.narrate = async () => {
    interruptNarration(f.db, 'Interrupted narration');
  };
  const turnId = await f.turn(['', '']);
  expect(f.snapshot().turn?.phase, f.snapshot().turn?.error ?? '').toBe('failed');
  const draft = JSON.parse(
    (f.db.prepare('SELECT draft FROM turns WHERE id = ?').get(turnId) as { draft: string }).draft,
  );
  expect(draft.resolution, f.snapshot().turn?.error ?? '').toBeDefined();
  const refs = draft.placeRefs as Record<string, string>;
  expect(new Set(['tower', 'market', 'drain'].map((ref) => refs[`new:${ref}`])).size).toBe(3);
  f.provider.narrate = narrate;
  const restarted = new Game(f.db, () => f.provider);
  restarted.retry(f.campaign.id, f.host.id);
  await restarted.idle();
  expect(f.snapshot().history.at(-1)?.id, f.snapshot().turn?.error ?? '').toBe(turnId);
  expect(adjudicate).toHaveBeenCalledTimes(1);
  const scene = f.snapshot().scene;
  expect(scene.worldMap!.positions).toEqual(draft.scene.worldMap.positions);
  expect(Object.keys(scene.worldMap!.nodes)).toHaveLength(4);
  expect(scene.worldMap!.nodes[origin].visited).toBe(true);
  for (const ref of ['tower', 'market', 'drain']) {
    const id = refs[`new:${ref}`];
    expect(scene.worldMap!.nodes[id]).toMatchObject({ id, visited: false });
    expect(scene.places?.[id]).toBeUndefined();
  }
  expect(scene.worldMap!.connections).toHaveLength(3);
  expect(scene.worldMap!.connections.find((edge) => edge.to === refs['new:drain'])?.blocked).toBe(true);
  expect(scene.location.id).toBe(origin);
});

it('enters an existing preview with its saved identity, restores revisited contents and records a legacy new arrival', async () => {
  const f = await table();
  const original = f.snapshot().scene;
  const origin = original.location.id!;
  original.loot = [{ ...baseItem('courtyard-key', 'Courtyard key', 'tool'), quantity: 1 }];
  original.searchedLoot = { 'courtyard:desk': 'Courtyard key' };
  f.saveScene(original);
  f.provider.adjudicate = async (context) => exits(context);
  await f.turn(['', '']);
  expect(f.snapshot().turn?.phase, f.snapshot().turn?.error ?? '').toBe('collecting');
  const tower = Object.values(f.snapshot().scene.worldMap!.nodes).find((node) => node.name === 'Watchtower')!;
  f.provider.adjudicate = async (context) => arrival(context, tower.id, tower.name);
  await f.turn();
  expect(f.snapshot().turn?.phase, f.snapshot().turn?.error ?? '').toBe('collecting');
  expect(f.snapshot().scene.location.id).toBe(tower.id);
  expect(f.snapshot().scene.worldMap!.nodes[tower.id].visited).toBe(true);
  expect(f.snapshot().scene.loot).toEqual([]);
  f.provider.adjudicate = async (context) => arrival(context, origin, original.location.name);
  await f.turn();
  expect(f.snapshot().turn?.phase, f.snapshot().turn?.error ?? '').toBe('collecting');
  expect(f.snapshot().scene.loot[0].id).toBe('courtyard-key');
  expect(f.snapshot().scene.searchedLoot).toEqual({ 'courtyard:desk': 'Courtyard key' });
  expect(Object.keys(f.snapshot().scene.worldMap!.nodes)).toHaveLength(4);
  f.provider.adjudicate = async (context) => arrival(context, 'new:cellar', 'Cellar');
  await f.turn();
  expect(f.snapshot().turn?.phase, f.snapshot().turn?.error ?? '').toBe('collecting');
  const scene = f.snapshot().scene;
  expect(scene.worldMap!.connections).toContainEqual({
    from: origin,
    to: scene.location.id,
    label: expect.any(String),
    blocked: false,
    bidirectional: true,
  });
});

it('enforces one adjacent tile from each character’s origin, including blocked and one-way routes', async () => {
  const f = await table();
  f.provider.adjudicate = async (context) => exits(context);
  await f.turn(['', '']);
  const context = f.context();
  const origin = context.scene.location.id!;
  const nodes = Object.values(context.scene.worldMap!.nodes);
  const tower = nodes.find((node) => node.name === 'Watchtower')!;
  const drain = nodes.find((node) => node.name === 'Drain entrance')!;
  const prematureRoom = arrival(context, tower.id, tower.name);
  prematureRoom.memberLocations = [];
  delete prematureRoom.sceneFocus;
  expect(() => validateAdjudication(context, prematureRoom)).toThrow();
  expect(() => validateAdjudication(context, arrival(context, tower.id, tower.name))).not.toThrow();
  expect(() => validateAdjudication(context, arrival(context, drain.id, drain.name))).toThrow();
  const opened = arrival(context, drain.id, drain.name);
  opened.events.find((event) => event.id === 'world:routes')!.fact =
    'The drain gate opens, revealing an accessible passage from the courtyard.';
  opened.mapUpdates = {
    locations: [],
    connections: [
      {
        from: origin,
        to: drain.id,
        label: 'Open drain gate',
        blocked: false,
        bidirectional: true,
        eventId: 'world:routes',
      },
    ],
  };
  expect(() => validateAdjudication(context, opened)).not.toThrow();
  const split = structuredClone(context);
  split.scene.places![tower.id] = {
    location: { id: tower.id, name: tower.name, atmosphere: 'A quiet room.', hazard: '' },
    loot: [],
    encounter: null,
  };
  split.scene.memberLocations![split.members[1].id] = tower.id;
  expect(() => validateAdjudication(split, opened)).toThrow();
  const path = context.scene.worldMap!.connections.find((edge) => edge.to === tower.id)!;
  path.from = tower.id;
  path.to = origin;
  path.bidirectional = false;
  expect(() => validateAdjudication(context, arrival(context, tower.id, tower.name))).toThrow();
  context.scene.worldMap!.connections = [];
  expect(() => validateAdjudication(context, arrival(context, tower.id, tower.name))).toThrow();
  const duplicated = arrival(context, tower.id, tower.name);
  duplicated.memberLocations!.push({ ...duplicated.memberLocations![0] });
  expect(() => validateAdjudication(context, duplicated)).toThrow('one resulting location');
});

it('rejects disconnected previews, expansion beyond an unvisited location and invalid route evidence', async () => {
  const f = await table();
  const context = f.context();
  const value = exits(context);
  expect(() => validateAdjudication(context, value)).not.toThrow();
  const orphan = structuredClone(value);
  orphan.mapUpdates!.connections = orphan.mapUpdates!.connections.filter((edge) => edge.to !== 'new:market');
  expect(() => validateAdjudication(context, orphan)).toThrow();
  const remote = structuredClone(value);
  remote.mapUpdates!.connections[1].from = 'new:tower';
  expect(() => validateAdjudication(context, remote)).toThrow();
  const invalid = structuredClone(value);
  invalid.mapUpdates!.connections[0].to = 'unknown-place';
  expect(() => validateAdjudication(context, invalid)).toThrow();
  const noEvidence = structuredClone(value);
  noEvidence.mapUpdates!.connections[0].eventId = 'unknown-event';
  expect(() => validateAdjudication(context, noEvidence)).toThrow();
  const split = structuredClone(context);
  const remoteId = crypto.randomUUID();
  split.scene.places![remoteId] = {
    location: { id: remoteId, name: 'Separate chamber', atmosphere: 'Beyond ordinary hearing.', hazard: '' },
    encounter: null,
    loot: [],
  };
  split.scene.memberLocations![split.members[1].id] = remoteId;
  const remoteEvidence = exits(split);
  remoteEvidence.mapUpdates!.connections[0].eventId = remoteEvidence.actions[1].eventIds[0];
  expect(() => validateAdjudication(split, remoteEvidence)).toThrow();
});

it('rejects implicit v2 legacy travel and movement by passed or failed characters', async () => {
  const f = await table();
  const context = f.context();
  const implicit = routine(context);
  implicit.location = { name: 'Unmapped cellar', atmosphere: 'A quiet chamber.', hazard: '' };
  delete implicit.memberLocations;
  expect(() => validateAdjudication(context, implicit)).toThrow('successful movement');

  const unrelated = routine(context);
  unrelated.location = { id: null, name: 'Cellar', atmosphere: 'A quiet chamber.', hazard: '' };
  unrelated.memberLocations = [{ memberId: unrelated.actions[0].memberId, locationId: 'destination' }];
  delete unrelated.events.find((event) => event.id === unrelated.actions[0].eventIds[0])!.effect;
  expect(() => validateAdjudication(context, unrelated)).toThrow('successful submitted movement');

  const passedContext = structuredClone(context);
  passedContext.turn.actions.forEach((action) => {
    action.passed = true;
    action.text = '';
  });
  const passed = routine(passedContext);
  passed.location = { id: null, name: 'Cellar', atmosphere: 'A quiet chamber.', hazard: '' };
  passed.memberLocations = passed.actions.map((action) => ({
    memberId: action.memberId,
    locationId: 'destination',
  }));
  expect(() => validateAdjudication(passedContext, passed)).toThrow('successful submitted movement');

  const failed = routine(context);
  failed.location = { id: null, name: 'Cellar', atmosphere: 'A quiet chamber.', hazard: '' };
  failed.memberLocations = [
    {
      memberId: failed.actions[0].memberId,
      locationId: 'destination',
      movementEventId: failed.actions[0].eventIds[0],
    },
  ];
  failed.actions[0].status = 'failure';
  failed.actions[0].components.main!.status = 'failure';
  failed.events.find((event) => event.id === failed.actions[0].eventIds[0])!.result = 'failure';
  expect(() => validateAdjudication(context, failed)).toThrow('successful movement event');
});

it('rejects map proposals from the legacy provider without structured route evidence', async () => {
  const f = await table();
  delete f.provider.adjudicate;
  delete f.provider.narrate;
  f.provider.resolve = async () => ({
    narration: 'The characters wait.',
    summary: 'The courtyard remains quiet.',
    choices: [],
    changes: [],
    journal: [],
    xp: 0,
    gold: 0,
    lethalWarning: null,
    location: null,
    mapUpdates: { locations: [{ ref: 'new:remote', name: 'Remote room' }], connections: [] },
  });
  await f.turn(['', '']);
  expect(f.snapshot().turn?.error).toContain('Map discoveries require structured adjudication');
  expect(Object.keys(f.snapshot().scene.worldMap!.nodes)).toHaveLength(1);
  expect(f.snapshot().scene.worldMap!.connections).toEqual([]);
});

it('opens at the actual starting scene and maps its exits without retaining the setting placeholder', async () => {
  let placeholder = '';
  const f = await table((context) => {
    placeholder = context.scene.location.id!;
    const value = arrival(context, 'new:start', 'Forest clearing');
    value.memberLocations = context.members.map((member) => ({
      memberId: member.id,
      locationId: 'new:start',
    }));
    value.events.find((event) => event.id === 'world:routes')!.locationRef = 'new:start';
    value.mapUpdates = {
      locations: [
        { ref: 'new:tower', name: 'Watchtower' },
        { ref: 'new:market', name: 'Market street' },
      ],
      connections: ['tower', 'market'].map((ref) => ({
        from: 'new:start',
        to: `new:${ref}`,
        label: 'Open trail',
        blocked: false,
        bidirectional: true,
        eventId: 'world:routes',
      })),
    };
    return value;
  });
  const scene = f.snapshot().scene;
  expect(
    Object.values(scene.worldMap!.nodes)
      .map((node) => node.name)
      .sort(),
  ).toEqual(['Forest clearing', 'Market street', 'Watchtower']);
  expect(scene.worldMap!.nodes[scene.location.id!]).toMatchObject({ name: 'Forest clearing', visited: true });
  expect(Object.values(scene.worldMap!.nodes).filter((node) => !node.visited)).toHaveLength(2);
  expect(scene.worldMap!.nodes[placeholder]).toBeUndefined();
  expect(scene.places?.[placeholder]).toBeUndefined();
  expect(Object.values(scene.memberLocations!)).toEqual(
    f.game.members(f.campaign.id).map(() => scene.location.id),
  );
  expect(scene.worldMap!.connections).toHaveLength(2);
  expect(scene.worldMap!.connections.every((edge) => edge.from === scene.location.id)).toBe(true);
});

it('places known-preview loot only after arrival, including a mover outside shared focus', async () => {
  const f = await table();
  f.provider.adjudicate = async (context) => exits(context);
  await f.turn(['', '']);
  const origin = f.snapshot().scene.location.id!;
  const mover = f.game.members(f.campaign.id)[0];
  const stationary = f.game.members(f.campaign.id)[1];
  const tower = Object.values(f.snapshot().scene.worldMap!.nodes).find((node) => node.name === 'Watchtower')!;
  const discovery = {
    memberId: mover.id,
    locationId: tower.id,
    sourceId: 'watchtower:rack',
    reason: 'A key rests on the reached watchtower rack.',
    item: {
      name: 'Watchtower key',
      kind: 'tool' as const,
      description: 'A physical key.',
      scaling: [],
      hands: 1 as const,
      light: true,
    },
  };
  f.provider.adjudicate = async (context, tools) => {
    tools.offerLoot(discovery);
    return routine(context);
  };
  const turnId = await f.turn(['Enter the tower and examine its rack.', '']);
  expect(f.snapshot().turn?.phase).toBe('failed');
  expect(f.snapshot().turn?.error).toContain('successful movement to that destination');
  expect(f.snapshot().scene.loot).toEqual([]);
  expect(f.snapshot().scene.places?.[tower.id]).toBeUndefined();
  expect(f.snapshot().scene.worldMap!.nodes[tower.id].visited).toBe(false);
  const receipt = JSON.parse(
    (f.db.prepare('SELECT draft FROM turns WHERE id = ?').get(turnId) as { draft: string }).draft,
  ).receipts.loot;
  f.provider.adjudicate = async (context, tools) => {
    tools.offerLoot(discovery);
    const value = arrival(context, tower.id, tower.name);
    value.sceneFocus = 'current';
    return value;
  };
  f.game.retry(f.campaign.id, f.host.id);
  await f.game.idle();
  expect(f.snapshot().turn?.phase, f.snapshot().turn?.error ?? '').toBe('collecting');
  const scene = f.snapshot().scene;
  expect(scene.location.id).toBe(origin);
  expect(scene.memberLocations![stationary.id]).toBe(origin);
  expect(scene.memberLocations![mover.id]).toBe(tower.id);
  expect(scene.loot).toEqual([]);
  expect(memberScene(scene, mover.id).loot.map((item) => item.id)).toEqual([receipt.item.id]);
  expect(memberScene(scene, mover.id).searchedLoot).toEqual({ 'watchtower:rack': 'Watchtower key' });
  expect(scene.worldMap!.nodes[tower.id].visited).toBe(true);
});

it('migrates only travelled legs, deduplicates history and preserves a pending accepted resolution', async () => {
  const f = await table();
  const initial = f.snapshot().scene;
  const members = f.game.members(f.campaign.id);
  const a = initial.location.id!;
  const b = crypto.randomUUID();
  const c = crypto.randomUUID();
  const place = (id: string, name: string) => ({
    location: { ...initial.location, id, name },
    encounter: null,
    loot: [],
  });
  const before: Scene = {
    ...initial,
    ...place(a, 'Courtyard'),
    places: { [b]: place(b, 'Watchtower'), [c]: place(c, 'Market street') },
    memberLocations: { [members[0].id]: a, [members[1].id]: c },
  };
  delete before.worldMap;
  const after: Scene = {
    ...before,
    ...place(b, 'Watchtower'),
    places: { [a]: place(a, 'Courtyard'), [c]: place(c, 'Market street') },
    memberLocations: { [members[0].id]: b, [members[1].id]: c },
  };
  f.saveScene(after);
  const completed = f.snapshot().history[0].id;
  const pending = f.snapshot().turn!.id;
  const accepted = JSON.parse(
    (f.db.prepare('SELECT draft FROM turns WHERE id = ?').get(completed) as { draft: string }).draft,
  ).resolution;
  delete accepted.worldMap;
  const historyDraft = JSON.stringify({
    members,
    context: { scene: before },
    scene: after,
    resolution: accepted,
  });
  f.db.prepare('UPDATE turns SET draft = ? WHERE id = ?').run(historyDraft, completed);
  f.db
    .prepare('INSERT INTO turns(id,campaign_id,number,phase,roster,draft) VALUES(?,?,?,?,?,?)')
    .run(
      crypto.randomUUID(),
      f.campaign.id,
      2,
      'complete',
      JSON.stringify(members.map((m) => m.id)),
      JSON.stringify({ members, context: { scene: after }, scene: after }),
    );
  f.db
    .prepare('UPDATE turns SET phase = ?, draft = ? WHERE id = ?')
    .run(
      'failed',
      JSON.stringify({ members, context: { scene: before }, scene: after, resolution: accepted }),
      pending,
    );
  const readScene = () =>
    JSON.parse(
      (f.db.prepare('SELECT scene FROM campaigns WHERE id = ?').get(f.campaign.id) as { scene: string })
        .scene,
    ) as Scene;
  const readPending = () =>
    JSON.parse(
      (f.db.prepare('SELECT draft FROM turns WHERE id = ?').get(pending) as { draft: string }).draft,
    );

  migrateWorldMaps(f.db);
  const map = readScene().worldMap!;
  expect(Object.keys(map.nodes).sort()).toEqual([a, b, c].sort());
  expect(Object.values(map.nodes).every((node) => node.visited)).toBe(true);
  expect(map.connections).toEqual([
    { from: a, to: b, label: 'Passage', blocked: false, bidirectional: true },
  ]);
  expect(readPending().resolution).toEqual(accepted);
  expect(readPending().scene.worldMap).toEqual(map);
  expect(readPending().context.scene.worldMap).toEqual(map);
  expect(f.db.prepare('SELECT draft FROM turns WHERE id = ?').get(completed)).toEqual({
    draft: historyDraft,
  });
  // Pre-ID legacy drafts retained the pre-travel scene; the next frozen scene proves arrival.
  const idless = structuredClone(before);
  delete idless.location.id;
  delete idless.memberLocations;
  delete idless.places;
  const idlessDraft = JSON.stringify({ members: [members[0]], context: { scene: idless }, scene: idless });
  f.db.prepare('UPDATE turns SET draft = ? WHERE id = ?').run(idlessDraft, completed);
  const withoutConnections = readScene();
  withoutConnections.worldMap!.connections = [];
  f.saveScene(withoutConnections);
  migrateWorldMaps(f.db);
  expect(readScene().worldMap).toEqual(map);
  expect(readPending().resolution).toEqual(accepted);
  expect(f.db.prepare('SELECT draft FROM turns WHERE id = ?').get(completed)).toEqual({ draft: idlessDraft });
  migrateWorldMaps(f.db);
  expect(readScene().worldMap).toEqual(map);
  const ambiguous = readScene();
  ambiguous.places![c].location.name = 'Courtyard';
  ambiguous.worldMap!.nodes[c].name = 'Courtyard';
  ambiguous.worldMap!.connections = [];
  f.saveScene(ambiguous);
  migrateWorldMaps(f.db);
  expect(readScene().worldMap!.connections).toEqual([]);
  expect(readPending().resolution).toEqual(accepted);
});

it('accepts first-arrival scene evidence without thread progress on shared and separate branches', async () => {
  const f = await table(exits);
  const c = f.context();
  const destinations = Object.values(c.scene.worldMap!.nodes).filter(
    (node) => !node.visited && node.name !== 'Drain entrance',
  );
  const value = arrival(c, destinations[0].id, destinations[0].name);
  value.worldProgress = [];
  value.arrivals = [];
  expect(() => validateAdjudication(c, value)).toThrow('Every first arrival');
  value.events.push({
    id: 'world:arrival',
    sequence: value.events.length,
    kind: 'world',
    actionId: null,
    memberId: null,
    phase: 'aftermath',
    result: null,
    locationRef: destinations[0].id,
    receiptRefs: [],
    dependsOn: [],
    fact: 'The tower shelters a dry stairwell and a brass signal bell; the open path returns to the courtyard.',
  });
  value.arrivals.push({ locationId: destinations[0].id, eventId: 'world:arrival' });
  expect(() => validateAdjudication(c, value)).not.toThrow();
  value.arrivals.push(value.arrivals[0]);
  expect(() => validateAdjudication(c, value)).toThrow('each shared arrival once');
  value.arrivals.pop();
  value.memberLocations![1].locationId = destinations[1].id;
  value.placeUpdates!.push({
    ref: destinations[1].id,
    location: { name: destinations[1].name, atmosphere: 'Open stalls around a fountain.', hazard: '' },
  });
  expect(() => validateAdjudication(c, value)).toThrow('Every first arrival');
  value.events.push({
    ...value.events.at(-1)!,
    id: 'world:market-arrival',
    sequence: value.events.length,
    locationRef: destinations[1].id,
    fact: 'Open stalls surround a fountain; traders shelter under awnings beside the courtyard path.',
  });
  value.arrivals.push({ locationId: destinations[1].id, eventId: 'world:market-arrival' });
  expect(() => validateAdjudication(c, value)).not.toThrow();
});

it('freezes first-arrival evidence, visible exits and search history through a return visit', async () => {
  const f = await table(exits);
  const original = f.snapshot().scene;
  original.searches = { desk: { information: 'A dry compartment beneath the desk.', rewardRolled: true } };
  f.saveScene(original);
  const tower = Object.values(original.worldMap!.nodes).find((node) => node.name === 'Watchtower')!;
  f.provider.adjudicate = async (c) => {
    const value = arrival(c, tower.id, tower.name);
    value.events.push({
      id: 'world:arrival',
      sequence: value.events.length,
      kind: 'world',
      actionId: null,
      memberId: null,
      phase: 'aftermath',
      result: null,
      locationRef: tower.id,
      receiptRefs: [],
      dependsOn: [],
      fact: 'A signal bell hangs over the dry stairs. An open path returns to the courtyard; a ladder leads to the exposed roof.',
    });
    value.arrivals = [{ locationId: tower.id, eventId: 'world:arrival' }];
    value.mapUpdates = {
      locations: [{ ref: 'new:roof', name: 'Tower roof' }],
      connections: [
        {
          from: tower.id,
          to: 'new:roof',
          label: 'Exposed ladder',
          blocked: false,
          bidirectional: true,
          eventId: 'world:arrival',
        },
      ],
    };
    return value;
  };
  const turnId = await f.turn();
  const completed = f.snapshot().history.at(-1)!;
  expect(completed.id, f.snapshot().turn?.error ?? '').toBe(turnId);
  expect(completed.resolution).toMatchObject({
    arrivals: [{ locationId: tower.id, eventId: 'world:arrival' }],
  });
  expect(completed.result!.narration).toContain('signal bell');
  expect(f.snapshot().scene.worldMap!.connections).toContainEqual(
    expect.objectContaining({ from: tower.id, label: 'Exposed ladder' }),
  );
  expect(f.snapshot().scene.searches).toBeUndefined();
  f.provider.adjudicate = async (c) => arrival(c, original.location.id!, original.location.name);
  await f.turn();
  expect(f.snapshot().scene.searches).toEqual(original.searches);
});

it('moves one hop toward a mapped goal and accepts actual route closures instead of adjacency denials', async () => {
  const f = await table(exits);
  const c = f.context();
  const origin = c.scene.location.id!;
  const tower = Object.values(c.scene.worldMap!.nodes).find((node) => node.name === 'Watchtower')!;
  const goal = crypto.randomUUID();
  c.scene.worldMap!.nodes[goal] = { id: goal, name: 'Rotsrichel', visited: false };
  c.scene.worldMap!.connections.push({
    from: tower.id,
    to: goal,
    label: 'Ridge path',
    blocked: false,
    bidirectional: true,
  });
  const value = arrival(c, tower.id, tower.name);
  for (const action of value.actions) action.travel = { goalId: goal };
  expect(() => validateAdjudication(c, value)).not.toThrow();
  const denied = routine(c);
  for (const action of denied.actions) action.travel = { goalId: goal };
  expect(() => validateAdjudication(c, denied)).toThrow('not adjacent');
  denied.events.push({
    id: 'world:landslide',
    sequence: denied.events.length,
    kind: 'world',
    actionId: null,
    memberId: null,
    phase: 'aftermath',
    result: null,
    locationRef: origin,
    fact: 'A fresh landslide closes the tower path.',
    receiptRefs: [],
    dependsOn: [],
  });
  denied.mapUpdates = {
    locations: [],
    connections: [
      {
        from: origin,
        to: tower.id,
        label: 'Landslide',
        blocked: true,
        bidirectional: true,
        eventId: 'world:landslide',
      },
    ],
  };
  expect(() => validateAdjudication(c, denied)).not.toThrow();
  value.memberLocations!.forEach((position) => {
    position.locationId = goal;
  });
  value.placeUpdates = [
    { ref: goal, location: { name: 'Rotsrichel', atmosphere: 'Windy rocks.', hazard: '' } },
  ];
  value.sceneFocus = goal;
  expect(() => validateAdjudication(c, value)).toThrow('adjacent');
});

it('regresses Kraterwereld turns 7, 9 and 10 locally without changing their completed history', async () => {
  const f = await table();
  const base = f.context();
  const context = (number: keyof typeof savedKraterwereld): GMContext => {
    const saved = savedKraterwereld[number];
    return {
      ...base,
      scene: structuredClone(saved.scene) as Scene,
      turn: { ...base.turn, ...structuredClone(saved.turn) } as GMContext['turn'],
      members: saved.members.map((member) => ({
        ...base.members[0],
        id: member.id,
        character: templateCharacter(member.name),
      })),
    };
  };
  const untouched = JSON.stringify(savedKraterwereld);
  const c7 = context('7');
  const ridge = Object.values(c7.scene.worldMap!.nodes).find((node) => node.name === 'Rotsrichel')!;
  const next = travelNextHop(c7.scene, c7.scene.location.id!, ridge.id)!;
  expect(next).toBe(savedKraterwereld['9'].scene.location.id);
  const options = adjudicationInput(c7).travelNextHops;
  for (const actor of c7.turn.actions) expect(options[actor.memberId][ridge.id]).toBe(next);
  const denied = turnAdjudicationSchema.parse(savedKraterwereld['7'].adjudication);
  for (const action of denied.actions) action.travel = { goalId: ridge.id };
  expect(() => validateExploration(c7, denied, (ref) => ref)).toThrow('not adjacent');
  const progress = arrival(c7, next, savedKraterwereld['9'].scene.location.name);
  for (const action of progress.actions) action.travel = { goalId: ridge.id };
  expect(() => validateAdjudication(c7, progress)).not.toThrow();

  const c9 = context('9');
  const thin = turnAdjudicationSchema.parse(savedKraterwereld['9'].adjudication);
  thin.arrivals = [];
  expect(() => validateExploration(c9, thin, (ref) => ref)).toThrow('Every first arrival');
  // These are illustrative new facts in an isolated regression, never a rewrite of the saved game.
  for (const place of thin.placeUpdates!) {
    const eventId = `arrival:${place.ref}`;
    thin.events.push({
      id: eventId,
      sequence: thin.events.length,
      kind: 'world',
      actionId: null,
      memberId: null,
      locationRef: place.ref,
      phase: 'aftermath',
      result: null,
      fact: `${place.location.name} biedt beschutting langs het zichtbare terugpad naar Bunker 67.`,
      receiptRefs: [],
      dependsOn: [],
    });
    thin.arrivals.push({ locationId: place.ref, eventId });
  }
  expect(thin.arrivals).toHaveLength(2); // The two jungle travellers share one arrival.
  expect(() => validateExploration(c9, thin, (ref) => ref)).not.toThrow();

  const c10 = context('10');
  const failed = turnAdjudicationSchema.parse(savedKraterwereld['10'].adjudication);
  const searcher = failed.actions.find((action) => action.components.main?.status === 'failure')!;
  searcher.intent = 'search';
  expect(() => validateExploration(c10, failed, (ref) => ref)).toThrow('useful information');
  const place = memberScene(c10.scene, searcher.memberId).location.id!;
  const roll = c10.turn.rolls.find((roll) => roll.memberId === searcher.memberId && !roll.notation)!;
  const eventId = 'search:lesser-information';
  failed.events.push({
    id: eventId,
    sequence: failed.events.length,
    kind: 'world',
    actionId: null,
    memberId: null,
    locationRef: place,
    phase: 'aftermath',
    result: null,
    fact: 'Een ondiepe moddergeul loopt omlaag, zonder herkenbaar meteorietspoor.',
    receiptRefs: [],
    dependsOn: [{ eventId: `check:${roll.id}`, requires: 'occurrence' }],
  });
  searcher.search = {
    sourceId: 'washed-out-tracks',
    locationId: place,
    informationEventId: eventId,
    reward: null,
  };
  expect(() => validateExploration(c10, failed, (ref) => ref)).not.toThrow();
  expect(searcher.components.main!.status).toBe('failure');
  expect(JSON.stringify(savedKraterwereld)).toBe(untouched);
});

it('allows a local control action to change a known remote route without discovering new remote routes', async () => {
  const f = await table();
  const c = f.context();
  c.members[1].active = false;
  c.turn.actions = c.turn.actions.slice(0, 1);
  c.turn.roster = c.turn.roster.slice(0, 1);
  const deck = crypto.randomUUID(),
    dock = crypto.randomUUID();
  for (const [id, name] of [
    [deck, 'Ship deck'],
    [dock, 'Dock'],
  ]) {
    c.scene.places![id] = {
      location: { id, name, atmosphere: 'A known place.', hazard: '' },
      encounter: null,
      loot: [],
    };
    c.scene.worldMap!.nodes[id] = { id, name, visited: true };
  }
  c.scene.memberLocations![c.members[1].id] = deck;
  const gangway = { from: deck, to: dock, label: 'Gangway', blocked: false, bidirectional: true };
  c.scene.worldMap!.connections.push(gangway);
  const value = routine(c);
  const action = value.actions[0],
    source = value.events[0],
    evidence = value.events.at(-1)!;
  delete source.effect;
  source.locationRef = c.scene.location.id;
  action.fact =
    action.components.main!.fact =
    source.fact =
      'The pilot releases the ship from the wheelhouse controls.';
  evidence.locationRef = deck;
  evidence.fact = 'The gangway separates from the dock as the ship departs.';
  evidence.dependsOn = [{ eventId: source.id, requires: 'success' }];
  value.mapUpdates = { locations: [], connections: [{ ...gangway, blocked: true, eventId: evidence.id }] };
  expect(() => validateAdjudication(c, value)).not.toThrow();
  expect(value.memberLocations).toEqual([]);
  expect(c.scene.memberLocations![c.members[1].id]).toBe(deck);
  evidence.dependsOn = [];
  expect(() => validateAdjudication(c, value)).toThrow('Discover routes');
  evidence.dependsOn = [{ eventId: source.id, requires: 'success' }];
  c.scene.worldMap!.connections = c.scene.worldMap!.connections.filter((edge) => edge !== gangway);
  expect(() => validateAdjudication(c, value)).toThrow('Discover routes');
});

it('respects an evidenced travel-method obstacle without turning an open path into a global blocker', async () => {
  const f = await table(exits);
  const c = f.context();
  const tower = Object.values(c.scene.worldMap!.nodes).find((node) => node.name === 'Watchtower')!;
  const value = routine(c);
  value.events.push({
    id: 'world:mount-refusal',
    sequence: value.events.length,
    kind: 'world',
    actionId: null,
    memberId: null,
    phase: 'aftermath',
    result: null,
    locationRef: c.scene.location.id!,
    fact: 'The moth refuses to carry the traveller while its harness is unsafe; the footpath remains open.',
    receiptRefs: [],
    dependsOn: [],
  });
  for (const action of value.actions) {
    action.travel = { goalId: tower.id, obstacleEventId: 'world:mount-refusal' };
    action.status = 'blocked';
    action.fact = 'The requested flight is blocked by the unsafe harness.';
    action.components.main = { ...action.components.main!, status: 'blocked', fact: action.fact };
    const event = value.events.find((event) => event.actionId === action.actionId)!;
    event.result = 'blocked';
    event.fact = action.fact;
    delete event.effect;
  }
  expect(() => validateAdjudication(c, value)).not.toThrow();
  value.actions[0].travel!.obstacleEventId = 'missing';
  expect(() => validateAdjudication(c, value)).toThrow('public local world evidence');
});

it('permits a feasible adjacent exploration leg toward a known goal without a mapped complete route', async () => {
  const f = await table(exits);
  const c = f.context();
  const goal = crypto.randomUUID();
  c.scene.worldMap!.nodes[goal] = { id: goal, name: 'Distant meteorite', visited: false };
  const tower = Object.values(c.scene.worldMap!.nodes).find((node) => node.name === 'Watchtower')!;
  const value = arrival(c, tower.id, tower.name);
  for (const action of value.actions) action.travel = { goalId: goal };
  expect(() => validateAdjudication(c, value)).not.toThrow();
  value.actions[0].travel!.avoid = [tower.id];
  expect(() => validateAdjudication(c, value)).toThrow('route restrictions');
});

it('resolves supplied aliases and unambiguous names and repairs an existing movement reference without another model call', async () => {
  const f = await table(exits);
  const c = f.context();
  const tower = Object.values(c.scene.worldMap!.nodes).find((node) => node.name === 'Watchtower')!;
  const alias = Object.entries(locationReferences(c)).find(([, place]) => place.id === tower.id)![0];
  const raw = arrival(c, tower.id, tower.name);
  raw.sceneFocus = alias;
  raw.placeUpdates![0].ref = tower.name;
  for (const position of raw.memberLocations!) {
    position.locationId = alias;
    position.movementEventId = 'misspelled-movement';
  }
  const untouched = JSON.stringify(raw);
  const normalized = turnAdjudicationSchema.parse(normalizeAdjudicationReferences(c, raw));
  expect(normalized.sceneFocus).toBe(tower.id);
  expect(normalized.memberLocations!.map((position) => position.movementEventId)).toEqual(
    normalized.actions.map((action) => action.eventIds[0]),
  );
  expect(() => validateAdjudication(c, normalized)).not.toThrow();
  expect(JSON.stringify(raw)).toBe(untouched);
});

it('reports unknown location references together and refuses ambiguous place names', async () => {
  const f = await table(exits);
  const c = f.context();
  const value = routine(c);
  value.sceneFocus = 'invented-focus';
  value.memberLocations = [{ memberId: c.members[0].id, locationId: 'invented-position' }];
  let feedback = '';
  try {
    normalizeAdjudicationReferences(c, value);
  } catch (error) {
    feedback = (error as Error).message;
  }
  expect(feedback).toContain('sceneFocus="invented-focus"');
  expect(feedback).toContain('memberLocations[0].locationId="invented-position"');
  expect(feedback).toContain('place:1');
  const twin = crypto.randomUUID();
  c.scene.worldMap!.nodes[twin] = { id: twin, name: 'Watchtower', visited: false };
  value.sceneFocus = 'Watchtower';
  value.memberLocations = [];
  expect(() => normalizeAdjudicationReferences(c, value)).toThrow('Unknown location references');
});

it('repairs a mistyped location ID only when its declared name identifies one existing place', async () => {
  const f = await table(exits);
  const c = f.context();
  const tower = Object.values(c.scene.worldMap!.nodes).find((node) => node.name === 'Watchtower')!;
  const value = arrival(c, tower.id, tower.name);
  const typo = '0a2b90dc-ec4c-4277-87e5-0a17671cb5bd';
  value.placeUpdates![0].ref = typo;
  value.sceneFocus = typo;
  value.memberLocations!.forEach((position) => {
    position.locationId = typo;
  });
  value.events.forEach((event) => {
    if (event.locationRef === tower.id) event.locationRef = typo;
  });
  value.arrivals?.forEach((arrival) => {
    arrival.locationId = typo;
  });
  const before = structuredClone(value);
  const normalized = normalizeAdjudicationReferences(c, value) as TurnAdjudication;
  expect(normalized.sceneFocus).toBe(tower.id);
  expect(() => validateAdjudication(c, normalized)).not.toThrow();
  expect(value).toEqual(before);
  c.scene.worldMap!.nodes['another-tower'] = { id: 'another-tower', name: tower.name, visited: false };
  expect(() => normalizeAdjudicationReferences(c, value)).toThrow('Unknown location references');
});

it('sends short location references to the GM and resolves them in gameplay tool calls', async () => {
  const f = await table(exits);
  const c = f.context();
  const tower = Object.values(c.scene.worldMap!.nodes).find((node) => node.name === 'Watchtower')!;
  const alias = Object.entries(locationReferences(c)).find(([, place]) => place.id === tower.id)![0];
  let requests = 0;
  const fetcher = vi.fn(async (_url, init) => {
    const input = JSON.parse(JSON.parse(init!.body as string).input[0].content);
    expect(input.scene.worldMap.nodes[alias].id).toBe(alias);
    expect(input.locationRefs[alias]).toEqual({ id: alias, name: tower.name });
    const output =
      ++requests === 1
        ? [
            {
              type: 'function_call',
              name: 'start_combat',
              call_id: 'start',
              arguments: JSON.stringify({ locationId: alias, enemies: [] }),
            },
          ]
        : [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(routine(c)) }] }];
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { output } })}\n\n`);
  }) as unknown as typeof fetch;
  const startCombat = vi.fn(() => ({}));
  const tools = Object.assign(vi.fn(), {
    startCombat,
    validateAdjudication: (input: unknown) => validateAdjudication(c, input),
  }) as unknown as GameTools;
  await new ChatGPTGM(
    { accessToken: async () => 'test' } as unknown as ChatGPTAuth,
    'owner',
    'test',
    fetcher,
  ).adjudicate(c, tools);
  expect(startCombat).toHaveBeenCalledExactlyOnceWith([], tower.id);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('never invents a movement effect or converts an unrelated successful action into travel during reference repair', async () => {
  const f = await table(exits);
  const c = f.context();
  const tower = Object.values(c.scene.worldMap!.nodes).find((node) => node.name === 'Watchtower')!;
  const value = arrival(c, tower.id, tower.name);
  const action = value.actions[0];
  const event = value.events.find((event) => event.id === action.eventIds[0])!;
  delete event.effect;
  event.fact = 'The character identifies a footprint.';
  const normalized = turnAdjudicationSchema.parse(normalizeAdjudicationReferences(c, value));
  expect(normalized.events.find((item) => item.id === event.id)!.effect).toBeUndefined();
  expect(() => validateAdjudication(c, normalized)).toThrow('explicit movement effect');
});

it('migrates map positions without rewriting checkpoints and preserves them when a legacy resolution publishes', async () => {
  const f = await table(exits);
  const narrate = f.provider.narrate!;
  const adjudicate = vi.fn(async (context: GMContext) => routine(context));
  f.provider.adjudicate = adjudicate;
  f.provider.narrate = async () => {
    interruptNarration(f.db, 'Interrupted narration');
  };
  const turnId = await f.turn(['', '']);
  expect(f.snapshot().turn?.phase).toBe('failed');
  const readDraft = () =>
    (f.db.prepare('SELECT draft FROM turns WHERE id = ?').get(turnId) as { draft: string }).draft;
  const draft = JSON.parse(readDraft());
  delete draft.scene.worldMap.positions;
  delete draft.context.scene.worldMap.positions;
  delete draft.resolution.worldMap.positions;
  f.db.prepare('UPDATE turns SET draft = ? WHERE id = ?').run(JSON.stringify(draft), turnId);
  const checkpoint = readDraft();
  const history = f.db
    .prepare("SELECT id, draft, result FROM turns WHERE campaign_id = ? AND phase = 'complete'")
    .all(f.campaign.id);
  const oldScene = f.snapshot().scene;
  delete oldScene.worldMap!.positions;
  f.saveScene(oldScene);
  migrateWorldMapPositions(f.db);
  const positions = f.snapshot().scene.worldMap!.positions!;
  expect(Object.keys(positions).sort()).toEqual(Object.keys(oldScene.worldMap!.nodes).sort());
  expect(readDraft()).toBe(checkpoint);
  const migratedScene = f.snapshot().scene;
  // A checkpoint without metadata must preserve coordinates already shown to viewers.
  migratedScene.worldMap!.positions = Object.fromEntries(
    Object.entries(positions).map(([id, point]) => [id, { x: point.x + 1234, y: point.y - 300 }]),
  );
  f.saveScene(migratedScene);
  const version = f.snapshot().version;
  migrateWorldMapPositions(f.db);
  expect(f.snapshot().version).toBe(version);
  f.provider.narrate = narrate;
  const restarted = new Game(f.db, () => f.provider);
  restarted.retry(f.campaign.id, f.host.id);
  await restarted.idle();
  expect(f.snapshot().history.at(-1)?.id, f.snapshot().turn?.error ?? '').toBe(turnId);
  expect(f.snapshot().scene.worldMap!.positions).toEqual(migratedScene.worldMap!.positions);
  expect(adjudicate).toHaveBeenCalledTimes(1);
  expect(JSON.parse(readDraft()).resolution).toEqual(draft.resolution);
  for (const entry of history as { id: string; draft: string; result: string }[])
    expect(f.db.prepare('SELECT id, draft, result FROM turns WHERE id = ?').get(entry.id)).toEqual(entry);
});

it('saves an evidenced shortcut closing a cycle without moving characters or places', async () => {
  const f = await table();
  const scene = f.snapshot().scene;
  const a = scene.location.id!,
    b = crypto.randomUUID(),
    c = crypto.randomUUID();
  for (const [id, name] of [
    [b, 'Woods'],
    [c, 'Mill'],
  ]) {
    scene.places![id] = {
      location: { id, name, atmosphere: 'A known place.', hazard: '' },
      encounter: null,
      loot: [],
    };
    scene.worldMap!.nodes[id] = { id, name, visited: true };
  }
  scene.worldMap!.connections = [
    [a, b],
    [b, c],
  ].map(([from, to]) => ({ from, to, label: 'Trail', blocked: false, bidirectional: true }));
  for (const member of f.snapshot().members) scene.memberLocations![member.id] = c;
  ensureWorldMapPositions(scene);
  f.saveScene(scene);
  expect(travelNextHop(scene, c, a)).toBe(b);
  expect(adjudicationInput(f.context()).scene.worldMap).not.toHaveProperty('positions');
  f.provider.adjudicate = async (context) => {
    const value = routine(context);
    const evidence = value.events.find((event) => event.id === 'world:routes')!;
    evidence.locationRef = c;
    evidence.fact = 'A visible service trail at the mill returns to the known courtyard.';
    value.mapUpdates = {
      locations: [],
      connections: [
        { from: c, to: a, label: 'Service trail', blocked: false, bidirectional: true, eventId: evidence.id },
      ],
    };
    const unsupported = structuredClone(value);
    unsupported.mapUpdates!.connections[0].eventId = 'missing';
    expect(() => validateAdjudication(context, unsupported)).toThrow('public world or action event');
    return value;
  };
  const turn = await f.turn(['', '']);
  const after = f.snapshot().scene;
  expect(f.snapshot().history.at(-1)?.id, f.snapshot().turn?.error ?? '').toBe(turn);
  expect(after.worldMap!.positions).toEqual(scene.worldMap!.positions);
  expect(after.memberLocations).toEqual(scene.memberLocations);
  expect(after.worldMap!.connections).toHaveLength(3);
  expect(travelNextHop(after, c, a)).toBe(a);
  const shortcut = after.worldMap!.connections.find((route) => route.label === 'Service trail')!;
  shortcut.bidirectional = false;
  expect(travelNextHop(after, a, c)).toBe(b);
  shortcut.blocked = true;
  expect(travelNextHop(after, c, a)).toBe(b);
});
