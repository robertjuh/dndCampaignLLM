import { createHash } from 'node:crypto';
import type { GMContext } from './game';
import type { NPCState, Scene } from '../shared/schema';
import type { Investigation, InvestigationSource, InvestigationResult } from '../shared/investigation';
import { knownLocations, memberScene } from '../shared/locations';
import { bindNPCSource, knownNPCs } from './npcs';

export const investigationKey = (value: string) =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\s]+/gu, ' ')
    .trim();
const key = investigationKey;
export const investigationFact = (finding: InvestigationResult['finding']) =>
  key(finding.fact).includes(key(finding.lead)) ? finding.fact : `${finding.fact}\n${finding.lead}`;
/** Prose and durable records serve different purposes; do not narrate each record again. */
export function investigationNarration(finding: InvestigationResult['finding']) {
  if (finding.narrativeVersion === 1 || key(finding.text).includes(key(finding.lead))) return finding.text;
  // Saved receipts predating the complete-prose contract may not have narrated their lead.
  return `${finding.text}\n${finding.lead}`;
}
export const investigationAttemptKey = (hookId: string, answer: number, signature: string) =>
  createHash('sha256')
    .update(JSON.stringify([hookId, answer, signature]))
    .digest('hex');

/** Selected tool receipts have met these people; publication still owns the actual scene write. */
function investigationScene(context: GMContext): Scene {
  const scene = { ...context.scene, npcs: { ...knownNPCs(context.scene) } };
  for (const { source } of investigationResults(context)) {
    if (source.kind !== 'npc' || scene.npcs[source.id]) continue;
    const person = bindNPCSource(scene, source, source.locationId);
    scene.npcs[person.id] = person.npc;
  }
  return scene;
}

const npcDescription = (npc: NPCState) => {
  const prefix = `${npc.name}. `;
  return (npc.fact.startsWith(prefix) ? npc.fact.slice(prefix.length) : npc.fact).slice(0, 500);
};

/** The answer is public once, regardless of which actor, hook, or source supplies it again. */
export function knownInvestigationAnswer(context: GMContext, fact: string) {
  const answer = key(fact);
  if (!answer) return false;
  const contains = (text: string) => ` ${key(text)} `.includes(` ${answer} `);
  return !!(
    context.gmMemory?.some((note) =>
      note.revealed?.some((index) => key(note.discoveries[index] ?? '') === answer),
    ) ||
    context.journal.some((entry) => contains(entry.detail)) ||
    investigationResults(context).some((result) => result.success && key(result.finding.fact) === answer) ||
    [context.scene, ...Object.values(context.scene.places ?? {})].some((place) =>
      Object.values(place.searches ?? {}).some((search) =>
        [search, ...Object.values(search.attempts ?? {})].some(
          (attempt) => attempt.investigation?.success && contains(attempt.information),
        ),
      ),
    )
  );
}

/** A reachable tile does not relocate the saved person or object that a lead points to. */
export function validateInvestigationLeads(
  context: GMContext,
  request: Pick<Investigation, 'success' | 'failure'>,
  source: InvestigationSource,
) {
  const sources = investigationSources(context);
  for (const branch of [request.success, request.failure]) {
    const at = branch.lead.locationId === 'current' ? source.locationId : branch.lead.locationId;
    if (
      at !== source.locationId &&
      !at.startsWith('new:') &&
      !context.scene.worldMap?.connections.some(
        (edge) =>
          !edge.blocked &&
          ((edge.from === source.locationId && edge.to === at) ||
            (edge.bidirectional && edge.to === source.locationId && edge.from === at)),
      )
    )
      throw new Error('An investigation lead must be here or reachable by one open adjacent route.');
    if (!branch.lead.source) continue;
    const ref = branch.lead.source;
    const id = ref.kind === 'place' && ref.id === 'current' ? source.locationId : ref.id;
    const found = sources.find((candidate) => candidate.kind === ref.kind && candidate.id === id) ??
      (source.kind === ref.kind && source.id === id ? source : undefined);
    if (!found)
      throw new Error('An investigation lead source must reference a saved person, object, or place.');
    if (found.locationId !== at)
      throw new Error(`${found.name} is at another location; use its actual location for the lead.`);
  }
}

