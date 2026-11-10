import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { initialScene, initialState, baseItem } from '../shared/rules';
import { templateCharacter, type Scene } from '../shared/schema';
import { ensureLocations } from '../shared/locations';
import {
  containingStructure,
  locationConnections,
  locationPath,
  mapLocation,
  structureMap,
} from '../shared/structures';
import { gatheringRoute } from '../shared/gathering';
import { compileSceneTurn, type SceneTurn } from '../server/scene-turn';
import { applyStructures } from '../server/structures';
import { travelNextHop } from '../server/world-map';
import { Game, type GMContext, type GameMaster } from '../server/game';
import { ChatGPTGM, PracticeGM } from '../server/providers';
import type { ChatGPTAuth } from '../server/auth';
import { openDatabase } from '../server/db';
import { assertEncounterProposal, prepareEncounterChecks, type EncounterChecks } from '../server/encounters';
import { applyAdjudicationRepair, retainAdjudicationProgress } from '../server/adjudication-recovery';
import { validateAdjudication } from '../server/turn-resolution';

function fixture() {
  const members = ['Pilot', 'Engineer', 'Visitor'].map((name) => {
    const id = randomUUID(),
      character = templateCharacter(name);
    return {
      id,
      playerId: randomUUID(),
      playerName: name,
      characterId: randomUUID(),
      character,
      state: initialState(character, id),
      active: true,
    };
  });
  const scene = ensureLocations(
    initialScene('Bridge'),
    members.map((member) => member.id),
  );
  scene.currencyName = 'credits';
  const ids = {
    bridge: scene.location.id!,
    deck: randomUUID(),
    engine: randomUUID(),
    oldPort: randomUUID(),
    newPort: randomUUID(),
  };
  scene.encounterRisk = { danger: 'safe', reason: 'A sheltered bridge.' };
  for (const [key, name] of [
    ['deck', 'Deck'],
    ['engine', 'Engine room'],
    ['oldPort', 'Old harbour'],
    ['newPort', 'New harbour'],
  ] as const) {
    scene.places![ids[key]] = {
      location: { id: ids[key], name, atmosphere: 'A known sheltered place.', hazard: '' },
      encounter: null,
      loot: [],
      encounterRisk: { danger: 'safe', reason: 'A sheltered place.' },
    };
    scene.worldMap!.nodes[ids[key]] = { id: ids[key], name, visited: true };
  }
  const connect = (from: string, to: string, label: string) =>
    scene.worldMap!.connections.push({ from, to, label, blocked: false, bidirectional: true });
  connect(ids.bridge, ids.deck, 'Stairs');
  connect(ids.deck, ids.engine, 'Engine hatch');
  connect(ids.oldPort, ids.newPort, 'Shipping lane');
  scene.worldMap!.connections.find((edge) => edge.from === ids.oldPort)!.transportOnly = true;
  // A legacy sailing-as-walking edge must become unusable after containment is established.
  connect(ids.bridge, ids.oldPort, 'Old sailing edge');
  scene.structures = {
    'new:zeewolf': {
      id: 'new:zeewolf',
      name: 'Zeewolf',
      locationId: ids.oldPort,
      entranceId: ids.deck,
      controlId: ids.bridge,
      roomIds: [ids.bridge, ids.deck, ids.engine],
      mobile: true,
      access: true,
    },
  };
  scene.memberLocations = {
    [members[0].id]: ids.bridge,
    [members[1].id]: ids.engine,
    [members[2].id]: ids.oldPort,
  };
  scene.places![ids.engine].loot.push({ ...baseItem(randomUUID(), 'Spanner', 'tool'), quantity: 1 });
  scene.npcs = {
    mechanic: {
      id: 'mechanic',
      name: 'Mechanic',
      aliases: [],
      locationId: ids.engine,
      status: 'alive',
      allegiance: null,
      fact: 'The mechanic works in the engine room.',
    },
  };
  const context: GMContext = {
    sceneProtocol: true,
    gmMemory: [],
    config: {
      ruleset: 'roguelike-v1',
      name: 'Structures',
      setting: 'At sea',
      premise: '',
      tone: '',
      instructions: '',
      language: 'English',
      custom: [],
      provider: 'practice',
      model: '',
    },
    members,
    startingMembers: structuredClone(members),
    scene,
    journal: [],
    history: [],
    receipts: {},
    turn: {
      id: randomUUID(),
      number: 1,
      phase: 'resolving',
      roster: members.map((member) => member.id),
      actions: members.map((member, index) => ({
        memberId: member.id,
        text:
          index === 0 ? 'Sail Zeewolf to New harbour and dock.' : index === 1 ? 'Clean the engine room.' : '',
        passed: index === 2,
      })),
      rolls: [],
      result: null,
      error: null,
    },
  };
  return { context, ids, ship: scene.structures['new:zeewolf'] };
}

