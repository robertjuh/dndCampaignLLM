import type { GMContext } from './game';
import type { Enemy, Encounter, NPCState, Scene } from '../shared/schema';
import type { TurnAdjudication, ResolvedEvent } from '../shared/turn-resolution';
import { combatActive, memberScene } from '../shared/locations';
import { npcNameKey, npcNames } from '../shared/npcs';
import { gatheringOptions, memberLocationAtEvent, turnConnections } from './world-map';

/** Backfill old saves from actual encounters; never infer life or location from old prose. */
export function knownNPCs(scene: Scene): Record<string, NPCState> {
  const npcs: Record<string, NPCState> = Object.assign(
    Object.create(null),
    structuredClone(scene.npcs ?? {}),
  );
  for (const place of [scene, ...Object.values(scene.places ?? {})])
    for (const enemy of place.encounter?.enemies ?? [])
      npcs[enemy.id] ??= {
        id: enemy.id,
        name: enemy.name,
        aliases: [],
        locationId: place.location.id!,
        status: enemy.hp === 0 ? 'dead' : enemy.withdrawn ? 'withdrawn' : 'alive',
        allegiance: null,
        fact: enemy.description,
        enemy: structuredClone(enemy),
      };
  return npcs;
}

export function npcIdentity(scene: Scene, id: string, name: string, aliases: string[] = []) {
  const npcs = knownNPCs(scene);
  const names = [name, ...aliases].map(npcNameKey);
  const existing = npcs[id];
  const newNames = existing
    ? names.filter((name) => !npcNames(existing).map(npcNameKey).includes(name))
    : names;
  const matches = Object.values(npcs).filter((npc) =>
    npcNames(npc).some((name) => newNames.includes(npcNameKey(name))),
  );
  if ((existing && matches.some((npc) => npc.id !== id)) || (!existing && matches.length > 1))
    throw new Error('An NPC alias cannot merge two established people; use their saved IDs.');
  return existing ?? matches[0];
}

/** Bind a spoken source before dice; a public role is enough without inventing a proper name. */
export function bindNPCSource(
  scene: Scene,
  source: { id: string; name?: string; description?: string; aliases?: string[] },
  locationId: string,
) {
  const saved = knownNPCs(scene)[source.id];
  const previous = npcIdentity(scene, source.id, source.name ?? saved?.name ?? source.id, source.aliases);
  if (previous?.status === 'dead') throw new Error('A dead NPC cannot answer a new question.');
  if (previous && previous.locationId !== locationId)
    throw new Error(`${previous.name} is at another location; use their actual location.`);
  if (!previous && !(source.id.startsWith('new:') && source.name?.trim() && source.description?.trim()))
    throw new Error('Use a saved NPC ID, or introduce a new: person with a stable public name/role and description.');
  const npc: NPCState = previous ? structuredClone(previous) : {
    id: source.id,
    name: source.name!.trim(),
    aliases: source.aliases ?? [],
    locationId,
    status: 'alive',
    allegiance: null,
    fact: `${source.name!.trim()}. ${source.description!.trim()}`,
  };
  return {
    id: npc.id,
    name: npc.name,
    description: npc.fact.slice(0, 500),
    aliases: [...npc.aliases],
    locationId,
    npc,
    isNew: !previous,
  };
}

function remember(scene: Scene, id: string, name: string, locationId: string | null) {
  scene.npcs ??= knownNPCs(scene);
  Object.setPrototypeOf(scene.npcs, null);
  const previous = scene.npcs[id];
  const npc =
    previous ??
    (scene.npcs[id] = { id, name, aliases: [], locationId, status: 'alive', allegiance: null, fact: '' });
  if (
    npcNameKey(name) !== npcNameKey(npc.name) &&
    !npc.aliases.some((alias) => npcNameKey(alias) === npcNameKey(name))
  )
    npc.aliases.push(name);
  return npc;
}

