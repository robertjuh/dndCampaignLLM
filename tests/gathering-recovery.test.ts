import { expect, it, vi } from 'vitest';
import saved from './fixtures/vaal-gathering.json';
import { Game, type GMContext, type GameMaster, type GameTools } from '../server/game';
import { ChatGPTGM, PracticeGM } from '../server/providers';
import type { ChatGPTAuth } from '../server/auth';
import { openDatabase } from '../server/db';
import { actorReferences, normalizeAdjudicationReferences } from '../server/world-map';
import { compileSceneTurn } from '../server/scene-turn';
import { applyNPCUpdates } from '../server/npcs';
import {
  engineEvents,
  normalizeAdjudicationStructure,
  validateAdjudication,
} from '../server/turn-resolution';
import { prepareEncounterChecks, type EncounterChecks } from '../server/encounters';
import { initialState } from '../shared/rules';
import { memberScene } from '../shared/locations';
import { templateCharacter, type Scene } from '../shared/schema';
import type { TurnAdjudication } from '../shared/turn-resolution';

const auth = { accessToken: async () => 'test-token' } as unknown as ChatGPTAuth;
const joiner = saved.turn.actions.find((action) => action.gathering)!;
const destination = joiner.gathering!.locationId;
function context(): GMContext {
  const members = saved.members.map((member) => {
    const character = { ...templateCharacter(member.name), stats: member.stats };
    return {
      id: member.id,
      playerId: member.id,
      playerName: member.name,
      characterId: member.id,
      character,
      state: initialState(character, member.id),
      active: true,
    };
  });
  return {
    config: {
      name: 'Recorded gathering',
      ruleset: 'roguelike-v1',
      setting: 'VAAL',
      premise: '',
      tone: '',
      language: 'English',
      instructions: '',
      custom: [],
      provider: 'chatgpt',
      model: 'test',
    },
    members,
    startingMembers: structuredClone(members),
    scene: { ...structuredClone(saved.scene), currencyName: 'vaal marks' } as Scene,
    turn: {
      ...structuredClone(saved.turn),
      phase: 'resolving',
      roster: members.map((m) => m.id),
      result: null,
      error: null,
    } as GMContext['turn'],
    receipts: structuredClone(saved.receipts),
    partialAdjudication: structuredClone(saved.partial) as TurnAdjudication,
    history: [],
    journal: [],
    requestBudget: { used: 0, limit: 1 },
  };
}
function response(value: unknown) {
  return new Response(
    `data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
      },
    })}\n\n`,
  );
}
function normalize(c: GMContext, input: unknown): TurnAdjudication {
  const value = normalizeAdjudicationStructure(
    c,
    normalizeAdjudicationReferences(c, input),
  ) as TurnAdjudication;
  value.events = [...engineEvents(c), ...value.events];
  return value;
}

function gatheringScene() {
  const c = context();
  c.sceneProtocol = true;
  c.receipts = {};
  c.turn.rolls = [];
  delete c.partialAdjudication;
  delete c.scene.worldProgression;
  for (const action of c.turn.actions)
    if (!action.gathering) {
      action.passed = true;
      action.text = '';
    }
  const actor = Object.entries(actorReferences(c)).find(([, member]) => member.id === joiner.memberId)![0];
  return {
    c,
    actor,
    scene: {
      version: 3,
      currencyName: 'imperial scrip',
      summary: 'The gathering journey.',
      beats: [{ kind: 'gather', actor, text: 'Xulath follows the familiar road toward the gathering.' }],
    },
  };
}

it('carries an established NPC through the same validated gathering route and preserves their identity', () => {
  const { c, scene } = gatheringScene();
  c.scene.npcs = {
    courier: {
      id: 'courier',
      name: 'Courier Nyra',
      aliases: [],
      locationId: memberScene(c.scene, joiner.memberId).location.id!,
      status: 'alive',
      allegiance: 'Couriers',
      followingMemberId: joiner.memberId,
      fact: 'Nyra travels with Xulath.',
    },
  };
  const value = compileSceneTurn(c, scene);
  applyNPCUpdates(c.scene, value, (ref) => ref);
  expect(c.scene.npcs.courier).toMatchObject({
    locationId: destination,
    followingMemberId: joiner.memberId,
    allegiance: 'Couriers',
  });
});

