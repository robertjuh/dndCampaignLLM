import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { rollStartingEquipment, grantEquipmentPowers } from '../shared/rules';
import { localDice } from './random';
import {
  abilitySchema,
  stats,
  type Character,
  type CharacterState,
  type Item,
  type Stat,
  type Scene,
} from '../shared/schema';

export function openDatabase(filename: string) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version > 11) throw new Error('This database was created by a newer Gather version.');
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
  if (version < 4)
    db.transaction(() => {
      db.exec(`CREATE TABLE google_accounts (subject TEXT PRIMARY KEY, player_id TEXT NOT NULL UNIQUE REFERENCES players(id), email TEXT NOT NULL);
      PRAGMA user_version = 4;`);
    })();
  if (version < 5)
    db.transaction(() => {
      const migrateSheet = (input: Character & { weaponOptions?: unknown }) => {
        const { weaponOptions: _old, ...sheet } = input;
        sheet.selectedEquipmentIds ??= [];
        sheet.abilities = sheet.abilities.map((ability) => ({ ...ability, level: ability.level ?? 1 }));
        sheet.equipmentOptions ??= rollStartingEquipment(sheet, localDice.draw);
        return sheet;
      };
      const migrateState = (
        input: CharacterState & { statPoints?: number; starterWeapons?: unknown; weaponChosen?: boolean },
        sheet: Character,
        memberId: string,
      ) => {
        const { statPoints, starterWeapons: _old, weaponChosen, ...state } = input;
        state.pendingLevelUps ??= Math.ceil((statPoints ?? 0) / 5);
        state.equipmentChosen ??= weaponChosen ?? false;
        state.starterEquipment ??= state.equipmentChosen
          ? []
          : sheet.equipmentOptions.map((item) => ({ ...item, id: `${memberId}-${item.id}` }));
        return state;
      };
      for (const row of db.prepare('SELECT id, sheet FROM characters').all() as {
        id: string;
        sheet: string;
      }[])
        db.prepare('UPDATE characters SET sheet = ? WHERE id = ?').run(
          JSON.stringify(migrateSheet(JSON.parse(row.sheet))),
          row.id,
        );
      for (const row of db.prepare('SELECT id, sheet, state FROM members').all() as {
        id: string;
        sheet: string;
        state: string;
      }[]) {
        const sheet = migrateSheet(JSON.parse(row.sheet));
        db.prepare('UPDATE members SET sheet = ?, state = ? WHERE id = ?').run(
          JSON.stringify(sheet),
          JSON.stringify(migrateState(JSON.parse(row.state), sheet, row.id)),
          row.id,
        );
      }
      for (const row of db.prepare('SELECT id, draft FROM turns WHERE draft IS NOT NULL').all() as {
        id: string;
        draft: string;
      }[]) {
        const draft = JSON.parse(row.draft);
        for (const member of draft.members) {
          member.character = migrateSheet(member.character);
          member.state = migrateState(member.state, member.character, member.id);
        }
        db.prepare('UPDATE turns SET draft = ? WHERE id = ?').run(JSON.stringify(draft), row.id);
      }
      db.pragma('user_version = 5');
    })();
  if (version < 6)
    db.transaction(() => {
      db.exec('ALTER TABLE actions ADD COLUMN ability_name TEXT;');
      const bestStat = (scores: Record<Stat, number>) =>
        stats.reduce((best, stat) => (scores[stat] > scores[best] ? stat : best), 'INT' as Stat);
      const migrateItem = <T extends Item>(item: T, fallback: Stat): T => {
        const power = { Common: 1, Uncommon: 1, Rare: 2, Legendary: 3, Cursed: 2 }[item.rarity];
        return {
          ...item,
          scaling: ['focus', 'relic'].includes(item.kind) && !item.scaling.length ? [fallback] : item.scaling,
          attackBonus: item.attackBonus ?? (item.kind === 'focus' ? power : 0),
          checkBonus: item.checkBonus ?? (item.kind === 'relic' ? power : 0),
        };
      };
      const migrateSheet = (sheet: Character) => {
        const stat = bestStat(sheet.stats);
        sheet.abilities = sheet.abilities.map((ability) =>
          abilitySchema.parse({
            ...ability,
            effect: ability.kind === 'utility' ? 'assist' : ability.effect,
            stat: ability.stat ?? stat,
          }),
        );
        sheet.equipmentOptions = sheet.equipmentOptions.map((item) => migrateItem(item, stat));
        return sheet;
      };
      const migrateState = (state: CharacterState) => {
        const stat = bestStat(state.stats);
        state.abilityUses ??= {};
        state.inventory = state.inventory.map((item) => migrateItem(item, stat));
        state.starterEquipment = state.starterEquipment.map((item) => migrateItem(item, stat));
        for (const slot of Object.keys(state.equipment) as (keyof CharacterState['equipment'])[]) {
          const item = state.equipment[slot];
          if (item) state.equipment[slot] = migrateItem(item, stat);
        }
        return state;
      };
      const migrateScene = (scene: Scene) => ({
        ...scene,
        loot: scene.loot.map((item) => migrateItem(item, 'INT')),
      });
      for (const row of db.prepare('SELECT id, sheet FROM characters').all() as {
        id: string;
        sheet: string;
      }[])
        db.prepare('UPDATE characters SET sheet = ? WHERE id = ?').run(
          JSON.stringify(migrateSheet(JSON.parse(row.sheet))),
          row.id,
        );
      for (const row of db.prepare('SELECT id, sheet, state FROM members').all() as {
        id: string;
        sheet: string;
        state: string;
      }[])
        db.prepare('UPDATE members SET sheet = ?, state = ? WHERE id = ?').run(
          JSON.stringify(migrateSheet(JSON.parse(row.sheet))),
          JSON.stringify(migrateState(JSON.parse(row.state))),
          row.id,
        );
      for (const row of db.prepare('SELECT id, scene FROM campaigns WHERE scene IS NOT NULL').all() as {
        id: string;
        scene: string;
      }[])
        db.prepare('UPDATE campaigns SET scene = ? WHERE id = ?').run(
          JSON.stringify(migrateScene(JSON.parse(row.scene))),
          row.id,
        );
      for (const row of db.prepare('SELECT id, draft FROM turns WHERE draft IS NOT NULL').all() as {
        id: string;
        draft: string;
      }[]) {
        const draft = JSON.parse(row.draft);
        for (const member of draft.members) {
          member.character = migrateSheet(member.character);
          member.state = migrateState(member.state);
        }
        draft.scene = migrateScene(draft.scene);
        db.prepare('UPDATE turns SET draft = ? WHERE id = ?').run(JSON.stringify(draft), row.id);
      }
      db.pragma('user_version = 6');
    })();
  if (version < 7)
    db.transaction(() => {
      db.exec('ALTER TABLE members ADD COLUMN replacement TEXT; PRAGMA user_version = 7;');
    })();
  if (version < 8)
    db.transaction(() => {
      const columns = db.prepare('PRAGMA table_info(actions)').all() as { name: string }[];
      if (!columns.some((column) => column.name === 'support_action'))
        db.exec('ALTER TABLE actions ADD COLUMN support_action TEXT;');
      // Migrate nested turn receipts too, so a saved resolution can still be retried.
      const migrate = (input: unknown): any => {
        if (Array.isArray(input)) return input.map(migrate);
        if (!input || typeof input !== 'object') return input;
        const value: Record<string, any> = Object.fromEntries(
          Object.entries(input).map(([key, child]) => [key, migrate(child)]),
        );
        if (value.stats && 'STR' in value.stats) {
          for (const stat of ['CHA', 'CON', 'WIS'])
            value.stats[stat] ??= value.blocked
              ? 0
              : 5 +
                (value.traits ?? []).reduce((sum: number, trait: any) => sum + (trait.stats[stat] ?? 0), 0);
        }
        if (value.requirements) for (const stat of ['CHA', 'CON', 'WIS']) value.requirements[stat] ??= 0;
        if (value.floor && typeof value.floor === 'object') {
          value.location = {
            name: value.floor.biome,
            atmosphere: value.floor.atmosphere,
            hazard: value.floor.hazard,
          };
          value.encounters = value.floor.encounters;
          delete value.floor;
        }
        if (typeof value.floor === 'number') delete value.floor;
        if ('nextFloor' in value) {
          value.location = value.nextFloor
            ? {
                name: value.nextFloor.biome,
                atmosphere: value.nextFloor.atmosphere,
                hazard: value.nextFloor.hazard,
              }
            : null;
          delete value.nextFloor;
        }
        if ('restedFloor' in value) {
          value.restedEncounter = null;
          delete value.restedFloor;
        }
        if ('hp' in value && Array.isArray(value.conditions))
          value.downedThisEncounter ??= value.conditions.includes('Downed');
        return value;
      };
      for (const [table, fields] of [
        ['characters', ['sheet']],
        ['members', ['sheet', 'state', 'replacement']],
        ['campaigns', ['scene']],
        ['turns', ['draft', 'result']],
        ['events', ['payload']],
      ] as const) {
        for (const row of db.prepare(`SELECT id, ${fields.join(', ')} FROM ${table}`).all() as Record<
          string,
          any
        >[])
          for (const field of fields)
            if (row[field])
              db.prepare(`UPDATE ${table} SET ${field} = ? WHERE id = ?`).run(
                JSON.stringify(migrate(JSON.parse(row[field]))),
                row.id,
              );
      }
      db.pragma('user_version = 8');
    })();
  if (version < 9)
    db.transaction(() => {
      // Give every copy of an existing item the same saved powers; keep completed history intact.
      const powers = new Map<string, Pick<Item, 'immunities' | 'onHit' | 'grantedAbility'>>();
      const migrate = (input: unknown): any => {
        if (Array.isArray(input)) return input.map(migrate);
        if (!input || typeof input !== 'object') return input;
        const value: Record<string, any> = Object.fromEntries(
          Object.entries(input).map(([key, child]) => [key, migrate(child)]),
        );
        if (
          value.id &&
          value.requirements &&
          value.damage &&
          value.kind !== 'consumable' &&
          ['Rare', 'Legendary', 'Cursed'].includes(value.rarity)
        ) {
          if (!powers.has(value.id)) {
            const item = grantEquipmentPowers(value as Item, localDice.draw);
            powers.set(value.id, {
              immunities: item.immunities,
              onHit: item.onHit,
              grantedAbility: item.grantedAbility,
            });
          }
          Object.assign(value, powers.get(value.id));
        }
        return value;
      };
      for (const [table, fields] of [
        ['characters', ['sheet']],
        ['members', ['sheet', 'state', 'replacement']],
        ['campaigns', ['scene']],
        ['turns', ['draft']],
      ] as const) {
        const where = table === 'turns' ? " WHERE phase != 'complete'" : '';
        for (const row of db.prepare(`SELECT id, ${fields.join(', ')} FROM ${table}${where}`).all() as Record<
          string,
          any
        >[])
          for (const field of fields)
            if (row[field])
              db.prepare(`UPDATE ${table} SET ${field} = ? WHERE id = ?`).run(
                JSON.stringify(migrate(JSON.parse(row[field]))),
                row.id,
              );
      }
      db.pragma('user_version = 9');
    })();
  if (version < 10)
    db.transaction(() => {
      // Remove legacy types everywhere an active character or item can be restored.
      // Numeric item healing, saved compensation and completed history stay intact.
      const migrate = (input: unknown): any => {
        if (Array.isArray(input)) return input.map(migrate);
        if (!input || typeof input !== 'object') return input;
        return Object.fromEntries(
          Object.entries(input)
            .filter(([key, value]) => !(key === 'healing' && typeof value === 'string'))
            .map(([key, value]) => [
              key,
              key === 'description' && typeof value === 'string'
                ? value.replace(/\s*Healing mode: (normal|repair|necrotic)\./g, '')
                : migrate(value),
            ]),
        );
      };
      for (const [table, fields] of [
        ['characters', ['sheet']],
        ['members', ['sheet', 'state', 'replacement']],
        ['campaigns', ['scene']],
        ['turns', ['draft']],
      ] as const) {
        const where = table === 'turns' ? " WHERE phase != 'complete'" : '';
        for (const row of db.prepare(`SELECT id, ${fields.join(', ')} FROM ${table}${where}`).all() as Record<
          string,
          any
        >[])
          for (const field of fields)
            if (row[field])
              db.prepare(`UPDATE ${table} SET ${field} = ? WHERE id = ?`).run(
                JSON.stringify(migrate(JSON.parse(row[field]))),
                row.id,
              );
      }
      db.pragma('user_version = 10');
    })();
  if (version < 11)
    db.transaction(() => {
      const migrate = (input: unknown): any => {
        if (Array.isArray(input)) return input.map(migrate);
        if (!input || typeof input !== 'object') return input;
        const value: Record<string, any> = Object.fromEntries(
          Object.entries(input).map(([key, child]) => [key, migrate(child)]),
        );
        if (value.equipment && !Array.isArray(value.equipment) && Array.isArray(value.inventory)) {
          value.equipment.relic ??= null;
          for (const hand of ['right', 'left']) {
            const item = value.equipment[hand];
            if (item?.kind !== 'relic') continue;
            for (const slot of ['right', 'left'])
              if (value.equipment[slot]?.id === item.id) value.equipment[slot] = null;
            if (!value.equipment.relic) value.equipment.relic = item;
            else if (value.equipment.relic.id !== item.id) {
              // Preserve a second relic even if the legacy backpack is already full.
              const owned = value.inventory.find((owned: Item) => owned.id === item.id);
              if (owned) owned.quantity++;
              else value.inventory.push({ ...item, quantity: 1 });
            }
          }
        }
        return value;
      };
      for (const [table, field, where] of [
        ['members', 'state', ''],
        ['turns', 'draft', " WHERE phase != 'complete'"],
      ])
        for (const row of db.prepare(`SELECT id, ${field} FROM ${table}${where}`).all() as Record<
          string,
          string
        >[])
          if (row[field])
            db.prepare(`UPDATE ${table} SET ${field} = ? WHERE id = ?`).run(
              JSON.stringify(migrate(JSON.parse(row[field]))),
              row.id,
            );
      db.pragma('user_version = 11');
    })();
  // A model may have been interrupted after a roll. Keep its receipts and require a deliberate retry.
  db.prepare(
    "UPDATE turns SET phase = 'failed', error = 'The host restarted during this turn. Retry to continue with the saved dice results.' WHERE phase = 'resolving'",
  ).run();
  return db;
}
export type DB = ReturnType<typeof openDatabase>;
