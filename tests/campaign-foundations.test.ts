import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { Game, type GMContext, type GameMaster } from '../server/game';
import { openDatabase } from '../server/db';
import { PracticeGM } from '../server/providers';
import { compileSceneTurn, type SceneTurn } from '../server/scene-turn';
import { submittedActionObligations } from '../server/action-intent';
import { advanceWorldProgression, worldProgressionContext } from '../server/world-progression';
import { baseItem, initialScene, initialState } from '../shared/rules';
import { ensureLocations, memberScene, knownLocations } from '../shared/locations';
import { templateCharacter } from '../shared/schema';
import { prepareGMNotes, updateGMMemory } from '../shared/gm-memory';

function context(): GMContext {
  const id = randomUUID(),
    character = templateCharacter('Traveller');
  const members = [
    {
      id,
      character,
      characterId: randomUUID(),
      playerId: randomUUID(),
      playerName: 'Traveller',
      active: true,
      state: initialState(character, id),
    },
  ];
  const scene = ensureLocations(initialScene('Meadow'), [id]);
  scene.currencyName = 'seed tokens';
  scene.encounterRisk = { danger: 'safe', reason: 'An empty peaceful meadow.' };
  return {
    sceneProtocol: true,
    members,
    startingMembers: structuredClone(members),
    scene,
    receipts: {},
    gmMemory: [],
    journal: [],
    history: [],
    config: {
      ruleset: 'roguelike-v1',
      name: 'Fresh world',
      setting: 'Wilderness',
      premise: 'Reach the observatory.',
      tone: 'Quiet',
      language: 'English',
      instructions: '',
      custom: [],
      provider: 'practice',
      model: '',
    },
    turn: {
      id: randomUUID(),
      number: 1,
      phase: 'resolving',
      roster: [id],
      actions: [{ memberId: id, text: 'Follow the caravan onward.', passed: false }],
      rolls: [],
      result: null,
      error: null,
    },
  };
}

function crossing(ctx: GMContext, name = 'Hill', remainingStages = 2): SceneTurn {
  const actor = ctx.members[0].id;
  return {
    version: 3,
    summary: `The traveller reaches ${name}.`,
    notes: ctx.gmMemory?.some((note) => note.id === 'observatory-trip')
      ? []
      : [
          {
            id: 'observatory-trip',
            locationId: 'current',
            cause: 'The caravan carries lenses to the observatory.',
            discoveries: ['The observatory is the delivery destination.'],
            actors: 'The caravan driver.',
            nextChange: 'The caravan reaches its next stop.',
            dueTurn: null,
            status: 'open',
            journey: {
              memberId: actor,
              destination: 'Observatory',
              completion: 'Arrive at the Observatory.',
              remainingStages,
            },
          },
        ],
    beats: [
      {
        kind: 'move',
        actor,
        journeyId: 'observatory-trip',
        to: `new:${name.toLowerCase().replaceAll(' ', '-')}`,
        fact: `The traveller follows the caravan to ${name}.`,
        text: `The traveller arrives at ${name}.`,
        place: {
          name,
          atmosphere: 'A quiet accessible plateau.',
          hazard: '',
          danger: 'safe',
          riskReason: 'A maintained road and quiet surroundings.',
        },
        exits: [
          {
            to: 'new:onward',
            name: name === 'Observatory' ? 'Gardens' : 'Observatory',
            label: 'Onward path',
            blocked: false,
            bidirectional: true,
          },
        ],
      },
    ],
  };
}

function saveCrossing(ctx: GMContext, proposal: SceneTurn) {
  const accepted = compileSceneTurn(ctx, proposal);
  const position = accepted.memberLocations![0];
  const place = accepted.placeUpdates!.find((place) => place.ref === position.locationId)!;
  ctx.scene.places![position.locationId] = {
    location: { ...place.location, id: position.locationId },
    encounter: null,
    loot: [],
    encounterRisk: { danger: 'safe', reason: 'Quiet surroundings.' },
  };
  ctx.scene.memberLocations![ctx.members[0].id] = position.locationId;
  ctx.gmMemory = updateGMMemory(ctx.gmMemory ?? [], accepted.gmNotes ?? []);
  ctx.turn.id = randomUUID();
  ctx.turn.number++;
  return accepted;
}

