import { isDeepStrictEqual } from 'node:util';
import {
  actionId,
  aggregateComponents,
  turnAdjudicationSchema,
  validateReferences,
  type ActionOutcome,
  type ActionComponent,
  type SavedTurnAdjudication,
  type ResolvedEvent,
  type TurnAdjudication,
} from '../shared/turn-resolution';
import { incapacitatingCondition } from '../shared/rules';
import { outcomeSchema, type ResourceUse } from '../shared/schema';
import type { GMContext, ResourceReceipt } from './game';
import { combatFact } from './narration';

export function receiptReferences(context: GMContext) {
  return new Set([
    ...context.turn.rolls.map((roll) => `roll:${roll.id}`),
    ...Object.keys(context.receipts ?? {}).map((key) => `tool:${key}`),
  ]);
}

/** Old receipts have no slot stamp; their normalized source and target determine it. */
export function resourceSlot(
  resource: Pick<ResourceUse, 'memberId' | 'itemId' | 'abilityName' | 'targetId'> & {
    slot?: 'main' | 'minor';
  },
): 'main' | 'minor' {
  const slot =
    resource.abilityName || (resource.targetId ?? resource.memberId) !== resource.memberId ? 'main' : 'minor';
  if (resource.slot && resource.slot !== slot)
    throw new Error('Saved resource slot contradicts its source and recipient.');
  return slot;
}

/** Frozen identity is independent from current capability or acting-roster membership. */
function identity(context: GMContext, memberId: string) {
  const member = (context.startingMembers ?? context.members).find((member) => member.id === memberId);
  if (!member) throw new Error(`Saved engine receipt refers to an unknown party member: ${memberId}.`);
  return member;
}

