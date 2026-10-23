import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import tower from './fixtures/darknessworld-tower.json';
import recordedCombats from './fixtures/darknessworld-combat.json';
import vaalTravel from './fixtures/vaal-travel.json';
import vaalReferences from './fixtures/vaal-location-references.json';
import vaalGathering from './fixtures/vaal-gathering.json';
import wreckSearch from './fixtures/akoedabar-search.json';
import { compileSceneTurn, type SceneTurn } from '../server/scene-turn';
import { ChatGPTGM, PracticeGM } from '../server/providers';
import { Game, type GMContext, type GameTools, type GameMaster, type CombatReceipt } from '../server/game';
import { engineEvents } from '../server/turn-resolution';
import { normalizeCombatInput } from '../server/combat';
import { openDatabase } from '../server/db';
import { initialState, initialScene, baseItem } from '../shared/rules';
import { ensureLocations, memberScene } from '../shared/locations';
import { gmMemorySchema, updateGMMemory } from '../shared/gm-memory';
import { enemySchema, templateCharacter, type Encounter, type Scene } from '../shared/schema';
import type { ChatGPTAuth } from '../server/auth';
import type { Investigation, InvestigationResult } from '../shared/investigation';
import { bindInvestigationSource } from '../server/investigations';
import { factionExample } from '../server/factions';
import { applyNPCUpdates } from '../server/npcs';
import { requestsPickup } from '../server/turn-pickups';
import { submittedTravel, locationReferences, actorReferences, normalizeAdjudicationReferences } from '../server/world-map';

function fixture(): GMContext {
  const members = tower.members.map((saved) => {
    const character = templateCharacter(saved.name);
    return {
      id: saved.id,
      playerId: randomUUID(),
      playerName: saved.name,
      characterId: randomUUID(),
      character,
      state: initialState(character, saved.id),
      active: true,
    };
  });
  return {
    sceneProtocol: true,
    gmMemory: [],
    config: {
      ruleset: 'roguelike-v1',
      name: 'Recorded tower',
      setting: 'Darknessworld',
      premise: 'Investigate the eldritch interference.',
      tone: 'Horror',
      instructions: '',
      language: 'English',
      custom: [],
      provider: 'chatgpt',
      model: 'test',
    },
    members,
    startingMembers: structuredClone(members),
    scene: structuredClone(tower.scene) as Scene,
    journal: structuredClone(tower.journal) as GMContext['journal'],
    history: [],
    receipts: {},
    turn: {
      id: randomUUID(),
      number: 6,
      phase: 'resolving',
      roster: members.map((member) => member.id),
      actions: tower.members.map((saved) => ({ memberId: saved.id, text: saved.action, passed: false })),
      rolls: [],
      result: null,
      error: null,
    },
  };
}
function wreckContext(): GMContext {
  const context = fixture();
  context.members = wreckSearch.members.map((member, index) => {
    const character = { ...templateCharacter(member.name), stats: member.stats };
    return {
      ...context.members[index],
      id: member.id,
      character,
      state: initialState(character, member.id),
    };
  });
  context.startingMembers = structuredClone(context.members);
  context.scene = structuredClone(wreckSearch.scene) as Scene;
  context.journal = structuredClone(wreckSearch.journal) as GMContext['journal'];
  context.gmMemory = gmMemorySchema.parse(wreckSearch.gmMemory);
  context.turn = {
    ...context.turn,
    ...structuredClone(wreckSearch.turn),
    roster: context.members.map((member) => member.id),
  } as GMContext['turn'];
  context.receipts = structuredClone(wreckSearch.receipts);
  return context;
}

function correctedWreck(success = true): SceneTurn {
  const corrected = structuredClone(wreckSearch.response) as SceneTurn;
  const move = corrected.beats[1];
  if (move.kind !== 'move') throw new Error('Expected the recorded arrival.');
  move.fact = 'Lobsterano enters the wreck through the stern gap.';
  move.text = 'Lobsterano squeezes through the stern gap into the flooded interior.';
  move.place!.deadEnd = 'The cramped compartment ends at the hull; the stern gap is its only exit.';
  corrected.beats.push({
    kind: 'act',
    actor: move.actor,
    slot: 'main',
    intent: 'search',
    fact: success
      ? 'Lobsterano finds the Mammago tool case behind a loose maintenance panel.'
      : 'Lobsterano cannot find the tool case in the shifting water.',
    text: success
      ? 'Steadying himself against the current, Lobsterano finds the case behind a loose panel.'
      : 'The shifting water defeats the search, but an exposed maintenance panel gives him another opening.',
    finding: {
      source: 'wreck-interior:tool-case',
      fact: success
        ? 'The missing Mammago tool case lies behind a loose maintenance panel.'
        : 'An exposed maintenance panel can be opened from inside the wreck.',
    },
  });
  return corrected;
}

function descent(context: GMContext): SceneTurn {
  const moryan = context.members.find((member) => member.character.name === 'Moryan')!;
  const companion = context.members.find((member) => member.id !== moryan.id)!;
  return {
    version: 3,
    currencyName: 'night marks',
    notes: [],
    summary: 'Moryan reaches the lower chamber. Iven explains the levy.',
    beats: [
      {
        kind: 'move',
        actor: moryan.id,
        to: 'new:lower-chamber',
        fact: 'Moryan descends the iron stair into the dry lower chamber.',
        text: 'Moryan takes the iron stairs down. In the dry chamber, dust jumps with each pulse beneath the hollow shaft.',
        route: 'Iron stair',
        exits: [{ to: 'new:pump-room', name: 'Pump room', label: 'East service passage', blocked: false, bidirectional: true }],
        place: {
          name: 'Bell Tower Lower Chamber',
          atmosphere:
            'A hollow shaft stands in a dry stone chamber. The iron stair returns to Bell Tower Lane; an east service passage leads to the pump room.',
          hazard: 'Vibration comes from beneath the floor.',
          danger: 'dangerous',
          riskReason: 'The open shaft is deep, and the unknown machinery beneath the floor is active.',
        },
      },
      {
        kind: 'act',
        actor: companion.id,
        slot: 'main',
        intent: 'action',
        fact: 'Iven explains that collectors take households marked on the levy rolls.',
        text: '“The collectors take the marked households,” Iven says through the inner doorway.',
        npcs: [{ npcId: 'iven', name: 'Iven' }],
      },
    ],
  };
}
const auth = { accessToken: async () => 'test-token' } as unknown as ChatGPTAuth;
function response(value: unknown) {
  if (value && typeof value === 'object' && 'version' in value && value.version === 3)
    value = { currencyName: 'night marks', ...value };
  return new Response(
    `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] } })}\n\n`,
  );
}
function tools(context: GMContext): GameTools {
  return Object.assign(vi.fn(), {
    startCombat: vi.fn(),
    combat: vi.fn(),
    offerLoot: vi.fn(),
    completeChallenge: vi.fn(),
  });
}

function caravan(): GMContext {
  const context = fixture();
  context.scene = structuredClone(vaalTravel.scene) as Scene;
  context.members = vaalTravel.members.map((saved, index) => ({
    ...context.members[index],
    id: saved.id,
    character: templateCharacter(saved.name),
  }));
  context.startingMembers = structuredClone(context.members);
  context.turn.number = 16;
  context.turn.roster = context.members.map((member) => member.id);
  context.turn.actions = vaalTravel.members.map((saved) => ({
    memberId: saved.id,
    text: saved.action,
    passed: false,
  }));
  context.journal = [];
  return context;
}

function caravanDeparture(context: GMContext): SceneTurn {
  const gemling = context.members[0];
  const xulath = context.members[1];
  return {
    version: 3,
    notes: [{ id: 'cart-journey', locationId: 'current', cause: 'The cart carries goods to North Road.', discoveries: ['The delivery ends at North Road.'], actors: 'The cart driver.', nextChange: 'The cart reaches the gates before North Road.', dueTurn: null, status: 'open', journey: { memberId: gemling.id, destination: 'North Road', completion: 'Reach North Road.', remainingStages: 2 } }],
    summary: 'Xulath reaches the avenue; Gemling escorts the cart to the gates.',
    beats: [
      {
        kind: 'move',
        actor: xulath.id,
        to: memberScene(context.scene, gemling.id).location.id!,
        fact: 'Xulath leaves Sunward Steps and reaches Gemling on Processional Avenue before the cart departs.',
        text: 'Xulath reaches the avenue and joins Gemling before the cart moves on.',
      },
      {
        kind: 'move',
        actor: gemling.id,
        journeyId: 'cart-journey',
        to: 'new:ceremonial-gates',
        route: 'North along the avenue',
        fact: 'Gemling escorts the cart north from Processional Avenue to the ceremonial gates.',
        text: 'Gemling follows the cart to the ceremonial gates. Beyond the forecourt an open road leads north.',
        place: {
          name: 'Ceremonial Gates',
          atmosphere: 'A guarded forecourt lies between the avenue and the north road.',
          hazard: 'Cart traffic passes through the gates.',
          danger: 'safe',
          riskReason: 'Traffic moves in an orderly line.',
        },
        exits: [
          {
            to: 'new:north-road',
            name: 'North Road',
            label: 'Open road north',
            blocked: false,
            bidirectional: true,
          },
        ],
      },
      {
        kind: 'act',
        actor: gemling.id,
        slot: 'main',
        intent: 'action',
        fact: 'Gemling tells Tovek about the hazard he helped stop at Sunward Steps.',
        text: 'At the gates Gemling tells Tovek about the counterweight and the bureaucratic delay.',
        npcs: [{ npcId: 'tovek', name: 'Tovek', locationId: 'new:ceremonial-gates' }],
      },
    ],
  };
}

function referenceCaravan() {
  const context = caravan();
  context.scene = structuredClone(vaalReferences.scene) as Scene;
  context.turn.number = 19;
  context.turn.actions = vaalReferences.members.map((saved) => ({
    memberId: saved.id,
    text: saved.action,
    passed: false,
  }));
  return context;
}
function validReferenceScene(): SceneTurn {
  const scene = structuredClone(vaalReferences.response) as SceneTurn;
  const move = scene.beats[0];
  if (move.kind !== 'move') throw new Error('Expected the recorded caravan travel.');
  move.journeyId = 'recorded-cart-journey';
  scene.notes.push({ id: move.journeyId, locationId: 'current', cause: 'The cart has a fixed delivery stop.', discoveries: ['The delivery ends beyond the canal works.'], actors: 'The caravan crew.', nextChange: 'The cart reaches its delivery stop.', dueTurn: null, status: 'open', journey: { memberId: move.actor, destination: move.place!.name, completion: 'Reach the delivery stop.', remainingStages: 1 } });
  // Keep the recorded malformed references, while giving the submitted conversation
  // its own action and stable participant under the current scene contract.
  move.fact = 'Gemling legionaire continues north with the caravan onto the road beyond the canal works, scanning the traffic. No immediate danger becomes apparent.';
  move.text = 'The caravan leaves North Road and continues past irrigated fields and a roadside waystation. Gemling watches the traffic beside the wagons.';
  scene.beats.push({
    kind: 'meet',
    actor: move.actor,
    person: { npcId: 'caravan-crewman', name: 'Caravan crewman' },
    fact: 'Gemling legionaire exchanges small talk with a caravan crewman. No useful new information emerges.',
    text: 'A crewman trades a few ordinary remarks with Gemling as the wagons continue past the fields.',
  });
  return scene;
}
function locationAlias(context: GMContext, id: string) {
  return Object.entries(locationReferences(context)).find(([, place]) => place.id === id)![0];
}
function actorAlias(context: GMContext, id: string) {
  return Object.entries(actorReferences(context)).find(([, actor]) => actor.id === id)![0];
}

it('moves registered caravan companions with their escort and retains conversations at both ends', () => {
  const context = caravan();
  const actor = context.members[0];
  const origin = memberScene(context.scene, actor.id).location.id!;
  context.scene.npcs = {
    broker: {
      id: 'broker',
      name: 'Oren Vask',
      aliases: [],
      locationId: origin,
      status: 'alive',
      allegiance: null,
      fact: 'Oren travels with the caravan.',
    },
    driver: {
      id: 'driver',
      name: 'Tovek',
      aliases: [],
      locationId: origin,
      status: 'alive',
      allegiance: null,
      followingMemberId: actor.id,
      fact: 'Tovek drives the cart.',
    },
  };
  const scene = caravanDeparture(context);
  const move = scene.beats.find((beat) => beat.kind === 'move' && beat.actor === actor.id)!;
  if (move.kind !== 'move') throw new Error('Expected travel.');
  move.with = ['Oren Vask'];
  const value = compileSceneTurn(context, scene);
  const to = move.to;
  expect([
    ...new Set(value.npcUpdates?.filter((update) => update.locationId === to).map((update) => update.npcId)),
  ]).toEqual(['broker', 'driver']);
  applyNPCUpdates(context.scene, value, (ref) => ref);
  expect(context.scene.npcs.broker).toMatchObject({ locationId: to, followingMemberId: actor.id });
  expect(context.scene.npcs.driver).toMatchObject({ locationId: to, followingMemberId: actor.id });
  // The relationship is saved once; later movement omits with and still carries the same people.
  context.scene.memberLocations![actor.id] = origin;
  for (const npc of Object.values(context.scene.npcs)) npc.locationId = origin;
  delete move.with;
  const again = compileSceneTurn(context, scene);
  expect([
    ...new Set(again.npcUpdates?.filter((update) => update.locationId === to).map((update) => update.npcId)),
  ]).toEqual(['broker', 'driver']);
});

it('preserves an NPC introduction before travel and their later conversation as separate observed states', () => {
  const context = fixture();
  const actor = context.members[0];
  const at = memberScene(context.scene, actor.id).location.id!;
  context.turn.actions[0].text = 'Meet the guide, then walk downstairs.';
  const scene = descent(context);
  scene.beats.unshift({
    kind: 'meet',
    actor: actor.id,
    person: { npcId: 'guide-sella', name: 'Guide Sella', followingMemberId: 'actor:1' },
    fact: 'Guide Sella introduces herself and agrees to travel with Moryan.',
    text: '“Sella,” says the guide. “I will come with you.”',
  });
  const move = scene.beats.find((beat) => beat.kind === 'move')!;
  if (move.kind !== 'move') throw new Error('Expected travel.');
  scene.beats.splice(2, 0, {
    kind: 'world',
    at: move.to,
    fact: 'Guide Sella points out the maintenance lever.',
    text: 'Sella points to the lever.',
    npcs: [{ npcId: 'guide-sella', name: 'Guide Sella' }],
  });
  const value = compileSceneTurn(context, scene);
  expect(
    value.npcUpdates?.filter((update) => update.npcId === 'guide-sella').map((update) => update.locationId),
  ).toEqual([at, move.to]);
  applyNPCUpdates(context.scene, value, (ref) => ref);
  expect(context.scene.npcs?.['guide-sella']).toMatchObject({
    locationId: move.to,
    followingMemberId: actor.id,
  });
});

it.each(['remote', 'dead', 'fighting'])('refuses an unsupported %s travelling companion', (kind) => {
  const context = caravan();
  const actor = context.members[0];
  const origin = memberScene(context.scene, actor.id).location.id!;
  const name = 'Travelling guard';
  context.scene.npcs = {
    guard: {
      id: 'guard',
      name,
      aliases: [],
      locationId: kind === 'remote' ? context.scene.location.id! : origin,
      status: kind === 'dead' ? 'dead' : 'alive',
      allegiance: null,
      fact: 'A guard.',
    },
  };
  if (kind === 'fighting') {
    const enemy = enemySchema.parse({
      id: 'guard',
      name,
      hp: 12,
      defense: 10,
      attack: 1,
      damage: '1d4',
      tier: 'normal',
      description: 'A guard.',
      tactic: 'Fight.',
    });
    context.scene.places![origin].encounter = {
      enemies: [{ ...enemy, maxHp: 12, initiative: 10 }],
      round: 1,
      initiative: [],
      victory: false,
      escaped: false,
    };
  }
  const scene = caravanDeparture(context);
  const move = scene.beats.find((beat) => beat.kind === 'move' && beat.actor === actor.id)!;
  if (move.kind !== 'move') throw new Error('Expected travel.');
  move.with = ['guard'];
  expect(() => compileSceneTurn(context, scene)).toThrow();
});

