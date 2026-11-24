import type { DB } from './db';
import type { GMContext } from './game';
import { findNPC, npcNames } from '../shared/npcs';
import { memberScene } from '../shared/locations';
import { submittedActionObligations } from './action-intent';

export type MemoryFact = {
  turnId: string;
  turnNumber: number;
  sourceId: string;
  kind: 'event' | 'journal' | 'legacy-summary';
  text: string;
  entityIds: string[];
  actorIds: string[];
  locationId?: string;
};
export type RetrievedMemory = {
  version: 1;
  facts: MemoryFact[];
  diagnostics: {
    status: 'ok' | 'disabled' | 'unavailable';
    durationMs: number;
    indexedTurns: number;
    backlog: number;
    bytes: number;
  };
};

const maxFacts = 8;
const maxCharacters = 8000;
const normalized = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const words = (text: string) =>
  normalized(text)
    .split(/\s+/u)
    .filter(
      (word) =>
        word.length > 2 &&
        !/^(?:the|and|that|this|with|from|into|about|then|have|what|where|there|would|could|want|een|het|van|naar|met|voor|dat|die|dan|over|wat|waar|zijn|gaan|willen|mijn)$/u.test(
          word,
        ),
    );
const unique = <T>(values: T[]) => [...new Set(values)];
const mentions = (text: string, name: string) =>
  !!normalized(name) && ` ${normalized(text)} `.includes(` ${normalized(name)} `);

