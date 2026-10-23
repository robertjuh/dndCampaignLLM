import { isDeepStrictEqual } from 'node:util';
import type { GMContext, CombatReceipt } from './game';
import { enemySchema, npcReactionSchema, type NPCReaction } from '../shared/schema';
import { knownNPCs, npcIdentity, persistentEnemy } from './npcs';
import { npcNameKey } from '../shared/npcs';
import { environmentalFacts } from './environment';
import { combatActive, placeScene } from '../shared/locations';
import { assertCombatClaims } from '../shared/turn-resolution';

export type NPCReactionReceipt = { reactions: NPCReaction[] };
const same = (a: string, b: string) =>
  a.normalize('NFKC').toLowerCase() === b.normalize('NFKC').toLowerCase();

/** Only already visited neighbours reachable over an open directed route may supply NPCs. */
export function nearbyNPCFacts(context: GMContext) {
  const here = context.scene.location.id!;
  const neighbours = new Set(
    (context.scene.worldMap?.connections ?? []).flatMap((edge) =>
      edge.blocked
        ? []
        : edge.to === here
          ? [edge.from]
          : edge.bidirectional && edge.from === here
            ? [edge.to]
            : [],
    ),
  );
  return Object.fromEntries(
    [...neighbours]
      .filter((id) => context.scene.places?.[id] && context.scene.worldMap?.nodes[id]?.visited)
      .flatMap((id) =>
        Object.entries(
          environmentalFacts({
            ...context,
            scene: placeScene(context.scene, id),
          }),
        ).map(([source, fact]) => [`nearby:${id}:${source}`, { originLocationId: id, fact }]),
      ),
  );
}

/** A bounded checklist uses explicit public relationships, never inferred secret allegiances. */
export function npcReactionCandidates(context: GMContext) {
  if (!combatActive(context.scene)) return [];
  const npcs = knownNPCs(context.scene);
  const fighting = [context.scene, ...Object.values(context.scene.places ?? {})].flatMap((place) =>
    combatActive(place) ? place.encounter!.enemies.filter((enemy) => enemy.hp > 0 && !enemy.withdrawn) : [],
  );
  const allegiances = new Set(
    context.scene
      .encounter!.enemies.filter((enemy) => enemy.hp > 0 && !enemy.withdrawn)
      .flatMap((enemy) => (npcs[enemy.id]?.allegiance ? [npcNameKey(npcs[enemy.id].allegiance!)] : [])),
  );
  const here = context.scene.location.id!;
  const facts = environmentalFacts(context);
  const nearby = nearbyNPCFacts(context);
  // ponytail: the existing six-reaction budget bounds a round; expand only for larger encounter rules.
  return Object.values(npcs)
    .filter(
      (npc) =>
        npc.status === 'alive' &&
        npc.allegiance &&
        allegiances.has(npcNameKey(npc.allegiance)) &&
        !fighting.some((enemy) => enemy.id === npc.id),
    )
    .sort((a, b) => Number(b.locationId === here) - Number(a.locationId === here) || a.id.localeCompare(b.id))
    .flatMap((npc) => {
      const sourceId = npc.locationId === here ? `npc:${npc.id}` : `nearby:${npc.locationId}:npc:${npc.id}`;
      const fact = npc.locationId === here ? facts[sourceId] : nearby[sourceId]?.fact;
      return npc.locationId && fact
        ? [
            {
              npcId: npc.id,
              npcName: npc.name,
              originLocationId: npc.locationId,
              sourceId,
              evidence: fact.slice(0, 1500),
            },
          ]
        : [];
    })
    .slice(0, 6);
}

function unchangedReaction(
  context: GMContext,
  candidate: ReturnType<typeof npcReactionCandidates>[number],
): NPCReaction {
  return {
    ...candidate,
    enemy: null,
    reason:
      'Planning established no additional intervention; preserve the last observed position and mechanics.',
    fact:
      context.config.language === 'Nederlands'
        ? `${candidate.npcName} blijft op de laatst waargenomen plek.`
        : `${candidate.npcName} remains at the last observed position.`,
  };
}

