import { createHash } from 'node:crypto';
import type { GMContext } from './game';
import { combatActive, knownLocations, locationHazard, memberScene, placeScene } from '../shared/locations';
import { locationConnections } from '../shared/structures';
import { incapacitatingCondition } from '../shared/rules';
import { aggregateComponents, type ActionOutcome, type TurnAdjudication } from '../shared/turn-resolution';
import { retainAdjudicationProgress } from './adjudication-recovery';
import { submittedActionObligations } from './action-intent';
import type { Action } from '../shared/schema';
import { npcNames } from '../shared/npcs';
import { investigationResults } from './investigations';
import { combatReceiptForMember } from './turn-resolution';
import { submittedTravel, travelNextHop } from './world-map';
import { requestsPickup, unquotedActionText } from './turn-pickups';

export type GoalRecovery = {
  memberId: string;
  kind: 'search' | 'inspect' | 'talk' | 'collect' | 'use' | 'overcome' | 'travel' | 'action';
  goalState: 'resolved' | 'progress' | 'failed' | 'unresolved';
  sourceId?: string;
  usefulConsequence?: boolean;
};

const intentKey = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^(?:i|ik)\s+/u, '');

function recoveryKind(context: GMContext, memberId: string): GoalRecovery['kind'] {
  const action = context.turn.actions.find((action) => action.memberId === memberId)!;
  const kind = submittedActionObligations(context, memberId)[0]?.kind;
  return (
    (kind === 'attack' ? 'action' : kind) ??
    (/\b(?:convince|persuad\w*|negotiat\w*|overtuig\w*|onderhandel\w*)\b/iu.test(action.text)
      ? 'talk'
      : 'action')
  );
}

const travelVerbs =
  /\b(?:walk|travel|move|cross|climb|jump|descend|ascend|travers\w*|loop|reis|steek|klim|spring|afdalen)\b/iu;
