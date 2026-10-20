import {
  clampReputation,
  factionWorldSchema,
  publicFactions,
  type FactionWorld,
  type FactionConnection,
  type ConnectionCandidate,
  type ReputationReceipt,
} from '../shared/factions';
import type { Member, Outcome } from '../shared/schema';
import type { TurnAdjudication } from '../shared/turn-resolution';
import type { GMContext } from './game';

/** A deterministic example for the labelled practice table and model schema contract. */
export function factionExample(
  ids: string[],
  setting: string,
  journal: Outcome['journal'],
  number: number,
): FactionWorld {
  const established = journal.filter((entry) => entry.kind === 'faction');
  return {
    version: 1,
    factions: ids.map((id, index) => ({
      id,
      name: established[index]?.name ?? `Practice faction ${index + 1}`,
      identity:
        ['Custodians of local order', 'Independent traders', 'Seekers of forbidden knowledge'][index % 3] +
        ` (${index + 1})`,
      goal:
        ['Protect established authority', 'Open a contested trade route', 'Recover a disputed discovery'][
          index % 3
        ] + ` in ${setting} (${index + 1})`,
      methods: ['Patrols and negotiation', 'Bargains and contacts', 'Research and secrecy'][index % 3],
      resources: ['Local sentries', 'Caravans and supplies', 'Archives and informants'][index % 3],
      privateAgenda: `Secure influence over the central conflict in ${setting}.`,
      hook: `A representative needs help with a disputed objective in ${setting}.`,
      activity: `Preparing an initiative in ${setting}.`,
      activityTurn: number,
      discoveredTurn: established[index] ? number : null,
      knownDescription: established[index]?.detail ?? '',
    })),
    relations: [
      { from: ids[0], to: ids[1], kind: 'conflict', reason: 'Disagree over control of access and supplies.' },
      { from: ids[1], to: ids[2], kind: 'overlap', reason: 'Both need access to the disputed site.' },
    ],
  };
}

export function validateGeneratedWorld(input: unknown, expected: FactionWorld): FactionWorld {
  const world = factionWorldSchema.parse(input);
  if (
    world.factions.length < expected.factions.length ||
    expected.factions.some((faction, index) => faction.id !== world.factions[index].id)
  )
    throw new Error('Preserve supplied faction IDs and order.');
  for (const [index, previous] of expected.factions.entries()) {
    const faction = world.factions[index];
    if (
      faction.discoveredTurn !== previous.discoveredTurn ||
      faction.knownDescription !== previous.knownDescription ||
      faction.activityTurn !== previous.activityTurn ||
      (previous.discoveredTurn !== null && faction.name !== previous.name)
    )
      throw new Error(
        'Preserve established faction names and public facts; new factions remain undiscovered.',
      );
  }
  for (const faction of world.factions.slice(expected.factions.length))
    if (
      faction.discoveredTurn !== null ||
      faction.knownDescription !== '' ||
      faction.activityTurn !== expected.factions[0].activityTurn
    )
      throw new Error(
        'Additional initial factions must remain undiscovered and use the supplied activityTurn.',
      );
  return world;
}

export function validateConnections(
  connections: FactionConnection[],
  context: GMContext,
  candidates: ConnectionCandidate[],
) {
  const seen = new Set<string>();
  for (const connection of connections) {
    const candidate = candidates.find(
      (candidate) =>
        candidate.memberId === connection.memberId && candidate.characterId === connection.characterId,
    );
    const member = context.members.find((member) => member.id === connection.memberId);
    if (
      !candidate ||
      !member ||
      !context.factions?.factions.some((faction) => faction.id === connection.factionId) ||
      seen.has(connection.memberId)
    )
      throw new Error('Connections require a unique eligible character and existing faction.');
    if (connection.source === 'generated' && (!candidate.generated || connection.score !== 2))
      throw new Error('A generated connection requires a successful saved roll and starts at +2.');
    if (connection.source === 'explicit') {
      const faction = context.factions!.factions.find((faction) => faction.id === connection.factionId)!;
      if (
        !`${member.character.concept} ${member.character.background}`
          .toLowerCase()
          .includes(faction.name.toLowerCase())
      )
        throw new Error(
          'An explicit connection must name the faction in the supplied background or concept.',
        );
    }
    seen.add(connection.memberId);
  }
  return connections;
}

export function publicMember(member: Member, world?: FactionWorld): Member {
  const known = new Set(publicFactions(world).map((faction) => faction.id));
  const {
    factionAchievements: _achievements,
    factionInitialized: _initialized,
    factionReputation,
    factionAffiliation,
    ...state
  } = member.state;
  return {
    ...member,
    state: {
      ...state,
      ...(factionReputation
        ? {
            factionReputation: Object.fromEntries(
              Object.entries(factionReputation).filter(([id]) => known.has(id)),
            ),
          }
        : {}),
      ...(factionAffiliation && known.has(factionAffiliation.factionId) ? { factionAffiliation } : {}),
    },
  };
}

export function assertPublicFactionText(
  world: FactionWorld | undefined,
  text: string,
  discovered = new Set<string>(),
) {
  if (
    world?.factions.some(
      (faction) =>
        faction.discoveredTurn === null &&
        !discovered.has(faction.id) &&
        (text.toLowerCase().includes(faction.name.toLowerCase()) ||
          text.toLowerCase().includes(faction.id.toLowerCase())),
    )
  )
    throw new Error('Public facts mention an undiscovered faction. Establish a discovery first.');
}

