import type { GMContext } from './game';
import type { TurnAdjudication } from '../shared/turn-resolution';
import { memberScene, knownLocations } from '../shared/locations';
import type { Scene } from '../shared/schema';
import { gatheringProgress } from '../shared/gathering';
import { isInCombat } from '../shared/rules';

export function gatheringOptions(
  context: GMContext,
  value?: TurnAdjudication,
  resolve = (id: string) => id,
  beforeEventId?: string,
) {
  const boundary = value?.events.find((event) => event.id === beforeEventId)?.sequence ?? Infinity;
  const risks = new Map(
    (value?.encounterRisks ?? [])
      .filter(
        (risk) => (value?.events.find((event) => event.id === risk.eventId)?.sequence ?? Infinity) < boundary,
      )
      .map((risk) => [resolve(risk.locationId), { danger: risk.danger, reason: risk.reason }]),
  );
  const scene = value
    ? {
        ...context.scene,
        encounterRisk: risks.get(context.scene.location.id!) ?? context.scene.encounterRisk,
        places: Object.fromEntries(
          Object.entries(context.scene.places ?? {}).map(([id, place]) => [
            id,
            { ...place, encounterRisk: risks.get(id) ?? place.encounterRisk },
          ]),
        ),
        worldMap: {
          nodes: context.scene.worldMap?.nodes ?? {},
          connections: turnConnections(context.scene, value, resolve, beforeEventId),
        },
      }
    : context.scene;
  const introduced = Object.keys(context.receipts?.startCombatByLocation ?? {});
  if (context.receipts?.startCombat && !context.receipts.startCombatByLocation)
    introduced.push(context.scene.location.id!);
  return Object.fromEntries(
    context.turn.actions.flatMap((action) =>
      action.gathering
        ? [[action.memberId, gatheringProgress(scene, action.gathering.route, introduced)]]
        : [],
    ),
  );
}

/** Choose the first leg of a route through publicly saved open connections. */
export function travelNextHop(
  scene: Scene,
  from: string,
  goal: string,
  via: string[] = [],
  avoid: string[] = [],
) {
  const known = knownLocations(scene);
  if (![from, goal, ...via, ...avoid].every((id) => Object.hasOwn(known, id))) return null;
  if (avoid.includes(from) || avoid.includes(goal)) return null;
  let first: string | null = null;
  let start = from;
  for (const target of [...via, goal]) {
    if (start === target) continue;
    const queue = [{ id: start, first: '' }];
    const seen = new Set([start, ...avoid]);
    let found: string | null = null;
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index];
      for (const edge of scene.worldMap?.connections ?? []) {
        if (edge.blocked) continue;
        const next =
          edge.from === current.id
            ? edge.to
            : edge.bidirectional && edge.to === current.id
              ? edge.from
              : null;
        if (!next || seen.has(next)) continue;
        seen.add(next);
        const step = current.first || next;
        if (next === target) {
          found = step;
          break;
        }
        queue.push({ id: next, first: step });
      }
      if (found) break;
    }
    if (!found) return null;
    first ??= found;
    start = target;
  }
  return first;
}

export function travelOptions(context: GMContext) {
  const goals = Object.keys(knownLocations(context.scene));
  return Object.fromEntries(
    context.turn.actions
      .filter((action) => !action.passed)
      .map((action) => {
        const from = memberScene(context.scene, action.memberId).location.id!;
        return [
          action.memberId,
          Object.fromEntries(
            goals.flatMap((goal) => {
              const next = travelNextHop(context.scene, from, goal);
              return next ? [[goal, next]] : [];
            }),
          ),
        ];
      }),
  );
}

