// Turn-based adaptations of the common PoE 2 ailments; existing save names stay valid.
export const ailments = [
  'Bleeding',
  'Burning',
  'Poisoned',
  'Stunned',
  'Weakened',
  'Chilled',
  'Frozen',
  'Shocked',
  'Electrocuted',
] as const;
export type Ailment = (typeof ailments)[number];
export const ailmentRules: Record<
  Ailment,
  { turns: number; damage: number; mechanic: string; remedy: string }
> = {
  Bleeding: {
    turns: 3,
    damage: 1,
    mechanic: 'Take 1 damage at the end of each turn; moving or fleeing adds 1 damage.',
    remedy: 'Apply pressure and bind the wound with suitable cloth or a bandage.',
  },
  Burning: {
    turns: 3,
    damage: 2,
    mechanic: 'Take 2 damage at the end of each turn.',
    remedy: 'Smother the flames with a suitable blanket, use water, or stop, drop and roll.',
  },
  Poisoned: {
    turns: 4,
    damage: 1,
    mechanic: 'Take 1 damage at the end of each turn.',
    remedy: 'Use an available antidote or a suitable cleansing treatment.',
  },
  Stunned: {
    turns: 1,
    damage: 0,
    mechanic: 'Lose your main action; your minor action remains available.',
    remedy: 'An ally can spend their action steadying and helping you regain focus.',
  },
  Weakened: {
    turns: 2,
    damage: 0,
    mechanic: '-2 to attack rolls, including weapon attacks and strike abilities. Damage is unchanged.',
    remedy: 'Spend your main action catching your breath and recovering your strength.',
  },
  Chilled: {
    turns: 2,
    damage: 0,
    mechanic: '-2 defense and -2 to DEX checks and fleeing; no off-hand minor attack.',
    remedy: 'Warm up with an available heat source, dry covering, or warming treatment.',
  },
  Frozen: {
    turns: 1,
    damage: 0,
    mechanic: 'Cannot take main or minor actions.',
    remedy: 'An ally must thaw you with safe warmth or an appropriate ability.',
  },
  Shocked: {
    turns: 3,
    damage: 0,
    mechanic: 'Take 1 extra damage whenever you take damage.',
    remedy: 'Spend your main action grounding yourself safely away from the electrical source.',
  },
  Electrocuted: {
    turns: 1,
    damage: 0,
    mechanic: 'Cannot take main or minor actions.',
    remedy: 'An ally must safely disconnect the electrical source and help you recover.',
  },
};
export const isAilment = (name: string): name is Ailment => Object.hasOwn(ailmentRules, name);
export const conditionDuration = (name: string) => (isAilment(name) ? ailmentRules[name].turns : 2);
export const conditionDescription = (name: string): string | undefined =>
  isAilment(name)
    ? `${ailmentRules[name].mechanic} Duration: ${ailmentRules[name].turns} turns, ticking at the end of every completed party turn, including the application turn. Remedy (main action): ${ailmentRules[name].remedy} A matching cure ability also removes it.`
    : undefined;
