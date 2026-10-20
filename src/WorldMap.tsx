import { Compass, LocateFixed, Maximize2, Minimize2, Minus, Plus, Scan } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Member, Scene, WorldMap as SavedMap } from '../shared/schema';
import { worldMapPositions, type MapPoint } from '../shared/world-map-layout';
import { CharacterPortrait } from './CharacterSheet';

const nodeWidth = 136;
const nodeHeight = 70;
const routeKey = (from: string, to: string) => [from, to].sort().join('|');
const clampZoom = (zoom: number, minimum: number) => Math.max(minimum, Math.min(2.5, zoom));
type Camera = MapPoint & { zoom: number };
type Props = {
  scene: Scene;
  members: Member[];
  myMemberId?: string | null;
  historical?: boolean;
  dutch?: boolean;
};

// Prefer a straight connection; bend around intervening markers when needed.
function routeControl(from: MapPoint, to: MapPoint, obstacles: MapPoint[]) {
  const dx = to.x - from.x,
    dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  let best = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  let hits = Infinity;
  for (const bend of [0, 90, -90, 180, -180, 300, -300]) {
    const control = {
      x: (from.x + to.x) / 2 - (dy / length) * bend,
      y: (from.y + to.y) / 2 + (dx / length) * bend,
    };
    let collisions = 0;
    for (let t = 0.1; t < 0.95; t += 0.05) {
      const x = (1 - t) ** 2 * from.x + 2 * (1 - t) * t * control.x + t ** 2 * to.x;
      const y = (1 - t) ** 2 * from.y + 2 * (1 - t) * t * control.y + t ** 2 * to.y;
      collisions += obstacles.filter(
        (point) => Math.abs(point.x - x) < nodeWidth / 2 + 8 && Math.abs(point.y - y) < nodeHeight / 2 + 8,
      ).length;
    }
    if (collisions < hits) {
      best = control;
      hits = collisions;
    }
    if (!hits) break;
  }
  return best;
}

function routePath(from: MapPoint, to: MapPoint, control: MapPoint, radius?: number) {
  const boundary = (point: MapPoint) => {
    const vx = control.x - point.x,
      vy = control.y - point.y;
    const scale =
      radius === undefined
        ? 1 / Math.max(Math.abs(vx) / (nodeWidth / 2 + 5), Math.abs(vy) / (nodeHeight / 2 + 5), 0.001)
        : Math.min(radius, Math.hypot(to.x - from.x, to.y - from.y) / 3) / (Math.hypot(vx, vy) || 1);
    return { x: point.x + vx * scale, y: point.y + vy * scale };
  };
  const start = boundary(from),
    end = boundary(to);
  return `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`;
}

export function WorldMap(props: Props) {
  if (!props.scene.worldMap || !Object.keys(props.scene.worldMap.nodes).length) return null;
  return <MapView {...props} map={props.scene.worldMap} />;
}

