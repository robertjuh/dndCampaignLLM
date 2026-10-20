import type { GMContext } from './game';
import type { Encounter, Scene } from '../shared/schema';
import type { TurnAdjudication } from '../shared/turn-resolution';
import { combatActive, memberScene, placeScene, savePlace } from '../shared/locations';
import { incapacitatingCondition } from '../shared/rules';
import { isDeepStrictEqual } from 'node:util';
import { adjudicationPlaceRef } from './turn-resolution';
import { memberLocationAtEvent } from './world-map';

export type EncounterCheck = {
  locationId: string;
  memberIds: string[];
  danger: 'safe' | 'dangerous';
  reason: string;
  die: number | null;
  triggered: boolean;
};
export type EncounterChecks = Record<string, EncounterCheck>;

/** A saved exploration is already decided. Resume by appending receipt-derived introductions. */
export function completedEncounterProposal(context: GMContext): TurnAdjudication | undefined {
  const baseline = context.receipts?.encounterProposal as TurnAdjudication | undefined;
  if (!baseline) return;
  const checks = context.receipts?.encounterChecks as EncounterChecks | undefined;
  const starts = context.receipts?.startCombatByLocation as Record<string, Encounter> | undefined;
  const triggered = Object.values(checks ?? {}).filter((check) => check.triggered);
  if (!triggered.length || triggered.some((check) => !starts?.[check.locationId])) return;
  const value = structuredClone(baseline);
  for (const check of triggered) {
    const encounter = starts![check.locationId];
    const names = encounter.enemies.map((enemy) => enemy.name).join(', ');
    const id = `encounter:introduction:${check.locationId}`;
    if (value.events.some((event) => event.id === id)) continue;
    value.events.push({
      id,
      sequence: value.events.length,
      kind: 'world',
      memberId: null,
      actionId: null,
      phase: 'aftermath',
      result: null,
      locationRef: check.locationId,
      fact:
        context.config.language === 'Nederlands'
          ? `Een confrontatie begint met ${names}. De eerste combat-ronde wacht op de volgende acties.`
          : `A confrontation begins with ${names}. The first combat round waits for the next actions.`,
      receiptRefs: ['tool:startCombatByLocation'],
      dependsOn: baseline.events
        .filter((event) => event.kind === 'world' && event.locationRef === check.locationId)
        .map((event) => ({ eventId: event.id, requires: 'occurrence' })),
    });
  }
  return value;
}

export function encounterPlaceRef(context: GMContext, value: TurnAdjudication) {
  return adjudicationPlaceRef(context, value);
}

function started(context: GMContext, locationId: string) {
  const starts = context.receipts?.startCombatByLocation as Record<string, Encounter> | undefined;
  return (
    !!starts?.[locationId] ||
    (!!context.receipts?.startCombat && !starts && locationId === context.scene.location.id)
  );
}

