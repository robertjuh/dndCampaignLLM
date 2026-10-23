import Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import { chmodSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { DB } from '../server/db';

const campaignId = 'd5d44105-cc6e-4348-b397-53e5a54c5e4b';
const turnId = '404a7b10-e172-4601-88d6-9cfa03593fbf';

// Reopen this audited receipt-only turn; never rewind a later submitted action.
export function reopenRockReedersTurn(db: DB, apply = false) {
  return db.transaction(() => {
    const campaign = db.prepare('SELECT scene FROM campaigns WHERE id = ?').get(campaignId) as {
      scene: string;
    };
    const latest = db
      .prepare(
        'SELECT id, number, phase, draft, result FROM turns WHERE campaign_id = ? ORDER BY number DESC LIMIT 2',
      )
      .all(campaignId) as {
      id: string;
      number: number;
      phase: string;
      draft: string | null;
      result: string | null;
    }[];
    const [pending, completed] = latest;
    if (
      !campaign ||
      completed?.id !== turnId ||
      completed.number !== 3 ||
      completed.phase !== 'complete' ||
      pending.number !== 4 ||
      pending.phase !== 'collecting' ||
      pending.draft ||
      ['actions', 'rolls', 'events'].some((table) =>
        db.prepare(`SELECT 1 FROM ${table} WHERE turn_id = ?`).get(pending.id),
      )
    )
      throw new Error('Recovery requires audited turn 3 to remain latest, with an empty collecting turn 4.');
    const draft = JSON.parse(completed.draft!);
    const result = JSON.parse(completed.result!);
    const rolls = db.prepare('SELECT id FROM rolls WHERE turn_id = ?').all(turnId) as { id: string }[];
    if (
      !draft.adjudicationFallback ||
      rolls.length !== 2 ||
      result.xp !== 0 ||
      result.currency !== 0 ||
      result.changes.length ||
      draft.adjudication.journal.length ||
      draft.adjudication.memberLocations.length ||
      draft.resolution.events.length !== 2 ||
      draft.resolution.events.some(
        (event: any) => event.kind !== 'mechanics' || !rolls.some((roll) => event.id === `check:${roll.id}`),
      )
    )
      throw new Error(
        'Recovery requires exactly the two saved checks and no published gameplay consequences.',
      );
    const currentScene = JSON.parse(campaign.scene);
    if (
      !isDeepStrictEqual(currentScene, draft.scene) ||
      Object.keys(currentScene).some(
        (key) =>
          key !== 'worldProgression' && !isDeepStrictEqual(currentScene[key], draft.context.scene[key]),
      )
    )
      throw new Error('The campaign scene differs from the audited receipt-only turn.');
    for (const member of draft.members) {
      const current = db
        .prepare('SELECT state FROM members WHERE id = ? AND campaign_id = ?')
        .get(member.id, campaignId) as { state: string } | undefined;
      const starting = draft.startingMembers.find((saved: any) => saved.id === member.id);
      if (
        !current ||
        !starting ||
        !isDeepStrictEqual(JSON.parse(current.state), member.state) ||
        Object.keys(member.state).some(
          (key) => key !== 'abilityUses' && !isDeepStrictEqual(member.state[key], starting.state[key]),
        )
      )
        throw new Error('Character state changed beyond the saved ability use; review before recovery.');
    }
    const report = {
      applied: apply,
      campaignId,
      turnId,
      removedEmptyTurnId: pending.id,
      preservedRollIds: rolls.map((roll) => roll.id),
      abilityUses: draft.members.map((member: any) => ({
        memberId: member.id,
        uses: member.state.abilityUses,
      })),
    };
    if (apply) {
      const originalReceipts = draft.receipts;
      draft.scene = structuredClone(draft.context.scene);
      draft.receipts = { executionEvents: originalReceipts.executionEvents };
      for (const key of [
        'adjudication',
        'adjudicationFallback',
        'resolution',
        'resolutionRevision',
        'narration',
        'narrationRevision',
        'placeRefs',
        'progress',
      ])
        delete draft[key];
      db.prepare('DELETE FROM turns WHERE id = ?').run(pending.id);
      db.prepare("UPDATE turns SET phase = 'failed', result = NULL, error = ?, draft = ? WHERE id = ?").run(
        'Story resolution reopened for repair. Original dice and ability use are saved.',
        JSON.stringify(draft),
        turnId,
      );
      db.prepare('UPDATE campaigns SET scene = ?, version = version + 1 WHERE id = ?').run(
        JSON.stringify(draft.scene),
        campaignId,
      );
      db.prepare('INSERT INTO events(campaign_id, turn_id, kind, payload) VALUES(?, ?, ?, ?)').run(
        campaignId,
        turnId,
        'playtest_turn_reopened',
        JSON.stringify({ ...report, previousResult: result, previousReceipts: originalReceipts }),
      );
    }
    return report;
  })();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const filename = process.argv[2];
  if (!filename)
    throw new Error('Usage: node --import tsx scripts/reopen-rock-reeders-turn.ts DATABASE [--apply]');
  const apply = process.argv.includes('--apply');
  const db = new Database(filename, { readonly: !apply });
  db.pragma('busy_timeout = 5000');
  try {
    if (apply) {
      const backup = `${filename}.before-rock-reeders-recovery-${Date.now()}.sqlite`;
      await db.backup(backup);
      chmodSync(backup, 0o600);
      console.log(JSON.stringify({ backup }));
    }
    console.log(JSON.stringify(reopenRockReedersTurn(db, apply), null, 2));
  } finally {
    db.close();
  }
}
