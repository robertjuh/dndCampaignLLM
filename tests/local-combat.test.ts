import { afterEach, expect, it, vi } from 'vitest';
import { interruptNarration } from './narration-interruption';
import { openDatabase } from '../server/db';
import { Game, type CombatReceipt, type GameMaster, type GMContext } from '../server/game';
import { adjudicationInput } from '../server/providers';
import { normalizeCombatInput } from '../server/combat';
import { engineEvents } from '../server/turn-resolution';
import { factualNarration, turnAdjudicationSchema, type TurnAdjudication } from '../shared/turn-resolution';
import { applyCondition, baseItem } from '../shared/rules';
import { enemySchema, outcomeSchema, templateCharacter, type Scene, type Encounter } from '../shared/schema';
import { placeScene } from '../shared/locations';

const ravine = '11111111-1111-4111-8111-111111111111';
const cave = '22222222-2222-4222-8222-222222222222';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));

function routine(context: GMContext): TurnAdjudication {
  const value = adjudicationInput(context).schemaExample;
  const events = [...engineEvents(context), ...value.events];
  const encounterRisks = [
    ...new Set([context.scene.location.id!, ...Object.values(context.scene.memberLocations ?? {})]),
  ]
    .filter((id) => !placeScene(context.scene, id).encounterRisk)
    .map((locationId) => {
      const place = placeScene(context.scene, locationId);
      const eventId = `world:risk:${locationId}`;
      events.push({
        id: eventId,
        sequence: events.length,
        kind: 'world',
        memberId: null,
        actionId: null,
        phase: 'aftermath',
        result: null,
        fact: place.encounter
          ? 'An armed raider holds this passage.'
          : 'Local patrols keep this established place secure.',
        locationRef: locationId,
        receiptRefs: [],
        dependsOn: [],
      });
      return {
        locationId,
        eventId,
        danger: place.encounter ? 'dangerous' : 'safe',
        reason: place.encounter ? 'An armed raider is present.' : 'Local patrols secure the area.',
      };
    });
  for (const [locationRef, encounter] of Object.entries(
    (context.receipts?.startCombatByLocation as Record<string, Encounter> | undefined) ?? {},
  ))
    events.push({
      id: `world:encounter:${locationRef}`,
      sequence: events.length,
      kind: 'world',
      memberId: null,
      actionId: null,
      phase: 'aftermath',
      result: null,
      locationRef,
      fact: `${encounter.enemies.map((enemy) => enemy.name).join(', ')} blocks the local passage, confronting the character present.`,
      receiptRefs: ['tool:startCombatByLocation'],
      dependsOn: [],
    });
  return turnAdjudicationSchema.parse({
    ...value,
    events,
    encounterRisks,
    arrivals: undefined,
    worldProgress: undefined,
  });
}
const enemy = (id: string, hp = 60) =>
  enemySchema.parse({
    id,
    name: id,
    tier: 'normal',
    hp,
    defense: 10,
    attack: 0,
    damage: '1d4',
    description: 'An armed raider.',
    tactic: 'Attack the local character.',
  });

async function table(legacy = false) {
  const db = openDatabase(':memory:');
  cleanup.push(() => db.close());
  const provider: GameMaster = legacy
    ? {
        resolve: async () =>
          outcomeSchema.parse({
            narration: 'The scene continues.',
            summary: 'The scene continues.',
            choices: [],
            changes: [],
            journal: [],
          }),
      }
    : {
        adjudicate: async (context) => routine(context),
        narrate: async (resolution, config) => factualNarration(resolution, config.language),
      };
  const draw = vi.fn((sides: number) => Math.min(sides, 12));
  let game = new Game(db, () => provider, draw);
  const host = game.identify();
  const players = [game.identify(), game.identify(), game.identify()];
  const campaign = game.create(host.id, {
    name: 'Separated combat',
    setting: 'Inn',
    premise: '',
    tone: '',
    language: 'English',
    instructions: '',
    custom: [],
    provider: 'practice',
  });
  for (const [index, player] of players.entries()) {
    const character = templateCharacter(`Scout ${index}`);
    character.selectedEquipmentIds = character.equipmentOptions.slice(0, 2).map((item) => item.id);
    const saved = game.saveCharacter(player.id, character);
    game.join(campaign.inviteCode!, player.id, saved.id);
  }
  game.start(campaign.id, host.id);
  await game.idle();
  const snapshot = () => game.snapshot(campaign.id, host.id);
  expect(snapshot().turn!.phase, snapshot().turn!.error ?? '').toBe('collecting');
  const members = game.members(campaign.id);
  const scene = snapshot().scene;
  for (const id of [ravine, cave]) {
    scene.places![id] = {
      location: { id, name: id, atmosphere: 'An exposed passage.', hazard: '' },
      encounter: null,
      loot: [],
    };
    scene.worldMap!.nodes[id] = { id, name: id, visited: true };
  }
  scene.memberLocations![members[0].id] = ravine;
  scene.memberLocations![members[1].id] = cave;
  const saveScene = (value: Scene) =>
    db.prepare('UPDATE campaigns SET scene = ? WHERE id = ?').run(JSON.stringify(value), campaign.id);
  saveScene(scene);
  const submit = async (texts = ['Attack ravine-raider.', 'Attack cave-raider.', 'Read the map.']) => {
    const turnId = snapshot().turn!.id;
    players.forEach((player, index) =>
      game.submit(campaign.id, player.id, turnId, texts[index], !texts[index]),
    );
    await game.idle();
    return turnId;
  };
  const restart = (source = draw) => {
    game = new Game(db, () => provider, source);
    return game;
  };
  return {
    get game() {
      return game;
    },
    db,
    provider,
    draw,
    host,
    players,
    members,
    campaign,
    snapshot,
    submit,
    restart,
    saveScene,
  };
}

