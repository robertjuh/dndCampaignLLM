import type { GMContext } from './game';
import type { TurnAdjudication } from '../shared/turn-resolution';
import { memberScene, placeScene } from '../shared/locations';
import { worldProgressionStateSchema, type WorldProgressionState } from '../shared/world-progression';
import { memberLocationAtEvent } from './world-map';

export { worldProgressEvidenceSchema, worldProgressionStateSchema } from '../shared/world-progression';

export class JournalCapacityError extends Error {}

// After two meaningful local turns, request development without blocking publication.
const stalledTurnLimit = 2;
const normalize = (fact: string) =>
  fact
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{Z}\s]+/gu, ' ')
    .trim();
const savedState = (context: GMContext): WorldProgressionState =>
  context.scene.worldProgression ?? { version: 1, places: {} };

function threads(context: GMContext) {
  return [
    { id: 'premise', fact: context.config.premise || context.config.setting },
    ...(context.config.partyGoal ? [{ id: 'partyGoal', fact: context.config.partyGoal }] : []),
    ...context.journal.map((entry) => ({ id: `${entry.kind}:${entry.name}`, fact: entry.detail })),
    ...context.members
      .filter((member) => member.active && member.character.motivation.trim())
      .map((member) => ({ id: `motivation:${member.id}`, fact: member.character.motivation })),
    ...context.history.slice(-6).map((entry, index) => ({
      id: `history:${index}`,
      fact: entry.summary,
    })),
  ];
}

function resultingPlace(
  context: GMContext,
  value: TurnAdjudication,
  memberId: string,
  resolve: (ref: string) => string,
) {
  const position = value.memberLocations?.find((position) => position.memberId === memberId);
  return position ? resolve(position.locationId) : memberScene(context.scene, memberId).location.id!;
}

function meaningfulPlaces(context: GMContext, value: TurnAdjudication, resolve: (ref: string) => string) {
  const places = new Set<string>();
  for (const action of value.actions) {
    const submitted = context.turn.actions.find((submitted) => submitted.memberId === action.memberId);
    if (!submitted || submitted.passed || action.intent === 'orientation') continue;
    // Combat and support already have engine-owned consequences; minor gestures do not set pacing.
    if (
      [action.components.main, action.components.movement].some(
        (part) => part && part.status !== 'blocked' && ['routine', 'check'].includes(part.basis),
      )
    )
      places.add(resultingPlace(context, value, action.memberId, resolve));
  }
  return places;
}

/** Public, existing threads and local pacing only; no extra model call or private-world disclosure. */
export function worldProgressionContext(context: GMContext) {
  const state = savedState(context);
  const occupied = new Set(
    context.members
      .filter((member) => member.active)
      .map((member) => memberScene(context.scene, member.id).location.id!),
  );
  return {
    stalledTurnLimit,
    // Facts already travel in config, journal, motivations and history; send their identities once.
    threads: threads(context).map(({ id }) => ({ id, ...(state.threads?.[id] ?? {}) })),
    places: [...occupied].map((locationId) => ({
      locationId,
      stalledTurns: state.places[locationId]?.stalledTurns ?? 0,
      progressDueOnMeaningfulAction: (state.places[locationId]?.stalledTurns ?? 0) + 1 >= stalledTurnLimit,
      recentFacts: state.places[locationId]?.recentFacts ?? [],
    })),
  };
}