function MapView({
  scene,
  members,
  myMemberId,
  historical = false,
  dutch = false,
  map,
}: Props & { map: SavedMap }) {
  const arrowId = useId();
  const helpId = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const inlineHeight = useRef(0);
  const lastPositions = useRef<Record<string, MapPoint>>({});
  const positions = useMemo(() => {
    const result = worldMapPositions(map, { ...lastPositions.current, ...map.positions });
    lastPositions.current = result;
    return result;
  }, [map]);
  const nodes = Object.values(map.nodes);
  const connections = map.connections.filter(
    (route) => positions[route.from] && positions[route.to] && route.from !== route.to,
  );
  const target = (myMemberId && scene.memberLocations?.[myMemberId]) || scene.location.id!;
  const [selected, setSelected] = useState(target);
  const [expanded, setExpanded] = useState(false);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 1 });
  const overview = camera.zoom < 1;
  const cameraRef = useRef(camera);
  const minimumZoom = useRef(0.15);
  const size = useRef({ width: 0, height: 0 });
  const initialized = useRef(false);
  const pointers = useRef(new Map<number, MapPoint>());
  const dragOrigin = useRef<MapPoint>({ x: 0, y: 0 });
  const dragged = useRef(false);
  const changeCamera = (next: Camera) => {
    cameraRef.current = next;
    setCamera(next);
  };
  const zoomAt = (factor: number, point = { x: size.current.width / 2, y: size.current.height / 2 }) => {
    const current = cameraRef.current;
    const zoom = clampZoom(current.zoom * factor, minimumZoom.current);
    changeCamera({
      x: point.x - ((point.x - current.x) * zoom) / current.zoom,
      y: point.y - ((point.y - current.y) * zoom) / current.zoom,
      zoom,
    });
  };
  const fit = () => {
    const points = Object.values(lastPositions.current);
    if (!points.length) return;
    const left = Math.min(...points.map((point) => point.x)) - nodeWidth / 2 - 24;
    const right = Math.max(...points.map((point) => point.x)) + nodeWidth / 2 + 24;
    const top = Math.min(...points.map((point) => point.y)) - nodeHeight / 2 - 24;
    const bottom = Math.max(...points.map((point) => point.y)) + nodeHeight / 2 + 24;
    const { width, height } = size.current;
    // Reserve screen space for overview tap targets, including at very low zoom.
    const zoom = Math.min(
      1,
      Math.max(1, width - 48) / (right - left),
      Math.max(1, height - 48) / (bottom - top),
    );
    // Keep fitted overviews reachable by buttons, keyboard and gestures.
    minimumZoom.current = Math.min(minimumZoom.current, zoom);
    changeCamera({
      x: width / 2 - ((left + right) / 2) * zoom,
      y: height / 2 - ((top + bottom) / 2) * zoom,
      zoom,
    });
  };
  const find = (id: string) => {
    const point = positions[id];
    if (!point) return;
    setSelected(id);
    const zoom = Math.max(1, cameraRef.current.zoom);
    changeCamera({
      x: size.current.width / 2 - point.x * zoom,
      y: size.current.height / 2 - point.y * zoom,
      zoom,
    });
  };

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const resize = () => {
      const { width, height } = element.getBoundingClientRect();
      if (!width || !height) return;
      const previous = size.current;
      size.current = { width, height };
      if (!initialized.current) {
        initialized.current = true;
        fit();
      } else
        changeCamera({
          ...cameraRef.current,
          x: cameraRef.current.x + (width - previous.width) / 2,
          y: cameraRef.current.y + (height - previous.height) / 2,
        });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    // Deliberate Ctrl/Command-wheel zoom leaves ordinary page scrolling intact.
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      zoomAt(Math.exp(-event.deltaY * 0.002), { x: event.clientX - rect.left, y: event.clientY - rect.top });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => {
      observer.disconnect();
      element.removeEventListener('wheel', wheel);
      pointers.current.clear();
    };
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [expanded]);

  useLayoutEffect(() => {
    if (expanded) dialog.current?.showModal();
    else if (dialog.current?.open) {
      dialog.current.close();
      expandButton.current?.focus({ preventScroll: true });
    }
  }, [expanded]);

  const topology = [
    ...nodes.map((node) => node.id),
    ...connections.map((route) => routeKey(route.from, route.to)),
  ].join(',');
  const previousTopology = useRef<Set<string> | null>(null);
  const [discoveries, setDiscoveries] = useState(new Set<string>());
  useEffect(() => {
    const keys = new Set(topology.split(','));
    const added = previousTopology.current
      ? new Set([...keys].filter((key) => !previousTopology.current!.has(key)))
      : new Set<string>();
    previousTopology.current = keys;
    setDiscoveries(added);
    const timeout = window.setTimeout(() => setDiscoveries(new Set()), 2400);
    return () => window.clearTimeout(timeout);
  }, [topology]);

  const occupants = (id: string) =>
    members.filter(
      (member) => member.active && (scene.memberLocations?.[member.id] ?? scene.location.id) === id,
    );
  const selectedNode = map.nodes[selected];
  const labels = new Map<string, MapPoint>();
  if (overview) {
    const placed: MapPoint[] = [];
    const important = nodes.filter(
      (node) => node.id === selected || node.id === scene.location.id || occupants(node.id).length,
    );
    important.sort((a, b) => Number(b.id === selected) - Number(a.id === selected));
    for (const node of important) {
      const x = positions[node.id].x * camera.zoom + camera.x;
      const y = positions[node.id].y * camera.zoom + camera.y;
      if (x < 0 || x > size.current.width || y < 0 || y > size.current.height) continue;
      // Keep the few priority labels inside the viewport and prefer a free side of their marker.
      const candidates = [
        { x: x - 64, y: y - 44 },
        { x: x - 64, y: y + 20 },
        { x: x + 20, y: y - 12 },
        { x: x - 148, y: y - 12 },
      ].map((point) => ({
        x: Math.max(4, Math.min(size.current.width - 132, point.x)),
        y: Math.max(4, Math.min(size.current.height - 28, point.y)),
      }));
      const overlap = (point: MapPoint) =>
        placed.reduce(
          (area, other) =>
            area +
            Math.max(0, 132 - Math.abs(point.x - other.x)) * Math.max(0, 28 - Math.abs(point.y - other.y)),
          0,
        );
      candidates.sort((a, b) => overlap(a) - overlap(b));
      const point = candidates[0];
      placed.push(point);
      labels.set(node.id, { x: point.x - x, y: point.y - y });
    }
  }
  const paths = useMemo(
    () =>
      map.connections
        .filter((route) => positions[route.from] && positions[route.to] && route.from !== route.to)
        .map((route) => ({
          ...route,
          key: routeKey(route.from, route.to),
          control: routeControl(
            positions[route.from],
            positions[route.to],
            Object.entries(positions)
              .filter(([id]) => id !== route.from && id !== route.to)
              .map(([, point]) => point),
          ),
        })),
    [map, positions],
  );
  const routeText = (route: SavedMap['connections'][number]) => (
    <>
      {map.nodes[route.from].name} {route.bidirectional ? '↔' : '→'} {map.nodes[route.to].name}
      {' · '}
      {route.label}
      {!route.bidirectional && <> · {dutch ? 'Eenrichtingsroute' : 'One-way'}</>}
      {route.blocked && (
        <>
          {' '}
          · <b>{dutch ? 'Geblokkeerd' : 'Blocked'}</b>
        </>
      )}
    </>
  );
  const content = (
    <>
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
        <span>
          {nodes.length} {dutch ? 'locaties' : 'locations'}
        </span>
      </div>
      <div className="world-map-controls" role="group" aria-label={dutch ? 'Kaartbediening' : 'Map controls'}>
        <button
          type="button"
          aria-label={dutch ? 'Uitzoomen' : 'Zoom out'}
          title={dutch ? 'Uitzoomen' : 'Zoom out'}
          disabled={camera.zoom <= minimumZoom.current}
          onClick={() => zoomAt(1 / 1.25)}
        >
          <Minus size={16} />
        </button>
        <output aria-label={dutch ? 'Zoomniveau' : 'Zoom level'}>{Math.round(camera.zoom * 100)}%</output>
        <button
          type="button"
          aria-label={dutch ? 'Inzoomen' : 'Zoom in'}
          title={dutch ? 'Inzoomen' : 'Zoom in'}
          disabled={camera.zoom >= 2.5}
          onClick={() => zoomAt(1.25)}
        >
          <Plus size={16} />
        </button>
        <button type="button" onClick={() => find(target)}>
          <LocateFixed size={15} />
          {myMemberId ? (dutch ? 'Vind mij' : 'Find me') : dutch ? 'Vind scène' : 'Find scene'}
        </button>
        <button type="button" onClick={fit}>
          <Scan size={15} />
          {dutch ? 'Hele kaart' : 'Fit map'}
        </button>
        <button
          ref={expandButton}
          type="button"
          onClick={() => {
            if (!expanded)
              inlineHeight.current = dialog.current?.parentElement?.getBoundingClientRect().height ?? 0;
            setExpanded(!expanded);
          }}
          aria-label={
            expanded ? (dutch ? 'Kaart sluiten' : 'Close map') : dutch ? 'Kaart vergroten' : 'Expand map'
          }
          title={
            expanded ? (dutch ? 'Kaart sluiten' : 'Close map') : dutch ? 'Kaart vergroten' : 'Expand map'
          }
        >
          {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>
      <p className="world-map-caption" id={helpId}>
        {dutch
          ? 'Sleep om te verkennen · Ctrl + scroll of knijp om te zoomen · Kies een locatie voor details'
          : 'Drag to explore · Ctrl + scroll or pinch to zoom · Select a place for details'}
      </p>
      <div
        ref={viewport}
        className={`world-map-viewport ${overview ? 'overview' : ''}`}
        role="region"
        aria-label={
          dutch
            ? 'Locaties en verbindingen, interactieve kaart'
            : 'Locations and connections, interactive map'
        }
        aria-describedby={helpId}
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          if (!pointers.current.size) {
            dragged.current = false;
            dragOrigin.current = { x: event.clientX, y: event.clientY };
          }
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        }}
        onPointerMove={(event) => {
          const old = pointers.current.get(event.pointerId);
          if (!old) return;
          const before = [...pointers.current.values()];
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          if (
            !dragged.current &&
            before.length === 1 &&
            Math.hypot(event.clientX - dragOrigin.current.x, event.clientY - dragOrigin.current.y) < 5
          )
            return;
          dragged.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          if (before.length >= 2) {
            const after = [...pointers.current.values()];
            const midpoint = (points: MapPoint[]) => ({
              x: (points[0].x + points[1].x) / 2,
              y: (points[0].y + points[1].y) / 2,
            });
            const a = midpoint(before),
              b = midpoint(after);
            const distance = (points: MapPoint[]) =>
              Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
            const rect = event.currentTarget.getBoundingClientRect();
            zoomAt(distance(after) / (distance(before) || 1), { x: a.x - rect.left, y: a.y - rect.top });
            changeCamera({
              ...cameraRef.current,
              x: cameraRef.current.x + b.x - a.x,
              y: cameraRef.current.y + b.y - a.y,
            });
          } else
            changeCamera({
              ...cameraRef.current,
              x: cameraRef.current.x + event.clientX - old.x,
              y: cameraRef.current.y + event.clientY - old.y,
            });
        }}
        onPointerUp={(event) => pointers.current.delete(event.pointerId)}
        onPointerCancel={(event) => pointers.current.delete(event.pointerId)}
        onClickCapture={(event) => {
          if (dragged.current && event.detail > 0) {
            event.preventDefault();
            event.stopPropagation();
          } else if (
            overview &&
            event.detail > 0 &&
            !(event.target as Element).closest('.world-map-node b')
          ) {
            const rect = event.currentTarget.getBoundingClientRect();
            const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
            let nearest: string | undefined;
            let distance = 24;
            for (const node of nodes) {
              const next = Math.hypot(
                positions[node.id].x * camera.zoom + camera.x - point.x,
                positions[node.id].y * camera.zoom + camera.y - point.y,
              );
              if (next < distance) {
                nearest = node.id;
                distance = next;
              }
            }
            if (nearest) {
              event.preventDefault();
              event.stopPropagation();
              find(nearest);
            }
          }
          dragged.current = false;
        }}
        onKeyDown={(event) => {
          const shifts: Record<string, MapPoint> = {
            ArrowLeft: { x: 40, y: 0 },
            ArrowRight: { x: -40, y: 0 },
            ArrowUp: { x: 0, y: 40 },
            ArrowDown: { x: 0, y: -40 },
          };
          const shift = shifts[event.key];
          if (shift) {
            event.preventDefault();
            changeCamera({
              ...cameraRef.current,
              x: cameraRef.current.x + shift.x,
              y: cameraRef.current.y + shift.y,
            });
          } else if (['+', '=', '-'].includes(event.key)) {
            event.preventDefault();
            zoomAt(event.key === '-' ? 1 / 1.25 : 1.25);
          } else if (event.key === 'Home') {
            event.preventDefault();
            fit();
          }
        }}
      >
        <div
          className="world-map-canvas"
          style={
            {
              transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`,
              '--map-inverse-zoom': 1 / camera.zoom,
            } as CSSProperties
          }
        >
          <svg width="1" height="1" aria-hidden="true">
            <defs>
              <marker
                id={arrowId}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerUnits="userSpaceOnUse"
                markerWidth={7 / Math.min(1, camera.zoom)}
                markerHeight={7 / Math.min(1, camera.zoom)}
                orient="auto"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
              </marker>
            </defs>
            {paths.map((route) => {
              const path = routePath(
                positions[route.from],
                positions[route.to],
                route.control,
                overview ? 10 / camera.zoom : undefined,
              );
              return (
                <g key={route.key}>
                  <path d={path} className="world-map-route-casing" />
                  <path
                    d={path}
                    className={`world-map-route ${route.blocked ? 'blocked' : ''} ${route.from === selected || route.to === selected ? 'selected' : ''} ${discoveries.has(route.key) ? 'new' : ''}`}
                    markerEnd={route.bidirectional ? undefined : `url(#${arrowId})`}
                  />
                </g>
              );
            })}
          </svg>
          {nodes.map((node) => {
            const here = occupants(node.id);
            const current = node.id === scene.location.id;
            const label = labels.get(node.id);
            return (
              <article
                key={node.id}
                className={`world-map-tile ${node.visited ? 'visited' : 'known'} ${current ? 'current' : ''} ${node.id === selected ? 'selected' : ''} ${here.length ? 'occupied' : ''} ${discoveries.has(node.id) ? 'new' : ''}`}
                aria-label={`${dutch ? 'Locatie' : 'Location'}: ${node.name}`}
                aria-current={current ? 'location' : undefined}
                style={{
                  left: positions[node.id].x - nodeWidth / 2,
                  top: positions[node.id].y - nodeHeight / 2,
                  width: nodeWidth,
                  height: nodeHeight,
                }}
              >
                <button
                  type="button"
                  className="world-map-node"
                  aria-label={`${dutch ? 'Locatie' : 'Location'}: ${node.name}`}
                  aria-pressed={selected === node.id}
                  title={node.name}
                  data-overview-label={label ? true : undefined}
                  style={
                    label
                      ? ({
                          '--map-label-x': `${label.x}px`,
                          '--map-label-y': `${label.y}px`,
                        } as CSSProperties)
                      : undefined
                  }
                  onClick={() => (overview ? find(node.id) : setSelected(node.id))}
                  onFocus={(event) => {
                    if (!event.currentTarget.matches(':focus-visible')) return;
                    setSelected(node.id);
                    const { x, y } = positions[node.id],
                      c = cameraRef.current;
                    if (
                      x * c.zoom + c.x < 50 ||
                      x * c.zoom + c.x > size.current.width - 50 ||
                      y * c.zoom + c.y < 40 ||
                      y * c.zoom + c.y > size.current.height - 40
                    )
                      find(node.id);
                  }}
                >
                  <span className="world-map-dot" aria-hidden="true" />
                  <b>{node.name}</b>
                  {here.length > 0 && (
                    <span className="world-map-overview-count" aria-hidden="true">
                      {here.length}
                    </span>
                  )}
                  {here.length > 0 && (
                    <span className="world-map-occupants" aria-hidden="true">
                      {here.slice(0, 3).map((member) => (
                        <CharacterPortrait key={member.id} character={member.character} size="mini" />
                      ))}
                      {here.length > 3 && <span>+{here.length - 3}</span>}
                    </span>
                  )}
                  <span className="world-map-sr">
                    {node.visited ? (dutch ? 'Bezocht' : 'Visited') : dutch ? 'Niet bezocht' : 'Unvisited'}
                    {current && (dutch ? ' · Huidige scène' : ' · Current scene')}
                    {here.map((member) => ` · ${member.character.name}`).join('')}
                  </span>
                </button>
              </article>
            );
          })}
        </div>
      </div>
      {selectedNode && (
        <div
          className="world-map-selection"
          aria-label={dutch ? 'Geselecteerde locatie' : 'Selected location'}
        >
          <b>{selectedNode.name}</b>
          <span>
            {selectedNode.visited ? (dutch ? 'Bezocht' : 'Visited') : dutch ? 'Niet bezocht' : 'Unvisited'}
            {selected === scene.location.id && (dutch ? ' · Huidige scène' : ' · Current scene')}
          </span>
          {occupants(selected).length > 0 && (
            <p>
              {occupants(selected)
                .map((member) => member.character.name)
                .join(' · ')}
            </p>
          )}
          <ul>
            {connections
              .filter((route) => route.from === selected || route.to === selected)
              .map((route) => (
                <li key={routeKey(route.from, route.to)}>{routeText(route)}</li>
              ))}
          </ul>
        </div>
      )}
      <details className="world-map-connections">
        <summary>Routes ({connections.length})</summary>
        <ul>
          {connections.map((route) => (
            <li key={routeKey(route.from, route.to)}>{routeText(route)}</li>
          ))}
        </ul>
      </details>
    </>
  );
  return (
    <section
      className="world-map"
      aria-label={dutch ? 'Wereldkaart' : 'World map'}
      style={expanded ? { height: inlineHeight.current } : undefined}
    >
      {!expanded && content}
      <dialog
        ref={dialog}
        className="world-map-dialog"
        aria-label={dutch ? 'Vergrote wereldkaart' : 'Expanded world map'}
        onCancel={(event) => {
          event.preventDefault();
          setExpanded(false);
        }}
        onClose={() => setExpanded(false)}
      >
        {expanded && content}
      </dialog>
    </section>
  );
}
