import { z } from 'zod';
import type { Scene, WorldMap } from './schema';

const ref = z.string().trim().min(1).max(100);
export const structureSchema = z
  .object({
    id: ref,
    name: ref,
    locationId: ref,
    entranceId: ref,
    controlId: ref.nullable(),
    roomIds: z.array(ref).min(1).max(100),
    mobile: z.boolean(),
    access: z.boolean(),
  })
  .strict();
export type Structure = z.infer<typeof structureSchema>;
export const structureUpdateSchema = structureSchema.extend({ eventId: ref });
export const structureMoveSchema = z
  .object({
    structureId: ref,
    memberId: ref,
    to: ref,
    access: z.boolean(),
    eventId: ref,
    operatorId: ref.optional(),
  })
  .strict();

export function containingStructure(scene: Pick<Scene, 'structures'>, locationId: string) {
  return Object.values(scene.structures ?? {}).find((structure) => structure.roomIds.includes(locationId));
}

export function structureChain(scene: Pick<Scene, 'structures'>, locationId: string) {
  const chain: Structure[] = [];
  const seen = new Set<string>();
  let structure = containingStructure(scene, locationId);
  while (structure && !seen.has(structure.id)) {
    seen.add(structure.id);
    chain.push(structure);
    structure = containingStructure(scene, structure.locationId);
  }
  return chain;
}

export function locationPath(scene: Scene, locationId: string): string {
  const name = (id: string) =>
    scene.worldMap?.nodes[id]?.name ??
    (scene.location.id === id ? scene.location.name : scene.places?.[id]?.location.name) ??
    id;
  const chain = structureChain(scene, locationId);
  return [
    ...chain
      .slice()
      .reverse()
      .flatMap((structure) => [name(structure.locationId), structure.name]),
    name(locationId),
  ]
    .filter((part, index, all) => index === 0 || part !== all[index - 1])
    .join(' › ');
}

/** Containment grants no passage: only an accessible entrance connects inside and outside. */
export function locationConnections(scene: Pick<Scene, 'structures' | 'worldMap'>): WorldMap['connections'] {
  const edges = (scene.worldMap?.connections ?? []).filter(
    (edge) => containingStructure(scene, edge.from)?.id === containingStructure(scene, edge.to)?.id,
  );
  for (const structure of Object.values(scene.structures ?? {})) {
    const saved = scene.worldMap?.connections.find(
      (edge) =>
        (edge.from === structure.entranceId && edge.to === structure.locationId) ||
        (edge.to === structure.entranceId && edge.from === structure.locationId),
    );
    edges.push(
      saved
        ? { ...saved, blocked: saved.blocked || !structure.access }
        : {
            from: structure.entranceId,
            to: structure.locationId,
            label: structure.name,
            blocked: !structure.access,
            bidirectional: true,
          },
    );
  }
  return edges;
}

export function passageConnections(scene: Pick<Scene, 'structures' | 'worldMap'>) {
  return locationConnections(scene).filter((edge) => !edge.transportOnly);
}

/** Return the marker representing a room in a particular map view. */
export function mapLocation(scene: Scene, locationId: string, scope: string | null) {
  const chain = structureChain(scene, locationId);
  const boundary = scope ? chain.findIndex((structure) => structure.id === scope) : chain.length;
  return boundary > 0 ? chain[boundary - 1].id : locationId;
}

export function structureMap(scene: Scene, scope: string | null): WorldMap {
  const saved = scene.worldMap ?? { nodes: {}, connections: [] };
  const nodes = Object.fromEntries(
    Object.entries(saved.nodes).filter(([id]) => (containingStructure(scene, id)?.id ?? null) === scope),
  );
  for (const structure of Object.values(scene.structures ?? {}))
    if ((containingStructure(scene, structure.locationId)?.id ?? null) === scope)
      nodes[structure.id] = { id: structure.id, name: structure.name, visited: true };
  const connections: WorldMap['connections'] = [];
  for (const edge of locationConnections(scene)) {
    const from = mapLocation(scene, edge.from, scope),
      to = mapLocation(scene, edge.to, scope);
    if (from === to) continue;
    // An interior map includes its own outside entrance as a boundary marker.
    const own = scope && scene.structures?.[scope];
    if (own && [edge.from, edge.to].includes(own.entranceId) && [edge.from, edge.to].includes(own.locationId))
      if (saved.nodes[own.locationId]) nodes[own.locationId] = saved.nodes[own.locationId];
    if (nodes[from] && nodes[to]) connections.push({ ...edge, from, to });
  }
  const positions = Object.fromEntries(Object.entries(saved.positions ?? {}).filter(([id]) => nodes[id]));
  const structures = Object.values(scene.structures ?? {}).filter((structure) => nodes[structure.id]);
  for (const [index, structure] of structures.entries()) {
    const anchor = positions[structure.locationId];
    if (anchor) positions[structure.id] = { x: anchor.x + 100 + (index % 3) * 70, y: anchor.y + 110 };
  }
  return { nodes, connections, positions };
}