/** Enforce evidence and durable change; the adjudicator still judges fictional significance. */
export function validateWorldProgression(
  context: GMContext,
  value: TurnAdjudication,
  resolve: (ref: string) => string,
) {
  if (value.worldProgress === undefined) return; // Accepted legacy checkpoints retain their contract.
  const state = savedState(context);
  const knownThreads = new Set(threads(context).map((thread) => thread.id));
  const eventIds = new Set<string>();
  for (const progress of value.worldProgress) {
    const locationId = resolve(progress.locationId);
    const event = value.events.find((event) => event.id === progress.eventId);
    if (
      !event ||
      event.kind !== 'world' ||
      event.actionId !== null ||
      event.presentation ||
      !event.locationRef ||
      resolve(event.locationRef) !== locationId
    )
      throw new Error('World progress needs a public world event at its stated location.');
    if (eventIds.has(event.id)) throw new Error('One world event can establish progress only once.');
    eventIds.add(event.id);
    if (
      !context.members.some(
        (member) =>
          member.active && memberLocationAtEvent(context, value, member.id, event.id, resolve) === locationId,
      )
    )
      throw new Error('World progress needs a character present at its location.');
    if (!knownThreads.has(progress.thread))
      throw new Error('World progress must advance a supplied existing thread, not invent its own premise.');
    const updates = value.journal.filter(
      (entry) => entry.kind === progress.journal.kind && entry.name === progress.journal.name,
    );
    if (updates.length !== 1)
      throw new Error(
        'World progress needs one canonical journal update; consolidate shared thread developments.',
      );
    const update = updates[0];
    const previous = context.journal.find(
      (entry) => entry.kind === progress.journal.kind && entry.name === progress.journal.name,
    );
    const frozen = (context.receipts?.encounterProposal as TurnAdjudication | undefined)?.journal.some(
      (entry) => entry.kind === update.kind && entry.name === update.name && entry.detail === update.detail,
    );
    // A validated checkpoint retains its exact journal; new proposals get canonical persistence.
    if (!frozen && !normalize(update.detail).includes(normalize(event.fact))) {
      const facts = value.worldProgress
        .filter((item) => item.journal.kind === update.kind && item.journal.name === update.name)
        .map((item) => value.events.find((event) => event.id === item.eventId))
        .filter((event) => event?.kind === 'world' && event.actionId === null && !event.presentation)
        .map((event) => event!.fact);
      update.detail = [...new Set([previous?.detail, ...facts].filter(Boolean))].join('\n');
    } else if (
      !frozen &&
      previous &&
      !normalize(update.detail).includes(normalize(previous.detail)) &&
      previous.detail.length + update.detail.length + 1 <= (update.kind === 'faction' ? 6000 : 1500)
    ) {
      update.detail = `${previous.detail}\n${update.detail}`;
    }
    if (update.detail.length > (update.kind === 'faction' ? 6000 : 1500))
      throw new JournalCapacityError(
        `Consolidate journal ${JSON.stringify(update.name)} within ${update.kind === 'faction' ? 6000 : 1500} characters, preserving established knowledge and including the exact concise fact from event ${event.id}. Shorten an oversized new event fact without changing its outcome.`,
      );
    if (previous && normalize(update.detail) === normalize(previous.detail))
      throw new Error('World progress must persist a new or changed public journal fact.');
    if (!normalize(event.fact) || !normalize(update.detail).includes(normalize(event.fact)))
      throw new Error(
        'World progress must persist its exact concise event fact in the cited journal detail (1500 characters for non-faction entries).',
      );
    const prior = state.places[locationId];
    if (prior?.lastTurnId !== context.turn.id) {
      const place =
        locationId === context.scene.location.id || context.scene.places?.[locationId]
          ? placeScene(context.scene, locationId)
          : undefined;
      const existing = [
        ...(prior?.recentFacts ?? []),
        ...(state.threads?.[progress.thread]?.recentFacts ?? []),
        ...context.journal.map((entry) => entry.detail),
        ...context.history.slice(-6).flatMap((entry) => entry.summary.split('\n')),
        ...Object.values(place?.searches ?? {}).map((search) => search.information),
        place?.location.atmosphere ?? '',
      ].map(normalize);
      if (existing.includes(normalize(event.fact)))
        throw new Error('Repeated facts or unchanged search information do not count as world progress.');
    }
    for (const dependency of event.dependsOn) {
      const failedCheck = context.turn.rolls.find(
        (roll) => !roll.success && dependency.eventId === `check:${roll.id}`,
      );
      if (failedCheck && dependency.requires !== 'occurrence')
        throw new Error('A consequence of a failed check depends on its occurrence, never its success.');
    }
    for (const action of value.actions.filter(
      (action) =>
        action.search?.informationEventId === event.id && action.components.main?.status === 'failure',
    )) {
      if (normalize(event.fact) === normalize(action.components.main!.fact))
        throw new Error(
          'Failed-search progress must establish a distinct lesser opportunity while the main stays failed.',
        );
      const check = context.turn.rolls.find((roll) => roll.memberId === action.memberId && !roll.notation);
      if (
        check &&
        !event.dependsOn.some(
          (dependency) => dependency.eventId === `check:${check.id}` && dependency.requires === 'occurrence',
        )
      )
        throw new Error('Failed-search progress must retain its immutable failed-check dependency.');
    }
  }
}

