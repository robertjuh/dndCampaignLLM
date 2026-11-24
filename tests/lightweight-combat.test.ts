import { afterEach, expect, it, vi } from 'vitest';
import { ChatGPTAuth } from '../server/auth';
import { openDatabase } from '../server/db';
import { Game, type GameMaster, type GMContext } from '../server/game';
import { normalizeCombatInput } from '../server/combat';
import { ChatGPTGM, PracticeGM } from '../server/providers';
import { placeScene, savePlace } from '../shared/locations';
import { prepareEnemyIntents } from '../shared/rules';
import { enemySchema, templateCharacter } from '../shared/schema';
import { interruptNarration } from './narration-interruption';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));

it.each([
  { interrupt: false, unavailable: false },
  { interrupt: true, unavailable: false },
  { interrupt: false, unavailable: true },
])(
  'uses one interpretation request and local combat presentation, preserving all receipts (interrupt=$interrupt, unavailable=$unavailable)',
  async ({ interrupt, unavailable }) => {
    const db = openDatabase(':memory:');
    cleanup.push(() => db.close());
    let provider: GameMaster = new PracticeGM();
    const combatFaces: number[] = [];
    const draw = vi.fn((sides: number) => (sides === 20 ? combatFaces.shift() ?? 12 : Math.min(2, sides)));
    let game = new Game(db, () => provider, draw);
    const host = game.identify();
    const players = [game.identify(), game.identify()];
    const campaign = game.create(host.id, {
      name: 'Team combat',
      setting: 'Training hall',
      premise: '',
      tone: '',
      language: 'English',
      instructions: '',
      custom: [],
      provider: 'practice',
    });
    for (const [index, player] of players.entries()) {
      const character = templateCharacter(`Fighter ${index}`);
      character.personality = index === 0 ? 'A proud knight with a dry sense of humor.' : 'A nervous, meticulous scholar.';
      character.selectedEquipmentIds = character.equipmentOptions.slice(0, 3).map((item) => item.id);
      const saved = game.saveCharacter(player.id, character);
      game.join(campaign.inviteCode!, player.id, saved.id);
    }
    game.start(campaign.id, host.id);
    await game.idle();
    const snapshot = () => game.snapshot(campaign.id, host.id);
    const scene = snapshot().scene;
    const members = game.members(campaign.id);
    const selectedAbility = members[0].character.abilities.find((ability) => ability.effect === 'strike')!;
    if (unavailable) {
      members[0].state.abilityUses ??= {};
      members[0].state.abilityUses[selectedAbility.name] = 1;
      db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(members[0].state), members[0].id);
    }
    const encounter = {
      enemies: [
        {
          ...enemySchema.parse({
            id: 'training-guard',
            name: 'Training guard',
            tier: 'normal',
            hp: 150,
            defense: 10,
            attack: 0,
            damage: '1d4',
            description: 'An armed training guard.',
            tactic: '',
          }),
          maxHp: 150,
          initiative: 1,
        },
      ],
      round: 1,
      victory: false,
      escaped: false,
      initiative: [
        ...members.map((member) => ({ id: member.id, total: 15 })),
        { id: 'training-guard', total: 1 },
      ],
    };
    prepareEnemyIntents(members, encounter);
    scene.encounter = encounter;
    savePlace(scene, { ...placeScene(scene, scene.location.id!), encounter });
    db.prepare('UPDATE campaigns SET scene = ? WHERE id = ?').run(JSON.stringify(scene), campaign.id);
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const data = JSON.parse(JSON.parse(init!.body as string).input[0].content);
      const plan = data.schemaExample;
      expect(data.members.map((member: { character: { personality: string } }) => member.character.personality))
        .toEqual(['A proud knight with a dry sense of humor.', 'A nervous, meticulous scholar.']);
      plan.voiceLines = [
        { actorId: members[0].id, line: 'Your manners are worse than your swordplay.' },
        { actorId: members[1].id, line: 'Steady hands. Just like the diagrams.' },
        { actorId: 'training-guard', line: 'You will go no further!' },
      ];
      plan.actions[0].rollEffect = {
        effect: 'hinder',
        targetId: 'training-guard',
        intent: 'strike Training guard in the arm to disrupt their attack',
        reason: 'The strike throws off the guard’s attack.',
      };
      if (interrupt) {
        try {
          interruptNarration(db, 'Storage interruption after combat.');
        } catch {
          /* installed before execution */
        }
      }
      const body = `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(plan) }] }],
        },
      })}\n\n`;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          },
        }),
      );
    });
    provider = new ChatGPTGM(
      { accessToken: async () => 'test-token' } as unknown as ChatGPTAuth,
      'owner',
      'test-model',
      fetcher as typeof fetch,
    );
    const turnId = snapshot().turn!.id;
    combatFaces.push(12, 12, 16, 7);
    players.forEach((player, index) =>
      game.submit(
        campaign.id,
        player.id,
        turnId,
        'I strike Training guard in the arm to disrupt their attack.',
        false,
        false,
        unavailable && index === 0 ? selectedAbility.name : null,
      ),
    );
    await game.idle();
    const saved = () =>
      JSON.parse((db.prepare('SELECT draft FROM turns WHERE id = ?').get(turnId) as { draft: string }).draft);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(saved().receipts.combat, snapshot().turn!.error ?? '').toBeDefined();
    expect(saved().receipts.combat.logs.filter((fact: string) => fact.startsWith('Teamwork:'))).toHaveLength(
      1,
    );
    expect(saved().receipts.lightweightCombat, snapshot().turn!.error ?? '').toBe(true);
    if (interrupt) {
      expect(snapshot().turn!.phase, snapshot().turn!.error ?? '').toBe('failed');
      const receipt = saved().receipts.combat;
      const rolls = db.prepare('SELECT * FROM rolls WHERE turn_id = ? ORDER BY rowid').all(turnId);
      db.exec('DROP TRIGGER interrupt_narration_save');
      const noDice = vi.fn(() => {
        throw new Error('Saved combat must not reroll.');
      });
      game = new Game(db, () => provider, noDice);
      game.retry(campaign.id, host.id);
      await game.idle();
      expect(saved().receipts.combat).toEqual(receipt);
      expect(db.prepare('SELECT * FROM rolls WHERE turn_id = ? ORDER BY rowid').all(turnId)).toEqual(rolls);
      expect(noDice).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    expect(snapshot().turn!.phase, snapshot().turn!.error ?? '').toBe('collecting');
    const result = snapshot().history.find((turn) => turn.id === turnId)!.result!;
    expect(result.narration).toContain(unavailable ? 'acts on instinct' : 'disadvantage');
    if (!unavailable) {
      const round = snapshot().history.find((turn) => turn.id === turnId)!;
      const enemyRoll = round.rolls.find((roll) => roll.mode === 'disadvantage');
      expect(enemyRoll).toMatchObject({ dice: [16, 7], keptDie: 7, reason: 'The strike throws off the guard’s attack.' });
    }
    if (unavailable) expect(snapshot().members[0].state.abilityUses?.[selectedAbility.name]).toBe(1);
    expect(result.narration).toContain('Teamwork:');
    expect(result.narration).toContain('Fighter 0');
    expect(result.narration).toContain('Fighter 1');
    for (const line of ['Your manners are worse than your swordplay.', 'Steady hands. Just like the diagrams.', 'You will go no further!']) {
      expect(result.narration.split(line)).toHaveLength(2);
      expect(result.summary).not.toContain(line);
    }
    expect(saved().receipts.combat.events.filter((event: { dialogue?: true }) => event.dialogue)).toHaveLength(3);
  },
);

