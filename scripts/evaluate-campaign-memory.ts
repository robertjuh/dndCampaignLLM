import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ChatGPTAuth } from '../server/auth';
import { openDatabase } from '../server/db';
import { Game, type GameMaster } from '../server/game';
import { ChatGPTGM, PracticeGM } from '../server/providers';
import { templateCharacter, type CampaignConfig } from '../shared/schema';

const { values } = parseArgs({
  options: {
    live: { type: 'boolean', default: false },
    model: { type: 'string' },
    output: { type: 'string' },
    case: { type: 'string' },
  },
});
const scenarios = [
  {
    name: 'workshop-agreement',
    language: 'English' as const,
    setting: 'A cheerful orbital repair workshop',
    person: 'Mira',
    aliases: ['the mechanic'],
    place: 'Workshop',
    fact: 'Mira promised shelter in the Copper Kite attic if the party repaired the beacon. She did not promise money or equipment.',
    needle: 'Copper Kite',
    action: 'Ask the mechanic to remind me where she said we could shelter if we repaired the beacon.',
    current: 'Mira is at the workbench. A beacon awaits repair. The workshop is open to visitors.',
  },
  {
    name: 'harbour-agreement',
    language: 'Nederlands' as const,
    setting: 'Een havenstad op de rug van een reuzenschildpad',
    person: 'Oda',
    aliases: ['de havenmeester'],
    place: 'Havenkantoor',
    fact: 'Oda beloofde onderdak in de toren van de Zilveren Schelp als de groep de seinlamp herstelt. Er is geen geld of uitrusting beloofd.',
    needle: 'Zilveren Schelp',
    action:
      'Vraag de havenmeester waar we volgens onze afspraak kunnen slapen als we de seinlamp herstellen.',
    current: 'Oda werkt aan een bureau. De seinlamp wacht op reparatie. Het havenkantoor is toegankelijk.',
  },
  {
    name: 'failed-search',
    language: 'English' as const,
    setting: 'A rain-soaked orbital salvage yard',
    person: 'Tal',
    aliases: ['the caretaker'],
    place: 'Salvage yard',
    fact: 'Tal heard the noon bell yesterday.',
    needle: '',
    action: 'Inspect the washed-out footprints to identify where the thief escaped.',
    current:
      'Heavy rain has smeared many overlapping bootprints across the yard. Identifying the thief’s tracks is uncertain. An open drainage channel and a sheltered tool alcove are visible.',
  },
];
const selected = scenarios.filter((scenario) => !values.case || scenario.name === values.case);
assert(selected.length, 'Unknown --case.');