it.each([
  ['I take the notice and submit myself for "private medical consultation".', true],
  ['I take the stairs down.', false],
  ['Take a look at the notice.', false],
  ['Ik neem de trap naar beneden.', false],
  ['Ik neem het briefje mee.', true],
  ["I don't take the notice.", false],
  ['Pick up the pace.', false],
])('distinguishes object collection from movement and observation: %s', (text, wanted) => {
  expect(requestsPickup(text)).toBe(wanted);
});

it('rejects silently omitted collection while allowing the GM to generate the described ordinary item', () => {
  const context = fixture();
  const actor = context.members[0];
  context.turn.actions[0].text = 'I take the notice and go downstairs.';
  const scene = descent(context);
  expect(() => compileSceneTurn(context, scene)).toThrow('submitted object collection');
  scene.beats.unshift({
    kind: 'take',
    actor: actor.id,
    item: {
      source: 'consultation-notice',
      name: 'Consultation notice',
      description: 'A paper notice offering private medical consultations in the screened ritual court.',
    },
    fact: 'Moryan takes the consultation notice.',
    text: 'Moryan folds the notice and takes it along.',
  });
  const value = compileSceneTurn(context, scene);
  expect(value.storyItems).toContainEqual(
    expect.objectContaining({
      name: 'Consultation notice',
      locationId: memberScene(context.scene, actor.id).location.id,
    }),
  );
  expect(value.pickups).toHaveLength(1);
  expect(value.memberLocations).toContainEqual(
    expect.objectContaining({ memberId: actor.id, locationId: 'new:lower-chamber' }),
  );
});

it('saves a generated notice before travel and resumes publication without creating a second copy', async () => {
  const f = await table((context) => {
    const scene = descent(context);
    const actor = context.members.find((member) => member.character.name === 'Moryan')!;
    scene.beats = scene.beats.filter((beat) => 'actor' in beat && beat.actor === actor.id);
    scene.beats.unshift({
      kind: 'take',
      actor: actor.id,
      item: {
        source: 'consultation-notice',
        name: 'Consultation notice',
        description: 'A notice offering private medical consultations in the screened ritual court.',
      },
      fact: 'Moryan takes the consultation notice.',
      text: 'Moryan folds the consultation notice and takes it along.',
    });
    return scene;
  });
  try {
    f.db.exec(
      "CREATE TRIGGER interrupt_notice BEFORE UPDATE OF gm_memory ON campaigns BEGIN SELECT RAISE(ABORT, 'publication interrupted'); END;",
    );
    const turnId = f.submit({ Moryan: 'I take the notice and go downstairs.', Katooluman: '' });
    await f.game.idle();
    expect(f.game.pending(f.campaign.id)?.phase).toBe('failed');
    const saved = JSON.parse(f.game.pending(f.campaign.id)!.draft!);
    expect(saved.resolution).toBeDefined();
    const draws = f.draw.mock.calls.length;
    f.db.exec('DROP TRIGGER interrupt_notice');
    const game = new Game(f.db, () => f.provider, f.draw);
    game.retry(f.campaign.id, f.host.id);
    await game.idle();
    const snapshot = game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    const actor = snapshot.members.find((member) => member.character.name === 'Moryan')!;
    const items = actor.state.inventory.filter((item) => item.name === 'Consultation notice');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'tool',
      quantity: 1,
      description: expect.stringContaining('private medical consultations'),
    });
    expect(memberScene(snapshot.scene, actor.id).location.name).toBe('Bell Tower Lower Chamber');
    expect(snapshot.history.at(-1)?.id).toBe(turnId);
    expect(snapshot.history.at(-1)?.result?.narration).toContain('notice');
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.draw).toHaveBeenCalledTimes(draws);
  } finally {
    f.db.close();
  }
});

it('keeps a caravan companion attached across publication, restart and another journey without repeated instructions', async () => {
  let origin: string;
  const f = await table((context) => {
    const actor = context.members.find((member) => member.character.name === 'Moryan')!;
    if (context.turn.number === 6) {
      const scene = descent(context);
      scene.beats = scene.beats.filter((beat) => 'actor' in beat && beat.actor === actor.id);
      const move = scene.beats[0];
      if (move.kind !== 'move') throw new Error('Expected travel.');
      move.with = ['Oren Vask'];
      return scene;
    }
    return {
      version: 3,
      summary: 'The escort returns upstairs.',
      beats: [
        {
          kind: 'move',
          actor: actor.id,
          to: origin,
          fact: 'Moryan goes back upstairs.',
          text: 'Moryan returns upstairs with the caravan broker.',
        },
      ],
    };
  });
  try {
    const actor = f.members.find((member) => member.character.name === 'Moryan')!;
    const scene: Scene = JSON.parse(f.game.campaign(f.campaign.id).scene!);
    origin = memberScene(scene, actor.id).location.id!;
    scene.npcs ??= {};
    scene.npcs.broker = {
      id: 'broker',
      name: 'Oren Vask',
      aliases: [],
      locationId: origin,
      status: 'alive',
      allegiance: 'Caravan crew',
      fact: 'Oren has agreed to travel with the escort.',
    };
    f.db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(scene), f.campaign.id);
    f.submit({ Moryan: 'Go downstairs with Oren.', Katooluman: '' });
    await f.game.idle();
    let snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(snapshot.scene.npcs?.broker).toMatchObject({
      locationId: memberScene(snapshot.scene, actor.id).location.id,
      followingMemberId: actor.id,
    });
    const game = new Game(f.db, () => f.provider, f.draw);
    const turn = game.pending(f.campaign.id)!;
    for (const member of f.members)
      game.submit(
        f.campaign.id,
        member.playerId,
        turn.id,
        member.id === actor.id ? 'Go upstairs.' : '',
        member.id !== actor.id,
      );
    await game.idle();
    snapshot = game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(snapshot.scene.npcs?.broker).toMatchObject({
      locationId: origin!,
      followingMemberId: actor.id,
      allegiance: 'Caravan crew',
    });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.narrate).not.toHaveBeenCalled();
  } finally {
    f.db.close();
  }
});

it('persists an invented successful finding as a physical change that enables the next submitted action', async () => {
  const destination = randomUUID();
  const f = await table((context) => {
    const actor = context.members.find((member) => member.character.name === 'Moryan')!;
    if (context.turn.number === 6)
      return {
        version: 3,
        summary: 'Moryan finds and releases the hidden latch.',
        beats: [
          {
            kind: 'act',
            actor: actor.id,
            fact: 'Moryan finds a hidden counterweight latch and releases the iron gate.',
            text: 'Behind the worn relief, Moryan finds a recessed latch. Pulling it lifts the iron gate.',
            features: [
              { featureId: 'iron-gate', name: 'Iron gate', properties: { latched: false }, passable: true },
            ],
            journal: { kind: 'fact', name: 'Hidden gate latch' },
            progress: { thread: 'premise', kind: 'discovery' },
          },
        ],
      };
    expect(context.scene.features?.['iron-gate'].properties.latched).toBe(false);
    expect(context.scene.worldMap?.connections.find((edge) => edge.to === destination)?.blocked).toBe(false);
    return {
      version: 3,
      summary: 'Moryan walks through the opened gate.',
      beats: [
        {
          kind: 'move',
          actor: actor.id,
          to: destination,
          fact: 'Moryan walks through the open iron gate into the garden.',
          text: 'Moryan steps through the raised gate into the garden.',
        },
      ],
    };
  });
  try {
    const actor = f.members.find((member) => member.character.name === 'Moryan')!;
    const scene: Scene = JSON.parse(f.game.campaign(f.campaign.id).scene!);
    const origin = memberScene(scene, actor.id).location.id!;
    scene.places![destination] = {
      location: { id: destination, name: 'Garden', atmosphere: 'A quiet garden.', hazard: '' },
      encounter: null,
      loot: [],
      encounterRisk: { danger: 'safe', reason: 'An enclosed garden.' },
    };
    scene.worldMap!.nodes[destination] = { id: destination, name: 'Garden', visited: true };
    scene.worldMap!.connections.push({
      from: origin,
      to: destination,
      blocked: true,
      bidirectional: true,
      label: 'Iron gate',
    });
    scene.features = {
      ...scene.features,
      'iron-gate': {
        id: 'iron-gate',
        name: 'Iron gate',
        aliases: [],
        locationId: origin,
        properties: { latched: true },
        route: { from: origin, to: destination },
        fact: 'The iron gate is shut.',
      },
    };
    f.db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(scene), f.campaign.id);
    const adjudicate = f.provider.adjudicate!;
    f.provider.adjudicate = async (context, tools) => {
      if (context.turn.number === 6)
        tools({
          memberId: actor.id,
          stat: 'INT',
          dc: 10,
          mode: 'normal',
          lethal: false,
          reason: 'Find the concealed gate mechanism and release it.',
        });
      return adjudicate(context, tools);
    };
    f.draw.mockImplementation((sides) => (sides === 20 ? 18 : sides));
    f.submit({ Moryan: 'Find the hidden mechanism and open the iron gate.', Katooluman: '' });
    await f.game.idle();
    expect(f.game.snapshot(f.campaign.id, f.host.id).turn?.phase).toBe('collecting');
    f.submit({ Moryan: 'Walk to the Garden.', Katooluman: '' });
    await f.game.idle();
    const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(memberScene(snapshot.scene, actor.id).location.id).toBe(destination);
    expect(snapshot.journal.find((entry) => entry.name === 'Hidden gate latch')?.detail).toContain(
      'hidden counterweight latch',
    );
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  } finally {
    f.db.close();
  }
});

it('accepts the recorded eight-attempt location failure in one response by repairing its unique named reference', async () => {
  const context = referenceCaravan();
  context.requestBudget = { used: 0, limit: 1 };
  const original = structuredClone(vaalReferences.response);
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const input = JSON.parse(JSON.parse(init!.body as string).input[0].content);
    const alias = locationAlias(context, context.scene.memberLocations![context.members[0].id]);
    expect(input.members[0].locationId).toBe(alias);
    expect(input.scene.worldMap.nodes[alias].id).toBe(alias);
    expect(input.locationRefs[alias]).toEqual({ id: alias, name: 'North Road' });
    expect(input.members[0].id).toBe(actorAlias(context, context.members[0].id));
    expect(input.actorRefs[input.members[0].id]).toEqual({ id: input.members[0].id, name: context.members[0].character.name });
    return response(validReferenceScene());
  });
  const value = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, tools(context));
  expect(fetcher).toHaveBeenCalledTimes(1);
  const causeway = Object.values(context.scene.worldMap!.nodes).find(
    (node) => node.name === 'North Causeway',
  )!;
  expect(value.mapUpdates?.connections).toContainEqual(
    expect.objectContaining({
      from: 'new:north-road-beyond',
      to: causeway.id,
    }),
  );
  expect(value.mapUpdates?.locations).toEqual([]);
  expect(value.memberLocations?.[0].locationId).toBe('new:north-road-beyond');
  expect(value.memberLocations?.[1].locationId).toBe(
    Object.values(context.scene.worldMap!.nodes).find((node) => node.name === 'Canal Loading Yard')!.id,
  );
  expect(value.npcUpdates).toContainEqual(expect.objectContaining({
    npcId: 'caravan-crewman', locationId: 'new:north-road-beyond',
  }));
  expect(context.turn.rolls).toEqual([]);
  expect(vaalReferences.response).toEqual(original);
});

it('reports all unresolved scene references together so one correction replaces the broken references', async () => {
  const context = referenceCaravan();
  context.requestBudget = { used: 0, limit: 2 };
  const unnamed = validReferenceScene();
  const broken = vaalReferences.response.beats[0].exits[1].to;
  for (const beat of unnamed.beats)
    if ('exits' in beat) for (const exit of beat.exits ?? []) if (exit.to === broken) delete exit.name;
  const fixed = validReferenceScene();
  const causeway = Object.values(context.scene.worldMap!.nodes).find(
    (node) => node.name === 'North Causeway',
  )!;
  for (const beat of fixed.beats)
    if ('exits' in beat)
      for (const exit of beat.exits ?? []) if (exit.to === broken) exit.to = locationAlias(context, causeway.id);
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (fetcher.mock.calls.length === 1) return response(unnamed);
    const feedback = JSON.parse(init!.body as string).input.at(-1).content;
    expect(feedback).toContain('beats[0].exits[1].to');
    expect(feedback).toContain('beats[1].exits[0].to');
    expect(feedback).toContain('North Causeway');
    expect(feedback).toContain(locationAlias(context, causeway.id));
    return response(fixed);
  });
  const value = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, tools(context));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(value.memberLocations).toHaveLength(2);
});

it('normalizes only location fields in scene beats, notes and nested updates', () => {
  const context = referenceCaravan();
  const from = context.scene.memberLocations![context.members[0].id];
  const to = context.scene.memberLocations![context.members[1].id];
  const alias = locationAlias(context, from);
  const raw = {
    version: 3,
    beats: [
      {
        kind: 'world',
        at: alias,
        fact: alias,
        npcs: [
          { npcId: alias, locationId: alias },
          { npcId: 'lost', locationId: null },
        ],
        features: [
          {
            featureId: alias,
            route: { from: alias, to: locationAlias(context, to) },
            properties: { text: alias },
          },
        ],
        exits: [{ to: 'new:preview', name: 'New waystation' }],
      },
      { kind: 'take', actor: alias, itemId: alias },
    ],
    notes: [{ id: alias, locationId: alias }],
  };
  const before = structuredClone(raw);
  const value = normalizeAdjudicationReferences(context, raw) as typeof raw;
  expect(value.beats[0]).toMatchObject({
    at: from,
    fact: alias,
    npcs: [
      { npcId: alias, locationId: from },
      { npcId: 'lost', locationId: null },
    ],
    features: [{ featureId: alias, route: { from, to }, properties: { text: alias } }],
    exits: [{ to: 'new:preview' }],
  });
  expect(value.beats[1]).toEqual(raw.beats[1]);
  expect(value.notes).toEqual([{ id: alias, locationId: from }]);
  expect(raw).toEqual(before);
});

it('refuses to guess between duplicate or conflicting place identities', () => {
  const context = referenceCaravan();
  const causeway = Object.values(context.scene.worldMap!.nodes).find(
    (node) => node.name === 'North Causeway',
  )!;
  context.scene.worldMap!.nodes['other-causeway'] = {
    id: 'other-causeway',
    name: causeway.name,
    visited: false,
  };
  expect(() => compileSceneTurn(context, vaalReferences.response)).toThrow('Unknown location references');
  delete context.scene.worldMap!.nodes['other-causeway'];
  const conflicting = structuredClone(vaalReferences.response);
  conflicting.beats[1].exits[0].name = 'North Road';
  expect(() => compileSceneTurn(context, conflicting)).toThrow('Conflicting named location references');
  const separate = structuredClone(vaalReferences.response);
  separate.beats[0].place.name = 'North Road';
  const normalized = normalizeAdjudicationReferences(context, separate) as typeof separate;
  expect(normalized.beats[0].to).toBe('new:north-road-beyond');
});