/** ponytail: guard explicit English/Dutch journeys; ambiguous movement stays with the GM. */
export function submittedTravel(context: GMContext, memberId: string) {
  const action = context.turn.actions.find((action) => action.memberId === memberId);
  if (!action || action.passed || action.gathering) return;
  const origin = memberScene(context.scene, memberId).location.id!;
  const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const matches = (target: string, name: string) =>
    target === name || target.startsWith(`${name} `);
  const parts = action.text
    .replace(/"[^"]*"|“[^”]*”/gu, ' ')
    .split(/[.;!\n]|\b(?:and|while|but|en|terwijl|maar)\b/iu)
    .filter((part) => !/\b(?:not|never|don't|don’t|won't|won’t|would|could|might|if|niet|nooit|als)\b/iu.test(part));
  for (const raw of parts) {
    if (/\b(?:stop following|stop travelling|stop traveling|abandon|cancel|stop met volgen|annuleer|verlaat de karavaan)\b/iu.test(raw)) continue;
    const part = normalize(raw);
    const joining = part.match(/\b(?:join|rejoin|follow|meet up with|volg|sluit me aan bij)\s+(.+)/u)?.[1];
    if (joining) {
      const companions = context.members.filter((member) =>
        member.id !== memberId && member.active &&
        [normalize(member.character.name), normalize(member.character.name).split(' ')[0]]
          .some((name) => matches(joining, name)),
      );
      if (companions.length === 1) {
        const companionId = companions[0].id;
        const goalId = memberScene(context.scene, companionId).location.id!;
        if (goalId !== origin) return { goalId, companionId };
      }
    }
    const directed = part.match(/\b(?:go|walk|head|travel|move|return|ga|loop|reis|keer)\s+(?:(?:back|over|straight|terug)\s+)*(?:(?:to|towards?|naar|richting)\s+)?(.+)/u)?.[1];
    if (directed) {
      const target = directed.replace(/^(?:the|de|het)\s+/u, '');
      const goals = Object.entries(knownLocations(context.scene)).filter(([, name]) => {
        const full = normalize(name).replace(/^(?:the|de|het)\s+/u, '');
        return matches(target, full) || matches(target, full.split(' ').at(-1)!);
      });
      if (goals.length === 1 && goals[0][0] !== origin) return { goalId: goals[0][0] };
    }
    if (
      !/\b(?:same|current|dezelfde|huidige)\s+(?:area|place|room|location|plek|ruimte|locatie)\b/u.test(part) &&
      (/\b(?:follow|following|volg|volgen)\s+(?:(?:the|a|my|moving|loaded|de|het|een)\s+){0,3}(?:cart|caravan|wagon|kar|wagen|karavaan)\b(?!['’]s|\s+\w+['’]s)/iu.test(raw) ||
        (/\b(?:go|walk|head|travel|move|follow|ga|loop|reis|volg)\b/u.test(part) &&
          /\b(?:next|new|another|volgende|nieuwe|andere)\s+(?:area|place|location|room|gebied|plek|locatie|ruimte)\b/u.test(part)))
    ) return { onward: true as const };
  }
}

/** Witnesses use the character's position at the event, not both ends of a later move. */
export function memberLocationAtEvent(
  context: GMContext,
  value: TurnAdjudication,
  memberId: string,
  eventId: string,
  resolve: (ref: string) => string,
) {
  const origin = memberScene(context.scene, memberId).location.id!;
  const position = value.memberLocations?.find((position) => position.memberId === memberId);
  if (!position) return origin;
  if (context.turn.number === 0) return resolve(position.locationId);
  const movements = value.events.filter((event) =>
    position.movementEventId
      ? event.id === position.movementEventId
      : event.memberId === memberId &&
        event.result === 'success' &&
        (event.phase === 'movement' || event.effect === 'movement'),
  );
  const event = value.events.find((event) => event.id === eventId);
  return movements.length === 1 && event && movements[0].sequence <= event.sequence
    ? resolve(position.locationId)
    : origin;
}