/** Engine facts retain execution order; routine fiction must be supplied by adjudication. */
export function engineEvents(context: GMContext): ResolvedEvent[] {
  const events: ResolvedEvent[] = [];
  const add = (
    id: string,
    fact: string,
    memberId: string | null,
    refs: string[],
    kind: ResolvedEvent['kind'] = 'mechanics',
    phase: ResolvedEvent['phase'] = null,
    result: ResolvedEvent['result'] = null,
    presentation?: 'log',
  ) => {
    events.push({
      id,
      sequence: events.length,
      kind,
      phase,
      result,
      memberId,
      actionId:
        memberId && context.turn.actions.some((action) => action.memberId === memberId)
          ? actionId(context.turn.id, memberId)
          : null,
      fact: combatFact(context, fact),
      receiptRefs: refs,
      dependsOn: [],
      ...(presentation ? { presentation } : {}),
    });
  };
  for (const [index, arrival] of (context.arrivingCharacters ?? []).entries())
    add(`arrival:${index}`, `${arrival.character.name} joins the party.`, null, [], 'arrival');
  if (context.combatResult) {
    if (!context.combatResult.events)
      throw new Error('This legacy combat receipt lacks typed outcomes; finish it through the legacy route.');
    for (const [index, event] of context.combatResult.events.entries())
      add(
        `combat:${index}`,
        event.fact,
        context.turn.actions.some((action) => action.memberId === event.actorId) ? event.actorId : null,
        ['tool:combat'],
        'combat',
        context.turn.actions.some((action) => action.memberId === event.actorId && action.passed)
          ? null
          : event.phase,
        context.turn.actions.some((action) => action.memberId === event.actorId && action.passed)
          ? null
          : event.status,
        event.presentation,
      );
    return events;
  }
  for (const roll of context.turn.rolls.filter((roll) => !roll.notation)) {
    const member = identity(context, roll.memberId);
    const dutch = context.config.language === 'Nederlands';
    add(
      `check:${roll.id}`,
      dutch
        ? `${member.character.name}: de ${roll.stat} check ${roll.success ? 'slaagt' : 'mislukt'}${roll.critical ? ` (natural ${roll.critical === 'success' ? 20 : 1})` : ''}.${roll.abilityName ? ` ${roll.abilityName} is gebruikt.` : ''}`
        : `${member.character.name}: the ${roll.stat} check ${roll.success ? 'succeeds' : 'fails'}${roll.critical ? ` (natural ${roll.critical === 'success' ? 20 : 1})` : ''}.${roll.abilityName ? ` ${roll.abilityName} is used.` : ''}`,
      roll.memberId,
      [`roll:${roll.id}`],
      'mechanics',
      'main',
      roll.success ? 'success' : 'failure',
    );
    const assisted = events.at(-1)!;
    for (const item of roll.equipmentBonuses ?? [])
      assisted.fact += dutch
        ? ` De uitgeruste ${item.name} draagt passief +${item.bonus} bij aan deze ${roll.stat} check.`
        : ` The equipped ${item.name} passively contributes +${item.bonus} to this ${roll.stat} check.`;
    for (const helperId of roll.assistedBy ?? []) {
      const helper = context.turn.rolls.find((saved) => saved.memberId === helperId && !saved.notation);
      if (!helper?.success || helper.assistsMemberId !== roll.memberId)
        throw new Error('Saved assistance must refer to a successful helper check for this actor.');
      assisted.dependsOn.push({ eventId: `check:${helper.id}`, requires: 'success' });
      const name = identity(context, helperId).character.name;
      assisted.fact += dutch
        ? ` De geslaagde hulp van ${name} ondersteunt deze check.`
        : ` ${name}'s successful assistance supports this check.`;
    }
  }
  for (const [key, receipt] of Object.entries(context.receipts ?? {})) {
    if (key.startsWith('check-effect:')) {
      const effect = receipt as { memberId: string; fact: string };
      add(key, effect.fact, effect.memberId, [`tool:${key}`], 'mechanics', 'aftermath');
    }
    if (key === 'support')
      for (const [index, support] of (receipt as NonNullable<GMContext['supportResults']>).entries())
        add(
          `support:${index}`,
          support.log,
          support.memberId,
          ['tool:support'],
          'mechanics',
          'main',
          support.restored > 0 ? 'success' : 'blocked',
        );
    if (key.startsWith('resource:')) {
      const resource = receipt as ResourceReceipt;
      const actor = identity(context, resource.memberId);
      const target = identity(context, resource.targetId ?? resource.memberId);
      add(
        key,
        `${actor.character.name} uses ${resource.sourceName}, consuming its item or ability use; ${target.character.name} recovers ${resource.restored} HP.${resource.cured?.length ? ` Removes ${resource.cured.join(', ')}.` : ''}`,
        resource.memberId,
        [`tool:${key}`],
        'mechanics',
        resourceSlot(resource),
        'success',
      );
    }
    if (key === 'challenge') {
      const logRecovery = (receipt as { logRecovery?: boolean }).logRecovery;
      for (const [index, fact] of ((receipt as { recovery: string[] }).recovery ?? []).entries())
        add(
          `recovery:${index}`,
          fact,
          null,
          ['tool:challenge'],
          'mechanics',
          logRecovery ? 'aftermath' : null,
          null,
          logRecovery ? 'log' : undefined,
        );
      for (const [index, name] of ((receipt as { revived?: string[] }).revived ?? []).entries())
        add(
          `revived:${index}`,
          `${name} regains consciousness after the encounter.`,
          null,
          ['tool:challenge'],
          'mechanics',
          'aftermath',
        );
    }
    if (key === 'loot')
      add(
        'loot',
        `Scene loot is available: ${(receipt as { item: { name: string }; reason: string }).item.name}.`,
        null,
        ['tool:loot'],
      );
  }
  const prior = (context.receipts?.executionEvents as ResolvedEvent[] | undefined) ?? [];
  const current = new Map(events.map((event) => [event.id, event]));
  // The cache supplies chronology, never facts: a revived ally's identity must stay receipt-derived.
  const ordered = prior.map((saved) => {
    const event = current.get(saved.id);
    if (!event) throw new Error(`Saved engine event ${saved.id} no longer has an authoritative receipt.`);
    current.delete(saved.id);
    return event;
  });
  return [...ordered, ...current.values()].map((event, sequence) => ({ ...event, sequence }));
}

type ComponentDisposition = Pick<ActionComponent, 'status' | 'basis'>;
export type EngineComponents = {
  main: ComponentDisposition | null | undefined;
  minor: ComponentDisposition | null | undefined;
};