it('counts an accepted journey across places and completes it without another equivalent road segment', () => {
  const ctx = context();
  saveCrossing(ctx, crossing(ctx));
  expect(ctx.gmMemory![0].journey?.remainingStages).toBe(1);
  const before = structuredClone(ctx.gmMemory);
  expect(() => compileSceneTurn(ctx, crossing(ctx, 'Another hill'))).toThrow('must now reach Observatory');
  expect(ctx.gmMemory).toEqual(before);
  saveCrossing(ctx, crossing(ctx, 'Observatory'));
  expect(ctx.gmMemory![0]).toMatchObject({
    status: 'resolved',
    journey: { remainingStages: 0, destination: 'Observatory' },
  });
});

it('does not let note patches reset stages, silently close the journey, or replace its destination', () => {
  const ctx = context();
  saveCrossing(ctx, crossing(ctx));
  for (const patch of [
    { ...ctx.gmMemory![0], journey: { ...ctx.gmMemory![0].journey!, remainingStages: 20 } },
    { ...ctx.gmMemory![0], status: 'resolved' as const },
    { ...ctx.gmMemory![0], journey: { ...ctx.gmMemory![0].journey!, destination: 'A different city' } },
  ]) {
    const proposal = crossing(ctx, 'Observatory');
    proposal.notes = [patch];
    expect(() => compileSceneTurn(ctx, proposal)).toThrow(/engine-owned|accepted journey/);
  }
  const replacement = crossing(context(), 'Another hill');
  replacement.notes[0].id = 'replacement';
  replacement.notes[0].journey!.memberId = ctx.members[0].id;
  const move = replacement.beats[0];
  if (move.kind !== 'move') throw new Error('fixture');
  move.actor = ctx.members[0].id;
  move.journeyId = 'replacement';
  expect(() => compileSceneTurn(ctx, replacement)).toThrow('Reuse the actor’s open journey');
});

it('keeps waiting, failed crossings and unrelated exploration from spending journey stages', () => {
  const ctx = context();
  saveCrossing(ctx, crossing(ctx));
  const memory = structuredClone(ctx.gmMemory);
  ctx.turn.actions[0].text = 'Walk to the nearby grove.';
  const detour = crossing(ctx, 'Grove');
  const move = detour.beats[0];
  if (move.kind !== 'move') throw new Error('fixture');
  delete move.journeyId;
  expect(compileSceneTurn(ctx, detour).gmNotes).toEqual([]);
  ctx.turn.actions[0].text = 'Cross the ravine toward the observatory.';
  ctx.turn.rolls = [
    {
      id: randomUUID(),
      memberId: ctx.members[0].id,
      stat: 'DEX',
      dc: 15,
      mode: 'normal',
      dice: [2],
      modifier: 0,
      total: 2,
      success: false,
      reason: 'Cross the unstable ravine.',
      lethal: false,
      source: 'test',
    },
  ];
  const failed: SceneTurn = {
    version: 3,
    notes: [],
    summary: 'The crossing fails.',
    beats: [
      {
        kind: 'move',
        actor: ctx.members[0].id,
        to: 'new:ravine',
        journeyId: 'observatory-trip',
        checked: true,
        fact: 'The traveller cannot cross the ravine.',
        text: 'The traveller retreats from the unstable edge.',
      },
    ],
  };
  // A failed traversal targets an existing adjacent place, without inventing an arrival.
  const target = ctx.scene.location.id!;
  ctx.scene.worldMap!.connections.push({
    from: ctx.scene.memberLocations![ctx.members[0].id],
    to: target,
    label: 'Ravine crossing',
    blocked: false,
    bidirectional: true,
  });
  (failed.beats[0] as Extract<SceneTurn['beats'][number], { kind: 'move' }>).to = target;
  expect(compileSceneTurn(ctx, failed).gmNotes).toEqual([]);
  expect(ctx.gmMemory).toEqual(memory);
});

