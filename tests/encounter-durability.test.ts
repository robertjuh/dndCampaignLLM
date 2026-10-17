import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { openDatabase } from '../server/db';
import { Game, type GameMaster } from '../server/game';
import { adjudicationInput } from '../server/providers';
import { engineEvents } from '../server/turn-resolution';
import { templateCharacter } from '../shared/schema';
import { factualNarration, turnAdjudicationSchema } from '../shared/turn-resolution';

it('preserves an earlier local encounter die when a later draw fails before draft save', async () => {
  const db = openDatabase(':memory:');
  try {
    const provider: GameMaster = {
      adjudicate: async (context, tools) => {
        const value = turnAdjudicationSchema.parse(adjudicationInput(context).schemaExample);
        value.events = [...engineEvents(context), ...value.events];
        // This provider keeps the accepted legacy opening contract; the test targets scheduler storage.
        value.arrivals = undefined;
        value.worldProgress = undefined;
        value.encounterRisks = context.turn.number ? [] : undefined;
        if (context.turn.number) tools.prepareEncounters!(tools.validateAdjudication!(value));
        return value;
      },
      narrate: async (resolution, config) => factualNarration(resolution, config.language),
    };
    let encounterDraws = 0;
    let game = new Game(
      db,
      () => provider,
      (sides) => {
        if (sides !== 6) return Math.min(12, sides);
        if (++encounterDraws === 1) return 2;
        throw new Error('The second location exhausted the random source.');
      },
    );
    const host = game.identify();
    const players = [game.identify(), game.identify()];
    const campaign = game.create(host.id, {
      name: 'Durable encounters',
      setting: 'Old roads',
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
      game.join(campaign.inviteCode!, player.id, game.saveCharacter(player.id, character).id);
    }
    game.start(campaign.id, host.id);
    await game.idle();
    const snapshot = game.snapshot(campaign.id, host.id);
    expect(snapshot.turn!.phase, snapshot.turn!.error ?? '').toBe('collecting');
    const scene = snapshot.scene;
    const first = scene.location.id!;
    const second = randomUUID();
    scene.encounterRisk = { danger: 'dangerous', reason: 'Raiders patrol this road.' };
    scene.places![second] = {
      location: { id: second, name: 'Ravine', atmosphere: '', hazard: 'Hostile patrols' },
      encounter: null,
      loot: [],
      encounterRisk: { danger: 'dangerous', reason: 'Raiders occupy this ravine.' },
    };
    scene.memberLocations![snapshot.members[1].id] = second;
    db.prepare('UPDATE campaigns SET scene = ? WHERE id = ?').run(JSON.stringify(scene), campaign.id);
    const turnId = snapshot.turn!.id;
    for (const player of players) game.submit(campaign.id, player.id, turnId, 'Observe the route.', false);
    await game.idle();
    expect(game.snapshot(campaign.id, host.id).turn!.phase).toBe('failed');
    const saved = db
      .prepare('SELECT result FROM rolls WHERE turn_id = ? AND check_key = ?')
      .get(turnId, `encounter:${first}`) as { result: string };
    expect(JSON.parse(saved.result).dice).toEqual([2]);
    const retriedDraws: number[] = [];
    game = new Game(
      db,
      () => provider,
      (sides) => {
        retriedDraws.push(sides);
        return sides;
      },
    );
    game.retry(campaign.id, host.id);
    await game.idle();
    const retried = game.snapshot(campaign.id, host.id);
    expect(retried.turn!.phase, retried.turn!.error ?? '').toBe('collecting');
    expect(retriedDraws).toEqual([6]);
    const draft = JSON.parse(
      (db.prepare('SELECT draft FROM turns WHERE id = ?').get(turnId) as { draft: string }).draft,
    );
    expect(draft.receipts.encounterChecks[first].die).toBe(2);
    expect(draft.receipts.encounterChecks[second].die).toBe(6);
  } finally {
    db.close();
  }
});
