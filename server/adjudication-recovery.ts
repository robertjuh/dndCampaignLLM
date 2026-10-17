import { isDeepStrictEqual } from 'node:util';
import {
  aggregateComponents,
  turnAdjudicationSchema,
  type TurnAdjudication,
  type ActionOutcome,
} from '../shared/turn-resolution';
import type { GMContext } from './game';
import { engineEvents } from './turn-resolution';
import { memberScene } from '../shared/locations';
import { encounterPlaceRef } from './encounters';

const phases = ['movement', 'minor', 'main'] as const;
const key = (memberId: string, phase: string) => `${memberId}:${phase}`;
const repairSchema = turnAdjudicationSchema.partial().extend({
  events: turnAdjudicationSchema.shape.events.element
    .extend({ sequence: turnAdjudicationSchema.shape.events.element.shape.sequence.default(0) })
    .array()
    .max(400)
    .optional(),
});

function aggregate(action: ActionOutcome): ActionOutcome {
  const components = Object.values(action.components).filter((part) => part != null);
  return {
    ...action,
    ...aggregateComponents(action.components, action.status === 'passed'),
    fact:
      components
        .map((part) => part.fact)
        .join(' ')
        .slice(0, 2500) || action.fact,
    reason:
      components
        .map((part) => part.reason)
        .join(' ')
        .slice(0, 2500) || action.reason,
    eventIds: components.length ? [...new Set(components.flatMap((part) => part.eventIds))] : action.eventIds,
    receiptRefs: [...new Set(components.flatMap((part) => part.receiptRefs))],
  };
}

/** Keep only components whose dependency-complete projection passes the real turn validator. */
export function retainAdjudicationProgress(
  context: GMContext,
  candidate: TurnAdjudication,
  fallback: TurnAdjudication,
  validate: (input: unknown) => TurnAdjudication,
) {
  const locked = new Set<string>();
  const engine = engineEvents(context);
  const engineIds = new Set(engine.map((event) => event.id));
  const project = (selected: Set<string>): TurnAdjudication => {
    const owned = candidate.events.filter(
      (event) =>
        event.actionId &&
        event.memberId &&
        event.phase &&
        selected.has(key(event.memberId, event.phase)) &&
        !engineIds.has(event.id),
    );
    const ids = new Set([...engineIds, ...owned.map((event) => event.id)]);
    // Main consequences cannot survive a discarded move, even when its proof reference is broken.
    const positions = (candidate.memberLocations ?? []).filter(
      (position) =>
        selected.has(key(position.memberId, 'movement')) || selected.has(key(position.memberId, 'main')),
    );
    const resolve = encounterPlaceRef(context, candidate);
    const occupied = new Set(
      context.members
        .filter((member) => member.active)
        .map((member) => {
          const position = positions.find((position) => position.memberId === member.id);
          return position ? resolve(position.locationId) : memberScene(context.scene, member.id).location.id;
        }),
    );
    const required = new Set([
      ...candidate.actions
        .filter((action) => selected.has(key(action.memberId, 'main')))
        .flatMap((action) => (action.search ? [action.search.informationEventId] : [])),
      ...(candidate.arrivals ?? [])
        .filter((arrival) => positions.some((position) => position.locationId === arrival.locationId))
        .map((arrival) => arrival.eventId),
      ...[...(candidate.worldProgress ?? []), ...(candidate.encounterRisks ?? [])]
        .filter((evidence) => occupied.has(resolve(evidence.locationId)))
        .map((evidence) => evidence.eventId),
    ]);
    // Missing prerequisites remain missing; never replace a dependency with a fallback success.
    const world = candidate.events.filter((event) => {
      if (event.kind !== 'world' || event.actionId !== null || engineIds.has(event.id)) return false;
      if (!event.dependsOn.every((dep) => ids.has(dep.eventId))) return false;
      if (
        !required.has(event.id) &&
        !event.dependsOn.some((dep) => owned.some((own) => own.id === dep.eventId))
      )
        return false;
      ids.add(event.id);
      return true;
    });
    const synthetic = fallback.events.filter(
      (event) =>
        !engineIds.has(event.id) &&
        !(event.memberId && event.phase && selected.has(key(event.memberId, event.phase))),
    );
    const events = [...engine, ...owned, ...world, ...synthetic];
    // Retain the candidate's causal order; routine movement normalization handles saved checks.
    const order = new Map(candidate.events.map((event, index) => [event.id, index]));
    events.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
    const actions = fallback.actions.map((base) => {
      const proposed = candidate.actions.find((action) => action.memberId === base.memberId);
      if (!proposed) return base;
      const components = { ...base.components };
      for (const phase of phases)
        if (selected.has(key(base.memberId, phase))) components[phase] = proposed.components[phase] ?? null;
      return aggregate({
        ...base,
        components,
        ...(selected.has(key(base.memberId, 'main'))
          ? { intent: proposed.intent, search: proposed.search }
          : {}),
        ...(positions.some((position) => position.memberId === base.memberId) ||
        selected.has(key(base.memberId, 'main'))
          ? { travel: proposed.travel }
          : {}),
      });
    });
    const connections = (candidate.mapUpdates?.connections ?? []).filter((edge) => ids.has(edge.eventId));
    const localEvidence = (evidence: { eventId: string; locationId: string }) =>
      occupied.has(resolve(evidence.locationId)) &&
      world.some(
        (event) =>
          event.id === evidence.eventId &&
          !event.presentation &&
          event.locationRef &&
          resolve(event.locationRef) === resolve(evidence.locationId),
      );
    const progress = candidate.worldProgress?.filter(
      (progress) =>
        localEvidence(progress) &&
        candidate.journal.some(
          (entry) => entry.kind === progress.journal.kind && entry.name === progress.journal.name,
        ),
    );
    const places = new Set([
      ...positions.map((position) => position.locationId),
      ...world.flatMap((event) => (event.locationRef ? [event.locationRef] : [])),
      ...connections.flatMap((edge) => [edge.from, edge.to]),
    ]);
    return {
      ...fallback,
      actions,
      journal: candidate.journal.filter(
        (entry) =>
          world.some((event) => event.fact === entry.detail) ||
          progress?.some(
            (evidence) => evidence.journal.kind === entry.kind && evidence.journal.name === entry.name,
          ),
      ),
      events: events.map((event, sequence) => ({ ...event, sequence })),
      memberLocations: positions,
      placeUpdates: candidate.placeUpdates?.filter((place) => places.has(place.ref)),
      mapUpdates: {
        locations: (candidate.mapUpdates?.locations ?? []).filter((place) => places.has(place.ref)),
        connections,
      },
      arrivals: candidate.arrivals?.filter((arrival) => ids.has(arrival.eventId)),
      factionEffects: candidate.factionEffects?.filter((effect) => ids.has(effect.eventId)),
      worldProgress: progress,
      encounterRisks: candidate.encounterRisks?.filter(localEvidence),
    };
  };
  let value: TurnAdjudication;
  try {
    value = validate(project(new Set()));
  } catch {
    value = validate(fallback);
  }
  // ponytail: one greedy pass; use dependency ordering if coupled actions need local recovery.
  for (const phase of phases)
    for (const action of candidate.actions) {
      if (!action.components[phase]) continue;
      const selected = new Set([...locked, key(action.memberId, phase)]);
      try {
        value = validate(project(selected));
        locked.add(key(action.memberId, phase));
      } catch {
        /* An unresolved component is left for the one bounded model repair. */
      }
    }
  return { value, locked };
}

