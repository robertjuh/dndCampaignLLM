import { interruptNarration } from './narration-interruption';
import { afterEach, expect, it, vi } from 'vitest';
import { openDatabase } from '../server/db';
import { Game, type GameMaster, type GMContext, type GameTools } from '../server/game';
import { adjudicationInput } from '../server/providers';
import { engineEvents } from '../server/turn-resolution';
import { normalizeCombatInput } from '../server/combat';
import { enemySchema, templateCharacter } from '../shared/schema';
import { factualNarration, turnAdjudicationSchema, type TurnAdjudication } from '../shared/turn-resolution';
import { placeScene } from '../shared/locations';

const road = '33333333-3333-4333-8333-333333333333';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));
const dice = (sides: number) => (sides === 6 ? 1 : Math.min(sides, 12));
const raider = () =>
  enemySchema.parse({
    id: 'road-raider',
    name: 'Road raider',
    tier: 'normal',
    hp: 60,
    defense: 10,
    attack: 0,
    damage: '1d4',
    description: 'A lookout beside the abandoned caravan cart.',
    tactic: 'Hold the road.',
  });

function base(context: GMContext) {
  const input = adjudicationInput(context);
  return turnAdjudicationSchema.parse({
    ...input.schemaExample,
    events: [...engineEvents(context), ...input.schemaExample.events],
  });
}

function development(value: TurnAdjudication, locationId: string, opening = false) {
  const eventId = `world:caravan:${locationId}`;
  const fact = opening
    ? 'The innkeeper identifies the mill as the missing caravan’s last recorded delivery.'
    : 'The caravan lookout takes position beside the abandoned cart, blocking the road with a drawn blade.';
  value.events.push({
    id: eventId,
    sequence: value.events.length,
    kind: 'world',
    actionId: null,
    memberId: null,
    phase: 'aftermath',
    result: null,
    locationRef: locationId,
    fact,
    receiptRefs: [],
    dependsOn: [],
  });
  value.journal.push({ kind: 'quest', name: 'Missing caravan', detail: fact });
  value.worldProgress!.push({
    locationId,
    eventId,
    kind: opening ? 'discovery' : 'threat',
    thread: 'premise',
    journal: { kind: 'quest', name: 'Missing caravan' },
  });
  return eventId;
}

function introductions(value: TurnAdjudication, context: GMContext) {
  for (const [locationId, encounter] of Object.entries(context.receipts?.startCombatByLocation ?? {})) {
    if (value.events.some((event) => event.id === `world:encounter:${locationId}`)) continue;
    const names = (encounter as { enemies: { name: string }[] }).enemies
      .map((enemy) => enemy.name)
      .join(', ');
    value.events.push({
      id: `world:encounter:${locationId}`,
      sequence: value.events.length,
      kind: 'world',
      actionId: null,
      memberId: null,
      phase: 'aftermath',
      result: null,
      locationRef: locationId,
      fact: `${names} emerges from cover and confronts the present travellers.`,
      receiptRefs: ['tool:startCombatByLocation'],
      dependsOn: [],
    });
  }
}