const negative =
  /\b(?:not|never|don['’]t|won['’]t|can['’]t|cannot|would|could|might|if|unless|niet|nooit|geen|als|tenzij)\b/iu;

/** Exact names/aliases first; a shortened reference must still identify one saved object. */
function namedTarget<T extends { name: string; aliases?: string[] }>(
  items: T[],
  text: string,
): T | undefined {
  const key = ` ${intentKey(text)} `;
  const scored = items
    .map((item) => ({
      item,
      score: Math.max(
        ...[item.name, ...(item.aliases ?? [])].map((name) => {
          const normalized = intentKey(name);
          if (normalized && key.includes(` ${normalized} `)) return 100 + normalized.length;
          return normalized.split(' ').filter((word) => word.length > 3 && key.includes(` ${word} `)).length;
        }),
      ),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored[0]) return;
  // Two explicitly named objects are ambiguous even when one name is longer.
  if (scored[1] && (scored[1].score >= 100 || scored[0].score < 100)) return;
  return scored[0].item;
}

function aggregate(action: ActionOutcome, value: TurnAdjudication) {
  Object.assign(action, aggregateComponents(action.components, action.status === 'passed'));
  const own = value.events.filter((event) => event.actionId === action.actionId);
  action.eventIds = own.map((event) => event.id);
  action.receiptRefs = [...new Set(own.flatMap((event) => event.receiptRefs))];
  action.fact = Object.values(action.components)
    .filter((part) => part != null)
    .map((part) => part.fact)
    .join(' ')
    .slice(0, 2500);
  value.events.forEach((event, sequence) => {
    event.sequence = sequence;
  });
}

function canRecover(context: GMContext, action: ActionOutcome) {
  const submitted = context.turn.actions.find((item) => item.memberId === action.memberId)!;
  const member = context.members.find((item) => item.id === action.memberId)!;
  const check = context.turn.rolls.find((roll) => roll.memberId === member.id && !roll.notation);
  const words = unquotedActionText(submitted.text).trim();
  return (
    !submitted.passed &&
    !submitted.gathering &&
    !submitted.supportAction &&
    !check?.assistsMemberId &&
    !/^(?:(?:can|could|should|would|may)\s+(?:i|we)|(?:kan|kun|mag|moet|zou)\s+(?:ik|wij|we))\b/iu.test(
      words,
    ) &&
    !/\b(?:buy|purchase|pay|bribe|spend|koop\w*|betaal\w*|omkoop\w*)\b/iu.test(words) &&
    !combatReceiptForMember(context, member.id) &&
    !combatActive(memberScene(context.scene, member.id)) &&
    (check?.success || (member.state.hp > 0 && !incapacitatingCondition(member.state)))
  );
}

/** Recover only known ordinary routes; transport, unknown places and ambiguous traversal stay with the GM. */
function recoverTravel(context: GMContext, input: TurnAdjudication, candidate?: TurnAdjudication) {
  const value = structuredClone(input);
  const goals: GoalRecovery[] = [];
  for (const action of value.actions) {
    if (
      !canRecover(context, action) ||
      value.events.some((event) => event.id === `fallback:move:${action.memberId}`) ||
      value.memberLocations?.some((position) => position.memberId === action.memberId)
    )
      continue;
    const submitted = context.turn.actions.find((item) => item.memberId === action.memberId)!;
    const locked = context.partialAdjudication?.actions.find((item) => item.memberId === action.memberId)
      ?.components.main;
    if (locked && !locked.processingFailure) continue;
    // submittedTravel filters negated travel clauses; unrelated "do not upload" preserves walking.
    const journey = submittedTravel(context, action.memberId);
    if (!journey?.goalId) continue;
    const from = memberScene(context.scene, action.memberId).location.id!;
    const check = context.turn.rolls.find((roll) => roll.memberId === action.memberId && !roll.notation);
    const traversal = !!check && travelVerbs.test(check.reason);
    const name = context.members.find((member) => member.id === action.memberId)!.character.name;
    const id = `fallback:move:${action.memberId}`;
    if (traversal && !check!.success && action.components.main?.status === 'failure') {
      value.events.push({
        id,
        sequence: value.events.length,
        kind: 'action',
        memberId: action.memberId,
        actionId: action.actionId,
        phase: 'main',
        effect: 'movement',
        result: 'failure',
        fact:
          context.config.language === 'Nederlands'
            ? `${name} slaagt er deze poging niet in om ${knownLocations(context.scene)[journey.goalId]} te bereiken.`
            : `${name}'s attempt to reach ${knownLocations(context.scene)[journey.goalId]} falls short.`,
        locationRef: from,
        receiptRefs: [`roll:${check!.id}`],
        dependsOn: [{ eventId: `check:${check!.id}`, requires: 'occurrence' }],
      });
      action.components.main.eventIds.push(id);
      aggregate(action, value);
      goals.push({
        memberId: action.memberId,
        kind: 'travel',
        goalState: 'failed',
        sourceId: `route:${journey.goalId}`,
        usefulConsequence: false,
      });
      continue;
    }
    const to = travelNextHop(context.scene, from, journey.goalId);
    if (!to) continue;
    const preview = !context.scene.places?.[to] && !value.placeUpdates?.some((place) => place.ref === to);
    const description = candidate?.placeUpdates?.find((place) => place.ref === to);
    const arrival = candidate?.arrivals?.find((place) => place.locationId === to);
    const risk = candidate?.encounterRisks?.find((place) => place.locationId === to);
    // First visits retain the GM's visible arrival and assessment, never invent a safe destination.
    if (preview && (!description || !arrival || !risk)) continue;
    const arrivalAct = submittedActionObligations(context, action.memberId).some(
      (intent) => intent.afterTravel,
    );
    if (
      (check && !traversal && !arrivalAct) ||
      (submitted.abilityName && !check) ||
      (traversal && !check?.success)
    )
      continue;
    const phase = traversal ? ('main' as const) : ('movement' as const);
    if (phase === 'movement' && action.components.movement) continue;
    const original = phase === 'main' ? action.components.main : undefined;
    const remove = new Set((original?.eventIds ?? []).filter((id) => id.startsWith('outcome:')));
    if (!check && !arrivalAct && action.components.main?.eventIds.every((id) => id.startsWith('outcome:'))) {
      action.components.main.eventIds.forEach((id) => remove.add(id));
      action.components.main = null;
    }
    value.events = value.events.filter((event) => !remove.has(event.id));
    const fact =
      context.config.language === 'Nederlands'
        ? `${name} bereikt ${description?.location.name ?? knownLocations(context.scene)[to]}.`
        : `${name} reaches ${description?.location.name ?? knownLocations(context.scene)[to]}.`;
    const refs = traversal ? [`roll:${check!.id}`] : [];
    value.events.push({
      id,
      sequence: value.events.length,
      kind: 'action',
      memberId: action.memberId,
      actionId: action.actionId,
      phase,
      effect: 'movement',
      result: 'success',
      fact,
      receiptRefs: refs,
      dependsOn: traversal ? [{ eventId: `check:${check!.id}`, requires: 'success' }] : [],
      locationRef: to,
      ...(!traversal && check ? { beforeEventId: `check:${check.id}` } : {}),
    });
    if (preview && candidate) {
      const originalMove = candidate.memberLocations?.find((place) => place.memberId === action.memberId)?.movementEventId;
      const savedIds = new Set(value.events.map((event) => event.id));
      const local = candidate.events.filter((event) => event.kind === 'world' && event.locationRef === to &&
        !event.presentation && event.dependsOn.every((dependency) => dependency.eventId === originalMove || savedIds.has(dependency.eventId)));
      const localIds = new Set(local.map((event) => event.id));
      for (const event of local) if (!savedIds.has(event.id)) value.events.push({ ...structuredClone(event),
        dependsOn: event.dependsOn.map((dependency) => ({ ...dependency, eventId: dependency.eventId === originalMove ? id : dependency.eventId })) });
      if (localIds.has(arrival!.eventId) && localIds.has(risk!.eventId)) {
        (value.placeUpdates ??= []).push(structuredClone(description!));
        (value.arrivals ??= []).push(structuredClone(arrival!));
        (value.encounterRisks ??= []).push(structuredClone(risk!));
        const map = (value.mapUpdates ??= { locations: [], connections: [] });
        for (const edge of candidate.mapUpdates?.connections ?? []) if (localIds.has(edge.eventId)) {
          if (!map.connections.some((saved) => [saved.from, saved.to].sort().join('|') === [edge.from, edge.to].sort().join('|')))
            map.connections.push(structuredClone(edge));
          for (const ref of [edge.from, edge.to]) {
            const node = candidate.mapUpdates?.locations.find((node) => node.ref === ref);
            if (node && !map.locations.some((saved) => saved.ref === ref)) map.locations.push(structuredClone(node));
          }
        }
        for (const npc of candidate.npcUpdates ?? []) if (localIds.has(npc.eventId))
          (value.npcUpdates ??= []).push(structuredClone(npc));
      }
    }
    action.components[phase] = {
      status: 'success',
      basis: traversal ? 'check' : 'routine',
      fact,
      reason: fact,
      receiptRefs: refs,
      eventIds: [...(original?.eventIds.filter((id) => !remove.has(id)) ?? []), id],
    };
    (value.memberLocations ??= []).push({ memberId: action.memberId, locationId: to, movementEventId: id });
    action.travel = { goalId: journey.goalId };
    aggregate(action, value);
    goals.push({
      memberId: action.memberId,
      kind: 'travel',
      goalState: to === journey.goalId && !arrivalAct ? 'resolved' : 'progress',
      sourceId: `route:${to}`,
      usefulConsequence: true,
    });
  }
  return { value, goals };
}

/** ponytail: finish only simple saved booleans; other goals keep evidence rather than growing an intent parser. */
function recoverFeature(context: GMContext, value: TurnAdjudication, action: ActionOutcome) {
  const check = context.turn.rolls.find((roll) => roll.memberId === action.memberId && !roll.notation);
  if (
    !check?.success ||
    !canRecover(context, action) ||
    action.components.main?.status !== 'success' ||
    recoveryKind(context, action.memberId) === 'talk'
  )
    return;
  const submitted = context.turn.actions.find((item) => item.memberId === action.memberId)!;
  const clauses = unquotedActionText(submitted.text)
    .split(/[.;!]|\b(?:and|then|but|en|daarna|maar)\b/iu)
    .filter((clause) => !negative.test(clause));
  const at =
    value.memberLocations?.find((position) => position.memberId === action.memberId)?.locationId ??
    memberScene(context.scene, action.memberId).location.id!;
  const features = Object.values(context.scene.features ?? {}).filter((feature) => feature.locationId === at);
  const operations = [
    { pattern: /\b(?:unlock|ontgrendel\w*)\b/iu, fields: { locked: false } },
    { pattern: /\b(?:open|openen)\b/iu, fields: { open: true } },
    { pattern: /\b(?:repair|fix|herstel\w*|repareer\w*)\b/iu, fields: { working: true, damaged: false } },
  ];
  for (const operation of operations) {
    const clause = clauses.find((clause) => operation.pattern.test(clause));
    if (!clause || !operation.pattern.test(check.reason)) continue;
    const feature = namedTarget(features, clause);
    if (
      !feature ||
      namedTarget(features, check.reason)?.id !== feature.id ||
      Object.keys(feature.properties).some(
        (key) => !['locked', 'open', 'working', 'damaged'].includes(key),
      ) ||
      /\b(?:requires?|needs?|only|without|cannot|vereist|alleen|zonder)\b/iu.test(feature.fact)
    )
      continue;
    if (value.featureUpdates?.some((update) => update.featureId === feature.id)) continue;
    const properties = Object.fromEntries(
      Object.entries(operation.fields).filter(([key]) => typeof feature.properties[key] === 'boolean'),
    );
    if (!Object.keys(properties).length || (operation.fields.open && feature.properties.locked === true))
      continue;
    const state = { ...feature.properties, ...properties };
    const changed = Object.keys(properties).some((key) => properties[key] !== feature.properties[key]);
    const id = `fallback:goal:${action.memberId}`;
    const name = context.members.find((member) => member.id === action.memberId)!.character.name;
    const detail = Object.keys(properties).includes('locked')
      ? context.config.language === 'Nederlands'
        ? 'ontgrendelt'
        : 'unlocks'
      : Object.keys(properties).includes('open')
        ? context.config.language === 'Nederlands'
          ? 'opent'
          : 'opens'
        : context.config.language === 'Nederlands'
          ? 'herstelt'
          : 'repairs';
    const trial = structuredClone(value);
    trial.events.push({
      id,
      sequence: trial.events.length,
      kind: 'world',
      memberId: null,
      actionId: null,
      phase: 'aftermath',
      result: null,
      fact: changed
        ? `${name} ${detail} ${feature.name}.`
        : context.config.language === 'Nederlands'
          ? `${name} bevestigt dat ${feature.name} al ${Object.hasOwn(properties, 'locked') ? 'ontgrendeld' : Object.hasOwn(properties, 'open') ? 'open' : 'hersteld'} is.`
          : `${name} confirms that ${feature.name} is already ${Object.hasOwn(properties, 'locked') ? 'unlocked' : Object.hasOwn(properties, 'open') ? 'open' : 'repaired'}.`,
      locationRef: at,
      receiptRefs: [],
      dependsOn: [{ eventId: `check:${check.id}`, requires: 'success' }],
    });
    const controllers = Object.values(context.scene.features ?? {}).filter(
      (other) =>
        other.route &&
        feature.route &&
        [other.route.from, other.route.to].sort().join('|') ===
          [feature.route.from, feature.route.to].sort().join('|'),
    );
    (trial.featureUpdates ??= []).push({
      featureId: feature.id,
      name: feature.name,
      locationId: at,
      properties,
      eventId: id,
      ...(changed &&
      feature.route &&
      controllers.length === 1 &&
      state.locked !== true &&
      state.open !== false &&
      state.working !== false &&
      state.damaged !== true
        ? { passable: true }
        : {}),
    });
    const goal: GoalRecovery = {
      memberId: action.memberId,
      kind: 'overcome',
      sourceId: `feature:${feature.id}`,
      goalState:
        submittedActionObligations(context, action.memberId).length > 1 ||
        clauses.some(
          (other) => other !== clause && operations.some((operation) => operation.pattern.test(other)),
        ) ||
        (!!submittedTravel(context, action.memberId) &&
          !value.memberLocations?.some((position) => position.memberId === action.memberId))
          ? 'progress'
          : 'resolved',
      usefulConsequence: true,
    };
    return { value: trial, goal };
  }
}

function recoverPickup(context: GMContext, value: TurnAdjudication, action: ActionOutcome) {
  const submitted = context.turn.actions.find((item) => item.memberId === action.memberId)!;
  const clauses = unquotedActionText(submitted.text)
    .split(/[.;!\n]|\b(?:and|then|but|en|daarna|maar)\b/iu)
    .filter((clause) => requestsPickup(clause) && !negative.test(clause));
  if (
    !canRecover(context, action) ||
    recoveryKind(context, action.memberId) === 'talk' ||
    clauses.length !== 1 ||
    submitted.abilityName ||
    context.turn.rolls.some((roll) => roll.memberId === action.memberId && !roll.notation) ||
    /\b(?:\d+|two|three|four|all|both|twee|drie|vier|alle|beide)\b/iu.test(submitted.text) ||
    (action.components.main && action.components.main.status !== 'blocked')
  )
    return;
  const at =
    value.memberLocations?.find((position) => position.memberId === action.memberId)?.locationId ??
    memberScene(context.scene, action.memberId).location.id!;
  if (at !== context.scene.location.id && !context.scene.places?.[at]) return;
  const item = namedTarget(
    placeScene(context.scene, at).loot.filter((item) => item.quantity > 0),
    clauses[0],
  );
  if (!item) return;
  const trial = structuredClone(value);
  const target = trial.actions.find((target) => target.memberId === action.memberId)!;
  const remove = new Set(target.components.main?.eventIds.filter((id) => id.startsWith('outcome:')) ?? []);
  trial.events = trial.events.filter((event) => !remove.has(event.id));
  const id = `fallback:take:${action.memberId}`;
  const name = context.members.find((member) => member.id === action.memberId)!.character.name;
  const fact =
    context.config.language === 'Nederlands'
      ? `${name} pakt ${item.name} op.`
      : `${name} picks up ${item.name}.`;
  trial.events.push({
    id,
    sequence: trial.events.length,
    kind: 'action',
    memberId: action.memberId,
    actionId: action.actionId,
    phase: 'main',
    result: 'success',
    fact,
    locationRef: at,
    receiptRefs: [],
    dependsOn: [],
  });
  target.components.main = {
    status: 'success',
    basis: 'routine',
    fact,
    reason: fact,
    eventIds: [id],
    receiptRefs: [],
  };
  (trial.pickups ??= []).push({ memberId: action.memberId, itemId: item.id, eventId: id, quantity: 1 });
  aggregate(target, trial);
  return {
    value: trial,
    goal: {
      memberId: action.memberId,
      kind: 'collect',
      goalState: submittedActionObligations(context, action.memberId).length > 1 ? 'progress' : 'resolved',
      sourceId: `item:${item.id}`,
      usefulConsequence: true,
    } as GoalRecovery,
  };
}

/** Structural playability signals, not a semantic reviewer or an authority over game outcomes. */
export function turnPlayability(
  context: GMContext,
  value: TurnAdjudication | undefined,
  recovered: GoalRecovery[] = [],
  previous: Pick<Action, 'memberId' | 'text' | 'passed'>[] = [],
) {
  const outcomes = context.turn.actions
    .filter((action) => !action.passed)
    .map((submitted) => {
      const result = value?.actions.find((action) => action.memberId === submitted.memberId);
      const recovery = recovered.find((action) => action.memberId === submitted.memberId);
      const declared =
        value?.actionOutcomes?.filter((action) => action.memberId === submitted.memberId) ?? [];
      const main = result?.components.main;
      const moved = value?.memberLocations?.find((position) => position.memberId === submitted.memberId);
      const hasProgress =
        !!moved && moved.locationId !== memberScene(context.scene, submitted.memberId).location.id;
      const usefulFinding =
        !!result?.search &&
        value?.events.some(
          (event) =>
            event.id === result.search!.informationEventId &&
            event.kind === 'world' &&
            !!event.fact.trim() &&
            event.fact !== main?.fact,
        );
      const unfinished = declared.some((action) => action.outcome !== 'resolved');
      const previousInput = previous.find(
        (action) => action.memberId === submitted.memberId && !action.passed,
      );
      const key = intentKey(submitted.text);
      const repeatedInput =
        !!previousInput &&
        (intentKey(previousInput.text) === key ||
          /^(?:try again|retry|again|opnieuw|nog eens|probeer opnieuw)$/u.test(key));
      const goalState = !result
        ? 'unassessed'
        : main?.status === 'failure'
          ? 'failed'
          : main?.status === 'blocked'
            ? hasProgress
              ? 'progress'
              : 'unresolved'
            : unfinished ||
                result.status === 'partial' ||
                (result.travel &&
                  (moved?.locationId ?? memberScene(context.scene, submitted.memberId).location.id) !==
                    result.travel.goalId)
              ? 'progress'
              : (recovery?.goalState ?? 'resolved');
      return {
        memberId: submitted.memberId,
        kind: result?.search ? 'search' : (recovery?.kind ?? recoveryKind(context, submitted.memberId)),
        goalState,
        repeatedInput,
        recovered: !!recovery,
        usefulConsequence:
          hasProgress || usefulFinding || recovery?.usefulConsequence === true || goalState === 'resolved',
        inputFingerprint: createHash('sha256').update(key).digest('hex').slice(0, 16),
      };
    });
  return {
    version: 1,
    outcomes,
    unfinishedGoals: outcomes.filter((action) =>
      ['progress', 'failed', 'unresolved'].includes(action.goalState),
    ).length,
    repeatedInputs: outcomes.filter((action) => action.repeatedInput).length,
  };
}

/** Presentation variety is stable across recovery; it never rolls rewards or damage. */
function observation(context: GMContext, memberId: string) {
  const scene = memberScene(context.scene, memberId);
  const dutch = context.config.language === 'Nederlands';
  const action = context.turn.actions.find((action) => action.memberId === memberId)!;
  const kind = recoveryKind(context, memberId);
  const key = intentKey(action.text);
  const tokens = (text: string) =>
    intentKey(text)
      .split(' ')
      .filter(
        (word) =>
          word.length > 2 && !/^(?:the|and|with|from|that|this|het|een|van|met|voor|naar)$/u.test(word),
      );
  type Evidence = { sourceId: string; text: string; names: string[]; domain: string; priority: number };
  const options: Evidence[] = [
    ...scene.loot
      .filter((item) => item.quantity > 0)
      .filter(() => kind === 'collect' || kind === 'use')
      .map((item) => ({
        sourceId: `item:${item.id}`,
        names: [item.name],
        domain: 'item',
        priority: 30,
        text: dutch
          ? `${item.name} ligt hier nog om op te pakken.`
          : `${item.name} is still here, available to pick up.`,
      })),
    ...Object.values(scene.features ?? {})
      .filter((feature) => feature.locationId === scene.location.id)
      .map((feature) => ({
        sourceId: `feature:${feature.id}`,
        names: [feature.name, ...feature.aliases],
        domain: 'feature',
        priority: ['inspect', 'search', 'overcome', 'use'].includes(kind) ? 30 : 0,
        text: `${feature.name}: ${
          Object.entries(feature.properties)
            .slice(0, 3)
            .map(([key, value]) => `${key}: ${value}`)
            .join(', ') || feature.fact
        }`,
      })),
    ...Object.values(scene.npcs ?? {})
      .filter((npc) => npc.locationId === scene.location.id)
      .map((npc) => ({
        sourceId: `npc:${npc.id}`,
        names: npcNames(npc),
        domain: 'npc',
        priority: kind === 'talk' ? 40 : 0,
        text: `${npc.name} (${
          dutch
            ? {
                alive: 'aanwezig',
                dead: 'overleden',
                withdrawn: 'teruggetrokken',
                surrendered: 'overgegeven',
              }[npc.status]
            : { alive: 'present', dead: 'dead', withdrawn: 'withdrawn', surrendered: 'surrendered' }[
                npc.status
              ]
        }): ${npc.fact}`,
      })),
    ...locationConnections(scene)
      .filter(
        (edge) => edge.from === scene.location.id || (edge.bidirectional && edge.to === scene.location.id),
      )
      .map((edge) => {
        const to = edge.from === scene.location.id ? edge.to : edge.from;
        const name = scene.worldMap?.nodes[to]?.name;
        return {
          sourceId: `route:${to}`,
          names: [name ?? '', edge.label],
          domain: 'route',
          priority: 0,
          text: name
            ? dutch
              ? `${edge.label}: de doorgang naar ${name} is ${edge.blocked ? 'geblokkeerd' : 'open'}.`
              : `${edge.label}: the passage to ${name} is ${edge.blocked ? 'blocked' : 'open'}.`
            : '',
        };
      }),
    {
      sourceId: `hazard:${scene.location.id}`,
      names: [],
      domain: 'place',
      priority: 0,
      text: locationHazard(scene.location.hazard),
    },
    {
      sourceId: `place:${scene.location.id}`,
      names: [scene.location.name],
      domain: 'place',
      priority: 0,
      text: scene.location.atmosphere,
    },
  ];
  const investigation = investigationResults(context).find(
    (finding) => finding.memberId === memberId && finding.source.locationId === scene.location.id,
  );
  if (investigation)
    options.push({
      sourceId: `investigation:${memberId}`,
      names: [investigation.source.name],
      domain: 'investigation',
      priority: 200,
      text: [...new Set([investigation.finding.fact, investigation.finding.lead])].join(' '),
    });
  const knownIds = new Set([
    scene.location.id,
    ...Object.values(scene.npcs ?? {})
      .filter((npc) => npc.locationId === scene.location.id)
      .map((npc) => npc.id),
    ...Object.values(scene.features ?? {})
      .filter((feature) => feature.locationId === scene.location.id)
      .map((feature) => feature.id),
  ]);
  for (const memory of context.retrievedMemory?.facts ?? []) {
    if (!memory.actorIds.includes(memberId) || !memory.entityIds.some((id) => knownIds.has(id))) continue;
    const names = options
      .filter((option) => memory.entityIds.some((id) => option.sourceId.endsWith(`:${id}`)))
      .flatMap((option) => option.names);
    options.push({
      sourceId: `memory:${memory.turnId}:${memory.sourceId}`,
      names,
      domain: 'memory',
      priority: kind === 'talk' ? 35 : 10,
      text: memory.text,
    });
  }
  const recent = intentKey(
    [...context.history.map((entry) => entry.summary), ...context.journal.map((entry) => entry.detail)].join(
      ' ',
    ),
  );
  const ranked = options
    .filter((option) => option.text.trim() && option.text.length <= 1800)
    .map((option) => {
      const matched = option.names.some(
        (name) => !!intentKey(name) && ` ${key} `.includes(` ${intentKey(name)} `),
      );
      const overlap = tokens(option.names.join(' ')).filter((word) =>
        tokens(action.text).includes(word),
      ).length;
      return {
        ...option,
        matched: matched || overlap > 0,
        score:
          option.priority +
          (matched ? 100 : 0) +
          overlap * 20 -
          (recent.includes(intentKey(option.text)) ? 15 : 0),
      };
    })
    .sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId));
  const index = createHash('sha256')
    .update(`${context.turn.id}:${memberId}:observation`)
    .digest()
    .readUInt32BE(0);
  const best = ranked.filter((option) => option.score === ranked[0]?.score);
  const chosen = best[index % best.length];
  return chosen
    ? { ...chosen, kind, useful: chosen.domain === 'investigation' || chosen.matched }
    : { sourceId: `place:${scene.location.id}`, text: scene.location.name, kind, useful: false };
}

/** An unavailable noncombat goal still leaves a concrete, public observation in this turn. */
export function addInstinctObservations(context: GMContext, input: TurnAdjudication): TurnAdjudication {
  const eligible = input.actions.filter((action) => action.components.main?.status === 'blocked' &&
    canRecover(context, action) &&
    !context.turn.rolls.some((roll) => roll.memberId === action.memberId && !roll.notation) &&
    !input.events.some((event) => event.id === `instinct:observation:${action.memberId}` ||
      event.id === `fallback:observation:${action.memberId}` ||
      (event.kind === 'world' && event.dependsOn.some((dependency) => action.components.main!.eventIds.includes(dependency.eventId)))));
  if (!eligible.length || context.turn.number === 0) return input;
  const value = structuredClone(input);
  for (const action of eligible) {
    const member = context.members.find((member) => member.id === action.memberId)!;
    const origin = memberScene(context.scene, member.id).location.id!;
    const at = input.memberLocations?.find((position) => position.memberId === member.id)?.locationId ?? origin;
    const currentFact = [...input.events].reverse().find((event) =>
      !event.id.startsWith('instinct:observation:') && !event.id.startsWith('fallback:observation:') &&
      (event.locationRef ?? context.scene.location.id) === at &&
      (event.kind === 'world' || (event.kind === 'action' && event.result === 'success')));
    const location = input.placeUpdates?.find((place) => place.ref === at)?.location ?? context.scene.places?.[at]?.location;
    const finding = currentFact?.fact ?? (at === origin ? observation(context, member.id).text :
      location?.atmosphere || location?.hazard || location?.name);
    if (!finding) continue;
    const excerpt = finding.length <= 2000 ? finding :
      finding.match(/^.{1,2000}[.!?](?=\s|$)/s)?.[0] || location?.atmosphere ||
      (at === origin ? memberScene(context.scene, member.id).location.name : location?.name);
    if (!excerpt) continue;
    const event = {
      id: `instinct:observation:${member.id}`, sequence: value.events.length,
      kind: 'world' as const, memberId: null, actionId: null, phase: 'aftermath' as const,
      result: null, locationRef: at,
      fact: context.config.language === 'Nederlands'
        ? `${member.character.name} reageert instinctief en merkt op: ${excerpt}`
        : `${member.character.name} acts on instinct and notices: ${excerpt}`,
      receiptRefs: [], dependsOn: action.components.main!.eventIds.map((eventId) => ({ eventId, requires: 'occurrence' as const })),
    };
    value.events.push(event);
    value.sceneDraft?.passages.push({ eventIds: [event.id], text: event.fact });
  }
  return value;
}

/** Recover supported outcomes; technical omissions remain marked for a saved-turn retry. */
export function finishTurnFallback(
  context: GMContext,
  base: TurnAdjudication,
  candidate: TurnAdjudication | undefined,
  validate: (input: unknown) => TurnAdjudication,
): TurnAdjudication {
  const fallback = structuredClone(base);
  const proposed = candidate ?? context.partialAdjudication;
  const evidenceByMember = new Map<string, ReturnType<typeof observation>>();
  const completedGoals = new Map<string, GoalRecovery>();
  const dutch = context.config.language === 'Nederlands';
  for (const action of fallback.actions) {
    const member = context.members.find((member) => member.id === action.memberId)!;
    for (const component of Object.values(action.components)) {
      if (!component) continue;
      component.reason = dutch
        ? 'Volgens de vastgelegde uitkomst en waarneembare omgeving.'
        : 'Supported by the recorded outcome and observable surroundings.';
      if (!component.processingFailure) continue;
      component.reason = dutch
        ? 'De verwerking is onvoltooid; opnieuw proberen hervat dit onderdeel met de opgeslagen resultaten.'
        : 'Processing is unfinished; retry resumes this component with the saved results.';
      component.fact = dutch
        ? `De actie van ${member.character.name} is nog niet volledig verwerkt.`
        : `${member.character.name}'s action has not been fully processed.`;
      for (const event of fallback.events.filter((event) => component.eventIds.includes(event.id)))
        event.fact = component.fact;
    }
    action.fact =
      Object.values(action.components)
        .filter((part) => part != null)
        .map((part) => part.fact)
        .join(' ')
        .slice(0, 2500) || action.fact;
    action.reason = dutch
      ? 'De vastgelegde uitkomst en de waarneembare omgeving blijven bepalend.'
      : 'The recorded outcome and observable surroundings determine the result.';
    if (action.status === 'passed' || member.state.hp <= 0 || incapacitatingCondition(member.state)) continue;
    const evidence = observation(context, member.id);
    evidenceByMember.set(member.id, evidence);
    fallback.events.push({
      id: `fallback:observation:${member.id}`,
      sequence: fallback.events.length,
      kind: 'world',
      memberId: null,
      actionId: null,
      phase: 'aftermath',
      result: null,
      locationRef: memberScene(context.scene, member.id).location.id,
      fact: dutch
        ? `${member.character.name} merkt bij deze poging op: ${evidence.text}`
        : `${member.character.name} notices during this attempt: ${evidence.text}`,
      receiptRefs: [],
      dependsOn: [],
    });
  }
  let value: TurnAdjudication;
  try {
    value = validate(fallback);
  } catch (error) {
    const travel = recoverTravel(context, fallback, proposed);
    if (!travel.goals.length) throw error;
    value = validate(travel.value);
    travel.goals.forEach((goal) => completedGoals.set(goal.memberId, goal));
  }
  if (proposed) {
    // A compiler can fail after producing independent valid events, before assembling every action.
    const recovered = structuredClone(proposed);
    recovered.actions = fallback.actions.map((action) => {
      const saved = proposed.actions.find((saved) => saved.memberId === action.memberId);
      if (saved) return saved;
      const own = proposed.events.filter((event) => event.actionId === action.actionId);
      const components = { ...action.components };
      for (const phase of ['main', 'minor', 'movement'] as const) {
        const events = own.filter((event) => event.phase === phase);
        if (!events.length || !events[0].result) continue;
        components[phase] = {
          status: events[0].result,
          basis: events.some((event) => event.receiptRefs.length)
            ? (action.components[phase]?.basis ?? 'routine')
            : 'routine',
          fact: events
            .map((event) => event.fact)
            .join(' ')
            .slice(0, 2500),
          reason: 'Preserved local outcome.',
          receiptRefs: [...new Set(events.flatMap((event) => event.receiptRefs))],
          eventIds: events.map((event) => event.id),
        };
      }
      return {
        ...action,
        components,
        ...aggregateComponents(components, action.status === 'passed'),
        fact: Object.values(components)
          .filter((part) => part != null)
          .map((part) => part.fact)
          .join(' ')
          .slice(0, 2500),
        eventIds: [...new Set([...own.map((event) => event.id), ...action.eventIds])],
        receiptRefs: [...new Set(own.flatMap((event) => event.receiptRefs))],
      };
    });
    try {
      value = retainAdjudicationProgress(context, recovered, value, validate).value;
    } catch {
      /* Independently invalid output cannot replace the validated fallback. */
    }
  }
  const travel = recoverTravel(context, value, proposed);
  if (travel.goals.length) {
    try {
      value = validate(travel.value);
      travel.goals.forEach((goal) => completedGoals.set(goal.memberId, goal));
    } catch {
      /* Keep independently accepted movement when another requested route is unavailable. */
    }
  }
  for (const action of [...value.actions]) {
    const recovered = recoverFeature(context, value, action) ?? recoverPickup(context, value, action);
    if (!recovered) continue;
    try {
      value = validate(recovered.value);
      const main = value.actions.find((item) => item.memberId === action.memberId)?.components.main;
      completedGoals.set(action.memberId, {
        ...recovered.goal,
        goalState: main?.status === 'blocked' ? 'unresolved' : recovered.goal.goalState,
        usefulConsequence: main?.status !== 'blocked',
      });
    } catch {
      /* Ambiguous/unsupported effects fall back to target-related evidence, never a retry loop. */
    }
  }
  // Retention can supersede a fallback action with a successful move; observations must stay local.
  value.events = value.events.filter(
    (event) =>
      !event.id.startsWith('fallback:observation:') ||
      (![...completedGoals.values()].some(
        (goal) =>
          ['resolved', 'progress'].includes(goal.goalState) &&
          event.id === `fallback:observation:${goal.memberId}`,
      ) &&
        ![...evidenceByMember].some(
          ([memberId, evidence]) =>
            event.id === `fallback:observation:${memberId}` &&
            value.featureUpdates?.some((update) => evidence.sourceId === `feature:${update.featureId}`),
        ) &&
        !value.actions.some(
          (action) =>
            event.id === `fallback:observation:${action.memberId}` &&
            action.eventIds.some((id) =>
              value.events.some(
                (own) =>
                  own.id === id &&
                  own.kind === 'action' &&
                  !own.id.startsWith('outcome:') &&
                  !own.id.startsWith('fallback:'),
              ),
            ),
        ) &&
        !(value.memberLocations ?? []).some(
          (position) =>
            event.id === `fallback:observation:${position.memberId}` &&
            position.locationId !== event.locationRef,
        )),
  );
  value.events.forEach((event, sequence) => {
    event.sequence = sequence;
  });
  if (context.requestBudget)
    context.requestBudget.goalRecovery = value.actions.flatMap((action) => {
      const evidence = evidenceByMember.get(action.memberId);
      const completed = completedGoals.get(action.memberId);
      if (completed)
        return [
          {
            ...completed,
            usefulConsequence:
              completed.usefulConsequence || (completed.goalState === 'failed' && evidence?.useful),
          },
        ];
      if (!evidence) return [];
      const actual = action.eventIds.some((id) =>
        value.events.some(
          (event) =>
            event.id === id &&
            event.kind === 'action' &&
            !event.id.startsWith('outcome:') &&
            !event.id.startsWith('fallback:'),
        ),
      );
      const main = action.components.main;
      const investigation = investigationResults(context).find(
        (finding) => finding.memberId === action.memberId,
      );
      const moved = value.memberLocations?.some((position) => position.memberId === action.memberId);
      return [
        {
          memberId: action.memberId,
          kind: evidence.kind,
          sourceId: evidence.sourceId,
          goalState:
            main?.status === 'failure'
              ? ('failed' as const)
              : main?.status === 'blocked'
                ? ('unresolved' as const)
                : actual || investigation?.success
                  ? ('resolved' as const)
                  : moved || evidence.useful
                    ? ('progress' as const)
                    : ('unresolved' as const),
          usefulConsequence: actual || moved || evidence.useful,
        },
      ];
    });
  return validate(value);
}
