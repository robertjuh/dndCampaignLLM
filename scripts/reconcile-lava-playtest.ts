import Database from 'better-sqlite3';
import { chmodSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { DB } from '../server/db';

// One audited save correction, deliberately not a prose parser or campaign seed.
const campaignId = '3a28cd6a-8bd6-43f7-a0da-477c9c2293e7';
const itemId = 'dfbf8f40-f9a0-4eb8-b22f-d2c0d89a96c5';
const name = 'Drukregelaarssleutel';
const stale =
  'In een onderhoudskast van de oude leidingkamer ligt een zware, hittebestendige Drukregelaarssleutel. Deze past op de oude afsluiters en drukregelaars van het leidingstelsel in de Breukschacht; de sleutel is nog niet meegenomen.';
const detail =
  'In een onderhoudskast van de oude leidingkamer werd een zware, hittebestendige Drukregelaarssleutel gevonden. Deze past op de oude afsluiters en drukregelaars van het leidingstelsel in de Breukschacht.';

export function reconcileLavaPlaytest(db: DB, apply = false) {
  return db.transaction(() => {
    const campaign = db.prepare('SELECT scene FROM campaigns WHERE id = ?').get(campaignId) as
      { scene: string } | undefined;
    if (!campaign) throw new Error('The audited campaign is absent.');
    const turn = db
      .prepare("SELECT id, number, phase, draft FROM turns WHERE campaign_id = ? AND phase != 'complete'")
      .get(campaignId) as { id: string; number: number; phase: string; draft: string | null } | undefined;
    if (
      !turn ||
      turn.phase !== 'collecting' ||
      turn.draft ||
      db.prepare('SELECT 1 FROM actions WHERE turn_id = ?').get(turn.id)
    )
      throw new Error('Correction requires a fresh collecting turn with no submissions or saved draft.');
    const entry = db
      .prepare('SELECT detail, item_id FROM journal WHERE campaign_id = ? AND kind = ? AND name = ?')
      .get(campaignId, 'fact', name) as { detail: string; item_id: string | null } | undefined;
    if (!entry || ![stale, detail].includes(entry.detail) || (entry.item_id && entry.item_id !== itemId))
      throw new Error('The journal differs from the audited evidence; review it before correcting.');
    const scene = JSON.parse(campaign.scene);
    const members = (
      db.prepare('SELECT sheet, state FROM members WHERE campaign_id = ?').all(campaignId) as {
        sheet: string;
        state: string;
      }[]
    ).map((row) => ({ name: JSON.parse(row.sheet).name, state: JSON.parse(row.state) }));
    const holders = members.filter((member) =>
      [...member.state.inventory, ...Object.values(member.state.equipment)].some(
        (item: any) => item?.id === itemId,
      ),
    );
    const ground = [scene, ...Object.values(scene.places ?? {})]
      .flatMap((place: any) => place.loot)
      .filter((item: any) => item.id === itemId);
    if (holders.length !== 1 || ground.length)
      throw new Error('Item ownership is ambiguous or changed; review current evidence.');
    const report = {
      campaignId,
      turn: turn.number,
      applied: apply,
      changed: entry.detail !== detail || entry.item_id !== itemId,
      holder: holders[0].name,
      before: entry,
      after: { detail, item_id: itemId },
      positions: scene.memberLocations,
      positionCorrection: 'Positions retained; this correction reconciles the proven wrench entry.',
    };
    if (apply && report.changed) {
      db.prepare(
        'UPDATE journal SET detail = ?, item_id = ? WHERE campaign_id = ? AND kind = ? AND name = ?',
      ).run(detail, itemId, campaignId, 'fact', name);
      db.prepare('INSERT INTO events(campaign_id, turn_id, kind, payload) VALUES(?, ?, ?, ?)').run(
        campaignId,
        turn.id,
        'playtest_state_correction',
        JSON.stringify(report),
      );
      db.prepare('UPDATE campaigns SET version = version + 1 WHERE id = ?').run(campaignId);
    }
    return report;
  })();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const filename = process.argv[2];
  if (!filename)
    throw new Error('Usage: node --import tsx scripts/reconcile-lava-playtest.ts DATABASE [--apply]');
  const apply = process.argv.includes('--apply');
  const db = new Database(filename, { readonly: !apply });
  db.pragma('busy_timeout = 5000');
  try {
    if (apply) {
      const backup = `${filename}.before-correction-${Date.now()}.sqlite`;
      await db.backup(backup);
      chmodSync(backup, 0o600);
      console.log(JSON.stringify({ backup }));
    }
    console.log(JSON.stringify(reconcileLavaPlaytest(db, apply), null, 2));
  } finally {
    db.close();
  }
}