it.each(['gather', 'move'])(
  'compiles %s gathering travel with server-owned slots, route, identities and rewards in one request',
  async (kind) => {
    const { c, actor, scene } = gatheringScene();
    const input =
      kind === 'gather'
        ? scene
        : {
            ...scene,
            beats: [
              {
                kind,
                actor,
                to: destination,
                fact: 'Xulath travels the gathering route.',
                text: scene.beats[0].text,
              },
            ],
          };
    const before = structuredClone(c);
    const fetcher = vi.fn(async () => response({ ...input, rewards: { xp: 40, reason: 'Travel.' } }));
    const gameTools = Object.assign(vi.fn(), {
      validateAdjudication: (input: unknown) => validateAdjudication(c, input),
    }) as unknown as GameTools;
    const accepted = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(c, gameTools);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(c.requestBudget?.corrections ?? []).toEqual([]);
    expect(accepted.actions.find((a) => a.memberId === joiner.memberId)).toMatchObject({
      actionId: `${c.turn.id}:action:${joiner.memberId}`,
      status: 'success',
      components: { main: { basis: 'routine', status: 'success' }, minor: null },
      travel: { goalId: destination },
    });
    expect(accepted.actions.find((a) => a.memberId === joiner.memberId)?.components.movement).toBeUndefined();
    expect(accepted.memberLocations).toEqual([
      { memberId: joiner.memberId, locationId: destination, movementEventId: expect.any(String) },
    ]);
    expect(accepted.rewards.xp).toBe(0);
    expect(accepted.sceneDraft?.passages.some((passage) => passage.text === scene.beats[0].text)).toBe(true);
    expect({ ...c, requestBudget: undefined }).toEqual({ ...before, requestBudget: undefined });
    expect(gameTools).not.toHaveBeenCalled();
  },
);

it.each(['danger', 'combat', 'blocked', 'one-way', 'world-change'])(
  'derives the gathering stop for %s before generating movement proofs',
  (cause) => {
    const { c, scene } = gatheringScene();
    const [origin, middle, goal] = joiner.gathering!.route;
    const edge = c.scene.worldMap!.connections.find(
      (edge) => [edge.from, edge.to].includes(origin) && [edge.from, edge.to].includes(middle),
    )!;
    if (cause === 'danger')
      c.scene.places![middle].encounterRisk = { danger: 'dangerous', reason: 'A hostile patrol.' };
    if (cause === 'combat')
      c.scene.places![middle].encounter = {
        enemies: [],
        round: 1,
        initiative: [],
        victory: false,
        escaped: false,
      };
    if (cause === 'blocked') edge.blocked = true;
    if (cause === 'one-way') Object.assign(edge, { from: middle, to: origin, bidirectional: false });
    const beats: unknown[] = [...scene.beats];
    if (cause === 'world-change')
      beats.unshift({
        kind: 'world',
        at: goal,
        fact: 'Guards close the northbound gate at Far North Road.',
        text: 'The road gate slams shut.',
        exits: [{ to: middle, label: 'The closed road gate.', blocked: true, bidirectional: true }],
      });
    const accepted = compileSceneTurn(c, { ...scene, beats });
    const expected = cause === 'danger' || cause === 'world-change' ? middle : origin;
    const position = accepted.memberLocations?.find((position) => position.memberId === joiner.memberId);
    expect(position?.locationId ?? origin).toBe(expected);
    expect(accepted.actions.find((action) => action.memberId === joiner.memberId)?.travel?.goalId).toBe(goal);
    if (cause === 'danger') {
      const draw = vi.fn(() => 6);
      prepareEncounterChecks(c, accepted, {}, draw);
      expect(draw).toHaveBeenCalledExactlyOnceWith(middle);
    }
  },
);

it('persists a surprising local interruption with generated evidence while preserving progress and player choice', () => {
  const { c, actor, scene } = gatheringScene();
  const middle = joiner.gathering!.route[1];
  const strange =
    'A stone road marker unfolds into a mouth and demands the name of the person who carved it.';
  const accepted = compileSceneTurn(c, {
    ...scene,
    beats: [
      {
        kind: 'gather',
        actor,
        text: 'Xulath reaches the road beyond the waystation.',
        stop: { at: middle, fact: strange, text: strange },
      },
    ],
  });
  const action = accepted.actions.find((action) => action.memberId === joiner.memberId)!;
  const obstacle = accepted.events.find((event) => event.id === action.travel?.obstacleEventId)!;
  expect(action.components.main?.status).toBe('success');
  expect(accepted.memberLocations).toContainEqual(
    expect.objectContaining({ memberId: joiner.memberId, locationId: middle }),
  );
  expect(obstacle).toMatchObject({
    kind: 'world',
    actionId: null,
    memberId: null,
    locationRef: middle,
    fact: strange,
  });
  expect(accepted.journal).toContainEqual(expect.objectContaining({ kind: 'fact', detail: strange }));
  expect(accepted.pickups).toEqual([]);
  expect(accepted.changes).toEqual([]);
  expect(accepted.actions.find((action) => action.memberId !== joiner.memberId)?.status).toBe('passed');
});

