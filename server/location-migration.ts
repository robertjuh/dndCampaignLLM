import { randomUUID } from 'node:crypto';
import type { DB } from './db';
import type { Scene, PlaceState } from '../shared/schema';
import { ensureLocations, connectLocations, recordTravel } from '../shared/locations';

/** Reconstruct ownership from saved snapshots, without replaying any mechanics. */
export function migrateLocations(db: DB) {
  for (const campaign of db.prepare('SELECT id, scene FROM campaigns WHERE scene IS NOT NULL').all() as {
    id: string;
    scene: string;
  }[]) {
    const current: Scene = JSON.parse(campaign.scene);
    if (!current.location || !Array.isArray(current.loot)) continue;
    if (current.location.id && current.places) continue;
    const places: Record<string, PlaceState> = {};
    const names = new Map<string, string>();
    const itemPlaces = new Map<string, string>();
    const encounterPlaces = new Map<string, string>();
    const sourcePlaces = new Map<string, string>();
    const environmentPlaces = new Map<string, string>();
    const positions: Record<string, string> = {};
    const placeId = (scene: Scene) => {
      const name = scene.location.name.normalize('NFKC').toLowerCase();
      const id = names.get(name) ?? randomUUID();
      names.set(name, id);
      places[id] ??= { location: { ...scene.location, id }, encounter: null, loot: [] };
      return id;
    };
    const observe = (scene: Scene) => {
      const id = placeId(scene);
      const place = places[id];
      place.location = { ...scene.location, id };
      for (const item of scene.loot) if (!itemPlaces.has(item.id)) itemPlaces.set(item.id, id);
      if (scene.encounter) {
        const key = scene.encounter.enemies.map((enemy) => enemy.id).join('|');
        if (!encounterPlaces.has(key)) encounterPlaces.set(key, id);
        places[encounterPlaces.get(key)!].encounter = structuredClone(scene.encounter);
      }
      for (const key of Object.keys(scene.searchedLoot ?? {}))
        if (!sourcePlaces.has(key)) sourcePlaces.set(key, id);
      for (const key of Object.keys(scene.environment?.sources ?? {}))
        if (!environmentPlaces.has(key)) environmentPlaces.set(key, id);
      return id;
    };
    const history = db
      .prepare(
        "SELECT number, draft, result FROM turns WHERE campaign_id = ? AND phase = 'complete' ORDER BY number",
      )
      .all(campaign.id) as { number: number; draft: string | null; result: string | null }[];
    for (const turn of history) {
      if (!turn.draft) continue;
      const draft = JSON.parse(turn.draft);
      const before: Scene = draft.context?.scene ?? draft.scene;
      const beforeId = observe(before);
      for (const member of draft.members ?? []) positions[member.id] ??= beforeId;
      const loot = draft.receipts?.loot;
      if (loot?.item) {
        itemPlaces.set(loot.item.id, beforeId);
        if (loot.sourceId) sourcePlaces.set(loot.sourceId, beforeId);
      }
      const afterId = observe(draft.scene);
      if (turn.number === 0 || (!draft.adjudication && afterId !== beforeId))
        for (const member of draft.members ?? []) positions[member.id] = afterId;
      for (const action of draft.adjudication?.actions ?? []) {
        const fact = `${action.fact} ${action.components?.main?.fact ?? ''}`.toLowerCase();
        // ponytail: only explicit legacy arrival facts prove presence; no general prose parser.
        if (
          action.status === 'success' &&
          /\b(reaches|enters|arrives|joins|bereikt|betreedt|daalt|voegt)\b/.test(fact) &&
          fact.includes(draft.scene.location.name.toLowerCase())
        )
          positions[action.memberId] = afterId;
      }
    }
    // Current loot without provenance is local only when history establishes one place.
    const currentId = placeId(current);
    if (!history.length) observe(current);
    const repair = (scene: Scene): Scene => {
      const id = placeId(scene);
      const map = structuredClone(places);
      for (const place of Object.values(map)) {
        place.loot = [];
        place.searchedLoot = {};
        place.environment = undefined;
      }
      const legacyLoot: Scene['loot'] = [];
      for (const item of scene.loot) {
        const owner = itemPlaces.get(item.id) ?? (Object.keys(map).length === 1 ? id : undefined);
        if (owner && map[owner]) map[owner].loot.push(structuredClone(item));
        else legacyLoot.push(structuredClone(item));
      }
      for (const [key, name] of Object.entries(scene.searchedLoot ?? {})) {
        const owner = sourcePlaces.get(key);
        if (owner) map[owner].searchedLoot![key] = name;
      }
      for (const [key, source] of Object.entries(scene.environment?.sources ?? {})) {
        const owner = environmentPlaces.get(key);
        if (owner) {
          map[owner].environment ??= {
            sources: {},
            spentResources: [...(scene.environment?.spentResources ?? [])],
          };
          map[owner].environment!.sources[key] = structuredClone(source);
        }
      }
      map[id].location = { ...scene.location, id };
      const active = map[id];
      delete map[id];
      return {
        ...scene,
        ...active,
        places: map,
        memberLocations: { ...positions },
        ...(legacyLoot.length ? { legacyLoot } : {}),
      };
    };
    const repaired = repair(current);
    // Preserve accepted resolutions/narration; enrich only their backing scene state.
    for (const row of db
      .prepare(
        "SELECT id,draft FROM turns WHERE campaign_id = ? AND phase != 'complete' AND draft IS NOT NULL",
      )
      .all(campaign.id) as { id: string; draft: string }[]) {
      const draft = JSON.parse(row.draft);
      observe(draft.scene);
      draft.scene = repair(draft.scene);
      if (draft.context?.scene) draft.context.scene = repair(draft.context.scene);
      db.prepare('UPDATE turns SET draft = ? WHERE id = ?').run(JSON.stringify(draft), row.id);
    }
    db.prepare('UPDATE campaigns SET scene = ?, version = version + 1 WHERE id = ?').run(
      JSON.stringify(repaired),
      campaign.id,
    );
    db.prepare('INSERT INTO events(campaign_id, kind, payload) VALUES(?, ?, ?)').run(
      campaign.id,
      'location_state_migrated',
      JSON.stringify({
        locationId: currentId,
        legacyItems: repaired.legacyLoot?.map((item) => item.id) ?? [],
        reason: 'Location ownership reconstructed from saved snapshots. No gameplay receipts replayed.',
      }),
    );
  }
}

