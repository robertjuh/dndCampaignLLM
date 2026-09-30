import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(filename: string) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version > 3) throw new Error('This database was created by a newer Gather version.');
  if (version === 0)
    db.transaction(() => {
      db.exec(`
      CREATE TABLE players (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT 'Adventurer');
      CREATE TABLE sessions (hash TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(id));
      CREATE TABLE characters (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES players(id), sheet TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE campaigns (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES players(id), code TEXT NOT NULL UNIQUE, display_token TEXT NOT NULL, config TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'lobby', paused INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE members (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), player_id TEXT NOT NULL REFERENCES players(id), character_id TEXT NOT NULL REFERENCES characters(id), sheet TEXT NOT NULL, state TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, UNIQUE(campaign_id, player_id));
      CREATE TABLE turns (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), number INTEGER NOT NULL, phase TEXT NOT NULL, roster TEXT NOT NULL, result TEXT, error TEXT, UNIQUE(campaign_id, number));
      CREATE UNIQUE INDEX one_pending_turn ON turns(campaign_id) WHERE phase != 'complete';
      CREATE TABLE actions (turn_id TEXT NOT NULL REFERENCES turns(id), member_id TEXT NOT NULL REFERENCES members(id), text TEXT NOT NULL, passed INTEGER NOT NULL, PRIMARY KEY(turn_id, member_id));
      CREATE TABLE rolls (id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES turns(id), check_key TEXT NOT NULL, parameters TEXT NOT NULL, result TEXT NOT NULL, UNIQUE(turn_id, check_key));
      CREATE TABLE journal (campaign_id TEXT NOT NULL REFERENCES campaigns(id), kind TEXT NOT NULL, name TEXT NOT NULL, detail TEXT NOT NULL, PRIMARY KEY(campaign_id, kind, name));
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id TEXT NOT NULL REFERENCES campaigns(id), turn_id TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      PRAGMA user_version = 1;
    `);
    })();
  if (version < 2)
    db.transaction(() => {
      db.exec(`ALTER TABLE campaigns ADD COLUMN scene TEXT;
      ALTER TABLE turns ADD COLUMN draft TEXT;
      ALTER TABLE actions ADD COLUMN accepts_lethal_risk INTEGER NOT NULL DEFAULT 0;
      PRAGMA user_version = 2;`);
    })();
  if (version < 3)
    db.transaction(() => {
      db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version = 3;');
    })();
  // A model may have been interrupted after a roll. Keep its receipts and require a deliberate retry.
  db.prepare(
    "UPDATE turns SET phase = 'failed', error = 'The host restarted during this turn. Retry to continue with the saved dice results.' WHERE phase = 'resolving'",
  ).run();
  return db;
}
export type DB = ReturnType<typeof openDatabase>;
