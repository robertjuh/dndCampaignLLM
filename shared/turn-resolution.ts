import { z } from 'zod';
import { maxNarrationLength, outcomeSchema, type CampaignConfig } from './schema';

const fact = z.string().trim().min(1).max(2500);
export const actionId = (turnId: string, memberId: string) => `${turnId}:action:${memberId}`;
export const actionOutcomeV1Schema = z
  .object({
    actionId: z.string().min(1),
    memberId: z.string().min(1),
    status: z.enum(['success', 'failure', 'partial', 'blocked', 'passed']),
    basis: z.enum(['routine', 'check', 'engine', 'none']),
    fact,
    reason: fact,
    receiptRefs: z.array(z.string()).max(100),
    eventIds: z.array(z.string()).min(1).max(100),
  })
  .strict();
export type ActionOutcomeV1 = z.infer<typeof actionOutcomeV1Schema>;
const componentStatus = z.enum(['success', 'failure', 'partial', 'blocked']);
export const actionComponentSchema = actionOutcomeV1Schema
  .omit({ actionId: true, memberId: true })
  .extend({ status: componentStatus });
export type ActionComponent = z.infer<typeof actionComponentSchema>;
export const actionOutcomeSchema = actionOutcomeV1Schema.extend({
  components: z
    .object({ main: actionComponentSchema.nullable(), minor: actionComponentSchema.nullable() })
    .strict(),
});
export type ActionOutcome = z.infer<typeof actionOutcomeSchema>;
export const resolvedEventV1Schema = z
  .object({
    id: z.string().min(1).max(200),
    sequence: z.number().int().nonnegative(),
    kind: z.enum(['action', 'world', 'combat', 'mechanics', 'arrival']),
    memberId: z.string().nullable(),
    actionId: z.string().nullable(),
    fact,
    receiptRefs: z.array(z.string()).max(100),
    dependsOn: z.array(z.string()).max(100),
  })
  .strict();
export type ResolvedEventV1 = z.infer<typeof resolvedEventV1Schema>;
export const resolvedEventSchema = resolvedEventV1Schema.extend({
  presentation: z.literal('log').optional(),
  phase: z.enum(['main', 'minor', 'aftermath']).nullable(),
  result: componentStatus.nullable(),
  dependsOn: z
    .array(z.object({ eventId: z.string().min(1), requires: z.enum(['occurrence', 'success']) }).strict())
    .max(100),
});
export type ResolvedEvent = z.infer<typeof resolvedEventSchema>;
export const turnAdjudicationV1Schema = z
  .object({
    version: z.literal(1),
    turnId: z.string().min(1),
    actions: z.array(actionOutcomeV1Schema).max(100),
    events: z.array(resolvedEventV1Schema).max(400),
    changes: outcomeSchema.shape.changes,
    journal: outcomeSchema.shape.journal,
    location: outcomeSchema.shape.location,
    safeRest: z.boolean(),
    rewards: z.object({ xp: outcomeSchema.shape.xp, gold: outcomeSchema.shape.gold, reason: fact }).strict(),
  })
  .strict();