/** Restore an existing person's mechanics before any initiative or loot dice are drawn. */
export function persistentEnemy(
  context: GMContext,
  proposed: Omit<Enemy, 'maxHp' | 'initiative'>,
  origin: string,
): Omit<Enemy, 'maxHp' | 'initiative'> & Partial<Pick<Enemy, 'maxHp' | 'initiative'>> {
  if (
    context.members.some(
      (member) =>
        member.id === proposed.id || npcNameKey(member.character.name) === npcNameKey(proposed.name),
    )
  )
    throw new Error('A player character cannot be introduced as an NPC.');
  const npc = npcIdentity(context.scene, proposed.id, proposed.name);
  if (!npc) return proposed;
  if (npc.status === 'dead' || npc.enemy?.hp === 0) throw new Error(`${npc.name} is permanently dead.`);
  if (
    npc.locationId !== origin &&
    !(
      npc.locationId &&
      context.scene.worldMap?.nodes[npc.locationId]?.visited &&
      context.scene.worldMap.connections.some(
        (edge) =>
          !edge.blocked &&
          ((edge.from === npc.locationId && edge.to === origin) ||
            (edge.bidirectional && edge.to === npc.locationId && edge.from === origin)),
      )
    )
  )
    throw new Error(`${npc.name} is not at the encounter's origin or an openly adjacent place.`);
  if (
    [context.scene, ...Object.values(context.scene.places ?? {})].some(
      (place) =>
        combatActive(place) &&
        place.encounter!.enemies.some((enemy) => enemy.id === npc.id && !enemy.withdrawn && enemy.hp > 0),
    )
  )
    throw new Error(`${npc.name} already participates in an active encounter.`);
  const enemy = { ...proposed, ...structuredClone(npc.enemy), id: npc.id, name: npc.name, withdrawn: false };
  delete enemy.readyRound;
  return enemy;
}

export function rememberNPCReaction(
  scene: Scene,
  id: string,
  name: string,
  origin: string,
  fact: string,
  joining: boolean,
) {
  const npc = remember(scene, id, name, origin);
  npc.locationId = origin;
  npc.fact = fact;
  if (joining) npc.status = 'alive';
}

/** Only engine execution can overwrite saved HP, equipment, conditions or death. */
export function saveNPCEncounter(scene: Scene, locationId: string, encounter: Encounter) {
  scene.npcs ??= knownNPCs(scene);
  for (const enemy of encounter.enemies) {
    if (enemy.withdrawn && scene.npcs[enemy.id] && scene.npcs[enemy.id].locationId !== locationId) continue;
    const npc = remember(scene, enemy.id, enemy.name, locationId);
    if (npc.status === 'dead' && enemy.hp > 0) throw new Error(`${npc.name} is permanently dead.`);
    npc.locationId = locationId;
    npc.status =
      enemy.hp === 0
        ? 'dead'
        : enemy.withdrawn
          ? npc.status === 'surrendered'
            ? 'surrendered'
            : 'withdrawn'
          : 'alive';
    npc.enemy = structuredClone(enemy);
  }
}

