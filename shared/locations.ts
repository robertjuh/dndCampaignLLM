import type { Outcome, PlaceState, Scene, WorldMap } from './schema';

export const combatActive = (scene: Pick<Scene, 'encounter'>) =>
  !!scene.encounter && !scene.encounter.victory && !scene.encounter.escaped;

export function ensureLocations(scene: Scene, memberIds: string[] = []) {
  scene.location.id ??= crypto.randomUUID();
  scene.places ??= {};
  scene.worldMap ??= { nodes: {}, connections: [] };
  for (const location of [scene.location, ...Object.values(scene.places).map((place) => place.location)])
    if (location.id)
      scene.worldMap.nodes[location.id] = { id: location.id, name: location.name, visited: true };
  scene.memberLocations ??= {};
  for (const id of memberIds)
    if (
      !scene.memberLocations[id] ||
      (scene.memberLocations[id] !== scene.location.id && !scene.places[scene.memberLocations[id]])
    )
      scene.memberLocations[id] = scene.location.id;
  return scene;
}

function placeState(scene: Scene): PlaceState {
  return structuredClone({
    location: scene.location,
    encounter: scene.encounter,
    loot: scene.loot,
    searchedLoot: scene.searchedLoot,
    searches: scene.searches,
    environment: scene.environment,
    encounterRisk: scene.encounterRisk,
  });
}

export function placeScene(scene: Scene, locationId?: string): Scene {
  if (!locationId || locationId === scene.location.id) return scene;
  const place = scene.places?.[locationId];
  if (!place) throw new Error('This location is not established.');
  return {
    ...scene,
    ...place,
    searchedLoot: place.searchedLoot,
    searches: place.searches,
    environment: place.environment,
    encounterRisk: place.encounterRisk,
  };
}

export function memberScene(scene: Scene, memberId: string): Scene {
  return placeScene(scene, scene.memberLocations?.[memberId]);
}

export function savePlace(scene: Scene, place: Scene) {
  if (place === scene) return;
  scene.places![place.location.id!] = placeState(place);
}

/** IDs determine travel; name matching is only for older outputs without IDs. */
export function updateLocation(scene: Scene, location: NonNullable<Outcome['location']>) {
  ensureLocations(scene);
  const priorId = scene.location.id!;
  let id = location.id;
  if (id === undefined)
    id =
      location.name === scene.location.name
        ? priorId
        : Object.keys(scene.places!).find((key) => scene.places![key].location.name === location.name);
  if (id && id !== priorId && !scene.places![id] && !scene.worldMap!.nodes[id])
    throw new Error('Unknown location ID.');
  id ??= crypto.randomUUID();
  if (id !== priorId) {
    scene.places![priorId] = placeState(scene);
    const place = scene.places![id] ?? {
      location: { ...location, id },
      encounter: null,
      loot: [],
    };
    Object.assign(scene, place, {
      searchedLoot: place.searchedLoot,
      searches: place.searches,
      environment: place.environment,
      encounterRisk: place.encounterRisk,
    });
    delete scene.places![id];
  }
  scene.location = { ...location, id };
  scene.worldMap!.nodes[id] = { id, name: location.name, visited: true };
  return { priorId, destinationId: id, travelled: id !== priorId };
}

export function knownLocations(scene: Scene): Record<string, string> {
  return Object.fromEntries([
    ...(scene.location.id ? [[scene.location.id, scene.location.name]] : []),
    ...Object.entries(scene.places ?? {}).map(([id, place]) => [id, place.location.name]),
    ...Object.values(scene.worldMap?.nodes ?? {}).map((node) => [node.id, node.name]),
  ]);
}

/** Register arrivals before changing focus, preserving every existing place's objects. */
export function registerPlaces(
  scene: Scene,
  updates: NonNullable<Outcome['placeUpdates']>,
  refs: Record<string, string>,
) {
  ensureLocations(scene);
  for (const update of updates) {
    const id = refs[update.ref] ?? update.ref;
    const place = id === scene.location.id ? scene : scene.places![id];
    if (!place && !update.ref.startsWith('new:') && !scene.worldMap!.nodes[id])
      throw new Error('Unknown location ID.');
    const next = place ?? { encounter: null, loot: [] };
    Object.assign(next, {
      location: { ...update.location, id },
    });
    if (id !== scene.location.id) scene.places![id] = next as PlaceState;
    scene.worldMap!.nodes[id] = { id, name: update.location.name, visited: true };
  }
}

/** One saved connection per pair of places; an evidenced update can open or close it. */
export function connectLocations(scene: Scene, connection: WorldMap['connections'][number]) {
  if (connection.from === connection.to) return;
  const connections = scene.worldMap!.connections;
  const index = connections.findIndex(
    (edge) =>
      (edge.from === connection.from && edge.to === connection.to) ||
      (edge.from === connection.to && edge.to === connection.from),
  );
  if (index < 0) connections.push(connection);
  else connections[index] = connection;
}

export function registerMap(
  scene: Scene,
  updates: Outcome['mapUpdates'],
  refs: Record<string, string>,
  currentId: string,
) {
  if (!updates) return;
  const resolve = (ref: string) => (ref === 'current' ? currentId : (refs[ref] ?? ref));
  for (const location of updates.locations) {
    const id = resolve(location.ref);
    scene.worldMap!.nodes[id] ??= { id, name: location.name, visited: false };
  }
  for (const { eventId: _eventId, ...connection } of updates.connections)
    connectLocations(scene, { ...connection, from: resolve(connection.from), to: resolve(connection.to) });
}

/** Compatibility arrivals also record the one leg that was actually traversed. */
export function recordTravel(scene: Scene, origins: Record<string, string>) {
  for (const [memberId, from] of Object.entries(origins)) {
    const to = scene.memberLocations![memberId];
    if (!to || from === to || !scene.worldMap!.nodes[from] || !scene.worldMap!.nodes[to]) continue;
    if (
      scene.worldMap!.connections.some(
        (edge) => (edge.from === from && edge.to === to) || (edge.from === to && edge.to === from),
      )
    )
      continue;
    connectLocations(scene, { from, to, label: 'Passage', blocked: false, bidirectional: true });
  }
}

export function occupiedPlaces(scene: Scene) {
  return Object.fromEntries(
    [...new Set([scene.location.id!, ...Object.values(scene.memberLocations ?? {})])].map((id) => {
      const place = placeScene(scene, id);
      return [
        id,
        {
          location: structuredClone(place.location),
          encounter: place.encounter
            ? {
                round: place.encounter.round,
                victory: place.encounter.victory,
                escaped: place.encounter.escaped,
                enemies: place.encounter.enemies.map(({ id, name, hp, maxHp, withdrawn }) => ({
                  id,
                  name,
                  hp,
                  maxHp,
                  withdrawn: !!withdrawn,
                })),
              }
            : null,
        },
      ];
    }),
  );
}
