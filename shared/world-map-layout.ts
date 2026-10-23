import type { Scene, WorldMap } from './schema';

export type MapPoint = { x: number; y: number };

/** Presentation coordinates only: never infer travel or geography from these. */
export function worldMapPositions(map: WorldMap, previous = map.positions ?? {}) {
  const positions: Record<string, MapPoint> = {};
  const ids = Object.keys(map.nodes);
  for (const id of ids) {
    const point = previous[id];
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) positions[id] = { ...point };
  }
  const neighbours = new Map(ids.map((id) => [id, [] as string[]]));
  for (const edge of map.connections) {
    neighbours.get(edge.from)?.push(edge.to);
    neighbours.get(edge.to)?.push(edge.from);
  }
  const missing = new Set(ids.filter((id) => !positions[id]));
  // ponytail: a bounded-size campaign map uses a slot scan; use a spatial index if maps reach thousands of places.
  while (missing.size) {
    const id =
      [...missing].find((id) => neighbours.get(id)!.some((next) => positions[next])) ?? [...missing][0];
    const nearby = neighbours.get(id)!.flatMap((next) => (positions[next] ? [positions[next]] : []));
    const placed = Object.values(positions);
    const center = nearby.length
      ? {
          x: nearby.reduce((sum, point) => sum + point.x, 0) / nearby.length,
          y: nearby.reduce((sum, point) => sum + point.y, 0) / nearby.length,
        }
      : { x: placed.length ? Math.max(...placed.map((point) => point.x)) + 360 : 0, y: 0 };
    for (let ring = 0; !positions[id]; ring++) {
      const candidates: MapPoint[] =
        ring === 0
          ? [center]
          : Array.from({ length: ring * 6 }, (_, index) => ({
              x: center.x + Math.cos((index * Math.PI) / (ring * 3)) * ring * 180,
              y: center.y + Math.sin((index * Math.PI) / (ring * 3)) * ring * 180,
            }));
      const anchor = positions[ids[0]] ?? center;
      const score = (point: MapPoint) =>
        nearby.reduce((sum, neighbour) => sum + Math.hypot(point.x - neighbour.x, point.y - neighbour.y), 0) +
        0.15 * Math.hypot(point.x - anchor.x, point.y - anchor.y);
      candidates.sort((a, b) => score(a) - score(b));
      const free = candidates.find((candidate) =>
        placed.every(
          (point) => Math.abs(point.x - candidate.x) >= 170 || Math.abs(point.y - candidate.y) >= 120,
        ),
      );
      if (free) positions[id] = free;
    }
    missing.delete(id);
  }
  return positions;
}

/** Saved campaign positions win when an older in-flight draft is published. */
export function ensureWorldMapPositions(scene: Scene, saved?: WorldMap) {
  if (scene.worldMap)
    scene.worldMap.positions = worldMapPositions(scene.worldMap, {
      ...scene.worldMap.positions,
      ...saved?.positions,
    });
  return scene;
}