/** Include evidenced route changes in this turn's movement and path validation. */
export function turnConnections(
  scene: Scene,
  value: TurnAdjudication,
  resolve: (ref: string) => string,
  untilEventId?: string,
) {
  const cutoff = untilEventId
    ? (value.events.find((event) => event.id === untilEventId)?.sequence ?? Infinity)
    : Infinity;
  const updates = (value.mapUpdates?.connections ?? [])
    .filter((edge) => {
      const sequence = value.events.find((event) => event.id === edge.eventId)?.sequence ?? Infinity;
      // A closure recorded with an arrival takes effect after that crossing.
      return sequence < cutoff || (sequence === cutoff && !edge.blocked);
    })
    .map(({ eventId: _eventId, ...edge }) => ({
      ...edge,
      from: resolve(edge.from),
      to: resolve(edge.to),
    }));
  const pairs = new Set(updates.map((edge) => [edge.from, edge.to].sort().join('|')));
  return (scene.worldMap?.connections ?? [])
    .filter((edge) => !pairs.has([edge.from, edge.to].sort().join('|')))
    .concat(updates);
}

/** An uncaused local opening can precede its crossing without another model repair. */
export function orderRouteOpenings(
  context: GMContext,
  value: TurnAdjudication,
  resolve: (ref: string) => string,
) {
  for (const edge of value.mapUpdates?.connections ?? []) {
    if (edge.blocked) continue;
    const opening = value.events.find((event) => event.id === edge.eventId);
    if (
      !opening ||
      opening.kind !== 'world' ||
      opening.dependsOn.length ||
      opening.presentation ||
      !opening.locationRef
    )
      continue;
    const from = resolve(edge.from),
      to = resolve(edge.to);
    if (
      !context.scene.worldMap?.connections.some(
        (old) =>
          old.blocked && ((old.from === from && old.to === to) || (old.from === to && old.to === from)),
      )
    )
      continue;
    const crossing = value.events.find((event) => {
      const member = context.members.find((member) => member.id === event.memberId);
      const origin = member && memberScene(context.scene, member.id).location.id;
      const target =
        event.locationRef ??
        value.memberLocations?.find(
          (position) => position.memberId === event.memberId && position.movementEventId === event.id,
        )?.locationId;
      return (
        origin &&
        resolve(opening.locationRef!) === origin &&
        event.result === 'success' &&
        (event.phase === 'movement' || event.effect === 'movement') &&
        target &&
        ((origin === from && resolve(target) === to) || (origin === to && resolve(target) === from))
      );
    });
    if (!crossing || value.events.indexOf(opening) < value.events.indexOf(crossing)) continue;
    value.events.splice(value.events.indexOf(opening), 1);
    value.events.splice(value.events.indexOf(crossing), 0, opening);
    value.events.forEach((event, sequence) => (event.sequence = sequence));
  }
  return value;
}

/** Public remote changes must trace back to an actual local submitted action. */
export function eventCausedLocally(
  context: GMContext,
  value: TurnAdjudication,
  eventId: string,
  resolve: (ref: string) => string,
  seen = new Set<string>(),
): boolean {
  if (seen.has(eventId)) return false;
  seen.add(eventId);
  const event = value.events.find((event) => event.id === eventId);
  if (!event) return false;
  const actor = context.members.find((member) => member.active && member.id === event.memberId);
  const position = value.memberLocations?.find((position) => position.memberId === actor?.id);
  if (
    event.kind === 'action' &&
    actor &&
    event.result !== 'blocked' &&
    context.turn.actions.some((action) => action.memberId === actor.id && !action.passed) &&
    event.locationRef &&
    [
      memberScene(context.scene, actor.id).location.id,
      ...(position ? [resolve(position.locationId)] : []),
    ].includes(resolve(event.locationRef))
  )
    return true;
  return event.dependsOn.some((dependency) =>
    eventCausedLocally(context, value, dependency.eventId, resolve, seen),
  );
}