function voyage(context: GMContext, to: string): SceneTurn {
  const name = context.scene.worldMap?.nodes[to]?.name ?? 'a new harbour';
  return {
    version: 3,
    notes: [],
    summary: `Zeewolf docks at ${name}.`,
    beats: [
      {
        kind: 'transport',
        actor: context.members[0].id,
        structureId: 'new:zeewolf',
        to,
        access: true,
        fact: `The pilot sails Zeewolf to ${name} and docks.`,
        text: 'From the bridge, the pilot guides Zeewolf into its new berth.',
      },
      {
        kind: 'act',
        actor: context.members[1].id,
        slot: 'main',
        intent: 'action',
        fact: 'The engineer cleans the engine room during the crossing.',
        text: 'The engineer wipes oil from the engine-room floor as the ship travels.',
      },
    ],
  };
}

it('moves the structure while preserving passenger rooms, onboard state and people ashore', () => {
  const { context, ids } = fixture();
  const before = structuredClone(context.scene);
  const value = compileSceneTurn(context, voyage(context, ids.newPort));
  expect(value.memberLocations).toEqual([]);
  expect(value.structureMoves).toHaveLength(1);
  applyStructures(context.scene, value, (id) => id);
  expect(context.scene.structures!['new:zeewolf'].locationId).toBe(ids.newPort);
  expect(context.scene.memberLocations).toEqual(before.memberLocations);
  expect(context.scene.places).toEqual(before.places);
  expect(context.scene.npcs).toEqual(before.npcs);
  expect(locationPath(context.scene, ids.engine)).toBe('New harbour › Zeewolf › Engine room');
  expect(travelNextHop(context.scene, ids.oldPort, ids.deck)).toBeNull();
  expect(gatheringRoute(context.scene, ids.oldPort, ids.deck)).toBeNull();
  expect(gatheringRoute(context.scene, ids.newPort, ids.engine)).toEqual([ids.newPort, ids.deck, ids.engine]);
  expect(locationConnections(context.scene)).not.toContainEqual(
    expect.objectContaining({ from: ids.bridge, to: ids.oldPort }),
  );
});

it.each(['blocked', 'one-way', 'remote operator', 'static structure', 'own room', 'second hop'])(
  'rejects invalid transport: %s',
  (failure) => {
    const { context, ids, ship } = fixture();
    const response = voyage(context, ids.newPort);
    const edge = context.scene.worldMap!.connections.find((edge) => edge.from === ids.oldPort)!;
    if (failure === 'blocked') edge.blocked = true;
    if (failure === 'one-way') {
      edge.from = ids.newPort;
      edge.to = ids.oldPort;
      edge.bidirectional = false;
    }
    if (failure === 'remote operator') context.scene.memberLocations![context.members[0].id] = ids.oldPort;
    if (failure === 'static structure') ship.mobile = false;
    if (failure === 'own room') (response.beats[0] as { to: string }).to = ids.engine;
    if (failure === 'second hop') response.beats.push({ ...response.beats[0] });
    expect(() => compileSceneTurn(context, response)).toThrow();
  },
);

it('uses boarding and disembarking order at departure without moving anyone left ashore', () => {
  const { context, ids } = fixture();
  const visitor = context.members[2];
  context.turn.actions[2] = { memberId: visitor.id, text: 'Board the ship.', passed: false };
  const response = voyage(context, ids.newPort);
  const board = {
    kind: 'move' as const,
    actor: visitor.id,
    to: ids.deck,
    fact: 'The visitor boards Zeewolf at Old harbour.',
    text: 'The visitor crosses the gangway onto the deck.',
  };
  response.beats.unshift(board);
  const accepted = compileSceneTurn(context, response);
  expect(accepted.memberLocations).toEqual([
    expect.objectContaining({ memberId: visitor.id, locationId: ids.deck }),
  ]);
  response.beats.shift();
  response.beats.push(board);
  expect(() => compileSceneTurn(context, response)).toThrow(/adjacent|entrance/);
  context.scene.memberLocations![visitor.id] = ids.deck;
  context.turn.actions[2].text = 'Disembark before departure.';
  response.beats.pop();
  response.beats.unshift({ ...board, to: ids.oldPort, fact: 'The visitor disembarks before departure.' });
  expect(compileSceneTurn(context, response).memberLocations).toEqual([
    expect.objectContaining({ memberId: visitor.id, locationId: ids.oldPort }),
  ]);
});