it('publishes the recorded location-reference failure in an isolated game with one scene response', async () => {
  const f = await table(
    (context) => {
      const actors = new Map(
        vaalReferences.members.map((saved) => [
          saved.id,
          context.members.find((member) => member.character.name === saved.name)!.id,
        ]),
      );
      return JSON.parse(
        JSON.stringify(validReferenceScene(), (_key, value) =>
          typeof value === 'string' ? (actors.get(value) ?? value) : value,
        ),
      );
    },
    { scene: vaalReferences.scene as Scene, members: vaalReferences.members, journal: [] },
  );
  try {
    f.db.prepare('UPDATE turns SET number=19 WHERE id=?').run(f.game.pending(f.campaign.id)!.id);
    f.submit();
    await f.game.idle();
    const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(snapshot.turn?.number).toBe(20);
    const gemling = snapshot.members.find((member) => member.character.name === 'Gemling legionaire')!;
    const xulath = snapshot.members.find((member) => member.character.name === 'Xulath')!;
    expect(memberScene(snapshot.scene, gemling.id).location.name).toBe('Outer North Road');
    expect(memberScene(snapshot.scene, xulath.id).location.name).toBe('Canal Loading Yard');
    expect(snapshot.scene.npcs?.['caravan-crewman']).toMatchObject({
      name: 'Caravan crewman', locationId: memberScene(snapshot.scene, gemling.id).location.id,
    });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.narrate).not.toHaveBeenCalled();
    expect(snapshot.history.at(-1)?.rolls).toEqual([]);
  } finally {
    f.db.close();
  }
});

it.each(['start_combat', 'investigate'])(
  'resolves scene location aliases before %s and returns aliases in its receipt',
  async (name) => {
    const context = fixture();
    context.requestBudget = { used: 0, limit: 2 };
    const at = context.scene.location.id!;
    const alias = locationAlias(context, at);
    const finding = investigate(context, false);
    finding.source = { kind: 'place', id: alias, locationId: alias };
    finding.preparation.locationId = alias;
    finding.success.lead.locationId = alias;
    finding.failure.lead.locationId = alias;
    const receipt = { memberId: finding.memberId, locationId: at, source: { kind: 'place', id: at, locationId: at } };
    const gameTools = Object.assign(tools(context), { investigate: vi.fn(() => receipt) });
    vi.mocked(gameTools.startCombat).mockReturnValue(receipt as never);
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (fetcher.mock.calls.length === 1)
        return toolResponse(
          name,
          name === 'investigate'
            ? { ...finding, memberId: actorAlias(context, finding.memberId) }
            : { locationId: alias, enemies: [], introduction: 'Sentries bar the road.' },
        );
      const output = JSON.parse(init!.body as string).input.find(
        (item: { type?: string }) => item.type === 'function_call_output',
      );
      expect(JSON.parse(output.output)).toEqual({
        memberId: actorAlias(context, finding.memberId),
        locationId: alias,
        source: { kind: 'place', id: alias, locationId: alias },
      });
      return response(descent(context));
    });
    await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, gameTools);
    expect(fetcher).toHaveBeenCalledTimes(2);
    if (name === 'start_combat')
      expect(gameTools.startCombat).toHaveBeenCalledExactlyOnceWith([], at, 'Sentries bar the road.');
    else
      expect(gameTools.investigate).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          memberId: finding.memberId,
          source: { kind: 'place', id: at, locationId: at },
          preparation: expect.objectContaining({ locationId: at }),
          success: expect.objectContaining({ lead: expect.objectContaining({ locationId: at }) }),
          failure: expect.objectContaining({ lead: expect.objectContaining({ locationId: at }) }),
        }),
      );
  },
);

it.each(['roll_check', 'use_resource'])(
  'round-trips short character references through %s without changing item IDs or prose',
  async (name) => {
    const context = fixture();
    context.requestBudget = { used: 0, limit: 2 };
    const [actor, target] = context.members;
    const acting = actorAlias(context, actor.id);
    const helping = actorAlias(context, target.id);
    const receipt = { memberId: actor.id, targetId: target.id, itemId: acting, fact: helping };
    const gameTools = tools(context);
    vi.mocked(gameTools).mockReturnValue(receipt as never);
    gameTools.useResource = vi.fn(() => receipt as never);
    const args =
      name === 'roll_check'
        ? {
            memberId: acting,
            assistsMemberId: helping,
            assistedBy: [helping],
            stat: 'WIS',
            dc: 10,
            mode: 'normal',
            reason: 'Read the markings.',
          }
        : { memberId: acting, targetId: helping, itemId: acting, abilityName: null };
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (fetcher.mock.calls.length === 1) return toolResponse(name, args);
      const output = JSON.parse(init!.body as string).input.find(
        (item: { type?: string }) => item.type === 'function_call_output',
      );
      expect(JSON.parse(output.output)).toEqual({
        memberId: acting,
        targetId: helping,
        itemId: acting,
        fact: helping,
      });
      const scene = descent(context);
      for (const beat of scene.beats) if ('actor' in beat) beat.actor = actorAlias(context, beat.actor);
      return response(scene);
    });
    const accepted = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, gameTools);
    expect(fetcher).toHaveBeenCalledTimes(2);
    if (name === 'roll_check')
      expect(gameTools).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          memberId: actor.id,
          assistsMemberId: target.id,
          assistedBy: [target.id],
        }),
      );
    else
      expect(gameTools.useResource).toHaveBeenCalledExactlyOnceWith({
        memberId: actor.id,
        targetId: target.id,
        itemId: acting,
        abilityName: null,
      });
    expect(accepted.actions.map((action) => action.memberId)).toEqual(
      context.turn.actions.map((action) => action.memberId),
    );
  },
);

it.each([false, true])(
  'publishes new gathering scenes and persistent surprises without another writer, including restart=%s',
  async (interrupted) => {
    const middle = vaalGathering.turn.actions.find((action) => action.gathering)!.gathering!.route[1];
    const strange = 'A stone marker unfolds into a mouth and demands its maker’s name.';
    const f = await table(
      (context) => {
        expect(context.sceneProtocol).toBe(true);
        const joiner = context.turn.actions.find((action) => action.gathering)!;
        return {
          version: 3,
          summary: 'Xulath reaches the talking marker.',
          beats: [
            {
              kind: 'gather',
              actor: actorAlias(context, joiner.memberId),
              text: 'Xulath follows the familiar road beyond the waystation.',
              stop: { at: middle, fact: strange, text: strange },
            },
            {
              kind: 'world',
              at: middle,
              fact: 'The speaking marker blocks the road.',
              text: 'Its carved letters move like lips.',
              features: [
                {
                  featureId: 'speaking-marker',
                  name: 'Speaking marker',
                  properties: { demand: 'Its maker’s name.' },
                },
              ],
              place: {
                name: context.scene.places![middle].location.name,
                atmosphere: 'A stone marker speaks beside the irrigation channels.',
                hazard: 'The marker bars the way.',
                danger: 'dangerous',
                riskReason: 'The awakened stone blocks travellers.',
              },
            },
          ],
          notes: [
            {
              id: 'speaking-marker',
              locationId: middle,
              cause: 'PRIVATE: An old road ward responds to imperial couriers.',
              discoveries: ['The maker’s name is carved underneath.'],
              actors: 'The road ward awaits an answer.',
              nextChange: 'The ward asks again.',
              dueTurn: context.turn.number + 2,
              status: 'open',
            },
          ],
        };
      },
      {
        scene: vaalGathering.scene as Scene,
        members: vaalGathering.members.map((member) => ({ ...member, action: '' })),
        journal: [],
      },
    );
    try {
      const gemling = f.members.find((member) => member.character.name === 'Gemling legionaire')!;
      const xulath = f.members.find((member) => member.id !== gemling.id)!;
      const turn = f.game.pending(f.campaign.id)!;
      f.game.callGathering(f.campaign.id, gemling.playerId, turn.id);
      const gathering = f.game.snapshot(f.campaign.id, f.host.id).scene.gathering!;
      if (interrupted)
        f.db.exec(
          "CREATE TRIGGER interrupt_gather BEFORE UPDATE OF gm_memory ON campaigns BEGIN SELECT RAISE(ABORT, 'publication interrupted'); END;",
        );
      f.game.submit(f.campaign.id, xulath.playerId, turn.id, '', false, false, null, null, gathering.id);
      f.game.submit(f.campaign.id, gemling.playerId, turn.id, '', true);
      await f.game.idle();
      let game = f.game;
      if (interrupted) {
        expect(game.pending(f.campaign.id)?.phase).toBe('failed');
        const checkpoint = JSON.parse(game.pending(f.campaign.id)!.draft!);
        expect(checkpoint.adjudication.sceneDraft).toBeDefined();
        expect(game.snapshot(f.campaign.id, f.host.id).scene.features?.['speaking-marker']).toBeUndefined();
        const draws = f.draw.mock.calls.length;
        f.db.exec('DROP TRIGGER interrupt_gather');
        game = new Game(f.db, () => f.provider, f.draw);
        game.retry(f.campaign.id, f.host.id);
        await game.idle();
        expect(f.draw).toHaveBeenCalledTimes(draws);
      }
      const snapshot = game.snapshot(f.campaign.id, f.host.id);
      expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
      expect(memberScene(snapshot.scene, xulath.id).location.id).toBe(middle);
      expect(memberScene(snapshot.scene, gemling.id).location.id).toBe(gathering.locationId);
      expect(snapshot.scene.features?.['speaking-marker']).toMatchObject({
        locationId: middle,
        properties: { demand: 'Its maker’s name.' },
      });
      expect(snapshot.journal).toContainEqual(expect.objectContaining({ detail: strange }));
      expect(snapshot.history.at(-1)?.result?.narration).toContain(strange);
      expect(snapshot.history.at(-1)?.result?.xp).toBe(0);
      expect(
        snapshot.history.at(-1)?.rolls.filter((roll) => roll.reason === 'Random encounter'),
      ).toHaveLength(1);
      expect(JSON.parse(game.campaign(f.campaign.id).gm_memory)[0].cause).toContain('PRIVATE');
      expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
      expect(f.fetcher).toHaveBeenCalledTimes(1);
      expect(f.narrate).not.toHaveBeenCalled();
    } finally {
      f.db.close();
    }
  },
);

it('repairs the recorded cart turn without dropping onward travel or joining at the shared focus', async () => {
  const context = caravan();
  const fixed = caravanDeparture(context);
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string);
    const input = JSON.parse(body.input[0].content);
    expect(input.members[0].locationId).toBe(locationAlias(context, context.scene.memberLocations![context.members[0].id]));
    expect(input.submittedTravel[actorAlias(context, context.members[0].id)]).toEqual({ onward: true });
    expect(input.submittedTravel[actorAlias(context, context.members[1].id)]).toMatchObject({
      goalId: locationAlias(context, context.scene.memberLocations![context.members[0].id]),
      companionId: actorAlias(context, context.members[0].id),
    });
    const call = fetcher.mock.calls.length;
    if (call === 1) return response(vaalTravel.sameLocationMove);
    if (call === 2) {
      expect(body.input.at(-1).content).toContain('Preserve submitted onward travel');
      return response(vaalTravel.droppedTravel);
    }
    expect(body.input.at(-1).content).toContain('submitted travel');
    return response(fixed);
  });
  const value = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, tools(context));
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(value.memberLocations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ memberId: context.members[0].id, locationId: 'new:ceremonial-gates' }),
      expect.objectContaining({
        memberId: context.members[1].id,
        locationId: context.scene.memberLocations![context.members[0].id],
      }),
    ]),
  );
  expect(value.actions.find((action) => action.memberId === context.members[1].id)?.travel?.goalId).toBe(
    memberScene(context.scene, context.members[0].id).location.id,
  );
  expect(value.mapUpdates?.connections).toContainEqual(
    expect.objectContaining({
      from: 'new:ceremonial-gates',
      to: 'new:north-road',
      blocked: false,
    }),
  );
});

it('requires a move for each explicit travel request even when conversation fails', () => {
  const context = caravan();
  context.turn.actions[1].passed = true;
  context.turn.rolls.push({
    id: 'failed-conversation',
    memberId: context.members[0].id,
    stat: 'CHA',
    dc: 10,
    mode: 'normal',
    dice: [2],
    modifier: 0,
    total: 2,
    success: false,
    reason: 'The driver is distracted.',
    lethal: false,
    source: 'test',
  });
  const stationary = structuredClone(vaalTravel.droppedTravel);
  stationary.beats = stationary.beats.filter((beat) => beat.actor === context.members[0].id);
  expect(() => compileSceneTurn(context, stationary)).toThrow('submitted travel');
  const moving = caravanDeparture(context);
  moving.beats.shift();
  const value = compileSceneTurn(context, moving);
  expect(value.actions[0]).toMatchObject({
    status: 'partial',
    components: { movement: { status: 'success' }, main: { status: 'failure' } },
  });
  expect(value.memberLocations?.[0].locationId).toBe('new:ceremonial-gates');
});

it('requires first-arrival routes while permitting an explicitly described dead end', () => {
  const context = caravan();
  const proposal = caravanDeparture(context);
  const move = proposal.beats[1];
  if (move.kind !== 'move') throw new Error('fixture');
  delete move.exits;
  expect(() => compileSceneTurn(context, proposal)).toThrow('needs explicit exits');
  move.exits = [];
  expect(() => compileSceneTurn(context, proposal)).toThrow('open onward exit');
  move.place!.deadEnd = 'The forecourt ends at the barred gate; the avenue is the only way back.';
  move.text = 'Gemling reaches the forecourt, where a barred gate closes the road ahead.';
  const value = compileSceneTurn(context, proposal);
  expect(value.placeUpdates?.find((place) => place.ref === 'new:ceremonial-gates')?.location.hazard)
    .toContain(move.place!.deadEnd);
  expect(value.memberLocations?.some((position) => position.locationId === 'new:ceremonial-gates')).toBe(
    true,
  );
});

it('takes one reachable hop toward a distant companion and leaves that companion in place', () => {
  const context = caravan();
  const gemling = context.members[0];
  const xulath = context.members[1];
  const steps = context.scene.location.id!;
  const temple = Object.values(context.scene.worldMap!.nodes).find(
    (node) => node.name === 'The Temple Ward',
  )!;
  context.scene.memberLocations![xulath.id] = temple.id;
  context.turn.actions[0].passed = true;
  const proposal = caravanDeparture(context);
  proposal.notes = [];
  proposal.beats = [
    {
      kind: 'move',
      actor: xulath.id,
      to: steps,
      fact: 'Xulath travels from Temple Ward to Sunward Steps on his way to Gemling on the avenue.',
      text: 'Xulath reaches Sunward Steps; Gemling is still farther along the route.',
    },
  ];
  const value = compileSceneTurn(context, proposal);
  expect(value.memberLocations).toEqual([
    expect.objectContaining({ memberId: xulath.id, locationId: steps }),
  ]);
  expect(value.actions.find((action) => action.memberId === xulath.id)?.travel?.goalId).toBe(
    memberScene(context.scene, gemling.id).location.id,
  );
});

it('retains a real blocked journey without inventing an arrival', () => {
  const context = caravan();
  context.turn.actions[1].passed = true;
  const value = compileSceneTurn(context, {
    version: 3,
    notes: [],
    summary: 'The cart stops at a newly lowered barrier.',
    beats: [
      {
        kind: 'act',
        actor: context.members[0].id,
        slot: 'main',
        blocked: 'Guards have lowered a barrier across the lane ahead of the cart.',
        fact: 'The cart stops before the lowered barrier; Gemling remains on Processional Avenue.',
        text: 'Guards lower a barrier across the lane, bringing the cart to a halt.',
      },
    ],
  });
  expect(value.actions[0].status).toBe('blocked');
  expect(value.memberLocations).toEqual([]);
});

