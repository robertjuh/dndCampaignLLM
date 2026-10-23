import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import recorded from './fixtures/darknessworld-combat.json';
import {
  assertRandomEncounterBudget,
  boundRandomEnemy,
  randomEncounterBalance,
} from '../server/encounter-balance';
import type { GMContext } from '../server/game';
import { baseItem, initialScene, initialState, runCombat } from '../shared/rules';
import { ensureLocations } from '../shared/locations';
import {
  combatSchema,
  enemySchema,
  templateCharacter,
  type Enemy,
  type Member,
  type Encounter,
} from '../shared/schema';

function context(): GMContext {
  const character = templateCharacter('Katooluman');
  character.traits[0].stats = { STR: 0, DEX: 0, INT: 4, CHA: 0, CON: 2, WIS: -1 };
  character.abilities = [
    {
      name: 'Spiral-Script Strike',
      kind: 'combat',
      effect: 'strike',
      stat: 'INT',
      level: 1,
      dice: '1d12',
      inflicts: 'Burning',
      description: 'Burn a forbidden pattern into a threat.',
    },
    {
      name: 'Forbidden Field Dressing',
      kind: 'utility',
      effect: 'mend',
      stat: 'CON',
      level: 1,
      dice: '1d8',
      cures: ['Shocked'],
      description: 'Mend wounds with field knowledge.',
    },
  ];
  const id = randomUUID();
  const member: Member = {
    id,
    playerId: randomUUID(),
    characterId: randomUUID(),
    playerName: 'Player',
    character,
    state: initialState(character, id),
    active: true,
  };
  member.state.equipment.left = {
    ...baseItem('cudgel', 'Station-Iron Cudgel', 'weapon'),
    scaling: ['STR', 'CON'],
    damage: '1d6',
  };
  member.state.equipment.body = {
    ...baseItem('armour', 'Script armour', 'armour'),
    scaling: ['INT'],
    defense: 1,
  };
  member.state.equipment.boots = { ...baseItem('boots', 'Boots', 'boots'), defense: 1 };
  const scene = ensureLocations(initialScene('Outer Ward'), [id]);
  return { members: [member], scene, receipts: {} } as GMContext;
}
function enemy(context: GMContext, balanced: boolean): Enemy {
  const saved = structuredClone(recorded[0].encounter.enemies[0]) as Enemy;
  const proposed = enemySchema.strip().parse(saved);
  const stats = balanced
    ? boundRandomEnemy(proposed, randomEncounterBalance(context, context.scene.location.id!))
    : proposed;
  // Recorded event fixtures omit loot; restore the weapon that inflicted Burning in turn 25.
  const blade = {
    ...baseItem('wight-blade', "Wight's Hooked Blade", 'weapon'),
    rarity: 'Rare' as const,
    scaling: ['STR' as const, 'DEX' as const],
    damage: stats.damage,
    onHit: { ailment: 'Burning' as const, chance: 25 },
  };
  return { ...stats, maxHp: stats.hp, initiative: 1, equipment: [blade], conditions: [], conditionTurns: {} };
}
function round(
  actor: Member,
  target: Enemy,
  main: 'attack' | 'strike' | 'mend' | 'wait' | 'flee' = 'attack',
) {
  return combatSchema.parse({
    actions: [
      {
        memberId: actor.id,
        main: main === 'strike' || main === 'mend' ? 'ability' : main === 'wait' ? 'interact' : main,
        abilityName:
          main === 'strike' ? 'Spiral-Script Strike' : main === 'mend' ? 'Forbidden Field Dressing' : null,
        targetId: main === 'mend' || main === 'wait' || main === 'flee' ? null : target.id,
        weaponSlot: 'left',
        stat: main === 'mend' ? 'CON' : 'INT',
        description: 'Resolve the submitted action.',
        minor: 'none',
        minorItemId: null,
      },
    ],
    enemyTargets: [],
    loot: {
      name: 'Trophy',
      kind: 'tool',
      scaling: [],
      hands: 1,
      light: false,
      description: 'A plain token.',
    },
  });
}
function encounter(actor: Member, target: Enemy): Encounter {
  return {
    enemies: [target],
    round: 1,
    victory: false,
    escaped: false,
    initiative: [
      { id: actor.id, total: 20 },
      { id: target.id, total: 1 },
    ],
  };
}