/** Only observable, immediately adjacent routes become public map commitments. */
export function validateWorldMap(
  context: GMContext,
  value: TurnAdjudication,
  resultingRef: (ref: string) => string,
) {
  const nodes = new Set([
    context.scene.location.id!,
    ...Object.keys(context.scene.places ?? {}),
    ...Object.keys(context.scene.worldMap?.nodes ?? {}),
  ]);
  const arrivals = new Set((value.placeUpdates ?? []).map((place) => place.ref));
  const previews = value.mapUpdates?.locations ?? [];
  if (new Set(previews.map((place) => place.ref)).size !== previews.length)
    throw new Error('Map location references must be unique.');
  for (const preview of previews) {
    if (!nodes.has(preview.ref) && !/^new:[a-zA-Z0-9_-]{1,80}$/.test(preview.ref))
      throw new Error('Map locations need a known ID or a new: reference.');
    const arrival = value.placeUpdates?.find((place) => place.ref === preview.ref);
    if (arrival && arrival.location.name !== preview.name)
      throw new Error('A map preview and its arriving scene must name the same location.');
  }
  const declared = new Set([...arrivals, ...previews.map((place) => place.ref)]);
  const occupied = new Set<string>();
  for (const member of context.members.filter((member) => member.active)) {
    const position = value.memberLocations?.find((position) => position.memberId === member.id);
    if (context.turn.number > 0 || !position)
      occupied.add(memberScene(context.scene, member.id).location.id!);
    if (position) occupied.add(resultingRef(position.locationId));
  }
  if (context.turn.number === 0 && !value.memberLocations?.length) occupied.add(context.scene.location.id!);
  const updates = value.mapUpdates?.connections ?? [];
  const causedLocally = (eventId: string) => eventCausedLocally(context, value, eventId, resultingRef);
  const pairs = new Set<string>();
  for (const connection of updates) {
    if ([connection.from, connection.to].includes('destination'))
      throw new Error('Map routes use known IDs, declared references or current.');
    const from = resultingRef(connection.from);
    const to = resultingRef(connection.to);
    if (from === to || ![from, to].every((ref) => nodes.has(ref) || declared.has(ref)))
      throw new Error('Map connections must join two distinct known or declared locations.');
    const pair = [from, to].sort().join('|');
    if (pairs.has(pair)) throw new Error('Update each map connection only once per turn.');
    pairs.add(pair);
    const event = value.events.find((event) => event.id === connection.eventId);
    if (!event || !['world', 'action'].includes(event.kind) || event.presentation === 'log')
      throw new Error('Map connections need a public world or action event establishing the route.');
    const previous = context.scene.worldMap?.connections.find(
      (edge) => (edge.from === from && edge.to === to) || (edge.from === to && edge.to === from),
    );
    // Remote controls can change a known route; they cannot discover routes beyond a preview.
    const remoteChange =
      !!previous &&
      event.kind === 'world' &&
      !!event.locationRef &&
      [from, to].includes(resultingRef(event.locationRef)) &&
      causedLocally(event.id);
    const witnessed =
      context.turn.number === 0
        ? occupied
        : new Set(
            context.members
              .filter((member) => member.active)
              .map((member) => memberLocationAtEvent(context, value, member.id, event.id, resultingRef)),
          );
    if (!witnessed.has(from) && !witnessed.has(to) && !remoteChange)
      throw new Error(
        'Discover routes from a character’s occupied location, not beyond an unvisited preview.',
      );
    if (event.kind === 'action') {
      const actor = context.members.find((member) => member.id === event.memberId);
      const actorPlaces = actor
        ? [memberLocationAtEvent(context, value, actor.id, event.id, resultingRef)]
        : [];
      if (
        ![from, to].some((ref) => actorPlaces.includes(ref)) ||
        (event.locationRef && !actorPlaces.includes(resultingRef(event.locationRef)))
      )
        throw new Error('A route discovery action must belong to a character at that route.');
    }
    if (
      event.locationRef &&
      !remoteChange &&
      (!witnessed.has(resultingRef(event.locationRef)) ||
        ![from, to].includes(resultingRef(event.locationRef)))
    )
      throw new Error('Route evidence must belong to its observable occupied endpoint.');
    if (previous?.blocked && !connection.blocked && event.kind === 'action' && event.result !== 'success')
      throw new Error('Opening a blocked route requires a successful action or an established world change.');
  }
  for (const preview of previews.filter((preview) => !nodes.has(preview.ref)))
    if (
      !updates.some((connection) => {
        const from = resultingRef(connection.from);
        const to = resultingRef(connection.to);
        return (from === preview.ref && occupied.has(to)) || (to === preview.ref && occupied.has(from));
      })
    )
      throw new Error('Every new map preview must connect directly to an occupied location.');

  for (const action of value.actions) {
    const submitted = context.turn.actions.find((entry) => entry.memberId === action.memberId);
    if (!submitted?.gathering) continue;
    if (
      action.intent === 'search' ||
      action.intent === 'orientation' ||
      action.search ||
      action.components.movement ||
      action.components.minor
    )
      throw new Error(
        'Joining a gathering uses the whole main action for travel, with no destination action.',
      );
    if (action.travel && action.travel.goalId !== submitted.gathering.locationId)
      throw new Error('Gathering travel must preserve the fixed meeting point.');
    const member = context.members.find((entry) => entry.id === action.memberId)!;
    const from = memberScene(context.scene, member.id).location.id!;
    const position = value.memberLocations?.find((entry) => entry.memberId === member.id);
    const to = position ? resultingRef(position.locationId) : from;
    const progress = gatheringOptions(context, value, resultingRef, position?.movementEventId)[member.id];
    if (
      submitted.gathering.route[0] !== from ||
      submitted.gathering.route.at(-1) !== submitted.gathering.locationId ||
      !progress.path.includes(to)
    )
      throw new Error(
        'Gathering movement must follow its saved visited route and stop at danger, combat or a blocked passage.',
      );
    if (
      (isInCombat(memberScene(context.scene, member.id), member.state) ||
        context.combatResult?.participantIds?.includes(member.id)) &&
      to !== from
    )
      throw new Error('Characters in combat cannot join a gathering.');
    const obstacleId = action.travel?.obstacleEventId;
    const obstacle = value.events.find((event) => event.id === obstacleId);
    if (
      obstacleId &&
      (!obstacle ||
        obstacle.kind !== 'world' ||
        obstacle.presentation ||
        !obstacle.locationRef ||
        resultingRef(obstacle.locationRef) !== to)
    )
      throw new Error(
        'A gathering interruption needs public world evidence at the character’s stopping place.',
      );
    if (to !== progress.destination && action.components.main?.status === 'success' && !obstacle)
      throw new Error(
        'Complete the clear gathering route, or establish the actual interruption at the stopping place.',
      );
  }
  for (const position of value.memberLocations ?? []) {
    const from = memberScene(context.scene, position.memberId).location.id!;
    const to = resultingRef(position.locationId);
    if (context.turn.number === 0 || from === to) continue;
    const destinations = new Set(
      value.events
        .filter(
          (event) =>
            event.memberId === position.memberId &&
            event.kind === 'action' &&
            event.result === 'success' &&
            (event.phase === 'movement' || event.effect === 'movement') &&
            event.locationRef,
        )
        .map((event) => resultingRef(event.locationRef!))
        .filter((ref) => ref !== from),
    );
    if (destinations.size > 1)
      throw new Error('A character cannot traverse multiple location tiles in one turn.');
    if (context.scene.worldMap?.nodes[to]?.visited === false && !arrivals.has(to))
      throw new Error('Entering an unvisited map location requires its arriving scene.');
    if (context.turn.actions.some((action) => action.memberId === position.memberId && action.gathering))
      continue;
    let pair = turnConnections(context.scene, value, resultingRef, position.movementEventId).find(
      (edge) => (edge.from === from && edge.to === to) || (edge.from === to && edge.to === from),
    );
    // A first arrival can describe the new leg just traversed; it does not reopen a known route.
    if (!pair && !nodes.has(to) && arrivals.has(to)) {
      const discovered = value.mapUpdates?.connections.find(
        (edge) =>
          ((resultingRef(edge.from) === from && resultingRef(edge.to) === to) ||
            (resultingRef(edge.to) === from && resultingRef(edge.from) === to)) &&
          value.arrivals?.some(
            (arrival) => resultingRef(arrival.locationId) === to && arrival.eventId === edge.eventId,
          ),
      );
      if (discovered)
        pair = { ...discovered, from: resultingRef(discovered.from), to: resultingRef(discovered.to) };
    }
    // Legacy/genuinely new arrivals establish their traversed leg during finalization.
    if (!pair && !nodes.has(to) && !previews.some((preview) => preview.ref === to)) continue;
    if (!pair) throw new Error('Movement can cross only one adjacent location per turn.');
    if (pair.blocked) throw new Error('This map route is blocked.');
    if (!pair.bidirectional && pair.from !== from) throw new Error('This map route is one-way.');
  }
}