it('requires a changed physical circumstance for a journey extension and refuses recycled excuses', () => {
  const ctx = context();
  const at = ctx.scene.location.id!;
  const far = randomUUID();
  ctx.scene.worldMap!.nodes[far] = { id: far, name: 'Far bank', visited: false };
  ctx.scene.worldMap!.connections.push({
    from: at,
    to: far,
    label: 'Bridge crossing',
    blocked: false,
    bidirectional: true,
  });
  ctx.scene.features = {
    bridge: {
      id: 'bridge',
      name: 'Bridge',
      aliases: [],
      locationId: at,
      properties: { intact: true },
      route: { from: at, to: far },
      fact: 'The bridge is intact.',
    },
  };
  const proposal = crossing(ctx, 'Detour', 1);
  const move = proposal.beats[0];
  if (move.kind !== 'move') throw new Error('fixture');
  move.journeyDelay = { reason: 'The bridge collapses across the direct road.', extraStages: 1 };
  expect(() => compileSceneTurn(ctx, proposal)).toThrow('new witnessed local change');
  proposal.beats.unshift({
    kind: 'world',
    at,
    fact: move.journeyDelay.reason,
    text: 'The bridge gives way, closing the direct road.',
    features: [{ featureId: 'bridge', name: 'Bridge', properties: { intact: false }, passable: false }],
  });
  const accepted = compileSceneTurn(ctx, proposal);
  expect(accepted.gmNotes![0].journey).toMatchObject({
    remainingStages: 1,
    delays: [move.journeyDelay.reason],
  });
  ctx.gmMemory = accepted.gmNotes;
  const repeated = structuredClone(proposal);
  repeated.notes = [];
  expect(() => compileSceneTurn(ctx, repeated)).toThrow('Repeated scenery');
});

it('protects journey counters through investigation preparation and supports explicit abandonment', () => {
  const ctx = context();
  saveCrossing(ctx, crossing(ctx));
  const saved = ctx.gmMemory![0];
  expect(() =>
    prepareGMNotes(ctx.gmMemory!, [{ id: saved.id, journey: { ...saved.journey!, remainingStages: 12 } }]),
  ).toThrow('engine-owned');
  const proposal: SceneTurn = {
    version: 3,
    notes: [],
    summary: 'The traveller leaves the caravan.',
    beats: [
      {
        kind: 'act',
        actor: ctx.members[0].id,
        endJourney: saved.id,
        slot: 'main',
        intent: 'action',
        fact: 'The traveller stops following the caravan.',
        text: 'The traveller leaves the caravan to pursue another interest.',
      },
    ],
  };
  ctx.turn.actions[0].text = 'Wait here.';
  expect(() => compileSceneTurn(ctx, proposal)).toThrow('explicit submitted abandonment');
  ctx.turn.actions[0].text = 'I stop following the caravan.';
  expect(compileSceneTurn(ctx, proposal).gmNotes![0]).toMatchObject({
    status: 'resolved',
    journey: { cancelled: true, remainingStages: 1 },
  });
  ctx.turn.actions[0].text = 'I do not stop following the caravan.';
  expect(() => compileSceneTurn(ctx, proposal)).toThrow('explicit submitted abandonment');
});

