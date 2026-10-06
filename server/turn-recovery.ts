import { isDeepStrictEqual } from 'node:util';
import {
  savedTurnAdjudicationSchema,
  turnResolutionSchema,
  turnNarrationSchema,
  validateReferences,
  type SavedTurnAdjudication,
  type TurnResolution,
  type TurnNarration,
  type ResolvedEvent,
  type ResolvedEventV1,
} from '../shared/turn-resolution';
import type { GMContext, ResourceReceipt } from './game';
import { combatFact } from './narration';
import { engineComponents, engineEvents, receiptReferences } from './turn-resolution';

type Checkpoints = {
  receipts: Record<string, unknown>;
  adjudication?: SavedTurnAdjudication;
  resolution?: TurnResolution;
  narration?: TurnNarration;
  resolutionRevision?: number;
  narrationRevision?: number;
};
type Event = ResolvedEvent | ResolvedEventV1;
type Outcome = SavedTurnAdjudication['actions'][number];

function recoveryError(claim: string): never {
  throw new Error(
    `Saved turn recovery requires a supported outcome: ${claim}. Saved mechanics are preserved.`,
  );
}

function recap(resolution: TurnResolution) {
  return [
    ...resolution.events.map((event) => event.fact),
    `Location: ${JSON.stringify(resolution.location)}. Safe rest: ${resolution.safeRest}.`,
    ...resolution.journal.map((entry) => `${entry.kind} ${entry.name}: ${entry.detail}`),
  ].join('\n');
}

function forVersion(event: ResolvedEvent, version: 1 | 2): Event {
  if (version === 2) return event;
  const { phase: _phase, result: _result, presentation: _presentation, ...saved } = event;
  return { ...saved, dependsOn: [] };
}

