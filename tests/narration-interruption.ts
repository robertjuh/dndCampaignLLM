import type { DB } from '../server/db';

/** Simulate a process/storage interruption. Ordinary narrator failures now publish a fallback. */
export function interruptNarration(db: DB, message: string): never {
  const turn = db
    .prepare("SELECT id FROM turns WHERE phase='resolving' ORDER BY rowid DESC LIMIT 1")
    .get() as { id: string };
  const { attempts } = db
    .prepare("SELECT COUNT(*) AS attempts FROM events WHERE turn_id=? AND kind='stage:narration'")
    .get(turn.id) as { attempts: number };
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  db.exec(`DROP TRIGGER IF EXISTS interrupt_narration_save;
    CREATE TRIGGER interrupt_narration_save BEFORE UPDATE OF draft ON turns
    WHEN NEW.id=${quote(turn.id)} AND NEW.draft LIKE '%"narration":%'
      AND (SELECT COUNT(*) FROM events WHERE turn_id=NEW.id AND kind='stage:narration')=${attempts}
    BEGIN SELECT RAISE(ABORT, ${quote(message)}); END;`);
  throw new Error(message);
}