async function table() {
  const db = openDatabase(':memory:');
  cleanup.push(() => db.close());
  let handle: (context: GMContext, tools: GameTools) => TurnAdjudication | Promise<TurnAdjudication> = (
    context,
  ) => base(context);
  const provider: GameMaster = {
    adjudicate: async (context, tools) => {
      if (context.turn.number) return handle(context, tools);
      const value = base(context);
      const id = context.scene.location.id!;
      const eventId = development(value, id, true);
      value.placeUpdates = [
        {
          ref: id,
          location: { name: 'Inn', atmosphere: 'An occupied inn with a posted delivery ledger.', hazard: '' },
        },
      ];
      value.arrivals = [{ locationId: id, eventId }];
      value.encounterRisks = [
        { locationId: id, eventId, danger: 'safe', reason: 'The staffed inn is secure.' },
      ];
      return tools.validateAdjudication!(value);
    },
    narrate: async (resolution, config) => factualNarration(resolution, config.language),
    planCombat: async (context) => normalizeCombatInput(context),
  };
  const draw = vi.fn(dice);
  let game = new Game(db, () => provider, draw);
  const host = game.identify();
  const players = [game.identify(), game.identify()];
  const campaign = game.create(host.id, {
    name: 'Encounter flow',
    setting: 'Inn',
    premise: 'Find the missing caravan.',
    tone: '',
    language: 'English',
    instructions: '',
    custom: [],
    provider: 'practice',
  });
  for (const [index, player] of players.entries()) {
    const character = templateCharacter(`Scout ${index}`);
    character.selectedEquipmentIds = character.equipmentOptions.slice(0, 2).map((item) => item.id);
    game.join(campaign.inviteCode!, player.id, game.saveCharacter(player.id, character).id);
  }
  game.start(campaign.id, host.id);
  await game.idle();
  const snapshot = () => game.snapshot(campaign.id, host.id);
  expect(snapshot().turn!.phase, snapshot().turn!.error ?? '').toBe('collecting');
  const members = game.members(campaign.id);
  const scene = snapshot().scene;
  const inn = scene.location.id!;
  scene.places![road] = {
    location: { id: road, name: 'Road', atmosphere: 'An exposed caravan road.', hazard: 'Patrols' },
    encounter: null,
    loot: [],
    encounterRisk: { danger: 'dangerous', reason: 'Hostile patrols hold this road.' },
  };
  scene.worldMap!.nodes[road] = { id: road, name: 'Road', visited: true };
  scene.memberLocations![members[0].id] = road;
  db.prepare('UPDATE campaigns SET scene = ? WHERE id = ?').run(JSON.stringify(scene), campaign.id);
  const submit = async (texts = ['Observe the abandoned cart.', '']) => {
    const turnId = snapshot().turn!.id;
    players.forEach((player, index) =>
      game.submit(campaign.id, player.id, turnId, texts[index], !texts[index]),
    );
    await game.idle();
    return turnId;
  };
  const draft = (turnId: string) =>
    JSON.parse((db.prepare('SELECT draft FROM turns WHERE id = ?').get(turnId) as { draft: string }).draft);
  const rolls = (turnId: string) =>
    db
      .prepare('SELECT check_key, parameters, result FROM rolls WHERE turn_id = ? ORDER BY check_key')
      .all(turnId);
  const restart = (source = vi.fn(dice)) => {
    game = new Game(db, () => provider, source);
    return source;
  };
  const normal = (context: GMContext, tools: GameTools) => {
    const value = base(context);
    if (!context.combatResult) development(value, road);
    introductions(value, context);
    const accepted = tools.validateAdjudication!(value);
    for (const check of tools.prepareEncounters!(accepted)) tools.startCombat([raider()], check.locationId);
    introductions(value, context);
    return tools.validateAdjudication!(value);
  };
  handle = normal;
  return {
    db,
    provider,
    draw,
    players,
    members,
    campaign,
    host,
    inn,
    snapshot,
    submit,
    draft,
    rolls,
    restart,
    normal,
    get game() {
      return game;
    },
    setHandle(value: typeof handle) {
      handle = value;
    },
  };
}

