import { createHash } from 'node:crypto';
import type { GMContext } from './game';
import type { Item, Member, Scene } from '../shared/schema';
import type { Quest, QuestDefinition } from '../shared/quests';
import type { TurnAdjudication } from '../shared/turn-resolution';
import { questDefinitionSchema } from '../shared/quests';
import { baseItem, offerGroundItem, randomLoot, removeItem } from '../shared/rules';
import {
  combatActive,
  memberScene,
  placeScene,
  registerMap,
  registerPlaces,
  savePlace,
} from '../shared/locations';
import { featureConnection } from '../shared/scene-state';
import { applyNPCUpdates, knownNPCs } from './npcs';
import { applyFeatureUpdates } from './scene-state';
import { memberLocationAtEvent } from './world-map';
import { applyFactionEffects } from './factions';

type Delivery = { memberId: string; itemId: string; quantity: number };
type Claim = { questId: string; locationId: string; eventId: string; deliveries: Delivery[] };
export type QuestPlan = { quests: Record<string, Quest>; claims: Claim[] };
const ongoing = (q: Quest) => q.status === 'active' || q.status === 'ready';
const sameItem = (
  item: Item,
  c: Extract<QuestDefinition['objectives'][number]['condition'], { kind: 'deliver' }>,
) => (c.itemId ? item.id === c.itemId : item.sourceId === c.sourceId);
const questKey = (id: string) => `quest:${createHash('sha256').update(id).digest('hex').slice(0, 32)}`;