it('uses only ready local characters for the random encounter budget and level', () => {
  const c = context();
  const at = c.scene.location.id!;
  const extra = (name: string) => ({
    ...structuredClone(c.members[0]),
    id: randomUUID(),
    character: { ...c.members[0].character, name },
  });
  const distant = extra('Distant veteran');
  distant.state.level = 20;
  const inactive = extra('Inactive veteran');
  inactive.state.level = 20;
  inactive.active = false;
  const downed = extra('Downed veteran');
  downed.state.hp = 0;
  const frozen = extra('Frozen veteran');
  frozen.state.conditions = ['Frozen'];
  c.members.push(distant, inactive, downed, frozen);
  c.scene.places!['other'] = {
    location: { id: 'other', name: 'Road', atmosphere: '', hazard: '' },
    loot: [],
    encounter: null,
  };
  c.scene.memberLocations = Object.fromEntries(
    c.members.map((member) => [member.id, member === distant ? 'other' : at]),
  );
  expect(randomEncounterBalance(c, at)).toMatchObject({
    memberIds: [c.members[0].id],
    level: 1,
    maxEnemies: 4,
    threatBudget: 8,
  });
  expect(randomEncounterBalance(c, 'new:room', [c.members[0].id])).toMatchObject({
    level: 1,
    maxEnemies: 4,
    threatBudget: 8,
  });
  const balance = randomEncounterBalance(c, at);
  expect(() => assertRandomEncounterBudget([{ tier: 'normal' }], balance)).not.toThrow();
  expect(() => assertRandomEncounterBudget([{ tier: 'minor' }, { tier: 'minor' }], balance)).not.toThrow();
  expect(() => assertRandomEncounterBudget([{ tier: 'elite' }, { tier: 'elite' }], balance)).not.toThrow();
  expect(() =>
    assertRandomEncounterBudget(
      Array.from({ length: 4 }, () => ({ tier: 'normal' as const })),
      balance,
    ),
  ).not.toThrow();
  expect(() =>
    assertRandomEncounterBudget(
      Array.from({ length: 5 }, () => ({ tier: 'minor' as const })),
      balance,
    ),
  ).toThrow('at most 4');
  expect(() => assertRandomEncounterBudget([{ tier: 'boss' }, { tier: 'boss' }], balance)).toThrow('16/8');
  c.members[0].state.level = 5;
  const veteran = randomEncounterBalance(c, at);
  expect(veteran.tiers.normal.hp).toBeGreaterThan(balance.tiers.normal.hp);
  expect(veteran.tiers.normal.attack).toBeGreaterThan(balance.tiers.normal.attack);
  c.members[0].state.hp = 0;
  expect(() => assertRandomEncounterBudget([{ tier: 'normal' }], randomEncounterBalance(c, at))).toThrow(
    '2/0',
  );
});

it('allows a solo character to retreat from four enemies without defeating them or gaining victory rewards', () => {
  const c = context();
  const actor = c.members[0];
  actor.state.abilityUses = { 'Spiral-Script Strike': 1 };
  const enemies = Array.from({ length: 4 }, (_, index) => ({
    ...enemy(c, true),
    id: `raider-${index}`,
    name: `Raider ${index + 1}`,
  }));
  const fight = encounter(actor, enemies[0]);
  fight.enemies = enemies;
  fight.initiative = [
    { id: enemies[0].id, total: 20 },
    { id: actor.id, total: 19 },
    ...enemies.slice(1).map((enemy) => ({ id: enemy.id, total: 1 })),
  ];
  const draw = vi.fn((sides: number, _label: string) =>
    sides === 20 ? 14 : sides === 100 ? 100 : Math.min(3, sides),
  );
  runCombat([actor], fight, round(actor, enemies[0]), draw);
  expect(actor.state.hp).toBe(6);
  expect(enemies.every((enemy) => enemy.hp > 0)).toBe(true);
  draw.mockClear();
  const logs = runCombat([actor], fight, round(actor, enemies[0], 'flee'), draw);
  expect(fight).toMatchObject({ escaped: true, victory: false });
  expect(actor.state.hp).toBe(2);
  expect(logs).toContain('The surviving party escapes. Combat ends.');
  expect(
    draw.mock.calls.filter(([, label]) => label.includes(`attacks ${actor.character.name}`)),
  ).toHaveLength(1);
  expect(enemies.every((enemy) => enemy.hp > 0)).toBe(true);
  expect(actor.state.xp).toBe(0);
  expect(actor.state.abilityUses['Spiral-Script Strike']).toBe(1);
});

