import { z } from 'zod';
import type { GMContext } from './game';
import { gmNotePatchSchema, prepareGMNotes } from '../shared/gm-memory';
import { memberScene, placeScene, knownLocations } from '../shared/locations';
import { featureUpdateSchema, findSceneFeature } from '../shared/scene-state';
import { factionEffectSchema } from '../shared/factions';
import { currencyNameSchema, maxNarrationLength } from '../shared/schema';
import { createHash } from 'node:crypto';
import { investigationFact, investigationKey, investigationNarration, investigationResults } from './investigations';
import { submittedActionObligations } from './action-intent';
import { applySceneJourneys } from './journeys';
import { requestsPickup } from './turn-pickups';
import { bindNPCSource, knownNPCs, npcIdentity } from './npcs';
import { findNPC } from '../shared/npcs';
import { questOperationSchema } from '../shared/quests';
import {
  gatheringOptions,
  turnConnections,
  actorReferences,
  locationReferences,
  normalizeAdjudicationReferences,
} from './world-map';
import {
  actionId,
  aggregateComponents,
  turnAdjudicationSchema,
  narrationEvents,
  type ActionComponent,
  type ResolvedEvent,
  type TurnAdjudication,
  type TurnNarration,
  type TurnResolution,
} from '../shared/turn-resolution';
import {
  combatReceiptForMember,
  engineComponents,
  engineEvents,
  validateAdjudication,
} from './turn-resolution';