it('starts a required local encounter without attacks, then resolves its next round without involving the safe group', async () => {
  const f = await table();
  let requiredLocations: string[] = [];
  f.setHandle((context, tools) => {
    const value = base(context);
    development(value, road);
    introductions(value, context);
    const accepted = tools.validateAdjudication!(value);
    const required = tools.prepareEncounters!(accepted);
    requiredLocations = required.map((check) => check.locationId);
    for (const check of required) tools.startCombat([raider()], check.locationId);
    introductions(value, context);
    return tools.validateAdjudication!(value);
  });
  const hp = f.members.map((member) => member.state.hp);
  const introduced = await f.submit();
  expect(f.snapshot().turn!.phase, f.snapshot().turn!.error ?? '').toBe('collecting');
  expect(requiredLocations).toEqual([road]);
  const local = placeScene(f.snapshot().scene, road).encounter!;
  expect(local.round).toBe(1);
  expect(local.initiative.map((entry) => entry.id).sort()).toEqual([f.members[0].id, 'road-raider'].sort());
  expect(f.game.members(f.campaign.id).map((member) => member.state.hp)).toEqual(hp);
  expect(f.draft(introduced).receipts.combat).toBeUndefined();
  expect(f.snapshot().scene.encounter).toBeNull();
  f.setHandle(f.normal);
  f.provider.planCombat = async (context) => {
    expect(context.members.map((member) => member.id)).toEqual([f.members[0].id]);
    return normalizeCombatInput(context);
  };
  const round = await f.submit(['Attack road-raider.', '']);
  expect(f.snapshot().turn!.phase, f.snapshot().turn!.error ?? '').toBe('collecting');
  expect(placeScene(f.snapshot().scene, road).encounter!.round).toBe(2);
  expect(f.draft(round).receipts.combat.participantIds).toEqual([f.members[0].id]);
  expect(f.game.members(f.campaign.id)[1].state.hp).toBe(hp[1]);
  expect(f.snapshot().scene.memberLocations![f.members[1].id]).toBe(f.inn);
});

it.each([true, false])(
  'bounds fresh random opponents while preserving explicit story stakes (random=%s)',
  async (random) => {
    const f = await table();
    f.setHandle((context, tools) => {
      const value = base(context);
      development(value, road);
      if (random) {
        const required = tools.prepareEncounters!(tools.validateAdjudication!(value));
        expect(required.map((check) => check.locationId)).toEqual([road]);
        const before = f.rolls(context.turn.id);
        expect(() =>
          tools.startCombat(
            [
              { ...raider(), tier: 'boss' },
              { ...raider(), id: 'second-raider', tier: 'boss' },
            ],
            road,
          ),
        ).toThrow('16/8');
        expect(() =>
          tools.startCombat(
            Array.from({ length: 5 }, (_, index) => ({ ...raider(), id: `raider-${index}`, tier: 'minor' })),
            road,
          ),
        ).toThrow('at most 4');
        expect(f.rolls(context.turn.id)).toEqual(before);
      }
      const proposed = { ...raider(), defense: 30, attack: 15, damage: '4d12', onHit: 'Chilled' as const };
      const saved = tools.startCombat([proposed], road);
      const rolls = f.rolls(context.turn.id);
      expect(tools.startCombat([{ ...proposed, hp: 1, damage: '1d4' }], road)).toEqual(saved);
      expect(f.rolls(context.turn.id)).toEqual(rolls);
      introductions(value, context);
      return tools.validateAdjudication!(value);
    });
    await f.submit();
    const snapshot = f.snapshot();
    expect(snapshot.turn!.phase, snapshot.turn!.error ?? '').toBe('collecting');
    const enemy = placeScene(snapshot.scene, road).encounter!.enemies[0];
    expect(enemy).toMatchObject(
      random
        ? {
            hp: 12,
            maxHp: 12,
            defense: 11,
            attack: 1,
            damage: '1d6',
            onHitChance: 25,
            maxAilmentsPerHit: 1,
          }
        : { hp: 60, maxHp: 60, defense: 30, attack: 15, damage: '4d12' },
    );
    if (!random) expect(enemy.onHitChance).toBeUndefined();
  },
);

it('preserves an already established enemy profile when a later random encounter finds that NPC again', async () => {
  const f = await table();
  const scene = f.snapshot().scene;
  scene.npcs = {
    'road-raider': {
      id: 'road-raider',
      name: 'Road raider',
      aliases: [],
      locationId: road,
      status: 'alive',
      allegiance: null,
      fact: 'The surviving caravan lookout holds the road.',
      enemy: { ...raider(), hp: 21, maxHp: 60, initiative: 1, equipment: [] },
    },
  };
  f.db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(scene), f.campaign.id);
  await f.submit();
  const snapshot = f.snapshot();
  expect(snapshot.turn!.phase, snapshot.turn!.error ?? '').toBe('collecting');
  const saved = placeScene(snapshot.scene, road).encounter!.enemies[0];
  expect(saved).toMatchObject({ hp: 21, maxHp: 60, defense: 10, attack: 0, damage: '1d4' });
  expect(saved.onHitChance).toBeUndefined();
});

