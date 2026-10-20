import type { Member, Outcome, Scene, CampaignConfig } from './schema';
import { findNPC } from './npcs';
import { featureConnection, findSceneFeature } from './scene-state';

/** Discovery prose stays historical; present ownership is projected from authoritative state. */
export function projectJournal(
  entries: Outcome['journal'],
  scene: Scene,
  members: Member[],
  language: CampaignConfig['language'],
): Outcome['journal'] {
  const dutch = language === 'Nederlands';
  return entries.map((entry) => {
    if (!entry.itemId) {
      const { itemId: _itemId, itemStatus: _itemStatus, ...fact } = entry;
      entry = fact;
    }
    const { featureId: _featureId, featureStatus: _featureStatus, ...discovery } = entry;
    entry = discovery;
    if (entry.kind !== 'npc' && !entry.itemId) {
      const feature = findSceneFeature(scene, _featureId ?? entry.name);
      if (feature) {
        const connection = featureConnection(scene, feature.route);
        const fields = Object.entries(feature.properties)
          .filter(([key]) => !connection || key !== 'passable')
          .map(
            ([key, value]) =>
              `${key}: ${
                value === null
                  ? dutch
                    ? 'onbekend'
                    : 'unknown'
                  : typeof value === 'boolean'
                    ? value
                      ? dutch
                        ? 'ja'
                        : 'yes'
                      : dutch
                        ? 'nee'
                        : 'no'
                    : value
              }`,
          );
        if (connection)
          fields.push(
            dutch
              ? `doorgang: ${connection.blocked ? 'geblokkeerd' : 'open'}`
              : `passage: ${connection.blocked ? 'blocked' : 'open'}`,
          );
        entry = { ...entry, featureId: feature.id, featureStatus: fields.join(' · ') };
      }
    }
    if (entry.kind === 'npc') {
      const npc = findNPC(scene, entry.npcId ?? entry.name);
      if (npc) {
        const status = dutch
          ? { alive: 'In leven', withdrawn: 'Teruggetrokken', surrendered: 'Overgegeven', dead: 'Overleden' }[
              npc.status
            ]
          : { alive: 'Alive', withdrawn: 'Withdrawn', surrendered: 'Surrendered', dead: 'Dead' }[npc.status];
        const location =
          npc.locationId === scene.location.id
            ? scene.location.name
            : npc.locationId
              ? scene.worldMap?.nodes[npc.locationId]?.name
              : undefined;
        return {
          ...entry,
          npcId: npc.id,
          npcStatus: [
            status,
            location,
            npc.allegiance,
            npc.enemy ? `${npc.enemy.hp}/${npc.enemy.maxHp} HP` : null,
          ]
            .filter(Boolean)
            .join(' · '),
        };
      }
      const { npcId: _id, npcStatus: _status, ...fact } = entry;
      return fact;
    }
    if (!entry.itemId) {
      const { itemId: _itemId, itemStatus: _itemStatus, ...fact } = entry;
      return fact;
    }
    const holder = members.find((member) =>
      [...member.state.inventory, ...Object.values(member.state.equipment)].some(
        (item) => item?.id === entry.itemId,
      ),
    );
    const place = [scene, ...Object.values(scene.places ?? {})].find((place) =>
      place.loot.some((item) => item.id === entry.itemId),
    );
    const itemStatus = holder
      ? `${dutch ? 'In bezit van' : 'Carried by'} ${holder.character.name}.`
      : place
        ? `${dutch ? 'Ligt bij' : 'On the ground at'} ${place.location.name}.`
        : dutch
          ? 'Niet meer beschikbaar op de grond.'
          : 'No longer available on the ground.';
    return { ...entry, itemStatus };
  });
}