/** All references use the same canonical IDs before a check and when a scene is compiled. */
export function investigationSources(context: GMContext) {
  const sources: (InvestigationSource & { name: string; value: unknown })[] = [];
  for (const [id, name] of Object.entries(knownLocations(context.scene)))
    sources.push({ kind: 'place', id, name, locationId: id, value: { name } });
  for (const feature of Object.values(context.scene.features ?? {}))
    sources.push({
      kind: 'feature',
      id: feature.id,
      name: feature.name,
      aliases: feature.aliases,
      locationId: feature.locationId,
      description: feature.fact.slice(0, 500),
      value: { id: feature.id, properties: feature.properties, fact: feature.fact },
    });
  for (const npc of Object.values(knownNPCs(investigationScene(context))))
    if (npc.locationId)
      sources.push({
        kind: 'npc',
        id: npc.id,
        name: npc.name,
        aliases: npc.aliases,
        locationId: npc.locationId,
        description: npcDescription(npc),
        value: npc,
      });
  for (const member of context.members)
    for (const item of [
      ...member.state.inventory,
      ...Object.values(member.state.equipment).filter((item) => item != null),
    ])
      sources.push({
        kind: 'item',
        id: item.id,
        name: item.name,
        locationId: memberScene(context.scene, member.id).location.id!,
        description: item.description.slice(0, 500),
        value: item,
      });
  for (const place of [context.scene, ...Object.values(context.scene.places ?? {})])
    for (const item of place.loot)
      sources.push({
        kind: 'item',
        id: item.id,
        name: item.name,
        locationId: place.location.id!,
        description: item.description.slice(0, 500),
        value: item,
      });
  return sources;
}

export function bindInvestigationSource(context: GMContext, memberId: string, input: InvestigationSource) {
  const origin = memberScene(context.scene, memberId).location.id!;
  let source = {
    ...input,
    id: input.id === 'current' ? origin : input.id,
    locationId: input.locationId === 'current' ? origin : input.locationId,
  };
  if (
    source.locationId !== origin &&
    !source.locationId.startsWith('new:') &&
    !context.scene.worldMap?.connections.some(
      (edge) =>
        !edge.blocked &&
        ((edge.from === origin && edge.to === source.locationId) ||
          (edge.bidirectional && edge.to === origin && edge.from === source.locationId)),
    )
  )
    throw new Error('The investigation source must be here or at the destination of one open adjacent move.');
  const person =
    source.kind === 'npc' ? bindNPCSource(investigationScene(context), source, source.locationId) : undefined;
  if (person)
    source = {
      ...source,
      id: person.id,
      name: person.name,
      description: person.isNew ? source.description : npcDescription(person.npc),
      aliases: person.aliases,
    };
  const sources = investigationSources(context);
  const found = sources.find((candidate) => candidate.kind === source.kind && candidate.id === source.id);
  if (found && found.locationId !== source.locationId)
    throw new Error(`${found.name} is at another location; use its actual owner/location.`);
  if (
    !found &&
    !(source.kind === 'feature' && source.id.startsWith('new:') && source.name && source.description) &&
    !person &&
    !(
      source.kind === 'place' &&
      source.id === source.locationId &&
      source.id.startsWith('new:') &&
      source.name
    )
  )
    throw new Error(
      'Use a saved source ID, or declare a visible new: feature with its name and description.',
    );
  const names = (candidate: InvestigationSource & { name: string }) => {
    const aliases = [candidate.name, ...(candidate.aliases ?? [])].map(key);
    if (candidate.kind === 'feature' || candidate.kind === 'item') {
      const words = key(candidate.name).split(' ');
      if (words.length > 2) aliases.push(words.slice(-2).join(' '));
    }
    return aliases;
  };
  if (
    !found &&
    sources.some(
      (candidate) =>
        candidate.kind !== 'place' &&
        names(candidate).some(
          (name) =>
            name === key(source.name ?? '') || (source.aliases ?? []).some((alias) => key(alias) === name),
        ),
    )
  )
    throw new Error('That object or person already exists. Use its saved ID instead of recreating it.');
  const action = context.turn.actions.find((action) => action.memberId === memberId);
  const submitted = ` ${key(action?.text ?? '')} `;
  const named = sources.filter(
    (candidate) =>
      candidate.kind !== 'place' &&
      names(candidate).some((name) => name.length > 3 && submitted.includes(` ${name} `)),
  );
  if (
    named.length &&
    !named.some((candidate) => candidate.kind === source.kind && candidate.id === source.id)
  )
    throw new Error(`Preserve the submitted target: ${named.map((candidate) => candidate.name).join(', ')}.`);
  const bound = found ?? {
    ...source,
    name: source.name!,
    value: person
      ? person.npc
      : source.kind === 'place'
        ? { name: source.name }
        : { id: source.id, properties: {}, fact: `${source.name}. ${source.description}` },
  };
  const { value, ...canonical } = bound;
  // Recording an interview changes public memory, not the witness's evidence.
  // New prepared answers have their own attempt key; actual NPC state changes
  // still invalidate the source signature.
  const signatureValue = person ? {
    id: person.npc.id,
    locationId: person.npc.locationId,
    status: person.npc.status,
    allegiance: person.npc.allegiance,
    factionId: person.npc.factionId,
    followingMemberId: person.npc.followingMemberId,
    enemy: person.npc.enemy,
  } : value;
  return {
    source: canonical,
    signature: createHash('sha256').update(JSON.stringify(signatureValue)).digest('hex'),
    introduced: !found,
  };
}

export function investigationResults(context: GMContext): InvestigationResult[] {
  return Object.entries(context.receipts ?? {})
    .filter(([key]) => key.startsWith('investigation:'))
    .map(([, value]) => value as InvestigationResult);
}
