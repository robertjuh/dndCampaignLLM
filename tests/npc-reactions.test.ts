import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { Game, type GMContext, type GameMaster } from '../server/game';
import { openDatabase } from '../server/db';
import { ChatGPTGM, adjudicationInput } from '../server/providers';
import type { ChatGPTAuth } from '../server/auth';
import { normalizeCombatInput } from '../server/combat';
import { validateNPCReactions, journalWithNPCReactions } from '../server/npc-reactions';
import { engineEvents } from '../server/turn-resolution';
import { initialScene, initialState, baseItem, runCombat, rollEnemyLoot } from '../shared/rules';
import { ensureLocations } from '../shared/locations';
import { enemySchema, templateCharacter, type NPCReaction } from '../shared/schema';
import { factualNarration, turnAdjudicationSchema } from '../shared/turn-resolution';

const sourceId = 'journal:fact:De Scheve Lepel';
const evidence =
  'Captain Mara watches from the railing beside the gangway and commands the loader defending her ship.';
function reaction(): NPCReaction {
  return {
    npcId: 'captain-mara',
    npcName: 'Captain Mara',
    originLocationId: 'current',
    sourceId,
    evidence,
    reason: 'She can see the assault and intervenes to defend her crew and ship.',
    fact: 'Captain Mara leaves the railing and joins her loader at the gangway to defend the ship.',
    enemy: enemySchema.parse({
      id: 'captain-mara',
      name: 'Captain Mara',
      tier: 'normal',
      hp: 18,
      defense: 10,
      attack: 3,
      damage: '1d6',
      description: 'The established ship captain.',
      tactic: 'Defend her loader and the gangway.',
    }),
  };
}
function context(): GMContext {
  const id = randomUUID(),
    character = templateCharacter('Pirate');
  const member = {
    id,
    playerId: randomUUID(),
    characterId: randomUUID(),
    playerName: 'Player',
    character,
    active: true,
    state: initialState(character, id),
  };
  member.state.hp = member.state.maxHp = 100;
  member.state.equipment.right = {
    ...baseItem('sword', 'Boarding sword', 'weapon'),
    damage: '1d6',
    scaling: ['STR'],
  };
  const scene = ensureLocations(initialScene('Dock'), [id]);
  scene.encounter = {
    round: 1,
    victory: false,
    escaped: false,
    initiative: [
      { id, total: 20 },
      { id: 'loader', total: 10 },
    ],
    enemies: [
      {
        ...enemySchema.parse({
          id: 'loader',
          name: 'Ship loader',
          tier: 'normal',
          hp: 30,
          defense: 10,
          attack: 1,
          damage: '1d4',
          description: 'A crew member.',
          tactic: 'Guard the gangway.',
        }),
        maxHp: 30,
        initiative: 10,
        conditions: ['Weakened'],
        conditionTurns: { Weakened: 3 },
      },
    ],
  };
  return {
    config: {
      ruleset: 'roguelike-v1',
      name: 'Crew defence',
      setting: 'Dock',
      premise: 'Take the ship.',
      provider: 'chatgpt',
      model: 'test',
      language: 'English',
      tone: '',
      custom: [],
      instructions: '',
    },
    members: [member],
    startingMembers: structuredClone([member]),
    scene,
    journal: [{ kind: 'fact', name: 'De Scheve Lepel', detail: evidence }],
    history: [],
    receipts: {},
    turn: {
      id: randomUUID(),
      number: 2,
      phase: 'resolving',
      roster: [id],
      actions: [{ memberId: id, text: 'Ik klim het schip op en val Captain Mara aan.', passed: false }],
      rolls: [],
      result: null,
      error: null,
    },
  };
}
const close: (() => void)[] = [];
afterEach(() => close.splice(0).forEach((fn) => fn()));

it('resolves a combined approach and attack against a joining visible captain without changing existing enemies', () => {
  const c = context(),
    before = structuredClone(c.scene.encounter);
  const plan = normalizeCombatInput(c, {
    npcReactions: [reaction()],
    actions: [{ memberId: c.members[0].id, main: 'attack', targetId: 'captain-mara' }],
  });
  expect(plan.actions[0]).toMatchObject({ main: 'attack', targetId: 'captain-mara' });
  expect(c.scene.encounter).toEqual(before);
  c.turn.actions[0].text = 'Ik val Captain Mara niet aan; ik loop naar de reling.';
  expect(normalizeCombatInput(c, plan).actions[0].main).not.toBe('attack');
});