export function validateFactionEffects(context: GMContext, value: TurnAdjudication) {
  const effects = value.factionEffects ?? [];
  const world = context.factions;
  const seen = new Set<string>();
  for (const effect of effects) {
    const faction = world?.factions.find((faction) => faction.id === effect.factionId);
    const event = value.events.find((event) => event.id === effect.eventId);
    if (!faction || !event || event.result === 'blocked' || event.presentation === 'log')
      throw new Error('Faction effects require an existing faction and a resolved story consequence.');
    const key = `${effect.type}:${effect.factionId}:${'memberId' in effect ? effect.memberId : ''}`;
    if (seen.has(key))
      throw new Error('Combine faction effects once per faction, character and type per turn.');
    seen.add(key);
    if ('memberId' in effect) {
      const member = context.members.find(
        (member) => member.id === effect.memberId && member.characterId === effect.characterId,
      );
      if (!member || !member.state.factionInitialized)
        throw new Error('Faction effects require the initialized frozen character.');
      if (
        (event.memberId && event.memberId !== member.id) ||
        (!event.memberId && !event.fact.toLowerCase().includes(member.character.name.toLowerCase()))
      )
        throw new Error('Attribute faction consequences to their responsible character.');
      if (
        effect.type === 'reputation' &&
        member.state.factionAchievements?.[effect.factionId]?.includes(effect.achievementKey)
      )
        throw new Error('This faction achievement has already changed this character’s reputation.');
      if (
        effect.type === 'affiliation' &&
        effect.kind === null &&
        member.state.factionAffiliation?.factionId !== effect.factionId
      )
        throw new Error('Only an existing connection to this faction can be removed.');
    }
    if (effect.type === 'discover' && !event.fact.toLowerCase().includes(faction.name.toLowerCase()))
      throw new Error('Discovery requires a story event identifying the faction by name.');
  }
  const discovered = new Set(
    effects.filter((effect) => effect.type === 'discover').map((effect) => effect.factionId),
  );
  const isKnown = (factionId: string) =>
    discovered.has(factionId) ||
    world?.factions.some((faction) => faction.id === factionId && faction.discoveredTurn !== null);
  for (const effect of effects)
    if (effect.type === 'affiliation' && !isKnown(effect.factionId))
      throw new Error('Affiliation changes require a discovered faction.');
  const publicEffectFacts = effects.flatMap((effect) =>
    effect.type === 'discover'
      ? [effect.knownDescription]
      : (effect.type === 'reputation' || effect.type === 'affiliation') && isKnown(effect.factionId)
        ? [effect.reason]
        : [],
  );
  assertPublicFactionText(
    world,
    JSON.stringify({
      scene: context.scene,
      factionFacts: publicEffectFacts,
      events: value.events,
      actions: value.actions,
      journal: value.journal,
      npcUpdates: value.npcUpdates,
      featureUpdates: value.featureUpdates,
      location: value.location,
      placeUpdates: value.placeUpdates,
      mapUpdates: value.mapUpdates,
      rewards: value.rewards,
    }),
    discovered,
  );
  for (const entry of value.journal.filter((entry) => entry.kind === 'faction'))
    if (
      world &&
      !world.factions.some(
        (faction) =>
          faction.name === entry.name && (faction.discoveredTurn !== null || discovered.has(faction.id)),
      )
    )
      throw new Error('Faction journal entries require a discovery in the saved registry.');
    else if (world) {
      const faction = world.factions.find((faction) => faction.name === entry.name)!;
      const update = effects.find((effect) => effect.type === 'discover' && effect.factionId === faction.id);
      if (
        entry.detail !== faction.knownDescription &&
        !(update?.type === 'discover' && entry.detail === update.knownDescription)
      )
        throw new Error('Record updated public faction facts with a discovery effect.');
    }
}

export function applyFactionEffects(
  world: FactionWorld,
  members: Member[],
  value: TurnAdjudication,
  turn: number,
): ReputationReceipt[] {
  const receipts: ReputationReceipt[] = [];
  for (const effect of value.factionEffects ?? []) {
    const faction = world.factions.find((faction) => faction.id === effect.factionId)!;
    if (effect.type === 'discover') {
      faction.discoveredTurn ??= turn;
      faction.knownDescription = effect.knownDescription;
    } else if (effect.type === 'activity') {
      faction.activity = effect.activity;
      faction.activityTurn = turn;
    } else {
      const member = members.find(
        (member) => member.id === effect.memberId && member.characterId === effect.characterId,
      )!;
      if (effect.type === 'affiliation') {
        member.state.factionAffiliation = effect.kind
          ? { factionId: faction.id, kind: effect.kind, reason: effect.reason }
          : null;
      } else {
        const scores = (member.state.factionReputation ??= {});
        const before = scores[faction.id] ?? 0;
        const after = (scores[faction.id] = clampReputation(before + effect.amount));
        ((member.state.factionAchievements ??= {})[faction.id] ??= []).push(effect.achievementKey);
        receipts.push({
          factionId: faction.id,
          memberId: member.id,
          characterId: member.characterId,
          characterName: member.character.name,
          before,
          after,
          amount: after - before,
          reason: effect.reason,
        });
      }
    }
  }
  return receipts;
}