export function validateNPCUpdates(
  context: GMContext,
  value: TurnAdjudication,
  resolve: (ref: string) => string,
) {
  // A recorded exchange is itself a public memory, even without a redundant update.
  const established = knownNPCs(context.scene);
  for (const event of value.events)
    if (event.npcIds)
      event.npcIds = event.npcIds.map((id) => {
        const proposed = value.npcUpdates?.find((update) => update.npcId === id);
        return proposed
          ? (npcIdentity(context.scene, proposed.npcId, proposed.name, proposed.aliases)?.id ?? id)
          : id;
      });
  for (const event of value.events) {
    if (!event.npcIds) continue;
    if (
      !['action', 'world'].includes(event.kind) ||
      event.presentation ||
      !event.locationRef ||
      new Set(event.npcIds).size !== event.npcIds.length
    )
      throw new Error('NPC interactions need distinct public participants and an observed local event.');
    for (const id of event.npcIds) {
      const npc = established[id];
      const explicit = value.npcUpdates?.find(
        (update) =>
          update.npcId === id ||
          npcIdentity(context.scene, update.npcId, update.name, update.aliases)?.id === id,
      );
      if (!npc && !explicit) throw new Error('Introduce an unknown NPC participant through npcUpdates.');
      if (npc?.status === 'dead') throw new Error('A dead NPC cannot participate in a new interaction.');
      if (explicit) continue;
      const updates = (value.npcUpdates ??= []);
      if (updates.length >= 30) throw new Error('Record at most thirty NPC updates per turn.');
      const last = [...value.events].reverse().find((other) => other.npcIds?.includes(id))!;
      updates.push({
        npcId: id,
        name: npc!.name,
        locationId: npc!.locationId,
        eventId: last.id,
      });
    }
  }
  if (!value.npcUpdates) return;
  const scene = { ...context.scene, npcs: knownNPCs(context.scene) };
  const updated = new Set<string>();
  const history = new Map<string, { sequence: number; npc: NPCState }[]>();
  value.npcUpdates.sort(
    (a, b) =>
      (value.events.find((event) => event.id === a.eventId)?.sequence ?? Infinity) -
      (value.events.find((event) => event.id === b.eventId)?.sequence ?? Infinity),
  );
  for (const update of value.npcUpdates) {
    if (
      context.members.some(
        (member) =>
          member.id === update.npcId ||
          [update.name, ...(update.aliases ?? [])].some(
            (name) => npcNameKey(member.character.name) === npcNameKey(name),
          ),
      )
    )
      throw new Error('NPC updates cannot change a player character.');
    const previous = npcIdentity(scene, update.npcId, update.name, update.aliases);
    const id = previous?.id ?? update.npcId;
    const features = [
      ...Object.values(context.scene.features ?? {}),
      ...(value.featureUpdates ?? []).map((feature) => ({
        id: feature.featureId,
        name: feature.name,
        aliases: feature.aliases ?? [],
      })),
    ];
    const items = [
      ...context.members.flatMap((member) => [
        ...member.state.inventory,
        ...Object.values(member.state.equipment).filter((item) => item != null),
      ]),
      ...Object.values(established).flatMap((npc) => npc.enemy?.equipment ?? []),
      ...[context.scene, ...Object.values(context.scene.places ?? {})].flatMap((place) => place.loot),
    ];
    if (
      items.some((item) => item.id === id || item.id === update.npcId) ||
      features.some(
        (feature) =>
          feature.id === id ||
          feature.id === update.npcId ||
          [feature.name, ...feature.aliases].some((name) =>
            [update.name, ...(update.aliases ?? [])].some((other) => npcNameKey(name) === npcNameKey(other)),
          ),
      )
    )
      throw new Error('An NPC identity cannot replace scenery or an item.');
    const changeId = `${id}:${update.eventId}`;
    if (updated.has(changeId)) throw new Error('Update an NPC only once per event.');
    updated.add(changeId);
    const event = value.events.find((event) => event.id === update.eventId);
    const locationId = update.locationId === null ? null : resolve(update.locationId);
    const eventLocation = event?.locationRef ? resolve(event.locationRef) : undefined;
    const names = [update.name, ...(update.aliases ?? []), ...(previous ? npcNames(previous) : [])];
    if (
      !event ||
      event.presentation ||
      !['action', 'world', 'combat'].includes(event.kind) ||
      (['failure', 'blocked'].includes(event.result ?? '') &&
        !(
          event.npcIds?.includes(id) &&
          previous &&
          locationId === previous.locationId &&
          (!update.status || update.status === previous.status) &&
          (update.followingMemberId === undefined ||
            update.followingMemberId === previous.followingMemberId) &&
          (update.allegiance === undefined || update.allegiance === previous.allegiance)
          && (update.factionId === undefined || update.factionId === previous.factionId)
        )) ||
      ((!previous || !event.npcIds?.includes(id)) &&
        !names.some((name) => npcNameKey(event.fact).includes(npcNameKey(name)))) ||
      !eventLocation ||
      (locationId !== null && eventLocation !== locationId) ||
      !context.members.some(
        (member) =>
          member.active &&
          member.state.hp > 0 &&
          memberLocationAtEvent(context, value, member.id, event.id, resolve) === eventLocation,
      )
    )
      throw new Error('NPC state needs an observed, successful or informational event at its stated place.');
    if (previous?.status === 'dead' && update.status && update.status !== 'dead')
      throw new Error('An NPC death is permanent; old descriptions cannot restore them.');
    if (update.factionId && !context.factions?.factions.some((faction) => faction.id === update.factionId))
      throw new Error('An NPC faction connection must use an existing faction ID.');
    if (previous && previous.status !== 'dead' && update.status === 'dead')
      throw new Error('A living NPC can die only through recorded engine execution.');
    if (update.followingMemberId) {
      const leader = context.members.find(
        (member) => member.id === update.followingMemberId && member.active,
      );
      if (
        !leader ||
        memberLocationAtEvent(context, value, leader.id, event.id, resolve) !== locationId ||
        (update.status ?? previous?.status) === 'dead'
      )
        throw new Error('An accompanying NPC needs a living identity and a present travelling character.');
    }
    const leader = previous?.followingMemberId;
    const position = value.memberLocations?.find((position) => position.memberId === leader);
    const movement = value.events.find((event) => event.id === position?.movementEventId);
    const gathering = leader && context.turn.actions.find((action) => action.memberId === leader)?.gathering;
    const gatheredTogether = !!(
      leader &&
      gathering &&
      previous?.locationId === memberScene(context.scene, leader).location.id &&
      locationId &&
      position &&
      resolve(position.locationId) === locationId &&
      movement?.memberId === leader &&
      movement.kind === 'action' &&
      movement.result === 'success' &&
      movement.effect === 'movement' &&
      movement.sequence <= event.sequence &&
      gatheringOptions(context, value, resolve, movement.id)[leader]?.path.includes(locationId)
    );
    if (
      previous?.locationId &&
      locationId &&
      previous.locationId !== locationId &&
      !gatheredTogether &&
      !turnConnections(context.scene, value, resolve, event.id).some(
        (edge) =>
          !edge.blocked &&
          ((edge.from === previous.locationId && edge.to === locationId) ||
            (edge.bidirectional && edge.to === previous.locationId && edge.from === locationId)),
      )
    )
      throw new Error('NPC movement needs an established open adjacent route.');
    const fighting = [context.scene, ...Object.values(context.scene.places ?? {})].some(
      (place) =>
        combatActive(place) &&
        place.encounter!.enemies.some((enemy) => enemy.id === id && enemy.hp > 0 && !enemy.withdrawn),
    );
    if (fighting && (locationId !== previous?.locationId || (update.status && update.status !== 'alive')))
      throw new Error('NPC prose cannot remove a living participant from active combat.');
    update.npcId = id;
    const aliases = [
      ...new Set([
        ...(previous?.aliases ?? []),
        ...(update.aliases ?? []),
        ...(previous && update.name !== previous.name ? [update.name] : []),
      ]),
    ];
    scene.npcs[id] = {
      ...previous,
      id,
      name: previous?.name ?? update.name,
      aliases,
      locationId,
      status: update.status ?? previous?.status ?? 'alive',
      allegiance: update.allegiance === undefined ? (previous?.allegiance ?? null) : update.allegiance,
      factionId: update.factionId === undefined ? previous?.factionId : update.factionId,
      ...(update.followingMemberId !== undefined ? { followingMemberId: update.followingMemberId } : {}),
      fact: event.fact,
    };
    const changes = history.get(id) ?? [];
    changes.push({ sequence: event.sequence, npc: structuredClone(scene.npcs[id]) });
    history.set(id, changes);
  }
  for (const event of value.events.filter((event) => event.npcIds)) {
    const locationId = resolve(event.locationRef!);
    if (
      !context.members.some(
        (member) =>
          member.active &&
          member.state.hp > 0 &&
          memberLocationAtEvent(context, value, member.id, event.id, resolve) === locationId,
      )
    )
      throw new Error('NPC interactions need a conscious observer at the time of the exchange.');
    for (const id of event.npcIds!) {
      const previous = established[id];
      const npc =
        [...(history.get(id) ?? [])].reverse().find((change) => change.sequence <= event.sequence)?.npc ??
        previous;
      if (!npc || npc.status === 'dead' || npc.locationId !== locationId)
        throw new Error('NPC dialogue requires living participants at their actual observed location.');
    }
  }
}

