import { Compass } from 'lucide-react';
import { useId } from 'react';
import type { Member, Scene } from '../shared/schema';

const tileWidth = 126;
const tileHeight = 120;
const columnGap = 34;
const rowGap = 28;
const padding = 12;

export function WorldMap({
  scene,
  members,
  historical = false,
  dutch = false,
}: {
  scene: Scene;
  members: Member[];
  historical?: boolean;
  dutch?: boolean;
}) {
  const arrowId = useId();
  const map = scene.worldMap;
  if (!map || !Object.keys(map.nodes).length) return null;
  const nodes = Object.values(map.nodes);
  const connections = map.connections.filter((route) => map.nodes[route.from] && map.nodes[route.to]);
  const neighbours = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const route of connections) {
    neighbours.get(route.from)?.push(route.to);
    neighbours.get(route.to)?.push(route.from);
  }
  const positions = new Map<string, { x: number; y: number }>();
  let height = padding;
  let width = tileWidth + padding * 2;
  // A simple breadth-first layout keeps nearby places together; disconnected history gets its own rows.
  for (const root of [scene.location.id, ...nodes.map((node) => node.id)]) {
    if (!root || !map.nodes[root] || positions.has(root)) continue;
    const layers = [[root]];
    const seen = new Set([root]);
    for (let level = 0; level < layers.length; level++) {
      const next: string[] = [];
      for (const id of layers[level])
        for (const adjacent of neighbours.get(id) ?? [])
          if (!seen.has(adjacent)) {
            seen.add(adjacent);
            next.push(adjacent);
          }
      if (next.length) layers.push(next);
    }
    const rows = Math.max(...layers.map((layer) => layer.length));
    for (const [column, layer] of layers.entries())
      for (const [row, id] of layer.entries())
        positions.set(id, {
          x: padding + column * (tileWidth + columnGap),
          y: height + row * (tileHeight + rowGap),
        });
    width = Math.max(width, layers.length * (tileWidth + columnGap) - columnGap + padding * 2);
    height += rows * (tileHeight + rowGap);
  }
  height = height - rowGap + padding;
  return (
    <section className="world-map" aria-label={dutch ? 'Wereldkaart' : 'World map'}>
      <div className="world-map-heading">
        <h3>
          <Compass size={17} aria-hidden="true" />
          {historical
            ? dutch
              ? 'Huidige wereldkaart'
              : 'Current world map'
            : dutch
              ? 'Wereldkaart'
              : 'World map'}
        </h3>
        <span>{nodes.length}</span>
      </div>
      {/* <p className="world-map-caption">
        {historical
          ? dutch
            ? 'Huidige locaties terwijl je een eerdere beurt bekijkt.'
            : 'Current positions while viewing an earlier turn.'
          : dutch
            ? 'Bekende routes · één locatie per beurt'
            : 'Known paths · one location per turn'}
      </p> */}
      {/* <p className="world-map-caption">
        {dutch
          ? 'Streepjes: geblokkeerd · pijl: eenrichtingsroute'
          : 'Dashed routes: blocked · arrows: one-way'}
      </p> */}
      <div
        className="world-map-viewport"
        role="region"
        aria-label={
          dutch ? 'Locaties en verbindingen, scrollbare kaart' : 'Locations and connections, scrollable map'
        }
        tabIndex={0}
      >
        <div className="world-map-canvas" style={{ width, height }}>
          <svg width={width} height={height} aria-hidden="true">
            <defs>
              <marker
                id={arrowId}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
              </marker>
            </defs>
            {connections.map((route, index) => {
              const from = positions.get(route.from)!;
              const to = positions.get(route.to)!;
              const right = from.x < to.x;
              const sameColumn = from.x === to.x;
              return (
                <line
                  key={index}
                  className={route.blocked ? 'world-map-route blocked' : 'world-map-route'}
                  x1={from.x + (sameColumn ? tileWidth / 2 : right ? tileWidth : 0)}
                  y1={from.y + (sameColumn && from.y < to.y ? tileHeight : sameColumn ? 0 : tileHeight / 2)}
                  x2={to.x + (sameColumn ? tileWidth / 2 : right ? 0 : tileWidth)}
                  y2={to.y + (sameColumn && from.y < to.y ? 0 : sameColumn ? tileHeight : tileHeight / 2)}
                  markerEnd={route.bidirectional ? undefined : `url(#${arrowId})`}
                />
              );
            })}
          </svg>
          {nodes.map((node) => {
            const occupants = members.filter(
              (member) => (scene.memberLocations?.[member.id] ?? scene.location.id) === node.id,
            );
            const current = node.id === scene.location.id;
            return (
              <article
                key={node.id}
                className={`world-map-tile ${node.visited ? 'visited' : 'known'} ${current ? 'current' : ''}`}
                aria-label={`${dutch ? 'Locatie' : 'Location'}: ${node.name}`}
                aria-current={current ? 'location' : undefined}
                tabIndex={0}
                style={{
                  left: positions.get(node.id)!.x,
                  top: positions.get(node.id)!.y,
                  width: tileWidth,
                  height: tileHeight,
                }}
              >
                <b>{node.name}</b>
                <small>
                  {node.visited ? (dutch ? 'Bezocht' : 'Visited') : dutch ? 'Niet bezocht' : 'Unvisited'}
                </small>
                {current && (
                  <small className="world-map-focus">{dutch ? 'Huidige scène' : 'Current scene'}</small>
                )}
                {occupants.length > 0 && (
                  <ul aria-label={dutch ? 'Personages hier' : 'Characters here'}>
                    {occupants.map((member) => (
                      <li key={member.id}>
                        <span aria-hidden="true">●</span> {member.character.name}
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            );
          })}
        </div>
      </div>
      <details className="world-map-connections">
        <summary>
          {dutch ? 'Routes' : 'Routes'} ({connections.length})
        </summary>
        <ul>
          {connections.map((route, index) => (
            <li key={index}>
              {map.nodes[route.from].name} {route.bidirectional ? '↔' : '→'} {map.nodes[route.to].name}
              {route.label && <> · {route.label}</>}
              {!route.bidirectional && <> · {dutch ? 'Eenrichtingsroute' : 'One-way'}</>}
              {route.blocked && (
                <>
                  {' '}
                  · <b>{dutch ? 'Geblokkeerd' : 'Blocked'}</b>
                </>
              )}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