/** Short stable protocol references; canonical UUIDs remain the saved identities. */
export function locationReferences(context: GMContext) {
  return Object.fromEntries(
    Object.entries(knownLocations(context.scene)).map(([id, name], index) => [
      `place:${index + 1}`,
      { id, name },
    ]),
  );
}

export function actorReferences(context: GMContext) {
  return Object.fromEntries(
    context.members.map((member, index) => [
      `actor:${index + 1}`,
      { id: member.id, name: member.character.name },
    ]),
  );
}

/** Repair only unambiguous reference spelling and existing movement proofs, never outcomes. */
export function normalizeAdjudicationReferences(context: GMContext, input: unknown): unknown {
  const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  if (!record(input)) return input;
  const references = locationReferences(context);
  const known = knownLocations(context.scene);
  const names = new Map<string, string[]>();
  const key = (value: string) => value.normalize('NFKC').trim().toLowerCase();
  for (const [id, name] of Object.entries(known)) names.set(key(name), [...(names.get(key(name)) ?? []), id]);
  const declared = new Set<string>();
  const namedReferences = new Map<string, string>();
  const beats = input.version === 3 && Array.isArray(input.beats) ? input.beats : [];
  const scenePlaces = beats
    .filter(record)
    .flatMap((beat) => [
      ...(record(beat.place)
        ? [{ ref: beat.kind === 'move' ? beat.to : beat.at, name: beat.place.name }]
        : []),
      ...(Array.isArray(beat.exits)
        ? beat.exits.filter(record).map((exit) => ({ ref: exit.to, name: exit.name }))
        : []),
    ]);
  for (const list of [
    input.placeUpdates,
    record(input.mapUpdates) ? input.mapUpdates.locations : [],
    scenePlaces,
  ])
    if (Array.isArray(list))
      for (const place of list)
        if (record(place) && typeof place.ref === 'string' && /^new:[a-zA-Z0-9_-]{1,80}$/.test(place.ref)) {
          declared.add(place.ref);
          const name =
            typeof place.name === 'string'
              ? place.name
              : record(place.location)
                ? place.location.name
                : undefined;
          if (typeof name === 'string')
            names.set(key(name), [...new Set([...(names.get(key(name)) ?? []), place.ref])]);
        } else if (
          record(place) &&
          typeof place.ref === 'string' &&
          /^[0-9a-f-]{30,36}$/i.test(place.ref) &&
          !Object.hasOwn(known, place.ref)
        ) {
          const name =
            typeof place.name === 'string'
              ? place.name
              : record(place.location)
                ? place.location.name
                : undefined;
          const matches = typeof name === 'string' ? names.get(key(name)) : undefined;
          if (matches?.length === 1 && Object.hasOwn(known, matches[0])) {
            const previous = namedReferences.get(place.ref);
            if (previous && previous !== matches[0])
              throw new Error(
                `Conflicting named location references for ${JSON.stringify(place.ref)}: ${JSON.stringify(known[previous])} and ${JSON.stringify(known[matches[0]])}. Use their distinct supplied location aliases.`,
              );
            namedReferences.set(place.ref, matches[0]);
          }
        }
  const problems: string[] = [];
  const resolve = (value: unknown, path: string): unknown => {
    if (typeof value !== 'string') return value;
    if (
      value === 'current' ||
      (value === 'destination' && input.version !== 3) ||
      Object.hasOwn(known, value) ||
      declared.has(value)
    )
      return value;
    const alias = Object.hasOwn(references, value) ? references[value] : undefined;
    if (alias) return alias.id;
    const named = namedReferences.get(value);
    if (named && names.get(key(known[named]))?.length === 1) return named;
    const matches = names.get(key(value));
    if (matches?.length === 1) return matches[0];
    problems.push(`${path}=${JSON.stringify(value)}`);
    return value;
  };
  const fields = (value: unknown, keys: string[], path: string): unknown => {
    if (!record(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        keys.includes(name) ? resolve(item, `${path}.${name}`) : item,
      ]),
    );
  };
  const list = (value: unknown, keys: string[], path: string) =>
    Array.isArray(value) ? value.map((item, index) => fields(item, keys, `${path}[${index}]`)) : value;
  const output = { ...input };
  const questOperation = (operation: unknown, path: string): unknown => {
    if (!record(operation) || !record(operation.quest)) return operation;
    const quest = { ...operation.quest };
    if (Array.isArray(quest.objectives)) quest.objectives = quest.objectives.map((objective, i) =>
      record(objective) && record(objective.condition)
        ? { ...objective, condition: fields(objective.condition, ['locationId'], `${path}.objectives[${i}].condition`) }
        : objective);
    if (record(quest.reward)) quest.reward = {
      ...quest.reward,
      ...(Array.isArray(quest.reward.access) ? { access: list(quest.reward.access, ['from', 'to'], `${path}.reward.access`) } : {}),
    };
    return { ...operation, quest };
  };
  if (input.version === 3) {
    const actors = actorReferences(context);
    output.beats = beats.map((beat, index) => {
      if (!record(beat)) return beat;
      const path = `beats[${index}]`;
      const next = fields(beat, beat.kind === 'move' ? ['to'] : ['at'], path) as Record<string, unknown>;
      if (typeof beat.actor === 'string') next.actor = actors[beat.actor]?.id ?? beat.actor;
      if (record(beat.stop)) next.stop = fields(beat.stop, ['at'], `${path}.stop`);
      if (Array.isArray(beat.quests)) next.quests = beat.quests.map((operation, i) => questOperation(operation, `${path}.quests[${i}].quest`));
      if (Array.isArray(beat.factions))
        next.factions = beat.factions.map((effect) =>
          record(effect) && typeof effect.memberId === 'string'
            ? { ...effect, memberId: actors[effect.memberId]?.id ?? effect.memberId }
            : effect,
        );
      if (Array.isArray(beat.exits)) next.exits = list(beat.exits, ['to'], `${path}.exits`);
      if (Array.isArray(beat.npcs)) next.npcs = list(beat.npcs, ['locationId'], `${path}.npcs`);
      const companion = (item: unknown) =>
        record(item) && typeof item.followingMemberId === 'string'
          ? { ...item, followingMemberId: actors[item.followingMemberId]?.id ?? item.followingMemberId }
          : item;
      if (Array.isArray(next.npcs)) next.npcs = next.npcs.map(companion);
      if (record(beat.person)) next.person = companion(beat.person);
      if (Array.isArray(beat.features))
        next.features = beat.features.map((feature, i) =>
          record(feature) && record(feature.route)
            ? { ...feature, route: fields(feature.route, ['from', 'to'], `${path}.features[${i}].route`) }
            : feature,
        );
      return next;
    });
    if (Array.isArray(input.notes)) output.notes = (list(input.notes, ['locationId'], 'notes') as unknown[]).map((note) =>
      record(note) && record(note.journey) && typeof note.journey.memberId === 'string'
        ? { ...note, journey: { ...note.journey, memberId: actors[note.journey.memberId]?.id ?? note.journey.memberId } }
        : note);
  }
  for (const [name, keys] of Object.entries({
    memberLocations: ['locationId'],
    placeUpdates: ['ref'],
    events: ['locationRef'],
    arrivals: ['locationId'],
    encounterRisks: ['locationId'],
    worldProgress: ['locationId'],
    npcUpdates: ['locationId'],
    featureUpdates: ['locationId'],
  }))
    if (name in output) output[name] = list(output[name], keys, name);
  if ('sceneFocus' in output) output.sceneFocus = resolve(output.sceneFocus, 'sceneFocus');
  if (Array.isArray(output.questUpdates)) output.questUpdates = output.questUpdates.map((update, i) =>
    record(update) ? { ...update, operation: questOperation(update.operation, `questUpdates[${i}].operation.quest`) } : update);
  if (Array.isArray(output.featureUpdates))
    output.featureUpdates = output.featureUpdates.map((update, index) =>
      record(update) && record(update.route)
        ? { ...update, route: fields(update.route, ['from', 'to'], `featureUpdates[${index}].route`) }
        : update,
    );
  if (record(output.location)) output.location = fields(output.location, ['id'], 'location');
  if (record(output.mapUpdates))
    output.mapUpdates = {
      ...output.mapUpdates,
      locations: list(output.mapUpdates.locations, ['ref'], 'mapUpdates.locations'),
      connections: list(output.mapUpdates.connections, ['from', 'to'], 'mapUpdates.connections'),
    };
  if (Array.isArray(output.actions))
    output.actions = output.actions.map((action, index) => {
      if (!record(action)) return action;
      const next = { ...action };
      if ('search' in next) next.search = fields(next.search, ['locationId'], `actions[${index}].search`);
      if (record(next.travel))
        next.travel = {
          ...next.travel,
          goalId: resolve(next.travel.goalId, `actions[${index}].travel.goalId`),
          ...Object.fromEntries(
            ['via', 'avoid']
              .filter((name) => Array.isArray((next.travel as Record<string, unknown>)[name]))
              .map((name) => [
                name,
                ((next.travel as Record<string, unknown>)[name] as unknown[]).map((ref, i) =>
                  resolve(ref, `actions[${index}].travel.${name}[${i}]`),
                ),
              ]),
          ),
        };
      return next;
    });
  if (problems.length)
    throw new Error(
      `Unknown location references: ${problems.join('; ')}. Reuse these supplied aliases or their exact IDs: ${JSON.stringify(input.version === 3 ? Object.fromEntries(Object.entries(references).map(([alias, place]) => [alias, place.name])) : references)}. ${input.version === 3 ? 'Declare a genuinely new arrival with new: and move.place, or a new preview with new: and exits[].name.' : 'Declare a genuinely new arrival in placeUpdates with a new: reference;'} never invent an ID for an existing place.`,
    );
  // A unique already-declared actor-owned movement proof is safe to reference automatically.
  if (Array.isArray(output.memberLocations) && Array.isArray(output.events)) {
    const events = output.events;
    output.memberLocations = output.memberLocations.map((position) => {
      if (!record(position)) return position;
      const moves = events.filter(
        (event) =>
          record(event) &&
          event.memberId === position.memberId &&
          event.kind === 'action' &&
          event.result === 'success' &&
          (event.phase === 'movement' || (event.phase === 'main' && event.effect === 'movement')) &&
          (!event.locationRef || event.locationRef === position.locationId),
      );
      if (
        moves.length === 1 &&
        record(moves[0]) &&
        !moves.some((event) => record(event) && event.id === position.movementEventId)
      )
        return { ...position, movementEventId: moves[0].id };
      return position;
    });
  }
  return output;
}