it('keeps a failed piloting check failed and leaves the structure and boarding access unchanged', () => {
  const { context, ids } = fixture();
  context.turn.rolls.push({
    id: randomUUID(),
    memberId: context.members[0].id,
    stat: 'DEX',
    dc: 15,
    mode: 'normal',
    dice: [2],
    modifier: 0,
    total: 2,
    success: false,
    reason: 'Crosswind at the harbour entrance.',
    lethal: false,
    source: 'test',
  });
  const before = structuredClone(context.scene.structures);
  const response = voyage(context, ids.newPort);
  Object.assign(response.beats[0], {
    fact: 'The pilot cannot leave the harbour in the crosswind.',
    text: 'Crosswind keeps Zeewolf at its original berth.',
  });
  const value = compileSceneTurn(context, response);
  expect(value.actions[0].components.main).toMatchObject({ status: 'failure', basis: 'check' });
  expect(value.structureMoves).toEqual([]);
  applyStructures(context.scene, value, (id) => id);
  expect(context.scene.structures).toEqual(before);
});

it('projects world and interior maps, and derives the location of a nested vehicle from its carrier', () => {
  const { context, ids, ship } = fixture();
  const scene = context.scene;
  const world = structureMap(scene, null),
    inside = structureMap(scene, ship.id);
  expect(world.nodes[ship.id].name).toBe('Zeewolf');
  expect(world.nodes[ids.engine]).toBeUndefined();
  expect(inside.nodes[ids.engine].name).toBe('Engine room');
  expect(inside.nodes[ids.newPort]).toBeUndefined();
  expect(mapLocation(scene, ids.engine, null)).toBe(ship.id);
  const seat = randomUUID();
  scene.worldMap!.nodes[seat] = { id: seat, name: 'Lifeboat seat', visited: true };
  scene.structures!['new:lifeboat'] = {
    id: 'new:lifeboat',
    name: 'Lifeboat',
    locationId: ids.deck,
    entranceId: seat,
    controlId: seat,
    roomIds: [seat],
    mobile: true,
    access: true,
  };
  ship.locationId = ids.newPort;
  expect(locationPath(scene, seat)).toBe('New harbour › Zeewolf › Deck › Lifeboat › Lifeboat seat');
  expect(mapLocation(scene, seat, ship.id)).toBe('new:lifeboat');
  expect(containingStructure(scene, ids.engine)?.id).toBe(ship.id);
});

it('permits a submitted order carried out by a saved living crew member at the controls', () => {
  const { context, ids } = fixture();
  context.turn.actions[0] = { ...context.turn.actions[0], text: '', passed: true };
  context.turn.actions[1].text = 'Sail Zeewolf to New harbour.';
  context.scene.npcs!.mechanic.locationId = ids.bridge;
  const response = voyage(context, ids.newPort);
  response.beats = [
    {
      ...response.beats[0],
      actor: context.members[1].id,
      operatorId: 'mechanic',
      fact: 'The engineer calls the mechanic on the bridge, who steers Zeewolf to New harbour and docks.',
    } as SceneTurn['beats'][number],
  ];
  expect(compileSceneTurn(context, response).structureMoves![0].operatorId).toBe('mechanic');
  context.scene.npcs!.mechanic.status = 'dead';
  expect(() => compileSceneTurn(context, response)).toThrow(/control room/);
});

it('uses exterior danger for navigation checks and freezes the accepted structure movement', () => {
  const { context, ids } = fixture();
  context.scene.places![ids.newPort].encounterRisk = {
    danger: 'dangerous',
    reason: 'Armed raiders patrol the entrance.',
  };
  const value = compileSceneTurn(context, voyage(context, ids.newPort));
  const checks: EncounterChecks = {};
  const draw = vi.fn(() => 1);
  prepareEncounterChecks(context, value, checks, draw);
  expect(draw).toHaveBeenCalledTimes(1);
  expect(checks[ids.bridge]).toMatchObject({ danger: 'dangerous', triggered: true });
  const changed = structuredClone(value);
  changed.structureMoves![0].to = ids.oldPort;
  expect(() => assertEncounterProposal(context, changed, value)).toThrow('preserves structureMoves');
  const retained = retainAdjudicationProgress(context, value, value, (candidate) =>
    validateAdjudication(context, candidate),
  );
  expect(() =>
    applyAdjudicationRepair(retained, { structureMoves: changed.structureMoves }, context),
  ).toThrow('retained world evidence');
});

