import type { Item } from './schema';

export const protectiveKinds = ['armour', 'helmet', 'boots', 'shield'] as const;
export const armourPerks = [
  'reinforced',
  'thorns',
  'bulwark',
  'vigilant',
  'escape-artist',
  'recuperating',
  'scrambler',
  'quickstep',
  'enduring',
  'rescuer',
  'restorative',
  'opening-strike',
  'retaliator',
  'opportunist',
  'last-stand',
  'fortified',
  'hardy',
] as const;
export type ArmourPerk = (typeof armourPerks)[number];
export const perkKinds: Record<ArmourPerk, readonly Item['kind'][]> = {
  reinforced: ['armour', 'helmet', 'shield'],
  thorns: ['armour', 'shield'],
  bulwark: ['armour', 'shield'],
  vigilant: ['helmet', 'boots'],
  'escape-artist': ['helmet', 'boots'],
  recuperating: ['armour', 'helmet', 'boots'],
  scrambler: ['boots', 'shield'],
  quickstep: ['helmet', 'boots'],
  enduring: protectiveKinds,
  rescuer: ['helmet', 'shield'],
  restorative: ['armour', 'helmet'],
  'opening-strike': ['helmet', 'boots'],
  retaliator: ['armour', 'shield'],
  opportunist: ['helmet', 'boots'],
  'last-stand': ['armour', 'shield'],
  fortified: ['armour', 'helmet', 'shield'],
  hardy: ['armour', 'helmet', 'boots'],
};

export const perkNames: Record<ArmourPerk, string> = {
  reinforced: 'Reinforced',
  thorns: 'Thorns',
  bulwark: 'Bulwark',
  vigilant: 'Vigilant',
  'escape-artist': 'Escape Artist',
  recuperating: 'Recuperating',
  scrambler: 'Scrambler',
  quickstep: 'Quickstep',
  enduring: 'Enduring',
  rescuer: 'Rescuer',
  restorative: 'Restorative',
  'opening-strike': 'Opening Strike',
  retaliator: 'Retaliator',
  opportunist: 'Opportunist',
  'last-stand': 'Last Stand',
  fortified: 'Fortified',
  hardy: 'Hardy',
};

export function perkAmount(item: Pick<Item, 'rarity' | 'perk'>) {
  const strength = { Common: 0, Uncommon: 1, Rare: 2, Cursed: 2, Legendary: 3 }[item.rarity];
  return strength * (item.perk === 'hardy' || item.perk === 'fortified' ? 2 : 1);
}

export function perkDescription(item: Pick<Item, 'rarity' | 'perk'>) {
  const n = perkAmount(item);
  const effects: Record<ArmourPerk, string> = {
    reinforced: `Reduce damage from the first enemy hit each round by ${n}, after shields and barriers, to a minimum of 0.`,
    thorns: `Once each round, after an enemy hit costs you HP, deal ${n} damage back to that enemy. Fully blocked hits do not trigger this.`,
    bulwark: `Your Defend action grants an extra +${n} Defense until your next turn.`,
    vigilant: `Gain +${n} initiative when combat starts.`,
    'escape-artist': `Gain +${n} to fleeing checks.`,
    recuperating: `Recover ${n} additional HP after a successful encounter.`,
    scrambler: `After a failed fleeing check, gain +${n} Defense until your next turn.`,
    quickstep: `After successfully taking a main action to move, gain +${n} Defense until your next turn.`,
    enduring: `Prevent up to ${n} total damage from ongoing ailments each turn, including Shocked's extra damage. Ailment durations and other effects remain.`,
    rescuer: `Your basic Help Up action restores ${n} additional HP to the Downed ally.`,
    restorative: `The first potion or healing ability that restores your HP each combat round restores ${n} additional HP.`,
    'opening-strike': `Gain +${n} to your first damaging attack roll each encounter. A miss spends this bonus; advantage uses it on both dice.`,
    retaliator: `After an enemy hit costs you HP, your next successful damaging attack deals +${n} damage. Further hits refresh this benefit without multiplying it.`,
    opportunist: `Once each round, deal +${n} damage when hitting an enemy already affected by an ailment.`,
    'last-stand': `Gain +${n} Defense while conscious and below half your maximum HP.`,
    fortified: `Prevent up to ${n} of the extra damage dice from enemy critical hits. The ordinary damage component remains.`,
    hardy: `Gain ${n} maximum HP while equipped. Equipping never heals you; removing it can clamp current HP.`,
  };
  return item.perk
    ? `${effects[item.perk]} Matching perks stack across up to 4 distinct equipped pieces; the strongest 4 count. A two-handed piece counts once. Backpack items grant no bonus.`
    : '';
}