it('requires separate outcomes for two targets, preserving a concrete turn-limit deferral', () => {
  const ctx = context(),
    actor = ctx.members[0].id;
  ctx.turn.actions[0].text = 'Inspect the desk and search the wardrobe.';
  const obligations = submittedActionObligations(ctx, actor);
  expect(obligations).toHaveLength(2);
  const fact =
    'The desk bears a wet ink stain. Searching the locked wardrobe will take the next main action.';
  const proposal: SceneTurn = {
    version: 3,
    notes: [],
    summary: fact,
    beats: [{ kind: 'act', actor, slot: 'main', intent: 'action', fact, text: fact }],
  };
  expect(() => compileSceneTurn(ctx, proposal)).toThrow('One unrelated result');
  const act = proposal.beats[0];
  if (act.kind !== 'act') throw new Error('fixture');
  act.resolves = [
    { id: obligations[0].id, outcome: 'resolved', fact: 'The desk bears a wet ink stain.' },
    {
      id: obligations[1].id,
      outcome: 'deferred',
      fact: 'Searching the locked wardrobe will take the next main action.',
    },
  ];
  const accepted = compileSceneTurn(ctx, proposal);
  expect(accepted.actions[0].components.main?.status).toBe('partial');
  expect(accepted.actionOutcomes?.map((outcome) => [outcome.request, outcome.outcome])).toEqual([
    ['Inspect the desk', 'resolved'],
    ['search the wardrobe', 'deferred'],
  ]);
  act.resolves[1].id = obligations[0].id;
  expect(() => compileSceneTurn(ctx, proposal)).toThrow('invalid or duplicate');
  act.resolves[1] = { id: obligations[1].id, outcome: 'resolved', fact: act.resolves[0].fact };
  expect(() => compileSceneTurn(ctx, proposal)).toThrow('own specific outcome');
});

it('reconciles an intent outcome with the real inventory refusal', () => {
  const ctx = context(),
    actor = ctx.members[0];
  actor.state.inventory = Array.from({ length: 8 }, (_, index) => ({
    ...baseItem(randomUUID(), `Ballast ${index}`, 'tool'),
    quantity: 1,
  }));
  ctx.startingMembers = structuredClone(ctx.members);
  ctx.turn.actions[0].text = 'Take the reed.';
  const obligation = submittedActionObligations(ctx, actor.id)[0];
  const fact = 'Traveller takes the reed.';
  const accepted = compileSceneTurn(ctx, {
    version: 3,
    notes: [],
    summary: fact,
    beats: [
      {
        kind: 'take',
        actor: actor.id,
        item: { source: 'reed', name: 'Reed', description: 'An ordinary loose reed.' },
        fact,
        text: fact,
        resolves: [{ id: obligation.id, outcome: 'resolved', fact }],
      },
    ],
  });
  expect(accepted.actionOutcomes![0].outcome).toBe('blocked');
  expect(accepted.actionOutcomes![0].fact).toBe(
    accepted.events.find((event) => event.id === accepted.actionOutcomes![0].eventId)!.fact,
  );
  expect(accepted.sceneDraft?.passages.some((passage) => passage.text === fact)).toBe(false);
});

it('derives a sufficient budget for known geography and counts every compressed gathering leg', () => {
  const ctx = context(),
    origin = ctx.scene.location.id!,
    actor = ctx.members[0].id;
  const stops = ['Hill', 'Grove', 'Observatory'].map((name) => ({ id: randomUUID(), name }));
  let from = origin;
  for (const stop of stops) {
    ctx.scene.worldMap!.nodes[stop.id] = { ...stop, visited: true };
    ctx.scene.places![stop.id] = {
      location: { ...stop, atmosphere: 'A maintained route.', hazard: '' },
      encounter: null,
      loot: [],
      encounterRisk: {
        danger: stop.name === 'Grove' ? 'dangerous' : 'safe',
        reason: 'Visible local circumstances.',
      },
    };
    ctx.scene.worldMap!.connections.push({
      from,
      to: stop.id,
      label: 'Road',
      blocked: false,
      bidirectional: true,
    });
    from = stop.id;
  }
  ctx.turn.actions[0].gathering = {
    id: randomUUID(),
    locationId: stops[2].id,
    route: [origin, ...stops.map((stop) => stop.id)],
  };
  const proposal = crossing(ctx, 'Hill', 1);
  proposal.beats = [
    {
      kind: 'gather',
      actor,
      journeyId: 'observatory-trip',
      text: 'Traveller follows the mapped road, stopping at the dangerous grove.',
    },
  ];
  const accepted = compileSceneTurn(ctx, proposal);
  expect(accepted.memberLocations![0].locationId).toBe(stops[1].id);
  expect(accepted.gmNotes![0].journey?.remainingStages).toBe(1);
});