/** Search is a disposable projection, never part of the gameplay commit. */
function ensureSearch(db: DB) {
  const missing = !db.prepare("SELECT 1 FROM sqlite_master WHERE name='campaign_memory_search'").get();
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS campaign_memory_search USING fts5(
    text, content='campaign_memory', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER IF NOT EXISTS campaign_memory_insert AFTER INSERT ON campaign_memory BEGIN
    INSERT INTO campaign_memory_search(rowid, text) VALUES(new.id, new.text);
  END;
  CREATE TRIGGER IF NOT EXISTS campaign_memory_delete AFTER DELETE ON campaign_memory BEGIN
    INSERT INTO campaign_memory_search(campaign_memory_search, rowid, text) VALUES('delete', old.id, old.text);
  END;`);
  if (missing) db.exec("INSERT INTO campaign_memory_search(campaign_memory_search) VALUES('rebuild')");
}

type CompletedTurn = { id: string; number: number; draft: string | null; result: string | null };

function projectTurn(turn: CompletedTurn): MemoryFact[] {
  const draft = turn.draft ? JSON.parse(turn.draft) : null;
  const result = turn.result ? JSON.parse(turn.result) : null;
  const resolution = draft?.resolution;
  const facts: MemoryFact[] = [];
  const resolve = (id: string | undefined): string | undefined =>
    id === 'current' ? draft?.context?.scene?.location?.id : (draft?.placeRefs?.[id ?? ''] ?? id);
  const add = (
    sourceId: string,
    kind: MemoryFact['kind'],
    text: unknown,
    entityIds: string[] = [],
    actorIds: string[] = [],
    locationId?: string,
  ) => {
    if (typeof text !== 'string' || !text.trim() || text.length > 6000) return;
    facts.push({
      turnId: turn.id,
      turnNumber: turn.number,
      sourceId,
      kind,
      text: text.trim(),
      entityIds: unique(entityIds.filter((id) => typeof id === 'string' && !!id)),
      actorIds: actorIds.filter((id) => typeof id === 'string'),
      ...(locationId ? { locationId } : {}),
    });
  };
  if (Array.isArray(resolution?.events)) {
    const events = new Map<string, any>(resolution.events.map((event: any) => [event.id, event]));
    for (const event of resolution.events) {
      if (
        !event ||
        event.presentation === 'log' ||
        typeof event.id !== 'string' ||
        (!['action', 'world', 'arrival'].includes(event.kind) && !event.id.startsWith('investigation:'))
      )
        continue;
      const evidence = new Map<string, string>();
      const collect = (id: string): boolean => {
        if (evidence.has(id)) return true;
        const saved = events.get(id);
        if (!saved || evidence.size >= 32 || typeof saved.fact !== 'string') return false;
        evidence.set(id, saved.fact);
        return (saved.dependsOn ?? []).every((dependency: any) => collect(dependency.eventId));
      };
      if (!collect(event.id)) continue;
      const location = resolve(event.locationRef);
      const quests = (draft.adjudication?.questUpdates ?? [])
        .filter((update: any) => update.eventId === event.id)
        .map((update: any) => update.operation?.questId ?? update.operation?.quest?.id);
      add(
        event.id,
        'event',
        unique([...events].filter(([id]) => evidence.has(id)).map(([, saved]) => saved.fact)).join('\n'),
        [...(event.npcIds ?? []), event.memberId, location, ...quests],
        event.memberId ? [event.memberId] : [],
        location,
      );
    }
    for (const [index, entry] of (resolution.journal ?? []).entries()) {
      if (typeof entry.detail !== 'string') continue;
      for (const [part, text] of entry.detail.split('\n').entries()) {
        if (!text.trim() || facts.some((fact) => normalized(fact.text).includes(normalized(text)))) continue;
        const npcId =
          entry.npcId ??
          (draft.scene && entry.kind === 'npc' ? findNPC(draft.scene, entry.name)?.id : undefined);
        add(`journal:${index}:${part}:${entry.kind}:${entry.name}`, 'journal', text, [
          npcId,
          entry.itemId,
          entry.featureId,
        ]);
      }
    }
  } else if (result?.summary) add('summary', 'legacy-summary', result.summary);
  return facts;
}

function catchUp(db: DB, campaignId: string, beforeTurn: number) {
  // ponytail: 64 turns per fresh turn; large old saves catch up over successive turns.
  const turns = db
    .prepare(
      `SELECT t.id, t.number, t.draft, t.result FROM turns t
    LEFT JOIN campaign_memory_indexed i ON i.turn_id = t.id
    WHERE t.campaign_id = ? AND t.phase = 'complete' AND t.number < ? AND i.turn_id IS NULL
    ORDER BY t.number DESC LIMIT 64`,
    )
    .all(campaignId, beforeTurn) as CompletedTurn[];
  const insert = db.prepare(`INSERT OR IGNORE INTO campaign_memory
    (campaign_id, turn_id, turn_number, source_id, kind, text, entity_ids, actor_ids, location_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const turn of turns) {
      let facts: MemoryFact[] = [];
      try {
        facts = projectTurn(turn);
      } catch {
        /* Malformed historical rows cannot block play. */
      }
      for (const fact of facts)
        insert.run(
          campaignId,
          fact.turnId,
          fact.turnNumber,
          fact.sourceId,
          fact.kind,
          fact.text,
          JSON.stringify(fact.entityIds),
          JSON.stringify(fact.actorIds),
          fact.locationId ?? null,
        );
      db.prepare('INSERT OR IGNORE INTO campaign_memory_indexed(turn_id) VALUES (?)').run(turn.id);
    }
  })();
  const backlog = (
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM turns t
    LEFT JOIN campaign_memory_indexed i ON i.turn_id = t.id
    WHERE t.campaign_id = ? AND t.phase = 'complete' AND t.number < ? AND i.turn_id IS NULL`,
      )
      .get(campaignId, beforeTurn) as { count: number }
  ).count;
  return { indexedTurns: turns.length, backlog };
}

type MemoryRow = {
  id: number;
  turn_id: string;
  turn_number: number;
  source_id: string;
  kind: MemoryFact['kind'];
  text: string;
  entity_ids: string;
  actor_ids: string;
  location_id: string | null;
};
const toFact = (row: MemoryRow): MemoryFact => ({
  turnId: row.turn_id,
  turnNumber: row.turn_number,
  sourceId: row.source_id,
  kind: row.kind,
  text: row.text,
  entityIds: JSON.parse(row.entity_ids),
  actorIds: JSON.parse(row.actor_ids),
  ...(row.location_id ? { locationId: row.location_id } : {}),
});

/** Resolve identities and query terms locally; the packet is frozen with the turn draft. */
export function retrieveCampaignMemory(db: DB, campaignId: string, context: GMContext): RetrievedMemory {
  const started = performance.now();
  const packet: RetrievedMemory = {
    version: 1,
    facts: [],
    diagnostics: {
      status: 'ok',
      durationMs: 0,
      indexedTurns: 0,
      backlog: 0,
      bytes: 0,
    },
  };
  try {
    if (process.env.GATHER_CAMPAIGN_MEMORY === '0') packet.diagnostics.status = 'disabled';
    else {
      ensureSearch(db);
      Object.assign(packet.diagnostics, catchUp(db, campaignId, context.turn.number));
      const olderThan = Math.max(0, context.turn.number - context.history.length);
      const existing = normalized(
        [
          ...context.history.map((entry) => entry.summary),
          ...context.journal.map((entry) => entry.detail),
        ].join('\n'),
      );
      const lists: { row: MemoryRow; score: number }[][] = [];
      for (const action of context.turn.actions.filter((action) => !action.passed)) {
        const location = memberScene(context.scene, action.memberId).location.id!;
        const people = Object.values(context.scene.npcs ?? {});
        const named = people
          .filter((npc) => npcNames(npc).some((name) => mentions(action.text, name)))
          .map((npc) => npc.id);
        const quests = Object.values(context.scene.quests ?? {})
          .filter((quest) => mentions(action.text, quest.name))
          .map((quest) => quest.id);
        const primary = unique([
          ...named,
          ...quests,
          ...(!named.length &&
          submittedActionObligations(context, action.memberId).some((intent) => intent.kind === 'talk')
            ? people.filter((npc) => npc.locationId === location).map((npc) => npc.id)
            : []),
        ]).slice(0, 12);
        const secondary = [location, action.memberId];
        const terms = unique(
          words(
            `${action.text} ${people
              .filter((npc) => named.includes(npc.id))
              .map((npc) => npc.name)
              .join(' ')}`,
          ),
        ).slice(0, 24);
        const candidates = new Map<number, MemoryRow>();
        for (const ids of [primary, secondary]) {
          if (!ids.length) continue;
          const rows = db
            .prepare(
              `SELECT m.* FROM campaign_memory m JOIN turns t ON t.id=m.turn_id
            WHERE m.campaign_id = ? AND t.phase='complete' AND t.number < ?
            AND EXISTS (SELECT 1 FROM json_each(m.entity_ids) WHERE value IN (${ids.map(() => '?').join(',')}))
            ORDER BY m.turn_number DESC, m.source_id LIMIT 64`,
            )
            .all(campaignId, olderThan, ...ids) as MemoryRow[];
          rows.forEach((row) => candidates.set(row.id, row));
        }
        if (terms.length) {
          const query = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
          const rows = db
            .prepare(
              `SELECT m.* FROM campaign_memory_search s JOIN campaign_memory m ON m.id = s.rowid
            JOIN turns t ON t.id=m.turn_id
            WHERE campaign_memory_search MATCH ? AND m.campaign_id = ? AND t.phase='complete' AND t.number < ?
            ORDER BY rank, m.turn_number DESC, m.source_id LIMIT 64`,
            )
            .all(query, campaignId, olderThan) as MemoryRow[];
          rows.forEach((row) => candidates.set(row.id, row));
        }
        lists.push(
          [...candidates.values()]
            .filter((row) => !existing.includes(normalized(row.text)))
            .map((row) => {
              const ids = JSON.parse(row.entity_ids) as string[];
              const text = normalized(row.text);
              const topic = terms.filter((term) => ` ${text} `.includes(` ${term} `)).length;
              return {
                row,
                score:
                  ids.filter((id) => named.includes(id) || quests.includes(id)).length * 100 +
                  (!named.length && ids.some((id) => primary.includes(id)) ? 20 : 0) +
                  topic * 10 +
                  (ids.includes(location) ? 4 : 0) +
                  (ids.includes(action.memberId) ? 1 : 0),
              };
            })
            .filter(({ score }) => score >= 10)
            .sort(
              (a, b) =>
                b.score - a.score ||
                b.row.turn_number - a.row.turn_number ||
                a.row.source_id.localeCompare(b.row.source_id),
            ),
        );
      }
      const selected = new Set<number>();
      // Round-robin allocation keeps split scenes represented within one shared cap.
      while (lists.some((list) => list.length) && packet.facts.length < maxFacts) {
        for (const list of lists) {
          const candidate = list.shift();
          if (!candidate || selected.has(candidate.row.id) || packet.facts.length >= maxFacts) continue;
          const fact = toFact(candidate.row);
          if (packet.facts.some((saved) => normalized(saved.text) === normalized(fact.text))) continue;
          if (JSON.stringify({ ...packet, facts: [...packet.facts, fact] }).length > maxCharacters - 100)
            continue;
          selected.add(candidate.row.id);
          packet.facts.push(fact);
        }
      }
    }
  } catch {
    packet.facts = [];
    packet.diagnostics.status = 'unavailable';
  }
  packet.diagnostics.durationMs = Math.round((performance.now() - started) * 100) / 100;
  packet.diagnostics.bytes = Buffer.byteLength(
    JSON.stringify({ version: packet.version, facts: packet.facts }),
  );
  return packet;
}

export function rebuildCampaignMemory(db: DB, campaignId: string) {
  ensureSearch(db);
  db.transaction(() => {
    db.prepare('DELETE FROM campaign_memory WHERE campaign_id = ?').run(campaignId);
    db.prepare(
      'DELETE FROM campaign_memory_indexed WHERE turn_id IN (SELECT id FROM turns WHERE campaign_id = ?)',
    ).run(campaignId);
  })();
}