it.each([
  [25, true, false],
  [26, false, true],
  [100, false, false],
])('limits ordinary enemy ailments on a hit (native chance roll=%i)', (chance, chilled, burning) => {
  const c = context();
  const actor = c.members[0];
  const target = enemy(c, true);
  const fight = encounter(actor, target);
  const logs = runCombat([actor], fight, round(actor, target, 'wait'), (sides, label) =>
    sides === 20
      ? 14
      : label.includes('Shadow Wight: Chilled chance')
        ? chance
        : label.includes('Burning chance')
          ? chance === 100
            ? 100
            : 1
          : 1,
  );
  expect(actor.state.conditions.includes('Chilled')).toBe(chilled);
  expect(actor.state.conditions.includes('Burning')).toBe(burning);
  expect(logs.filter((log) => /becomes (Chilled|Burning)/.test(log))).toHaveLength(
    chilled || burning ? 1 : 0,
  );
});

it('applies one innate ailment on a critical hit and preserves an old enemy’s saved hit mechanics', () => {
  for (const balanced of [false, true]) {
    const c = context();
    const actor = c.members[0];
    const target = enemy(c, balanced);
    const logs = runCombat([actor], encounter(actor, target), round(actor, target, 'wait'), (sides) =>
      sides === 20 ? 20 : 1,
    );
    expect(actor.state.conditions).toContain('Chilled');
    expect(actor.state.conditions.includes('Burning')).toBe(!balanced);
    expect(logs.filter((log) => /becomes (Chilled|Burning)/.test(log))).toHaveLength(balanced ? 1 : 2);
  }
});

it('lets one heal gain ground in the recorded Burning/Chilled damage spiral without curing either ailment', () => {
  for (const balanced of [false, true]) {
    const c = context();
    const actor = c.members[0];
    const target = enemy(c, balanced);
    actor.state.hp = 6;
    actor.state.conditions = ['Chilled', 'Burning'];
    actor.state.conditionTurns = { Chilled: 2, Burning: 2 };
    runCombat([actor], encounter(actor, target), round(actor, target, 'mend'), (sides) =>
      sides === 20 ? 14 : sides === 100 ? 100 : sides === 6 ? 3 : Math.min(sides, 4),
    );
    expect(actor.state.conditions).toContain('Burning');
    if (balanced) expect(actor.state.hp).toBeGreaterThan(6);
    else expect(actor.state.hp).toBeLessThan(6);
  }
});

it('improves solo combat over fixed dice sequences while retaining misses and lethal risk', () => {
  const trials = 400;
  const results = [false, true].map((balanced) => {
    let wins = 0,
      turns = 0;
    for (let seed = 1; seed <= trials; seed++) {
      const c = context();
      const actor = c.members[0];
      const target = enemy(c, balanced);
      const fight = encounter(actor, target);
      let entropy = seed;
      const draw = (sides: number) => {
        entropy = (Math.imul(entropy, 1664525) + 1013904223) >>> 0;
        return 1 + Math.floor((entropy / 2 ** 32) * sides);
      };
      while (!fight.victory && actor.state.hp > 0 && fight.round <= 30) {
        const kind = !actor.state.abilityUses?.['Spiral-Script Strike']
          ? 'strike'
          : actor.state.hp <= 12 && !actor.state.abilityUses?.['Forbidden Field Dressing']
            ? 'mend'
            : 'attack';
        runCombat([actor], fight, round(actor, target, kind), draw);
      }
      if (fight.victory) {
        wins++;
        turns += fight.round - 1;
      }
    }
    return { wins, trials, meanWinningTurns: turns / wins };
  });
  process.stdout.write(
    `Solo combat balance: ${JSON.stringify({ recorded: results[0], bounded: results[1] })}\n`,
  );
  expect(results[1].wins).toBeGreaterThan(results[0].wins + trials * 0.1);
  expect(results[1].wins).toBeGreaterThanOrEqual(trials * 0.75);
  expect(results[1].wins).toBeLessThan(trials);
  expect(results[1].meanWinningTurns).toBeLessThan(6);
});
