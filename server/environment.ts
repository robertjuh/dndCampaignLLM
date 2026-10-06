import { environmentalActionSchema, type EnvironmentalAction } from '../shared/schema';
import type { GMContext } from './game';
import { createHash } from 'node:crypto';

/** Stable public references ground proposals without a catalog of environmental weapons. */
export function environmentalFacts(context: Pick<GMContext, 'journal' | 'scene'>) {
  // ponytail: one source per fact; split facts if distinct objects need separate readiness.
  return Object.fromEntries(
    [
      [`scene:${context.scene.location.name}:atmosphere`, context.scene.location.atmosphere],
      [`scene:${context.scene.location.name}:hazard`, context.scene.location.hazard],
      ...context.journal.map((entry) => [`journal:${entry.kind}:${entry.name}`, entry.detail]),
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