/** A compact patch may fill unresolved slots but cannot rewrite retained components or facts. */
export function applyAdjudicationRepair(
  retained: ReturnType<typeof retainAdjudicationProgress>,
  input: unknown,
  context: GMContext,
): TurnAdjudication {
  const patch = repairSchema.parse(input);
  const base = retained.value;
  if ((patch.turnId && patch.turnId !== base.turnId) || (patch.version && patch.version !== base.version))
    throw new Error('Recovery belongs to another turn.');
  const engineIds = new Set(engineEvents(context).map((event) => event.id));
  const replacements = new Map((patch.actions ?? []).map((action) => [action.memberId, action]));
  if (
    replacements.size !== (patch.actions ?? []).length ||
    [...replacements.keys()].some((id) => !base.actions.some((action) => action.memberId === id))
  )
    throw new Error('Recovery actions must use distinct submitted actors.');
  const events = base.events.filter(
    (event) =>
      engineIds.has(event.id) ||
      !event.memberId ||
      !event.phase ||
      retained.locked.has(key(event.memberId, event.phase)) ||
      !replacements.has(event.memberId),
  );
  for (const event of patch.events ?? []) {
    if (events.some((saved) => saved.id === event.id))
      throw new Error('Recovery cannot replace a retained event.');
    events.push(event);
  }
  const actions = base.actions.map((action) => {
    const next = replacements.get(action.memberId);
    if (!next) return action;
    for (const phase of phases)
      if (
        retained.locked.has(key(action.memberId, phase)) &&
        !isDeepStrictEqual(action.components[phase], next.components[phase])
      )
        throw new Error('Recovery cannot replace a retained component.');
    if (
      retained.locked.has(key(action.memberId, 'main')) &&
      (!isDeepStrictEqual(action.search ?? null, next.search ?? null) ||
        (action.intent ?? 'action') !== (next.intent ?? 'action'))
    )
      throw new Error('Recovery cannot replace retained search evidence.');
    return aggregate(next);
  });
  const merge = <T>(saved: T[], updates: T[], id: (item: T) => string): T[] => {
    for (const update of updates) {
      const existing = saved.find((item) => id(item) === id(update));
      if (existing && !isDeepStrictEqual(existing, update))
        throw new Error('Recovery cannot replace retained world evidence.');
    }
    return [...saved, ...updates.filter((update) => !saved.some((item) => id(item) === id(update)))];
  };
  return turnAdjudicationSchema.parse({
    ...base,
    ...patch,
    actions,
    events: events.map((event, sequence) => ({ ...event, sequence })),
    journal: merge(base.journal, patch.journal ?? [], (entry) => `${entry.kind}:${entry.name}`),
    memberLocations: merge(base.memberLocations ?? [], patch.memberLocations ?? [], (item) => item.memberId),
    placeUpdates: merge(base.placeUpdates ?? [], patch.placeUpdates ?? [], (item) => item.ref),
    arrivals: merge(base.arrivals ?? [], patch.arrivals ?? [], (item) => item.locationId),
    mapUpdates: {
      locations: merge(
        base.mapUpdates?.locations ?? [],
        patch.mapUpdates?.locations ?? [],
        (item) => item.ref,
      ),
      connections: merge(
        base.mapUpdates?.connections ?? [],
        patch.mapUpdates?.connections ?? [],
        (item) => `${item.from}:${item.to}`,
      ),
    },
    factionEffects: merge(base.factionEffects ?? [], patch.factionEffects ?? [], (item) =>
      JSON.stringify(item),
    ),
    worldProgress: merge(base.worldProgress ?? [], patch.worldProgress ?? [], (item) => item.eventId),
    encounterRisks: merge(base.encounterRisks ?? [], patch.encounterRisks ?? [], (item) => item.locationId),
  });
}