it('respects danger another character discovers earlier in the same scene', () => {
  const { c, scene } = gatheringScene();
  const middle = joiner.gathering!.route[1];
  const scout = c.turn.actions.find((action) => !action.gathering)!;
  scout.passed = false;
  scout.text = `Walk to ${c.scene.places![middle].location.name}.`;
  const accepted = compileSceneTurn(c, {
    ...scene,
    beats: [
      {
        kind: 'move',
        actor: scout.memberId,
        to: middle,
        fact: 'Gemling returns to the road and sees an armed patrol.',
        text: 'An armed patrol blocks the fields beside the road.',
        place: {
          name: c.scene.places![middle].location.name,
          atmosphere: 'An armed patrol watches the road.',
          hazard: 'The patrol blocks travellers.',
          danger: 'dangerous',
          riskReason: 'An armed patrol blocks the road.',
        },
      },
      ...scene.beats,
    ],
  });
  expect(accepted.memberLocations?.map((position) => position.locationId)).toEqual([middle, middle]);
  expect(accepted.actions.find((action) => action.memberId === joiner.memberId)?.travel?.goalId).toBe(
    destination,
  );
});

it.each(['unsubmitted', 'extra-main', 'extra-minor', 'beyond-danger', 'foreign-stop'])(
  'rejects gathering %s without weakening the underlying rules',
  (change) => {
    const { c, actor, scene } = gatheringScene();
    const beats: unknown[] = [...scene.beats];
    if (change === 'unsubmitted')
      delete c.turn.actions.find((a) => a.memberId === joiner.memberId)!.gathering;
    if (change === 'extra-main' || change === 'extra-minor')
      beats.push({
        kind: 'act',
        actor,
        slot: change === 'extra-main' ? 'main' : 'minor',
        fact: 'Xulath takes another action.',
        text: 'An extra act.',
      });
    if (change === 'beyond-danger' || change === 'foreign-stop') {
      c.scene.places![joiner.gathering!.route[1]].encounterRisk = {
        danger: 'dangerous',
        reason: 'A patrol.',
      };
      beats[0] = {
        ...scene.beats[0],
        stop: {
          at: change === 'foreign-stop' ? c.scene.location.id : destination,
          fact: 'A new obstruction.',
          text: 'A new obstruction.',
        },
      };
    }
    expect(() => compileSceneTurn(c, { ...scene, beats })).toThrow();
  },
);

it.each(['initial', 0, 1, 2] as const)(
  'accepts recorded gathering response %s with one model request and preserves saved results',
  async (attempt) => {
    const c = context();
    // Isolate format recovery from the independently bounded optional story-pacing repair.
    delete c.scene.worldProgression;
    if (attempt === 'initial') {
      delete c.partialAdjudication;
      delete (c.receipts as Record<string, unknown>).encounterChecks;
    }
    const before = structuredClone(c);
    const draw = vi.fn(() => 1);
    const mechanics = vi.fn();
    const tools = Object.assign(mechanics, {
      validateAdjudication: (input: unknown) => validateAdjudication(c, input),
      prepareEncounters: (value: TurnAdjudication) =>
        prepareEncounterChecks(c, value, (c.receipts!.encounterChecks ??= {}) as EncounterChecks, draw)
          .required,
    }) as unknown as GameTools;
    const fetcher = vi.fn(async () =>
      response(attempt === 'initial' ? saved.initial : saved.repairs[attempt]),
    );
    const accepted = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(c, tools);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(c.requestBudget?.corrections ?? []).toEqual([]);
    expect(accepted.memberLocations).toEqual([
      {
        memberId: joiner.memberId,
        locationId: destination,
        movementEventId: attempt === 'initial' ? 'xulath-gathering-movement' : 'xulath-gathering-arrival',
      },
    ]);
    expect(accepted.actions.find((a) => a.memberId === joiner.memberId)).toMatchObject({
      status: 'success',
      components: { main: { status: 'success', basis: 'routine' }, minor: null, movement: null },
    });
    const gemling = saved.partial.actions.find((a) => a.memberId !== joiner.memberId)!;
    expect(accepted.actions.find((a) => a.memberId === gemling.memberId)?.components.main).toEqual(
      gemling.components.main,
    );
    expect(accepted.events.slice(0, engineEvents(c).length)).toEqual(engineEvents(c));
    expect(c.turn.rolls).toEqual(before.turn.rolls);
    expect(c.scene).toEqual(before.scene);
    expect(c.partialAdjudication).toEqual(before.partialAdjudication);
    expect(c.receipts!.loot).toEqual(before.receipts!.loot);
    expect((c.receipts!.encounterChecks as EncounterChecks)[destination].memberIds.sort()).toEqual(
      c.members.map((m) => m.id).sort(),
    );
    expect(draw).not.toHaveBeenCalled();
    expect(mechanics).not.toHaveBeenCalled();
  },
);