it.each([
  ['Join gemling', 'companion'],
  ['Go to the avenue, search around along the way', 'goal'],
  ['Ask him about the ledger, while proceeding to follow the cart', 'onward'],
  ['Volg de kar naar de volgende locatie', 'onward'],
  ['Ik sluit me aan bij Gemling', 'companion'],
  ['I do not follow the cart; I wait here.', null],
  ['I say "follow the cart to the next area" and stay here.', null],
  ["I follow the cart driver's instructions.", null],
  ['Follow the cart around the same area.', null],
  ['Ask where Gemling went.', null],
])('recognizes explicit travel without interpreting dialogue or local footwork: %s', (text, kind) => {
  const context = caravan();
  context.turn.actions[1].text = text;
  const journey = submittedTravel(context, context.members[1].id);
  if (!kind) expect(journey).toBeUndefined();
  else if (kind === 'onward') expect(journey).toEqual({ onward: true });
  else expect(journey?.goalId).toBe(memberScene(context.scene, context.members[0].id).location.id);
});

it.each([true, false])(
  'supplies active openings, character and faction introductions in both protocols (scene=%s)',
  async (sceneProtocol) => {
    const context = fixture();
    context.sceneProtocol = sceneProtocol;
    context.turn.number = 0;
    context.turn.actions = [];
    context.factions = factionExample(['wardens', 'traders', 'scholars'], context.config.setting, [], 0);
    const at = context.scene.location.id!;
    context.scene.memberLocations = Object.fromEntries(context.members.map((member) => [member.id, at]));
    const opening: SceneTurn = {
      version: 3,
      opening: { npcs: [], features: ['sluice'], quests: [], mysteries: [] },
      notes: [],
      summary: 'A flood threatens the lane; the sluice workshop is accessible.',
      beats: [
        {
          kind: 'world',
          at,
          fact: 'A broken sluice is flooding Bell Tower Lane. A bell warns the residents. An open eastward passage reaches the sluice workshop.',
          features: [{ featureId: 'sluice', name: 'Broken sluice', properties: { broken: true } }],
          text: 'A warning bell rings as water pours through the broken sluice into Bell Tower Lane. To the east, an open passage leads to the sluice workshop.',
          place: {
            name: context.scene.location.name,
            atmosphere: 'Floodwater runs beneath the tower as the warning bell rings.',
            hazard: 'A broken sluice floods the lane.',
            danger: 'dangerous',
            riskReason: 'Water from the broken sluice threatens the lane.',
          },
          exits: [
            {
              to: 'new:workshop',
              name: 'Sluice workshop',
              label: 'East passage',
              blocked: false,
              bidirectional: true,
            },
          ],
        },
        ...context.members.map((member) => ({
          kind: 'world' as const,
          at,
          fact: `${member.character.name}: ${member.character.concept}. ${member.character.background}`,
          text: `${member.character.name}: ${member.character.concept}. ${member.character.background}`,
        })),
        ...context.factions.factions.map((faction) => ({
          kind: 'world' as const,
          at,
          fact: `${faction.name}: ${faction.identity}.`,
          text: `${faction.name}: ${faction.identity}.`,
          factions: [
            { type: 'discover' as const, factionId: faction.id, knownDescription: faction.identity },
          ],
        })),
      ],
    };
    const compiled = compileSceneTurn(context, opening);
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      expect(body.instructions).toContain(
        'an immediate threat, an unfolding urgent problem and/or specific accessible leads',
      );
      expect(body.instructions).toContain(
        'Give EVERY active party member a short individual introduction by name',
      );
      expect(body.instructions).toContain('Introduce EVERY supplied faction by name and public role');
      expect(body.instructions).toContain('at least one open onward route beyond the way back');
      expect(body.instructions).not.toContain('Opening turn0 can reveal zero');
      return response(sceneProtocol ? opening : compiled);
    });
    const accepted = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, tools(context));
    expect(accepted.actions).toEqual([]);
    expect(accepted.rewards).toMatchObject({ xp: 0, currency: 0 });
    expect(accepted.factionEffects?.map((effect) => effect.factionId)).toEqual([
      'wardens',
      'traders',
      'scholars',
    ]);
    const facts = accepted.events.map((event) => event.fact).join(' ');
    for (const member of context.members) expect(facts).toContain(member.character.name);
    for (const faction of context.factions.factions) {
      expect(facts).toContain(faction.identity);
      expect(facts).not.toContain(faction.privateAgenda);
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

function recordedCombat(saved = recordedCombats[0]): GMContext {
  const context = fixture();
  const actor = context.members.find((member) => member.character.name === 'Katooluman')!;
  actor.id = saved.memberId;
  Object.assign(actor.state, structuredClone(saved.after));
  for (const member of context.members) member.active = member.id === actor.id;
  context.startingMembers = structuredClone(context.members);
  Object.assign(
    context.startingMembers.find((member) => member.id === actor.id)!.state,
    structuredClone(saved.before),
  );
  context.scene = ensureLocations(
    {
      ...initialScene(saved.location.name),
      location: structuredClone(saved.location),
      encounter: structuredClone(saved.encounter) as Encounter,
      encounterRisk: { ...saved.encounterRisk, danger: 'dangerous' },
    },
    context.members.map((member) => member.id),
  );
  context.turn.id = saved.turnId;
  context.turn.number = saved.number;
  context.turn.roster = [actor.id];
  context.turn.actions = [{ memberId: actor.id, text: 'I attack Shadow Wight.', passed: false }];
  const combat: CombatReceipt = {
    participantIds: [actor.id],
    events: structuredClone(saved.events) as CombatReceipt['events'],
    logs: saved.events.map((event) => event.fact),
    encounter: context.scene.encounter!,
    characters: [],
    loot: [],
  };
  context.combatResult = combat;
  context.receipts = { combat, combatByLocation: { [saved.location.id]: combat } };
  return context;
}

it('appends a saved story combat cause as its own local scene event', () => {
  const context = fixture();
  const at = 'new:lower-chamber';
  const introduction =
    'The Chamber keeper emerges from the shaft to drive intruders away from the machinery.';
  context.receipts = {
    startCombatByLocation: { [at]: recordedCombat().scene.encounter! },
    combatIntroductionsByLocation: { [at]: introduction },
  };
  const accepted = compileSceneTurn(context, descent(context));
  const event = accepted.events.find((event) => event.fact === introduction)!;
  expect(event).toMatchObject({
    kind: 'world',
    phase: 'aftermath',
    locationRef: at,
    receiptRefs: ['tool:startCombatByLocation'],
  });
  expect(accepted.sceneDraft?.passages).toContainEqual({ eventIds: [event.id], text: introduction });
  expect(
    accepted.actions.find((action) => action.memberId === context.members[0].id)?.components.movement?.status,
  ).toBe('success');
});

it.each(recordedCombats)(
  'compiles recorded combat turn $number without model-authored mechanical references',
  async (saved) => {
    const context = recordedCombat(saved);
    const mechanics = engineEvents(context);
    const before = structuredClone(context);
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      const input = JSON.parse(body.input[0].content);
      expect(input.combatState[locationAlias(context, saved.location.id)]).toMatchObject({ victory: false, enemies: [{ hp: 18 }] });
      expect(input.mechanics.map((event: { at: string }) => event.at)).toEqual(
        mechanics.map((event) => locationAlias(context, event.locationRef!)),
      );
      expect(body.instructions).toContain('kind:"combat"');
      return response({
        version: 3,
        summary: 'The Shadow Wight remains alive in the Outer Ward.',
        beats: [
          {
            kind: 'combat',
            at: saved.location.id,
            text: `Katooluman's cudgel cuts through empty darkness. ${
              saved.number === 27
                ? 'The Shadow Wight also misses, while the fire on Katooluman burns on.'
                : 'The Shadow Wight catches him in reply, leaving him wounded.'
            }`,
          },
        ],
      });
    });
    const accepted = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, tools(context));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(context).toEqual(before);
    expect(accepted.events).toEqual(mechanics);
    expect(accepted.actions[0]).toMatchObject({
      status: 'failure',
      components: { main: { status: 'failure', basis: 'engine', eventIds: ['combat:0'] }, minor: null },
    });
    expect(accepted.actions[0].eventIds).toEqual(['combat:0']);
    expect(accepted.events.filter((event) => event.actionId === null).map((event) => event.id)).toEqual(
      mechanics.slice(1).map((event) => event.id),
    );
    expect(accepted.sceneDraft?.passages).toHaveLength(1);
    expect(accepted.sceneDraft?.passages[0].eventIds).toEqual(mechanics.map((event) => event.id));
  },
);

it('retains a missed combat main action alongside a successful healing minor', () => {
  const context = recordedCombat();
  const receipt = context.combatResult!;
  receipt.events!.splice(1, 0, {
    actorId: context.turn.actions[0].memberId,
    phase: 'minor',
    status: 'success',
    fact: 'Katooluman drinks a healing potion, recovering 4 HP.',
    locationId: context.scene.location.id,
  });
  const accepted = compileSceneTurn(context, {
    version: 3,
    summary: 'The fight continues.',
    beats: [
      {
        kind: 'combat',
        at: 'current',
        text: 'Katooluman misses, then drinks his potion before the wight strikes.',
      },
    ],
  });
  expect(accepted.actions[0]).toMatchObject({
    status: 'partial',
    components: {
      main: { status: 'failure', eventIds: ['combat:0'] },
      minor: { status: 'success', eventIds: ['combat:1'] },
    },
  });
});

it('keeps mechanical combat outcomes immutable and rejects false victory prose', () => {
  const context = recordedCombat();
  const beat = { kind: 'combat', at: 'current', text: 'The Shadow Wight is dead.' };
  expect(() =>
    compileSceneTurn(context, { version: 3, summary: 'The fight continues.', beats: [beat] }),
  ).toThrow(/18\/18 HP/);
  expect(() =>
    compileSceneTurn(context, {
      version: 3,
      summary: 'The fight continues.',
      beats: [
        {
          ...beat,
          text: 'Katooluman misses.',
          eventIds: ['combat:0'],
        },
      ],
    }),
  ).toThrow();
  expect(() =>
    compileSceneTurn(context, {
      version: 3,
      summary: 'The fight continues.',
      beats: [
        {
          kind: 'act',
          actor: context.turn.actions[0].memberId,
          fact: 'Katooluman hits the wight.',
          text: 'Katooluman hits the wight.',
        },
      ],
    }),
  ).toThrow(/combat beat/);
});

it('keeps simultaneous fights separate without requiring enemy-event ownership from the GM', () => {
  const context = recordedCombat();
  const actor = context.members.find((member) => member.id === context.turn.actions[0].memberId)!;
  const companion = context.members.find((member) => member.id !== actor.id)!;
  companion.active = true;
  const at = randomUUID();
  context.scene.places![at] = {
    location: { ...context.scene.location, id: at, name: 'Other alley' },
    encounter: structuredClone(context.scene.encounter),
    loot: [],
    encounterRisk: context.scene.encounterRisk,
  };
  context.scene.memberLocations![companion.id] = at;
  context.scene.worldMap!.nodes[at] = { id: at, name: 'Other alley', visited: true };
  context.turn.actions.push({ memberId: companion.id, text: 'Attack the wight here.', passed: false });
  context.turn.roster.push(companion.id);
  const other = structuredClone(context.combatResult!);
  other.participantIds = [companion.id];
  other.events = other.events!.map((event) => ({
    ...event,
    actorId: event.actorId === actor.id ? companion.id : null,
    locationId: at,
    fact: event.fact.replaceAll(actor.character.name, companion.character.name),
  }));
  (context.receipts!.combatByLocation as Record<string, CombatReceipt>)[at] = other;
  const first = context.combatResult!;
  context.combatResult = {
    ...first,
    participantIds: [actor.id, companion.id],
    events: [...first.events!, ...other.events!],
    encounters: { [context.scene.location.id!]: first.encounter, [at]: other.encounter },
  };
  context.receipts!.combat = context.combatResult;
  const accepted = compileSceneTurn(context, {
    version: 3,
    summary: 'Both fights continue.',
    beats: [
      { kind: 'combat', at: 'current', text: 'Katooluman misses; the Shadow Wight wounds him.' },
      { kind: 'combat', at, text: 'Moryan misses in the other alley; the Shadow Wight strikes back.' },
    ],
  });
  expect(accepted.actions.map((action) => action.eventIds)).toEqual([['combat:0'], ['combat:3']]);
  expect(accepted.sceneDraft?.passages.map((passage) => passage.eventIds)).toEqual([
    ['combat:0', 'combat:1', 'combat:2'],
    ['combat:3', 'combat:4', 'combat:5'],
  ]);
});

it('does not duplicate an engine-resolved combat pass', () => {
  const context = recordedCombat();
  context.turn.actions[0] = { ...context.turn.actions[0], text: '', passed: true };
  context.combatResult!.events![0] = {
    ...context.combatResult!.events![0],
    fact: 'Katooluman holds position.',
    status: null,
  };
  const events = engineEvents(context);
  const accepted = compileSceneTurn(context, {
    version: 3,
    summary: 'The fight continues.',
    beats: [
      {
        kind: 'combat',
        at: 'current',
        text: 'Katooluman holds position, and the wight strikes him.',
      },
    ],
  });
  expect(accepted.events).toEqual(events);
  expect(accepted.actions[0]).toMatchObject({ status: 'passed', components: { main: null, minor: null } });
});

it('allows another character to arrive while preserving the already executed combat', () => {
  const context = recordedCombat();
  const companion = context.members.find((member) => member.id !== context.turn.actions[0].memberId)!;
  const origin = randomUUID();
  companion.active = true;
  context.scene.places![origin] = {
    location: { ...context.scene.location, id: origin, name: 'Side alley' },
    encounter: null,
    loot: [],
    encounterRisk: { danger: 'safe', reason: 'A sheltered empty passage.' },
  };
  context.scene.memberLocations![companion.id] = origin;
  context.scene.worldMap!.nodes[origin] = { id: origin, name: 'Side alley', visited: true };
  context.scene.worldMap!.connections.push({
    from: origin,
    to: context.scene.location.id!,
    label: 'Open passage',
    blocked: false,
    bidirectional: true,
  });
  context.turn.roster.push(companion.id);
  context.turn.actions.push({ memberId: companion.id, text: 'Go to the Outer Ward.', passed: false });
  const mechanics = engineEvents(context);
  const accepted = compileSceneTurn(context, {
    version: 3,
    summary: 'Moryan joins Katooluman in the Outer Ward.',
    beats: [
      { kind: 'combat', at: 'current', text: 'Katooluman misses and the wight wounds him.' },
      {
        kind: 'move',
        actor: companion.id,
        to: context.scene.location.id,
        fact: 'Moryan follows the open passage into the Outer Ward.',
        text: 'Moryan arrives from the side alley as the clash continues.',
      },
    ],
  });
  expect(accepted.events.slice(0, mechanics.length)).toEqual(mechanics);
  expect(accepted.actions.find((action) => action.memberId === companion.id)?.components).toMatchObject({
    main: null,
    movement: { status: 'success', basis: 'routine' },
  });
  expect(accepted.memberLocations).toContainEqual(
    expect.objectContaining({ memberId: companion.id, locationId: context.scene.location.id }),
  );
});