it('establishes nested places and their separate world location in one scene response', () => {
  const { context, ids, ship } = fixture();
  delete context.scene.structures;
  context.turn.actions = context.turn.actions.map((action) => ({ ...action, text: '', passed: true }));
  const value = compileSceneTurn(context, {
    version: 3,
    notes: [],
    summary: 'Zeewolf lies at the anchorage.',
    beats: [
      {
        kind: 'world',
        at: ids.bridge,
        fact: 'Zeewolf lies at the anchorage; its bridge, deck and engine room form the ship interior.',
        text: 'Through the bridge windows, the sheltered anchorage is visible.',
        structures: [
          {
            ...ship,
            locationId: 'new:anchorage',
            access: false,
            outside: {
              name: 'Anchorage',
              atmosphere: 'Sheltered water outside the harbour.',
              hazard: '',
              danger: 'safe',
              riskReason: 'The anchorage is protected by the breakwater.',
            },
            outsideExits: [{ to: ids.oldPort, label: 'Marked shipping lane' }],
          },
        ],
      },
    ],
  });
  expect(value.structureUpdates![0].roomIds).toEqual(ship.roomIds);
  expect(value.placeUpdates).toContainEqual(expect.objectContaining({ ref: 'new:anchorage' }));
  expect(value.memberLocations).toEqual([]);
});

it('saves a first exterior arrival while passengers remain inside', () => {
  const { context, ids } = fixture();
  const response = voyage(context, 'new:small-harbour');
  Object.assign(response.beats[0], {
    place: {
      name: 'Small harbour',
      atmosphere: 'A sheltered basin with an enclosed landing.',
      hazard: '',
      danger: 'safe',
      riskReason: 'The breakwater protects the basin.',
      deadEnd: 'The enclosed basin ends at the quay; the shipping lane is its only water exit.',
    },
    route: 'Shipping lane to the small harbour',
    exits: [{ to: ids.oldPort, label: 'Return shipping lane' }],
  });
  const value = compileSceneTurn(context, response);
  expect(value.structureMoves![0].to).toBe('new:small-harbour');
  expect(value.arrivals).toContainEqual(expect.objectContaining({ locationId: 'new:small-harbour' }));
  expect(value.memberLocations).toEqual([]);
});

it('can establish an older flat ship and leave its anchorage in the same scene with everyone aboard', () => {
  const { context, ids, ship } = fixture();
  delete context.scene.structures;
  context.scene.memberLocations![context.members[2].id] = ids.deck;
  const response = voyage(context, ids.oldPort);
  response.beats.unshift({
    kind: 'world',
    at: ids.bridge,
    fact: 'Zeewolf lies in an anchorage outside Old harbour, with its crew in their rooms.',
    text: 'The bridge windows look out over the sheltered anchorage.',
    structures: [
      {
        ...ship,
        locationId: 'new:anchorage',
        access: false,
        outside: {
          name: 'Anchorage',
          atmosphere: 'Sheltered water outside the harbour.',
          hazard: '',
          danger: 'safe',
          riskReason: 'Sheltered water.',
        },
        outsideExits: [
          {
            to: ids.oldPort,
            label: 'Entrance shipping lane',
            transportOnly: true,
            blocked: false,
            bidirectional: true,
          },
        ],
      },
    ],
  });
  const accepted = compileSceneTurn(context, response);
  applyStructures(context.scene, accepted, (id) => id);
  expect(context.scene.structures!['new:zeewolf'].locationId).toBe(ids.oldPort);
  expect(accepted.memberLocations).toEqual([]);
});

it('rejects cyclic or overlapping containment and prevents a definition from moving an existing ship', () => {
  const { context, ids, ship } = fixture();
  const definition = { ...ship, roomIds: [...ship.roomIds] };
  const response = voyage(context, ids.newPort);
  response.beats.unshift({
    kind: 'world',
    at: ids.bridge,
    fact: 'The crew records the ship layout.',
    text: 'The bridge and deck belong to Zeewolf.',
    structures: [definition],
  });
  definition.locationId = ids.newPort;
  expect(() => compileSceneTurn(context, response)).toThrow(/redefining|transport/);
  definition.locationId = ids.engine;
  expect(() => compileSceneTurn(context, response)).toThrow(/redefining|transport/);
  definition.locationId = ship.locationId;
  context.turn.actions = context.turn.actions.map((action) => ({ ...action, text: '', passed: true }));
  response.beats = [
    {
      kind: 'world',
      at: ids.oldPort,
      fact: 'An impossible enclosure is declared.',
      text: 'An enclosure surrounds the harbour.',
      structures: [
        {
          id: 'new:cyclic',
          name: 'Enclosure',
          locationId: ids.engine,
          entranceId: ids.oldPort,
          controlId: null,
          roomIds: [ids.oldPort],
          mobile: false,
          access: true,
        },
      ],
    },
  ];
  expect(() => compileSceneTurn(context, response)).toThrow(/contain themselves/);
  const world = response.beats[0];
  if (world.kind !== 'world') throw new Error('fixture');
  world.structures![0] = {
    id: 'new:overlap',
    name: 'Overlapping structure',
    locationId: ids.oldPort,
    entranceId: ids.engine,
    controlId: null,
    roomIds: [ids.engine],
    mobile: false,
    access: true,
  };
  expect(() => compileSceneTurn(context, response)).toThrow(/exactly one structure/);
});

