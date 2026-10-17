import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app';
import { ChatGPTAuth } from '../server/auth';
import { openDatabase } from '../server/db';
import { Game, type GMContext } from '../server/game';
import { PracticeGM, adjudicationInput } from '../server/providers';
import { validateWorldMap } from '../server/world-map';
import { gatheringProgress, gatheringRoute } from '../shared/gathering';
import { memberScene } from '../shared/locations';
import { enemySchema, templateCharacter, type Scene } from '../shared/schema';
import type { TurnAdjudication } from '../shared/turn-resolution';

const [inn, road, bridge, camp] = Array.from({ length: 4 }, () => randomUUID());
const names: Record<string, string> = { [inn]: 'Inn', [road]: 'Road', [bridge]: 'Bridge', [camp]: 'Camp' };

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));

function roads(): Scene {
  const location = (id: string) => ({ id, name: names[id], atmosphere: 'A familiar road.', hazard: '' });
  return {
    location: location(inn),
    encounter: null,
    encounters: 0,
    loot: [],
    lethalWarning: null,
    encounterRisk: { danger: 'safe', reason: 'Patrolled road.' },
    places: Object.fromEntries(
      [road, bridge, camp].map((id) => [
        id,
        {
          location: location(id),
          encounter: null,
          loot: [],
          encounterRisk: { danger: 'safe', reason: 'Patrolled road.' },
        },
      ]),
    ),
    worldMap: {
      nodes: Object.fromEntries(
        [inn, road, bridge, camp].map((id) => [id, { id, name: names[id], visited: true }]),
      ),
      connections: [
        [inn, road],
        [road, bridge],
        [bridge, camp],
      ].map(([from, to]) => ({ from, to, blocked: false, bidirectional: true, label: road })),
    },
    memberLocations: {},
  };
}

async function table() {
  const db = openDatabase(':memory:');
  cleanup.push(() => db.close());
  const provider = new PracticeGM();
  const dice = vi.fn((sides: number) => Math.min(sides, 12));
  let game = new Game(db, () => provider, dice);
  const host = game.identify();
  const players = [game.identify(), game.identify(), game.identify()];
  const campaign = game.create(host.id, {
    name: 'Gathering',
    setting: inn,
    premise: '',
    tone: '',
    language: 'English',
    instructions: '',
    custom: [],
    provider: 'practice',
  });
  for (const [index, player] of players.entries()) {
    const character = templateCharacter(`Traveller ${index}`);
    character.selectedEquipmentIds = character.equipmentOptions.slice(0, 2).map((item) => item.id);
    const saved = game.saveCharacter(player.id, character);
    game.join(campaign.inviteCode!, player.id, saved.id);
  }
  game.start(campaign.id, host.id);
  await game.idle();
  const snapshot = () => game.snapshot(campaign.id, host.id);
  expect(snapshot().turn?.phase, snapshot().turn?.error ?? '').toBe('collecting');
  const members = game.members(campaign.id);
  const scene = roads();
  scene.memberLocations = Object.fromEntries(
    members.map((member, index) => [member.id, index === 1 ? camp : inn]),
  );
  const saveScene = (scene: Scene) =>
    db.prepare('UPDATE campaigns SET scene = ? WHERE id = ?').run(JSON.stringify(scene), campaign.id);
  saveScene(scene);
  const call = () => {
    game.callGathering(campaign.id, players[0].id, snapshot().turn!.id);
    return snapshot().scene.gathering!;
  };
  const join = (gatheringId = snapshot().scene.gathering!.id, player = players[1]) =>
    game.submit(campaign.id, player.id, snapshot().turn!.id, '', false, false, null, null, gatheringId);
  return {
    db,
    provider,
    dice,
    host,
    players,
    campaign,
    members,
    scene,
    snapshot,
    saveScene,
    call,
    join,
    get game() {
      return game;
    },
    restart() {
      game = new Game(db, () => provider, dice);
    },
    async finish() {
      const turn = snapshot().turn!;
      for (const player of players) {
        const member = members.find((member) => member.playerId === player.id)!;
        if (!turn.actions.some((action) => action.memberId === member.id))
          game.submit(campaign.id, player.id, turn.id, '', true);
      }
      await game.idle();
      expect(snapshot().turn?.phase, snapshot().turn?.error ?? '').toBe('collecting');
      return snapshot().history.at(-1)!;
    },
  };
}