it.each([false, true])(
  'resolves two occupied fights independently of an inn focus and reuses both receipts after restart (legacy=%s)',
  async (legacy) => {
    const f = await table(legacy);
    let started = false;
    let observed: GMContext | undefined;
    const resolve: NonNullable<GameMaster['resolve']> = async (context, tools) => {
      if (!started) {
        tools.startCombat([enemy('ravine-raider')], ravine);
        expect(() => tools.startCombat([enemy('ravine-raider')], cave)).toThrow(
          /unique across active encounters|not at the encounter's origin/,
        );
        tools.startCombat([enemy('cave-raider')], cave);
        expect(() => tools.combat(normalizeCombatInput(context), ravine)).toThrow('just begun');
        tools({
          memberId: f.members[0].id,
          stat: 'WIS',
          dc: 10,
          mode: 'normal',
          lethal: false,
          reason: 'Watch the road before the raider arrives.',
        });
        started = true;
      }
      observed = structuredClone(context);
      return outcomeSchema.parse({
        narration: 'The scene continues.',
        summary: 'The scene continues.',
        choices: [],
        changes: [],
        journal: [],
      });
    };
    if (legacy) f.provider.resolve = resolve;
    else
      f.provider.adjudicate = async (context, tools) => {
        await resolve(context, tools);
        return routine(context);
      };
    const before = f.members.map((member) => member.state.hp);
    const introducedTurn = await f.submit(['Watch the road.', 'Watch the doorway.', 'Read the map.']);
    expect(f.snapshot().turn!.phase, f.snapshot().turn!.error ?? '').toBe('collecting');
    for (const id of [ravine, cave]) expect(placeScene(f.snapshot().scene, id).encounter!.round).toBe(1);
    expect(f.game.members(f.campaign.id).map((member) => member.state.hp)).toEqual(before);
    const first = JSON.parse(
      (f.db.prepare('SELECT draft FROM turns WHERE id = ?').get(introducedTurn) as { draft: string }).draft,
    );
    expect(Object.keys(first.receipts.startCombatByLocation).sort()).toEqual([cave, ravine].sort());

    f.provider.planCombat = async (context) => {
      expect(context.members).toHaveLength(1);
      expect(context.turn.actions).toHaveLength(1);
      return normalizeCombatInput(context);
    };
    let interrupt = true;
    if (legacy)
      f.provider.resolve = async (context) => {
        observed = structuredClone(context);
        if (interrupt) throw new Error('Interrupted after local combat receipts.');
        return outcomeSchema.parse({
          narration: 'The scene continues.',
          summary: 'The scene continues.',
          choices: [],
          changes: [],
          journal: [],
        });
      };
    else {
      f.provider.adjudicate = async (context) => {
        observed = structuredClone(context);
        return routine(context);
      };
      f.provider.narrate = async (resolution, config) => {
        if (interrupt) interruptNarration(f.db, 'Interrupted after local combat receipts.');
        return factualNarration(resolution, config.language);
      };
    }
    const turnId = await f.submit();
    expect(f.snapshot().turn!.phase, f.snapshot().turn!.error ?? '').toBe('failed');
    const saved = JSON.parse(
      (f.db.prepare('SELECT draft FROM turns WHERE id = ?').get(turnId) as { draft: string }).draft,
    );
    const combat = saved.receipts.combat as CombatReceipt;
    expect(Object.keys(saved.receipts.combatByLocation).sort()).toEqual([cave, ravine].sort());
    expect(combat.participantIds?.sort()).toEqual(
      f.members
        .slice(0, 2)
        .map((member) => member.id)
        .sort(),
    );
    expect(Object.keys(combat.encounters!).sort()).toEqual([cave, ravine].sort());
    expect(combat.events!.every((event) => event.locationId === cave || event.locationId === ravine)).toBe(
      true,
    );
    expect(observed!.scene.location.name).toBe('Inn');
    const rolls = f.db
      .prepare('SELECT check_key FROM rolls WHERE turn_id = ? ORDER BY check_key')
      .all(turnId);
    expect(
      rolls.some((roll) => (roll as { check_key: string }).check_key.startsWith(`combat:${cave}:`)),
    ).toBe(true);
    expect(
      rolls.some((roll) => (roll as { check_key: string }).check_key.startsWith(`combat:${ravine}:`)),
    ).toBe(true);
    interrupt = false;
    const noNewDice = vi.fn(() => {
      throw new Error('A saved fight must not reroll.');
    });
    f.restart(noNewDice).retry(f.campaign.id, f.host.id);
    await f.game.idle();
    expect(f.snapshot().turn!.phase, f.snapshot().turn!.error ?? '').toBe('collecting');
    expect(noNewDice).not.toHaveBeenCalled();
    expect(f.snapshot().scene.location.name).toBe('Inn');
    expect(f.snapshot().scene.encounter).toBeNull();
    for (const id of [ravine, cave]) expect(placeScene(f.snapshot().scene, id).encounter!.round).toBe(2);
    expect(
      f.db.prepare('SELECT check_key FROM rolls WHERE turn_id = ? ORDER BY check_key').all(turnId),
    ).toEqual(rolls);
  },
);