/** Backfill only traversed connections; never infer geography from similar names. */
export function migrateWorldMaps(db: DB) {
  for (const campaign of db.prepare('SELECT id, scene FROM campaigns WHERE scene IS NOT NULL').all() as {
    id: string;
    scene: string;
  }[]) {
    const current: Scene = JSON.parse(campaign.scene);
    if (!current.location?.id || !Array.isArray(current.loot)) continue;
    ensureLocations(current);
    const history = db
      .prepare(
        "SELECT draft FROM turns WHERE campaign_id = ? AND phase = 'complete' AND draft IS NOT NULL ORDER BY number",
      )
      .all(campaign.id) as { draft: string }[];
    const drafts = history.map((row) => JSON.parse(row.draft));
    const historicalId = (scene: Scene, memberId: string) => {
      const id = scene.memberLocations?.[memberId] ?? scene.location.id;
      if (id) return id;
      // Pre-ID history is untouched. Resolve its exact recorded name only when unambiguous.
      const name = scene.location.name.normalize('NFKC').toLowerCase();
      const matches = Object.values(current.worldMap!.nodes).filter(
        (node) => node.name.normalize('NFKC').toLowerCase() === name,
      );
      return matches.length === 1 ? matches[0].id : undefined;
    };
    for (const [index, draft] of drafts.entries()) {
      const before: Scene | undefined = draft.context?.scene;
      // Legacy publication saves its draft BEFORE moving. The next frozen scene proves arrival.
      const next = drafts[index + 1];
      const after: Scene | undefined = draft.resolution
        ? draft.scene
        : (next?.context?.scene ?? next?.scene ?? current);
      if (!before?.location || !after?.location) continue;
      for (const member of draft.members ?? []) {
        const from = historicalId(before, member.id);
        const to = historicalId(after, member.id);
        if (!from || !to || from === to || !current.worldMap!.nodes[from] || !current.worldMap!.nodes[to])
          continue;
        if (
          !current.worldMap!.connections.some(
            (edge) => (edge.from === from && edge.to === to) || (edge.from === to && edge.to === from),
          )
        )
          connectLocations(current, { from, to, label: 'Passage', blocked: false, bidirectional: true });
      }
    }
    // Retain accepted checkpoints; enrich only their backing geography.
    for (const row of db
      .prepare(
        "SELECT id, draft FROM turns WHERE campaign_id = ? AND phase != 'complete' AND draft IS NOT NULL",
      )
      .all(campaign.id) as { id: string; draft: string }[]) {
      const draft = JSON.parse(row.draft);
      for (const scene of [draft.scene, draft.context?.scene] as (Scene | undefined)[]) {
        if (!scene?.location?.id) continue;
        scene.worldMap ??= structuredClone(current.worldMap);
        ensureLocations(scene);
      }
      if (draft.resolution && draft.scene && draft.context?.scene)
        recordTravel(
          draft.scene,
          draft.context.scene.memberLocations ??
            Object.fromEntries(
              (draft.members ?? []).map((member: { id: string }) => [
                member.id,
                draft.context.scene.location.id,
              ]),
            ),
        );
      db.prepare('UPDATE turns SET draft = ? WHERE id = ?').run(JSON.stringify(draft), row.id);
    }
    db.prepare('UPDATE campaigns SET scene = ?, version = version + 1 WHERE id = ?').run(
      JSON.stringify(current),
      campaign.id,
    );
  }
}