/** Encounter introductions may add local fiction, never rewrite the exploration already checked. */
export function assertEncounterProposal(
  context: GMContext,
  value: TurnAdjudication,
  baseline: TurnAdjudication | undefined,
) {
  if (!baseline) return;
  for (const field of [
    'turnId',
    'version',
    'actions',
    'changes',
    'rewards',
    'location',
    'memberLocations',
    'mapUpdates',
    'sceneFocus',
    'separations',
    'arrivals',
    'factionEffects',
    'pickups',
    'npcUpdates',
    'featureUpdates',
  ] as const)
    if (!isDeepStrictEqual(value[field], baseline[field]))
      throw new Error(
        `Saved encounter exploration preserves ${field}; append only its local encounter introduction.`,
      );
  if (!isDeepStrictEqual(value.events.slice(0, baseline.events.length), baseline.events))
    throw new Error('Saved encounter exploration events and their order are immutable.');
  const resolve = encounterPlaceRef(context, baseline);
  for (const event of value.events.slice(baseline.events.length))
    if (
      event.kind !== 'world' ||
      event.actionId !== null ||
      event.memberId !== null ||
      event.phase !== 'aftermath' ||
      event.presentation ||
      event.effect ||
      event.beforeEventId ||
      !event.locationRef ||
      !started(context, resolve(event.locationRef)) ||
      !event.receiptRefs.some((ref) => ref === 'tool:startCombatByLocation' || ref === 'tool:startCombat')
    )
      throw new Error(
        'Append only public local world aftermath events citing the newly started encounter receipt.',
      );
  const preserve = <T>(
    field: string,
    saved: T[] | undefined,
    next: T[] | undefined,
    key: (entry: T) => string,
  ) => {
    if (
      !isDeepStrictEqual((next ?? []).slice(0, saved?.length ?? 0), saved ?? []) ||
      new Set((next ?? []).map(key)).size !== (next ?? []).length
    )
      throw new Error(`Saved encounter ${field} entries are immutable; append only distinct entries.`);
  };
  preserve('journal', baseline.journal, value.journal, (entry) => `${entry.kind}:${entry.name}`);
  preserve('world progress', baseline.worldProgress, value.worldProgress, (entry) => entry.eventId);
  preserve('danger assessment', baseline.encounterRisks, value.encounterRisks, (entry) =>
    resolve(entry.locationId),
  );
  const updates = new Map((value.placeUpdates ?? []).map((update) => [update.ref, update]));
  if (updates.size !== (value.placeUpdates ?? []).length)
    throw new Error('Encounter place updates require unique place identities.');
  for (const prior of baseline.placeUpdates ?? []) {
    const update = updates.get(prior.ref);
    const comparable =
      update && started(context, resolve(prior.ref))
        ? {
            ...update,
            location: {
              ...update.location,
              atmosphere: prior.location.atmosphere,
              hazard: prior.location.hazard,
            },
          }
        : update;
    if (!isDeepStrictEqual(comparable, prior))
      throw new Error(
        'Saved encounter places keep their identities and prior exploration; refresh only local encounter atmosphere or hazards.',
      );
    updates.delete(prior.ref);
  }
  for (const update of updates.values()) {
    const locationId = resolve(update.ref);
    if (
      !started(context, locationId) ||
      (locationId !== context.scene.location.id && !context.scene.places?.[locationId]) ||
      placeScene(context.scene, locationId).location.name !== update.location.name
    )
      throw new Error(
        'New encounter place updates may refresh only the established place of a newly started fight.',
      );
  }
}