/** Pacing is a bounded writing request, independent from the legality of saved outcomes. */
export function worldProgressDue(
  context: GMContext,
  value: TurnAdjudication,
  resolve: (ref: string) => string,
) {
  if (value.worldProgress === undefined) return [];
  const state = savedState(context);
  const represented = new Set(value.worldProgress.map((progress) => resolve(progress.locationId)));
  return [...meaningfulPlaces(context, value, resolve)].filter((locationId) => {
    const prior = state.places[locationId];
    return (
      prior?.lastTurnId !== context.turn.id &&
      (prior?.stalledTurns ?? 0) + 1 >= stalledTurnLimit &&
      !represented.has(locationId)
    );
  });
}

/** Called once at finalization, alongside the existing saved resolution checkpoint. */
export function advanceWorldProgression(
  context: GMContext,
  value: TurnAdjudication,
  resolve: (ref: string) => string,
): WorldProgressionState | undefined {
  if (value.worldProgress === undefined) return context.scene.worldProgression;
  const state = structuredClone(savedState(context));
  const meaningful = meaningfulPlaces(context, value, resolve);
  // Progress on one thread cannot reset another merely because the party changed places.
  const stable = new Set(threads(context).map(({ id }) => id).filter((id) => !id.startsWith('history:')));
  const tracked = new Set([
    ...Object.keys(state.threads ?? {}),
    ...(context.config.premise ? ['premise'] : []),
    ...(context.config.partyGoal ? ['partyGoal'] : []),
    ...value.worldProgress.map((progress) => progress.thread),
  ]);
  for (const thread of tracked) {
    if (!stable.has(thread) || (!meaningful.size && !value.worldProgress.some((progress) => progress.thread === thread))) continue;
    const previous = state.threads?.[thread];
    if (previous?.lastTurnId === context.turn.id) continue;
    const facts = value.worldProgress.filter((progress) => progress.thread === thread)
      .map((progress) => normalize(value.events.find((event) => event.id === progress.eventId)!.fact));
    (state.threads ??= {})[thread] = {
      stalledTurns: facts.length ? 0 : (previous?.stalledTurns ?? 0) + 1,
      lastTurnId: context.turn.id,
      recentFacts: [...new Set([...(previous?.recentFacts ?? []), ...facts])].slice(-24),
    };
  }
  const progressed = new Set(value.worldProgress.map((progress) => resolve(progress.locationId)));
  for (const locationId of new Set([...meaningful, ...progressed])) {
    const prior = state.places[locationId];
    if (prior?.lastTurnId === context.turn.id) continue;
    const facts = value.worldProgress
      .filter((progress) => resolve(progress.locationId) === locationId)
      .map((progress) => normalize(value.events.find((event) => event.id === progress.eventId)!.fact));
    state.places[locationId] = {
      stalledTurns: progressed.has(locationId) ? 0 : (prior?.stalledTurns ?? 0) + 1,
      lastTurnId: context.turn.id,
      recentFacts: [...new Set([...(prior?.recentFacts ?? []), ...facts])].slice(-24),
    };
  }
  return worldProgressionStateSchema.parse(state);
}
