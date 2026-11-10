import type { GMContext } from './game';
import type { Scene } from '../shared/schema';
import type { TurnAdjudication } from '../shared/turn-resolution';
import { containingStructure, structureChain, type Structure } from '../shared/structures';
import { knownLocations } from '../shared/locations';
import { memberLocationAtEvent } from './world-map';
import { knownNPCs } from './npcs';

const identity = (id: string) => id;

/** Project containment at an event; boarding before departure differs from boarding after it. */
export function structureSceneAtEvent(
  context: Pick<GMContext, 'scene'>,
  value: TurnAdjudication,
  resolve = identity,
  eventId?: string,
): Scene {
  const boundary = eventId
    ? (value.events.find((event) => event.id === eventId)?.sequence ?? Infinity)
    : Infinity;
  const structures = structuredClone(context.scene.structures ?? {});
  const updates = [
    ...(value.structureUpdates ?? []).map((update) => ({ type: 'definition' as const, update })),
    ...(value.structureMoves ?? []).map((update) => ({ type: 'move' as const, update })),
  ].sort(
    (a, b) =>
      (value.events.find((event) => event.id === a.update.eventId)?.sequence ?? Infinity) -
      (value.events.find((event) => event.id === b.update.eventId)?.sequence ?? Infinity),
  );
  for (const entry of updates) {
    const event = value.events.find((event) => event.id === entry.update.eventId);
    if (!event || (entry.type === 'move' && event.sequence >= boundary)) continue;
    if (entry.type === 'definition') {
      const { eventId: _, ...update } = entry.update;
      structures[update.id] = {
        ...update,
        locationId: structures[update.id]?.locationId ?? resolve(update.locationId),
        entranceId: resolve(update.entranceId),
        controlId: update.controlId && resolve(update.controlId),
        roomIds: update.roomIds.map(resolve),
        // Room declarations describe containment; access changes take effect at their event.
        ...(event.sequence > boundary && structures[update.id]
          ? { access: structures[update.id].access }
          : {}),
      };
    } else {
      const previous = structures[entry.update.structureId];
      if (previous)
        structures[previous.id] = {
          ...previous,
          locationId: resolve(entry.update.to),
          access: entry.update.access,
        };
    }
  }
  return { ...context.scene, structures };
}