/** Without a draw callback, validate the complete plan without spending or saving dice. */
export function prepareEncounterChecks(
  context: GMContext,
  value: TurnAdjudication,
  saved: EncounterChecks,
  draw?: (locationId: string) => number,
) {
  const resolve = encounterPlaceRef(context, value);
  const position = (memberId: string) => {
    const update = value.memberLocations?.find((entry) => entry.memberId === memberId);
    return update ? resolve(update.locationId) : memberScene(context.scene, memberId).location.id!;
  };
  const occupied = new Set(context.members.filter((m) => m.active).map((m) => position(m.id)));
  const starts = context.receipts?.startCombatByLocation as Record<string, Encounter> | undefined;
  for (const ref of Object.keys(starts ?? {})) {
    const locationId =
      context.receipts?.startCombatLegacyLocation === ref ? resolve('destination') : resolve(ref);
    if (!occupied.has(locationId))
      throw new Error('A new combat encounter requires a character actually present at its location.');
    if (
      !value.events.some(
        (event) =>
          event.kind === 'world' &&
          event.actionId === null &&
          event.locationRef &&
          resolve(event.locationRef) === locationId &&
          event.receiptRefs.some(
            (receipt) => receipt === 'tool:startCombatByLocation' || receipt === 'tool:startCombat',
          ),
      )
    )
      throw new Error(
        'Present each newly started encounter in a public local world event citing its startCombat receipt.',
      );
  }
  const assessments = new Map<string, NonNullable<TurnAdjudication['encounterRisks']>[number]>();
  for (const risk of value.encounterRisks ?? []) {
    const locationId = resolve(risk.locationId);
    if (assessments.has(locationId) || !occupied.has(locationId))
      throw new Error('Assess encounter danger once per occupied location.');
    const evidence = value.events.find((event) => event.id === risk.eventId);
    if (
      !evidence ||
      evidence.kind !== 'world' ||
      evidence.actionId !== null ||
      evidence.presentation ||
      !evidence.locationRef ||
      resolve(evidence.locationRef) !== locationId ||
      !context.members.some(
        (member) =>
          member.active &&
          memberLocationAtEvent(context, value, member.id, evidence.id, resolve) === locationId,
      )
    )
      throw new Error('Encounter danger needs public local world evidence.');
    const reliesOnFailure = (eventId: string, seen = new Set<string>()): boolean => {
      if (seen.has(eventId)) return false;
      seen.add(eventId);
      return (
        context.turn.rolls.some((roll) => !roll.success && eventId === `check:${roll.id}`) ||
        !!value.events
          .find((event) => event.id === eventId)
          ?.dependsOn.some((dependency) => reliesOnFailure(dependency.eventId, seen))
      );
    };
    if (risk.danger === 'safe' && reliesOnFailure(evidence.id))
      throw new Error('A failed check cannot establish that a location is safe.');
    assessments.set(locationId, risk);
  }
  // A continuation cannot escape a saved trigger by changing a destination or renaming an arrival.
  for (const check of Object.values(saved)) {
    const group = context.members
      .filter((m) => m.active && position(m.id) === check.locationId)
      .map((m) => m.id)
      .sort();
    if (group.join(',') !== [...check.memberIds].sort().join(','))
      throw new Error('Encounter checks preserve the checked group and its validated destination.');
  }
  const candidates = new Map<string, string[]>();
  if (context.turn.number > 0)
    for (const action of value.actions) {
      const member = context.members.find((m) => m.id === action.memberId);
      const submitted = context.turn.actions.find((a) => a.memberId === action.memberId);
      if (
        !member?.active ||
        !submitted ||
        submitted.passed ||
        member.state.hp <= 0 ||
        incapacitatingCondition(member.state) ||
        action.intent === 'orientation' ||
        context.combatResult?.participantIds?.includes(member.id) ||
        ![action.components.main, action.components.movement].some(
          (part) => part && part.status !== 'blocked' && ['routine', 'check'].includes(part.basis),
        )
      )
        continue;
      const locationId = position(member.id);
      const local = candidates.get(locationId) ?? [];
      local.push(member.id);
      candidates.set(locationId, local);
    }
  const planned: { locationId: string; memberIds: string[]; danger: 'safe' | 'dangerous'; reason: string }[] =
    [];
  // Validate all assessments before drawing, so bad proposals cannot spend extra dice.
  for (const locationId of new Set([...candidates.keys(), ...occupied])) {
    const known = locationId === context.scene.location.id || !!context.scene.places?.[locationId];
    const place = known ? placeScene(context.scene, locationId) : undefined;
    if (started(context, locationId) || (place && combatActive(place))) continue;
    // Descriptive edits do not change the saved danger classification. Only a grounded
    // encounterRisks entry does; unassessed places still require one before exploration.
    const risk = assessments.get(locationId) ?? place?.encounterRisk;
    if (!risk && (candidates.has(locationId) || context.turn.number === 0))
      throw new Error(`Supply encounterRisks with grounded safe/dangerous evidence for ${locationId}.`);
    if (!risk || !candidates.has(locationId) || saved[locationId]) continue;
    planned.push({
      locationId,
      memberIds: context.members
        .filter((m) => m.active && position(m.id) === locationId)
        .map((m) => m.id)
        .sort(),
      danger: risk.danger,
      reason: risk.reason,
    });
  }
  for (const plan of draw ? planned : []) {
    const die = plan.danger === 'dangerous' ? draw!(plan.locationId) : null;
    if (die !== null && (!Number.isInteger(die) || die < 1 || die > 6))
      throw new Error('Encounter checks require a valid d6 result.');
    saved[plan.locationId] = { ...plan, die, triggered: die === 1 };
  }
  return {
    checks: saved,
    required: Object.values(saved).filter((check) => check.triggered && !started(context, check.locationId)),
  };
}

export function saveEncounterRisks(scene: Scene, value: TurnAdjudication, resolve: (ref: string) => string) {
  for (const risk of value.encounterRisks ?? []) {
    const place = placeScene(scene, resolve(risk.locationId));
    place.encounterRisk = { danger: risk.danger, reason: risk.reason };
    savePlace(scene, place);
  }
}

export function encounterContext(context: GMContext) {
  return {
    chance:
      'One d6 per dangerous occupied location per meaningful exploration turn; 1 starts an encounter. Together shares one check. Safe places, passes, orientation, opening and existing fights do not roll.',
    checks: context.receipts?.encounterChecks ?? {},
    preservedAdjudication: context.receipts?.encounterProposal,
    instruction:
      'Saved triggered checks require start_combat at that location. Choose scene-appropriate opponents for the present group; do not move other characters or resolve a first combat round now.',
  };
}
