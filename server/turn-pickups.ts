import type { GMContext } from './game';
import type { Item, Scene } from '../shared/schema';
import { aggregateComponents, type TurnAdjudication } from '../shared/turn-resolution';
import { memberScene, placeScene, savePlace, combatActive } from '../shared/locations';
import { baseItem, incapacitatingCondition, takeItem, offerGroundItem } from '../shared/rules';
import { adjudicationPlaceRef } from './turn-resolution';

/** Narrow consent guard; interpretation and item/pronoun matching remain the adjudicator's job. */
export function requestsPickup(text: string) {
  return text
    .split(/[.;!\n]|\b(?:and|then|en|daarna)\b/iu)
    .some(
      (part) =>
        /\b(?:take|collect|grab|pocket|pick\s+(?:\w+\s+){0,3}up|neem|pak|verzamel|raap)\b/iu.test(part) &&
        !/\b(?:not|never|don't|won't|niet|nooit|geen)\b/iu.test(part) &&
        !/\btake\s+(?:(?:a|an|the|some|my|our|his|her|their|this|that)\s+)?(?:look|stairs?|steps?|road|path|route|turn|cover|breath|break|time|care|position|seat|watch|aim|action|damage|risk|part|test)\b/iu.test(
          part,
        ) &&
        !/\bneem\s+(?:(?:een|de|het|mijn|onze|die|dat)\s+)?(?:kijkje|trap|trappen|weg|route|afslag|pauze|adem|tijd|plaats|positie|risico)\b/iu.test(
          part,
        ) &&
        !/\bpick\s+up\s+(?:the\s+)?(?:pace|trail|speed)\b/iu.test(part),
    );
}

export type PickupResult = {
  eventId: string;
  memberId: string;
  itemId: string;
  locationId: string;
  quantity: number;
};