export function validateStructures(
  context: GMContext,
  value: TurnAdjudication,
  resolve: (ref: string) => string,
) {
  const transports = value.events.filter(
    (event) => event.effect === 'transport' && event.result === 'success',
  );
  if (transports.some((event) => !value.structureMoves?.some((move) => move.eventId === event.id)))
    throw new Error('Every successful transport event needs its corresponding structureMoves entry.');
  if (!value.structureUpdates?.length && !value.structureMoves?.length) return;
  const scene = structureSceneAtEvent(context, value, resolve);
  const known = new Set([
    ...Object.keys(knownLocations(context.scene)),
    ...(value.placeUpdates ?? []).map((place) => resolve(place.ref)),
    ...(value.mapUpdates?.locations ?? []).map((place) => resolve(place.ref)),
  ]);
  const seen = new Set<string>();
  const rooms = new Set<string>();
  for (const structure of Object.values(scene.structures ?? {})) {
    if (
      !known.has(structure.locationId) ||
      !structure.roomIds.every((id) => known.has(id)) ||
      !structure.roomIds.includes(structure.entranceId) ||
      (structure.mobile && (!structure.controlId || !structure.roomIds.includes(structure.controlId))) ||
      structure.roomIds.includes(structure.locationId)
    )
      throw new Error(
        `Structure ${structure.id} needs known rooms, an entrance, a separate world location and a control room when mobile.`,
      );
    for (const room of structure.roomIds) {
      if (rooms.has(room)) throw new Error('A room belongs to exactly one structure.');
      rooms.add(room);
    }
    let cursor: Structure | undefined = structure;
    const ancestors = new Set<string>();
    while (cursor) {
      if (ancestors.has(cursor.id))
        throw new Error('Structures cannot contain themselves, directly or through another structure.');
      ancestors.add(cursor.id);
      cursor = containingStructure(scene, cursor.locationId);
    }
  }
  for (const update of value.structureUpdates ?? []) {
    if (seen.has(update.id)) throw new Error('Define each structure once per turn, combining its room list.');
    seen.add(update.id);
    const previous = context.scene.structures?.[update.id];
    if (known.has(update.id) || (!previous && !/^new:[a-zA-Z0-9_-]{1,80}$/.test(update.id)))
      throw new Error(
        'A new structure needs its own new: identity, separate from its rooms and world location.',
      );
    if (
      previous &&
      (resolve(update.locationId) !== previous.locationId ||
        update.mobile !== previous.mobile ||
        resolve(update.entranceId) !== previous.entranceId ||
        (update.controlId && resolve(update.controlId)) !== previous.controlId ||
        previous.roomIds.some((id) => !update.roomIds.map(resolve).includes(id)))
    )
      throw new Error(
        'Keep established structure rooms and mobility; move a mobile structure with transport, never by redefining it.',
      );
    const event = value.events.find((event) => event.id === update.eventId);
    const at = event?.locationRef && resolve(event.locationRef);
    if (
      !event ||
      !['world', 'action'].includes(event.kind) ||
      event.presentation ||
      ['failure', 'blocked'].includes(event.result ?? '') ||
      !at ||
      !context.members.some(
        (member) =>
          member.active &&
          member.state.hp > 0 &&
          memberLocationAtEvent(context, value, member.id, event.id, resolve) === at,
      ) ||
      (at !== resolve(update.locationId) && !update.roomIds.map(resolve).includes(at))
    )
      throw new Error(
        'Establish a structure through a public event witnessed at its outside location or one of its rooms.',
      );
  }
  seen.clear();
  for (const move of value.structureMoves ?? []) {
    if (seen.has(move.structureId))
      throw new Error('A structure travels at most one world connection per turn.');
    seen.add(move.structureId);
    const event = value.events.find((event) => event.id === move.eventId);
    const before = structureSceneAtEvent(context, value, resolve, move.eventId);
    const structure = before.structures?.[move.structureId];
    const action = value.actions.find((action) => action.memberId === move.memberId);
    const submitted = context.turn.actions.find((action) => action.memberId === move.memberId);
    const member = context.members.find((member) => member.id === move.memberId);
    const at = event && memberLocationAtEvent(context, value, move.memberId, event.id, resolve);
    const operator = move.operatorId && knownNPCs(context.scene)[move.operatorId];
    const controlled = move.operatorId
      ? operator &&
        operator.status === 'alive' &&
        operator.locationId === structure?.controlId &&
        (!operator.enemy || (operator.enemy.hp > 0 && !operator.enemy.withdrawn))
      : at === structure?.controlId;
    if (
      !structure?.mobile ||
      !event ||
      event.kind !== 'action' ||
      event.memberId !== move.memberId ||
      event.phase !== 'main' ||
      event.effect !== 'transport' ||
      event.result !== 'success' ||
      !submitted ||
      submitted.passed ||
      submitted.gathering ||
      !member?.active ||
      member.state.hp <= 0 ||
      !action?.components.main?.eventIds.includes(event.id) ||
      !at ||
      !structureChain(before, at).some((parent) => parent.id === structure.id) ||
      !controlled ||
      resolve(event.locationRef ?? '') !== at
    )
      throw new Error(
        'Transport needs a submitted successful main action aboard the structure, operated at its saved controls by that actor or the explicitly identified living crew member.',
      );
    const to = resolve(move.to),
      from = structure.locationId;
    if (
      !known.has(to) ||
      containingStructure(before, from)?.id !== containingStructure(before, to)?.id ||
      structureChain(before, to).some((parent) => parent.id === structure.id)
    )
      throw new Error(
        'A structure travels within its containing world; it cannot enter itself or bypass an enclosure.',
      );
    const edges = [
      ...(before.worldMap?.connections ?? []),
      ...(value.mapUpdates?.connections ?? [])
        .filter(
          (edge) =>
            (value.events.find((entry) => entry.id === edge.eventId)?.sequence ?? Infinity) <= event.sequence,
        )
        .map((edge) => ({ ...edge, from: resolve(edge.from), to: resolve(edge.to) })),
    ];
    // Later route declarations replace earlier state, including blocked and one-way routes.
    const edge = edges
      .slice()
      .reverse()
      .find((edge) => (edge.from === from && edge.to === to) || (edge.to === from && edge.from === to));
    if (
      to === from
        ? move.access === structure.access
        : !edge || edge.blocked || !(edge.from === from || edge.bidirectional)
    )
      throw new Error(
        'Transport follows one open adjacent world route; docking in place must change access.',
      );
  }
}

export function applyStructures(scene: Scene, value: TurnAdjudication, resolve: (ref: string) => string) {
  if (!value.structureUpdates?.length && !value.structureMoves?.length) return;
  scene.structures = structureSceneAtEvent({ scene }, value, resolve).structures;
}

export function witnessedLocations(scene: Scene, locationId: string) {
  return [locationId, ...structureChain(scene, locationId).map((structure) => structure.locationId)];
}
