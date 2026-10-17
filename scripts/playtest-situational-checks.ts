import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { ChatGPTAuth } from '../server/auth';
import { openDatabase } from '../server/db';
import { Game, type GameMaster } from '../server/game';
import { ChatGPTGM, PracticeGM } from '../server/providers';
import { baseItem } from '../shared/rules';
import { templateCharacter, type CampaignConfig } from '../shared/schema';

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
    name: 'friendly-moth',
    detail:
      'The postmoth publicly admires Flo, recognizes the visible emblem and is sympathetic to her supporters.',
    favorable: true,
    adverse: false,
    mode: 'advantage',
    ability: false,
  },
  {
    name: 'hostile-moth',
    detail:
      'The postmoth openly supports Fort Foliant, which imprisoned Flo. She recognizes Flo’s emblem and is guarded toward its supporters.',
    favorable: false,
    adverse: true,
    mode: 'disadvantage',
    ability: false,
  },
  {
    name: 'mixed-with-ability',
    detail:
      'The postmoth publicly admires Flo and recognizes her emblem. A uniformed Fort Foliant guard stands beside the desk within earshot; the moth visibly hesitates to discuss Flo in front of him.',
    favorable: true,
    adverse: true,
    mode: 'normal',
    ability: true,
  },
  {
    name: 'irrelevant-distant-factors',
    detail:
      'The postmoth does not recognize the banner and has no association with either Flo or Fort Foliant. A hostile guard is in a distant sealed room and cannot see or hear this desk. Wind outside the soundproof, closed windows does not reach this room.',
    favorable: false,
    adverse: false,
    mode: 'normal',
    ability: false,
  },
] as const;
const selected = cases.filter((scenario) => !values.case || values.case === scenario.name);
assert(selected.length, 'Unknown --case.');
if (!values.live) {
  console.log('Preview only. Add --live --model <model-id> to use the connected ChatGPT account.');
  console.table(selected.map(({ name, favorable, adverse, mode }) => ({ name, favorable, adverse, mode })));
} else {
  const model = values.model;
  assert(model, 'Choose the playtest model with --model <model-id>.');
  try {
    process.loadEnvFile(resolve('.env'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const auth = new ChatGPTAuth(join(resolve(process.env.GATHER_DATA_DIR ?? 'data'), 'credentials'));
  const owner = 'situational-check-playtest';
  assert(auth.status(owner).connected, 'Connect ChatGPT in Gather first.');
  const gm = new ChatGPTGM(auth, owner, model);
  const practice = new PracticeGM();
  const reports = await Promise.all(
    selected.map(async (scenario) => {
      console.log(`Running ${scenario.name} with ${model} in an isolated in-memory campaign…`);
      const db = openDatabase(':memory:');
      try {
        const background = `The knight’s banner with Flo’s emblem hangs visibly at his shoulder. The enclosed post desk is quiet and well lit. The postmoth has personally seen a prison scroll bearing Flo’s seal sent along the Hanging Postline to Fluff Quay and handed to a Fort Foliant courier. She knows no cell location. Disclosing these confidential postal records requires persuasion, even to a sympathetic listener. ${scenario.detail}`;
        const provider: GameMaster = {
          async adjudicate(context, tools) {
            if (context.turn.number) return gm.adjudicate(context, tools);
            const opening = await practice.adjudicate(context, tools);
            opening.events[0].fact = background;
            opening.journal = [{ kind: 'npc', name: 'Postmoth', detail: background }];
            return opening;
          },
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
        const player = game.identify();
        const config: CampaignConfig = {
          ruleset: 'roguelike-v1',
          name: scenario.name,
          setting: 'Hanging Postline, enclosed post desk',
          premise: 'The knight seeks the imprisoned Princess Flo.',
          tone: 'Whimsical fantasy, immersive and concise',
          instructions: '',
          custom: [],
          language: 'English',
          provider: 'chatgpt',
          model,
        };
        const campaign = game.create(host.id, config);
        const character = templateCharacter('The winged knight');
        character.concept = 'A knight seeking Princess Flo, carrying her visible banner.';
        const ability = character.abilities.find((ability) => ability.kind === 'utility')!;
        Object.assign(ability, {
          name: 'Courteous appeal',
          description: 'Focus on public words and social cues while making a persuasive appeal.',
          stat: 'CHA',
        });
        const saved = game.saveCharacter(player.id, character);
        game.join(campaign.inviteCode!, player.id, saved.id);
        const member = game.members(campaign.id)[0];
        game.manageCharacter(campaign.id, player.id, {
          type: 'starter',
          itemIds: member.state.starterEquipment.slice(0, 2).map((item) => item.id),
        });
        const prepared = game.members(campaign.id)[0];
        for (const slot of Object.keys(prepared.state.equipment) as (keyof typeof prepared.state.equipment)[])
          prepared.state.equipment[slot] = null;
        prepared.state.inventory = [{ ...baseItem('flo-banner', 'Flo’s banner', 'tool'), quantity: 1 }];
        for (const stat of Object.keys(prepared.state.stats) as (keyof typeof prepared.state.stats)[])
          prepared.state.stats[stat] = 5;
        db.prepare('UPDATE members SET state = ? WHERE id = ?').run(
          JSON.stringify(prepared.state),
          member.id,
        );
        game.start(campaign.id, host.id);
        await game.idle();
        const turn = game.snapshot(campaign.id, host.id).turn!;
        assert.equal(turn.phase, 'collecting', turn.error ?? 'Opening failed.');
        game.submit(
          campaign.id,
          player.id,
          turn.id,
          `${scenario.ability ? 'I use Courteous appeal to' : 'I'} politely persuade the postmoth to tell me what she knows about Flo’s whereabouts.`,
          false,
          false,
          scenario.ability ? ability.name : null,
        );
        await game.idle();
        const snapshot = game.snapshot(campaign.id, host.id);
        const completed = snapshot.history.find((item) => item.id === turn.id);
        const stages = Object.fromEntries(
          (
            db
              .prepare(
                "SELECT kind, payload FROM events WHERE turn_id = ? AND kind LIKE 'stage:%' ORDER BY id",
              )
              .all(turn.id) as { kind: string; payload: string }[]
          ).map(({ kind, payload }) => [kind.slice(6), JSON.parse(payload)]),
        );
        const roll = completed?.rolls[0];
        const failures = [];
        if (!completed) failures.push(snapshot.turn?.error ?? 'Turn did not finish.');
        if (completed?.rolls.length !== 1) failures.push('Expected exactly one inquiry check.');
        if (roll?.mode !== scenario.mode) failures.push(`Expected mode ${scenario.mode}.`);
        if (
          roll?.circumstances?.favorable !== scenario.favorable ||
          roll?.circumstances?.adverse !== scenario.adverse
        )
          failures.push('Contextual flags do not match the established circumstances.');
        if (scenario.ability && roll?.abilityName !== ability.name)
          failures.push('Requested ability was omitted.');
        if (stages.narration?.fallback) failures.push('Narration fell back to the factual recap.');
        const report = {
          case: scenario.name,
          passed: failures.length === 0,
          failures,
          roll,
          actions: completed?.resolution?.actions,
          narration: completed?.result?.narration,
          diagnostics: completed?.diagnostics,
          stages,
        };
        console.log(
          JSON.stringify({
            case: report.case,
            passed: report.passed,
            failures,
            roll,
            narration: report.narration,
            diagnostics: report.diagnostics,
            requests: Object.fromEntries(
              Object.entries(stages).map(([stage, data]) => [stage, data.requests ?? 0]),
            ),
          }),
        );
        return report;
      } finally {
        db.close();
      }
    }),
  );
  if (values.output) writeFileSync(values.output, JSON.stringify({ model, reports }, null, 2));
  if (reports.some((report) => !report.passed)) process.exitCode = 1;
}