it('keeps extra actions, conflicting actors, ordinary multi-hop travel, blocked routes and danger invalid', () => {
  for (const change of ['main', 'minor', 'actor', 'proofActor', 'ordinary', 'blocked', 'danger'] as const) {
    const c = context();
    delete c.partialAdjudication;
    delete (c.receipts as Record<string, unknown>).encounterChecks;
    const raw = structuredClone(saved.initial) as unknown as TurnAdjudication;
    const action = raw.actions.find((a) => a.memberId === joiner.memberId)!;
    const proof = raw.events.find((event) => event.id === action.components.movement?.eventIds[0])!;
    if (change === 'main' || change === 'minor')
      action.components[change] = structuredClone(action.components.movement ?? null);
    if (change === 'actor') action.memberId = c.members.find((m) => m.id !== joiner.memberId)!.id;
    if (change === 'proofActor') proof.memberId = c.members.find((m) => m.id !== joiner.memberId)!.id;
    if (change === 'ordinary') delete c.turn.actions.find((a) => a.memberId === joiner.memberId)!.gathering;
    if (change === 'blocked')
      c.scene.worldMap!.connections.find(
        (edge) => edge.from === destination && edge.to === joiner.gathering!.route[1],
      )!.blocked = true;
    if (change === 'danger')
      c.scene.places![joiner.gathering!.route[1]].encounterRisk = { danger: 'dangerous', reason: 'Raiders.' };
    expect(() => validateAdjudication(c, normalize(c, raw)), change).toThrow();
  }
});

it('waits for unresolved destinations before saving encounter groups or spending dice', () => {
  const c = context();
  const checks: EncounterChecks = {};
  const draw = vi.fn(() => 1);
  c.scene.places![destination].encounterRisk = { danger: 'dangerous', reason: 'Raiders.' };
  prepareEncounterChecks(c, saved.partial as TurnAdjudication, checks, draw);
  expect(checks).toEqual({});
  expect(draw).not.toHaveBeenCalled();
});

it('updates only unrolled safe groups for validated moves and keeps validation free of checkpoint mutations', () => {
  const c = context();
  const value = normalize(c, saved.initial);
  const checks = c.receipts!.encounterChecks as EncounterChecks;
  const before = structuredClone(checks);
  expect(() => validateAdjudication(c, value)).not.toThrow();
  expect(checks).toEqual(before);
  for (const change of ['rolled', 'triggered', 'frozen', 'unsafe', 'departed'] as const) {
    const changed = structuredClone(c);
    const check = (changed.receipts!.encounterChecks as EncounterChecks)[destination];
    if (change === 'rolled') {
      check.danger = 'dangerous';
      check.die = 6;
    }
    if (change === 'triggered') {
      check.danger = 'dangerous';
      check.die = 1;
      check.triggered = true;
    }
    if (change === 'frozen') changed.receipts!.encounterProposal = value;
    if (change === 'unsafe')
      changed.scene.places![destination].encounterRisk = { danger: 'dangerous', reason: 'Raiders.' };
    if (change === 'departed') check.memberIds.push('departed-member');
    expect(
      () => prepareEncounterChecks(changed, value, changed.receipts!.encounterChecks as EncounterChecks),
      change,
    ).toThrow('checked group');
  }
});

