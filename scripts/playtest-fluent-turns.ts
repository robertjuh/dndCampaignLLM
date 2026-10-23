import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ChatGPTAuth } from '../server/auth';
import { openDatabase } from '../server/db';
import { Game, type GameMaster } from '../server/game';
import { ChatGPTGM, PracticeGM } from '../server/providers';
import { baseItem } from '../shared/rules';
import { campaignSchema, templateCharacter } from '../shared/schema';
import { ensureLocations } from '../shared/locations';

const { values } = parseArgs({
  options: {
    live: { type: 'boolean', default: false },
    model: { type: 'string' },
    case: { type: 'string' },
    output: { type: 'string' },
  },
});
const cases = [
  {
    name: 'explicit-pickup',
    text: 'Ik neem de verzegelde ampullen uit het open krat mee.',
    pickup: true,
    travel: false,
  },
  { name: 'missing-ship', text: 'We vliegen nu weg naar IJzerkeel.', pickup: false, travel: true },
  {
    name: 'pickup-and-travel',
    text: 'Ik pak de ampullen, zet het krat apart en loop naar de laadkade.',
    pickup: true,
    travel: true,
  },
];
const selected = cases.filter((scenario) => !values.case || scenario.name === values.case);
assert(selected.length, 'Unknown --case.');
if (!values.live) {
  console.table(selected);
  console.log('Preview only. Use --live --model <model-id> for isolated in-memory turns.');
} else {
  assert(values.model, 'Select the model explicitly with --model.');
  try {
    process.loadEnvFile(resolve('.env'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const auth = new ChatGPTAuth(join(resolve(process.env.GATHER_DATA_DIR ?? 'data'), 'credentials'));
  const owner = 'fluent-turn-playtest';
  assert(auth.status(owner).connected, 'Connect ChatGPT in Gather first.');
  const reports = [];
  for (const scenario of selected) {
    console.log(`Running ${scenario.name} in an isolated in-memory campaign…`);
    const db = openDatabase(':memory:');
    try {
      const gm = new ChatGPTGM(auth, owner, values.model);
      const practice = new PracticeGM();
      const provider: GameMaster = {
        adjudicate: (context, tools) =>
          context.turn.number ? gm.adjudicate(context, tools) : practice.adjudicate(context, tools),
        narrate: (resolution, config, budget) =>
          resolution.actions.length
            ? gm.narrate(resolution, config, budget)
            : practice.narrate(resolution, config),
      };
      const game = new Game(
        db,
        () => provider,
        (sides) => Math.min(12, sides),
      );
      const host = game.identify();
      const campaign = game.create(
        host.id,
        campaignSchema.parse({
          name: scenario.name,
          setting: 'A spaceport loading niche and its adjacent dock.',
          premise: 'Find a way to travel to IJzerkeel.',
          language: 'Nederlands',
          tone: 'Lively space pirates',
          instructions: '',
          custom: [],
          provider: 'chatgpt',
          model: values.model,
        }),
      );
      const players = [game.identify(), game.identify()];
      for (const [index, player] of players.entries()) {
        const character = game.saveCharacter(
          player.id,
          templateCharacter(index ? 'Waiting companion' : 'Rustbeard'),
        );
        game.join(campaign.inviteCode!, player.id, character.id);
        const member = game.members(campaign.id).find((member) => member.playerId === player.id)!;
        game.manageCharacter(campaign.id, player.id, {
          type: 'starter',
          itemIds: member.state.starterEquipment.slice(0, 2).map((item) => item.id),
        });
      }
      game.start(campaign.id, host.id);
      await game.idle();
      let snapshot = game.snapshot(campaign.id, host.id);
      assert.equal(snapshot.turn!.phase, 'collecting', snapshot.turn!.error ?? 'Opening failed.');
      const scene = ensureLocations(
        snapshot.scene,
        snapshot.members.map((member) => member.id),
      );
      const origin = scene.location.id!;
      const dock = randomUUID();
      scene.location = {
        id: origin,
        name: 'Overdekte laadnis',
        atmosphere:
          'Een open krat bevat verzegelde ampullen. Een openbare vrachtbrief noemt IJzerkeel. De open laadgang leidt naar de aangrenzende laadkade met openbare opstapplaatsen. Niemand bezit een schip.',
        hazard: '',
      };
      scene.loot = [{ ...baseItem('test-ampoules', 'Verzegelde ampullen', 'tool'), quantity: 1 }];
      scene.encounterRisk = { danger: 'safe', reason: 'Een rustige openbare laadnis.' };
      scene.places![dock] = {
        location: {
          id: dock,
          name: 'Laadkade',
          atmosphere: 'Openbare opstapplaatsen en een afvaartbord; geen eigendom of ticket is verkregen.',
          hazard: '',
        },
        encounter: null,
        loot: [],
        encounterRisk: { danger: 'safe', reason: 'Een rustige openbare laadkade.' },
      };
      scene.worldMap!.nodes[origin] = { id: origin, name: scene.location.name, visited: true };
      scene.worldMap!.nodes[dock] = { id: dock, name: 'Laadkade', visited: true };
      scene.worldMap!.connections.push({
        from: origin,
        to: dock,
        label: 'Open laadgang',
        blocked: false,
        bidirectional: true,
      });
      db.prepare('UPDATE campaigns SET scene = ? WHERE id = ?').run(JSON.stringify(scene), campaign.id);
      const turn = snapshot.turn!;
      game.submit(campaign.id, players[0].id, turn.id, scenario.text, false);
      game.submit(campaign.id, players[1].id, turn.id, '', true);
      await game.idle();
      snapshot = game.snapshot(campaign.id, host.id);
      const completed = snapshot.history.find(
        (turn) => turn.id === snapshot.history.at(-1)?.id && turn.number === 1,
      );
      const [actor, companion] = snapshot.members;
      const picked = actor.state.inventory.some((item) => item.id === 'test-ampoules');
      const moved = snapshot.scene.memberLocations![actor.id] === dock;
      const failures = [];
      if (!completed) failures.push(snapshot.turn?.error ?? 'Turn did not finish.');
      if (picked !== scenario.pickup)
        failures.push(`Pickup expected ${scenario.pickup}, observed ${picked}.`);
      if (moved !== scenario.travel) failures.push(`Travel expected ${scenario.travel}, observed ${moved}.`);
      if (snapshot.scene.memberLocations![companion.id] !== origin)
        failures.push('The waiting companion was moved.');
      const stages = (
        db
          .prepare("SELECT kind,payload FROM events WHERE turn_id=? AND kind LIKE 'stage:%'")
          .all(turn.id) as { kind: string; payload: string }[]
      ).map((row) => ({ stage: row.kind, ...JSON.parse(row.payload) }));
      const calls = stages.flatMap((stage) => stage.requestDiagnostics ?? []);
      const report = {
        case: scenario.name,
        passed: !failures.length,
        failures,
        requests: calls.length,
        durationMs: stages.reduce((sum, stage) => sum + stage.durationMs, 0),
        inputTokens: calls.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0),
        outputTokens: calls.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0),
        corrections: stages.flatMap((stage) => stage.corrections ?? []),
        actions: completed?.resolution?.actions,
        narration: completed?.result?.narration,
      };
      reports.push(report);
      console.log(
        JSON.stringify({
          case: report.case,
          passed: report.passed,
          requests: report.requests,
          durationMs: report.durationMs,
          corrections: report.corrections,
          failures,
        }),
      );
    } finally {
      db.close();
    }
  }
  if (values.output) writeFileSync(values.output, JSON.stringify(reports, null, 2) + '\n', { mode: 0o600 });
  if (reports.some((report) => !report.passed)) process.exitCode = 1;
}