it('keeps victory loot and recovery local while an absent investigator ticks ailments and receives exploration rewards', async () => {
  const f = await table(true);
  const [fighter, caveScout, investigator] = f.members;
  const scene = f.snapshot().scene;
  scene.places![ravine].encounter = {
    enemies: [
      {
        ...enemy('ravine-raider', 1),
        maxHp: 1,
        initiative: 1,
        equipment: [baseItem('raider-knife', 'Raider knife', 'weapon')],
      },
    ],
    initiative: [
      { id: fighter.id, total: 30 },
      { id: 'ravine-raider', total: 1 },
    ],
    round: 1,
    victory: false,
    escaped: false,
  };
  f.saveScene(scene);
  investigator.state.hp -= 5;
  caveScout.state.hp -= 5;
  applyCondition(investigator.state, 'Burning');
  for (const member of [investigator, caveScout])
    f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(member.state), member.id);
  f.provider.resolve = async (context, tools) => {
    expect(context.combatResult?.participantIds).toEqual([fighter.id]);
    tools({
      memberId: investigator.id,
      stat: 'INT',
      dc: 10,
      mode: 'normal',
      lethal: false,
      reason: 'Read the map.',
    });
    return outcomeSchema.parse({
      narration: 'The map identifies the route.',
      summary: 'The route is identified.',
      choices: [],
      changes: [],
      journal: [],
      xp: 10,
      currency: 2,
    });
  };
  const id = await f.submit(['Attack ravine-raider.', '', 'Read the map.']);
  expect(f.snapshot().turn!.phase, f.snapshot().turn!.error ?? '').toBe('collecting');
  const after = f.game.members(f.campaign.id);
  expect(after[0].state.xp).toBe(30);
  expect(after[1].state.hp).toBe(caveScout.state.hp);
  expect(after[2].state.hp).toBeLessThan(investigator.state.hp);
  expect(after[2].state.xp).toBe(10);
  expect(after[2].state.currency).toBe(investigator.state.currency + 2);
  expect(placeScene(f.snapshot().scene, ravine).loot.map((item) => item.id)).toContain('raider-knife');
  expect(f.snapshot().scene.loot).toEqual([]);
  const saved = JSON.parse(
    (f.db.prepare('SELECT draft FROM turns WHERE id = ?').get(id) as { draft: string }).draft,
  );
  expect(saved.receipts.ailments.some((log: string) => log.includes('Burning'))).toBe(true);
});

it('places an explicitly targeted new-arrival encounter without moving the shared focus or attacking on arrival', async () => {
  const f = await table(true);
  const ref = 'new:raider-camp';
  f.provider.resolve = async (context, tools) => {
    const introduced = tools.startCombat([enemy('camp-raider')], ref);
    expect(tools.startCombat([enemy('ignored-on-retry')], ref)).toEqual(introduced);
    return outcomeSchema.parse({
      narration: 'Scout 0 reaches the raider camp.',
      summary: 'Scout 0 reaches the raider camp.',
      choices: [],
      changes: [],
      journal: [],
      placeUpdates: [
        {
          ref,
          location: {
            name: 'Raider camp',
            atmosphere: 'A raider blocks the approach.',
            hazard: 'An armed raider.',
          },
        },
      ],
      memberLocations: [{ memberId: f.members[0].id, locationId: ref }],
    });
  };
  const hp = f.members[0].state.hp;
  await f.submit(['Walk to the raider camp.', '', 'Read the map.']);
  const result = f.snapshot();
  expect(result.turn!.phase, result.turn!.error ?? '').toBe('collecting');
  expect(result.scene.location.name).toBe('Inn');
  const locationId = result.scene.memberLocations![f.members[0].id];
  expect(locationId).not.toBe(ravine);
  expect(placeScene(result.scene, locationId).location.name).toBe('Raider camp');
  expect(placeScene(result.scene, locationId).encounter).toMatchObject({
    round: 1,
    victory: false,
    enemies: [{ id: 'camp-raider', hp: 60 }],
  });
  expect(placeScene(result.scene, ravine).encounter).toBeNull();
  expect(f.game.members(f.campaign.id)[0].state.hp).toBe(hp);
});