/** Undefined is unresolved intent; null is a slot known to be absent. */
export function engineComponents(context: GMContext, memberId: string): EngineComponents {
  const action = context.turn.actions.find((action) => action.memberId === memberId);
  if (!action) throw new Error('Only submitted actions have component outcomes.');
  if (action.passed) return { main: null, minor: null };
  if (context.combatResult) {
    const result = {} as EngineComponents;
    for (const phase of ['main', 'minor'] as const) {
      const events =
        context.combatResult.events?.filter((event) => event.actorId === memberId && event.phase === phase) ??
        [];
      const statuses = events.flatMap((event) => (event.status ? [event.status] : []));
      result[phase] = !events.length
        ? phase === 'main'
          ? { status: 'blocked', basis: 'engine' }
          : null
        : {
            status:
              statuses.includes('success') && statuses.some((status) => status !== 'success')
                ? 'partial'
                : statuses.includes('failure')
                  ? 'failure'
                  : statuses.includes('blocked')
                    ? 'blocked'
                    : 'success',
            basis: 'engine',
          };
    }
    return result;
  }
  const result: EngineComponents = { main: undefined, minor: undefined };
  const assign = (phase: 'main' | 'minor', disposition: ComponentDisposition) => {
    if (result[phase]) throw new Error(`Saved receipts spend more than one ${phase} action for ${memberId}.`);
    result[phase] = disposition;
  };
  const roll = context.turn.rolls.find((roll) => roll.memberId === memberId && !roll.notation);
  if (roll) assign('main', { status: roll.success ? 'success' : 'failure', basis: 'check' });
  const support = (
    context.supportResults ?? (context.receipts?.support as GMContext['supportResults'])
  )?.find((receipt) => receipt.memberId === memberId);
  if (support) assign('main', { status: support.restored > 0 ? 'success' : 'blocked', basis: 'engine' });
  for (const [key, receipt] of Object.entries(context.receipts ?? {})) {
    if (!key.startsWith('resource:')) continue;
    const resource = receipt as ResourceReceipt;
    if (resource.memberId === memberId)
      assign(resourceSlot(resource), { status: 'success', basis: 'engine' });
  }
  // A saved execution wins over both starting incapacity and a lethal result of that execution.
  const member = context.members.find((member) => member.id === memberId);
  if (!member) throw new Error('The submitted actor is missing from the frozen party registry.');
  if (!result.main && (member.state.hp <= 0 || incapacitatingCondition(member.state)))
    result.main = { status: 'blocked', basis: 'none' };
  return result;
}

/** Legacy callers may use an aggregate only when the main disposition is already known. */
export function engineDisposition(
  context: GMContext,
  memberId: string,
): Pick<ActionOutcome, 'status' | 'basis'> | null {
  const action = context.turn.actions.find((action) => action.memberId === memberId)!;
  const components = engineComponents(context, memberId);
  if (action.passed) return aggregateComponents({ main: null, minor: null }, true);
  if (components.main === undefined) return null;
  return aggregateComponents({ main: components.main, minor: components.minor ?? null });
}

export function adjudicationOutcome(value: SavedTurnAdjudication) {
  return outcomeSchema.parse({
    narration: 'Pending narration.',
    summary: 'Pending narration.',
    choices: [],
    changes: value.changes,
    journal: value.journal,
    location: value.location,
    safeRest: value.safeRest,
    xp: value.rewards.xp,
    gold: value.rewards.gold,
    lethalWarning: null,
  });
}