it.each([false, true])(
  'publishes transport in one model call and preserves state across restart (new harbour: %s)',
  async (newHarbour) => {
    const { context, ids } = fixture();
    const db = openDatabase(':memory:');
    try {
      const practice = new PracticeGM();
      let current: GMContext;
      const sceneResponse = () => {
        const response = voyage(current, newHarbour ? 'new:second-harbour' : ids.newPort);
        if (newHarbour)
          Object.assign(response.beats[0], {
            place: {
              name: 'Second harbour',
              atmosphere: 'An enclosed sheltered basin.',
              hazard: '',
              danger: 'safe',
              riskReason: 'A sheltered berth.',
              deadEnd: 'The enclosed basin has only its entrance channel.',
            },
            route: 'Shipping lane to Second harbour',
            exits: [{ to: ids.oldPort, label: 'Return shipping lane', transportOnly: true }],
          });
        return response;
      };
      const fetcher = vi.fn(
        async () =>
          new Response(
            `data: ${JSON.stringify({
              type: 'response.completed',
              response: {
                status: 'completed',
                output: [
                  {
                    type: 'message',
                    content: [{ type: 'output_text', text: JSON.stringify(sceneResponse()) }],
                  },
                ],
              },
            })}\n\n`,
          ),
      );
      const gm = new ChatGPTGM(
        { accessToken: async () => 'test' } as unknown as ChatGPTAuth,
        'owner',
        'test',
        fetcher,
      );
      const narrate = vi.fn(practice.narrate.bind(practice));
      const provider: GameMaster = {
        sceneTurns: true,
        narrate,
        adjudicate: async (live, tools) => {
          if (!live.turn.number) return practice.adjudicate(live, tools);
          current = live;
          return gm.adjudicate(live, tools);
        },
      };
      const game = new Game(
        db,
        () => provider,
        () => 4,
      );
      const owner = game.identify();
      const campaign = game.create(owner.id, context.config);
      const players = context.members.map(() => game.identify());
      for (const [index, player] of players.entries()) {
        const character = game.saveCharacter(
          player.id,
          templateCharacter(context.members[index].character.name),
        );
        game.join(campaign.inviteCode!, player.id, character.id);
        const member = game.members(campaign.id).find((member) => member.playerId === player.id)!;
        game.manageCharacter(campaign.id, player.id, {
          type: 'starter',
          itemIds: member.state.starterEquipment.slice(0, 2).map((item) => item.id),
        });
      }
      game.start(campaign.id, owner.id);
      await game.idle();
      const members = game.members(campaign.id);
      const scene: Scene = structuredClone(context.scene);
      scene.memberLocations = Object.fromEntries(
        context.members.map((saved) => [
          members.find((member) => member.character.name === saved.character.name)!.id,
          context.scene.memberLocations![saved.id],
        ]),
      );
      db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(scene), campaign.id);
      narrate.mockClear();
      const turnId = game.pending(campaign.id)!.id;
      for (const [index, player] of players.entries()) {
        const action = context.turn.actions[index];
        game.submit(campaign.id, player.id, turnId, action.text, action.passed);
      }
      await game.idle();
      const after = game.snapshot(campaign.id, owner.id);
      expect(after.turn?.phase, after.turn?.error ?? undefined).toBe('collecting');
      const destination = newHarbour
        ? Object.values(after.scene.worldMap!.nodes).find((node) => node.name === 'Second harbour')!.id
        : ids.newPort;
      expect(after.scene.structures!['new:zeewolf'].locationId).toBe(destination);
      expect(after.scene.worldMap!.nodes[destination].visited).toBe(true);
      expect(after.scene.memberLocations).toEqual(scene.memberLocations);
      expect(after.scene.places![ids.engine].loot).toEqual(scene.places![ids.engine].loot);
      const restarted = new Game(
        db,
        () => provider,
        () => 4,
      );
      await restarted.idle();
      expect(restarted.snapshot(campaign.id, owner.id).scene.structures).toEqual(after.scene.structures);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(narrate).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  },
);