/** Existing public facts ground awareness; the planner judges motives and feasible intervention. */
export function validateNPCReactions(
  context: GMContext,
  input: unknown,
  requireCoverage = false,
): NPCReaction[] {
  const here = context.scene.location.id!;
  const saved = (
    context.receipts?.npcReactionsByLocation as Record<string, NPCReactionReceipt> | undefined
  )?.[here];
  const reactions = npcReactionSchema
    .array()
    .max(6)
    .parse(input ?? saved?.reactions ?? []);
  if (saved) {
    if (!isDeepStrictEqual(reactions, saved.reactions)) throw new Error('Saved NPC reactions are immutable.');
    return reactions;
  }
  const missing = npcReactionCandidates(context).filter(
    (candidate) =>
      !reactions.some(
        (reaction) =>
          npcIdentity(context.scene, reaction.npcId, reaction.npcName)?.id === candidate.npcId ||
          reaction.npcId === candidate.npcId,
      ),
  );
  if (requireCoverage && missing.length)
    throw new Error(
      `Account for affected NPCs: ${missing.map((npc) => npc.npcName).join(', ')}. Dialogue or a grounded reason to stay out is valid with enemy:null.`,
    );
  if (!requireCoverage)
    reactions.push(
      ...missing
        .slice(0, Math.max(0, 6 - reactions.length))
        .map((candidate) => unchangedReaction(context, candidate)),
    );
  if (!reactions.length) return reactions;
  if (!combatActive(context.scene)) throw new Error('NPC combat reactions require an ongoing encounter.');
  const facts = environmentalFacts(context);
  const nearby = nearbyNPCFacts(context);
  const known = [context.scene, ...Object.values(context.scene.places ?? {})].flatMap((place) =>
    combatActive(place) ? place.encounter!.enemies : [],
  );
  const identities = new Set<string>();
  for (const reaction of reactions) {
    const proposedName = reaction.npcName;
    const origin = reaction.originLocationId === 'current' ? here : reaction.originLocationId;
    const npc = npcIdentity(context.scene, reaction.npcId, reaction.npcName);
    if (npc && (npc.status === 'dead' || npc.locationId !== origin))
      throw new Error('A reacting NPC must be alive at their saved location.');
    if (
      reaction.enemy &&
      (reaction.enemy.id !== reaction.npcId || !same(reaction.enemy.name, reaction.npcName))
    )
      throw new Error('A joining enemy must preserve the reacting NPC identity.');
    if (npc) {
      reaction.npcId = npc.id;
      reaction.npcName = npc.name;
      if (reaction.enemy)
        reaction.enemy = enemySchema.strip().parse(persistentEnemy(context, reaction.enemy, origin));
    }
    if (
      origin !== here &&
      (!context.scene.worldMap?.nodes[origin]?.visited ||
        !context.scene.worldMap?.connections.some(
          (edge) =>
            !edge.blocked &&
            ((edge.from === origin && edge.to === here) ||
              (edge.bidirectional && edge.to === origin && edge.from === here)),
        ))
    )
      throw new Error(
        'NPC reactions need a local or openly adjacent origin, not a distant or unvisited place.',
      );
    const source =
      origin === here
        ? facts[reaction.sourceId]
        : nearby[reaction.sourceId]?.originLocationId === origin
          ? nearby[reaction.sourceId].fact
          : undefined;
    const current = context.journal.find(
      (entry) => entry.kind === 'npc' && same(entry.name, reaction.npcName),
    );
    const canonical =
      (npc && reaction.sourceId.endsWith(`npc:${npc.id}`)) ||
      (current && reaction.sourceId.endsWith(`journal:npc:${current.name}`));
    if (current && !canonical)
      throw new Error('Use the current NPC journal decision, not an earlier description of that NPC.');
    if (
      !source?.includes(reaction.evidence) ||
      (!canonical && !reaction.evidence.toLowerCase().includes(proposedName.toLowerCase()))
    )
      throw new Error('NPC reactions must cite public local evidence naming that NPC.');
    if (
      identities.has(reaction.npcId) ||
      reactions.filter((other) => same(other.npcName, reaction.npcName)).length > 1
    )
      throw new Error('An NPC reacts only once per combat round.');
    identities.add(reaction.npcId);
    if (
      context.members.some(
        (member) => member.id === reaction.npcId || same(member.character.name, reaction.npcName),
      ) ||
      known.some((enemy) => enemy.id === reaction.npcId || same(enemy.name, reaction.npcName))
    )
      throw new Error(
        'Use existing combat actors; NPC reactions cannot duplicate, resurrect or relocate a saved enemy.',
      );
    if (
      reaction.enemy &&
      (reaction.enemy.id !== reaction.npcId || !same(reaction.enemy.name, reaction.npcName))
    )
      throw new Error('A joining enemy must preserve the reacting NPC identity.');
  }
  if (
    (context.scene.encounter?.enemies.length ?? 0) + reactions.filter((reaction) => reaction.enemy).length >
    10
  )
    throw new Error('An encounter can contain at most ten enemies.');
  const encounter = context.scene.encounter!;
  assertCombatClaims(
    {
      [here]: {
        location: context.scene.location,
        encounter: {
          ...encounter,
          enemies: [
            ...encounter.enemies.map((enemy) => ({ ...enemy, withdrawn: !!enemy.withdrawn })),
            ...reactions.flatMap((reaction) =>
              reaction.enemy ? [{ ...reaction.enemy, maxHp: reaction.enemy.hp, withdrawn: false }] : [],
            ),
          ],
        },
      },
    },
    reactions.map((reaction) => ({ text: reaction.fact, locationId: here })),
  );
  return reactions;
}