it('starts a four-enemy random encounter for a solo explorer without executing an opening attack', async () => {
  const f = await table();
  f.setHandle((context, tools) => {
    const value = base(context);
    development(value, road);
    const required = tools.prepareEncounters!(tools.validateAdjudication!(value));
    expect(required.map((check) => check.locationId)).toEqual([road]);
    tools.startCombat(
      Array.from({ length: 4 }, (_, index) => ({
        ...raider(),
        id: `raider-${index}`,
        name: `Road raider ${index + 1}`,
      })),
      road,
    );
    introductions(value, context);
    return tools.validateAdjudication!(value);
  });
  const hp = f.members[0].state.hp;
  await f.submit();
  const snapshot = f.snapshot();
  expect(snapshot.turn!.phase, snapshot.turn!.error ?? '').toBe('collecting');
  const fight = placeScene(snapshot.scene, road).encounter!;
  expect(fight.enemies).toHaveLength(4);
  expect(fight.enemies.every((enemy) => enemy.hp === 12 && enemy.maxHp === 12)).toBe(true);
  expect(fight.initiative).toHaveLength(5);
  expect(fight.round).toBe(1);
  expect(snapshot.members[0].state.hp).toBe(hp);
});

it.each(['check', 'start', 'finalization'] as const)(
  'reuses saved dice and progress after restarting following %s',
  async (pause) => {
    const f = await table();
    const introduction =
      'The Road raider steps around the abandoned cart, drawing a blade to enforce the blockade.';
    let interrupted = false;
    f.setHandle((context, tools) => {
      const value = base(context);
      development(value, road);
      introductions(value, context);
      const accepted = tools.validateAdjudication!(value);
      const required = tools.prepareEncounters!(accepted);
      if (pause === 'check' && !interrupted) {
        interrupted = true;
        throw new Error('Interrupted after check.');
      }
      for (const check of required) {
        expect(() => tools.startCombat([raider()], check.locationId, ' ')).toThrow('Describe how and why');
        tools.startCombat([raider()], check.locationId, introduction);
        tools.startCombat([raider()], check.locationId, 'A retry must not replace the saved cause.');
      }
      if (pause === 'start' && !interrupted) {
        interrupted = true;
        throw new Error('Interrupted after start.');
      }
      introductions(value, context);
      return tools.validateAdjudication!(value);
    });
    f.provider.narrate = async (resolution, config) => {
      if (pause === 'finalization' && !interrupted) {
        interrupted = true;
        interruptNarration(f.db, 'Interrupted after finalization.');
      }
      return factualNarration(resolution, config.language);
    };
    const turnId = await f.submit();
    expect(f.snapshot().turn!.phase, f.snapshot().turn!.error ?? '').toBe('failed');
    const before = f.draft(turnId);
    const beforeRolls = f.rolls(turnId);
    const check = structuredClone(before.receipts.encounterChecks[road]);
    expect(check).toMatchObject({ die: 1, triggered: true, memberIds: [f.members[0].id] });
    if (pause !== 'check') expect(before.receipts.startCombatByLocation[road].round).toBe(1);
    if (pause === 'finalization') expect(before.scene.worldProgression.places[road].lastTurnId).toBe(turnId);
    const retryDraw = f.restart();
    f.game.retry(f.campaign.id, f.host.id);
    await f.game.idle();
    expect(f.snapshot().turn!.phase, f.snapshot().turn!.error ?? '').toBe('collecting');
    const after = f.draft(turnId);
    expect(after.receipts.encounterChecks[road]).toEqual(check);
    expect(after.receipts.combatIntroductionsByLocation[road]).toBe(introduction);
    if (pause === 'start') expect(f.snapshot().history.at(-1)?.result?.narration).toContain(introduction);
    expect(
      f.rolls(turnId).filter((row) => (row as { check_key: string }).check_key === `encounter:${road}`),
    ).toHaveLength(1);
    expect(retryDraw.mock.calls.length).toBe(f.rolls(turnId).length - beforeRolls.length);
    expect(placeScene(f.snapshot().scene, road).encounter!.round).toBe(1);
    expect(after.scene.worldProgression.places[road]).toMatchObject({ stalledTurns: 0, lastTurnId: turnId });
    if (pause === 'finalization') expect(after.scene.worldProgression).toEqual(before.scene.worldProgression);
  },
);

