import { environmentalActionSchema, type EnvironmentalAction } from '../shared/schema';
import type { GMContext } from './game';
import { createHash } from 'node:crypto';
import { findNPC, npcPublicFact } from '../shared/npcs';
import { featurePublicFact } from '../shared/scene-state';

/** Stable public references ground proposals without a catalog of environmental weapons. */
export function environmentalFacts(context: Pick<GMContext, 'journal' | 'scene'>) {
  const here = context.scene.location.name.toLowerCase();
  const elsewhere = Object.values(context.scene.places ?? {}).map((place) =>
    place.location.name.toLowerCase(),
  );
  const localJournal = context.journal.filter((entry) =>
    entry.kind === 'npc' && findNPC(context.scene, entry.name)
      ? findNPC(context.scene, entry.name)!.locationId === context.scene.location.id
      : entry.kind === 'location'
        ? entry.name.toLowerCase() === here
        : entry.detail.toLowerCase().includes(here) ||
          !elsewhere.some((name) => entry.detail.toLowerCase().includes(name)),
  );
  // ponytail: one source per fact; split facts if distinct objects need separate readiness.
  return Object.fromEntries(
    [
      [`scene:${context.scene.location.name}:atmosphere`, context.scene.location.atmosphere],
      [`scene:${context.scene.location.name}:hazard`, context.scene.location.hazard],
      ...localJournal.map((entry) => [`journal:${entry.kind}:${entry.name}`, entry.detail]),
      ...Object.values(context.scene.npcs ?? {})
        .filter((npc) => npc.locationId === context.scene.location.id)
        .map((npc) => [`npc:${npc.id}`, npcPublicFact(npc)]),
      ...Object.values(context.scene.features ?? {})
        .filter((feature) => feature.locationId === context.scene.location.id)
        .map((feature) => [`feature:${feature.id}`, featurePublicFact(feature, context.scene)]),
    ].filter(([, fact]) => fact.trim()),
  );
}

/** Reuse saved profiles; a model cannot silently upgrade an already known source. */
export function validateEnvironmentalAction(
  context: Pick<GMContext, 'journal' | 'scene'>,
  input: unknown,
): EnvironmentalAction {
  const proposed = environmentalActionSchema.parse(input);
  const saved = context.scene.environment?.sources[proposed.sourceId];
  if (
    !saved &&
    Object.values(context.scene.places ?? {}).some((place) => place.environment?.sources[proposed.sourceId])
  )
    throw new Error('That environmental source is at another location.');
  const profile = saved
    ? {
        ...saved.profile,
        operation: proposed.operation,
        reloadSourceId: proposed.reloadSourceId,
        reloadEvidence: proposed.reloadEvidence,
      }
    : proposed;
  const facts = environmentalFacts(context);
  if (!saved && !facts[profile.sourceId]?.includes(profile.evidence))
    throw new Error('The environmental source must cite an established scene or journal fact.');
  if (
    profile.operation === 'reload' &&
    (profile.consumption !== 'reload' ||
      !profile.reloadSourceId ||
      !profile.reloadEvidence ||
      profile.reloadSourceId === profile.sourceId ||
      !facts[profile.reloadSourceId]?.includes(profile.reloadEvidence))
  )
    throw new Error('Reloading needs a separate established supply of ammunition.');
  if (profile.operation === 'reload')
    profile.reloadResourceKey = `${profile.reloadSourceId}:${createHash('sha256').update(facts[profile.reloadSourceId!]).digest('hex')}`;
  else delete profile.reloadResourceKey;
  if (profile.operation === 'attack' && (profile.reloadSourceId || profile.reloadEvidence))
    throw new Error('An attack cannot reload or claim extra ammunition in the same main action.');
  return profile;
}