it('restarts and publishes the failed gathering checkpoint without repeating saved dice or duplicating loot', async () => {
  const db = openDatabase(':memory:');
  try {
    const c = context();
    delete c.requestBudget;
    const practice = new PracticeGM();
    const fetcher = vi.fn(async () =>
      response(fetcher.mock.calls.length === 1 ? saved.repairs[2] : { events: [] }),
    );
    const gm = new ChatGPTGM(auth, 'owner', 'test', fetcher);
    let replay = false;
    const provider: GameMaster = {
      sceneTurns: true,
      adjudicate: (context, tools) =>
        replay ? gm.adjudicate(context, tools) : practice.adjudicate(context, tools),
      narrate: practice.narrate.bind(practice),
    };
    const draw = vi.fn((sides: number) => sides);
    let game = new Game(db, () => provider, draw);
    const host = game.identify();
    const campaign = game.create(host.id, c.config);
    for (const member of c.members) {
      const player = game.identify();
      const character = game.saveCharacter(player.id, member.character);
      game.join(campaign.inviteCode!, player.id, character.id);
      db.prepare('UPDATE members SET id=? WHERE campaign_id=? AND player_id=?').run(
        member.id,
        campaign.id,
        player.id,
      );
      game.manageCharacter(campaign.id, player.id, {
        type: 'starter',
        itemIds: game
          .members(campaign.id)
          .find((m) => m.id === member.id)!
          .state.starterEquipment.slice(0, 2)
          .map((item) => item.id),
      });
    }
    game.start(campaign.id, host.id);
    await game.idle();
    const pending = game.pending(campaign.id)!;
    c.members = game.members(campaign.id);
    c.startingMembers = structuredClone(c.members);
    const draft = {
      context: c,
      members: c.members,
      startingMembers: c.startingMembers,
      scene: c.scene,
      receipts: c.receipts,
      partialAdjudication: c.partialAdjudication,
      pipelineVersion: 1,
      gmMemory: [],
    };
    db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(c.scene), campaign.id);
    db.prepare("UPDATE turns SET id=?,number=26,phase='failed',roster=?,draft=? WHERE id=?").run(
      c.turn.id,
      JSON.stringify(c.turn.roster),
      JSON.stringify(draft),
      pending.id,
    );
    for (const action of c.turn.actions)
      db.prepare('INSERT INTO actions(turn_id,member_id,text,passed,gathering) VALUES(?,?,?,?,?)').run(
        c.turn.id,
        action.memberId,
        action.text,
        0,
        action.gathering ? JSON.stringify(action.gathering) : null,
      );
    for (const roll of c.turn.rolls)
      db.prepare('INSERT INTO rolls VALUES(?,?,?,?,?)').run(
        roll.id,
        c.turn.id,
        roll.id,
        '{}',
        JSON.stringify(roll),
      );
    replay = true;
    draw.mockClear();
    game = new Game(db, () => provider, draw);
    game.retry(campaign.id, host.id);
    await game.idle();
    const snapshot = game.snapshot(campaign.id, host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    expect(snapshot.turn?.number).toBe(27);
    expect(memberScene(snapshot.scene, joiner.memberId).location.id).toBe(destination);
    const completed = snapshot.history.at(-1)!;
    expect(completed.id).toBe(c.turn.id);
    expect(completed.rolls.slice(0, c.turn.rolls.length)).toEqual(c.turn.rolls);
    expect(completed.rolls.slice(c.turn.rolls.length).map((roll) => roll.label)).toEqual([
      'Exploration bonus chance (15%)',
    ]);
    const gemling = saved.partial.actions.find((a) => a.memberId !== joiner.memberId)!;
    const row = db.prepare('SELECT draft FROM turns WHERE id=?').get(c.turn.id) as { draft: string };
    const final = JSON.parse(row.draft).adjudication as TurnAdjudication;
    expect(final.actions.find((a) => a.memberId === gemling.memberId)?.components.main).toEqual(
      gemling.components.main,
    );
    expect(
      memberScene(snapshot.scene, joiner.memberId).loot.filter(
        (item) => item.id === saved.receipts.loot.item.id,
      ),
    ).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2); // Gathering is repaired locally; the other call is optional story pacing.
    expect(draw).toHaveBeenCalledExactlyOnceWith(100); // Finalization's first bonus roll; no repeated checks or encounter dice.
  } finally {
    db.close();
  }
});