it('refuses to complete when a provider discards a mandatory saved encounter', async () => {
  const f = await table();
  f.setHandle((context, tools) => {
    const value = base(context);
    development(value, road);
    tools.prepareEncounters!(tools.validateAdjudication!(value));
    // A legacy-shaped fallback cannot hide a saved mandatory encounter by omitting opt-in fields.
    delete value.encounterRisks;
    delete value.worldProgress;
    return value;
  });
  const turnId = await f.submit();
  expect(f.snapshot().turn!.phase).toBe('failed');
  expect(f.snapshot().turn!.error).toMatch(/Saved (?:random encounters|encounter)/);
  expect(f.draft(turnId).receipts.encounterChecks[road].triggered).toBe(true);
  f.setHandle(f.normal);
  f.restart();
  f.game.retry(f.campaign.id, f.host.id);
  await f.game.idle();
  expect(f.snapshot().turn!.phase, f.snapshot().turn!.error ?? '').toBe('collecting');
  expect(placeScene(f.snapshot().scene, road).encounter!.round).toBe(1);
});

it.each(['new:caravan-camp', '44444444-4444-4444-8444-444444444444'])(
  'places a first-arrival trigger and initiative at %s while the shared focus stays at the inn',
  async (ref) => {
    const f = await table();
    const mapped = !ref.startsWith('new:');
    const preview = '55555555-5555-4555-8555-555555555555';
    if (mapped) {
      const scene = f.snapshot().scene;
      scene.worldMap!.nodes[ref] = { id: ref, name: 'Caravan camp', visited: false };
      scene.worldMap!.nodes[preview] = { id: preview, name: 'Distant ruins', visited: false };
      scene.worldMap!.connections.push({
        from: road,
        to: ref,
        label: 'Open track',
        blocked: false,
        bidirectional: true,
      });
      expect(scene.places![ref]).toBeUndefined();
      f.db.prepare('UPDATE campaigns SET scene = ? WHERE id = ?').run(JSON.stringify(scene), f.campaign.id);
    }
    let interrupted = false;
    f.setHandle((context, tools) => {
      const value = base(context);
      const actor = value.actions.find((action) => action.memberId === f.members[0].id)!;
      const movement = value.events.find(
        (event) => event.actionId === actor.actionId && event.phase === 'main',
      )!;
      movement.effect = 'movement';
      movement.locationRef = ref;
      movement.fact = 'Scout 0 reaches the adjacent caravan camp along the open track.';
      actor.fact = actor.components.main!.fact = movement.fact;
      value.memberLocations = [{ memberId: actor.memberId, locationId: ref, movementEventId: movement.id }];
      value.placeUpdates = [
        {
          ref,
          location: {
            name: 'Caravan camp',
            atmosphere: 'An abandoned cart stands beside a lookout’s barricade.',
            hazard: 'Armed lookout',
          },
        },
      ];
      const eventId = development(value, ref);
      value.arrivals = [{ locationId: ref, eventId }];
      value.mapUpdates = {
        locations: [],
        connections: [
          { from: road, to: ref, label: 'Open track', blocked: false, bidirectional: true, eventId },
        ],
      };
      value.encounterRisks = [
        { locationId: ref, eventId, danger: 'dangerous', reason: 'An armed lookout holds the camp.' },
      ];
      introductions(value, context);
      const required = tools.prepareEncounters!(tools.validateAdjudication!(value));
      expect(required.map((check) => check.locationId)).toEqual([ref]);
      if (mapped && !interrupted) {
        interrupted = true;
        throw new Error('Interrupted after first-arrival encounter check.');
      }
      if (mapped) expect(() => tools.startCombat([raider()], preview)).toThrow();
      for (const check of required) {
        const encounter = tools.startCombat([raider()], check.locationId);
        const savedRolls = f.rolls(context.turn.id);
        expect(tools.startCombat([raider()], check.locationId)).toEqual(encounter);
        expect(f.rolls(context.turn.id)).toEqual(savedRolls);
      }
      introductions(value, context);
      return tools.validateAdjudication!(value);
    });
    const turnId = await f.submit(['Walk to the caravan camp.', '']);
    if (mapped) {
      expect(f.snapshot().turn!.phase).toBe('failed');
      expect(f.draft(turnId).scene.places[ref]).toBeUndefined();
      const saved = structuredClone(f.draft(turnId).receipts.encounterChecks[ref]);
      expect(saved).toMatchObject({ die: 1, triggered: true, memberIds: [f.members[0].id] });
      f.restart();
      f.game.retry(f.campaign.id, f.host.id);
      await f.game.idle();
      expect(f.draft(turnId).receipts.encounterChecks[ref]).toEqual(saved);
      expect(
        f.rolls(turnId).filter((row) => (row as { check_key: string }).check_key === `encounter:${ref}`),
      ).toHaveLength(1);
    }
    const result = f.snapshot();
    expect(result.turn!.phase, result.turn!.error ?? '').toBe('collecting');
    const locationId = result.scene.memberLocations![f.members[0].id];
    expect(locationId).not.toBe(road);
    if (mapped) expect(locationId).toBe(ref);
    else expect(locationId).not.toBe(ref);
    expect(result.scene.worldMap!.nodes[locationId].visited).toBe(true);
    expect(result.scene.location.id).toBe(f.inn);
    const arrival = placeScene(result.scene, locationId);
    expect(arrival.encounterRisk!.danger).toBe('dangerous');
    expect(arrival.encounter!.initiative.map((entry) => entry.id).sort()).toEqual(
      [f.members[0].id, 'road-raider'].sort(),
    );
    expect(arrival.encounter!.round).toBe(1);
    expect(placeScene(result.scene, road).encounter).toBeNull();
    expect(f.draft(turnId).scene.worldProgression.places[locationId].lastTurnId).toBe(turnId);
  },
);

