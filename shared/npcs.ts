import type { NPCState, Scene } from './schema';

export const npcNameKey = (name: string) => name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
export const npcNames = (npc: Pick<NPCState, 'name' | 'aliases'>) => [npc.name, ...npc.aliases];

/** Names are aliases; the saved ID remains the identity through renames and encounters. */
export function findNPC(scene: Pick<Scene, 'npcs'>, reference: string): NPCState | undefined {
  if (scene.npcs && Object.hasOwn(scene.npcs, reference)) return scene.npcs[reference];
  const matches = Object.values(scene.npcs ?? {}).filter((npc) =>
    npcNames(npc).some((name) => npcNameKey(name) === npcNameKey(reference)),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function npcPublicFact(npc: NPCState) {
  return `${npc.name}. Status: ${npc.status}. Location: ${npc.locationId ?? 'unknown'}.${
    npc.allegiance ? ` Allegiance: ${npc.allegiance}.` : ''
  } ${npc.fact}`.trim();
}