it('records a retreat and explains an unreachable named target without redirecting damage or spending a charge', () => {
  const c = context(),
    npc = reaction();
  npc.enemy = null;
  npc.evidence = 'Captain Mara has retreated behind the sealed bridge hatch and is already out of reach.';
  c.journal[0].detail = npc.evidence;
  npc.fact = 'Captain Mara remains behind the sealed bridge hatch and sounds the ship alarm.';
  const ability = c.members[0].character.abilities.find((ability) => ability.effect === 'strike')!;
  c.turn.actions[0].abilityName = ability.name;
  const before = structuredClone(c.members[0].state.abilityUses);
  const plan = normalizeCombatInput(c, {
    npcReactions: [npc],
    actions: [{ memberId: c.members[0].id, main: 'ability', abilityName: ability.name, targetId: npc.npcId }],
  });
  expect(plan.actions[0].blockedReason).toBe(npc.fact);
  const logs = runCombat(c.members, c.scene.encounter!, plan, (sides) => (sides === 20 ? 12 : 2));
  expect(logs.join(' ')).toContain('sealed bridge hatch');
  expect(c.scene.encounter!.enemies[0].hp).toBe(30);
  expect(c.members[0].state.abilityUses).toEqual(before);
  const receipts = { npcReactionsByLocation: { [c.scene.location.id!]: { reactions: [npc] } } };
  const journal = journalWithNPCReactions([], receipts, c.journal);
  expect(journal).toContainEqual({ kind: 'npc', name: npc.npcName, detail: npc.fact });
  expect(journalWithNPCReactions(journal, receipts, c.journal)).toEqual(journal);
  c.journal = [...c.journal, ...journal];
  expect(() => validateNPCReactions(c, [npc])).toThrow('current NPC journal decision');
  npc.sourceId = 'journal:npc:Captain Mara';
  npc.evidence = journal[0].detail;
  expect(validateNPCReactions(c, [npc])).toEqual([npc]);
});

it.each(['invented', 'distant', 'duplicate', 'dead', 'player', 'renamed', 'false-death'])(
  'rejects an unsupported %s NPC reaction before rolling',
  (defect) => {
    const c = context(),
      npc = reaction();
    let reactions = [npc];
    if (defect === 'invented') npc.evidence = 'Captain Mara has an invisible army hiding in the hold.';
    if (defect === 'distant') npc.originLocationId = randomUUID();
    if (defect === 'duplicate') reactions = [npc, structuredClone(npc)];
    if (defect === 'dead')
      c.scene.encounter!.enemies.push({ ...npc.enemy!, hp: 0, maxHp: 18, initiative: 8 });
    if (defect === 'player') npc.npcId = c.members[0].id;
    if (defect === 'renamed') npc.enemy!.name = 'Secret admiral';
    if (defect === 'false-death') npc.fact = 'Ship loader is dead. Captain Mara joins the fight.';
    expect(() => validateNPCReactions(c, reactions)).toThrow();
  },
);