it('saves an unadvanced local counter once and publishes later turns while pacing remains due', async () => {
  const f = await table();
  const scene = f.snapshot().scene;
  scene.places![road].encounterRisk = { danger: 'safe', reason: 'The secured road is guarded.' };
  f.db.prepare('UPDATE campaigns SET scene = ? WHERE id = ?').run(JSON.stringify(scene), f.campaign.id);
  f.setHandle((context) => base(context));
  let interrupt = true;
  f.provider.narrate = async (resolution, config) => {
    if (interrupt) interruptNarration(f.db, 'Interrupted after counter finalization.');
    return factualNarration(resolution, config.language);
  };
  const turnId = await f.submit();
  expect(f.snapshot().turn!.phase).toBe('failed');
  expect(f.draft(turnId).scene.worldProgression.places[road]).toMatchObject({
    stalledTurns: 1,
    lastTurnId: turnId,
  });
  interrupt = false;
  const draw = f.restart(
    vi.fn(() => {
      throw new Error('Saved finalization cannot draw again.');
    }),
  );
  f.game.retry(f.campaign.id, f.host.id);
  await f.game.idle();
  expect(f.snapshot().turn!.phase, f.snapshot().turn!.error ?? '').toBe('collecting');
  expect(draw).not.toHaveBeenCalled();
  expect(f.snapshot().scene.worldProgression!.places[road].stalledTurns).toBe(1);
  await f.submit();
  expect(f.snapshot().turn!.phase, f.snapshot().turn!.error ?? '').toBe('collecting');
  expect(f.snapshot().scene.worldProgression!.places[road].stalledTurns).toBe(2);
});
