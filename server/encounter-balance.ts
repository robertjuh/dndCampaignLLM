import type { GMContext } from './game';
import type { Enemy } from '../shared/schema';
import { memberScene } from '../shared/locations';
import { incapacitatingCondition } from '../shared/rules';

const tiers = {
  minor: { threat: 1, hp: 6, hpPerLevel: 3, defense: 10, attack: 0, damage: '1d4' },
  normal: { threat: 2, hp: 12, hpPerLevel: 4, defense: 11, attack: 1, damage: '1d6' },
  elite: { threat: 4, hp: 24, hpPerLevel: 6, defense: 12, attack: 2, damage: '1d8' },
  boss: { threat: 8, hp: 40, hpPerLevel: 10, defense: 13, attack: 3, damage: '2d6' },
} as const;
const dice = ['1d4', '1d6', '1d8', '1d10', '1d12', '2d6', '2d8', '2d10', '2d12', '3d12', '4d12'];
const average = (notation: string) => {
  const [count, sides] = notation.split('d').map(Number);
  return (count * (sides + 1)) / 2;
};

/** Local characters determine level; encounters may deliberately outnumber and outmatch them. */
export function randomEncounterBalance(context: GMContext, locationId: string, memberIds?: string[]) {
  const members = context.members.filter(
    (member) =>
      member.active &&
      member.state.hp > 0 &&
      !incapacitatingCondition(member.state) &&
      !member.state.conditions.includes('Escaped') &&
      (memberIds
        ? memberIds.includes(member.id)
        : memberScene(context.scene, member.id).location.id === locationId),
  );
  const level = Math.max(
    1,
    Math.floor(members.reduce((sum, member) => sum + member.state.level, 0) / Math.max(1, members.length)),
  );
  const step = Math.floor((level - 1) / 2);
  return {
    memberIds: members.map((member) => member.id),
    level,
    maxEnemies: 4,
    threatBudget: members.length ? Math.max(8, members.length * 2) : 0,
    tiers: Object.fromEntries(
      Object.entries(tiers).map(([tier, base]) => {
        const damage = dice.filter((notation) => average(notation) <= average(base.damage) + step).at(-1)!;
        return [
          tier,
          {
            threat: base.threat,
            hp: Math.min(300, base.hp + base.hpPerLevel * (level - 1)),
            defense: Math.min(30, base.defense + step),
            attack: Math.min(15, base.attack + step),
            damage,
          },
        ];
      }),
    ) as Record<
      Enemy['tier'],
      { threat: number; hp: number; defense: number; attack: number; damage: string }
    >,
  };
}

/** Cap fresh random opponents once; established NPC mechanics and explicit story fights stay saved. */
export function boundRandomEnemy<T extends Pick<Enemy, 'tier' | 'hp' | 'defense' | 'attack' | 'damage'>>(
  enemy: T,
  balance: ReturnType<typeof randomEncounterBalance>,
) {
  const limit = balance.tiers[enemy.tier];
  return {
    ...enemy,
    hp: Math.min(enemy.hp, limit.hp),
    defense: Math.min(enemy.defense, limit.defense),
    attack: Math.min(enemy.attack, limit.attack),
    damage: average(enemy.damage) > average(limit.damage) ? limit.damage : enemy.damage,
    ...(['minor', 'normal'].includes(enemy.tier) ? { onHitChance: 25, maxAilmentsPerHit: 1 } : {}),
  };
}

export function assertRandomEncounterBudget(
  enemies: Pick<Enemy, 'tier'>[],
  balance: ReturnType<typeof randomEncounterBalance>,
) {
  if (enemies.length > balance.maxEnemies)
    throw new Error(`Random encounters allow at most ${balance.maxEnemies} enemies. Use a smaller group.`);
  const threat = enemies.reduce((sum, enemy) => sum + balance.tiers[enemy.tier].threat, 0);
  if (!balance.threatBudget || threat > balance.threatBudget)
    throw new Error(
      `Random encounter exceeds the local threat budget (${threat}/${balance.threatBudget}). Use fewer or weaker opponents: minor=1, normal=2, elite=4, boss=8.`,
    );
}