it('plans NPC reactions in one request with default loot for an empty equipment list', async () => {
  const c = context();
  const npc = reaction();
  npc.enemy!.equipmentBlueprints = [];
  const output = normalizeCombatInput(c, {
    npcReactions: [npc],
    actions: [{ memberId: c.members[0].id, main: 'attack', targetId: 'captain-mara' }],
  });
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(init!.body as string),
      input = JSON.parse(body.input[0].content);
    expect(input.schemaExample.npcReactions).toEqual([]);
    expect(input.environmentalFacts[sourceId]).toBe(evidence);
    expect(body.instructions).toContain('Evaluate nearby established NPCs each round in this same response');
    expect(body.instructions).toContain('copy npcName literally from the quoted evidence');
    return new Response(
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }],
        },
      })}\n\n`,
    );
  }) as unknown as typeof fetch;
  const gm = new ChatGPTGM(
    { accessToken: async () => 'test' } as unknown as ChatGPTAuth,
    'owner',
    'test',
    fetcher,
  );
  const plan = await gm.planCombat(c);
  expect(plan.npcReactions).toEqual([npc]);
  const loot = rollEnemyLoot('captain', 1, plan.npcReactions![0].enemy!, () => 100);
  expect(loot).toHaveLength(1);
  expect(loot[0]).toMatchObject({ kind: 'weapon', rarity: 'Rare', damage: npc.enemy!.damage });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('preserves the named target when an unsupported NPC plan exhausts its existing repair budget', async () => {
  const c = context();
  const output = normalizeCombatInput(c, {
    npcReactions: [reaction()],
    actions: [
      {
        memberId: c.members[0].id,
        main: 'attack',
        targetId: 'captain-mara',
      },
    ],
  });
  output.npcReactions![0].evidence = 'Captain Mara commands an invented army from a distant castle.';
  const fetcher = vi.fn(
    async () =>
      new Response(
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }],
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
  const plan = await gm.planCombat(c);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(plan.npcReactions).toBeUndefined();
  expect(plan.actions[0].blockedReason).toContain('requested target');
  runCombat(c.members, c.scene.encounter!, plan, (sides) => (sides === 20 ? 12 : 2));
  expect(c.scene.encounter!.enemies[0].hp).toBe(30);
});

it('accepts an established neighbour over an open route and rejects blocked or unvisited origins', () => {
  const c = context(),
    npc = reaction(),
    deck = randomUUID();
  c.scene.places![deck] = {
    location: { id: deck, name: 'Upper deck', atmosphere: evidence, hazard: '' },
    encounter: null,
    loot: [],
  };
  c.scene.worldMap!.nodes[deck] = { id: deck, name: 'Upper deck', visited: true };
  const route = {
    from: deck,
    to: c.scene.location.id!,
    label: 'Gangway',
    blocked: false,
    bidirectional: false,
  };
  c.scene.worldMap!.connections.push(route);
  npc.originLocationId = deck;
  npc.sourceId = `nearby:${deck}:scene:Upper deck:atmosphere`;
  expect(validateNPCReactions(c, [npc])).toEqual([npc]);
  route.blocked = true;
  expect(() => validateNPCReactions(c, [npc])).toThrow('local or openly adjacent');
  route.blocked = false;
  c.scene.worldMap!.nodes[deck].visited = false;
  expect(() => validateNPCReactions(c, [npc])).toThrow('local or openly adjacent');
});

it.each(['after-arrival', 'after-resolution'] as const)(
  'keeps NPC arrival, initiative, loot and targeting through restart %s',
  async (interruption) => {
    const db = openDatabase(':memory:');
    close.push(() => db.close());
    let pause = false,
      twenties = 0;
    const draw = vi.fn((sides: number) => {
      if (pause && interruption === 'after-arrival' && sides === 20 && ++twenties === 2)
        throw new Error('Interrupted after the saved NPC arrival.');
      return sides === 20 ? 12 : sides === 100 ? 90 : 2;
    });
    const planCombat = vi.fn(async (c: GMContext) =>
      normalizeCombatInput(c, {
        npcReactions: c.scene.encounter!.enemies.some((enemy) => enemy.id === 'captain-mara')
          ? []
          : [reaction()],
        actions: c.turn.actions
          .filter((action) => !action.passed)
          .map((action) => ({ memberId: action.memberId, main: 'attack', targetId: 'captain-mara' })),
      }),
    );
    const provider: GameMaster = {
      planCombat,
      adjudicate: async (c) => {
        const value = adjudicationInput(c).schemaExample;
        return turnAdjudicationSchema.parse({
          ...value,
          events: [...engineEvents(c), ...value.events],
          arrivals: undefined,
          encounterRisks: undefined,
          worldProgress: undefined,
        });
      },
      narrate: async (resolution, config) => {
        if (pause && interruption === 'after-resolution')
          throw new Error('Interrupted after saved resolution.');
        return factualNarration(resolution, config.language);
      },
    };
    let game = new Game(db, () => provider, draw);
    const host = game.identify(),
      player = game.identify();
    const campaign = game.create(host.id, {
      name: 'Ship crew',
      setting: 'Dock',
      premise: 'Take the ship.',
      provider: 'practice',
      language: 'English',
      instructions: '',
      tone: '',
      custom: [],
    });
    const character = templateCharacter('Pirate');
    character.selectedEquipmentIds = character.equipmentOptions.slice(0, 2).map((item) => item.id);
    game.join(campaign.inviteCode!, player.id, game.saveCharacter(player.id, character).id);
    game.start(campaign.id, host.id);
    await game.idle();
    const snapshot = () => game.snapshot(campaign.id, host.id);
    expect(snapshot().turn!.phase, snapshot().turn!.error ?? '').toBe('collecting');
    const member = game.members(campaign.id)[0],
      scene = snapshot().scene;
    const original = context().scene.encounter!;
    original.initiative[0].id = member.id;
    scene.encounter = original;
    member.state.hp = member.state.maxHp = 100;
    member.state.equipment.right = {
      ...baseItem('sword', 'Boarding sword', 'weapon'),
      damage: '1d6',
      scaling: ['STR'],
    };
    db.prepare('UPDATE members SET state=? WHERE id=?').run(JSON.stringify(member.state), member.id);
    db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(scene), campaign.id);
    db.prepare('INSERT INTO journal(campaign_id,kind,name,detail) VALUES(?,?,?,?)').run(
      campaign.id,
      'fact',
      'De Scheve Lepel',
      evidence,
    );
    pause = true;
    const turnId = snapshot().turn!.id;
    const draft = () =>
      JSON.parse((db.prepare('SELECT draft FROM turns WHERE id=?').get(turnId) as { draft: string }).draft);
    if (interruption === 'after-resolution')
      db.exec(
        `CREATE TRIGGER interrupt_narration BEFORE UPDATE OF draft ON turns WHEN NEW.draft LIKE '%"narration":%' BEGIN SELECT RAISE(ABORT, 'narration checkpoint interrupted'); END;`,
      );
    game.submit(campaign.id, player.id, turnId, 'Ik klim het schip op en val Captain Mara aan.', false);
    await game.idle();
    expect(snapshot().turn!.phase, snapshot().turn!.error ?? '').toBe('failed');
    const interrupted = draft();
    const captain = interrupted.scene.encounter.enemies.find(
      (enemy: { id: string }) => enemy.id === 'captain-mara',
    );
    expect(captain).toBeTruthy();
    const loot = structuredClone(captain.equipment);
    if (interruption === 'after-arrival')
      expect(interrupted.scene.encounter.enemies[0]).toEqual(original.enemies[0]);
    pause = false;
    db.exec('DROP TRIGGER IF EXISTS interrupt_narration');
    game = new Game(db, () => provider, draw);
    game.retry(campaign.id, host.id);
    await game.idle();
    expect(snapshot().turn!.phase, snapshot().turn!.error ?? '').toBe('collecting');
    const result = snapshot(),
      saved = draft();
    expect(planCombat).toHaveBeenCalledTimes(1);
    expect(result.scene.encounter!.enemies.map((enemy) => enemy.id)).toEqual(['loader', 'captain-mara']);
    expect(result.scene.encounter!.enemies[0].hp).toBe(30);
    expect(result.scene.encounter!.enemies[1].hp).toBeLessThan(18);
    expect(result.scene.encounter!.enemies[1].equipment).toEqual(loot);
    expect(result.scene.encounter!.initiative.filter((entry) => entry.id === 'captain-mara')).toHaveLength(1);
    expect(
      saved.receipts.combat.logs.some((fact: string) => /^Captain Mara (?:hits|misses)/.test(fact)),
    ).toBe(false);
    expect(
      saved.resolution.events.filter((event: { id: string }) => event.id.startsWith('npc:')),
    ).toHaveLength(1);
    expect(
      result.journal.find((entry) => entry.kind === 'npc' && entry.name === 'Captain Mara')!.detail,
    ).toContain('joins her loader');
    const next = result.turn!.id;
    game.submit(campaign.id, player.id, next, 'Attack Captain Mara.', false);
    await game.idle();
    expect(snapshot().turn!.phase, snapshot().turn!.error ?? '').toBe('collecting');
    const nextDraft = JSON.parse(
      (db.prepare('SELECT draft FROM turns WHERE id=?').get(next) as { draft: string }).draft,
    );
    expect(
      nextDraft.receipts.combat.logs.some((fact: string) => /^Captain Mara (?:hits|misses)/.test(fact)),
    ).toBe(true);
    const wounded = snapshot().scene;
    wounded.encounter!.enemies.find((enemy) => enemy.id === 'captain-mara')!.hp = 1;
    db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(wounded), campaign.id);
    game.submit(campaign.id, player.id, snapshot().turn!.id, 'Attack Captain Mara.', false);
    await game.idle();
    expect(snapshot().turn!.phase, snapshot().turn!.error ?? '').toBe('collecting');
    expect(
      snapshot().journal.find((entry) => entry.kind === 'npc' && entry.name === 'Captain Mara')!.detail,
    ).toContain('Captain Mara died in the fight.');
  },
);