export function applyNPCUpdates(scene: Scene, value: TurnAdjudication, resolve: (ref: string) => string) {
  scene.npcs ??= knownNPCs(scene);
  for (const update of value.npcUpdates ?? []) {
    const npc = remember(
      scene,
      update.npcId,
      update.name,
      update.locationId === null ? null : resolve(update.locationId),
    );
    npc.aliases = [...new Set([...npc.aliases, ...(update.aliases ?? [])])];
    npc.locationId = update.locationId === null ? null : resolve(update.locationId);
    npc.status = update.status ?? npc.status;
    if (update.allegiance !== undefined) npc.allegiance = update.allegiance;
    if (update.factionId !== undefined) npc.factionId = update.factionId;
    if (update.followingMemberId !== undefined) npc.followingMemberId = update.followingMemberId;
    npc.fact = value.events.find((event) => event.id === update.eventId)!.fact;
  }
}

/** Keep public exchanges in existing journal memory, outside generated response quotas. */
export function journalWithNPCInteractions(
  journal: GMContext['journal'],
  scene: Scene,
  events: Pick<ResolvedEvent, 'npcIds' | 'fact'>[],
  previous: GMContext['journal'],
) {
  const result = structuredClone(journal);
  for (const event of events)
    for (const id of event.npcIds ?? []) {
      const npc = scene.npcs?.[id];
      if (!npc) continue;
      const matches = (entry: GMContext['journal'][number]) =>
        entry.kind === 'npc' && npcNames(npc).some((name) => npcNameKey(name) === npcNameKey(entry.name));
      let entry = result.find(matches);
      if (!entry) {
        const old = previous.find(matches);
        entry = { kind: 'npc', name: old?.name ?? npc.name, detail: old?.detail ?? '' };
        result.push(entry);
      }
      if (!entry.detail.includes(event.fact)) {
        const detail = [entry.detail, event.fact].filter(Boolean).join('\n');
        // Current journal memory is bounded; full exchanges remain in completed event history.
        entry.detail = detail.length <= 1500 ? detail : event.fact.slice(0, 1500);
      }
    }
  return result;
}