it('compresses visited open routes, preserving one-way routes, blockers, unknown places and combat', () => {
  const scene = roads();
  expect(gatheringRoute(scene, camp, inn)).toEqual([camp, bridge, road, inn]);
  expect(gatheringProgress(scene, [camp, bridge, road, inn]).destination).toBe(inn);
  scene.places![bridge].encounterRisk = { danger: 'dangerous', reason: 'Bandits use the bridge.' };
  expect(gatheringProgress(scene, [camp, bridge, road, inn])).toMatchObject({
    path: [camp, bridge],
    destination: bridge,
    stop: 'danger',
  });
  scene.worldMap!.connections[1].bidirectional = false;
  expect(gatheringRoute(scene, camp, inn)).toBeNull();
  scene.worldMap!.connections[1].bidirectional = true;
  scene.worldMap!.nodes[road].visited = false;
  expect(gatheringRoute(scene, camp, inn)).toBeNull();
  scene.worldMap!.nodes[road].visited = true;
  scene.worldMap!.connections[1].blocked = true;
  expect(gatheringRoute(scene, camp, inn)).toBeNull();
  scene.worldMap!.connections[1].blocked = false;
  scene.places![road].encounter = { enemies: [], round: 1, initiative: [], victory: false, escaped: false };
  expect(gatheringRoute(scene, camp, inn)).toBeNull();
});

it('calls without spending an action, saves optional joining, supports cancellation and narrates multi-hop travel once after restart', async () => {
  const f = await table();
  const gathering = f.call();
  expect(f.snapshot().turn!.actions).toEqual([]);
  f.join();
  expect(f.snapshot().turn!.actions[0].gathering).toEqual({
    id: gathering.id,
    locationId: inn,
    route: [camp, bridge, road, inn],
  });
  expect(() => f.game.callGathering(f.campaign.id, f.players[2].id, f.snapshot().turn!.id)).toThrow(
    'Players have joined',
  );
  f.game.cancelAction(f.campaign.id, f.players[1].id, f.snapshot().turn!.id);
  expect(f.snapshot().turn!.actions).toEqual([]);
  f.join();
  f.restart();
  const completed = await f.finish();
  expect(memberScene(f.snapshot().scene, f.members[1].id).location.id).toBe(inn);
  expect(completed.result!.narration).toContain('Camp → Bridge → Road → Inn');
  expect(completed.result!.narration).toContain('Time passes');
  expect(completed.result!.xp).toBe(0);
  expect(completed.rolls).toEqual([]);
  expect(f.snapshot().scene.worldMap!.connections).toHaveLength(3);
  expect(f.snapshot().scene.gathering).toEqual(gathering);
  expect(f.snapshot().turn!.actions).toEqual([]);
});