it('keeps thread stagnation across new places and does not reset it for another thread', () => {
  const ctx = context();
  const first = compileSceneTurn(ctx, crossing(ctx));
  ctx.scene.worldProgression = advanceWorldProgression(ctx, first, (id) => id);
  expect(ctx.scene.worldProgression?.threads?.premise.stalledTurns).toBe(1);
  ctx.turn.id = randomUUID();
  ctx.turn.number++;
  const second = compileSceneTurn(ctx, crossing(ctx, 'Grove'));
  ctx.scene.worldProgression = advanceWorldProgression(ctx, second, (id) => id);
  expect(worldProgressionContext(ctx).threads.find((thread) => thread.id === 'premise')).toMatchObject({
    stalledTurns: 2,
  });
  expect(advanceWorldProgression(ctx, second, (id) => id)).toEqual(ctx.scene.worldProgression);
});

const premises = [
  {
    name: 'Quiet wilderness',
    premise: 'A peaceful solitary nature walk, without a mission.',
    object: 'Fallen cedar',
    person: null,
    mystery: false,
    concept: 'A wandering naturalist',
    property: 'moved',
    action: 'Move the fallen cedar aside.',
  },
  {
    name: 'Inverted ocean',
    premise: 'Gravity points upward. A silent jellyfish explores hanging reefs.',
    object: 'Tuning crystal',
    person: null,
    mystery: true,
    concept: 'A silent floating jellyfish without hands',
    property: 'resonating',
    action: 'Touch the tuning crystal with a tendril.',
  },
  {
    name: 'Border siege',
    premise: 'Defend a fortress against invaders; combat is central.',
    object: 'Sally port',
    person: 'Gate captain',
    mystery: false,
    concept: 'A fortress defender',
    property: 'open',
    action: 'Open the sally port.',
  },
  {
    name: 'Unhurried commons',
    premise: '',
    object: 'Sundial',
    person: 'Groundskeeper',
    mystery: false,
    concept: 'A curious visitor with no shared quest',
    property: 'aligned',
    action: 'Align the sundial with the noon shadow.',
  },
];

function opening(ctx: GMContext, premise: (typeof premises)[number]): SceneTurn {
  const at = ctx.scene.location.id!;
  const facts = `${premise.object} stands here.${premise.person ? ` ${premise.person} tends it.` : ''}`;
  return {
    version: 3,
    currencyName: 'local tokens',
    summary: facts,
    opening: {
      npcs: premise.person ? ['caretaker'] : [],
      features: ['fixture'],
      quests: [],
      mysteries: premise.mystery ? ['crystal-song'] : [],
    },
    notes: premise.mystery
      ? [
          {
            id: 'crystal-song',
            locationId: at,
            cause: 'PRIVATE: The crystal resonates with the inverted ocean tide.',
            discoveries: ['The tide sets the crystal singing.'],
            actors: '',
            nextChange: 'The tide turns.',
            dueTurn: null,
            status: 'open',
          },
        ]
      : [],
    beats: [
      {
        kind: 'world',
        at,
        fact: facts,
        text: `${ctx.config.premise} ${facts}`,
        place: {
          name: premise.name,
          atmosphere: facts,
          hazard: '',
          danger: 'safe',
          riskReason: 'The starting shelter is undisturbed.',
        },
        exits: [
          {
            to: 'new:outside',
            name: 'Beyond the shelter',
            label: 'An open passage',
            blocked: false,
            bidirectional: true,
          },
        ],
        features: [{ featureId: 'fixture', name: premise.object, properties: { [premise.property]: false } }],
        ...(premise.person ? { npcs: [{ npcId: 'caretaker', name: premise.person }] } : {}),
      },
    ],
  };
}

it('rejects an opening with missing declared people, objects, offers or mystery preparation together', () => {
  const ctx = context();
  ctx.turn.number = 0;
  ctx.turn.actions = [];
  const proposal = opening(ctx, premises[0]);
  proposal.opening = {
    npcs: ['unsaved-person'],
    features: ['unsaved-object'],
    quests: ['unsaved-offer'],
    mysteries: ['unsaved-mystery'],
  };
  expect(() => compileSceneTurn(ctx, proposal)).toThrow(
    /unsaved-person[\s\S]*unsaved-object[\s\S]*unsaved-offer[\s\S]*unsaved-mystery/,
  );
  delete proposal.opening;
  expect(() => compileSceneTurn(ctx, proposal)).toThrow('Opening needs');
});