it('records an engine-resolved escape as main movement without executing it again', () => {
  const context = recordedCombat();
  const actor = context.members.find((member) => member.id === context.turn.actions[0].memberId)!;
  const destination = randomUUID();
  actor.state.conditions = ['Escaped'];
  context.scene.places![destination] = {
    location: { ...context.scene.location, id: destination, name: 'Sheltered alley' },
    encounter: null,
    loot: [],
    encounterRisk: { danger: 'safe', reason: 'The alley is sheltered from the fight.' },
  };
  context.scene.worldMap!.nodes[destination] = { id: destination, name: 'Sheltered alley', visited: true };
  context.scene.worldMap!.connections.push({
    from: context.scene.location.id!,
    to: destination,
    label: 'Open passage',
    blocked: false,
    bidirectional: true,
  });
  context.turn.actions[0].text = 'Escape into the sheltered alley.';
  context.combatResult!.encounter.escaped = true;
  context.combatResult!.events = [
    {
      actorId: actor.id,
      phase: 'main',
      status: 'success',
      locationId: context.scene.location.id,
      fact: 'Katooluman escapes the fight.',
    },
  ];
  const accepted = compileSceneTurn(context, {
    version: 3,
    summary: 'Katooluman reaches the sheltered alley.',
    beats: [
      { kind: 'combat', at: 'current', text: 'Katooluman slips away from the Shadow Wight.' },
      {
        kind: 'move',
        actor: actor.id,
        to: destination,
        checked: true,
        fact: 'Katooluman reaches the sheltered alley through the open passage.',
        text: 'He reaches the sheltered alley.',
      },
    ],
  });
  expect(accepted.actions[0].components).toMatchObject({ main: { status: 'success', basis: 'engine' } });
  expect(accepted.actions[0].components.movement).toBeUndefined();
  expect(accepted.memberLocations).toContainEqual(
    expect.objectContaining({ memberId: actor.id, locationId: destination }),
  );
});

it('compiles the recorded stair descent without model-generated evidence or repairs', async () => {
  const context = fixture();
  const fetcher = vi.fn(async () => response(descent(context)));
  const gm = new ChatGPTGM(auth, 'owner', 'test', fetcher);
  const value = await gm.adjudicate(context, tools(context));
  const actor = context.members.find((member) => member.character.name === 'Moryan')!;
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(value.actions.find((action) => action.memberId === actor.id)?.components.movement).toMatchObject({
    status: 'success',
    basis: 'routine',
  });
  expect(value.memberLocations).toContainEqual(
    expect.objectContaining({ memberId: actor.id, locationId: 'new:lower-chamber' }),
  );
  expect(value.arrivals).toHaveLength(1);
  expect(value.mapUpdates?.connections).toContainEqual(
    expect.objectContaining({ to: 'new:lower-chamber', blocked: false }),
  );
  expect(value.encounterRisks).toContainEqual(
    expect.objectContaining({ locationId: 'new:lower-chamber', danger: 'dangerous' }),
  );
  expect(value.npcUpdates).toContainEqual(expect.objectContaining({ npcId: 'iven' }));
});

it('preserves ordinary arrival when a destination investigation fails', () => {
  const context = fixture();
  const proposal = descent(context);
  const move = proposal.beats[0];
  if (move.kind !== 'move') throw new Error('fixture');
  context.turn.actions.find((action) => action.memberId === move.actor)!.text =
    'Go downstairs and inspect the pulse source.';
  context.turn.rolls.push({
    id: 'saved-check',
    memberId: move.actor,
    stat: 'WIS',
    dc: 10,
    mode: 'normal',
    dice: [2],
    modifier: 0,
    total: 2,
    success: false,
    reason: 'The machinery is obscured by the shaft.',
    lethal: false,
    source: 'test',
  });
  proposal.beats.splice(1, 0, {
    kind: 'act',
    actor: move.actor,
    slot: 'main',
    intent: 'search',
    fact: 'Moryan cannot identify the machinery through the shaft.',
    text: 'The shaft conceals the source, but an exposed maintenance lever is within reach.',
    finding: {
      source: 'lower-chamber:machinery',
      fact: 'An exposed maintenance lever beside the shaft can stop the moving floor panels.',
    },
  });
  const value = compileSceneTurn(context, proposal);
  expect(value.actions.find((action) => action.memberId === move.actor)).toMatchObject({
    status: 'partial',
    components: { movement: { status: 'success' }, main: { status: 'failure', basis: 'check' } },
  });
  expect(value.memberLocations?.find((position) => position.memberId === move.actor)?.locationId).toBe(
    'new:lower-chamber',
  );
  expect(value.events[0].phase).toBe('movement');
  expect(context.turn.rolls[0].dice).toEqual([2]);
});

it.each([true, false])(
  'repairs the recorded wreck arrival/search together in one correction, preserving success=%s',
  async (success) => {
    const context = wreckContext();
    const receipts = context.receipts!;
    const check = context.turn.rolls[0];
    if (!success) {
      Object.assign(check, { success: false, dice: [2, 9], total: 3 });
      delete receipts.loot;
      receipts.executionEvents = (receipts.executionEvents as { id: string }[]).filter(
        (event) => event.id !== 'loot',
      );
    }
    const before = structuredClone({ turn: context.turn, receipts: context.receipts, scene: context.scene });
    context.requestBudget = { used: 0, limit: 2 };
    const corrected = correctedWreck(success);
    const gameTools = tools(context);
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const wire = JSON.parse(init!.body as string);
      const input = JSON.parse(wire.input[0].content);
      expect(input.savedLoot?.item.id).toBe(success ? wreckSearch.receipts.loot.item.id : undefined);
      expect(wire.instructions).toContain('need TWO operations');
      expect(wire.instructions).toContain('deadEnd:string');
      if (fetcher.mock.calls.length === 1) return response(wreckSearch.response);
      const feedback = wire.input.filter((item: { role?: string }) => item.role === 'user').at(-1).content;
      expect(feedback).toContain('Lobsterano (actor:2) is missing its main act');
      expect(feedback).toContain(`saved WIS check (${success ? 'success' : 'failure'}`);
      expect(feedback).toContain('Wreck Interior (place:7)');
      expect(feedback).toContain('place.deadEnd');
      expect(feedback).toContain('changing fact/text alone');
      return response(corrected);
    });
    const value = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, gameTools);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(gameTools).not.toHaveBeenCalled();
    expect(gameTools.offerLoot).not.toHaveBeenCalled();
    expect(value.actions.find((action) => action.memberId === check.memberId)).toMatchObject({
      status: success ? 'success' : 'partial',
      components: {
        main: { basis: 'check', status: success ? 'success' : 'failure', receiptRefs: [`roll:${check.id}`] },
        movement: { basis: 'routine', status: 'success', receiptRefs: [] },
      },
    });
    expect(value.memberLocations).toContainEqual(
      expect.objectContaining({ memberId: check.memberId, locationId: wreckSearch.receipts.loot.locationId }),
    );
    expect(value.pickups).toEqual([]);
    expect({ turn: context.turn, receipts: context.receipts, scene: context.scene }).toEqual(before);
  },
);