it('rejects stale calls, foreign players, combatants and replacing an already submitted action', async () => {
  const f = await table();
  f.call();
  expect(() => f.join(randomUUID())).toThrow('meeting point changed');
  expect(() => f.game.callGathering(f.campaign.id, f.host.id, f.snapshot().turn!.id)).toThrow(
    'participating character',
  );
  f.game.submit(f.campaign.id, f.players[1].id, f.snapshot().turn!.id, 'Watch the road.', false);
  expect(() => f.join()).toThrow('Cancel your submitted action');
  f.game.cancelAction(f.campaign.id, f.players[1].id, f.snapshot().turn!.id);
  const scene = f.snapshot().scene;
  scene.places![camp].encounter = {
    enemies: [
      {
        ...enemySchema.parse({
          id: 'raider',
          name: 'Raider',
          tier: 'normal',
          hp: 20,
          defense: 10,
          attack: 0,
          damage: '1d4',
          description: 'An armed raider.',
          tactic: 'Attack.',
        }),
        maxHp: 20,
        initiative: 0,
      },
    ],
    round: 1,
    initiative: [],
    victory: false,
    escaped: false,
  };
  f.saveScene(scene);
  expect(() => f.join()).toThrow('Characters in combat');
  expect(() => f.game.callGathering(f.campaign.id, f.players[1].id, f.snapshot().turn!.id)).toThrow('combat');
});

it('stops at a dangerous intermediate place without skipping its encounter check or automatically continuing', async () => {
  const f = await table();
  const scene = f.snapshot().scene;
  scene.places![bridge].encounterRisk = { danger: 'dangerous', reason: 'Raiders ambush travellers here.' };
  f.saveScene(scene);
  f.call();
  f.join();
  const completed = await f.finish();
  expect(memberScene(f.snapshot().scene, f.members[1].id).location.id).toBe(bridge);
  expect(completed.result!.narration).toContain('Camp → Bridge');
  expect(completed.rolls.filter((roll) => roll.reason === 'Random encounter')).toHaveLength(1);
  expect(f.snapshot().turn!.actions).toEqual([]);
});

it('validates gathering exceptions only for saved join actions and denies extra actions or bypassing danger', async () => {
  const f = await table();
  f.call();
  f.join();
  const s = f.snapshot();
  const context: GMContext = {
    config: s.config,
    members: s.members,
    scene: s.scene,
    turn: s.turn!,
    history: [],
    journal: [],
  };
  const value = adjudicationInput(context).schemaExample as TurnAdjudication;
  const action = value.actions[0];
  const event = value.events.find((event) => event.memberId === action.memberId)!;
  event.effect = 'movement';
  event.locationRef = inn;
  value.memberLocations = [{ memberId: action.memberId, locationId: inn, movementEventId: event.id }];
  expect(() => validateWorldMap(context, value, (id) => id)).not.toThrow();
  context.turn.actions[0].gathering = undefined;
  expect(() => validateWorldMap(context, value, (id) => id)).toThrow('only one adjacent');
  context.turn.actions[0].gathering = s.turn!.actions[0].gathering = {
    id: s.scene.gathering!.id,
    locationId: inn,
    route: [camp, bridge, road, inn],
  };
  action.components.movement = action.components.main;
  expect(() => validateWorldMap(context, value, (id) => id)).toThrow('whole main action');
  action.components.movement = null;
  context.scene.places![bridge].encounterRisk = { danger: 'dangerous', reason: 'Raiders.' };
  expect(() => validateWorldMap(context, value, (id) => id)).toThrow('stop at danger');
});

it('starts a triggered encounter at the intermediate stop and requires new combat submissions', async () => {
  const f = await table();
  const scene = f.snapshot().scene;
  scene.places![bridge].encounterRisk = { danger: 'dangerous', reason: 'Raiders ambush travellers here.' };
  f.saveScene(scene);
  f.dice.mockImplementation(() => 1);
  f.call();
  f.join();
  const hp = f.snapshot().members[1].state.hp;
  const completed = await f.finish();
  const local = memberScene(f.snapshot().scene, f.members[1].id);
  expect(local.location.id).toBe(bridge);
  expect(local.encounter).toMatchObject({ round: 1, victory: false });
  expect(local.encounter!.enemies[0].hp).toBe(20);
  expect(f.snapshot().members[1].state.hp).toBe(hp);
  expect(completed.rolls.filter((roll) => roll.reason === 'Random encounter')).toHaveLength(1);
  expect(() => f.join()).toThrow('Characters in combat');
});