export type TurnAdjudicationV1 = z.infer<typeof turnAdjudicationV1Schema>;
export const turnAdjudicationSchema = turnAdjudicationV1Schema.extend({
  version: z.literal(2),
  actions: z.array(actionOutcomeSchema).max(100),
  events: z.array(resolvedEventSchema).max(400),
});
export type TurnAdjudication = z.infer<typeof turnAdjudicationSchema>;
export const savedTurnAdjudicationSchema = z.discriminatedUnion('version', [
  turnAdjudicationV1Schema,
  turnAdjudicationSchema,
]);
export type SavedTurnAdjudication = z.infer<typeof savedTurnAdjudicationSchema>;
export const turnResolutionV1Schema = z
  .object({
    version: z.literal(1),
    turnId: z.string(),
    actions: z.array(actionOutcomeV1Schema.extend({ characterId: z.string(), characterName: z.string() })),
    events: z.array(resolvedEventV1Schema),
    factualRecap: z.string().min(1),
    rewards: z.array(
      z
        .object({
          memberId: z.string(),
          characterName: z.string(),
          xp: z.number().int(),
          gold: z.number().int(),
          reason: fact,
        })
        .strict(),
    ),
    characters: z.array(
      z
        .object({
          memberId: z.string(),
          characterName: z.string(),
          hp: z.number().int().nonnegative(),
          maxHp: z.number().int().positive(),
          conditions: z.array(z.string()),
          abilityUses: z.record(z.number().int().nonnegative()),
          level: z.number().int().positive(),
          xp: z.number().int().nonnegative(),
          gold: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    // Canonical changes are owned by adjudication/finalization, never presentation.
    changes: outcomeSchema.shape.changes,
    journal: outcomeSchema.shape.journal,
    // Initial/legacy scenes can retain the full campaign setting and an empty atmosphere.
    location: z
      .object({
        name: z.string().min(1).max(500),
        atmosphere: z.string().max(1500),
        hazard: z.string().max(1000),
      })
      .strict()
      .nullable(),
    safeRest: z.boolean(),
    executionContext: z
      .array(
        z.object({
          actorId: z.string(),
          name: z.string(),
          description: z.string(),
          equipment: z.array(z.object({ name: z.string(), kind: z.string(), description: z.string() })),
        }),
      )
      .optional(),
    actionDescriptions: z.record(z.string()).optional(),
  })
  .strict();
export const turnResolutionV2Schema = turnResolutionV1Schema.extend({
  version: z.literal(2),
  actions: z.array(actionOutcomeSchema.extend({ characterId: z.string(), characterName: z.string() })),
  events: z.array(resolvedEventSchema),
});
export const turnResolutionSchema = z.discriminatedUnion('version', [
  turnResolutionV1Schema,
  turnResolutionV2Schema,
]);
export type TurnResolution = z.infer<typeof turnResolutionSchema>;
export const turnNarrationV1Schema = z
  .object({
    version: z.literal(1),
    turnId: z.string(),
    eventNarrations: z.record(z.string().trim().min(1).max(maxNarrationLength)),
    closing: z.string().max(maxNarrationLength),
    summary: z.string().trim().min(1).max(2000),
  })
  .strict();
export const turnNarrationV2Schema = turnNarrationV1Schema.omit({ eventNarrations: true }).extend({
  version: z.literal(2),
  passages: z
    .array(
      z
        .object({
          eventIds: z.array(z.string().min(1)).min(1).max(400),
          text: z.string().trim().min(1).max(maxNarrationLength),
        })
        .strict(),
    )
    .min(1)
    .max(400),
});
export const turnNarrationSchema = z.discriminatedUnion('version', [
  turnNarrationV1Schema,
  turnNarrationV2Schema,
]);
export type TurnNarration = z.infer<typeof turnNarrationSchema>;

/** Bookkeeping remains in the frozen resolution and the UI's expandable log. */
export function narrationEvents(resolution: TurnResolution) {
  return resolution.events.filter((event) => !('presentation' in event) || event.presentation !== 'log');
}

export function narrationParagraphs(resolution: TurnResolution, narration: TurnNarration): string[] {
  return (
    narration.version === 1
      ? resolution.events.map((event) => narration.eventNarrations[event.id])
      : narration.passages.map((passage) => passage.text)
  ).concat(narration.closing ? [narration.closing] : []);
}

/** A presentation failure must not invalidate already resolved gameplay. */
export function factualNarration(
  resolution: TurnResolution,
  language: CampaignConfig['language'],
): TurnNarration {
  const neutral =
    language === 'Nederlands'
      ? 'Het vastgelegde resultaat blijft van kracht.'
      : 'The recorded outcome stands.';
  const compact = (fact: string, limit: number) => {
    const sentences = fact.replace(/\bDC\s*\d+\b/gi, '').split(/(?<=[.!?])\s+|\n+/);
    let text = '';
    for (const sentence of sentences) {
      if (/\b(?:XP|DCs?\d*|experience points?|difficulty class|ervaringspunten)\b/i.test(sentence)) continue;
      if (text.length + sentence.length + 1 > limit) break;
      text += `${text ? ' ' : ''}${sentence.trim()}`;
    }
    return text.trim() || neutral;
  };
  // ponytail: oversized facts use whole-sentence excerpts; the full resolution stays saved.
  const events = narrationEvents(resolution);
  const limit = Math.floor((maxNarrationLength - events.length * 2) / Math.max(1, events.length));
  const dutch = language === 'Nederlands';
  const situation = resolution.location
    ? [
        resolution.location.name,
        resolution.location.atmosphere,
        resolution.location.hazard,
        resolution.safeRest
          ? dutch
            ? 'Veilig rusten is mogelijk.'
            : 'Safe rest is available.'
          : dutch
            ? 'Veilig rusten is niet mogelijk.'
            : 'Safe rest is not available.',
      ]
        .filter(Boolean)
        .join(' ')
    : (events.filter((event) => event.kind === 'world').at(-1)?.fact ?? neutral);
  return assembleResolvedNarration(resolution, {
    version: 2,
    turnId: resolution.turnId,
    passages: events.map((event) => ({ eventIds: [event.id], text: compact(event.fact, limit) })),
    closing: '',
    summary: compact(situation, 1900),
  });
}

/** Derive the summary without losing the result of either requested action slot. */
export function aggregateComponents(
  components: {
    main: Pick<ActionComponent, 'status' | 'basis'> | null;
    minor: Pick<ActionComponent, 'status' | 'basis'> | null;
  },
  passed = false,
): Pick<ActionOutcome, 'status' | 'basis'> {
  const attempted = [components.main, components.minor].filter((part) => part !== null);
  if (passed) {
    if (attempted.length) throw new Error('A pass cannot contain action components.');
    return { status: 'passed', basis: 'none' };
  }
  if (!attempted.length) throw new Error('A submitted action must resolve at least one requested component.');
  const statuses = attempted.map((part) => part.status);
  const status =
    statuses.includes('partial') ||
    (statuses.includes('success') && statuses.some((value) => value !== 'success'))
      ? 'partial'
      : statuses.every((value) => value === 'success')
        ? 'success'
        : statuses.every((value) => value === 'blocked')
          ? 'blocked'
          : 'failure';
  return { status, basis: (components.main ?? components.minor)!.basis };
}

/** Cross-reference validation is shared by accepted proposals and finalized resolutions. */
export function validateReferences(
  value: Pick<SavedTurnAdjudication, 'actions' | 'events' | 'turnId'>,
  memberIds: readonly string[],
  receipts: ReadonlySet<string>,
) {
  const expected = new Set(memberIds.map((id) => actionId(value.turnId, id)));
  const actions = new Map(value.actions.map((action) => [action.actionId, action]));
  if (
    actions.size !== value.actions.length ||
    actions.size !== expected.size ||
    [...expected].some((id) => !actions.has(id))
  )
    throw new Error('Exactly one outcome is required for every submitted action.');
  const events = new Map<string, ResolvedEvent | ResolvedEventV1>();
  const checkRefs = (refs: readonly string[]) => {
    if (new Set(refs).size !== refs.length) throw new Error('Receipt references must be unique.');
    for (const ref of refs) if (!receipts.has(ref)) throw new Error(`Unknown receipt: ${ref}`);
  };
  for (const [sequence, event] of value.events.entries()) {
    if (events.has(event.id) || event.sequence !== sequence)
      throw new Error('Event IDs must be unique and sequences must match execution order.');
    if (
      event.actionId &&
      (!actions.has(event.actionId) || actions.get(event.actionId)!.memberId !== event.memberId)
    )
      throw new Error('Event refers to an unknown action or mismatched actor.');
    if ('phase' in event) {
      const action = event.actionId ? actions.get(event.actionId) : undefined;
      if (
        event.kind === 'action' &&
        (!action ||
          (action.status === 'passed'
            ? event.phase !== null || event.result !== null
            : !['main', 'minor'].includes(event.phase ?? '')))
      )
        throw new Error(
          'Action events must declare their requested slot; pass events have no phase or result.',
        );
      if (event.kind === 'world' && (event.actionId || (event.phase !== null && event.phase !== 'aftermath')))
        throw new Error('World consequences use causal dependencies, not an action component identity.');
      if (action && event.phase === null && action.status !== 'passed')
        throw new Error('Action effects must declare their action slot or aftermath phase.');
    }
    checkRefs(event.receiptRefs);
    const dependencies = new Set<string>();
    for (const dependency of event.dependsOn) {
      const id = typeof dependency === 'string' ? dependency : dependency.eventId;
      if (dependencies.has(id)) throw new Error('Dependency references must be unique.');
      dependencies.add(id);
      const prerequisite = events.get(id);
      if (!prerequisite) throw new Error('Dependencies must refer to earlier events.');
      if (typeof dependency === 'string') {
        // Accepted v1 checkpoints keep their original dependency interpretation.
        const before = prerequisite.actionId ? actions.get(prerequisite.actionId) : undefined;
        const after = event.actionId ? actions.get(event.actionId) : undefined;
        if (
          before &&
          ['failure', 'blocked', 'passed'].includes(before.status) &&
          (!after || ['success', 'partial'].includes(after.status))
        )
          throw new Error('A failed prerequisite cannot support a successful dependent event.');
      } else if (
        dependency.requires === 'success' &&
        (!('result' in prerequisite) || prerequisite.result !== 'success')
      ) {
        throw new Error('A successful prerequisite requires a successful result on the referenced event.');
      }
    }
    events.set(event.id, event);
  }
  for (const action of value.actions) {
    if (action.actionId !== actionId(value.turnId, action.memberId))
      throw new Error('Action identity does not match its actor.');
    checkRefs(action.receiptRefs);
    for (const id of action.eventIds)
      if (events.get(id)?.actionId !== action.actionId)
        throw new Error('Action outcomes must reference their own resolved events.');
    const own = value.events.filter((event) => event.actionId === action.actionId);
    if (own.some((event) => event.receiptRefs.some((ref) => !action.receiptRefs.includes(ref))))
      throw new Error('Action events must use receipts declared by their aggregate outcome.');
    if (
      new Set(action.eventIds).size !== action.eventIds.length ||
      own.some((event) => !action.eventIds.includes(event.id))
    )
      throw new Error('Every action event must belong to its aggregate outcome exactly once.');
    if (!('components' in action)) continue;
    const aggregate = aggregateComponents(action.components, action.status === 'passed');
    if (aggregate.status !== action.status || aggregate.basis !== action.basis)
      throw new Error('The aggregate outcome must match its main and minor components.');
    for (const phase of ['main', 'minor'] as const) {
      const component = action.components[phase];
      const phased = own.filter((event) => 'phase' in event && event.phase === phase);
      if (!component) {
        if (phased.length) throw new Error('An absent component cannot have resolved events.');
        continue;
      }
      checkRefs(component.receiptRefs);
      if (component.receiptRefs.some((ref) => !action.receiptRefs.includes(ref)))
        throw new Error('Component receipts must belong to their aggregate outcome.');
      if (
        new Set(component.eventIds).size !== component.eventIds.length ||
        phased.some((event) => !component.eventIds.includes(event.id))
      )
        throw new Error('Every phased action event must belong to its component exactly once.');
      for (const id of component.eventIds) {
        const event = events.get(id);
        if (!event || event.actionId !== action.actionId || !('phase' in event) || event.phase !== phase)
          throw new Error('Component events must belong to the same actor and action slot.');
        if (event.receiptRefs.some((ref) => !component.receiptRefs.includes(ref)))
          throw new Error('A component must include all of its event receipts.');
        if (
          event.result &&
          component.status !== 'partial' &&
          event.result !== component.status &&
          !(component.status === 'failure' && event.result === 'blocked')
        )
          throw new Error('Event result contradicts its action component.');
      }
    }
  }
}

export function assembleResolvedNarration(resolution: TurnResolution, input: unknown): TurnNarration {
  const narration = turnNarrationSchema.parse(input);
  // Accepted v1 checkpoints retain full coverage; new prose covers only story events.
  const events = narration.version === 1 ? resolution.events : narrationEvents(resolution);
  const ids =
    narration.version === 1
      ? Object.keys(narration.eventNarrations)
      : narration.passages.flatMap((passage) => passage.eventIds);
  if (
    narration.turnId !== resolution.turnId ||
    ids.length !== events.length ||
    new Set(ids).size !== ids.length ||
    events.some((event) => !ids.includes(event.id))
  )
    throw new Error('Narration must cover exactly the finalized event IDs.');
  if (narration.version === 2) {
    const positions = new Map(ids.map((id, index) => [id, index]));
    for (const event of events)
      for (const dependency of event.dependsOn) {
        const id = typeof dependency === 'string' ? dependency : dependency.eventId;
        if (!positions.has(id)) continue;
        if (positions.get(id)! >= positions.get(event.id)!)
          throw new Error('Narration must preserve causal order within and between passages.');
      }
    const engineIds = events
      .filter((event) => !['action', 'world'].includes(event.kind))
      .map((event) => event.id);
    if (ids.filter((id) => engineIds.includes(id)).some((id, index) => id !== engineIds[index]))
      throw new Error('Narration must preserve engine execution and combat initiative order.');
  }
  const text = narrationParagraphs(resolution, narration).join('\n\n');
  if (!text.trim() || text.length > maxNarrationLength)
    throw new Error('Complete narration exceeds the story budget or is empty.');
  if (
    /\b(?:XP|DCs?\d*|experience points?|difficulty class|ervaringspunten)\b/i.test(
      `${text}\n${narration.summary}`,
    )
  )
    throw new Error('Keep rewards and difficulty classes in server receipts, outside story prose.');
  return narration;
}
