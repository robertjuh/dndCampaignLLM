import { expect, it } from 'vitest';
import { worldMapSchema, type WorldMap } from '../shared/schema';
import { worldMapPositions } from '../shared/world-map-layout';

it('places an expanding web without moving existing places, including a loop and a disconnected group', () => {
  const [a, b, c, d, e, f] = Array.from({ length: 6 }, () => crypto.randomUUID());
  const node = (id: string) => ({ id, name: id, visited: true });
  const edge = (from: string, to: string) => ({
    from,
    to,
    label: 'Trail',
    blocked: false,
    bidirectional: true,
  });
  const map: WorldMap = {
    nodes: Object.fromEntries([a, b, c, d].map((id) => [id, node(id)])),
    connections: [edge(a, b), edge(b, c)],
  };
  const initial = worldMapPositions(map);
  expect(initial[a]).toEqual({ x: 0, y: 0 });
  expect(worldMapPositions(structuredClone(map))).toEqual(initial);
  map.positions = initial;
  map.nodes[a].name = 'Renamed courtyard';
  map.nodes[e] = node(e);
  map.nodes[f] = node(f);
  map.connections.push(edge(c, a), edge(b, e), edge(c, e), edge(e, f), edge(d, f));
  const expanded = worldMapPositions(map);
  for (const id of [a, b, c, d]) expect(expanded[id]).toEqual(initial[id]);
  for (const [id, point] of Object.entries(expanded))
    for (const [other, next] of Object.entries(expanded))
      if (id !== other)
        expect(Math.abs(point.x - next.x) >= 170 || Math.abs(point.y - next.y) >= 120).toBe(true);
  map.positions = expanded;
  expect(worldMapPositions(worldMapSchema.parse(JSON.parse(JSON.stringify(map))))).toEqual(expanded);
});

it('accepts legacy maps and rejects non-finite saved positions', () => {
  const id = crypto.randomUUID();
  const map: WorldMap = { nodes: { [id]: { id, name: 'Courtyard', visited: true } }, connections: [] };
  expect(worldMapSchema.parse(map).positions).toBeUndefined();
  expect(worldMapSchema.safeParse({ ...map, positions: { [id]: { x: Infinity, y: 0 } } }).success).toBe(
    false,
  );
  expect(worldMapPositions({ ...map, positions: { [id]: { x: NaN, y: 0 } } })[id]).toEqual({ x: 0, y: 0 });
});