it('restarts the recorded failed wreck checkpoint and publishes one tool case with the original check', async () => {
  const db = openDatabase(':memory:');
  try {
    const context = wreckContext();
    const fetcher = vi.fn(async () =>
      response(fetcher.mock.calls.length === 1 ? wreckSearch.response : correctedWreck()),
    );
    const gm = new ChatGPTGM(auth, 'owner', 'test', fetcher);
    const provider: GameMaster = {
      sceneTurns: true,
      adjudicate: gm.adjudicate.bind(gm),
      narrate: new PracticeGM().narrate,
    };
    const draw = vi.fn((sides: number) => sides);
    let game = new Game(db, () => provider, draw);
    const host = game.identify();
    const campaign = game.create(host.id, context.config);
    for (const member of context.members) {
      const player = game.identify();
      const character = game.saveCharacter(player.id, member.character);
      game.join(campaign.inviteCode!, player.id, character.id);
      db.prepare('UPDATE members SET id=?,state=? WHERE campaign_id=? AND player_id=?').run(
        member.id, JSON.stringify(member.state), campaign.id, player.id,
      );
    }
    context.members = game.members(campaign.id);
    context.startingMembers = structuredClone(context.members);
    const draft = {
      context, members: context.members, startingMembers: context.startingMembers,
      scene: context.scene, gmMemory: context.gmMemory, receipts: context.receipts, pipelineVersion: 1,
    };
    db.prepare("UPDATE campaigns SET status='active',scene=? WHERE id=?").run(
      JSON.stringify(context.scene), campaign.id,
    );
    db.prepare('INSERT INTO turns(id,campaign_id,number,phase,roster,draft) VALUES(?,?,?,?,?,?)').run(
      context.turn.id, campaign.id, 7, 'failed', JSON.stringify(context.turn.roster), JSON.stringify(draft),
    );
    for (const action of context.turn.actions)
      db.prepare('INSERT INTO actions(turn_id,member_id,text,passed) VALUES(?,?,?,0)').run(
        context.turn.id, action.memberId, action.text,
      );
    const check = context.turn.rolls[0];
    db.prepare('INSERT INTO rolls VALUES(?,?,?,?,?)').run(
      check.id, context.turn.id, check.memberId, '{}', JSON.stringify(check),
    );
    game = new Game(db, () => provider, draw);
    game.retry(campaign.id, host.id);
    await game.idle();
    const snapshot = game.snapshot(campaign.id, host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(snapshot.turn?.number).toBe(8);
    expect(snapshot.history.at(-1)?.rolls.filter((roll) => !roll.notation)).toEqual([check]);
    expect(draw.mock.calls.filter(([sides]) => sides === 20)).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const place = memberScene(snapshot.scene, check.memberId);
    expect(place.location.id).toBe(wreckSearch.receipts.loot.locationId);
    expect(place.loot.filter((item) => item.name === wreckSearch.receipts.loot.item.name)).toEqual([
      expect.objectContaining({ id: wreckSearch.receipts.loot.item.id }),
    ]);
    expect(snapshot.members.flatMap((member) => member.state.inventory).some(
      (item) => item.id === wreckSearch.receipts.loot.item.id,
    )).toBe(false);
  } finally {
    db.close();
  }
});

it('rejects teleportation, blocked routes and actions for passing players', () => {
  const context = fixture();
  const value = descent(context);
  const move = value.beats[0];
  if (move.kind !== 'move') throw new Error('fixture');
  const origin = memberScene(context.scene, move.actor).location.id!;
  const edge = context.scene.worldMap!.connections.find(
    (edge) => edge.from === origin || edge.to === origin,
  )!;
  move.to = edge.from === origin ? edge.to : edge.from;
  edge.blocked = true;
  expect(() => compileSceneTurn(context, value)).toThrow(/route/);
  move.to = 'new:lower-chamber';
  context.turn.actions.find((action) => action.memberId === move.actor)!.passed = true;
  expect(() => compileSceneTurn(context, value)).toThrow(/nonpassing/);
});

it('keeps processing errors retryable instead of returning fictional blockers', async () => {
  const context = fixture();
  context.requestBudget = { used: 0, limit: 3 };
  const fetcher = vi.fn(async () => response({ version: 3, beats: [], summary: 'Incomplete' }));
  await expect(
    new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, tools(context)),
  ).rejects.toThrow(/request limit/);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('retains rejected scenes and correction instructions across tools and successive repairs', async () => {
  const context = fixture();
  const complete = descent(context);
  const move = complete.beats[0];
  if (move.kind !== 'move') throw new Error('fixture');
  context.turn.actions.find((action) => action.memberId === move.actor)!.text =
    'Go downstairs and inspect the pulse source.';
  const saved = {
    id: 'saved-check',
    memberId: move.actor,
    stat: 'WIS' as const,
    dc: 10 as const,
    mode: 'normal' as const,
    dice: [2],
    modifier: 0,
    total: 2,
    success: false,
    reason: 'The machinery is obscured by the shaft.',
    lethal: false,
    source: 'test',
  };
  context.turn.rolls.push(saved);
  complete.beats.splice(1, 0, {
    kind: 'act',
    actor: move.actor,
    slot: 'main',
    intent: 'search',
    fact: 'Moryan cannot identify the machinery through the shaft.',
    text: 'The shaft conceals the source, but an exposed maintenance lever is within reach.',
    finding: { source: 'lower-chamber:machinery', fact: 'An exposed maintenance lever is within reach.' },
  });
  const missingFinding = structuredClone(complete);
  const search = missingFinding.beats[1];
  if (search.kind !== 'act') throw new Error('fixture');
  delete search.finding;
  const missingPlace = structuredClone(complete);
  const arrival = missingPlace.beats[0];
  if (arrival.kind !== 'move') throw new Error('fixture');
  delete arrival.place;
  const gameTools = tools(context);
  vi.mocked(gameTools).mockReturnValue(saved);
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const call = fetcher.mock.calls.length;
    const input = JSON.parse(init!.body as string).input.slice(1);
    const scenes = input.flatMap((item: { content?: { type: string; text: string }[] }) =>
      Array.isArray(item.content)
        ? item.content.filter((part) => part.type === 'output_text').map((part) => JSON.parse(part.text))
        : [],
    );
    const feedback = input
      .filter((item: { role?: string }) => item.role === 'user')
      .map((item: { content: string }) => item.content)
      .join(' ');
    if (call > 1) {
      expect(scenes).toContainEqual(missingFinding);
      expect(feedback).toContain('An investigation needs');
    }
    for (let previous = 2; previous < Math.min(call, 4); previous++) {
      expect(input).toContainEqual(
        expect.objectContaining({ type: 'function_call', call_id: `saved-${previous}` }),
      );
      expect(input).toContainEqual(
        expect.objectContaining({
          type: 'function_call_output',
          call_id: `saved-${previous}`,
          output: JSON.stringify({ ...saved, memberId: actorAlias(context, saved.memberId) }),
        }),
      );
    }
    if (call === 1) return response(missingFinding);
    if (call === 2 || call === 3)
      return new Response(
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [
              {
                type: 'function_call',
                namespace: 'game',
                name: 'roll_check',
                call_id: `saved-${call}`,
                arguments: JSON.stringify({
                  memberId: move.actor,
                  stat: saved.stat,
                  dc: saved.dc,
                  mode: saved.mode,
                  reason: saved.reason,
                }),
              },
            ],
          },
        })}\n\n`,
      );
    if (call === 4) return response(missingPlace);
    expect(scenes).toContainEqual(missingPlace);
    expect(feedback).toContain('move.place');
    return response(complete);
  });
  const accepted = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, gameTools);
  expect(fetcher).toHaveBeenCalledTimes(5);
  expect(gameTools).toHaveBeenCalledTimes(2);
  expect(context.turn.rolls).toEqual([saved]);
  expect(accepted.actions.find((action) => action.memberId === move.actor)?.components).toMatchObject({
    movement: { status: 'success' },
    main: { status: 'failure', basis: 'check' },
  });
  expect(accepted.memberLocations).toContainEqual(
    expect.objectContaining({ memberId: move.actor, locationId: move.to }),
  );
});

it('preserves a prepared cause and supplies due activities without exposing notes in prose', async () => {
  const context = fixture();
  const at = memberScene(context.scene, context.members[0].id).location.id!;
  context.gmMemory = [
    {
      id: 'pulses',
      locationId: at,
      cause: 'PRIVATE: a worn governor drives a buried engine.',
      discoveries: ['The governor can be disengaged.'],
      actors: 'A keeper wants the engine running.',
      nextChange: 'The keeper returns to service it.',
      dueTurn: 6,
      status: 'open',
    },
  ];
  expect(() =>
    updateGMMemory(context.gmMemory!, [{ ...context.gmMemory![0], cause: 'A different mystery.' }]),
  ).toThrow(/cause/);
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const input = JSON.parse(JSON.parse(init!.body as string).input[0].content);
    expect(input.dueActivities).toEqual(context.gmMemory!.map((note) => ({
      ...note, locationId: locationAlias(context, note.locationId),
    })));
    return response(descent(context));
  });
  const accepted = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(context, tools(context));
  expect(JSON.stringify(accepted.sceneDraft)).not.toContain('PRIVATE');
  expect(gmMemorySchema.parse(context.gmMemory)).toHaveLength(1);
});

it('publishes one creative response and persists private preparation atomically in the game', async () => {
  const db = openDatabase(':memory:');
  const practice = new PracticeGM();
  let current: GMContext;
  const fetcher = vi.fn(async () => {
    const actor = current.members[0];
    return response({
      version: 3,
      summary: 'The keeper answers.',
      notes: [
        {
          id: 'engine',
          locationId: current.scene.location.id!,
          cause: 'PRIVATE governor failure.',
          discoveries: ['An accessible lever disengages it.'],
          actors: 'The keeper repairs it.',
          nextChange: 'The keeper inspects the governor.',
          dueTurn: current.turn.number + 1,
          status: 'open',
        },
      ],
      beats: [
        {
          kind: 'meet',
          actor: actor.id,
          person: { npcId: 'workshop-keeper', name: 'The keeper' },
          fact: 'The keeper explains the accessible lever.',
          text: '“That lever disengages the governor,” the keeper says.',
        },
      ],
    });
  });
  const gm = new ChatGPTGM(auth, 'owner', 'test', fetcher);
  const narrate = vi.fn(practice.narrate.bind(practice));
  const provider: GameMaster = {
    sceneTurns: true,
    adjudicate: async (context, gameTools) => {
      if (!context.turn.number) return practice.adjudicate(context, gameTools);
      current = context;
      return gm.adjudicate(context, gameTools);
    },
    narrate,
  };
  const game = new Game(
    db,
    () => provider,
    () => 4,
  );
  try {
    const host = game.identify();
    const campaign = game.create(host.id, fixture().config);
    const character = game.saveCharacter(host.id, templateCharacter('Moryan'));
    game.join(campaign.inviteCode!, host.id, character.id);
    const member = game.members(campaign.id)[0];
    game.manageCharacter(campaign.id, host.id, {
      type: 'starter',
      itemIds: member.state.starterEquipment.slice(0, 2).map((item) => item.id),
    });
    game.start(campaign.id, host.id);
    await game.idle();
    const state = ensureLocations(initialScene('Workshop'), [member.id]);
    state.encounterRisk = { danger: 'safe', reason: 'The keeper controls the disconnected workshop.' };
    db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(state), campaign.id);
    narrate.mockClear();
    game.submit(
      campaign.id,
      host.id,
      game.pending(campaign.id)!.id,
      'Ask the keeper about the engine.',
      false,
    );
    await game.idle();
    const snapshot = game.snapshot(campaign.id, host.id);
    expect(snapshot.history.at(-1)?.result?.narration).toContain('That lever disengages');
    expect(snapshot.turn?.phase).toBe('collecting');
    expect(snapshot.scene.npcs?.['workshop-keeper']).toMatchObject({
      name: 'The keeper', locationId: memberScene(snapshot.scene, member.id).location.id,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(narrate).not.toHaveBeenCalled();
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
    expect(JSON.parse(game.campaign(campaign.id).gm_memory)[0].cause).toBe('PRIVATE governor failure.');
    expect(game.export(campaign.id, host.id).gmMemory[0].cause).toBe('PRIVATE governor failure.');
  } finally {
    db.close();
  }
});

async function table(build: (context: GMContext, call: number) => unknown, saved = {
  scene: tower.scene as Scene, members: tower.members, journal: tower.journal,
}) {
  const db = openDatabase(':memory:');
  const practice = new PracticeGM();
  let current: GMContext;
  const fetcher = vi.fn(async (_url?: unknown, _init?: RequestInit) => {
    const built = build(current, fetcher.mock.calls.length);
    return built instanceof Response ? built : response(built);
  });
  const gm = new ChatGPTGM(auth, 'owner', 'test', fetcher);
  const narrate = vi.fn(practice.narrate.bind(practice));
  const provider: GameMaster = {
    sceneTurns: true,
    adjudicate: async (context, tools) => {
      if (!context.turn.number) return practice.adjudicate(context, tools);
      current = context;
      return gm.adjudicate(context, tools);
    },
    narrate,
  };
  const draw = vi.fn((sides: number) => Math.min(4, sides));
  const game = new Game(db, () => provider, draw);
  const host = game.identify();
  const campaign = game.create(host.id, fixture().config);
  const players = saved.members.map(() => game.identify());
  for (const [index, player] of players.entries()) {
    const character = game.saveCharacter(player.id, templateCharacter(saved.members[index].name));
    game.join(campaign.inviteCode!, player.id, character.id);
    const member = game.members(campaign.id).find((member) => member.playerId === player.id)!;
    game.manageCharacter(campaign.id, player.id, {
      type: 'starter',
      itemIds: member.state.starterEquipment.slice(0, 2).map((item) => item.id),
    });
  }
  game.start(campaign.id, host.id);
  await game.idle();
  const members = game.members(campaign.id);
  const mapping = new Map(
    saved.members.map((entry) => [
      entry.id,
      members.find((member) => member.character.name === entry.name)!.id,
    ]),
  );
  const scene = JSON.parse(
    JSON.stringify(saved.scene, (_key, value) =>
      typeof value === 'string' ? (mapping.get(value) ?? value) : value,
    ),
  );
  scene.memberLocations = Object.fromEntries(
    Object.entries(saved.scene.memberLocations!).map(([id, at]) => [mapping.get(id), at]),
  );
  db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(scene), campaign.id);
  db.prepare('UPDATE turns SET number=6 WHERE id=?').run(game.pending(campaign.id)!.id);
  for (const entry of saved.journal)
    db.prepare(
      'INSERT INTO journal(campaign_id,kind,name,detail) VALUES(?,?,?,?) ON CONFLICT(campaign_id,kind,name) DO UPDATE SET detail=excluded.detail',
    ).run(campaign.id, entry.kind, entry.name, entry.detail);
  narrate.mockClear();
  draw.mockClear();
  const submit = (actions?: Record<string, string>) => {
    const turn = game.pending(campaign.id)!;
    for (const player of players) {
      const member = members.find((member) => member.playerId === player.id)!;
      const text =
        actions?.[member.character.name] ??
        saved.members.find((entry) => entry.name === member.character.name)!.action;
      game.submit(campaign.id, player.id, turn.id, text, !text.trim());
    }
    return turn.id;
  };
  return { db, game, host, campaign, players, members, fetcher, narrate, draw, provider, submit };
}

function investigate(context: GMContext, check = true): Investigation {
  const actor = context.members.find((member) => member.character.name === 'Moryan')!;
  const at = memberScene(context.scene, actor.id).location.id!;
  return {
    memberId: actor.id,
    source: {
      kind: 'feature',
      id: 'new:registration-notice',
      name: 'Registration notice',
      description: 'A posted registration notice bears a faded list of residents.',
      locationId: at,
    },
    question: 'What names are on the registration notice?',
    preparation: context.gmMemory?.some((note) => note.id === 'registration')
      ? { id: 'registration' }
      : {
          id: 'registration',
          locationId: at,
          cause: 'PRIVATE: The collector forged the registration.',
          discoveries: ['The notice names Sella Venn and Iven Marr.'],
          actors: 'The collector hides the original ledger.',
          nextChange: 'The clerk checks the posted copy.',
          dueTurn: 8,
          status: 'open',
        },
    answer: 0,
    success: {
      text: 'The faded names resolve clearly: Sella Venn and Iven Marr. The clerk’s counter in this ward holds the original ledger.',
      lead: { fact: 'The clerk’s counter in this ward holds the original ledger.', locationId: at },
    },
    failure: {
      fact: 'The faded names resist deciphering, but the clerk’s seal is clear.',
      text: 'The ink runs together. The clerk’s seal remains legible. The clerk’s counter in this ward has an intact original ledger.',
      lead: { fact: 'The clerk’s counter in this ward has an intact original ledger.', locationId: at },
    },
    check: check
      ? {
          stat: 'INT',
          dc: 10,
          mode: 'normal',
          circumstances: { favorable: false, adverse: false },
          reason: 'Moryan deciphers the faded registration notice.',
          lethal: false,
          abilityName: null,
          assistsMemberId: null,
          assistedBy: [],
        }
      : null,
  };
}
function toolResponse(name: string, args: unknown) {
  return new Response(
    `data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        status: 'completed',
        output: [
          {
            type: 'function_call',
            namespace: 'game',
            name,
            call_id: randomUUID(),
            arguments: JSON.stringify(args),
          },
        ],
      },
    })}\n\n`,
  );
}

it.each([false, true])(
  'handles available information and repeat requested abilities without unnecessary dice or charges (ability=%s)',
  async (ability) => {
    const f = await table((context, call) => {
      const request = investigate(context, ability);
      if (ability) request.check!.abilityName = 'Keen observation';
      return call % 2 === 1
        ? toolResponse('investigate', request)
        : {
            version: 3,
            summary: 'The names are known.',
            beats: [{ kind: 'investigate', actor: request.memberId }],
          };
    });
    try {
      f.draw.mockImplementation((sides) => (sides === 20 ? 14 : sides === 100 ? 100 : Math.min(4, sides)));
      const text = ability
        ? 'Use Keen observation to read the registration notice.'
        : 'Read the legible registration notice.';
      f.submit({ Moryan: text, Katooluman: '' });
      await f.game.idle();
      let snapshot = f.game.snapshot(f.campaign.id, f.host.id);
      expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
      const actor = snapshot.members.find((member) => member.character.name === 'Moryan')!;
      expect(snapshot.history.at(-1)?.rolls.filter((roll) => !roll.notation)).toHaveLength(ability ? 1 : 0);
      expect(snapshot.history.at(-1)?.result?.xp).toBe(10);
      expect(
        snapshot.scene.worldProgression?.places[memberScene(snapshot.scene, actor.id).location.id!]
          ?.stalledTurns,
      ).toBe(0);
      expect(Object.values(actor.state.abilityUses ?? {}).reduce((sum, uses) => sum + uses, 0)).toBe(
        ability ? 1 : 0,
      );
      f.draw.mockClear();
      f.submit({ Moryan: text, Katooluman: '' });
      await f.game.idle();
      snapshot = f.game.snapshot(f.campaign.id, f.host.id);
      expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
      expect(snapshot.history.at(-1)?.rolls.filter((roll) => !roll.notation)).toHaveLength(0);
      expect(snapshot.members.find((member) => member.id === actor.id)?.state.abilityUses).toEqual(
        actor.state.abilityUses,
      );
      expect(snapshot.history.at(-1)?.result?.xp).toBe(0);
      expect(f.draw.mock.calls.filter(([sides]) => sides === 20 || sides === 100)).toHaveLength(0);
    } finally {
      f.db.close();
    }
  },
);

it('remembers earlier failed questions when another question is investigated at the same source', async () => {
  let attempt = 0;
  const f = await table((context, call) => {
    const request = investigate(context);
    if (call % 2 === 1) {
      attempt++;
      if (attempt === 2) {
        request.preparation = {
          id: 'registration',
          discoveries: [
            'The notice names Sella Venn and Iven Marr.',
            'The clerk signed the registration notice.',
          ],
        };
        request.answer = 1;
        request.question = 'Who signed the registration notice?';
      }
      return toolResponse('investigate', request);
    }
    return {
      version: 3,
      summary: 'The faded notice resists reading.',
      beats: [{ kind: 'investigate', actor: request.memberId }],
    };
  });
  try {
    f.draw.mockImplementation((sides) => (sides === 20 ? 1 : Math.min(4, sides)));
    for (const [index, text] of [
      'Decipher the names on the registration notice.',
      'Decipher who signed the registration notice.',
      'Try reading the names on the registration notice again.',
    ].entries()) {
      f.submit({ Moryan: text, Katooluman: '' });
      await f.game.idle();
      const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
      expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
      expect(snapshot.history.at(-1)?.rolls.filter((roll) => !roll.notation)).toHaveLength(
        index === 2 ? 0 : 1,
      );
      expect(snapshot.history.at(-1)?.result?.xp).toBe(0);
    }
  } finally {
    f.db.close();
  }
});

it('keeps a newly explored place’s failed investigation after temporary references become saved IDs', async () => {
  const f = await table((context, call) => {
    const request = investigate(context);
    const first = context.turn.number === 6;
    const move = descent(context).beats[0];
    if (move.kind !== 'move') throw new Error('Expected the recorded descent.');
    const at = first ? move.to : memberScene(context.scene, request.memberId).location.id!;
    request.source = { kind: 'place', id: at, locationId: at, name: move.place!.name };
    if (first) request.preparation.locationId = at;
    request.success.lead.locationId = at;
    request.failure.lead.locationId = at;
    if (call % 2 === 1) return toolResponse('investigate', request);
    return {
      version: 3,
      summary: 'Moryan examines the lower chamber.',
      beats: [...(first ? [move] : []), { kind: 'investigate', actor: request.memberId }],
    };
  });
  try {
    f.draw.mockImplementation((sides) => (sides === 20 ? 1 : Math.min(4, sides)));
    for (let index = 0; index < 2; index++) {
      f.submit({
        Moryan: index
          ? 'Search this chamber again for the registered names.'
          : 'Descend the stair and search the chamber for the registered names.',
        Katooluman: '',
      });
      await f.game.idle();
      const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
      expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
      const actor = snapshot.members.find((member) => member.character.name === 'Moryan')!;
      const place = memberScene(snapshot.scene, actor.id);
      expect(place.searches?.[place.location.id!]?.investigation?.success).toBe(false);
      expect(snapshot.history.at(-1)?.rolls.filter((roll) => !roll.notation)).toHaveLength(index ? 0 : 1);
      expect(snapshot.history.at(-1)?.result?.xp).toBe(0);
    }
  } finally {
    f.db.close();
  }
});

it.each([true, false])(
  'commits prepared findings before dice and reuses unchanged evidence (success=%s)',
  async (success) => {
    let actorId = '';
    const f = await table((context, call) => {
      actorId = context.members.find((member) => member.character.name === 'Moryan')!.id;
      if (call % 2 === 1) return toolResponse('investigate', investigate(context));
      // Even an inconsistent post-roll description cannot discard the chosen finding.
      return {
        version: 3,
        summary: 'Nothing can be read.',
        rewards: { xp: 40, reason: 'Read the notice again.' },
        beats: [
          {
            kind: 'act',
            actor: actorId,
            fact: 'The names cannot be read.',
            text: 'Nothing is learned.',
            intent: 'search',
            finding: { source: 'new:registration-notice', fact: 'No usable names.' },
          },
        ],
      };
    });
    try {
      f.draw.mockImplementation((sides) => {
        if (sides === 20) {
          const draft = JSON.parse(f.game.pending(f.campaign.id)!.draft!);
          expect(draft.gmMemory[0].discoveries[0]).toBe('The notice names Sella Venn and Iven Marr.');
          expect(draft.receipts[`investigation-plan:${actorId}`].request.failure.fact).toContain('clerk');
          return success ? 14 : 1;
        }
        return sides === 100 ? 100 : Math.min(4, sides);
      });
      f.submit({ Moryan: 'Decipher the names on the registration notice.', Katooluman: '' });
      await f.game.idle();
      let snapshot = f.game.snapshot(f.campaign.id, f.host.id);
      expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
      const result = snapshot.history.at(-1)!.result!;
      expect(result.narration).not.toContain('Nothing is learned');
      expect(result.narration).not.toContain('No usable names');
      expect(result.narration).toContain(success ? 'Sella Venn and Iven Marr' : 'clerk’s seal');
      expect(result.narration).toContain('original ledger');
      if (!success) expect(result.narration).not.toContain('Sella Venn');
      expect(result.xp).toBe(success ? 10 : 0);
      expect(snapshot.history.at(-1)?.rolls.filter((roll) => !roll.notation)).toHaveLength(1);
      expect(snapshot.scene.features?.['new:registration-notice']?.name).toBe('Registration notice');
      const known = JSON.parse(f.game.campaign(f.campaign.id).gm_memory)[0];
      expect(known.revealed ?? []).toEqual(success ? [0] : []);
      expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
      const wire = JSON.parse(String(f.fetcher.mock.calls[1][1]?.body));
      const output = wire.input.find((item: { type: string }) => item.type === 'function_call_output');
      expect(output.output).not.toContain('PRIVATE');
      expect(output.output).not.toContain(success ? 'resist deciphering' : 'Sella Venn');
      expect(wire.tools[0].tools.some((tool: { name: string }) => tool.name === 'investigate')).toBe(true);
      const before = snapshot.members.find((member) => member.id === actorId)!.state.xp;
      f.draw.mockClear();
      f.submit({ Moryan: 'Read those resident names on the registration notice again.', Katooluman: '' });
      await f.game.idle();
      snapshot = f.game.snapshot(f.campaign.id, f.host.id);
      expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
      expect(snapshot.history.at(-1)?.rolls.filter((roll) => !roll.notation)).toHaveLength(0);
      expect(f.draw.mock.calls.filter(([sides]) => sides === 20 || sides === 100)).toHaveLength(0);
      expect(snapshot.history.at(-1)?.result?.xp).toBe(0);
      expect(snapshot.members.find((member) => member.id === actorId)!.state.xp).toBe(before);
      expect(snapshot.history.at(-1)?.result?.narration).toContain('original ledger');
      expect(f.narrate).not.toHaveBeenCalled();
      if (!success) {
        const scene = structuredClone(snapshot.scene);
        scene.features!['new:registration-notice'].properties.dried = true;
        f.db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(scene), f.campaign.id);
        f.draw.mockImplementation((sides) => (sides === 20 ? 14 : sides === 100 ? 100 : Math.min(4, sides)));
        f.submit({ Moryan: 'Decipher the registration notice after its ink has dried.', Katooluman: '' });
        await f.game.idle();
        snapshot = f.game.snapshot(f.campaign.id, f.host.id);
        expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
        expect(snapshot.history.at(-1)?.rolls.filter((roll) => !roll.notation)).toHaveLength(1);
        expect(snapshot.history.at(-1)?.result?.narration).toContain('Sella Venn and Iven Marr');
        expect(snapshot.history.at(-1)?.result?.xp).toBe(10);
      }
    } finally {
      f.db.close();
    }
  },
);

it('restarts a prepared investigation after publication interruption without rerolling or revealing private branches', async () => {
  const f = await table((context, call) =>
    call === 1
      ? toolResponse('investigate', investigate(context))
      : {
          version: 3,
          summary: 'The registration names are clear.',
          beats: [{ kind: 'investigate', actor: investigate(context).memberId }],
        },
  );
  try {
    f.draw.mockImplementation((sides) => (sides === 20 ? 14 : sides === 100 ? 100 : Math.min(4, sides)));
    f.db.exec(
      "CREATE TRIGGER interrupt_investigation BEFORE UPDATE OF gm_memory ON campaigns BEGIN SELECT RAISE(ABORT, 'publication interrupted'); END;",
    );
    f.submit({ Moryan: 'Decipher the registration notice.', Katooluman: '' });
    await f.game.idle();
    expect(f.game.snapshot(f.campaign.id, f.host.id).turn?.phase).toBe('failed');
    expect(JSON.parse(f.game.campaign(f.campaign.id).gm_memory)).toEqual([]);
    expect(JSON.stringify(f.game.snapshot(f.campaign.id, f.host.id))).not.toContain('PRIVATE');
    f.db.exec('DROP TRIGGER interrupt_investigation');
    const restarted = new Game(f.db, () => f.provider, f.draw);
    const calls = f.draw.mock.calls.length;
    restarted.retry(f.campaign.id, f.host.id);
    await restarted.idle();
    const snapshot = restarted.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(snapshot.history.at(-1)?.result?.narration).toContain('Sella Venn and Iven Marr');
    expect(snapshot.history.at(-1)?.result?.xp).toBe(10);
    expect(JSON.parse(restarted.campaign(f.campaign.id).gm_memory)[0].revealed).toEqual([0]);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.draw).toHaveBeenCalledTimes(calls);
  } finally {
    f.db.close();
  }
});

it('rejects inaccessible leads before rolling and locks both outcome branches on a retry', async () => {
  let invalid: Investigation;
  let original: InvestigationResult;
  let calls = 0;
  const f = await table((context) => {
    const request = investigate(context);
    if (++calls === 1) {
      invalid = structuredClone(request);
      invalid.success.lead.locationId = 'unreachable-vault';
      return toolResponse('investigate', invalid);
    }
    if (calls === 2) {
      expect(f.draw.mock.calls.filter(([sides]) => sides === 20)).toHaveLength(0);
      return toolResponse('investigate', request);
    }
    const saved = context.receipts![`investigation:${request.memberId}`] as InvestigationResult;
    if (calls === 3) {
      original = saved;
      request.preparation = {
        id: 'registration',
        discoveries: ['A replacement invented after seeing the dice.'],
      };
      request.failure.fact = 'The original failure was replaced.';
      request.success.text = 'The original success was replaced.';
      return toolResponse('investigate', request);
    }
    expect(saved).toEqual(original!);
    return {
      version: 3,
      summary: 'The notice is resolved.',
      beats: [{ kind: 'investigate', actor: request.memberId }],
    };
  });
  try {
    f.draw.mockImplementation((sides) => (sides === 20 ? 14 : sides === 100 ? 100 : Math.min(4, sides)));
    f.submit({ Moryan: 'Decipher the registration notice.', Katooluman: '' });
    await f.game.idle();
    const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(snapshot.history.at(-1)?.rolls.filter((roll) => !roll.notation)).toHaveLength(1);
    expect(snapshot.history.at(-1)?.result?.narration).not.toContain('replaced');
    expect(JSON.parse(f.game.campaign(f.campaign.id).gm_memory)[0].discoveries).toEqual([
      'The notice names Sella Venn and Iven Marr.',
    ]);
    expect(f.fetcher).toHaveBeenCalledTimes(4);
  } finally {
    f.db.close();
  }
});

it.each(['destination', 'origin'])(
  'binds a prepared finding to its actual %s before/after ordinary travel',
  async (location) => {
    const f = await table((context, call) => {
      const request = investigate(context);
      const response = descent(context);
      const move = response.beats[0];
      if (move.kind !== 'move') throw new Error('Expected the recorded move.');
      if (location === 'destination') {
        request.source.locationId = move.to;
        request.preparation.locationId = move.to;
        request.success.lead.locationId = move.to;
        request.failure.lead.locationId = move.to;
      }
      if (call === 1) return toolResponse('investigate', request);
      return {
        version: 3,
        summary: 'Moryan reads the notice and travels.',
        beats:
          location === 'origin'
            ? [{ kind: 'investigate', actor: request.memberId }, move]
            : [move, { kind: 'investigate', actor: request.memberId }],
      };
    });
    try {
      f.draw.mockImplementation((sides) => (sides === 20 ? 14 : sides === 100 ? 100 : Math.min(4, sides)));
      const actor = f.members.find((member) => member.character.name === 'Moryan')!;
      const origin = memberScene(JSON.parse(f.game.campaign(f.campaign.id).scene!), actor.id).location.id!;
      f.submit({
        Moryan:
          location === 'origin'
            ? 'Read the registration notice here, then descend the iron stair.'
            : 'Descend the iron stair and decipher its registration notice.',
        Katooluman: '',
      });
      await f.game.idle();
      const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
      expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
      const at = memberScene(snapshot.scene, actor.id);
      expect(at.location.name).toBe('Bell Tower Lower Chamber');
      const sourceAt = location === 'origin' ? origin : at.location.id!;
      const place =
        sourceAt === snapshot.scene.location.id ? snapshot.scene : snapshot.scene.places![sourceAt];
      expect(place.searches?.['new:registration-notice']?.information).toContain('Sella Venn');
      expect(snapshot.scene.features?.['new:registration-notice']?.locationId).toBe(sourceAt);
      expect(f.fetcher).toHaveBeenCalledTimes(2);
    } finally {
      f.db.close();
    }
  },
);

it('keeps prepared answers immutable while allowing new discoveries to be appended', () => {
  const context = fixture();
  const note = investigate(context).preparation;
  const memory = gmMemorySchema.parse([note]);
  expect(() => updateGMMemory(memory, [{ ...memory[0], discoveries: ['A different answer.'] }])).toThrow(
    'cannot be rewritten',
  );
  const extended = updateGMMemory(memory, [
    {
      ...memory[0],
      discoveries: [...memory[0].discoveries, 'The original is signed by the clerk.'],
      revealed: [0],
    },
  ]);
  expect(extended[0].discoveries).toHaveLength(2);
  expect(updateGMMemory(extended, [{ ...extended[0], revealed: [] }])[0].revealed).toEqual([0]);
});

it('keeps registration and household notices distinct, including remote ownership and aliases', () => {
  const context = fixture();
  const actor = context.members[0];
  const at = memberScene(context.scene, actor.id).location.id!;
  const remote = context.members.find((member) => member.id !== actor.id)!;
  const other = Object.keys(context.scene.worldMap!.nodes).find((id) => id !== at)!;
  context.scene.memberLocations![remote.id] = other;
  remote.state.inventory = [
    {
      ...baseItem(randomUUID(), 'Household notice', 'tool'),
      quantity: 1,
      description: 'A list of one household.',
    },
  ];
  context.scene.features = {
    registration: {
      id: 'registration',
      name: 'Ward registration notice',
      aliases: ['registration notice'],
      locationId: at,
      properties: {},
      fact: 'A posted public registration notice.',
    },
  };
  context.turn.actions[0].text = 'Find the registration notice.';
  expect(() =>
    bindInvestigationSource(context, actor.id, {
      kind: 'item',
      id: remote.state.inventory[0].id,
      locationId: at,
    }),
  ).toThrow('another location');
  expect(() =>
    bindInvestigationSource(context, actor.id, {
      kind: 'item',
      id: remote.state.inventory[0].id,
      locationId: other,
    }),
  ).toThrow(/submitted target|adjacent/);
  expect(() =>
    bindInvestigationSource(context, actor.id, {
      kind: 'feature',
      id: 'new:copy',
      name: 'Registration notice',
      description: 'Another copy.',
      locationId: at,
    }),
  ).toThrow('already exists');
  expect(
    bindInvestigationSource(context, actor.id, { kind: 'feature', id: 'registration', locationId: at }).source
      .id,
  ).toBe('registration');
});

it.each([false, true])(
  'saves an introduced person and a collected story object atomically (full backpack=%s)',
  async (full) => {
    const f = await table((context) => ({
      version: 3,
      summary: 'Sella meets the party while Moryan takes a plank.',
      beats: context.turn.actions.map((action) =>
        context.members.find((member) => member.id === action.memberId)!.character.name === 'Moryan'
          ? {
              kind: 'take',
              actor: action.memberId,
              item: {
                source: 'loose-plank',
                name: 'Loose plank',
                description: 'A plain wooden plank from beside the wall.',
              },
              fact: 'Moryan takes the loose plank.',
              text: 'Moryan slips the loose plank into his backpack.',
            }
          : {
              kind: 'meet',
              actor: action.memberId,
              person: { npcId: 'sella-venn', name: 'Sella Venn' },
              fact: 'Sella Venn introduces herself as the ward’s clerk.',
              text: '“Sella Venn, ward clerk,” the woman says.',
            },
      ),
    }));
    try {
      const member = f.members.find((member) => member.character.name === 'Moryan')!;
      const initial: Scene = JSON.parse(f.game.campaign(f.campaign.id).scene!);
      initial.features = {
        ...initial.features,
        'loose-plank': {
          id: 'loose-plank',
          name: 'Loose plank',
          aliases: [],
          locationId: memberScene(initial, member.id).location.id!,
          properties: {},
          fact: 'A loose plank lies beside the wall.',
        },
      };
      f.db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(initial), f.campaign.id);
      if (full) {
        member.state.inventory = Array.from({ length: 8 }, (_, index) => ({
          ...baseItem(randomUUID(), `Ballast ${index}`, 'tool'),
          quantity: 1,
        }));
        f.db.prepare('UPDATE members SET state=? WHERE id=?').run(JSON.stringify(member.state), member.id);
      }
      f.submit({ Moryan: 'Take the loose plank.', Katooluman: 'Ask the ward clerk her name.' });
      await f.game.idle();
      const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
      expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
      const actor = snapshot.members.find((saved) => saved.id === member.id)!;
      const carried = actor.state.inventory.find((item) => item.name === 'Loose plank');
      const ground = memberScene(snapshot.scene, member.id).loot.find((item) => item.name === 'Loose plank');
      expect(!!carried).toBe(!full);
      expect(!!ground).toBe(full);
      expect((carried ?? ground)?.kind).toBe('tool');
      expect(snapshot.scene.features?.['loose-plank']).toBeUndefined();
      expect(memberScene(snapshot.scene, member.id).searchedLoot?.['loose-plank']).toBe('Loose plank');
      expect(snapshot.scene.npcs?.['sella-venn']?.name).toBe('Sella Venn');
      expect(
        snapshot.journal.find((entry) => entry.kind === 'npc' && entry.name === 'Sella Venn')?.detail,
      ).toContain('clerk');
      if (full) expect(snapshot.history.at(-1)?.result?.narration).not.toContain('slips the loose plank');
      expect(f.narrate).not.toHaveBeenCalled();
    } finally {
      f.db.close();
    }
  },
);

it.each(['ongoing', 'victory', 'interrupted'])(
  'publishes %s combat from one scene response without a writer or critic',
  async (mode) => {
    const f = await table((context) => {
      expect(context.sceneProtocol).toBe(true);
      expect(context.combatResult?.events?.length).toBeGreaterThan(0);
      const victory = context.scene.encounter!.victory;
      const beats: unknown[] = [
        {
          kind: 'combat',
          at: 'current',
          text: victory
            ? 'Katooluman strikes the Shadow Wight, killing it. Ash settles around the fallen creature.'
            : 'Katooluman and Moryan strike into empty shadow. The Shadow Wight sweeps back at them, but its attack also misses.',
        },
      ];
      if (victory)
        beats.push({
          kind: 'world',
          at: 'current',
          fact: 'The Shadow Wight lies dead in the Outer Ward. Unstable debris remains along the street.',
          text: 'The clash falls quiet. Loose masonry still crowds the street beneath the dead lamps.',
          place: {
            name: context.scene.location.name,
            atmosphere: 'The wight lies still beneath the dead lamps.',
            hazard: 'Loose masonry remains unstable.',
            danger: 'dangerous',
            riskReason: 'Loose masonry can still collapse.',
          },
        });
      return {
        version: 3,
        beats,
        summary: victory ? 'The Shadow Wight is dead.' : 'The Shadow Wight remains alive.',
      };
    });
    try {
      const state = recordedCombat().scene;
      state.memberLocations = Object.fromEntries(f.members.map((member) => [member.id, state.location.id!]));
      const katooluman = f.members.find((member) => member.character.name === 'Katooluman')!;
      const moryan = f.members.find((member) => member.character.name === 'Moryan')!;
      state.encounter!.initiative = [
        { id: katooluman.id, total: 20 },
        { id: moryan.id, total: 19 },
        { id: state.encounter!.enemies[0].id, total: 1 },
      ];
      if (mode === 'victory') state.encounter!.enemies[0].hp = 1;
      f.db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(state), f.campaign.id);
      f.provider.planCombat = vi.fn(async (context) => normalizeCombatInput(context));
      f.draw.mockImplementation((sides) => Math.min(mode === 'victory' ? 20 : 4, sides));
      if (mode === 'interrupted')
        f.db.exec(
          "CREATE TRIGGER interrupt_scene_publication BEFORE UPDATE OF gm_memory ON campaigns BEGIN SELECT RAISE(ABORT, 'publication interrupted'); END;",
        );
      const turnId = f.game.pending(f.campaign.id)!.id;
      for (const member of f.members)
        f.game.submit(f.campaign.id, member.playerId, turnId, 'I attack Shadow Wight.', false);
      await f.game.idle();
      if (mode === 'interrupted') {
        expect(f.game.pending(f.campaign.id)?.phase).toBe('failed');
        const before = JSON.parse(f.game.pending(f.campaign.id)!.draft!);
        expect(before.adjudication.sceneDraft).toBeDefined();
        const rolls = f.db.prepare('SELECT * FROM rolls WHERE turn_id=? ORDER BY rowid').all(turnId);
        const draws = f.draw.mock.calls.length;
        f.db.exec('DROP TRIGGER interrupt_scene_publication');
        const restarted = new Game(f.db, () => f.provider, f.draw);
        restarted.retry(f.campaign.id, f.host.id);
        await restarted.idle();
        expect(f.draw).toHaveBeenCalledTimes(draws);
        expect(f.db.prepare('SELECT * FROM rolls WHERE turn_id=? ORDER BY rowid').all(turnId)).toEqual(rolls);
        const after = JSON.parse(
          (f.db.prepare('SELECT draft FROM turns WHERE id=?').get(turnId) as { draft: string }).draft,
        );
        expect(after.receipts.combat).toEqual(before.receipts.combat);
      }
      const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
      expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
      expect(snapshot.history.at(-1)?.id).toBe(turnId);
      expect(snapshot.history.at(-1)?.result?.narration).toContain('Katooluman');
      expect(snapshot.scene.encounter?.victory).toBe(mode === 'victory');
      expect(snapshot.scene.encounter?.round).toBe(state.encounter!.round + 1);
      expect(f.fetcher).toHaveBeenCalledTimes(1);
      expect(f.provider.planCombat).toHaveBeenCalledTimes(1);
      expect(f.narrate).not.toHaveBeenCalled();
      const stages = f.db
        .prepare("SELECT payload FROM events WHERE turn_id=? AND kind='stage:adjudication'")
        .all(turnId) as { payload: string }[];
      expect(stages.flatMap((row) => JSON.parse(row.payload).corrections ?? [])).toEqual([]);
      if (mode === 'victory') {
        expect(snapshot.scene.location.atmosphere).toContain('wight lies still');
        expect(snapshot.members.every((member) => member.state.xp > 0)).toBe(true);
      }
    } finally {
      f.db.close();
    }
  },
);

it('replays the recorded two-player tower turn through finalization and publication in an isolated database', async () => {
  const f = await table((context) => descent(context));
  try {
    const id = f.submit();
    await f.game.idle();
    const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(snapshot.history.at(-1)?.id).toBe(id);
    const moryan = snapshot.members.find((member) => member.character.name === 'Moryan')!;
    const at = memberScene(snapshot.scene, moryan.id).location;
    expect(at.name).toBe('Bell Tower Lower Chamber');
    expect(snapshot.scene.worldMap?.nodes[at.id!].visited).toBe(true);
    expect(snapshot.history.at(-1)?.result?.narration).toContain('Moryan takes the iron stairs down');
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.narrate).not.toHaveBeenCalled();
    const stages = f.db
      .prepare("SELECT payload FROM events WHERE turn_id=? AND kind LIKE 'stage:%'")
      .all(id) as { payload: string }[];
    expect(stages.flatMap((row) => JSON.parse(row.payload).corrections ?? [])).toEqual([]);
  } finally {
    f.db.close();
  }
});

it('rolls back private memory on a publication failure and resumes it without another model call', async () => {
  const f = await table((context) => {
    const response = descent(context);
    response.notes = [
      {
        id: 'buried-engine',
        locationId: 'new:lower-chamber',
        cause: 'PRIVATE mechanical governor.',
        discoveries: ['The shaft contains its governor.'],
        actors: 'The keeper services it.',
        nextChange: 'The keeper arrives for maintenance.',
        dueTurn: 7,
        status: 'open',
      },
    ];
    return response;
  });
  try {
    f.db.exec(
      "CREATE TRIGGER reject_private_save BEFORE UPDATE OF gm_memory ON campaigns BEGIN SELECT RAISE(ABORT, 'simulated publication interruption'); END;",
    );
    f.submit();
    await f.game.idle();
    expect(f.game.snapshot(f.campaign.id, f.host.id).turn?.phase).toBe('failed');
    expect(JSON.parse(f.game.campaign(f.campaign.id).gm_memory)).toEqual([]);
    expect(JSON.stringify(f.game.snapshot(f.campaign.id, f.host.id))).not.toContain('PRIVATE');
    f.db.exec('DROP TRIGGER reject_private_save');
    const restarted = new Game(f.db, () => f.provider, f.draw);
    restarted.retry(f.campaign.id, f.host.id);
    await restarted.idle();
    expect(restarted.snapshot(f.campaign.id, f.host.id).turn?.phase).toBe('collecting');
    const note = JSON.parse(restarted.campaign(f.campaign.id).gm_memory)[0];
    expect(note.cause).toBe('PRIVATE mechanical governor.');
    expect(note.locationId).not.toMatch(/^new:/);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.narrate).not.toHaveBeenCalled();
  } finally {
    f.db.close();
  }
});

it('accepts a due local world development while the players pass', () => {
  const context = fixture();
  for (const action of context.turn.actions) {
    action.passed = true;
    action.text = '';
  }
  const at = memberScene(context.scene, context.members[0].id).location.id!;
  const note = {
    id: 'keeper',
    locationId: at,
    cause: 'A keeper services the engine.',
    discoveries: ['The keeper knows the fault.'],
    actors: 'The keeper arrives for work.',
    nextChange: 'The keeper arrives.',
    dueTurn: 6,
    status: 'open' as const,
  };
  context.gmMemory = [note];
  const accepted = compileSceneTurn(context, {
    version: 3,
    summary: 'The keeper arrives.',
    beats: [
      {
        kind: 'world',
        at,
        fact: 'The keeper arrives carrying tools to inspect the engine.',
        text: 'A keeper arrives with tools and kneels beside the engine.',
        npcs: [{ npcId: 'keeper', name: 'The keeper' }],
      },
    ],
    notes: [{ id: note.id, nextChange: 'The keeper begins inspection.', dueTurn: 7 }],
  });
  expect(accepted.actions.every((action) => action.status === 'passed')).toBe(true);
  expect(accepted.npcUpdates).toContainEqual(expect.objectContaining({ npcId: 'keeper', locationId: at }));
  expect(accepted.gmNotes?.[0].dueTurn).toBe(7);
  expect(accepted.gmNotes?.[0].cause).toBe(note.cause);
});

it('consolidates a shared NPC conversation without duplicate state records', () => {
  const context = fixture();
  const at = context.scene.memberLocations![context.members[0].id];
  for (const member of context.members) context.scene.memberLocations![member.id] = at;
  const accepted = compileSceneTurn(context, {
    version: 3,
    summary: 'Iven answers both travellers.',
    beats: context.members.map((member, index) => ({
      kind: 'act',
      actor: member.id,
      fact: index ? 'Iven offers to identify the collector.' : 'Iven explains the household marks.',
      text: index
        ? '“I can identify the collector,” Iven says.'
        : 'Iven explains how the household marks work.',
      npcs: [{ npcId: 'iven', name: 'Iven' }],
    })),
  });
  expect(accepted.npcUpdates).toHaveLength(1);
  expect(accepted.events.filter((event) => event.npcIds?.includes('iven'))).toHaveLength(2);
});

it('retains a source investigation before ordinary departure in the submitted order', () => {
  const context = fixture();
  const value = descent(context);
  const move = value.beats[0];
  if (move.kind !== 'move') throw new Error('fixture');
  const origin = memberScene(context.scene, move.actor).location.id!;
  context.turn.actions.find((action) => action.memberId === move.actor)!.text =
    'Inspect the threshold, then go downstairs.';
  value.beats.unshift({
    kind: 'act',
    actor: move.actor,
    slot: 'main',
    intent: 'search',
    fact: 'Moryan identifies the threshold’s loose cover.',
    text: 'Moryan finds a loose maintenance cover in the threshold before descending.',
    finding: {
      source: 'tower:threshold-cover',
      fact: 'The threshold has a loose maintenance cover that can be lifted.',
    },
  });
  const accepted = compileSceneTurn(context, value);
  const actor = accepted.actions.find((action) => action.memberId === move.actor)!;
  expect(actor.search?.locationId).toBe(origin);
  expect(actor.components.movement?.status).toBe('success');
  expect(accepted.events.findIndex((event) => event.id === actor.search?.informationEventId)).toBeLessThan(
    accepted.events.findIndex((event) => event.id === actor.components.movement?.eventIds[0]),
  );
});

it('corrects a rejected inventory operation in prose locally without a critic or fictional success', () => {
  const context = fixture();
  const actor = context.members[0];
  const at = memberScene(context.scene, actor.id);
  // This action observes an item; the proposed pickup exceeds the player's consent.
  context.turn.actions[0].text = 'Look at the stone.';
  context.scene.loot = [{ ...baseItem('stone', 'Small stone', 'tool'), quantity: 1 }];
  const value = descent(context);
  value.beats[0] = {
    kind: 'act',
    actor: actor.id,
    slot: 'main',
    intent: 'action',
    fact: 'Moryan pockets the stone.',
    text: 'Moryan pockets the stone.',
    pickup: { itemId: 'stone' },
  };
  const accepted = compileSceneTurn(context, value);
  expect(accepted.actions.find((action) => action.memberId === actor.id)?.status).toBe('blocked');
  expect(accepted.sceneDraft?.passages[0].text).toContain('did not request collection');
  expect(accepted.sceneDraft?.summary).not.toContain('pockets');
  expect(at.location.id).toBe(context.scene.location.id);
});

it('persists newly visible onward destinations at a split-party arrival without generating their contents', async () => {
  const f = await table((context) => {
    const scene = descent(context);
    const move = scene.beats[0];
    if (move.kind !== 'move') throw new Error('Expected travel.');
    move.fact +=
      ' Beyond the chamber, an eastward service passage reaches the pump room; a sealed hatch leads north to the reservoir.';
    move.text +=
      ' An eastward service passage leads to the pump room. A sealed northern hatch bears the reservoir sign.';
    move.exits = [
      {
        to: 'new:pump-room',
        name: 'Pump room',
        label: 'East service passage',
        blocked: false,
        bidirectional: true,
      },
      {
        to: 'new:reservoir',
        name: 'Reservoir',
        label: 'North sealed hatch',
        blocked: true,
        bidirectional: true,
      },
    ];
    return scene;
  });
  try {
    f.submit();
    await f.game.idle();
    const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    const actor = snapshot.members.find((member) => member.character.name === 'Moryan')!;
    const arrived = memberScene(snapshot.scene, actor.id).location.id!;
    const pump = Object.values(snapshot.scene.worldMap!.nodes).find((node) => node.name === 'Pump room')!;
    const reservoir = Object.values(snapshot.scene.worldMap!.nodes).find(
      (node) => node.name === 'Reservoir',
    )!;
    expect(arrived).not.toBe(snapshot.scene.location.id);
    for (const node of [pump, reservoir]) {
      expect(node.visited).toBe(false);
      expect(snapshot.scene.places?.[node.id]).toBeUndefined();
    }
    expect(snapshot.scene.worldMap!.connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: arrived, to: pump.id, blocked: false }),
        expect.objectContaining({ from: arrived, to: reservoir.id, blocked: true }),
      ]),
    );
    expect(snapshot.history.at(-1)?.result?.narration).toContain('eastward service passage');
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  } finally {
    f.db.close();
  }
});

it('introduces a saved random encounter after arrival without rewriting the scene or calling a narrator', async () => {
  const introduction =
    'The Chamber keeper steps out from behind the shaft and bars the stair with a spear: the vibrations have awakened its defence of the machinery.';
  const f = await table((context, call) => {
    if (call === 1) return descent(context);
    const output = [
      {
        type: 'function_call',
        namespace: 'game',
        name: 'start_combat',
        call_id: 'keeper-start',
        arguments: JSON.stringify({
          locationId: 'new:lower-chamber',
          introduction,
          enemies: [
            {
              id: 'keeper',
              name: 'Chamber keeper',
              tier: 'minor',
              hp: 8,
              defense: 8,
              attack: 0,
              damage: '1d4',
              description: 'A guardian approaches from behind the shaft.',
              tactic: 'Guard the shaft.',
              equipmentBlueprints: [],
            },
          ],
        }),
      },
    ];
    return new Response(
      `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })}\n\n`,
    );
  });
  try {
    f.draw.mockImplementation((sides) => (sides === 6 ? 1 : Math.min(4, sides)));
    const turnId = f.submit();
    await f.game.idle();
    const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(snapshot.history.at(-1)?.result?.narration).toContain('Moryan takes the iron stairs down');
    expect(snapshot.history.at(-1)?.result?.narration).toContain('Chamber keeper');
    expect(snapshot.history.at(-1)?.result?.narration).toContain(introduction);
    expect(snapshot.history.at(-1)?.result?.summary).toContain('Chamber keeper');
    const draft = JSON.parse(
      (f.db.prepare('SELECT draft FROM turns WHERE id = ?').get(turnId) as { draft: string }).draft,
    );
    expect(draft.receipts.combatIntroductionsByLocation['new:lower-chamber']).toBe(introduction);
    const actor = snapshot.members.find((member) => member.character.name === 'Moryan')!;
    expect(memberScene(snapshot.scene, actor.id).encounter?.round).toBe(1);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.narrate).not.toHaveBeenCalled();
  } finally {
    f.db.close();
  }
});

it('requires a world currency name, then preserves it in later generated scenes', async () => {
  const context = fixture();
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string);
    expect(body.instructions).toContain("fitting this world's lore");
    return response({ ...descent(context), currencyName: fetcher.mock.calls.length === 1 ? '' : 'night marks' });
  });
  const gm = new ChatGPTGM(auth, 'owner', 'test', fetcher);
  const accepted = await gm.adjudicate(context, tools(context));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(accepted.currencyName).toBe('night marks');

  context.scene.currencyName = accepted.currencyName;
  const later = vi.fn(async (_url: unknown, init?: RequestInit) => {
    expect(JSON.parse(init!.body as string).instructions).toContain('Currency: "night marks"');
    return response({ ...descent(context), currencyName: 'unrelated credits' });
  });
  const preserved = await new ChatGPTGM(auth, 'owner', 'test', later).adjudicate(context, tools(context));
  expect(preserved.currencyName).toBe('night marks');
});

it('persists the generated currency name in the campaign and finalized turn across restart', async () => {
  const f = await table((context) => ({ ...descent(context), currencyName: 'night marks' }));
  try {
    f.submit();
    await f.game.idle();
    const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(snapshot.scene.currencyName).toBe('night marks');
    expect(snapshot.history.at(-1)?.resolution?.currencyName).toBe('night marks');
    const restarted = new Game(f.db, () => f.provider, f.draw);
    expect(restarted.snapshot(f.campaign.id, f.host.id).scene.currencyName).toBe('night marks');
  } finally {
    f.db.close();
  }
});