it.each(premises)(
  'persists $name from a fresh opening through a changed fact and restart',
  async (premise) => {
    const db = openDatabase(':memory:'),
      practice = new PracticeGM();
    const contexts: GMContext[] = [];
    const adjudicate = vi.fn(async (ctx: GMContext) => {
      contexts.push(structuredClone(ctx));
      if (!ctx.turn.number) return compileSceneTurn(ctx, opening(ctx, premise));
      const actor = ctx.members[0].id;
      const changed = ctx.scene.features?.fixture.properties[premise.property];
      if (ctx.turn.number === 2) expect(changed).toBe(true);
      const fact =
        ctx.turn.number === 1
          ? `${premise.object} is now ${premise.property}.`
          : `${premise.object} remains ${premise.property}.`;
      return compileSceneTurn(ctx, {
        version: 3,
        notes: [],
        summary: fact,
        beats: [
          {
            kind: 'act',
            actor,
            slot: 'main',
            intent: 'action',
            fact,
            text: fact,
            ...(ctx.turn.number === 1
              ? {
                  features: [
                    { featureId: 'fixture', name: premise.object, properties: { [premise.property]: true } },
                  ],
                }
              : {}),
          },
        ],
      });
    });
    const provider: GameMaster = { sceneTurns: true, adjudicate, narrate: practice.narrate.bind(practice) };
    let game = new Game(
      db,
      () => provider,
      (sides) => sides,
    );
    try {
      const host = game.identify(),
        player = game.identify();
      const campaign = game.create(host.id, {
        name: premise.name,
        setting: premise.name,
        premise: premise.premise,
        tone: 'Respect the premise',
        language: 'English',
        instructions: 'No imposed objective.',
        custom: [],
        provider: 'chatgpt',
        model: 'test',
      });
      const character = game.saveCharacter(player.id, {
        ...templateCharacter('Explorer'),
        concept: premise.concept,
      });
      game.join(campaign.inviteCode!, player.id, character.id);
      const member = game.members(campaign.id)[0];
      game.manageCharacter(campaign.id, player.id, {
        type: 'starter',
        itemIds: member.state.starterEquipment.slice(0, 2).map((item) => item.id),
      });
      game.start(campaign.id, host.id);
      await game.idle();
      const initial = game.snapshot(campaign.id, host.id);
      expect(initial.turn?.phase, initial.turn?.error ?? '').toBe('collecting');
      expect(initial.scene.features?.fixture.properties[premise.property]).toBe(false);
      expect(Object.keys(initial.scene.npcs ?? {})).toHaveLength(premise.person ? 1 : 0);
      expect(Object.keys(initial.scene.quests ?? {})).toHaveLength(0);
      expect(JSON.stringify(initial)).not.toContain('PRIVATE:');
      for (const action of [premise.action, `Inspect the ${premise.object.toLowerCase()}.`]) {
        game.submit(campaign.id, player.id, game.pending(campaign.id)!.id, action, false);
        await game.idle();
        const snapshot = game.snapshot(campaign.id, host.id);
        expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
        expect(snapshot.scene.features?.fixture.properties[premise.property]).toBe(true);
        expect(snapshot.members[0].state.xp).toBe(0);
        expect(snapshot.history.at(-1)?.rolls).toEqual([]);
        game = new Game(
          db,
          () => provider,
          (sides) => sides,
        );
      }
      expect(adjudicate).toHaveBeenCalledTimes(3);
      expect(contexts[2].members[0].character.concept).toBe(premise.concept);
      expect(contexts[2].gmMemory).toHaveLength(premise.mystery ? 1 : 0);
      expect(contexts[2].config.partyGoal).toBeUndefined();
    } finally {
      db.close();
    }
  },
);

