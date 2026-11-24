import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { openDatabase } from '../server/db';
import { ChatGPTAuth } from '../server/auth';
import { Game } from '../server/game';
import { ChatGPTGM } from '../server/providers';
import { createModelLog } from '../server/model-log';
import { localDice } from '../server/random';

const { values } = parseArgs({ options: {
  live: { type: 'boolean', default: false }, source: { type: 'string' }, output: { type: 'string' },
} });
assert(values.source, 'Specify --source <playtest.sqlite>.');
const original = new Database(resolve(values.source), { readonly: true });
try {
  const campaigns = original.prepare('SELECT id,owner_id FROM campaigns').all() as { id: string; owner_id: string }[];
  assert.equal(campaigns.length, 1, 'Use an isolated single-campaign playtest database.');
  const campaign = campaigns[0];
  const turns = original.prepare("SELECT id,number,draft FROM turns WHERE number BETWEEN 1 AND 5 AND phase='complete' ORDER BY number").all() as { id: string; number: number; draft: string }[];
  assert.equal(turns.length, 5, 'The source must contain five complete played turns.');
  if (!values.live) console.log('Preview: replay five saved starting states and submissions with fresh live GM responses and normal OS dice, each in a new database copy. Original saves remain read-only. Add --live --output <new-directory>.');
  else {
    assert(values.output, 'Specify a new --output directory.');
    const output = resolve(values.output);
    assert(!existsSync(output), 'Choose a new output directory to preserve earlier results.');
    mkdirSync(output, { recursive: true, mode: 0o700 });
    if (existsSync('.env')) process.loadEnvFile('.env');
    const auth = new ChatGPTAuth(resolve(process.env.GATHER_DATA_DIR ?? 'data', 'credentials'));
    assert(auth.status(campaign.owner_id).connected);
    const reports: { completed: boolean }[] = [];
    for (const turn of turns) {
      const path = join(output, `turn-${turn.number}.sqlite`);
      await original.backup(path);
      const db = openDatabase(path);
      try {
        const context = JSON.parse(turn.draft).context;
        const actions = original.prepare('SELECT member_id,text,passed,accepts_lethal_risk,ability_name,support_action FROM actions WHERE turn_id=?').all(turn.id) as any[];
        db.transaction(() => {
          // Rewind only this disposable copy, including derived memory, before normal submission.
          for (const table of ['actions', 'rolls', 'events']) db.prepare(`DELETE FROM ${table} WHERE turn_id IN (SELECT id FROM turns WHERE number>=?)`).run(turn.number);
          db.prepare('DELETE FROM campaign_memory').run();
          db.prepare('DELETE FROM campaign_memory_indexed').run();
          db.prepare('DELETE FROM turns WHERE number>?').run(turn.number);
          db.prepare("UPDATE turns SET phase='collecting',draft=NULL,result=NULL,error=NULL WHERE id=?").run(turn.id);
          db.prepare('UPDATE campaigns SET scene=?,gm_memory=?,factions=?,version=version+1 WHERE id=?').run(
            JSON.stringify(context.scene), JSON.stringify(context.gmMemory ?? []), JSON.stringify(context.factions), campaign.id);
          for (const member of context.members) db.prepare('UPDATE members SET sheet=?,state=?,active=? WHERE id=?').run(JSON.stringify(member.character), JSON.stringify(member.state), Number(member.active), member.id);
          db.prepare('DELETE FROM journal WHERE campaign_id=?').run(campaign.id);
          for (const entry of context.journal) db.prepare('INSERT INTO journal(campaign_id,kind,name,detail,item_id) VALUES(?,?,?,?,?)').run(campaign.id, entry.kind, entry.name, entry.detail, entry.itemId ?? null);
        })();
        const gm = new ChatGPTGM(auth, campaign.owner_id, context.config.model, fetch, createModelLog(join(output, 'logs')));
        const game = new Game(db, () => gm, localDice.draw, () => localDice);
        const started = Date.now();
        for (const action of actions) {
          const member = context.members.find((member: any) => member.id === action.member_id);
          game.submit(campaign.id, member.playerId, turn.id, action.text, !!action.passed, !!action.accepts_lethal_risk,
            action.ability_name ?? undefined, action.support_action ? JSON.parse(action.support_action) : undefined);
        }
        await game.idle();
        const snapshot = game.snapshot(campaign.id, campaign.owner_id);
        const stages = (db.prepare("SELECT payload FROM events WHERE turn_id=? AND kind LIKE 'stage:%'").all(turn.id) as { payload: string }[]).map((row) => JSON.parse(row.payload));
        const requests = stages.flatMap((stage) => stage.requestDiagnostics ?? []);
        const report = { turn: turn.number, completed: snapshot.history.some((saved) => saved.id === turn.id), error: snapshot.turn?.error,
          wallMs: Date.now() - started, durationMs: stages.reduce((sum, stage) => sum + stage.durationMs, 0), requests: requests.length,
          inputBytes: requests.reduce((sum, request) => sum + request.inputBytes, 0), inputTokens: requests.reduce((sum, request) => sum + (request.inputTokens ?? 0), 0),
          outputTokens: requests.reduce((sum, request) => sum + (request.outputTokens ?? 0), 0), corrections: stages.flatMap((stage) => stage.corrections ?? []),
          fallbacks: stages.flatMap((stage) => stage.fallback ? [stage.fallback] : []), snapshot };
        reports.push(report);
        writeFileSync(join(output, 'results.json'), JSON.stringify(reports, null, 2) + '\n', { mode: 0o600 });
        console.log(JSON.stringify({ ...report, snapshot: undefined }));
      } finally { db.close(); }
    }
    if (reports.some((report) => !report.completed)) process.exitCode = 1;
  }
} finally { original.close(); }