if (!values.live) {
  console.table(scenarios.map(({ name, language, needle }) => ({ name, language, expectedMemory: needle })));
  console.log(
    'Preview only. Use node --import tsx scripts/evaluate-campaign-memory.ts --live --model <model> --output <report.json>.',
  );
} else {
  assert(values.model, 'Select a model with --model.');
  try {
    process.loadEnvFile(resolve('.env'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const auth = new ChatGPTAuth(join(resolve(process.env.GATHER_DATA_DIR ?? 'data'), 'credentials'));
  const owner = 'campaign-memory-evaluation';
  assert(auth.status(owner).connected, 'Connect ChatGPT in Gather before live evaluation.');
  const previousMemory = process.env.GATHER_CAMPAIGN_MEMORY;
  const reports: Record<string, unknown>[] = [];
  try {
    for (const scenario of selected)
      for (const enabled of scenario.name === 'failed-search' ? [true] : [false, true]) {
        console.log(
          `Running ${scenario.name}, memory ${enabled ? 'on' : 'off'}, in an isolated in-memory campaign…`,
        );
        process.env.GATHER_CAMPAIGN_MEMORY = enabled ? '1' : '0';
        const db = openDatabase(':memory:');
        try {
          const practice = new PracticeGM();
          const gm = new ChatGPTGM(auth, owner, values.model);
          const provider: GameMaster = {
            sceneTurns: true,
            adjudicate: (context, tools) =>
              context.turn.number ? gm.adjudicate(context, tools) : practice.adjudicate(context, tools),
            narrate: practice.narrate.bind(practice),
            reviewSceneNarration: gm.reviewSceneNarration.bind(gm),
          };
          const game = new Game(
            db,
            () => provider,
            (sides) => (scenario.name === 'failed-search' ? 1 : Math.min(12, sides)),
          );
          const host = game.identify();
          const config: CampaignConfig = {
            ruleset: 'roguelike-v1',
            name: scenario.name,
            setting: scenario.setting,
            premise: '',
            tone: 'Lively and characterful',
            language: scenario.language,
            instructions:
              scenario.name === 'failed-search'
                ? 'Identifying the washed-out tracks requires a WIS check. Preserve a failure and reveal a different useful lesser observation.'
                : '',
            custom: [],
            provider: 'chatgpt',
            model: values.model,
          };
          const campaign = game.create(host.id, config);
          const player = game.identify();
          game.join(
            campaign.inviteCode!,
            player.id,
            game.saveCharacter(player.id, templateCharacter('Reader')).id,
          );
          const member = game.members(campaign.id)[0];
          game.manageCharacter(campaign.id, player.id, {
            type: 'starter',
            itemIds: member.state.starterEquipment.slice(0, 3).map((item) => item.id),
          });
          game.start(campaign.id, host.id);
          await game.idle();
          const opening = game.snapshot(campaign.id, host.id);
          assert.equal(opening.turn?.phase, 'collecting', opening.turn?.error ?? 'Opening failed.');
          const scene = structuredClone(opening.scene);
          scene.location.name = scenario.place;
          scene.location.atmosphere = scenario.current;
          scene.location.hazard = '';
          scene.currencyName = 'credits';
          scene.encounterRisk = { danger: 'safe', reason: 'A peaceful public workplace.' };
          scene.npcs = {
            witness: {
              id: 'witness',
              name: scenario.person,
              aliases: scenario.aliases,
              locationId: scene.location.id!,
              status: 'alive',
              allegiance: null,
              fact: scenario.current,
            },
          };
          db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(scene), campaign.id);
          db.prepare('UPDATE turns SET number=26 WHERE id=?').run(opening.turn!.id);
          // Seed accepted historical facts; the current journal and last twelve recaps omit the agreement.
          for (let number = 1; number <= 25; number++) {
            const id = randomUUID();
            const fact =
              number === 1 ? scenario.fact : `The party spends a quiet day at the workshop (${number}).`;
            const resolution = structuredClone(opening.history[0].resolution!);
            resolution.turnId = id;
            resolution.turnNumber = number;
            resolution.factualRecap = fact;
            resolution.journal = [];
            resolution.events = [
              {
                id: 'historical-fact',
                sequence: 0,
                kind: 'world',
                memberId: member.id,
                actionId: null,
                phase: null,
                result: null,
                fact,
                npcIds: number === 1 ? ['witness'] : undefined,
                locationRef: scene.location.id,
                receiptRefs: [],
                dependsOn: [],
              },
            ];
            db.prepare(
              `INSERT INTO turns(id,campaign_id,number,phase,roster,result,draft) VALUES(?,?,?,'complete','[]',?,?)`,
            ).run(
              id,
              campaign.id,
              number,
              JSON.stringify({ ...opening.history[0].result, summary: fact, narration: fact }),
              JSON.stringify({ resolution }),
            );
          }
          const started = performance.now();
          game.submit(campaign.id, player.id, opening.turn!.id, scenario.action, false);
          await game.idle();
          const elapsedMs = Math.round(performance.now() - started);
          const snapshot = game.snapshot(campaign.id, host.id);
          const done = snapshot.history.find((turn) => turn.id === opening.turn!.id);
          const draft = JSON.parse(
            (db.prepare('SELECT draft FROM turns WHERE id=?').get(opening.turn!.id) as { draft: string })
              .draft,
          );
          const stages = (
            db
              .prepare("SELECT payload FROM events WHERE turn_id=? AND kind LIKE 'stage:%' ORDER BY id")
              .all(opening.turn!.id) as { payload: string }[]
          ).map((row) => JSON.parse(row.payload));
          const text = done?.result?.narration ?? '';
          const report = {
            scenario: scenario.name,
            memoryEnabled: enabled,
            model: values.model,
            completed: !!done,
            elapsedMs,
            expectedFactPresent: scenario.needle
              ? text.toLowerCase().includes(scenario.needle.toLowerCase())
              : null,
            mainOutcome:
              done?.resolution?.version === 2 ? done.resolution.actions[0]?.components.main?.status : null,
            groundItems: snapshot.scene.loot.map(({ name, kind, rarity }) => ({ name, kind, rarity })),
            modelRequests: stages.reduce((sum, stage) => sum + stage.requests, 0),
            playability: (() => {
              const row = db
                .prepare("SELECT payload FROM events WHERE turn_id=? AND kind='turn_playability'")
                .get(opening.turn!.id) as { payload: string } | undefined;
              return row ? JSON.parse(row.payload) : null;
            })(),
            correctionRounds: stages.reduce(
              (sum, stage) =>
                sum +
                new Set(
                  (stage.corrections ?? [])
                    .filter(
                      (correction: { request: number; feedback: string }) =>
                        correction.request < stage.requests &&
                        !/^(Narration style:|Story progression deferred)/.test(correction.feedback),
                    )
                    .map((correction: { request: number }) => correction.request),
                ).size,
              0,
            ),
            correctionFeedback: stages.flatMap((stage) =>
              (stage.corrections ?? []).map((item: { feedback: string }) => item.feedback),
            ),
            fallback: draft.adjudicationFallback ?? null,
            memory: draft.context?.retrievedMemory?.diagnostics,
            selectedSources: draft.context?.retrievedMemory?.facts.map(
              (fact: { turnNumber: number; sourceId: string }) => ({
                turnNumber: fact.turnNumber,
                sourceId: fact.sourceId,
              }),
            ),
            failure: done ? null : snapshot.turn?.error,
            narration: text,
          };
          reports.push(report);
          console.log(JSON.stringify({ ...report, narration: undefined }));
          if (values.output)
            writeFileSync(
              resolve(values.output),
              JSON.stringify(
                { reports, note: 'Small paired live sample; no general latency or correction-rate claim.' },
                null,
                2,
              ) + '\n',
            );
        } finally {
          db.close();
        }
      }
  } finally {
    if (previousMemory === undefined) delete process.env.GATHER_CAMPAIGN_MEMORY;
    else process.env.GATHER_CAMPAIGN_MEMORY = previousMemory;
  }
  console.table(
    reports.map(
      ({
        scenario,
        memoryEnabled,
        completed,
        expectedFactPresent,
        modelRequests,
        correctionRounds,
        elapsedMs,
      }) => ({
        scenario,
        memoryEnabled,
        completed,
        expectedFactPresent,
        modelRequests,
        correctionRounds,
        elapsedMs,
      }),
    ),
  );
}
