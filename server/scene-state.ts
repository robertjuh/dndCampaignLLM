import type { GMContext } from './game';
import type { Scene } from '../shared/schema';
import type { TurnAdjudication } from '../shared/turn-resolution';
import {
  featureConnection,
  featureNameKey,
  findSceneFeature,
  type SceneFeature,
} from '../shared/scene-state';
import { knownNPCs } from './npcs';
import { eventCausedLocally, memberLocationAtEvent, turnConnections } from './world-map';

const pair = (route: NonNullable<SceneFeature['route']>) => [route.from, route.to].sort().join('|');

/** Current feature facts use the same public events and route validation as ordinary adjudication. */
export function validateFeatureUpdates(
  context: GMContext,
  value: TurnAdjudication,
  resolve: (ref: string) => string,
) {
  if (!value.featureUpdates?.length) return;
  const projected: Scene = { ...context.scene, features: { ...context.scene.features } };
  const places = new Set([
    context.scene.location.id!,
    ...Object.keys(context.scene.places ?? {}),
    ...(value.placeUpdates ?? []).map((place) => resolve(place.ref)),
  ]);
  const actors = [
    ...context.members.map((member) => ({ id: member.id, names: [member.character.name] })),
    ...Object.values(knownNPCs(context.scene)).map((npc) => ({
      id: npc.id,
      names: [npc.name, ...npc.aliases],
    })),
    ...(value.npcUpdates ?? []).map((npc) => ({
      id: npc.npcId,
      names: [npc.name, ...(npc.aliases ?? [])],
    })),
  ];
  const items = [
    ...context.members.flatMap((member) => [
      ...member.state.inventory,
      ...Object.values(member.state.equipment).filter((item) => item != null),
    ]),
    ...Object.values(knownNPCs(context.scene)).flatMap((npc) => npc.enemy?.equipment ?? []),
    ...[context.scene, ...Object.values(context.scene.places ?? {})].flatMap((place) => place.loot),
  ];
  const seen = new Set<string>();
  for (const update of value.featureUpdates) {
    const locationId = resolve(update.locationId);
    const previous =
      findSceneFeature(projected, update.featureId) ?? findSceneFeature(projected, update.name, locationId);
    const id = previous?.id ?? update.featureId;
    if (seen.has(id))
      throw new Error('Update a scene feature once per turn, combining its changed properties.');
    seen.add(id);
    const names = [update.name, ...(update.aliases ?? [])];
    if (
      actors.some(
        (actor) =>
          actor.id === id ||
          actor.id === update.featureId ||
          names.some((name) => actor.names.some((other) => featureNameKey(other) === featureNameKey(name))),
      ) ||
      items.some(
        (item) =>
          item.id === id ||
          item.id === update.featureId ||
          names.some((name) => featureNameKey(item.name) === featureNameKey(name)),
      )
    )
      throw new Error(
        'Scene features cannot replace characters, inventory or ground items; use their existing mechanics.',
      );
    for (const name of names) {
      const other = findSceneFeature(projected, name, locationId);
      if (other && other.id !== id) throw new Error('A feature alias cannot merge two established objects.');
    }
    const event = value.events.find((event) => event.id === update.eventId);
    const eventLocation = event?.locationRef ? resolve(event.locationRef) : undefined;
    const observed =
      event &&
      context.members.some(
        (member) =>
          member.active &&
          member.state.hp > 0 &&
          memberLocationAtEvent(context, value, member.id, event.id, resolve) === locationId,
      );
    if (
      !places.has(locationId) ||
      !event ||
      !['action', 'world'].includes(event.kind) ||
      event.presentation ||
      ['failure', 'blocked'].includes(event.result ?? '') ||
      eventLocation !== locationId ||
      (!observed && !(previous && eventCausedLocally(context, value, event.id, resolve))) ||
      (!previous && !names.some((name) => featureNameKey(event.fact).includes(featureNameKey(name))))
    )
      throw new Error(
        'Scene state needs a public resolved event at an observed place, or a caused change to a known feature.',
      );
    if (
      previous &&
      previous.locationId !== locationId &&
      !turnConnections(context.scene, value, resolve, event.id).some(
        (edge) =>
          !edge.blocked &&
          ((edge.from === previous.locationId && edge.to === locationId) ||
            (edge.bidirectional && edge.to === previous.locationId && edge.from === locationId)),
      )
    )
      throw new Error(
        'Moving a feature needs an established open adjacent route; state updates never move passengers.',
      );

    if (update.properties) {
      const properties: SceneFeature['properties'] = Object.create(null);
      for (const [key, state] of Object.entries(update.properties)) {
        const normalized = featureNameKey(key);
        if (Object.hasOwn(properties, normalized) && properties[normalized] !== state)
          throw new Error('A feature property cannot have two current values.');
        properties[normalized] = state;
      }
      update.properties = properties;
      if (Object.hasOwn(properties, 'passable')) {
        if (typeof properties.passable !== 'boolean')
          throw new Error('Route passability must be a boolean, using passable and a bound route.');
        if (update.passable !== undefined && update.passable !== properties.passable)
          throw new Error('A feature cannot declare contradictory passability.');
        update.passable = properties.passable;
        delete properties.passable;
      }
    }
    const route =
      update.route === undefined
        ? previous?.route
        : update.route && { from: resolve(update.route.from), to: resolve(update.route.to) };
    const connections = value.mapUpdates?.connections ?? [];
    const routeEdge =
      route &&
      (connections.find((edge) => pair({ from: resolve(edge.from), to: resolve(edge.to) }) === pair(route)) ??
        featureConnection(context.scene, route));
    if (route && (!routeEdge || ![route.from, route.to].includes(locationId)))
      throw new Error(
        'A feature can control a route at its place only; discover new routes through mapUpdates.',
      );
    if (update.passable !== undefined && !route)
      throw new Error('Feature passability needs its saved or supplied route.');
    const change = (route: NonNullable<SceneFeature['route']>, blocked: boolean) => {
      const edges = (value.mapUpdates ??= { locations: [], connections: [] }).connections;
      const explicit = edges.find(
        (edge) => pair({ from: resolve(edge.from), to: resolve(edge.to) }) === pair(route),
      );
      if (explicit) {
        if (explicit.blocked !== blocked)
          throw new Error('Feature passability contradicts its map route update.');
        return;
      }
      const edge = featureConnection(context.scene, route);
      if (!edge) throw new Error('A scene feature cannot invent a map connection.');
      if (edge.blocked === blocked) return;
      if (edges.length >= 60) throw new Error('Update at most sixty routes per turn.');
      edges.push({ ...edge, eventId: event.id, blocked });
    };
    if (previous?.route && update.route !== undefined && (!route || pair(previous.route) !== pair(route)))
      change(previous.route, true);
    if (route && update.passable !== undefined) change(route, !update.passable);
    update.featureId = id;
    if (update.route) update.route = route;
    projected.features = {
      ...projected.features,
      [id]: {
        ...previous,
        id,
        name: previous?.name ?? update.name,
        locationId,
        aliases: [
          ...new Set([
            ...(previous?.aliases ?? []),
            ...(update.aliases ?? []),
            ...(previous && previous.name !== update.name ? [update.name] : []),
          ]),
        ],
        properties: { ...previous?.properties, ...update.properties },
        route,
        fact: event.fact,
      },
    };
  }
}

/** Applied inside finalization, together with routes and positions; retry reuses the saved resolution. */
export function applyFeatureUpdates(scene: Scene, value: TurnAdjudication, resolve: (ref: string) => string) {
  for (const update of value.featureUpdates ?? []) {
    const previous =
      scene.features && Object.hasOwn(scene.features, update.featureId)
        ? scene.features[update.featureId]
        : undefined;
    const feature: SceneFeature = {
      id: update.featureId,
      name: previous?.name ?? update.name,
      aliases: [
        ...new Set([
          ...(previous?.aliases ?? []),
          ...(update.aliases ?? []),
          ...(previous && previous.name !== update.name ? [update.name] : []),
        ]),
      ],
      locationId: resolve(update.locationId),
      properties: { ...previous?.properties, ...update.properties },
      fact: value.events.find((event) => event.id === update.eventId)!.fact,
      route:
        update.route === undefined
          ? previous?.route
          : update.route && { from: resolve(update.route.from), to: resolve(update.route.to) },
    };
    // Access is stored only in the map, including when an older save duplicated this property.
    if (feature.route) delete feature.properties.passable;
    scene.features = { ...scene.features, [feature.id]: feature };
  }
}