export function validateAdjudication(context: GMContext, input: unknown): TurnAdjudication {
  const value = turnAdjudicationSchema.parse(input);
  if (value.turnId !== context.turn.id) throw new Error('Adjudication belongs to another turn.');
  validateReferences(
    value,
    context.turn.actions.map((action) => action.memberId),
    receiptReferences(context),
  );
  for (const event of value.events)
    if (event.memberId && !context.members.some((member) => member.id === event.memberId))
      throw new Error('Unknown event actor.');
  for (const event of value.events) {
    if (event.kind === 'action' && !event.actionId)
      throw new Error('Action events require an actor and action identity.');
    if (
      context.turn.actions.some((action) => action.text.trim() && event.fact.trim() === action.text.trim()) ||
      /\b(?:attempts|probeert)\s*:/i.test(event.fact)
    )
      throw new Error('Event facts must describe resolved outcomes instead of copying submissions.');
  }
  const authoritative = engineEvents(context);
  // Engine facts form the prefix, in execution order. New scene facts follow those results.
  for (const [index, event] of authoritative.entries())
    if (!isDeepStrictEqual(value.events[index], event))
      throw new Error(`Preserve engine event ${event.id} and its execution order exactly.`);
  if (value.events.slice(authoritative.length).some((event) => !['action', 'world'].includes(event.kind)))
    throw new Error(
      'New adjudicated events must be action outcomes or world consequences; mechanics come from the server.',
    );
  if (value.events.slice(authoritative.length).some((event) => event.presentation))
    throw new Error('Only the engine may keep bookkeeping out of story narration.');
  for (const result of value.actions) {
    const submitted = context.turn.actions.find((action) => action.memberId === result.memberId)!;
    if ((result.status === 'passed') !== submitted.passed)
      throw new Error('Pass outcomes must match the submitted pass.');
    const expected = engineComponents(context, result.memberId);
    const own = authoritative.filter((event) => event.actionId === result.actionId);
    for (const ref of result.receiptRefs) {
      const roll = context.turn.rolls.find((roll) => ref === `roll:${roll.id}`);
      const resource = ref.startsWith('tool:resource:')
        ? (context.receipts?.[ref.slice(5)] as ResourceReceipt | undefined)
        : undefined;
      if ((roll && roll.memberId !== result.memberId) || (resource && resource.memberId !== result.memberId))
        throw new Error('An action cannot claim another actor’s receipt.');
    }
    for (const phase of ['main', 'minor'] as const) {
      const component = result.components[phase];
      const constraint = expected[phase];
      const executed = own.filter((event) => event.phase === phase);
      if (!component) {
        if (executed.length || (phase === 'main' && (submitted.abilityName || submitted.supportAction)))
          throw new Error('An executed or selected action component cannot be omitted.');
        continue;
      }
      if (constraint === null) throw new Error('This action slot was not requested.');
      const member = context.members.find((member) => member.id === result.memberId)!;
      if (
        phase === 'minor' &&
        !constraint &&
        (member.state.hp <= 0 ||
          member.state.conditions.some((condition) => ['Frozen', 'Electrocuted'].includes(condition))) &&
        (component.status !== 'blocked' || component.basis !== 'none')
      )
        throw new Error('The current incapacity blocks the requested minor action.');
      for (const ref of component.receiptRefs) {
        const roll = context.turn.rolls.find((roll) => ref === `roll:${roll.id}` && !roll.notation);
        const resource = ref.startsWith('tool:resource:')
          ? (context.receipts?.[ref.slice(5)] as ResourceReceipt | undefined)
          : undefined;
        if (
          (roll && phase !== 'main') ||
          (resource && phase !== resourceSlot(resource)) ||
          (ref === 'tool:support' && phase !== 'main')
        )
          throw new Error('A component cannot claim a receipt from another action slot.');
      }
      if (constraint && (constraint.status !== component.status || constraint.basis !== component.basis))
        throw new Error(`Outcome contradicts the engine for ${result.memberId} (${phase}).`);
      if (!constraint && !['routine', 'none'].includes(component.basis))
        throw new Error('A mechanical outcome needs its saved receipt.');
      if (!constraint && component.basis === 'none' && component.status !== 'blocked')
        throw new Error('An actionable outcome needs a routine or mechanical basis.');
      if (
        executed.some(
          (event) =>
            !component.eventIds.includes(event.id) ||
            event.receiptRefs.some((ref) => !component.receiptRefs.includes(ref)),
        )
      )
        throw new Error('An action component must include all of its engine events and receipts.');
      if (
        component.fact.trim() === submitted.text.trim() ||
        /\b(?:attempts|probeert)\s*:/i.test(component.fact)
      )
        throw new Error('Record the component outcome, not a copy of the submitted prompt.');
    }
    if (
      own.some(
        (event) =>
          !result.eventIds.includes(event.id) ||
          event.receiptRefs.some((ref) => !result.receiptRefs.includes(ref)),
      )
    )
      throw new Error('An action must include all of its engine events and receipts.');
    if (result.fact.trim() === submitted.text.trim() || /\b(?:attempts|probeert)\s*:/i.test(result.fact))
      throw new Error('Record the outcome, not a copy of the submitted prompt.');
  }
  if (!value.events.length)
    throw new Error('Adjudication must establish at least one resolved scene or action event.');
  if (!context.turn.number && (value.rewards.xp || value.rewards.gold))
    throw new Error('Opening scenes cannot grant rewards.');
  if (context.combatResult && (value.rewards.xp || value.rewards.gold))
    throw new Error('Combat rewards come from the engine.');
  return value;
}