it('recovers a combat turn with an inactive fight that has no visible events, without rerolling', async () => {
  const db = openDatabase(':memory:');
  cleanup.push(() => db.close());
  let provider: GameMaster = new PracticeGM();
  let game = new Game(db, () => provider, (sides) => Math.min(12, sides));
  const host = game.identify();
  const players = [game.identify(), game.identify()];
  const campaign = game.create(host.id, {
    name: 'Separated fights', setting: 'Training hall', premise: '', tone: '',
    language: 'English', instructions: '', custom: [], provider: 'practice',
  });
  for (const [index, player] of players.entries()) {
    const character = templateCharacter(`Fighter ${index}`);
    character.selectedEquipmentIds = character.equipmentOptions.slice(0, 3).map((item) => item.id);
    const saved = game.saveCharacter(player.id, character);
    game.join(campaign.inviteCode!, player.id, saved.id);
  }
  game.start(campaign.id, host.id);
  await game.idle();
  const members = game.members(campaign.id);
  const scene = game.snapshot(campaign.id, host.id).scene;
  const idlePlace = '11111111-1111-4111-8111-111111111111';
  const encounter = (id: string, name: string, memberId: string) => ({
    enemies: [{
      ...enemySchema.parse({
        id, name, tier: 'normal', hp: 150, defense: 10, attack: 0,
        damage: '1d4', description: 'An armed training guard.', tactic: '',
      }),
      maxHp: 150, initiative: 1,
    }],
    round: 1, victory: false, escaped: false,
    initiative: [{ id: memberId, total: 15 }, { id, total: 1 }],
  });
  scene.encounter = encounter('training-guard', 'Training guard', members[0].id);
  savePlace(scene, { ...placeScene(scene, scene.location.id!), encounter: scene.encounter });
  scene.places![idlePlace] = {
    location: { id: idlePlace, name: 'Other hall', atmosphere: 'A separate training room.', hazard: '' },
    encounter: encounter('idle-guard', 'Idle guard', members[1].id),
    encounterRisk: { danger: 'dangerous', reason: 'An armed guard is present.' },
    loot: [],
  };
  scene.worldMap!.nodes[idlePlace] = { id: idlePlace, name: 'Other hall', visited: true };
  scene.memberLocations![members[1].id] = idlePlace;
  db.prepare('UPDATE campaigns SET scene = ? WHERE id = ?').run(JSON.stringify(scene), campaign.id);
  game.setActive(campaign.id, host.id, members[1].id, false);
  const turnId = game.snapshot(campaign.id, host.id).turn!.id;
  const planCombat = vi.fn(async (context: GMContext) => normalizeCombatInput(context));
  const unexpected = vi.fn(async () => { throw new Error('Saved combat needs no extra model request.'); });
  provider = { sceneTurns: true, lightweightCombat: true, planCombat, adjudicate: unexpected, narrate: unexpected };
  db.exec(`CREATE TRIGGER interrupt_narration_save BEFORE UPDATE OF draft ON turns
    WHEN NEW.draft LIKE '%"narration":%'
    BEGIN SELECT RAISE(ABORT, 'Interrupt after combat is saved.'); END;`);
  game.submit(campaign.id, players[0].id, turnId, 'Attack Training guard.', false);
  await game.idle();
  const saved = () => JSON.parse(
    (db.prepare('SELECT draft FROM turns WHERE id = ?').get(turnId) as { draft: string }).draft,
  );
  expect(game.snapshot(campaign.id, host.id).turn!.phase).toBe('failed');
  expect(saved().receipts.combatByLocation[idlePlace].events).toEqual([]);
  const receipts = saved().receipts.combatByLocation;
  const rolls = db.prepare('SELECT * FROM rolls WHERE turn_id = ? ORDER BY rowid').all(turnId);
  const requests = planCombat.mock.calls.length;
  db.exec('DROP TRIGGER interrupt_narration_save');
  const noDice = vi.fn(() => { throw new Error('Saved combat must not reroll.'); });
  game = new Game(db, () => provider, noDice);
  game.retry(campaign.id, host.id);
  await game.idle();
  const snapshot = game.snapshot(campaign.id, host.id);
  expect(snapshot.turn!.phase, snapshot.turn!.error ?? '').toBe('collecting');
  expect(saved().receipts.lightweightCombat).toBe(true);
  expect(saved().receipts.combatByLocation).toEqual(receipts);
  expect(db.prepare('SELECT * FROM rolls WHERE turn_id = ? ORDER BY rowid').all(turnId)).toEqual(rolls);
  expect(noDice).not.toHaveBeenCalled();
  expect(planCombat).toHaveBeenCalledTimes(requests);
  expect(unexpected).not.toHaveBeenCalled();
  const narration = snapshot.history.find((turn) => turn.id === turnId)!.result!.narration;
  expect(narration).toContain('Training guard');
  expect(narration).not.toContain('Idle guard');
});