/** A narrow consent check; the scene GM still interprets the actual agreement or handover. */
function consents(text: string, type: 'accept' | 'decline' | 'abandon' | 'turnIn' | 'deliver') {
  const patterns = {
    accept:
      /\b(?:accept|agree|deal|yes|help|will|let's|let us|take (?:the |this )?(?:job|quest|request)|aanvaard|accepteer|akkoord|ja|helpen|zal|zullen|doen het)\b/iu,
    decline: /\b(?:decline|refuse|no|reject|weiger|nee|afwijzen|wijs.*af)\b/iu,
    abandon: /\b(?:abandon|cancel|quit|stop|give up|opgeven|geef.*op|stoppen|annuleer)\b/iu,
    turnIn:
      /\b(?:report|return(?:ing)?|deliver|give|show|hand|claim|reward|payment|turn.*in|tell|bring(?:ing)?|verslag|rapporteer|terug|lever|geef|toon|overhandig|beloning|vertel|breng|brengen)\b/iu,
    deliver: /\b(?:deliver|give|hand|turn.*in|lever|geef|overhandig)\b/iu,
  };
  return text
    .split(/[.!;\n]/u)
    .some(
      (part) =>
        (patterns[type].test(part) ||
          (type === 'deliver' &&
            !/\b(?:with me|with us|met (?:me|mij|ons) mee)\b/iu.test(part) &&
            (/\breturn(?:ing)?\s+(?!(?:to|towards?|from|home|back|here|there|empty[- ]handed)\b)\S/iu.test(part) ||
              /\b(?:bring(?:ing)?\b[^.!;\n]*\bback|(?:breng|brengen)\b[^.!;\n]*\bterug)\b/iu.test(part)))) &&
        (type === 'decline' || !/\b(?:not|never|don't|won't|refuse|niet|nooit|weiger)\b/iu.test(part)) &&
        !/^\s*(?:can|could|should|would|may|kan|kunnen|zou|moet)\b/iu.test(part),
    );
}

function reachable(scene: Scene, origin: string, target: string) {
  const reached = new Set([origin]);
  for (const at of reached)
    for (const edge of scene.worldMap?.connections ?? []) {
      if (edge.blocked) continue;
      if (edge.from === at) reached.add(edge.to);
      if (edge.bidirectional && edge.to === at) reached.add(edge.from);
    }
  return reached.has(target);
}

/** The same pure plan is used for validation and atomic finalization. No model-authored progress. */
export function planQuests(context: GMContext, value: TurnAdjudication): QuestPlan {
  if (!Object.keys(context.scene.quests ?? {}).length && !value.questUpdates?.length)
    return { quests: {}, claims: [] };
  const scene = structuredClone(context.scene);
  scene.npcs = knownNPCs(scene);
  const quests: Record<string, Quest> = Object.assign(Object.create(null), structuredClone(scene.quests ?? {}));
  const claims: Claim[] = [];
  const members = structuredClone(context.members);
  const resolve = (ref: string) => (ref === 'current' ? context.scene.location.id! : ref);
  registerPlaces(scene, value.placeUpdates ?? [], {});
  registerMap(scene, value.mapUpdates, {}, context.scene.location.id!);
  const notes = [...new Map(
    [...(context.gmMemory ?? []), ...(value.gmNotes ?? [])].map((note) => [note.id, note]),
  ).values()];
  const deaths = () => Object.values(scene.npcs!).filter((n) => n.status === 'dead');
  const refresh = (quest: Quest, eventId?: string) => {
    if (!ongoing(quest)) return;
    const deadRecipient = [quest.giverId, quest.recipientId].some((id) => scene.npcs![id]?.status === 'dead');
    const lostEscort = quest.objectives.some(
      ({ condition: c }) => c.kind === 'escort' && scene.npcs![c.npcId]?.status === 'dead',
    );
    if (
      deadRecipient ||
      lostEscort ||
      (quest.deadlineTurn !== undefined && context.turn.number > quest.deadlineTurn)
    ) {
      quest.status = 'failed';
      quest.failureReason =
        context.config.language === 'Nederlands'
          ? deadRecipient
            ? 'De opdrachtgever of ontvanger is overleden.'
            : lostEscort
              ? 'De te begeleiden persoon is overleden.'
              : 'De afgesproken termijn is verstreken.'
          : deadRecipient
            ? 'The giver or recipient has died.'
            : lostEscort
              ? 'The escorted person has died.'
              : 'The agreed deadline has passed.';
      return;
    }
    for (const objective of quest.objectives) {
      const c = objective.condition;
      const old = quest.progress[objective.id];
      let evidence: string[] = [];
      let current = 0;
      const required = c.kind === 'hunt' ? c.count : c.kind === 'deliver' ? c.quantity : 1;
      switch (c.kind) {
        case 'kill':
        case 'hunt':
          evidence = deaths()
            .filter(
              (npc) =>
                !quest.priorDeaths.includes(npc.id) &&
                (c.kind === 'kill'
                  ? npc.id === c.npcId
                  : npc.locationId === c.locationId && npc.enemy?.tags?.includes(c.tag)),
            )
            .map((npc) => npc.id)
            .slice(0, required);
          current = evidence.length;
          break;
        case 'deliver':
          current = members
            .filter((m) => m.active)
            .flatMap((m) => m.state.inventory)
            .filter((item) => sameItem(item, c))
            .reduce((sum, item) => sum + item.quantity, 0);
          break;
        case 'visit': {
          const present = members.some(
            (m) =>
              m.active &&
              m.state.hp > 0 &&
              (eventId
                ? memberLocationAtEvent(context, value, m.id, eventId, resolve)
                : memberScene(scene, m.id).location.id) === c.locationId,
          );
          evidence = old?.evidence ?? [];
          if (present && eventId && !evidence.length) evidence = [`${context.turn.id}:${eventId}`];
          current = evidence.length ? 1 : 0;
          break;
        }
        case 'escort':
          current =
            scene.npcs![c.npcId]?.status !== 'dead' && scene.npcs![c.npcId]?.locationId === c.locationId
              ? 1
              : 0;
          break;
        case 'discover':
          current = notes.some((note) => note.id === c.hookId && note.revealed?.includes(c.answer)) ? 1 : 0;
          break;
        case 'state': {
          const feature = scene.features?.[c.featureId];
          const property =
            c.property === 'passable' && feature?.route
              ? !featureConnection(scene, feature.route)?.blocked
              : feature?.properties[c.property];
          current = property === c.value ? 1 : 0;
          break;
        }
      }
      quest.progress[objective.id] = {
        current: Math.min(required, current),
        complete: current >= required,
        evidence,
      };
    }
    quest.status = quest.objectives.every((o) => quest.progress[o.id].complete) ? 'ready' : 'active';
  };
  const allItems = () => [
    ...members.filter((m) => m.active && m.state.hp > 0).flatMap((m) => m.state.inventory),
    ...[scene, ...Object.values(scene.places ?? {})].flatMap((p) => p.loot),
    ...(value.storyItems ?? []).map((item) => ({
      ...baseItem(item.id, item.name, 'tool'),
      sourceId: item.sourceId,
      quantity: 1,
    })),
    ...((context.receipts?.loot as { item?: Item } | undefined)?.item
      ? [(context.receipts!.loot as { item: Item }).item]
      : []),
  ];
  for (const event of value.events) {
    const local = {
      ...value,
      npcUpdates: value.npcUpdates?.filter((u) => u.eventId === event.id),
      featureUpdates: value.featureUpdates?.filter((u) => u.eventId === event.id),
    };
    applyNPCUpdates(scene, local, resolve);
    applyFeatureUpdates(scene, local, resolve);
    for (const quest of Object.values(quests)) refresh(quest, event.id);
    for (const { operation } of (value.questUpdates ?? []).filter((u) => u.eventId === event.id)) {
      if (event.presentation || !event.locationRef || ['failure', 'blocked'].includes(event.result ?? ''))
        throw new Error('Quest changes require a successful local interaction.');
      const at = resolve(event.locationRef);
      if (operation.type === 'offer') {
        const definition = questDefinitionSchema.parse(operation.quest);
        if (Object.hasOwn(quests, definition.id))
          throw new Error('A saved request cannot be replaced or offered again.');
        if (
          Object.values(quests).some(
            (q) =>
              q.giverId === definition.giverId &&
              (q.name.toLowerCase() === definition.name.toLowerCase() ||
                q.objectives.some(({ condition: old }) =>
                  old.kind === 'deliver' && definition.objectives.some(({ condition: next }) =>
                    next.kind === 'deliver' &&
                    (old.sourceId ? old.sourceId === next.sourceId : old.itemId === next.itemId),
                  ),
                ) ||
                JSON.stringify(q.objectives.map((o) => o.condition)) ===
                  JSON.stringify(definition.objectives.map((o) => o.condition))),
          )
        )
          throw new Error('Reuse the existing request; renamed copies cannot reset its progress or rewards.');
        const giver = scene.npcs![definition.giverId];
        const recipient = scene.npcs![definition.recipientId];
        if (
          !giver ||
          giver.status === 'dead' ||
          giver.locationId !== at ||
          !recipient ||
          recipient.status === 'dead' ||
          !recipient.locationId ||
          !event.fact.toLowerCase().includes(giver.name.toLowerCase())
        )
          throw new Error('A request needs its actual living local giver and a saved living recipient.');
        const destinations: string[] = [recipient.locationId];
        for (const { condition: c } of definition.objectives) {
          if (
            c.kind === 'hunt' &&
            Object.values(scene.npcs!).filter(
              (npc) =>
                npc.status !== 'dead' && npc.locationId === c.locationId && npc.enemy?.tags?.includes(c.tag),
            ).length < c.count
          )
            throw new Error(
              'Prepare enough real living tagged enemies at the hunt location before offering their bounty.',
            );
          if ('locationId' in c) destinations.push(c.locationId);
          if ('npcId' in c) {
            if (c.kind === 'kill' && [definition.giverId, definition.recipientId].includes(c.npcId))
              throw new Error('A request cannot require killing its own giver or turn-in recipient.');
            const target = scene.npcs![c.npcId];
            if (!target || target.status === 'dead' || !target.locationId)
              throw new Error('A quest target must be a saved living NPC or monster.');
            destinations.push(target.locationId);
          }
          if (c.kind === 'state') {
            const feature = scene.features?.[c.featureId];
            if (
              !feature ||
              (!Object.hasOwn(feature.properties, c.property) &&
                !(c.property === 'passable' && feature.route))
            )
              throw new Error(
                'Repair, rescue, negotiation and other state objectives need a prepared object and property.',
              );
            destinations.push(feature.locationId);
          }
          if (c.kind === 'deliver') {
            const items = allItems().filter((item) => sameItem(item, c));
            const source = c.sourceId ? scene.features?.[c.sourceId] : undefined;
            const preparation = c.preparation && notes.find((note) => note.id === c.preparation!.hookId);
            if (c.preparation && !preparation?.discoveries[c.preparation.answer])
              throw new Error('A future collectible needs its fixed private prepared answer before being requested.');
            const available = items.reduce(
              (sum, item) =>
                sum + ('quantity' in item && typeof item.quantity === 'number' ? item.quantity : 1),
              0,
            );
            if (Math.max(available, source ? 1 : 0) < c.quantity && !preparation)
              throw new Error('A delivery needs enough real items or a prepared collectible source.');
            if (source) destinations.push(source.locationId);
            // A private answer fixes the future collectible; its known approach must be
            // reachable now. Nothing is spawned or remotely revealed by the agreement.
            if (preparation) destinations.push(preparation.locationId);
            for (const member of members)
              if (member.state.inventory.some((item) => sameItem(item, c)))
                destinations.push(memberScene(scene, member.id).location.id!);
            for (const place of [scene, ...Object.values(scene.places ?? {})])
              if (place.loot.some((item) => sameItem(item, c))) destinations.push(place.location.id!);
          }
          if (c.kind === 'discover') {
            const note = notes.find((n) => n.id === c.hookId && n.discoveries[c.answer]);
            if (!note) throw new Error('An investigation request needs a prepared discoverable answer.');
            destinations.push(note.locationId);
          }
        }
        if (destinations.some((target) => !reachable(scene, at, target)))
          throw new Error('Prepare a reachable way to complete and turn in this request before offering it.');
        for (const access of definition.reward.access)
          if (
            !scene.worldMap?.connections.some(
              (edge) =>
                (edge.from === access.from && edge.to === access.to) ||
                (edge.bidirectional && edge.from === access.to && edge.to === access.from),
            )
          )
            throw new Error('An access reward must name an existing saved passage.');
        if (definition.reward.faction) {
          const faction = context.factions?.factions.find(
            (f) => f.id === definition.reward.faction!.factionId,
          );
          if (
            !faction ||
            (giver.factionId !== faction.id &&
              giver.allegiance !== faction.id &&
              giver.allegiance !== faction.name)
          )
            throw new Error('Faction rewards require the giver’s established faction connection.');
          if (
            faction.discoveredTurn === null &&
            !value.factionEffects?.some((e) => e.type === 'discover' && e.factionId === faction.id)
          )
            throw new Error('Reveal a faction before promising its reputation as a public reward.');
        }
        if (definition.deadlineTurn !== undefined && definition.deadlineTurn <= context.turn.number)
          throw new Error('A new request needs a future, communicated deadline.');
        quests[definition.id] = {
          ...definition,
          status: 'offered',
          offeredTurn: context.turn.number,
          progress: {},
          priorDeaths: [],
        };
        continue;
      }
      const quest = Object.hasOwn(quests, operation.questId) ? quests[operation.questId] : undefined;
      if (!quest) throw new Error('Unknown quest. Use its saved ID.');
      const actor = members.find((m) => m.id === event.memberId && m.active && m.state.hp > 0);
      const submitted = context.turn.actions.find((a) => a.memberId === actor?.id);
      if (
        !actor ||
        event.kind !== 'action' ||
        event.phase !== 'main' ||
        !submitted ||
        submitted.passed ||
        !consents(submitted.text, operation.type) ||
        memberLocationAtEvent(context, value, actor.id, event.id, resolve) !== at ||
        value.actions.find((a) => a.memberId === actor.id)?.intent === 'orientation' ||
        combatActive(placeScene(scene, at))
      )
        throw new Error(
          'Accepting, declining, abandoning or turning in needs that player’s explicit local interaction.',
        );
      if (operation.type === 'abandon') {
        if (!ongoing(quest)) throw new Error('Only an active request can be abandoned.');
        quest.status = 'abandoned';
        continue;
      }
      const person = scene.npcs![operation.type === 'turnIn' ? quest.recipientId : quest.giverId];
      if (
        !person ||
        person.status === 'dead' ||
        person.locationId !== at ||
        !event.fact.toLowerCase().includes(person.name.toLowerCase())
      )
        throw new Error('Resolve the request with its actual living giver or designated recipient.');
      if (operation.type === 'accept' || operation.type === 'decline') {
        if (quest.status !== 'offered') throw new Error('This request has already been accepted or closed.');
        quest.status = operation.type === 'decline' ? 'declined' : 'active';
        if (operation.type === 'accept') {
          quest.acceptedTurn = context.turn.number;
          quest.priorDeaths = deaths().map((npc) => npc.id);
          refresh(quest, event.id);
        }
        continue;
      }
      // Returning the requested object is itself agreement to that delivery; an extra
      // verbal "accept" is unnecessary. Other objectives still need explicit acceptance.
      if (
        quest.status === 'offered' &&
        quest.objectives.every(({ condition }) => condition.kind === 'deliver') &&
        consents(submitted.text, 'deliver') &&
        quest.objectives.some(({ condition }) => condition.kind === 'deliver' &&
          actor.state.inventory.some((item) => sameItem(item, condition)),
        )
      ) {
        quest.status = 'active';
        quest.acceptedTurn = context.turn.number;
        quest.priorDeaths = deaths().map((npc) => npc.id);
        refresh(quest, event.id);
      }
      if (quest.status !== 'ready')
        throw new Error(
          'The saved objectives are not ready for turn-in, or this reward was already claimed.',
        );
      const deliveries: Delivery[] = [];
      for (const { condition: c } of quest.objectives) {
        if (c.kind !== 'deliver') continue;
        let remaining = c.quantity;
        for (const member of members) {
          if (
            !member.active ||
            member.state.hp <= 0 ||
            memberLocationAtEvent(context, value, member.id, event.id, resolve) !== at
          )
            continue;
          if (
            !context.turn.actions.some(
              (a) => a.memberId === member.id && !a.passed && consents(a.text, 'deliver'),
            )
          )
            continue;
          for (const item of [...member.state.inventory].filter((item) => sameItem(item, c))) {
            const quantity = Math.min(remaining, item.quantity);
            if (!quantity) break;
            deliveries.push({ memberId: member.id, itemId: item.id, quantity });
            removeItem(member.state, item.id, quantity);
            remaining -= quantity;
          }
        }
        if (remaining)
          throw new Error('Bring the required items to the recipient and explicitly hand them over.');
      }
      if (
        quest.reward.faction &&
        value.factionEffects?.some(
          (e) => e.type === 'reputation' && e.factionId === quest.reward.faction!.factionId,
        )
      )
        throw new Error(
          'Quest turn-in applies its faction reputation automatically; omit a duplicate faction effect.',
        );
      quest.status = 'completed';
      quest.completedTurn = context.turn.number;
      claims.push({ questId: quest.id, locationId: at, eventId: event.id, deliveries });
    }
  }
  if ((value.questUpdates ?? []).some((u) => !value.events.some((e) => e.id === u.eventId)))
    throw new Error('Quest changes need an actual saved event.');
  for (const quest of Object.values(quests)) refresh(quest, value.events.at(-1)?.id);
  return { quests, claims };
}

/** Called inside the existing finalization transaction; a frozen resolution prevents replay. */
export function applyQuestPlan(
  context: GMContext,
  value: TurnAdjudication,
  plan: QuestPlan,
  scene: Scene,
  members: Member[],
  resolve: (ref: string) => string,
  draw: (sides: number, key: string) => number,
) {
  const quests = structuredClone(plan.quests);
  for (const quest of Object.values(quests)) {
    for (const { condition: c } of quest.objectives)
      if ('locationId' in c) c.locationId = resolve(c.locationId);
    for (const access of quest.reward.access) {
      access.from = resolve(access.from);
      access.to = resolve(access.to);
    }
  }
  scene.quests = quests;
  const facts: { fact: string; locationId: string }[] = [];
  const reputation = [] as ReturnType<typeof applyFactionEffects>;
  const dutch = context.config.language === 'Nederlands';
  const currencyName = scene.currencyName ?? (dutch ? 'valuta' : 'currency');
  for (const claim of plan.claims) {
    const quest = quests[claim.questId];
    const locationId = resolve(claim.locationId);
    const place = placeScene(scene, locationId);
    for (const delivery of claim.deliveries)
      removeItem(members.find((m) => m.id === delivery.memberId)!.state, delivery.itemId, delivery.quantity);
    const items: string[] = [];
    const key = questKey(quest.id);
    if (quest.reward.currency) {
      offerGroundItem(place, {
        ...baseItem(`${key}:currency`, currencyName, 'tool'),
        currencyValue: quest.reward.currency,
        description: dutch
          ? `${quest.reward.currency} ${currencyName} voor ${quest.name}.`
          : `${quest.reward.currency} ${currencyName} for ${quest.name}.`,
      });
      items.push(`${quest.reward.currency} ${currencyName}`);
    }
    quest.reward.items.forEach((blueprint, index) => {
      let roll = 0;
      const item = randomLoot(
        `${key}:item:${index}`,
        Math.max(1, ...members.map((m) => m.state.level)),
        (sides) => draw(sides, `${key}:item:${index}:${roll++}`),
        blueprint,
      );
      offerGroundItem(place, item);
      items.push(item.name);
    });
    savePlace(scene, place);
    for (const access of quest.reward.access) {
      const edge = scene.worldMap!.connections.find(
        (e) =>
          (e.from === access.from && e.to === access.to) ||
          (e.bidirectional && e.from === access.to && e.to === access.from),
      )!;
      edge.blocked = false;
      facts.push({
        locationId,
        fact: dutch
          ? `${quest.name}: ${edge.label} is nu toegankelijk.`
          : `${quest.name}: ${edge.label} is now accessible.`,
      });
    }
    if (quest.reward.faction && context.factions) {
      const effects = members
        .filter(
          (m) =>
            m.active &&
            m.state.hp > 0 &&
            m.state.factionInitialized &&
            !m.state.factionAchievements?.[quest.reward.faction!.factionId]?.includes(key),
        )
        .map((m) => ({
          type: 'reputation' as const,
          factionId: quest.reward.faction!.factionId,
          memberId: m.id,
          characterId: m.characterId,
          eventId: claim.eventId,
          amount: quest.reward.faction!.reputation,
          reason: quest.name,
          awareness: 'The faction’s representative accepted the group’s completed request.',
          achievementKey: key,
        }));
      reputation.push(
        ...applyFactionEffects(
          context.factions,
          members,
          { ...value, factionEffects: effects },
          context.turn.number,
        ),
      );
    }
    facts.push({
      locationId,
      fact: dutch
        ? `${quest.name} is ingeleverd. ${quest.reward.description}${items.length ? ` ${items.join(', ')} ligt bij ${place.location.name}, beschikbaar om op te pakken.` : ''}`
        : `${quest.name} has been turned in. ${quest.reward.description}${items.length ? ` ${items.join(', ')} is available to collect at ${place.location.name}.` : ''}`,
    });
  }
  return { facts, reputation };
}