const ref = z.string().trim().min(1).max(100);
const fact = z.string().trim().min(1).max(1500);
const journal = z.object({ kind: z.enum(['npc', 'location', 'quest', 'fact']), name: ref }).strict();
const place = z
  .object({
    name: ref,
    atmosphere: fact,
    hazard: z.string().max(1000),
    danger: z.enum(['safe', 'dangerous']),
    riskReason: z.string().trim().min(1).max(500),
    deadEnd: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
const exit = z
  .object({
    to: ref,
    name: ref.optional(),
    label: ref,
    blocked: z.boolean().default(false),
    bidirectional: z.boolean().default(true),
  })
  .strict();
const npc = turnAdjudicationSchema.shape.npcUpdates
  .unwrap()
  .element.omit({ eventId: true, locationId: true })
  .extend({ locationId: ref.nullable().optional() });
const feature = featureUpdateSchema.omit({ eventId: true, locationId: true });
const resolves = z.array(z.object({
  id: ref, outcome: z.enum(['resolved', 'blocked', 'deferred']), fact,
}).strict()).max(12).optional();
const journeyFields = {
  journeyId: ref.optional(),
  journeyDelay: z.object({ reason: fact, extraStages: z.number().int().min(1).max(10) }).strict().optional(),
};
const common = {
  resolves,
  quests: z.array(questOperationSchema).max(8).optional(),
  fact,
  text: z.string().trim().min(1).max(maxNarrationLength),
  journal: journal.optional(),
  progress: z
    .object({
      thread: z.string().min(1).max(300),
      kind: z.enum(['discovery', 'npc', 'threat', 'resolution']),
    })
    .strict()
    .optional(),
  npcs: z.array(npc).max(12).optional(),
  features: z.array(feature).max(12).optional(),
  factions: z
    .array(
      z.union([
        factionEffectSchema.options[0].omit({ eventId: true }),
        factionEffectSchema.options[1].omit({ eventId: true }),
        factionEffectSchema.options[2].omit({ eventId: true }),
        factionEffectSchema.options[3].omit({ eventId: true }),
      ]),
    )
    .max(12)
    .optional(),
};

/** Model-facing operations: no event identities, dependency graphs or receipt copies. */
export const sceneTurnSchema = z
  .object({
    version: z.literal(3),
    currencyName: currencyNameSchema.optional(),
    beats: z
      .array(
        z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('investigate'), actor: ref, resolves }).strict(),
          z
            .object({
              kind: z.literal('gather'),
              ...journeyFields,
              actor: ref,
              text: common.text,
              with: z.array(ref).max(12).optional(),
              stop: z.object({ at: ref, fact, text: common.text }).strict().optional(),
            })
            .strict(),
          z
            .object({
              ...common,
              kind: z.literal('meet'),
              actor: ref,
              person: npc.omit({ locationId: true }),
            })
            .strict(),
          z
            .object({
              ...common,
              kind: z.literal('take'),
              actor: ref,
              itemId: ref.optional(),
              item: z
                .object({ source: ref, name: ref, description: z.string().trim().min(1).max(700) })
                .strict()
                .optional(),
            })
            .strict(),
          z
            .object({
              kind: z.literal('combat'),
              at: ref,
              text: common.text,
            })
            .strict(),
          z
            .object({
              ...common,
              kind: z.literal('move'),
              ...journeyFields,
              actor: ref,
              to: ref,
              with: z.array(ref).max(12).optional(),
              place: place.optional(),
              route: ref.optional(),
              checked: z.boolean().optional(),
              exits: z.array(exit).max(8).optional(),
            })
            .strict(),
          z
            .object({
              ...common,
              kind: z.literal('act'),
              endJourney: ref.optional(),
              actor: ref,
              slot: z.enum(['main', 'minor']).default('main'),
              intent: z.enum(['action', 'orientation', 'search']).default('action'),
              blocked: z.string().trim().min(1).max(500).optional(),
              finding: z
                .object({ fact, source: z.string().min(1).max(200) })
                .strict()
                .optional(),
              pickup: z
                .object({ itemId: ref, quantity: z.number().int().min(1).max(100).optional() })
                .strict()
                .optional(),
            })
            .strict(),
          z
            .object({
              ...common,
              kind: z.literal('world'),
              at: ref,
              place: place.optional(),
              exits: z.array(exit).max(8).optional(),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(40),
    summary: z.string().trim().min(1).max(2000),
    notes: z.array(gmNotePatchSchema).max(40).default([]),
    opening: z.object({
      npcs: z.array(ref).max(40), features: z.array(ref).max(40),
      quests: z.array(ref).max(20), mysteries: z.array(ref).max(40),
    }).strict().optional(),
    rewards: z.preprocess(
      (value) => value && typeof value === 'object' && !Object.keys(value).length ? undefined : value,
      z.object({ xp: z.number().int().min(0).max(40), reason: fact }).strict().optional(),
    ),
  })
  .strict();
export type SceneTurn = z.infer<typeof sceneTurnSchema>;

export function compileSceneTurn(context: GMContext, input: unknown): TurnAdjudication {
  const scene = sceneTurnSchema.parse(normalizeAdjudicationReferences(context, input));
  const mechanics = engineEvents(context);
  const combats =
    context.combatResult?.encounters ??
    (context.combatResult
      ? { [context.combatResult.locationId ?? context.scene.location.id!]: context.combatResult.encounter }
      : {});
  const notes = prepareGMNotes(
    context.gmMemory ?? [],
    scene.notes.map((note) => ({
      ...note,
      ...(note.locationId === 'current' ? { locationId: context.scene.location.id! } : {}),
    })),
  );
  const value: TurnAdjudication = {
    version: 2,
    currencyName: context.scene.currencyName ?? scene.currencyName,
    turnId: context.turn.id,
    actions: [],
    events: [...mechanics],
    changes: [],
    journal: [],
    location: null,
    memberLocations: [],
    placeUpdates: [],
    mapUpdates: { locations: [], connections: [] },
    arrivals: [],
    encounterRisks: [],
    worldProgress: [],
    npcUpdates: [],
    featureUpdates: [],
    factionEffects: [],
    pickups: [],
    storyItems: [],
    questUpdates: [],
    rewards: { xp: scene.rewards?.xp ?? 0, currency: 0, reason: scene.rewards?.reason ?? 'No reward.' },
    sceneDraft: { passages: [], summary: scene.summary },
    gmNotes: notes,
  };
  const positions = new Map(
    context.members.map((member) => [member.id, memberScene(context.scene, member.id).location.id!]),
  );
  const parts = new Map<
    string,
    { main: ActionComponent | null; minor: ActionComponent | null; movement?: ActionComponent }
  >();
  const intents = new Map<string, 'action' | 'orientation' | 'search'>();
  const searches = new Map<string, NonNullable<TurnAdjudication['actions'][number]['search']>>();
  const moved = new Map<string, string>();
  const journeys = new Map<string, NonNullable<TurnAdjudication['actions'][number]['travel']>>();
  const narratedCombats = new Set<string>();
  const people = knownNPCs(context.scene);
  const performed = new Map<string, { kind: string; intent?: string; at: string; hasPerson: boolean; blocked: boolean; eventId: string; resolves?: z.infer<NonNullable<typeof resolves>> }[]>();
  const resolve = (id: string) => (id === 'current' ? context.scene.location.id! : id);
  const add = (event: Omit<ResolvedEvent, 'id' | 'sequence'>) => {
    const saved: ResolvedEvent = {
      ...event,
      id: `scene:${value.events.length}`,
      sequence: value.events.length,
    };
    value.events.push(saved);
    return saved;
  };
  const world = (at: string, text: string, dependsOn: ResolvedEvent['dependsOn'] = []) =>
    add({
      kind: 'world',
      memberId: null,
      actionId: null,
      phase: null,
      result: null,
      locationRef: at,
      fact: text,
      receiptRefs: [],
      dependsOn,
    });
  const remember = (entry: z.infer<typeof journal>, text: string) => {
    const existing = value.journal.find((item) => item.kind === entry.kind && item.name === entry.name);
    if (existing) existing.detail = `${existing.detail}\n${text}`;
    else {
      const previous = context.journal.find((item) => item.kind === entry.kind && item.name === entry.name);
      value.journal.push({
        ...entry,
        detail: previous && !previous.detail.includes(text) ? `${previous.detail}\n${text}` : text,
      });
    }
  };
  const bindCompanions = (actor: string, companions: string[]) => {
    const at = positions.get(actor)!;
    for (const ref of new Set(companions)) {
      const npc = findNPC({ npcs: people }, ref);
      if (!npc || npc.locationId !== at || npc.status === 'dead')
        throw new Error('A travelling companion must be an established living NPC at the departure place.');
      if (npc.followingMemberId === actor) continue;
      const name = context.members.find((member) => member.id === actor)!.character.name;
      const event = world(
        at,
        context.config.language === 'Nederlands'
          ? `${npc.name} reist mee met ${name}.`
          : `${npc.name} accompanies ${name}.`,
      );
      event.npcIds = [npc.id];
      value.npcUpdates!.push({
        npcId: npc.id,
        name: npc.name,
        locationId: at,
        followingMemberId: actor,
        eventId: event.id,
      });
      npc.followingMemberId = actor;
    }
  };
  const accompany = (actor: string, from: string, to: string, movement: ResolvedEvent) => {
    const companions = Object.values(people).filter(
      (npc) => npc.followingMemberId === actor && npc.status !== 'dead',
    );
    if (!companions.length) return [];
    if (companions.some((npc) => npc.locationId !== from))
      throw new Error('Travelling companions must share the character’s actual departure place.');
    const name = context.members.find((member) => member.id === actor)!.character.name;
    const names = companions.map((npc) => npc.name).join(', ');
    const event = world(
      to,
      context.config.language === 'Nederlands'
        ? `${names} reizen met ${name} mee naar ${knownLocations(context.scene)[to] ?? to}.`
        : `${names} travel with ${name} to ${knownLocations(context.scene)[to] ?? to}.`,
      [{ eventId: movement.id, requires: 'success' }],
    );
    event.npcIds = companions.map((npc) => npc.id);
    for (const npc of companions) {
      value.npcUpdates!.push({
        npcId: npc.id,
        name: npc.name,
        locationId: to,
        followingMemberId: actor,
        eventId: event.id,
      });
      npc.locationId = to;
      remember({ kind: 'npc', name: npc.name }, event.fact);
    }
    return [event.id];
  };
  const route = (
    from: string,
    to: string,
    label: string,
    eventId: string,
    blocked = false,
    bidirectional = true,
  ) => {
    if (
      !value.mapUpdates!.connections.some(
        (edge) => [edge.from, edge.to].sort().join('|') === [from, to].sort().join('|'),
      )
    )
      value.mapUpdates!.connections.push({ from, to, label, blocked, bidirectional, eventId });
  };
  const describe = (at: string, description: z.infer<typeof place>, event: ResolvedEvent) => {
    const hazard = description.deadEnd && !description.hazard.includes(description.deadEnd)
      ? `${description.hazard} ${description.deadEnd}`.trim()
      : description.hazard;
    if (!value.placeUpdates!.some((update) => update.ref === at))
      value.placeUpdates!.push({
        ref: at,
        location: { name: description.name, atmosphere: description.atmosphere, hazard },
      });
    if (!value.encounterRisks!.some((risk) => risk.locationId === at))
      value.encounterRisks!.push({
        locationId: at,
        danger: description.danger,
        reason: description.riskReason,
        eventId: event.id,
      });
    if (
      (context.turn.number === 0 ||
        (!context.scene.worldMap?.nodes[at]?.visited &&
          at !== context.scene.location.id &&
          !context.scene.places?.[at])) &&
      !value.arrivals!.some((arrival) => arrival.locationId === at)
    )
      value.arrivals!.push({ locationId: at, eventId: event.id });
    remember({ kind: 'location', name: description.name }, event.fact);
  };
  const investigations = investigationResults(context);
  const discovered = new Set<string>();
  const operations = [...scene.beats];
  for (const result of investigations) {
    if (
      operations.some(
        (beat) =>
          (beat.kind === 'investigate' && beat.actor === result.memberId) ||
          (beat.kind === 'act' && beat.actor === result.memberId && beat.slot === 'main'),
      )
    )
      continue;
    const move = operations.findIndex((beat) => beat.kind === 'move' && beat.actor === result.memberId);
    const origin = positions.get(result.memberId);
    operations.splice(result.source.locationId === origin ? 0 : move + 1, 0, {
      kind: 'investigate',
      actor: result.memberId,
    });
  }
  for (const operation of operations) {
    const submitted =
      'actor' in operation
        ? context.turn.actions.find((action) => action.memberId === operation.actor)
        : undefined;
    if (submitted && 'with' in operation && operation.with?.length)
      bindCompanions(submitted.memberId, operation.with);
    if (operation.kind === 'gather' || (operation.kind === 'move' && submitted?.gathering)) {
      if (!submitted?.gathering || submitted.passed)
        throw new Error('Gather travel needs that character’s saved Join gathering submission.');
      const actor = submitted.memberId;
      const origin = positions.get(actor)!;
      if (
        parts.has(actor) ||
        moved.has(actor) ||
        Object.values(engineComponents(context, actor)).some(Boolean)
      )
        throw new Error('Joining a gathering spends the whole main action with no additional acts or costs.');
      const progress = gatheringOptions(context, value, resolve)[actor];
      const stop = operation.kind === 'gather' ? operation.stop : undefined;
      const destination = stop ? resolve(stop.at) : progress.destination;
      if (
        !progress.path.includes(destination) ||
        (operation.kind === 'move' &&
          (resolve(operation.to) !== destination ||
            operation.place ||
            operation.exits?.length ||
            operation.npcs?.length ||
            operation.features?.length ||
            operation.factions?.length ||
            operation.progress ||
            operation.journal))
      )
        throw new Error(
          'Gather follows the saved route and stops at its first danger or obstruction. Use gather.stop for a new local interruption; describe other world changes separately.',
        );
      const path = progress.path.slice(0, progress.path.indexOf(destination) + 1);
      const travelled = path.length > 1;
      const name = context.members.find((member) => member.id === actor)!.character.name;
      const names = path.map((id) => knownLocations(context.scene)[id]).join(' → ');
      const dutch = context.config.language === 'Nederlands';
      const fact =
        (travelled
          ? dutch
            ? `${name} reist via ${names}. De reis kost tijd.`
            : `${name} travels via ${names}. Time passes on the journey.`
          : dutch
            ? `${name} blijft bij ${names}; de verzamelroute is onderbroken.`
            : `${name} remains at ${names}; the gathering route is interrupted.`) +
        (stop ? ` ${stop.fact}` : '');
      const event = add({
        kind: 'action',
        actionId: actionId(context.turn.id, actor),
        memberId: actor,
        phase: 'main',
        result: travelled ? 'success' : 'blocked',
        ...(travelled ? { effect: 'movement' as const } : {}),
        locationRef: destination,
        fact: fact.slice(0, 2500),
        receiptRefs: [],
        dependsOn: [],
      });
      parts.set(actor, {
        main: {
          status: travelled ? 'success' : 'blocked',
          basis: travelled ? 'routine' : 'none',
          fact: event.fact,
          reason: stop?.fact ?? 'Travel along the saved gathering route.',
          receiptRefs: [],
          eventIds: [event.id],
        },
        minor: null,
      });
      positions.set(actor, destination);
      if (travelled) {
        moved.set(actor, event.id);
        value.memberLocations!.push({ memberId: actor, locationId: destination, movementEventId: event.id });
      }
      const journey: NonNullable<TurnAdjudication['actions'][number]['travel']> = {
        goalId: submitted.gathering.locationId,
      };
      const covered = [event.id];
      if (travelled) covered.push(...accompany(actor, origin, destination, event));
      if (stop) {
        const obstacle = world(destination, stop.fact, [{ eventId: event.id, requires: 'occurrence' }]);
        journey.obstacleEventId = obstacle.id;
        covered.push(obstacle.id);
        remember(
          {
            kind: 'fact',
            name: `Journey interruption at ${knownLocations(context.scene)[destination]}`.slice(0, 100),
          },
          stop.fact,
        );
      }
      journeys.set(actor, journey);
      value.sceneDraft!.passages.push({
        eventIds: covered,
        text: stop ? `${operation.text}\n${stop.text}` : operation.text,
      });
      continue;
    }
    if (submitted?.gathering)
      throw new Error(
        'Resolve a Join gathering submission with gather; destination actions need a later submission.',
      );
    let storyItem: NonNullable<TurnAdjudication['storyItems']>[number] | undefined;
    let beat: Exclude<SceneTurn['beats'][number], { kind: 'investigate' | 'meet' | 'take' | 'gather' }>;
    const result =
      'actor' in operation ? investigations.find((result) => result.memberId === operation.actor) : undefined;
    if (
      operation.kind === 'investigate' ||
      (operation.kind === 'act' && operation.slot === 'main' && result)
    ) {
      if (!result) throw new Error('Call investigate before describing its saved finding.');
      if (positions.get(result.memberId) !== resolve(result.source.locationId))
        throw new Error('The character must reach the bound investigation source before examining it.');
      const source = result.source;
      if (
        source.kind === 'feature' &&
        !context.scene.features?.[source.id] &&
        !value.featureUpdates!.some((feature) => feature.featureId === source.id)
      ) {
        const visible = world(source.locationId, `${source.name}. ${source.description}`);
        value.featureUpdates!.push({
          featureId: source.id,
          name: source.name,
          aliases: source.aliases ?? [],
          locationId: source.locationId,
          eventId: visible.id,
        });
      }
      const finding = investigationFact(result.finding);
      const text = investigationNarration(result.finding);
      const person = source.kind === 'npc'
        ? bindNPCSource({ ...context.scene, npcs: people }, source, source.locationId).npc
        : undefined;
      const participants = [
        ...(operation.kind === 'act' ? operation.npcs ?? [] : []),
        ...(person ? [{ npcId: person.id, name: person.name, aliases: person.aliases }] : []),
      ];
      const outcome = [
        ...participants.filter((npc) => !result.actionFact.includes(npc.name)).map((npc) => npc.name),
        result.actionFact,
      ].join('. ');
      beat = {
        kind: 'act',
        resolves: 'resolves' in operation ? operation.resolves : undefined,
        actor: result.memberId,
        slot: 'main',
        intent: 'search',
        fact: outcome.slice(0, 1500),
        text: text.trim(),
        ...(participants.length ? { npcs: participants } : {}),
        finding: { fact: finding, source: source.id },
        journal: { kind: 'fact', name: `${source.name.slice(0, 50)} · ${result.question.slice(0, 45)}` },
        ...(!result.reused &&
        !context.journal.some((entry) =>
          investigationKey(entry.detail).includes(investigationKey(finding)),
        ) &&
        !value.worldProgress!.some(
          (progress) => value.events.find((event) => event.id === progress.eventId)?.fact === finding,
        )
          ? { progress: { thread: result.thread, kind: 'discovery' as const } }
          : {}),
      };
      if (
        result.success &&
        !result.reused &&
        !context.gmMemory?.find((note) => note.id === result.hookId)?.revealed?.includes(result.answer)
      ) {
        const note =
          notes.find((note) => note.id === result.hookId) ??
          structuredClone(context.gmMemory!.find((note) => note.id === result.hookId)!);
        if (!notes.includes(note)) notes.push(note);
        note.revealed = [...new Set([...(note.revealed ?? []), result.answer])];
        discovered.add(investigationKey(result.finding.fact));
      }
    } else if (operation.kind === 'meet') {
      const at = positions.get(operation.actor)!;
      const person = npcIdentity(
        { ...context.scene, npcs: people },
        operation.person.npcId,
        operation.person.name,
        operation.person.aliases,
      );
      if (person && person.locationId !== at)
        throw new Error(`${person.name} is at another location; a meeting cannot move them here.`);
      beat = {
        ...operation,
        kind: 'act',
        slot: 'main',
        intent: 'action',
        npcs: [
          ...(operation.npcs ?? []),
          { ...operation.person, npcId: person?.id ?? operation.person.npcId },
        ],
      };
      delete (beat as Record<string, unknown>).person;
    } else if (operation.kind === 'take') {
      if (!!operation.item === !!operation.itemId)
        throw new Error('Take one existing itemId or declare one ordinary item.');
      const at = positions.get(operation.actor)!;
      let itemId = operation.itemId;
      if (operation.item) {
        if (
          !requestsPickup(
            context.turn.actions.find((action) => action.memberId === operation.actor)?.text ?? '',
          )
        )
          throw new Error('Create an ordinary story object only for a submitted collection action.');
        const original = operation.item;
        const feature =
          findSceneFeature(context.scene, original.source) ??
          findSceneFeature(context.scene, original.name, at);
        if (feature && feature.locationId !== at)
          throw new Error('The collected object is at another location. Use its actual source.');
        const object = feature ? { ...original, source: feature.id, name: feature.name } : original;
        const ground =
          at === context.scene.location.id || context.scene.places?.[at]
            ? placeScene(context.scene, at)
            : undefined;
        const existing = ground?.loot.find((item) => item.name.toLowerCase() === object.name.toLowerCase());
        if (existing) itemId = existing.id;
        else {
          if (
            ground?.searchedLoot?.[object.source] ||
            context.members.some((member) =>
              [
                ...member.state.inventory,
                ...Object.values(member.state.equipment).filter((item) => item != null),
              ].some((item) => item.name.toLowerCase() === object.name.toLowerCase()),
            )
          )
            throw new Error('This object already exists or was collected. Reuse its saved item ID.');
          const hex = createHash('sha256').update(`${at}:${object.source}`).digest('hex');
          itemId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
          const previous = value.storyItems!.find((item) => item.id === itemId);
          if (previous && (previous.name !== object.name || previous.description !== object.description))
            throw new Error('Keep the same identity for a shared story object.');
          if (!previous)
            storyItem = {
              id: itemId,
              name: object.name,
              description: object.description,
              locationId: at,
              sourceId: object.source,
              eventId: '',
            };
        }
      }
      beat = { ...operation, kind: 'act', slot: 'main', intent: 'action', pickup: { itemId: itemId! } };
      delete (beat as Record<string, unknown>).item;
      delete (beat as Record<string, unknown>).itemId;
    } else beat = operation;
    if (beat.kind === 'combat') {
      const at = resolve(beat.at);
      const events = mechanics.filter(
        (event) =>
          event.kind === 'combat' &&
          (event.locationRef ?? context.combatResult?.locationId ?? context.scene.location.id) === at &&
          event.presentation !== 'log',
      );
      if (!events.length || narratedCombats.has(at))
        throw new Error('Use one combat beat per location with saved combat results.');
      narratedCombats.add(at);
      value.sceneDraft!.passages.push({ eventIds: events.map((event) => event.id), text: beat.text });
      continue;
    }
    let at: string;
    let event: ResolvedEvent;
    const covered: string[] = [];
    if (beat.kind === 'world') {
      at = resolve(beat.at);
      if (![...positions.values()].includes(at))
        throw new Error('A world development needs a present witness.');
      event = world(at, beat.fact);
      if (combats[at]) event.phase = 'aftermath';
      covered.push(event.id);
      if (beat.place) describe(at, beat.place, event);
    } else {
      const submitted = context.turn.actions.find((action) => action.memberId === beat.actor);
      if (!submitted || submitted.passed)
        throw new Error('An operation needs its own submitted, nonpassing actor.');
      const identity = actionId(context.turn.id, beat.actor);
      if (beat.kind === 'act' && combatReceiptForMember(context, beat.actor))
        throw new Error(
          'Combat actions are already resolved; describe their saved results in a combat beat.',
        );
      const components = parts.get(beat.actor) ?? { main: null, minor: null };
      parts.set(beat.actor, components);
      at = positions.get(beat.actor)!;
      const expected = engineComponents(context, beat.actor);
      if (beat.kind === 'move') {
        if (moved.has(beat.actor) || (beat.checked && components.main))
          throw new Error('Travel crosses one connection; checked traversal uses the main action.');
        const destination = resolve(beat.to);
        const known = knownLocations(context.scene);
        if (destination === at)
          throw new Error(
            `A move needs a distinct destination: ${beat.actor} is already at ${at}. Preserve submitted onward travel with a different adjacent destination and place description; use an act only for an intended interaction within the same place.`,
          );
        if (!known[destination] && !beat.place)
          throw new Error('Describe the new adjacent place in move.place.');
        const declaredRoutes = value.mapUpdates!.connections;
        const availableRoutes = (context.scene.worldMap?.connections ?? [])
          .filter(
            (edge) =>
              !declaredRoutes.some(
                (update) =>
                  [edge.from, edge.to].sort().join('|') === [update.from, update.to].sort().join('|'),
              ),
          )
          .concat(declaredRoutes);
        if (
          known[destination] &&
          !availableRoutes.some(
            (edge) =>
              !edge.blocked &&
              ((edge.from === at && edge.to === destination) ||
                (edge.bidirectional && edge.to === at && edge.from === destination)),
          )
        )
          throw new Error(
            'Use an open adjacent route; an existing blocked or distant route cannot be bypassed.',
          );
        const disposition = beat.checked
          ? expected.main
          : { status: 'success' as const, basis: 'routine' as const };
        if (!disposition) throw new Error('Checked travel needs its saved check first.');
        const phase = beat.checked ? 'main' : 'movement';
        const own = value.events.filter((item) => item.actionId === identity && item.phase === phase);
        event = add({
          kind: 'action',
          memberId: beat.actor,
          actionId: identity,
          phase,
          effect: 'movement',
          result: disposition.status,
          locationRef: disposition.status === 'success' ? destination : at,
          fact: beat.fact,
          receiptRefs: [...new Set(own.flatMap((item) => item.receiptRefs))],
          dependsOn: own.map((item) => ({ eventId: item.id, requires: 'occurrence' as const })),
          ...(!beat.checked &&
          !components.main &&
          value.events.find((item) => item.actionId === identity && item.phase === 'main')
            ? {
                beforeEventId: value.events.find(
                  (item) => item.actionId === identity && item.phase === 'main',
                )!.id,
              }
            : {}),
        });
        components[phase] = {
          ...disposition,
          fact: beat.fact,
          reason: 'Submitted travel along the established local route.',
          receiptRefs: event.receiptRefs,
          eventIds: [...own.map((item) => item.id), event.id],
        };
        covered.push(...own.map((item) => item.id), event.id);
        moved.set(beat.actor, event.id);
        if (disposition.status === 'success') {
          const from = at;
          positions.set(beat.actor, destination);
          value.memberLocations!.push({
            memberId: beat.actor,
            locationId: destination,
            movementEventId: event.id,
          });
          at = destination;
          if (beat.place) {
            const arrival = world(at, `${beat.place.name}. ${beat.place.atmosphere} ${beat.place.hazard}`, [
              { eventId: event.id, requires: 'success' },
            ]);
            covered.push(arrival.id);
            describe(at, beat.place, arrival);
            if (!known[destination])
              route(from, destination, beat.route ?? `Passage to ${beat.place.name}`, arrival.id);
          }
          covered.push(...accompany(beat.actor, from, destination, event));
        } else if (beat.place || beat.exits?.length)
          throw new Error('Failed traversal cannot reveal the destination as an arrival.');
      } else {
        if (components[beat.slot]) throw new Error('One main and one minor action per actor.');
        const outcomes = beat.resolves ?? [];
        const unperformed = outcomes.filter((result) => result.outcome !== 'resolved');
        if (outcomes.length && unperformed.length === outcomes.length && expected[beat.slot]?.basis === 'check')
          throw new Error('A saved checked action has already been attempted; resolve that outcome instead of deferring every part.');
        const disposition =
          expected[beat.slot] ??
          (beat.blocked
            ? { status: 'blocked' as const, basis: 'none' as const }
            : unperformed.length
              ? { status: unperformed.length === outcomes.length ? 'blocked' as const : 'partial' as const, basis: 'routine' as const }
            : { status: 'success' as const, basis: 'routine' as const });
        const own = value.events.filter(
          (item) => item.actionId === identity && item.phase === beat.slot && !item.id.startsWith('scene:'),
        );
        event = add({
          kind: 'action',
          memberId: beat.actor,
          actionId: identity,
          phase: beat.slot,
          result: disposition.status,
          locationRef: at,
          fact: beat.fact,
          receiptRefs: [...new Set(own.flatMap((item) => item.receiptRefs))],
          dependsOn: [
            ...own.map((item) => ({ eventId: item.id, requires: 'occurrence' as const })),
            ...(moved.has(beat.actor)
              ? [{ eventId: moved.get(beat.actor)!, requires: 'success' as const }]
              : []),
          ],
        });
        components[beat.slot] = {
          ...disposition,
          fact: beat.fact,
          reason: beat.blocked ?? 'The submitted interaction and saved mechanical outcome.',
          receiptRefs: event.receiptRefs,
          eventIds: [...own.map((item) => item.id), event.id],
        };
        intents.set(beat.actor, beat.intent);
        covered.push(...own.map((item) => item.id), event.id);
        if (beat.intent === 'search' && !beat.blocked && !beat.finding)
          throw new Error(
            'An investigation needs a concrete finding or a different useful opening on failure.',
          );
        if (beat.finding) {
          const finding = world(
            at,
            beat.finding.fact,
            own
              .filter((item) => item.id.startsWith('check:'))
              .map((item) => ({
                eventId: item.id,
                requires: disposition.status === 'success' ? ('success' as const) : ('occurrence' as const),
              })),
          );
          if (moved.has(beat.actor))
            finding.dependsOn.push({ eventId: moved.get(beat.actor)!, requires: 'success' });
          covered.push(finding.id);
          searches.set(beat.actor, {
            sourceId: beat.finding.source,
            locationId: at,
            informationEventId: finding.id,
            reward: null,
          });
          remember(
            beat.journal ?? { kind: 'fact', name: beat.finding.source.slice(0, 100) },
            beat.finding.fact,
          );
          // Keep the current answer for this question; other questions retain their own journal entries.
          if (result && beat.journal)
            value.journal.find(
              (entry) => entry.kind === beat.journal!.kind && entry.name === beat.journal!.name,
            )!.detail = beat.finding.fact;
          if (beat.progress)
            value.worldProgress!.push({
              ...beat.progress,
              locationId: at,
              eventId: finding.id,
              journal: beat.journal ?? { kind: 'fact', name: beat.finding.source.slice(0, 100) },
            });
        }
        if (beat.pickup) value.pickups!.push({ ...beat.pickup, memberId: beat.actor, eventId: event.id });
        if (storyItem) value.storyItems!.push({ ...storyItem, eventId: event.id });
      }
    }
    if ('exits' in beat)
      for (const edge of beat.exits ?? []) {
        if (
          !knownLocations(context.scene)[edge.to] &&
          !value.mapUpdates!.locations.some((node) => node.ref === edge.to)
        ) {
          if (!edge.name) throw new Error('A new visible exit needs a name.');
          value.mapUpdates!.locations.push({ ref: edge.to, name: edge.name });
        }
        // Exit evidence is public local scenery, independent from an actor's action ownership.
        const evidence =
          event.kind === 'world' && event.locationRef === at
            ? event
            : world(at, `${beat.fact} ${edge.label}`);
        if (!covered.includes(evidence.id)) covered.push(evidence.id);
        route(at, edge.to, edge.label, evidence.id, edge.blocked, edge.bidirectional);
      }
    let evidence = event;
    if (
      beat.npcs?.length ||
      beat.features?.length ||
      (beat.progress && !(beat.kind === 'act' && beat.finding))
    ) {
      // A consequence can be observed even after a failed check without reversing that check.
      evidence =
        event.kind === 'world'
          ? event
          : world(at, beat.fact, [{ eventId: event.id, requires: 'occurrence' }]);
      if (!covered.includes(evidence.id)) covered.push(evidence.id);
    }
    for (const update of beat.npcs ?? []) {
      remember({ kind: 'npc', name: update.name }, evidence.fact);
      const previous = [...value.npcUpdates!].reverse().find((item) => item.npcId === update.npcId);
      if (previous) {
        const unchanged =
          previous.name === update.name &&
          previous.locationId === (update.locationId === undefined ? at : update.locationId) &&
          (update.status === undefined || update.status === (previous.status ?? 'alive')) &&
          (update.allegiance === undefined || update.allegiance === previous.allegiance) &&
          (update.factionId === undefined || update.factionId === previous.factionId) &&
          (update.followingMemberId === undefined || update.followingMemberId === previous.followingMemberId);
        if (unchanged) {
          evidence.npcIds = [...(evidence.npcIds ?? []), update.npcId];
          continue;
        }
      }
      value.npcUpdates!.push({
        ...update,
        locationId: update.locationId === undefined ? at : update.locationId,
        eventId: evidence.id,
      });
      const identity = npcIdentity(
        { ...context.scene, npcs: people },
        update.npcId,
        update.name,
        update.aliases,
      );
      const id = identity?.id ?? update.npcId;
      people[id] = {
        ...identity,
        id,
        name: identity?.name ?? update.name,
        aliases: update.aliases ?? identity?.aliases ?? [],
        locationId: update.locationId === undefined ? at : update.locationId,
        status: update.status ?? identity?.status ?? 'alive',
        allegiance: update.allegiance === undefined ? (identity?.allegiance ?? null) : update.allegiance,
        factionId: update.factionId === undefined ? identity?.factionId : update.factionId,
        ...(update.followingMemberId !== undefined ? { followingMemberId: update.followingMemberId } : {}),
        fact: evidence.fact,
      };
      evidence.npcIds = [...(evidence.npcIds ?? []), update.npcId];
    }
    if (beat.features?.length && ['failure', 'blocked'].includes(event.result ?? ''))
      throw new Error(
        'A failed action cannot apply its feature changes; preserve failure and describe any distinct world consequence separately.',
      );
    for (const update of beat.features ?? []) {
      value.featureUpdates!.push({ ...update, locationId: at, eventId: evidence.id });
      // A successful local opening can support a later move in this same scene.
      const bound =
        update.route === undefined ? context.scene.features?.[update.featureId]?.route : update.route;
      if (bound && update.passable !== undefined) {
        const edge = context.scene.worldMap?.connections.find(
          (edge) => [edge.from, edge.to].sort().join('|') === [bound.from, bound.to].sort().join('|'),
        );
        if (edge) route(edge.from, edge.to, edge.label, evidence.id, !update.passable, edge.bidirectional);
      }
    }
    for (const effect of beat.factions ?? []) value.factionEffects!.push({ ...effect, eventId: evidence.id });
    for (const operation of beat.quests ?? [])
      value.questUpdates!.push({ operation, eventId: operation.type === 'offer' ? evidence.id : event.id });
    if (beat.kind === 'act') {
      const acts = performed.get(beat.actor) ?? [];
      acts.push({
        kind: operation.kind,
        intent: beat.intent,
        at,
        hasPerson: !!beat.npcs?.length || result?.source.kind === 'npc',
        blocked: !!beat.blocked,
        eventId: event.id,
        resolves: beat.resolves,
      });
      performed.set(beat.actor, acts);
    }
    if (beat.journal && !(beat.kind === 'act' && beat.finding)) remember(beat.journal, beat.fact);
    if (beat.progress && !(beat.kind === 'act' && beat.finding)) {
      const entry = beat.journal ?? { kind: 'fact' as const, name: beat.fact.slice(0, 80) };
      if (!beat.journal) remember(entry, beat.fact);
      value.worldProgress!.push({ ...beat.progress, locationId: at, eventId: evidence.id, journal: entry });
    }
    value.sceneDraft!.passages.push({ eventIds: covered, text: beat.text });
  }
  // Report independent structural omissions together, before building action aggregates.
  const corrections: string[] = [];
  if (context.turn.number === 0) {
    if (!scene.opening) corrections.push('Opening needs opening:{npcs:[],features:[],quests:[],mysteries:[]}: list the IDs of every interactable person/object, offered request and mystery introduced in the prose. Save their corresponding updates/preparation in this response. Empty lists are valid when none are introduced.');
    else {
      const registered = {
        npcs: new Set([...Object.keys(context.scene.npcs ?? {}), ...value.npcUpdates!.map((item) => item.npcId)]),
        features: new Set([...Object.keys(context.scene.features ?? {}), ...value.featureUpdates!.map((item) => item.featureId)]),
        quests: new Set([...Object.keys(context.scene.quests ?? {}), ...value.questUpdates!.flatMap(({ operation }) => operation.type === 'offer' ? [operation.quest.id] : [])]),
        mysteries: new Set([...(context.gmMemory ?? []), ...notes].map((note) => note.id)),
      };
      for (const kind of ['npcs', 'features', 'quests', 'mysteries'] as const)
        for (const id of scene.opening[kind])
          if (!registered[kind].has(id)) corrections.push(`Opening ${kind} ${JSON.stringify(id)} lacks its saved ${kind === 'mysteries' ? 'cause and discoverable answers in notes' : 'state update'}; establish it in the appropriate world beat.`);
    }
  }
  const actors = actorReferences(context);
  for (const submitted of context.turn.actions) {
    const expected = engineComponents(context, submitted.memberId);
    for (const slot of ['main', 'minor'] as const) {
      if (expected[slot]?.basis !== 'check' || parts.get(submitted.memberId)?.[slot]) continue;
      const [actor, member] = Object.entries(actors).find(([, actor]) => actor.id === submitted.memberId)!;
      const check = context.turn.rolls.find((roll) => roll.memberId === submitted.memberId && !roll.notation)!;
      corrections.push(
        `${member.name} (${actor}) is missing its ${slot} act for the saved ${check.stat} check (${expected[slot]!.status}; ${check.reason.slice(0, 200)}). Add a separate {kind:"act",actor:"${actor}",slot:"${slot}",fact,text} at the action's actual place; a search also needs intent:"search" and finding:{source,fact}. Keep ordinary arrival in its own move BEFORE the destination act, even on search failure. A move with checked:false records movement only. Use checked:true only when the saved check was for traversal itself. Reuse this check; do not roll again.`,
      );
    }
    if (combatReceiptForMember(context, submitted.memberId)) continue;
    const acts = performed.get(submitted.memberId) ?? [];
    const obligations = submittedActionObligations(context, submitted.memberId);
    const claimed = new Set<string>();
    const outcomeFacts = new Set<string>();
    for (const act of acts) for (const result of act.resolves ?? []) {
      const obligation = obligations.find((item) => item.id === result.id);
      const event = value.events.find((event) => event.id === act.eventId)!;
      if (!obligation || claimed.has(result.id)) {
        corrections.push(`Use each supplied actionObligations ID once for ${submitted.memberId}; invalid or duplicate ${result.id}.`);
        continue;
      }
      claimed.add(result.id);
      if (outcomeFacts.has(investigationKey(result.fact)))
        corrections.push('Each requested target needs its own specific outcome; do not repeat one result for different intent IDs.');
      outcomeFacts.add(investigationKey(result.fact));
      if (!investigationKey(event.fact).includes(investigationKey(result.fact)))
        corrections.push(`Outcome ${result.id} must be stated in its act fact, including its target and actual result or reason for deferral/refusal.`);
      if (result.outcome !== 'resolved' && act.kind !== 'act')
        corrections.push(`Use an act with a concrete reason for ${result.outcome} ${result.id}; do not execute a take/meet/investigate for that unperformed part.`);
      (value.actionOutcomes ??= []).push({ memberId: submitted.memberId, obligationId: result.id, request: obligation.evidence, outcome: result.outcome, fact: result.fact, eventId: act.eventId });
    }
    for (const obligation of obligations) {
      const requiredAt = obligation.afterTravel ? positions.get(submitted.memberId) : obligation.beforeTravel ? memberScene(context.scene, submitted.memberId).location.id : undefined;
      const available = acts.filter((act) => !requiredAt || act.at === requiredAt);
      const addressed = available.filter((act) => act.resolves?.some((result) => result.id === obligation.id));
      if ((obligations.length > 1 || claimed.size) && !addressed.length) {
        corrections.push(`Resolve ${obligation.id} (${obligation.evidence}) at its actual place using resolves:[{id,outcome:"resolved"|"blocked"|"deferred",fact}] on its act/meet/take/investigate. A combined main action may cover multiple IDs with separate outcomes; explain any turn-limit deferral. One unrelated result cannot cover every target.`);
        continue;
      }
      const candidates = addressed.length ? addressed : available;
      const covered =
        (obligations.length === 1 && (obligation.kind === 'use' || obligation.kind === 'collect') &&
          !!context.receipts?.[`resource:item:${submitted.memberId}`]) ||
        candidates.some((act) =>
        act.resolves?.some((result) => result.id === obligation.id && result.outcome !== 'resolved') ||
        act.blocked ||
        (obligation.kind === 'search'
          ? act.intent === 'search'
          : obligation.kind === 'collect'
            ? act.kind === 'take' || !!value.pickups?.some((pickup) => pickup.eventId === act.eventId)
            : act.intent !== 'orientation' || obligation.kind === 'inspect'),
      );
      // A checked journey can itself find a submitted destination; a separate
      // explicitly requested destination act must still survive ordinary travel.
      if (!covered && !(parts.get(submitted.memberId)?.main && !obligation.afterTravel && !acts.length)) {
        const alias = Object.entries(actors).find(([, actor]) => actor.id === submitted.memberId)![0];
        corrections.push(
          `${alias} still needs the submitted ${obligation.kind === 'collect' ? 'object collection' : obligation.kind}: ${JSON.stringify(obligation.evidence)}. Resolve it with its own fitting act/investigate/meet/take operation${obligation.afterTravel ? ' AFTER ordinary arrival, at the destination' : ' at its actual source'}. A move or unrelated prose cannot replace it. Preserve a concrete physical blocker/refusal when appropriate; do not invent success or new dice.`,
        );
      }
      if (obligation.kind === 'talk' && covered && !candidates.some((act) => act.blocked || act.hasPerson || act.resolves?.some((result) => result.id === obligation.id && result.outcome !== 'resolved'))) {
        const text = investigationKey(obligation.evidence);
        const toPlayer = context.members.some((member) =>
          member.id !== submitted.memberId && text.includes(investigationKey(member.character.name)),
        );
        const legacyFinding = investigations.find((result) => result.memberId === submitted.memberId);
        // Frozen old place-bound interviews keep their already accepted source.
        if (!toPlayer && !(legacyFinding && !legacyFinding.finding.narrativeVersion))
          corrections.push(
            `Persist the person in ${JSON.stringify(obligation.evidence)} with meet.person, act.npcs, or an investigate source of kind:npc. An unnamed person can keep a stable public role label. Reuse their saved ID and actual location; a place source cannot stand in for the person answering.`,
          );
      }
    }
  }
  const arrivalCorrections = (adjudication: TurnAdjudication) => {
    const corrections: string[] = [];
    const places = locationReferences(context);
    const connections = turnConnections(context.scene, adjudication, resolve);
    for (const arrival of adjudication.arrivals ?? []) {
      const descriptions = operations.filter(
        (beat) =>
          (beat.kind === 'move' && resolve(beat.to) === arrival.locationId) ||
          (beat.kind === 'world' && resolve(beat.at) === arrival.locationId),
      );
      const reference = Object.entries(places).find(([, place]) => place.id === arrival.locationId);
      const name = reference ? `${reference[1].name} (${reference[0]})` : arrival.locationId;
      const deadEnd = descriptions.some((beat) => 'place' in beat && beat.place?.deadEnd);
      if (!deadEnd && !descriptions.some((beat) => 'exits' in beat && beat.exits !== undefined)) {
        corrections.push(
          `First arrival at ${name} needs explicit exits for its visible routes. Supply exits on its move/world beat, or place.deadEnd explaining the concrete geography or obstacle ending the route.`,
        );
        continue;
      }
      if (
        !deadEnd &&
        !context.members.some((member) => {
          if (positions.get(member.id) !== arrival.locationId) return false;
          const origin = context.turn.number === 0 ? null : memberScene(context.scene, member.id).location.id;
          return connections.some(
            (edge) =>
              !edge.blocked &&
              ((edge.from === arrival.locationId && edge.to !== origin) ||
                (edge.bidirectional && edge.to === arrival.locationId && edge.from !== origin)),
          );
        })
      )
        corrections.push(
          `First arrival at ${name} needs an open onward exit beyond the way back, or place.deadEnd explaining the concrete geography or obstacle. An enclosed room with only its entrance as an exit can be a dead end; describe that enclosure rather than inventing another passage.`,
        );
    }
    return corrections;
  };
  if (corrections.length)
    throw new Error(
      `The scene needs structural corrections; changing fact/text alone cannot fix these:\n${[...corrections, ...arrivalCorrections(value)].join('\n')}`,
    );
  for (const submitted of context.turn.actions) {
    const id = actionId(context.turn.id, submitted.memberId);
    const components = parts.get(submitted.memberId) ?? { main: null, minor: null };
    const expected = engineComponents(context, submitted.memberId);
    if (
      !submitted.passed &&
      !submitted.gathering &&
      !combatReceiptForMember(context, submitted.memberId) &&
      requestsPickup(submitted.text) &&
      !value.pickups!.some((pickup) => pickup.memberId === submitted.memberId) &&
      !context.receipts?.[`resource:item:${submitted.memberId}`] &&
      !['blocked', 'failure'].includes(components.main?.status ?? '')
    )
      throw new Error(
        `Resolve ${submitted.memberId}’s submitted object collection with take or an explicit physical/capacity refusal. Generate an ordinary story item when the described object has no inventory ID. Preserve collection at its actual source before travel; movement alone cannot replace it.`,
      );
    for (const phase of ['main', 'minor'] as const) {
      if (!components[phase] && expected[phase]) {
        const own = value.events.filter((event) => event.actionId === id && event.phase === phase);
        if (own.length)
          components[phase] = {
            ...expected[phase]!,
            fact: own
              .map((event) => event.fact)
              .join(' ')
              .slice(0, 2500),
            reason: 'Saved server outcome.',
            receiptRefs: [...new Set(own.flatMap((event) => event.receiptRefs))],
            eventIds: own.map((event) => event.id),
          };
      }
    }
    if (!submitted.passed && !Object.values(components).some(Boolean))
      throw new Error('The scene is incomplete: resolve every submitted action.');
    const own = value.events.filter((event) => event.actionId === id);
    if (submitted.passed && !own.length) {
      const name = context.members.find((member) => member.id === submitted.memberId)!.character.name;
      own.push(
        add({
          kind: 'action',
          memberId: submitted.memberId,
          actionId: id,
          phase: null,
          result: null,
          locationRef: positions.get(submitted.memberId),
          fact: context.config.language === 'Nederlands' ? `${name} wacht.` : `${name} waits.`,
          receiptRefs: [],
          dependsOn: [],
        }),
      );
    }
    value.actions.push({
      actionId: id,
      memberId: submitted.memberId,
      ...aggregateComponents(components, submitted.passed),
      components,
      fact: own
        .map((event) => event.fact)
        .join(' ')
        .slice(0, 2500),
      reason: 'Submitted intent and authoritative server outcomes.',
      receiptRefs: [...new Set(own.flatMap((event) => event.receiptRefs))],
      eventIds: own.map((event) => event.id),
      intent: intents.get(submitted.memberId) ?? 'action',
      search: searches.get(submitted.memberId) ?? null,
      ...(journeys.has(submitted.memberId) ? { travel: journeys.get(submitted.memberId) } : {}),
    });
  }
  for (const locationId of new Set(positions.values())) {
    const known = locationId === context.scene.location.id || !!context.scene.places?.[locationId];
    if (
      !value.encounterRisks!.some((risk) => risk.locationId === locationId) &&
      !(known && placeScene(context.scene, locationId).encounterRisk)
    )
      throw new Error(
        'Describe the local circumstances and explicit danger assessment of each new or unassessed place.',
      );
  }
  for (const [at, encounter] of Object.entries(combats))
    if (
      encounter.victory &&
      (!value.placeUpdates!.some(
        (update) => update.ref === at && update.location.name === placeScene(context.scene, at).location.name,
      ) ||
        !value.events.some(
          (event) => event.kind === 'world' && event.phase === 'aftermath' && event.locationRef === at,
        ))
    )
      throw new Error(
        `Victory needs a world beat with place describing the aftermath and remaining hazards at ${at}.`,
      );
  for (const note of notes)
    if (
      !Object.hasOwn(knownLocations(context.scene), note.locationId) &&
      !value.placeUpdates!.some((place) => place.ref === note.locationId)
    )
      throw new Error('Private notes need an established or newly arrived location.');
  for (const result of investigations) {
    if (result.reused) continue;
    const from = resolve(result.source.locationId);
    const to = resolve(result.finding.leadLocationId);
    const edges = [...(context.scene.worldMap?.connections ?? []), ...value.mapUpdates!.connections];
    if (
      from !== to &&
      !edges.some(
        (edge) =>
          !edge.blocked &&
          ((edge.from === from && edge.to === to) ||
            (edge.bidirectional && edge.to === from && edge.from === to)),
      )
    )
      throw new Error('Make the saved lead reachable through a visible open adjacent exit.');
  }
  for (const at of Object.keys((context.receipts?.startCombatByLocation ?? {}) as object)) {
    const saved = (context.receipts?.combatIntroductionsByLocation as Record<string, string> | undefined)?.[
      at
    ];
    const introduction = saved
      ? world(
          at,
          saved,
          value.events
            .filter((event) => event.kind === 'world' && event.locationRef === at)
            .map((event) => ({ eventId: event.id, requires: 'occurrence' })),
        )
      : [...value.events].reverse().find((event) => event.kind === 'world' && event.locationRef === at);
    if (saved && introduction) introduction.phase = 'aftermath';
    if (introduction && !introduction.receiptRefs.includes('tool:startCombatByLocation'))
      introduction.receiptRefs.push('tool:startCombatByLocation');
  }
  if (investigations.length) {
    const investigationOnly = context.turn.actions.every(
      (action) => action.passed || action.gathering ||
        investigations.some((result) => result.memberId === action.memberId) ||
        (parts.get(action.memberId)?.movement && !parts.get(action.memberId)?.main && !parts.get(action.memberId)?.minor),
    );
    value.rewards.xp = Math.min(40, Math.max(investigationOnly ? 0 : value.rewards.xp, discovered.size * 10));
    if (discovered.size) value.rewards.reason = 'New prepared discoveries.';
    else if (investigationOnly)
      value.rewards.reason = 'Previously investigated evidence grants no further XP.';
    // A split party's non-investigation outcome must survive the recap too.
    value.sceneDraft!.summary = value.events
      .filter((event) => event.kind === 'action' && event.memberId)
      .map((event) => event.fact)
      .join(' ')
      .slice(0, 2000);
  }
  if (context.turn.actions.every((action) => action.passed || action.gathering))
    value.rewards = { xp: 0, currency: 0, reason: 'Travel and waiting grant no discovery reward.' };
  // Generate default pass/engine presentation locally; never ask the GM to copy receipts.
  const loot = context.receipts?.loot as { memberId?: string; item: { name: string } } | undefined;
  if (loot) {
    const discovery = value.sceneDraft!.passages.find((passage) =>
      investigationKey(passage.text).includes(investigationKey(loot.item.name)) &&
      passage.eventIds.some((id) => {
        const event = value.events.find((event) => event.id === id);
        return event?.kind === 'action' && event.memberId === loot.memberId;
      }),
    );
    if (discovery && value.events.some((event) => event.id === 'loot')) discovery.eventIds.push('loot');
  }
  const covered = new Set(value.sceneDraft!.passages.flatMap((passage) => passage.eventIds));
  for (const event of value.events.filter((event) => event.presentation !== 'log' && !covered.has(event.id)))
    value.sceneDraft!.passages.push({ eventIds: [event.id], text: event.fact });
  const accepted = validateAdjudication(context, value);
  const arrivalErrors = arrivalCorrections(accepted);
  if (arrivalErrors.length) throw new Error(arrivalErrors.join('\n'));
  applySceneJourneys(context, scene, accepted);
  const changed = new Set(
    accepted.events
      .filter(
        (event) =>
          event.result === 'blocked' &&
          value.events.find((original) => original.id === event.id)?.result !== 'blocked',
      )
      .map((event) => event.id),
  );
  if (changed.size && accepted.sceneDraft) {
    for (const outcome of accepted.actionOutcomes ?? [])
      if (changed.has(outcome.eventId)) {
        outcome.outcome = 'blocked';
        outcome.fact = accepted.events.find((event) => event.id === outcome.eventId)!.fact;
      }
    for (const passage of accepted.sceneDraft.passages)
      if (passage.eventIds.some((id) => changed.has(id)))
        passage.text = accepted.events
          .filter((event) => passage.eventIds.includes(event.id) && event.kind !== 'mechanics')
          .map((event) => event.fact)
          .join(' ');
    accepted.sceneDraft.summary = accepted.events
      .filter((event) => ['action', 'world'].includes(event.kind))
      .slice(-3)
      .map((event) => event.fact)
      .join(' ')
      .slice(0, 2000);
  }
  return accepted;
}

/** Attach finalization-only facts locally; no second creative author or critic request. */
export function sceneNarration(value: TurnAdjudication, resolution: TurnResolution): TurnNarration {
  const draft = value.sceneDraft!;
  const events = narrationEvents(resolution);
  const seen = new Set<string>();
  const passages = draft.passages
    .map((passage) => ({
      ...passage,
      eventIds: passage.eventIds.filter((id) => {
        if (seen.has(id) || !events.some((event) => event.id === id)) return false;
        seen.add(id);
        return true;
      }),
    }))
    .filter((passage) => passage.eventIds.length);
  const additions = events.filter((event) => !seen.has(event.id));
  for (const event of additions) passages.push({ eventIds: [event.id], text: event.fact });
  // Canonical sequence includes movement-before-check ordering fixed by the server validator.
  const position = new Map(events.map((event, index) => [event.id, index]));
  for (const passage of passages) passage.eventIds.sort((a, b) => position.get(a)! - position.get(b)!);
  passages.sort((a, b) => position.get(a.eventIds[0])! - position.get(b.eventIds[0])!);
  const introductions = additions.filter((event) => event.receiptRefs.includes('tool:startCombatByLocation'));
  const summary = introductions.length
    ? `${draft.summary.slice(0, 950)}\n${introductions
        .map((event) => event.fact)
        .join('\n')
        .slice(0, 1000)}`
    : draft.summary;
  return { version: 2, turnId: resolution.turnId, passages, closing: '', summary };
}