/** Keep the latest public NPC decision in the existing journal, outside model output quotas. */
export function journalWithNPCReactions(
  journal: GMContext['journal'],
  receipts: Record<string, unknown>,
  previous: GMContext['journal'],
  language = 'English',
): GMContext['journal'] {
  const result = structuredClone(journal);
  for (const saved of Object.values(
    (receipts.npcReactionsByLocation ?? {}) as Record<string, NPCReactionReceipt>,
  ))
    for (const reaction of saved.reactions) {
      let entry = result.find((entry) => entry.kind === 'npc' && same(entry.name, reaction.npcName));
      if (!entry) {
        const old = previous.find((old) => old.kind === 'npc' && same(old.name, reaction.npcName));
        entry = {
          kind: 'npc',
          name: old?.name ?? reaction.npcName,
          detail: old?.detail ?? '',
        };
        result.push(entry);
      }
      if (!entry.detail.includes(reaction.fact)) {
        const detail = [entry.detail, reaction.fact].filter(Boolean).join('\n');
        entry.detail = detail.length <= 1500 ? detail : reaction.fact;
      }
    }
  for (const combat of Object.values((receipts.combatByLocation ?? {}) as Record<string, CombatReceipt>))
    for (const enemy of combat.encounter.enemies.filter((enemy) => enemy.hp === 0 || enemy.withdrawn)) {
      let entry = result.find((entry) => entry.kind === 'npc' && same(entry.name, enemy.name));
      const old = previous.find((entry) => entry.kind === 'npc' && same(entry.name, enemy.name));
      if (!entry && !old) continue;
      if (!entry) {
        entry = structuredClone(old!);
        result.push(entry);
      }
      const fact =
        language === 'Nederlands'
          ? `${enemy.name} ${enemy.hp === 0 ? 'is gestorven in het gevecht.' : 'heeft zich levend uit het gevecht teruggetrokken.'}`
          : `${enemy.name} ${enemy.hp === 0 ? 'died in the fight.' : 'withdrew alive from the fight.'}`;
      if (!entry.detail.includes(fact)) {
        const detail = `${entry.detail}\n${fact}`;
        entry.detail = detail.length <= 1500 ? detail : fact;
      }
    }
  return result;
}