it('retries narration from the saved arrival without travelling, rolling or rewarding twice', async () => {
  const f = await table();
  f.call();
  f.join();
  const adjudicate = vi.spyOn(f.provider, 'adjudicate');
  const narrate = vi.spyOn(f.provider, 'narrate').mockRejectedValueOnce(new Error('Narration interrupted.'));
  const turnId = f.snapshot().turn!.id;
  for (const player of [f.players[0], f.players[2]])
    f.game.submit(f.campaign.id, player.id, turnId, '', true);
  await f.game.idle();
  expect(f.snapshot().turn?.phase).toBe('failed');
  f.restart();
  f.game.retry(f.campaign.id, f.host.id);
  await f.game.idle();
  expect(f.snapshot().turn?.phase, f.snapshot().turn?.error ?? '').toBe('collecting');
  expect(memberScene(f.snapshot().scene, f.members[1].id).location.id).toBe(inn);
  expect(adjudicate).toHaveBeenCalledTimes(1);
  expect(narrate).toHaveBeenCalledTimes(2);
  expect(f.snapshot().history.at(-1)!.result!.xp).toBe(0);
  expect(f.snapshot().scene.worldMap!.connections).toHaveLength(3);
});

it('keeps the meeting point fixed when the caller leaves and preserves each non-joiner’s action', async () => {
  const f = await table();
  const gathering = f.call();
  const scene = f.snapshot().scene;
  scene.memberLocations![f.members[0].id] = road;
  f.saveScene(scene);
  f.join();
  f.game.submit(f.campaign.id, f.players[2].id, f.snapshot().turn!.id, 'Watch the inn entrance.', false);
  const completed = await f.finish();
  expect(f.snapshot().scene.gathering).toEqual(gathering);
  expect(memberScene(f.snapshot().scene, f.members[1].id).location.id).toBe(inn);
  expect(memberScene(f.snapshot().scene, f.members[0].id).location.id).toBe(road);
  expect(completed.actions.find((action) => action.memberId === f.members[2].id)).toMatchObject({
    text: 'Watch the inn entrance.',
  });
});

it('authenticates gathering endpoints and derives the joining character and route on the server', async () => {
  const f = await table();
  const directory = mkdtempSync(join(tmpdir(), 'gathering-api-'));
  const { app } = await createApp({
    db: f.db,
    auth: new ChatGPTAuth(directory),
    providers: () => f.provider,
  });
  const post = (path: string, player: typeof f.host, payload: object) =>
    app.inject({
      method: 'POST',
      url: `/api/campaigns/${f.campaign.id}/${path}`,
      headers: { 'x-gather-request': '1' },
      cookies: { gather_session: player.token! },
      payload,
    });
  try {
    const turnId = f.snapshot().turn!.id;
    expect((await post('gathering', f.host, { turnId })).statusCode).toBe(403);
    expect((await post('gathering', f.players[0], { turnId: randomUUID() })).statusCode).toBe(409);
    const call = await post('gathering', f.players[0], { turnId });
    expect(call.statusCode).toBe(200);
    const gatheringId = call.json().scene.gathering.id;
    expect(
      (await post('gathering/join', f.players[1], { turnId, gatheringId, memberId: f.members[2].id }))
        .statusCode,
    ).toBe(400);
    expect(
      (await post('gathering/join', f.players[1], { turnId, gatheringId: randomUUID() })).statusCode,
    ).toBe(409);
    expect((await post('gathering/join', f.host, { turnId, gatheringId })).statusCode).toBe(403);
    const joined = await post('gathering/join', f.players[1], { turnId, gatheringId });
    expect(joined.statusCode).toBe(200);
    expect(joined.json().turn.actions).toMatchObject([
      {
        memberId: f.members[1].id,
        gathering: { id: gatheringId, locationId: inn, route: [camp, bridge, road, inn] },
      },
    ]);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
