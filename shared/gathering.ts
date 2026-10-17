import { combatActive, placeScene } from './locations';
import type { Scene } from './schema';

/** Gather only through established, visited places and open directed routes. */
export function gatheringRoute(scene: Scene, from: string, goal: string): string[] | null {
  const visited = (id: string) =>
    scene.worldMap?.nodes[id]?.visited && (id === scene.location.id || !!scene.places?.[id]);
  if (!visited(from) || !visited(goal) || combatActive(placeScene(scene, goal))) return null;
  const queue = [[from]];
  const seen = new Set([from]);
  for (const path of queue) {
    const current = path.at(-1)!;
    if (current === goal) return path;
    for (const edge of scene.worldMap?.connections ?? []) {
      if (edge.blocked) continue;
      const next =
        edge.from === current ? edge.to : edge.bidirectional && edge.to === current ? edge.from : null;
      if (!next || seen.has(next) || !visited(next) || combatActive(placeScene(scene, next))) continue;
      seen.add(next);
      queue.push([...path, next]);
    }
  }
  return null;
}

/** Clear stretches compress into one turn; danger is assessed before travelling further. */
export function gatheringProgress(scene: Scene, route: string[], introducedCombats: string[] = []) {
  const path = route.slice(0, 1);
  let stop: 'danger' | 'combat' | 'blocked' | null = null;
  for (const next of route.slice(1)) {
    const from = path.at(-1)!;
    const edge = scene.worldMap?.connections.find(
      (edge) =>
        !edge.blocked &&
        ((edge.from === from && edge.to === next) ||
          (edge.bidirectional && edge.to === from && edge.from === next)),
    );
    if (
      !edge ||
      !scene.worldMap?.nodes[next]?.visited ||
      (next !== scene.location.id && !scene.places?.[next])
    ) {
      stop = 'blocked';
      break;
    }
    const place = placeScene(scene, next);
    if (combatActive(place) && !introducedCombats.includes(next)) {
      stop = 'combat';
      break;
    }
    path.push(next);
    if (combatActive(place) || place.encounterRisk?.danger !== 'safe') {
      stop = 'danger';
      break;
    }
  }
  return { path, destination: path.at(-1)!, stop };
}