/** Simulate before encounter checks; apply the same deterministic operations once at finalization. */
export function resolvePickups(context: GMContext, input: TurnAdjudication) {
  const value = structuredClone(input);
  const scene = structuredClone(context.scene);
  const members = structuredClone(context.members);
  const results: PickupResult[] = [];
  const positions = new Map(members.map((member) => [member.id, memberScene(scene, member.id).location.id!]));
  const resolve = adjudicationPlaceRef(context, value);
  const virtual = new Map<string, Scene>();
  const loot = context.receipts?.loot as
    | {
        item: Item;
        locationId: string;
        pendingPlacement?: boolean;
      }
    | undefined;
  const claimed = new Set<string>();
  const storyIds = new Set<string>();
  for (const item of value.storyItems ?? []) {
    const pickup = value.pickups?.find(
      (pickup) => pickup.eventId === item.eventId && pickup.itemId === item.id,
    );
    const event = value.events.find((event) => event.id === item.eventId);
    const at = resolve(item.locationId);
    const known = at === scene.location.id || !!scene.places?.[at];
    if (!pickup || !event?.locationRef || resolve(event.locationRef) !== at || storyIds.has(item.id))
      throw new Error('A story object must belong to one local pickup operation.');
    if (known && placeScene(scene, at).searchedLoot?.[item.sourceId])
      throw new Error('This story object source is already exhausted.');
    if (
      members.some((member) =>
        [
          ...member.state.inventory,
          ...Object.values(member.state.equipment).filter((item) => item != null),
        ].some((saved) => saved.id === item.id),
      ) ||
      [scene, ...Object.values(scene.places ?? {})].some((place) =>
        place.loot.some((saved) => saved.id === item.id),
      )
    )
      throw new Error('A saved item cannot be recreated as a story object.');
    storyIds.add(item.id);
    let place = virtual.get(at) ?? (known ? structuredClone(placeScene(scene, at)) : undefined);
    if (!place) {
      const location = value.placeUpdates?.find((place) => resolve(place.ref) === at)?.location;
      if (!location) throw new Error('A new story object needs an established local place.');
      place = { ...structuredClone(scene), location: { ...location, id: at }, loot: [], encounter: null };
    }
    offerGroundItem(place, { ...baseItem(item.id, item.name, 'tool'), description: item.description, sourceId: item.sourceId });
    virtual.set(at, place);
  }
  for (const pickup of value.pickups ?? []) {
    if (claimed.has(pickup.eventId)) throw new Error('A pickup event may collect only one item stack.');
    claimed.add(pickup.eventId);
    const action = value.actions.find((action) => action.memberId === pickup.memberId);
    const submitted = context.turn.actions.find((action) => action.memberId === pickup.memberId);
    const event = value.events.find((event) => event.id === pickup.eventId);
    const component =
      event?.phase === 'main' || event?.phase === 'minor' ? action?.components[event.phase] : null;
    if (
      !action ||
      !members.some((member) => member.id === pickup.memberId) ||
      !submitted ||
      submitted.passed ||
      !event ||
      event.kind !== 'action' ||
      event.memberId !== pickup.memberId ||
      event.actionId !== action.actionId ||
      !component ||
      (component.basis !== 'routine' && !(component.status === 'blocked' && component.basis === 'none')) ||
      !component.eventIds.includes(event.id) ||
      !event.locationRef ||
      event.effect
    )
      throw new Error('Pickup requires explicit taking intent and its own routine action event at the item.');
  }
  const failed = new Set<string>();
  const absent = new Set<string>();
  for (const event of value.events) {
    if (
      event.dependsOn.some(
        (dep) => absent.has(dep.eventId) || (dep.requires === 'success' && failed.has(dep.eventId)),
      )
    ) {
      failed.add(event.id);
      if (event.kind === 'world') absent.add(event.id);
      if (event.kind === 'action') {
        event.result = 'blocked';
        if (event.memberId) event.locationRef = positions.get(event.memberId);
        for (const dependency of event.dependsOn)
          if (failed.has(dependency.eventId)) dependency.requires = 'occurrence';
        event.fact =
          context.config.language === 'Nederlands'
            ? 'Dit deel blijft onuitgevoerd omdat het benodigde voorwerp niet is opgepakt.'
            : 'This part remains unperformed because the required item was not collected.';
      }
      continue;
    }
    const move = value.memberLocations?.find((position) => position.movementEventId === event.id);
    if (move && event.result === 'success') positions.set(move.memberId, resolve(move.locationId));
    const pickup = value.pickups?.find((pickup) => pickup.eventId === event.id);
    if (!pickup || event.result !== 'success') continue;
    const member = members.find((member) => member.id === pickup.memberId)!;
    const locationId = resolve(event.locationRef!);
    const known = locationId === scene.location.id || !!scene.places?.[locationId];
    let place = virtual.get(locationId) ?? (known ? placeScene(scene, locationId) : undefined);
    if (
      loot?.pendingPlacement &&
      resolve(loot.locationId) === locationId &&
      !place?.loot.some((item) => item.id === loot.item.id)
    ) {
      if (place) place = structuredClone(place);
      else {
        const location = value.placeUpdates?.find((update) => update.ref === locationId)?.location;
        if (location) {
          place = {
            ...structuredClone(scene),
            location: { ...location, id: locationId },
            loot: [],
            encounter: null,
          };
        }
      }
      if (place) {
        offerGroundItem(place, loot.item);
        virtual.set(locationId, place);
      }
    }
    const item = place?.loot.find((item) => item.id === pickup.itemId);
    const baseline = context.receipts?.encounterProposal as TurnAdjudication | undefined;
    const starts = context.receipts?.startCombatByLocation as Record<string, unknown> | undefined;
    const beforeEncounter =
      !!starts?.[locationId] &&
      baseline?.pickups?.some(
        (saved) =>
          saved.eventId === pickup.eventId &&
          saved.memberId === pickup.memberId &&
          saved.itemId === pickup.itemId &&
          (saved.quantity ?? 1) === (pickup.quantity ?? 1),
      );
    let error = '';
    let quantity = 0;
    if (!requestsPickup(context.turn.actions.find((action) => action.memberId === member.id)!.text))
      error = 'The submitted action did not request collection.';
    else if (positions.get(member.id) !== locationId) error = 'The item is at another location.';
    else if (!place || !item) error = 'The item is no longer available.';
    else if (member.state.hp <= 0 || incapacitatingCondition(member.state))
      error = 'The character cannot collect items.';
    else if (combatActive(place) && !beforeEncounter) error = 'Scene loot cannot be collected during combat.';
    else {
      const state = structuredClone(member.state);
      const ground = structuredClone(place);
      try {
        if ((pickup.quantity ?? 1) > item.quantity) throw new Error('That quantity is no longer available.');
        for (; quantity < (pickup.quantity ?? 1); quantity++)
          takeItem(member.character, state, ground, item.id);
        member.state = state;
        place.loot = ground.loot;
        if (known) {
          const ground = virtual.has(locationId)
            ? place.loot.filter((item) => item.id !== loot?.item.id && !storyIds.has(item.id))
            : place.loot;
          if (locationId === scene.location.id) scene.loot = ground;
          else savePlace(scene, { ...place, loot: ground });
        }
        results.push({ ...pickup, locationId, quantity });
      } catch (cause) {
        quantity = 0;
        error = cause instanceof Error ? cause.message : 'The item could not be collected.';
      }
    }
    event.result = error ? 'blocked' : 'success';
    event.fact =
      context.config.language === 'Nederlands'
        ? error
          ? `${member.character.name} kan het voorwerp niet oppakken: ${error}`
          : item!.currencyValue ? `${member.character.name} verzamelt ${item!.currencyValue * quantity} ${scene.currencyName ?? 'valuta'}.` : `${member.character.name} stopt ${item!.name} (${quantity}) in de rugzak.`
        : error
          ? `${member.character.name} cannot collect the item: ${error}`
          : item!.currencyValue ? `${member.character.name} collects ${item!.currencyValue * quantity} ${scene.currencyName ?? 'currency'}.` : `${member.character.name} puts ${item!.name} (${quantity}) in their backpack.`;
    if (error) failed.add(event.id);
  }
  if (!value.pickups?.length) return { value, scene, members, results };
  // Failed prerequisites cannot leave successful travel, discoveries or rewards behind.
  const removed = new Set(
    value.events.filter((event) => failed.has(event.id) && event.kind === 'world').map((event) => event.id),
  );
  value.events = value.events.filter((event) => !removed.has(event.id));
  for (const event of value.events)
    event.dependsOn = event.dependsOn.filter((dep) => !removed.has(dep.eventId));
  value.events.forEach((event, sequence) => (event.sequence = sequence));
  value.memberLocations = value.memberLocations?.filter(
    (position) => !failed.has(position.movementEventId ?? ''),
  );
  value.separations = value.separations?.filter((separation) => !failed.has(separation.eventId));
  const occupied = new Set(
    members.map(
      (member) =>
        value.memberLocations?.find((position) => position.memberId === member.id)?.locationId ??
        memberScene(scene, member.id).location.id!,
    ),
  );
  value.placeUpdates = value.placeUpdates?.filter(
    (place) => !place.ref.startsWith('new:') || occupied.has(place.ref),
  );
  value.arrivals = value.arrivals?.filter((arrival) => !failed.has(arrival.eventId));
  value.encounterRisks = value.encounterRisks?.filter((risk) => !failed.has(risk.eventId));
  value.worldProgress = value.worldProgress?.filter((progress) => !failed.has(progress.eventId));
  for (const action of value.actions)
    if (action.search && failed.has(action.search.informationEventId)) action.search = null;
  if (value.sceneFocus && value.sceneFocus !== 'current' && !occupied.has(resolve(value.sceneFocus))) {
    value.sceneFocus = 'current';
    value.location = null;
  }
  value.factionEffects = value.factionEffects?.filter((effect) => !failed.has(effect.eventId));
  if (value.mapUpdates) {
    value.mapUpdates.connections = value.mapUpdates.connections.filter((edge) => !failed.has(edge.eventId));
    const connected = new Set(value.mapUpdates.connections.flatMap((edge) => [edge.from, edge.to]));
    value.mapUpdates.locations = value.mapUpdates.locations.filter(
      (place) => !place.ref.startsWith('new:') || connected.has(place.ref),
    );
  }
  if (removed.size) {
    value.journal = value.journal.filter((entry) =>
      value.worldProgress?.some(
        (progress) => progress.journal.kind === entry.kind && progress.journal.name === entry.name,
      ),
    );
    value.rewards = { xp: 0, currency: 0, reason: 'Uncompleted dependent consequences grant no reward.' };
  }
  for (const action of value.actions) {
    for (const component of Object.values(action.components)) {
      if (!component) continue;
      const events = value.events.filter((event) => component.eventIds.includes(event.id));
      if (!events.some((event) => claimed.has(event.id) || failed.has(event.id))) continue;
      const states = new Set(events.map((event) => event.result).filter(Boolean));
      component.status = states.size > 1 ? 'partial' : (events[0]?.result ?? component.status);
      if (
        events.every((event) => event.phase === 'movement' && failed.has(event.id)) &&
        component.status === 'blocked'
      )
        component.basis = 'none';
      component.fact = events
        .map((event) => event.fact)
        .join(' ')
        .slice(0, 2500);
      component.reason = 'Resolved from available items, carrying capacity and completed prerequisites.';
    }
    Object.assign(action, aggregateComponents(action.components, action.status === 'passed'));
    action.fact =
      Object.values(action.components)
        .filter((part) => part)
        .map((part) => part!.fact)
        .join(' ')
        .slice(0, 2500) || action.fact;
  }
  return { value, scene, members, results };
}