/** Repair derived facts only. The caller persists the returned draft and audit in one transaction. */
export function repairTurnCheckpoints(draft: Checkpoints, context: GMContext) {
  const next: Checkpoints = {
    ...draft,
    receipts: { ...draft.receipts },
    adjudication: draft.adjudication && savedTurnAdjudicationSchema.parse(draft.adjudication),
    resolution: draft.resolution && turnResolutionSchema.parse(draft.resolution),
    narration: draft.narration && turnNarrationSchema.parse(draft.narration),
  };
  if (next.resolution && !next.adjudication)
    recoveryError('the finalized resolution has no accepted adjudication');
  if (next.narration && !next.resolution) recoveryError('accepted narration has no finalized resolution');
  for (const revision of [next.resolutionRevision, next.narrationRevision])
    if (revision !== undefined && (!Number.isInteger(revision) || revision < 0))
      recoveryError('the saved resolution revision is invalid');

  const current = { ...context, receipts: next.receipts };
  const authoritative = engineEvents(current);
  const engine = new Map(authoritative.map((event) => [event.id, event]));
  const receipts = receiptReferences(current);
  const memberIds = current.turn.actions.map((action) => action.memberId);
  const registry = current.startingMembers ?? current.members;
  const corrections = new Map<string, { previous: string; fact: string }>();
  for (const event of authoritative) {
    if (!event.id.startsWith('resource:')) continue;
    const resource = next.receipts[event.id] as ResourceReceipt;
    if ((resource.targetId ?? resource.memberId) === resource.memberId) continue;
    const actor = registry.find((member) => member.id === resource.memberId)!;
    const previous = combatFact(
      current,
      `${actor.character.name} uses ${resource.sourceName}, consuming its item or ability use; ${actor.character.name} recovers ${resource.restored} HP.${resource.cured?.length ? ` Removes ${resource.cured.join(', ')}.` : ''}`,
    );
    if (previous !== event.fact) corrections.set(event.id, { previous, fact: event.fact });
  }
  const corrected = new Set<string>();
  const correctedAccepted = new Set<string>();
  const oldFacts = new Map<string, string>();
  const replaceKnownFact = (fact: string) => {
    let result = fact;
    for (const correction of corrections.values())
      result = result.replaceAll(correction.previous, correction.fact);
    return result;
  };
  const containsOldFact = (value: unknown): boolean =>
    typeof value === 'string'
      ? replaceKnownFact(value) !== value
      : !!value && typeof value === 'object' && Object.values(value).some(containsOldFact);
  const neutral = (action: Outcome) => {
    const actor = registry.find((member) => member.id === action.memberId);
    if (!actor) recoveryError(`action ${action.actionId} has an unknown frozen actor`);
    const name = actor.character.name;
    return new Set([
      `${name} completes the submitted action.`,
      `${name} voert de ingediende actie uit.`,
      'Supported by the established situation and server receipts.',
      'Volgens de vastgelegde situatie en de serverresultaten.',
    ]);
  };
  const provenText = (text: string, events: Event[], extras: ReadonlySet<string> = new Set()) => {
    if (extras.has(text)) return true;
    const facts = events.filter((event) => engine.has(event.id)).map((event) => event.fact);
    const prior = events
      .filter((event) => engine.has(event.id))
      .map((event) => oldFacts.get(event.id) ?? corrections.get(event.id)?.previous ?? event.fact);
    return [
      ...facts,
      ...prior,
      facts.join(' '),
      facts.join('\n'),
      prior.join(' '),
      prior.join('\n'),
    ].includes(text);
  };
  const checkStatuses = (value: SavedTurnAdjudication | TurnResolution) => {
    for (const action of value.actions) {
      const submitted = current.turn.actions.find((submitted) => submitted.memberId === action.memberId)!;
      if ((action.status === 'passed') !== submitted.passed)
        recoveryError(`action ${action.actionId} contradicts its submitted pass`);
      const constraints = engineComponents(current, action.memberId);
      const own = authoritative.filter((event) => event.actionId === action.actionId);
      if ('components' in action) {
        for (const phase of ['main', 'minor'] as const) {
          // Finalization may have added or expired an ailment. Only execution proves the old capability.
          if (!own.some((event) => event.phase === phase)) continue;
          const expected = constraints[phase];
          const actual = action.components[phase];
          if (!actual || !expected || actual.status !== expected.status || actual.basis !== expected.basis)
            recoveryError(`action ${action.actionId} (${phase}) contradicts its execution receipt`);
        }
        continue;
      }
      if (submitted.passed) continue;
      if (current.combatResult) {
        // V1 summarized combat before components existed; keep its accepted aggregate semantics.
        const main =
          current.combatResult.events?.filter(
            (event) => event.actorId === action.memberId && event.phase === 'main',
          ) ?? [];
        const statuses = main.flatMap((event) => (event.status ? [event.status] : []));
        const mainStatus = statuses.includes('blocked')
          ? 'blocked'
          : statuses.includes('failure')
            ? 'failure'
            : main.length
              ? 'success'
              : 'blocked';
        const minorSucceeded = current.combatResult.events?.some(
          (event) =>
            event.actorId === action.memberId && event.phase === 'minor' && event.status === 'success',
        );
        const status = mainStatus !== 'success' && minorSucceeded ? 'partial' : mainStatus;
        if (action.status !== status || action.basis !== 'engine')
          recoveryError(`legacy action ${action.actionId} contradicts its combat receipt`);
      } else if (own.some((event) => event.phase === 'main')) {
        const expected = constraints.main!;
        if (action.status !== expected.status || action.basis !== expected.basis)
          recoveryError(`legacy action ${action.actionId} contradicts its main-action receipt`);
      } else if (own.some((event) => event.phase === 'minor')) {
        if (action.status !== 'success' || action.basis !== 'engine' || !provenText(action.fact, own))
          recoveryError(
            `legacy action ${action.actionId} has an unsupported main-success claim backed only by a minor-action receipt`,
          );
        const minorIds = new Set(own.map((event) => event.id));
        if (
          value.events.some(
            (event) =>
              !engine.has(event.id) &&
              event.dependsOn.some((dependency) =>
                minorIds.has(typeof dependency === 'string' ? dependency : dependency.eventId),
              ),
          )
        )
          recoveryError(
            `legacy action ${action.actionId} has an ambiguous dependent success backed only by a minor-action receipt`,
          );
      }
    }
  };
  const repairAccepted = (value: SavedTurnAdjudication | TurnResolution) => {
    if (value.turnId !== current.turn.id) recoveryError('a checkpoint belongs to another turn');
    for (const event of value.events)
      if (event.memberId && !registry.some((member) => member.id === event.memberId))
        recoveryError(`event ${event.id} has an unknown frozen actor`);
    for (const [index, canonical] of authoritative.entries()) {
      const expected = forVersion(canonical, value.version);
      const saved = value.events[index];
      if (!saved || !isDeepStrictEqual({ ...saved, fact: expected.fact }, expected))
        recoveryError(`engine event ${canonical.id} has unsupported identity, references or order`);
      if (saved.fact === expected.fact) continue;
      const correction = corrections.get(canonical.id);
      if (!correction || saved.fact !== correction.previous)
        recoveryError(`engine event ${canonical.id} contains an unsupported fact`);
      oldFacts.set(canonical.id, saved.fact);
      saved.fact = correction.fact;
      corrected.add(canonical.id);
      correctedAccepted.add(canonical.id);
    }
    for (const action of value.actions) {
      if (!action.eventIds.some((id) => correctedAccepted.has(id)) && !containsOldFact(action)) continue;
      const own = value.events.filter((event) => event.actionId === action.actionId);
      const fields = [
        action,
        ...('components' in action
          ? [action.components.main, action.components.minor].filter((part) => part !== null)
          : []),
      ];
      for (const field of fields) {
        if (!field.eventIds.some((id) => correctedAccepted.has(id)) && !containsOldFact(field)) continue;
        const relevant = own.filter((event) => field.eventIds.includes(event.id));
        for (const key of ['fact', 'reason'] as const) {
          if (!provenText(field[key], relevant, neutral(action)))
            recoveryError(
              `action ${action.actionId} has an ambiguous ${key} affected by the healing-recipient correction`,
            );
          for (const [id, correction] of corrections)
            if (field[key].includes(correction.previous)) {
              corrected.add(id);
              correctedAccepted.add(id);
            }
          field[key] = replaceKnownFact(field[key]);
        }
      }
    }
    const affectedActions = new Set(
      [...correctedAccepted].map((id) => engine.get(id)?.actionId).filter(Boolean),
    );
    for (const event of value.events) {
      if (engine.has(event.id)) continue;
      const affected =
        correctedAccepted.has(event.id) ||
        containsOldFact(event.fact) ||
        (event.actionId !== null && affectedActions.has(event.actionId)) ||
        event.dependsOn.some((dependency) =>
          correctedAccepted.has(typeof dependency === 'string' ? dependency : dependency.eventId),
        ) ||
        event.receiptRefs.some((ref) => correctedAccepted.has(ref.replace(/^tool:/, '')));
      if (!affected) continue;
      if (!provenText(event.fact, authoritative))
        recoveryError(
          `event ${event.id} has an ambiguous claim dependent on the healing-recipient correction`,
        );
      const fact = replaceKnownFact(event.fact);
      if (fact !== event.fact) corrected.add(event.id);
      event.fact = fact;
      correctedAccepted.add(event.id);
    }
    if (
      containsOldFact({
        changes: value.changes,
        journal: value.journal,
        location: value.location,
        rewards: value.rewards,
      })
    )
      recoveryError('canonical state claims contain the old healing recipient');
    validateReferences(value, memberIds, receipts);
    checkStatuses(value);
  };

  if (next.adjudication) repairAccepted(next.adjudication);
  if (next.resolution) {
    repairAccepted(next.resolution);
    if (next.resolution.version !== next.adjudication!.version)
      recoveryError('adjudication and resolution use different contract versions');
    if (
      !isDeepStrictEqual(
        next.resolution.events.slice(0, next.adjudication!.events.length),
        next.adjudication!.events,
      )
    )
      recoveryError('adjudication and resolution disagree on accepted facts');
    for (const [index, action] of next.resolution.actions.entries()) {
      const actor = registry.find((member) => member.id === action.memberId);
      const { characterId, characterName, ...outcome } = action;
      if (
        !actor ||
        actor.characterId !== characterId ||
        actor.character.name !== characterName ||
        !isDeepStrictEqual(outcome, next.adjudication!.actions[index])
      )
        recoveryError(
          `finalized action ${action.actionId} disagrees with its frozen identity or accepted outcome`,
        );
    }
    for (const record of [...next.resolution.characters, ...next.resolution.rewards]) {
      const member = registry.find((member) => member.id === record.memberId);
      if (!member || member.character.name !== record.characterName)
        recoveryError(`finalized member ${record.memberId} disagrees with its frozen identity`);
    }
    const expectedRecap = recap(next.resolution);
    if (next.resolution.factualRecap !== expectedRecap) {
      if (replaceKnownFact(next.resolution.factualRecap) !== expectedRecap)
        recoveryError('the factual recap contains unsupported facts');
      for (const [id, correction] of corrections)
        if (next.resolution.factualRecap.includes(correction.previous)) corrected.add(id);
      next.resolution.factualRecap = expectedRecap;
    }
  }
  const resolutionChanged = !isDeepStrictEqual(next.resolution, draft.resolution);
  if (resolutionChanged) next.resolutionRevision = (next.resolutionRevision ?? 0) + 1;
  const narrationInvalidated =
    !!next.narration &&
    (resolutionChanged || (next.narrationRevision ?? 0) !== (next.resolutionRevision ?? 0));
  if (narrationInvalidated) {
    delete next.narration;
    delete next.narrationRevision;
  }
  const executionEventsRefreshed =
    !!(authoritative.length || next.receipts.executionEvents) &&
    !isDeepStrictEqual(next.receipts.executionEvents, authoritative);
  if (executionEventsRefreshed) {
    for (const saved of (next.receipts.executionEvents as Event[] | undefined) ?? [])
      if (corrections.get(saved.id)?.previous === saved.fact) corrected.add(saved.id);
    next.receipts.executionEvents = authoritative;
  }
  if (
    !executionEventsRefreshed &&
    isDeepStrictEqual(next.adjudication, draft.adjudication) &&
    !resolutionChanged &&
    !narrationInvalidated
  )
    return null;
  Object.assign(draft, next);
  if (!next.narration) {
    delete draft.narration;
    delete draft.narrationRevision;
  }
  return {
    correctedEventIds: [...corrected],
    executionEventsRefreshed,
    narrationInvalidated,
    resolutionRevision: next.resolutionRevision ?? 0,
  };
}
