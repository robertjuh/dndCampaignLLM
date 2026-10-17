import { validateFactionEffects } from './factions';
import { isDeepStrictEqual } from 'node:util';
import {
  actionId,
  aggregateComponents,
  assertCombatClaims,
  turnAdjudicationSchema,
  validateReferences,
  type ActionOutcome,
  type ActionComponent,
  type SavedTurnAdjudication,
  type ResolvedEvent,
  type TurnAdjudication,
} from '../shared/turn-resolution';
import { incapacitatingCondition } from '../shared/rules';
import { outcomeSchema, type ResourceUse, type CombatInput } from '../shared/schema';
import type { CombatReceipt, GMContext, ResourceReceipt } from './game';
import { combatFact } from './narration';
import { memberScene, knownLocations, occupiedPlaces } from '../shared/locations';
import { validateWorldMap } from './world-map';
import { validateExploration } from './exploration';
import { validateWorldProgression } from './world-progression';

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

/** Local execution receipts determine who fought, independently of the screen's focus. */
export function combatReceiptForMember(context: GMContext, memberId: string): CombatReceipt | undefined {
  const local = context.receipts?.combatByLocation as Record<string, CombatReceipt> | undefined;
  if (local)
    return Object.entries(local).find(([locationId, receipt]) =>
      receipt.participantIds
        ? receipt.participantIds.includes(memberId)
        : locationId === memberScene(context.scene, memberId).location.id,
    )?.[1];
  const receipt = context.combatResult;
  return receipt && (!receipt.participantIds || receipt.participantIds.includes(memberId))
    ? receipt
    : undefined;
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
    locationRef?: string,
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
      ...(locationRef ? { locationRef } : {}),
    });
  };
  for (const [index, arrival] of (context.arrivingCharacters ?? []).entries())
    add(`arrival:${index}`, `${arrival.character.name} joins the party.`, null, [], 'arrival');
  for (const [index, fact] of (
    (context.receipts?.factionIntroductions as string[] | undefined) ?? []
  ).entries())
    add(`faction:connection:${index}`, fact, null, ['tool:factionIntroductions'], 'arrival');
  if (context.turn.number > 0)
    for (const member of context.startingMembers ?? context.members) {
      const incapacitated = incapacitatingCondition(member.state);
      if (
        incapacitated &&
        context.turn.roster.includes(member.id) &&
        !context.turn.actions.some((action) => action.memberId === member.id)
      )
        add(
          `incapacitated:${member.id}`,
          context.config.language === 'Nederlands'
            ? `${member.character.name} begint de beurt ${incapacitated} en slaat de actie over.`
            : `${member.character.name} starts the turn ${incapacitated} and skips their action.`,
          member.id,
          [],
        );
    }
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
        event.locationId ?? context.combatResult.locationId,
      );
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
  const combat = combatReceiptForMember(context, memberId);
  if (combat) {
    const result = {} as EngineComponents;
    for (const phase of ['main', 'minor'] as const) {
      const events =
        combat.events?.filter((event) => event.actorId === memberId && event.phase === phase) ?? [];
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
  // Private faction proposals stay in adjudication; finalization creates public facts/receipts.
  return outcomeSchema.parse({
    narration: 'Pending narration.',
    summary: 'Pending narration.',
    choices: [],
    changes: value.changes,
    journal: value.journal,
    location: value.location,
    memberLocations: value.memberLocations,
    placeUpdates: value.placeUpdates,
    mapUpdates: value.mapUpdates,
    sceneFocus: value.sceneFocus,
    separations: value.separations,
    xp: value.rewards.xp,
    gold: value.rewards.gold,
    lethalWarning: null,
  });
}

/** Ordinary movement can precede its actor's saved main-action execution. */
export function orderRoutineMovement<T extends { events: ResolvedEvent[] }>(value: T): T {
  if (!value.events.some((event) => event.beforeEventId)) return value;
  if (value.events.some((event, sequence) => event.sequence !== sequence))
    throw new Error('Event sequences must match execution order.');
  const events = [...value.events];
  for (const event of value.events.filter((event) => event.beforeEventId)) {
    const target = events.find((candidate) => candidate.id === event.beforeEventId);
    if (
      event.phase !== 'movement' ||
      event.kind !== 'action' ||
      event.result !== 'success' ||
      !target ||
      target.kind !== 'mechanics' ||
      target.phase !== 'main' ||
      target.actionId !== event.actionId
    )
      throw new Error('Routine movement can precede only its own later main action.');
    events.splice(events.indexOf(event), 1);
    events.splice(events.indexOf(target), 0, event);
  }
  return { ...value, events: events.map((event, sequence) => ({ ...event, sequence })) };
}

export function adjudicationPlaceRef(
  context: GMContext,
  value: { sceneFocus?: string; location?: TurnAdjudication['location'] },
) {
  const focus = value.sceneFocus === 'current' ? context.scene.location.id! : value.sceneFocus;
  const destination =
    focus ??
    (value.location?.id === null
      ? 'legacy:destination'
      : (value.location?.id ??
        (value.location && value.location.name !== context.scene.location.name
          ? (Object.entries(knownLocations(context.scene)).find(
              ([, name]) => name === value.location!.name,
            )?.[0] ?? 'legacy:destination')
          : context.scene.location.id!)));
  return (ref: string) =>
    ref === 'current' ? context.scene.location.id! : ref === 'destination' ? destination : ref;
}

/** New continuity failures use local recovery, never an additional model request. */
export class PositionContinuityError extends Error {}

export function assertMovementPositions(context: GMContext, value: TurnAdjudication) {
  if (context.turn.number === 0) return;
  const resolve = adjudicationPlaceRef(context, value);
  for (const event of value.events) {
    if (
      event.kind !== 'action' ||
      event.result !== 'success' ||
      !event.memberId ||
      !(event.phase === 'movement' || (event.phase === 'main' && event.effect === 'movement'))
    )
      continue;
    const position = value.memberLocations?.find((position) => position.memberId === event.memberId);
    const origin = memberScene(context.scene, event.memberId).location.id;
    if (
      (event.phase === 'movement' && !position && !event.locationRef) ||
      (event.locationRef &&
        (position
          ? resolve(position.locationId) !== resolve(event.locationRef)
          : resolve(event.locationRef) !== origin))
    )
      throw new PositionContinuityError('A successful location move needs its matching saved position.');
  }
}

/** Repair references to already-declared effects; the full validator still decides legality. */
export function normalizeAdjudicationStructure(context: GMContext, input: unknown): unknown {
  const record = (value: unknown): value is Record<string, any> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  if (!record(input) || !Array.isArray(input.actions) || !Array.isArray(input.events)) return input;
  const output = structuredClone(input);
  const events: Record<string, any>[] = output.events.filter(record);
  const proposedPositions: Record<string, any>[] = Array.isArray(output.memberLocations)
    ? output.memberLocations.filter(record)
    : [];
  const engine = engineEvents(context);
  const resolve = adjudicationPlaceRef(context, output);
  for (const action of output.actions.filter(record)) {
    const submitted = context.turn.actions.find(
      (a) => action.actionId === actionId(context.turn.id, a.memberId) && a.memberId === action.memberId,
    );
    if (!submitted) continue;
    if (!record(action.components)) continue;
    const mainComponent = action.components.main;
    // ponytail: recognize direct English/Dutch journeys, not arbitrary natural-language intent.
    if (
      !submitted.passed &&
      !submitted.abilityName &&
      !submitted.supportAction &&
      /^(?:(?:i|we|ik|wij)\s+)?(?:go|head|travel|move|walk|run|follow|return|enter|leave|ga|gaan|reis|loop|ren|volg|beweeg|betreed|verlaat)\b/i.test(
        submitted.text.trim(),
      ) &&
      !/\b(?:do not|don't|won't|will not|niet|geen)\b/i.test(submitted.text) &&
      action.intent !== 'orientation' &&
      action.intent !== 'search' &&
      record(mainComponent) &&
      mainComponent.status === 'success' &&
      mainComponent.basis === 'routine' &&
      Array.isArray(mainComponent.receiptRefs) &&
      !mainComponent.receiptRefs.length &&
      Array.isArray(mainComponent.eventIds) &&
      Array.isArray(output.memberLocations)
    ) {
      const positions = proposedPositions.filter((position) => position.memberId === action.memberId);
      const proof = events.find((event) => event.id === positions[0]?.movementEventId);
      if (
        positions.length === 1 &&
        proof &&
        proof.actionId === action.actionId &&
        proof.memberId === action.memberId &&
        proof.kind === 'action' &&
        proof.phase === 'main' &&
        proof.result === 'success' &&
        proof.effect === undefined &&
        typeof proof.locationRef === 'string' &&
        resolve(proof.locationRef) === resolve(positions[0].locationId) &&
        resolve(proof.locationRef) !== memberScene(context.scene, action.memberId).location.id &&
        mainComponent.eventIds.includes(proof.id)
      )
        proof.effect = 'movement';
    }
    const movement = action.components.movement;
    if (
      record(movement) &&
      movement.status === 'success' &&
      movement.basis === 'routine' &&
      Array.isArray(movement.receiptRefs) &&
      !movement.receiptRefs.length &&
      Array.isArray(movement.eventIds) &&
      movement.eventIds.length === 1
    ) {
      const proofs = events.filter((event) => event.id === movement.eventIds[0]);
      const proof = proofs.length === 1 ? proofs[0] : undefined;
      const main = engine.find(
        (event) => event.actionId === action.actionId && event.phase === 'main' && event.kind === 'mechanics',
      );
      if (
        proof &&
        main &&
        proof.actionId === action.actionId &&
        proof.memberId === action.memberId &&
        proof.kind === 'action' &&
        proof.phase === 'movement' &&
        proof.result === 'success' &&
        (!proof.beforeEventId || proof.beforeEventId === main.id) &&
        (!movement.beforeEventId || movement.beforeEventId === main.id)
      ) {
        proof.beforeEventId = main.id;
        delete movement.beforeEventId;
      }
    }
    const search = action.search;
    const roll = context.turn.rolls.find((roll) => roll.memberId === action.memberId && !roll.notation);
    if (record(search) && roll) {
      const information = events.find((event) => event.id === search.informationEventId);
      const requires = roll.success ? 'success' : 'occurrence';
      const checkId = `check:${roll.id}`;
      if (
        information?.kind === 'world' &&
        information.actionId === null &&
        information.locationRef === search.locationId &&
        Array.isArray(information.dependsOn) &&
        !information.dependsOn.some((dep: any) => dep?.eventId === checkId)
      ) {
        const grounded = information.dependsOn.some((dep: any) => {
          const source = events.find((event) => event.id === dep?.eventId);
          return (
            dep?.requires === requires &&
            source?.kind === 'action' &&
            source.actionId === action.actionId &&
            source.memberId === action.memberId &&
            source.phase === 'main' &&
            source.result === (roll.success ? 'success' : 'failure') &&
            source.locationRef === search.locationId &&
            Array.isArray(source.dependsOn) &&
            source.dependsOn.some((edge: any) => edge?.eventId === checkId && edge.requires === requires)
          );
        });
        if (grounded) information.dependsOn.push({ eventId: checkId, requires });
      }
    }
    for (const owner of [action, ...Object.values(action.components).filter(record)]) {
      if (!Array.isArray(owner.eventIds)) continue;
      const ids = owner.eventIds.filter(
        (id: unknown) =>
          !events.some(
            (event) =>
              event.id === id && event.kind === 'world' && event.actionId === null && event.memberId === null,
          ),
      );
      if (ids.length) owner.eventIds = ids;
    }
  }
  // A separation is a projection of positions, not another fictional outcome to ask the model for.
  let positionEventId: string | undefined;
  const resultingPositions = context.members
    .filter((member) => member.active)
    .map((member) => {
      const position = proposedPositions.find((position) => position.memberId === member.id);
      return {
        member,
        ref: resolve(position?.locationId ?? memberScene(context.scene, member.id).location.id!),
        proof: position?.movementEventId,
      };
    });
  for (const separation of Array.isArray(output.separations) ? output.separations : []) {
    if (!record(separation) || !Array.isArray(separation.memberIds) || separation.memberIds.length !== 2)
      continue;
    const source = events.find((event) => event.id === separation.eventId);
    if (
      !source ||
      source.kind !== 'action' ||
      source.result !== 'success' ||
      !(source.phase === 'movement' || source.effect === 'movement') ||
      !separation.memberIds.includes(source.memberId)
    )
      continue;
    const [left, right] = separation.memberIds.map((id: string) =>
      resultingPositions.find((position) => position.member.id === id),
    );
    if (!left || !right || left.ref === right.ref) continue;
    let eventId = positionEventId;
    if (!eventId) {
      let index = events.length;
      while (events.some((event) => event.id === `world:positions:${index}`)) index++;
      eventId = `world:positions:${index}`;
      const names = knownLocations(context.scene);
      const facts = resultingPositions.map(({ member, ref }) => {
        const name =
          names[ref] ?? output.placeUpdates?.find((place: any) => place?.ref === ref)?.location?.name;
        return (
          name &&
          (context.config.language === 'Nederlands'
            ? `${member.character.name} is bij ${name}.`
            : `${member.character.name} is at ${name}.`)
        );
      });
      if (facts.some((fact: any) => !fact)) continue;
      const world = {
        id: eventId,
        sequence: (events.at(-1)?.sequence ?? -1) + 1,
        kind: 'world',
        phase: 'aftermath',
        result: null,
        memberId: null,
        actionId: null,
        fact: facts.join(' '),
        receiptRefs: [],
        dependsOn: [...new Set(resultingPositions.map((position) => position.proof).filter(Boolean))].map(
          (eventId) => ({ eventId, requires: 'success' }),
        ),
      };
      output.events.push(world);
      events.push(world);
      positionEventId = eventId;
    }
    separation.eventId = eventId;
  }
  return output;
}

export function validateAdjudication(context: GMContext, input: unknown): TurnAdjudication {
  const value = orderRoutineMovement(
    turnAdjudicationSchema.parse(normalizeAdjudicationStructure(context, input)),
  );
  const updates = value.placeUpdates ?? [];
  const refs = new Set(updates.map((update) => update.ref));
  if (refs.size !== updates.length) throw new Error('Place update references must be unique.');
  const known = (ref: string) =>
    ref === context.scene.location.id ||
    Object.hasOwn(context.scene.places ?? {}, ref) ||
    Object.hasOwn(context.scene.worldMap?.nodes ?? {}, ref);
  for (const update of updates) {
    if (!known(update.ref) && !/^new:[a-zA-Z0-9_-]{1,80}$/.test(update.ref))
      throw new Error('Use a known place ID or a new: reference.');
  }
  const focus = value.sceneFocus === 'current' ? context.scene.location.id! : value.sceneFocus;
  if (focus && !known(focus) && !refs.has(focus))
    throw new Error('Scene focus must be an established or declared place.');
  const resultingRef = adjudicationPlaceRef(context, value);
  const destination = resultingRef('destination');
  const combatScene = { ...context.scene, places: { ...context.scene.places } };
  const encounters =
    context.combatResult?.encounters ??
    (context.combatResult
      ? { [context.combatResult.locationId ?? context.scene.location.id!]: context.combatResult.encounter }
      : {});
  for (const [locationId, encounter] of Object.entries(encounters)) {
    if (locationId === combatScene.location.id) combatScene.encounter = encounter;
    else if (combatScene.places[locationId])
      combatScene.places[locationId] = { ...combatScene.places[locationId], encounter };
  }
  const combatPlaces = occupiedPlaces(combatScene);
  assertCombatClaims(combatPlaces, [
    ...value.actions.flatMap((action) => [
      {
        text: `${action.fact} ${action.reason}`,
        locationId: memberScene(context.scene, action.memberId).location.id,
      },
      ...Object.values(action.components)
        .filter((component) => component != null)
        .map((component) => ({
          text: `${component.fact} ${component.reason}`,
          locationId: memberScene(context.scene, action.memberId).location.id,
        })),
    ]),
    ...value.events.map((event) => ({
      text: event.fact,
      locationId: resultingRef(event.locationRef ?? 'current'),
    })),
    ...value.journal.map((entry) => ({
      text: entry.detail,
      locationId:
        entry.kind === 'location'
          ? Object.entries(combatPlaces).find(([, place]) => place.location.name === entry.name)?.[0]
          : undefined,
    })),
    ...updates.map((update) => ({
      text: `${update.location.atmosphere} ${update.location.hazard}`,
      locationId: resultingRef(update.ref),
    })),
    ...(value.location
      ? [{ text: `${value.location.atmosphere} ${value.location.hazard}`, locationId: destination }]
      : []),
  ]);
  const positions = value.memberLocations ?? [];
  const informationOnly = value.actions.filter((action) => action.status !== 'passed');
  if (informationOnly.length && informationOnly.every((action) => action.intent === 'orientation')) {
    if (value.rewards.xp || value.rewards.gold) throw new Error('Orientation alone earns no reward.');
    if (value.factionEffects?.some((effect) => effect.type === 'discover'))
      throw new Error(
        'GM orientation may hint at known or observable facts, without revealing undiscovered faction identities.',
      );
  }
  if (
    context.turn.number > 0 &&
    value.location &&
    destination !== context.scene.location.id &&
    !focus &&
    !positions.some((position) => resultingRef(position.locationId) === destination) &&
    !context.members.some(
      (member) => member.active && memberScene(context.scene, member.id).location.id === destination,
    )
  )
    throw new Error('Entering a new place needs the successful movement of a submitted character.');
  const loot = context.receipts?.loot as
    { pendingPlacement?: boolean; memberId?: string; locationId?: string; item?: { id: string } } | undefined;
  if (
    loot?.pendingPlacement &&
    !positions.some(
      (position) =>
        position.memberId === loot.memberId &&
        resultingRef(position.locationId) === resultingRef(loot.locationId ?? 'destination') &&
        resultingRef(position.locationId) !== memberScene(context.scene, position.memberId).location.id,
    )
  )
    throw new Error(
      'Destination loot needs its discovering character’s successful movement to that destination.',
    );
  if (new Set(positions.map((position) => position.memberId)).size !== positions.length)
    throw new Error('Each character can have only one resulting location.');
  if (
    !focus &&
    value.location?.id &&
    value.location.id !== context.scene.location.id &&
    !known(value.location.id)
  )
    throw new Error('Use an established location ID, or null for a new place.');
  for (const position of positions) {
    if (!context.members.some((member) => member.id === position.memberId))
      throw new Error('Unknown character location.');
    const target = resultingRef(position.locationId);
    const action = value.actions.find((action) => action.memberId === position.memberId);
    const origin = memberScene(context.scene, position.memberId).location.id;
    if (context.turn.number > 0 && target !== origin) {
      if (position.movementEventId) {
        const event = value.events.find((event) => event.id === position.movementEventId);
        if (
          !event ||
          event.actionId !== action?.actionId ||
          event.memberId !== position.memberId ||
          event.kind !== 'action' ||
          event.result !== 'success' ||
          !['main', 'movement'].includes(event.phase ?? '')
        )
          throw new Error('Movement must cite that character’s successful movement event.');
        if (event.phase === 'main' && event.effect !== 'movement')
          throw new Error(
            `A position change requires an explicit movement effect, not an unrelated success. For every main-phase movement event, including ${event.id}, set effect:"movement"; alternatively use phase:"movement" for a movement component. Leave positions unchanged for unrelated successes.`,
          );
        if (action?.components[event.phase as 'main' | 'movement']?.status === 'blocked')
          throw new Error('Blocked movement cannot change location.');
      } else {
        // Older v2 output may omit the event ID, but an unrelated success never proves movement.
        const movement = value.events.filter(
          (event) =>
            event.actionId === action?.actionId &&
            event.memberId === position.memberId &&
            event.kind === 'action' &&
            event.result === 'success' &&
            (event.phase === 'movement' || (event.phase === 'main' && event.effect === 'movement')),
        );
        if (updates.length || movement.length !== 1)
          throw new Error('A location change requires that character’s successful submitted movement.');
        position.movementEventId = movement[0].id;
      }
    }
    if (!known(target) && !refs.has(target) && target !== 'legacy:destination')
      throw new Error('Character location must be current, destination, or an established place ID.');
    if (position.locationId === 'destination' && !value.location && !focus)
      throw new Error('Destination needs an established location update.');
  }
  for (const update of updates.filter(
    (update) => update.ref.startsWith('new:') || context.scene.worldMap?.nodes[update.ref]?.visited === false,
  ))
    if (!positions.some((position) => resultingRef(position.locationId) === update.ref))
      throw new Error('New places require an arriving character.');
  assertMovementPositions(context, value);
  validateWorldMap(context, value, resultingRef);
  validateExploration(context, value, resultingRef);
  validateWorldProgression(context, value, resultingRef);
  if (
    focus &&
    !context.members.some(
      (member) =>
        member.active &&
        (positions.some(
          (position) => position.memberId === member.id && resultingRef(position.locationId) === focus,
        ) ||
          (!positions.some((position) => position.memberId === member.id) &&
            memberScene(context.scene, member.id).location.id === focus)),
    )
  )
    throw new Error('Scene focus needs a present character.');
  for (const separation of value.separations ?? []) {
    const locations = separation.memberIds.map((id) => {
      if (!context.members.some((member) => member.id === id))
        throw new Error('Unknown separated character.');
      const position = positions.find((position) => position.memberId === id);
      return position ? resultingRef(position.locationId) : memberScene(context.scene, id).location.id;
    });
    if (
      locations[0] === locations[1] ||
      !value.events.some((event) => event.id === separation.eventId && event.kind === 'world')
    )
      throw new Error('Separated characters need distinct saved places and a world event.');
  }
  validateFactionEffects(context, value);
  const itemIds = new Set([
    ...context.members.flatMap((member) =>
      [
        ...member.state.inventory,
        ...Object.values(member.state.equipment).filter((item) => item != null),
      ].map((item) => item.id),
    ),
    ...[context.scene, ...Object.values(context.scene.places ?? {})].flatMap((place) =>
      place.loot.map((item) => item.id),
    ),
    ...(loot?.item ? [loot.item.id] : []),
  ]);
  for (const entry of value.journal) {
    if (entry.itemId && !itemIds.has(entry.itemId))
      throw new Error('Journal item references need an authoritative item ID.');
    if (entry.itemStatus) throw new Error('Current journal item status is projected by the server.');
  }
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
    if (
      event.locationRef &&
      !known(resultingRef(event.locationRef)) &&
      !refs.has(resultingRef(event.locationRef))
    )
      throw new Error('Local events must reference an established or declared place.');
    if (event.kind === 'action' && !event.actionId)
      throw new Error('Action events require an actor and action identity.');
    if (
      context.turn.actions.some((action) => action.text.trim() && event.fact.trim() === action.text.trim()) ||
      /\b(?:attempts|probeert)\s*:/i.test(event.fact)
    )
      throw new Error('Event facts must describe resolved outcomes instead of copying submissions.');
  }
  const authoritative = engineEvents(context);
  const engineIds = new Set(authoritative.map((event) => event.id));
  const actualEngine = value.events.filter((event) => !(event.phase === 'movement' && event.beforeEventId));
  const withoutSequence = ({ sequence: _sequence, ...event }: ResolvedEvent) => event;
  for (const [index, event] of authoritative.entries())
    if (
      !actualEngine[index] ||
      !isDeepStrictEqual(withoutSequence(actualEngine[index]), withoutSequence(event))
    )
      throw new Error(`Preserve engine event ${event.id} and its execution order exactly.`);
  const fictional = value.events.filter((event) => !engineIds.has(event.id));
  if (fictional.some((event) => !['action', 'world'].includes(event.kind)))
    throw new Error(
      'New adjudicated events must be action outcomes or world consequences; mechanics come from the server.',
    );
  if (fictional.some((event) => event.presentation))
    throw new Error('Only the engine may keep bookkeeping out of story narration.');
  for (const result of value.actions) {
    const submitted = context.turn.actions.find((action) => action.memberId === result.memberId)!;
    if ((result.status === 'passed') !== submitted.passed)
      throw new Error('Pass outcomes must match the submitted pass.');
    const expected = engineComponents(context, result.memberId);
    if (result.intent === 'orientation') {
      const origin = memberScene(context.scene, result.memberId).location.id;
      const localPlans = context.receipts?.combatInputByLocation as Record<string, CombatInput> | undefined;
      const planned = (
        localPlans?.[origin!] ?? (context.receipts?.combatInput as CombatInput | undefined)
      )?.actions.find((action) => action.memberId === result.memberId);
      if (
        planned &&
        (planned.main !== 'interact' ||
          planned.minor !== 'none' ||
          planned.abilityName ||
          planned.mainItemId ||
          planned.dc ||
          planned.effect ||
          planned.environment ||
          planned.cureCondition)
      )
        throw new Error('Orientation cannot reinterpret an executed combat action as informational.');
      if (
        result.components.movement ||
        result.components.minor ||
        result.receiptRefs.some(
          (ref) => ref.startsWith('roll:') || ref.startsWith('tool:resource:') || ref === 'tool:support',
        ) ||
        value.changes.some((change) => change.memberId === result.memberId) ||
        positions.some(
          (position) => position.memberId === result.memberId && resultingRef(position.locationId) !== origin,
        )
      )
        throw new Error('Orientation alone cannot roll, spend resources, change characters or move them.');
    }
    const movement = result.components.movement;
    if (movement) {
      const starter = (context.startingMembers ?? context.members).find(
        (member) => member.id === result.memberId,
      )!;
      if (
        combatReceiptForMember(context, result.memberId) ||
        starter.state.hp <= 0 ||
        incapacitatingCondition(starter.state) ||
        submitted.passed ||
        movement.basis !== 'routine' ||
        movement.status !== 'success' ||
        movement.receiptRefs.length
      )
        throw new Error('Separate movement must be ordinary conscious noncombat movement without resources.');
      const mainExecution = authoritative.find(
        (event) => event.actionId === result.actionId && event.phase === 'main',
      );
      if (
        mainExecution &&
        movement.eventIds.some(
          (id) =>
            value.events.findIndex((event) => event.id === id) >
            value.events.findIndex((event) => event.id === mainExecution.id),
        )
      )
        throw new Error('Completed ordinary movement must precede the later main action.');
    }
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
  if (
    context.combatResult &&
    (value.rewards.xp || value.rewards.gold) &&
    !value.actions.some(
      (action) =>
        !combatReceiptForMember(context, action.memberId) &&
        action.components.main?.status === 'success' &&
        action.intent !== 'orientation' &&
        action.components.main.eventIds.some((id) =>
          value.events.some((event) => event.id === id && event.result === 'success'),
        ),
    )
  )
    throw new Error('Combat rewards come from the engine.');
  return value;
}
