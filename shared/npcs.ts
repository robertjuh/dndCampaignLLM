import type { NPCState, Scene } from './schema';

export const npcNameKey = (name: string) => name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
export const npcNames = (npc: Pick<NPCState, 'name' | 'aliases'>) => [npc.name, ...npc.aliases];

/** Keep existing combat labels stable and number duplicates without taking another enemy's name. */
export function ensureUniqueEnemyNames(enemies: { name: string }[]) {
  const reserved = new Set(enemies.map((enemy) => npcNameKey(enemy.name)));
  const used = new Set<string>();
  for (const enemy of enemies) {
    const base = enemy.name.trim();
    if (used.has(npcNameKey(enemy.name))) {
      let number = 2;
      do {
        const suffix = ` (${number++})`;
        enemy.name = `${base.slice(0, 100 - suffix.length)}${suffix}`;
      } while (reserved.has(npcNameKey(enemy.name)) || used.has(npcNameKey(enemy.name)));
    }
    used.add(npcNameKey(enemy.name));
  }
}

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
