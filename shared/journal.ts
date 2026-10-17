import type { Member, Outcome, Scene, CampaignConfig } from './schema';

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