it('publishes finite journey progress once across restart and an interrupted final arrival', async () => {
  const db = openDatabase(':memory:'),
    practice = new PracticeGM();
  const adjudicate = vi.fn(async (ctx: GMContext) => {
    if (!ctx.turn.number) {
      const start = opening(ctx, premises[0]);
      const beat = start.beats[0];
      if (beat.kind !== 'world') throw new Error('fixture');
      beat.exits = [
        { to: 'new:hill', name: 'Hill', label: 'The hill path', blocked: false, bidirectional: true },
      ];
      return compileSceneTurn(ctx, start);
    }
    const name = ctx.turn.number === 1 ? 'Hill' : 'Observatory';
    const proposal = crossing(ctx, name);
    const move = proposal.beats[0];
    if (move.kind !== 'move') throw new Error('fixture');
    move.to = Object.keys(knownLocations(ctx.scene)).find((id) => knownLocations(ctx.scene)[id] === name)!;
    // Arrival at the named destination also closes the journey without repeating its ID.
    if (ctx.turn.number === 2) delete move.journeyId;
    return compileSceneTurn(ctx, proposal);
  });
  const provider: GameMaster = { sceneTurns: true, adjudicate, narrate: practice.narrate.bind(practice) };
  let game = new Game(
    db,
    () => provider,
    (sides) => sides,
  );
  try {
    const host = game.identify(),
      player = game.identify();
    const campaign = game.create(host.id, {
      name: 'Observatory expedition',
      setting: 'Quiet hills',
      premise: 'A caravan delivers lenses.',
      tone: 'Quiet',
      language: 'English',
      instructions: '',
      custom: [],
      provider: 'chatgpt',
      model: 'test',
    });
    const character = game.saveCharacter(player.id, templateCharacter('Traveller'));
    game.join(campaign.inviteCode!, player.id, character.id);
    const member = game.members(campaign.id)[0];
    game.manageCharacter(campaign.id, player.id, {
      type: 'starter',
      itemIds: member.state.starterEquipment.slice(0, 2).map((item) => item.id),
    });
    game.start(campaign.id, host.id);
    await game.idle();
    expect(game.pending(campaign.id)?.phase, game.pending(campaign.id)?.error ?? '').toBe('collecting');
    game.submit(campaign.id, player.id, game.pending(campaign.id)!.id, 'Follow the caravan onward.', false);
    await game.idle();
    expect(game.pending(campaign.id)?.phase, game.pending(campaign.id)?.error ?? '').toBe('collecting');
    const memory = () => JSON.parse(game.campaign(campaign.id).gm_memory);
    expect(memory()[0]).toMatchObject({ status: 'open', journey: { remainingStages: 1 } });
    expect(memory()[0].locationId).not.toMatch(/^new:/);
    game = new Game(
      db,
      () => provider,
      (sides) => sides,
    );
    db.exec(
      "CREATE TRIGGER interrupt_journey_publication BEFORE UPDATE OF gm_memory ON campaigns BEGIN SELECT RAISE(ABORT, 'publication interrupted'); END;",
    );
    game.submit(campaign.id, player.id, game.pending(campaign.id)!.id, 'Walk to the Observatory.', false);
    await game.idle();
    expect(game.pending(campaign.id)?.phase).toBe('failed');
    expect(memory()[0].journey.remainingStages).toBe(1);
    expect(adjudicate).toHaveBeenCalledTimes(3);
    db.exec('DROP TRIGGER interrupt_journey_publication');
    game = new Game(
      db,
      () => provider,
      (sides) => sides,
    );
    game.retry(campaign.id, host.id);
    await game.idle();
    const snapshot = game.snapshot(campaign.id, host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(memberScene(snapshot.scene, member.id).location.name).toBe('Observatory');
    expect(memory()[0]).toMatchObject({ status: 'resolved', journey: { remainingStages: 0 } });
    expect(adjudicate).toHaveBeenCalledTimes(3);
    expect(snapshot.history.flatMap((turn) => turn.rolls)).toEqual([]);
  } finally {
    db.close();
  }
});
