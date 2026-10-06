import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  blankTrait,
  characterSchema,
  combatSchema,
  enemySchema,
  templateCharacter,
  type Encounter,
  type Enemy,
  type Item,
  type Member,
} from '../shared/schema';
import {
  addItem,
  gainAttributes,
  rollStartingEquipment,
  chooseStartingEquipment,
  usableSlots,
  baseItem,
  damage,
  defense,
  equip,
  unequip,
  grantXp,
  healWithItem,
  heal,
  helpUp,
  recoverAfterEncounter,
  maxHp,
  isDowned,
  isDead,
  mendWithAbility,
  initialState,
  modifier,
  normalizeCharacter,
  occupiedSlots,
  offerGroundItem,
  initialScene,
  removeItem,
  takeItem,
  randomLoot,
  rollEnemyLoot,
  runCombat,
  scaling,
  equipmentBonus,
  resetAbilities,
  abilityMechanics,
  RuleError,
  applyCondition,
  tickConditions,
  matchingCures,
} from '../shared/rules';
import { localDice } from '../server/random';
import { conditionDuration } from '../shared/ailments';

describe('atomic loot pickup and equipment swaps', () => {
  it('equips scene loot directly into an empty slot with a full backpack', () => {
    const hero = member();
    for (let i = 0; i < 7; i++)
      addItem(hero.character, hero.state, baseItem(`spare-${i}`, `Spare ${i}`, 'relic'));
    const scene = initialScene('Test');
    scene.loot.push({ ...baseItem('boots', 'New boots', 'boots'), quantity: 2 });
    takeItem(hero.character, hero.state, scene, 'boots', 'boots');
    expect(occupiedSlots(hero.state)).toBe(8);
    expect(hero.state.equipment.boots?.id).toBe('boots');
    expect(scene.loot[0].quantity).toBe(1);
    expect(hero.state.inventory.some((item) => item.id === 'boots')).toBe(false);
  });

  it('rolls back overflowing swaps, then drops chosen stacks and stows both displaced items', () => {
    const hero = member();
    hero.state.equipment.left = baseItem('shield', 'Old shield', 'shield');
    for (let i = 0; i < 7; i++)
      addItem(hero.character, hero.state, baseItem(`spare-${i}`, `Spare ${i}`, 'relic'));
    const scene = initialScene('Test');
    scene.loot.push({ ...baseItem('great', 'Great blade', 'weapon'), hands: 2, quantity: 1 });
    const before = structuredClone({ state: hero.state, scene });
    expect(() => takeItem(hero.character, hero.state, scene, 'great', 'right', ['spare-0'])).toThrow(
      'Backpack full',
    );
    expect({ state: hero.state, scene }).toEqual(before);
    takeItem(hero.character, hero.state, scene, 'great', 'right', ['spare-0', 'spare-1']);
    expect(hero.state.equipment.left?.id).toBe('great');
    expect(hero.state.equipment.right?.id).toBe('great');
    expect(occupiedSlots(hero.state)).toBe(8);
    expect(hero.state.inventory.filter((item) => item.id === 'shield')).toHaveLength(1);
    expect(scene.loot.map((item) => item.id)).toEqual(['spare-0', 'spare-1']);
  });

  it('preserves selected drops and ground loot when equipment requirements or drop selections are invalid', () => {
    const hero = member();
    const scene = initialScene('Test');
    scene.loot.push({
      ...baseItem('armour', 'Heavy armour', 'armour'),
      requirements: { STR: 50, DEX: 0, INT: 0, CHA: 0, CON: 0, WIS: 0 },
      quantity: 1,
    });
    const before = structuredClone({ state: hero.state, scene });
    const drop = hero.state.inventory[0].id;
    for (const drops of [[drop], ['missing'], [drop, drop]]) {
      expect(() => takeItem(hero.character, hero.state, scene, 'armour', 'body', drops)).toThrow();
      expect({ state: hero.state, scene }).toEqual(before);
    }
  });
});

function member(name = 'Test hero'): Member {
  const character = normalizeCharacter(templateCharacter(name, 'A custom form'));
  const id = randomUUID();
  const state = initialState(character, id);
  addItem(character, state, state.starterEquipment[0]);
  equip(character, state, state.starterEquipment[0].id, 'right');
  state.equipmentChosen = true;
  return {
    id,
    playerId: randomUUID(),
    playerName: name,
    characterId: randomUUID(),
    character,
    state,
    active: true,
  };
}
function encounter(party: Member[], overrides = {}): Encounter {
  const enemy = {
    ...enemySchema.parse({
      id: 'adversary',
      name: 'Custom adversary',
      tier: 'normal',
      hp: 30,
      defense: 10,
      attack: 0,
      damage: '1d4',
      description: 'Test creature',
      tactic: 'Test tactic',
      ...overrides,
    }),
    maxHp: 30,
    initiative: 1,
  };
  return {
    enemies: [enemy],
    initiative: [...party.map((m) => ({ id: m.id, total: 15 })), { id: enemy.id, total: 1 }],
    round: 1,
    victory: false,
    escaped: false,
  };
}
const loot = {
  name: 'Custom item',
  kind: 'weapon',
  scaling: ['STR'],
  hands: 1,
  light: false,
  description: 'Instance-specific loot.',
} as const;
function input(m: Member, overrides = {}) {
  return combatSchema.parse({
    actions: [
      {
        memberId: m.id,
        main: 'attack',
        targetId: 'adversary',
        stat: 'STR',
        description: 'Attack',
        minor: 'none',
        minorItemId: null,
        minorSlot: null,
        ...overrides,
      },
    ],
    enemyTargets: [],
    loot,
  });
}

it.each([false, true])(
  'uses saved strike dice and bonus, doubling only dice on a critical (%s)',
  (critical) => {
    const hero = member();
    const ability = hero.character.abilities[0];
    ability.dice = '2d8';
    ability.bonus = 2;
    ability.level = 2;
    const e = encounter([hero], { hp: 100 });
    e.initiative = e.initiative.filter((actor) => actor.id === hero.id);
    const roll = vi.fn((sides: number) => (sides === 20 ? (critical ? 20 : 15) : sides));
    runCombat([hero], e, input(hero, { main: 'ability', abilityName: ability.name }), roll);
    expect(e.enemies[0].hp).toBe(100 - ((critical ? 4 : 2) * 8 + 4));
    expect(roll.mock.calls.filter(([sides]) => sides === 8)).toHaveLength(critical ? 4 : 2);
    expect(abilityMechanics(ability)).toContain('2d8 + STR modifier + 4 damage');
  },
);

it('uses saved Mend dice and compensation when helping up a Downed ally', () => {
  const hero = member();
  const ally = member('Downed ally');
  const ability = hero.character.abilities[0];
  Object.assign(ability, { effect: 'mend', dice: '1d8', bonus: 2, level: 2 });
  damage(ally.state, ally.state.hp, 'First injury');
  const roll = vi.fn((sides: number) => sides);
  expect(mendWithAbility(hero.character, hero.state, ability.name, ally, roll)).toBe(12);
  expect(roll.mock.calls).toEqual([[8, `${ability.name}: healing`, hero.character.name, ability.stat]]);
  expect(isDowned(ally.state)).toBe(false);
  expect(hero.state.abilityUses?.[ability.name]).toBe(1);
});

it.each(['guard', 'assist'] as const)('applies a saved %s bonus to an ally', (effect) => {
  const hero = member();
  const ally = member('Ally');
  const ability = hero.character.abilities[0];
  Object.assign(ability, { effect, bonus: 2, level: 2 });
  const e = encounter([hero, ally]);
  e.initiative = e.initiative.filter((actor) => actor.id === hero.id);
  runCombat(
    [hero, ally],
    e,
    input(hero, { main: 'ability', abilityName: ability.name, targetId: ally.id }),
    () => 1,
  );
  expect(effect === 'guard' ? ally.state.abilityGuard : ally.state.abilityAssist).toBe(
    effect === 'guard' ? 6 : 3,
  );
});

it('loads legacy three-stat sheets with neutral new attributes and applies constitution to health', () => {
  const legacy = JSON.parse(JSON.stringify(templateCharacter()));
  for (const stat of ['CHA', 'CON', 'WIS']) {
    delete legacy.stats[stat];
    for (const trait of legacy.traits) delete trait.stats[stat];
    for (const item of legacy.equipmentOptions) delete item.requirements[stat];
  }
  const character = characterSchema.parse(legacy);
  expect(character.stats).toEqual({ STR: 5, DEX: 5, INT: 5, CHA: 5, CON: 5, WIS: 5 });
  expect(character.traits[0].stats).toEqual(blankTrait().stats);
  expect(character.equipmentOptions[0].requirements).toEqual(baseItem('a', 'A', 'weapon').requirements);
  const state = initialState(character, 'constitution');
  state.stats.STR = 15;
  expect(maxHp(character, state)).toBe(20);
  state.stats.CON = 9;
  expect(maxHp(character, state)).toBe(24);
});

it('recovers constitution and trait HP, restores one charge, and resets downing only for living members', () => {
  const hero = member('Hero');
  const downed = member('Downed ally');
  const dead = member('Dead ally');
  hero.state.hp = 10;
  hero.state.stats.CON = 7;
  hero.character.traits[0].regeneration = 1;
  hero.state.abilityUses = { 'Focused strike': 2, 'Keen observation': 1 };
  hero.state.downedThisEncounter = true;
  hero.state.guarding = true;
  hero.state.abilityGuard = 3;
  hero.state.abilityAssist = 1;
  damage(downed.state, downed.state.hp, 'First injury');
  downed.state.stats.CON = 0;
  downed.state.abilityUses = { 'Focused strike': 1 };
  dead.state.downedThisEncounter = true;
  damage(dead.state, dead.state.hp, 'Second injury');
  const beforeDeath = structuredClone(dead.state);
  recoverAfterEncounter([hero, downed, dead]);
  expect(hero.state).toMatchObject({
    hp: 18,
    downedThisEncounter: false,
    guarding: false,
    abilityUses: { 'Focused strike': 1, 'Keen observation': 0 },
  });
  expect(hero.state.abilityGuard).toBeUndefined();
  expect(hero.state.abilityAssist).toBeUndefined();
  expect(downed.state).toMatchObject({
    hp: 1,
    downedThisEncounter: false,
    abilityUses: { 'Focused strike': 0 },
  });
  expect(isDowned(downed.state)).toBe(false);
  expect(dead.state).toEqual(beforeDeath);
  damage(downed.state, 1, 'New encounter');
  expect(isDowned(downed.state)).toBe(true);
});

it('spends the whole turn helping up an ally to exactly 1 HP and preserves the encounter death limit', () => {
  const hero = member('Helper');
  const ally = member('Ally');
  damage(ally.state, ally.state.hp, 'First injury', true);
  const e = encounter([hero, ally]);
  e.initiative = e.initiative.filter((actor) => actor.id === hero.id);
  const dice = vi.fn(() => 12);
  const inventory = structuredClone(hero.state.inventory);
  const plan = input(hero, { main: 'help-up', targetId: ally.id });
  const logs = runCombat([hero, ally], e, plan, dice);
  expect(ally.state).toMatchObject({ hp: 1, downedThisEncounter: true });
  expect(hero.state.inventory).toEqual(inventory);
  expect(e.enemies[0].hp).toBe(30);
  expect(dice).not.toHaveBeenCalled();
  expect(logs.join(' ')).toContain('Helper helps up Ally');
  expect(() => helpUp(ally.state)).toThrow('downed');
  expect(() =>
    runCombat([hero, ally], e, input(hero, { main: 'help-up', targetId: ally.id, minor: 'offhand' }), dice),
  ).toThrow('entire turn');
  damage(ally.state, 1, 'Second injury');
  expect(isDead(ally.state)).toBe(true);
  expect(() => helpUp(ally.state)).toThrow('downed');
});

it('preserves charges and the downing limit when the encounter ends by escape', () => {
  const hero = member('Fugitive');
  hero.state.hp = 10;
  hero.state.downedThisEncounter = true;
  hero.state.abilityUses = { 'Focused strike': 1, 'Keen observation': 1 };
  const e = encounter([hero]);
  runCombat([hero], e, input(hero, { main: 'flee' }), () => 20);
  expect(e.escaped).toBe(true);
  expect(hero.state).toMatchObject({
    hp: 10,
    downedThisEncounter: true,
    abilityUses: { 'Focused strike': 1, 'Keen observation': 1 },
  });
});

describe('customized roguelike mechanics', () => {
  it('derives stats from custom traits without a fixed balance budget', () => {
    const c = templateCharacter('Zed', 'Elf-spider warlord');
    c.traits = [
      {
        ...blankTrait('Many limbs'),
        stats: { ...blankTrait().stats, STR: 3, DEX: 1, INT: -1 },
        blocked: ['boots'],
        natural: true,
      },
    ];
    expect(normalizeCharacter(c).stats).toEqual({ STR: 8, DEX: 6, INT: 4, CHA: 5, CON: 5, WIS: 5 });
    expect([modifier(4), modifier(5), modifier(6), modifier(9)]).toEqual([-1, 0, 0, 2]);
    c.traits[0].stats = { ...blankTrait().stats, STR: 4, DEX: 4, INT: 4 };
    expect(normalizeCharacter(c).stats).toEqual({ STR: 9, DEX: 9, INT: 9, CHA: 5, CON: 5, WIS: 5 });
  });
  it('supports extreme strengths and weaknesses, with traits and armour compensating', () => {
    const c = templateCharacter('Frail ogre');
    c.traits[0].stats = { STR: 8, DEX: -4, INT: -4, CHA: -5, CON: -4, WIS: 8 };
    c.traits[1].regeneration = 1;
    const character = normalizeCharacter(characterSchema.parse(c));
    expect(character.stats).toEqual({ STR: 13, DEX: 1, INT: 1, CHA: 0, CON: 1, WIS: 13 });
    const hero = member();
    hero.character = character;
    hero.state = initialState(character, 'frail');
    expect(hero.state.maxHp).toBe(16);
    hero.state.hp = 10;
    recoverAfterEncounter([hero]);
    expect(hero.state.hp).toBe(12); // CON 1 plus trait regeneration 1.
    expect(defense(character, hero.state)).toBe(8);
    hero.state.equipment.body = {
      ...baseItem('armour', 'Braced armour', 'armour'),
      scaling: ['STR'],
      defense: 1,
    };
    expect(defense(character, hero.state)).toBe(15);
  });
  it('rejects out-of-range trait deltas and combined starting attributes', () => {
    for (const delta of [-6, 9]) {
      const c = templateCharacter();
      c.traits[0].stats.STR = delta;
      expect(characterSchema.safeParse(c).success).toBe(false);
    }
    for (const deltas of [
      [-5, -1],
      [8, 1],
    ]) {
      const c = templateCharacter();
      c.traits[0].stats.STR = deltas[0];
      c.traits[1].stats.STR = deltas[1];
      expect(() => normalizeCharacter(characterSchema.parse(c))).toThrow('between 0 and 13');
    }
  });
  it.each([
    ['duplicate traits', { id: 'same' }, { id: 'same' }, 'trait twice'],
    ['stacked defense', { defense: 1 }, { defense: 1 }, 'cannot stack'],
    ['stacked regeneration', { regeneration: 1 }, { regeneration: 1 }, 'cannot stack'],
    ['stacked positive HP', { hp: 4 }, { hp: 1 }, 'cannot stack'],
    ['stacked negative HP', { hp: -4 }, { hp: -1 }, 'cannot stack'],
    [
      'fully blocked anatomy',
      { blocked: ['left', 'right', 'body', 'head', 'boots', 'relic'] },
      {},
      'at least one equipment slot',
    ],
  ] as const)('still rejects %s', (_reason, first, second, message) => {
    const c = templateCharacter();
    Object.assign(c.traits[0], first);
    Object.assign(c.traits[1], second);
    expect(() => normalizeCharacter(characterSchema.parse(c))).toThrow(message);
  });
  it('counts stacks in eight backpack slots and applies equipment restrictions atomically', () => {
    const m = member();
    const potion = m.state.inventory[0];
    addItem(m.character, m.state, potion, 2);
    expect(occupiedSlots(m.state)).toBe(1);
    addItem(m.character, m.state, potion);
    expect(occupiedSlots(m.state)).toBe(2);
    for (let i = 0; i < 6; i++) addItem(m.character, m.state, baseItem(`item-${i}`, `Item ${i}`, 'relic'));
    const before = structuredClone(m.state);
    expect(() => addItem(m.character, m.state, baseItem('extra', 'Extra', 'relic'))).toThrow('Backpack full');
    expect(m.state).toEqual(before);
    m.character.traits = [{ ...blankTrait('No boots'), blocked: ['boots'] }];
    expect(() => equip(m.character, m.state, 'item-0', 'boots')).toThrow('anatomy');
  });
  it('uses both hand slots for two-handed weapons and displaces equipment once', () => {
    const m = member();
    const item = {
      ...baseItem('great', 'Custom great weapon', 'weapon'),
      hands: 2 as const,
      scaling: ['STR' as const],
    };
    addItem(m.character, m.state, item);
    equip(m.character, m.state, item.id, 'left');
    expect(m.state.equipment.left?.id).toBe('great');
    expect(m.state.equipment.right?.id).toBe('great');
    const shield = { ...baseItem('shield', 'Custom shield', 'shield'), defense: 1 };
    addItem(m.character, m.state, shield);
    equip(m.character, m.state, shield.id, 'right');
    expect(m.state.equipment.left).toBeNull();
    expect(m.state.inventory.filter((i) => i.id === 'great')).toHaveLength(1);
    expect(defense(m.character, m.state)).toBe(11);
  });
  it('equips and swaps relics only in their own slot, independently of occupied or blocked hands', () => {
    const m = member();
    const great = { ...baseItem('great', 'Great blade', 'weapon'), hands: 2 as const };
    addItem(m.character, m.state, great);
    equip(m.character, m.state, great.id, 'right');
    const hands = structuredClone({ left: m.state.equipment.left, right: m.state.equipment.right });
    const relic = { ...baseItem('oath', 'Oath', 'relic'), scaling: ['INT' as const], checkBonus: 1 };
    addItem(m.character, m.state, relic);
    for (const slot of ['left', 'right', 'body', 'head', 'boots'] as const) {
      const before = structuredClone(m.state);
      expect(() => equip(m.character, m.state, relic.id, slot)).toThrow('does not fit');
      expect(m.state).toEqual(before);
    }
    m.character.traits = [{ ...blankTrait(), blocked: ['left', 'right'] }];
    expect(usableSlots(m.character, m.state.stats, { ...relic, hands: 2 })).toEqual(['relic']);
    equip(m.character, m.state, relic.id, 'relic');
    expect(equipmentBonus(m.state, 'INT', 'checkBonus')).toBe(1);
    expect(equipmentBonus(m.state, 'STR', 'checkBonus')).toBe(0);
    const scene = initialScene('Test');
    scene.loot.push({ ...relic, id: 'new-oath', checkBonus: 2, hands: 2, quantity: 1 });
    takeItem(m.character, m.state, scene, 'new-oath', 'relic');
    expect(m.state.inventory.find((item) => item.id === relic.id)?.quantity).toBe(1);
    expect(m.state.equipment.relic?.id).toBe('new-oath');
    expect(equipmentBonus(m.state, 'INT', 'checkBonus')).toBe(2);
    expect({ left: m.state.equipment.left, right: m.state.equipment.right }).toEqual(hands);
    unequip(m.character, m.state, 'relic');
    expect(equipmentBonus(m.state, 'INT', 'checkBonus')).toBe(0);
    m.character.traits[0].blocked.push('relic');
    expect(usableSlots(m.character, m.state.stats, relic)).toEqual([]);
    expect(() => equip(m.character, m.state, relic.id, 'relic')).toThrow('anatomy');
  });
  it('averages hybrid modifiers and grants a reward choice and HP on every level', () => {
    const m = member();
    m.state.stats = { ...m.state.stats, STR: 9, DEX: 4, INT: 5 };
    expect(scaling(m.state, { ...baseItem('hybrid', 'Hybrid', 'weapon'), scaling: ['STR', 'DEX'] })).toBe(0);
    m.state.stats = { STR: 5, DEX: 5, INT: 5, CHA: 5, CON: 5, WIS: 5 };
    grantXp(m.character, m.state, 230);
    expect(m.state).toMatchObject({ level: 3, xp: 30, pendingLevelUps: 2, hp: 30, maxHp: 30 });
    expect(() => gainAttributes(m.character, m.state, ['STR'])).toThrow('exactly two');
    gainAttributes(m.character, m.state, ['CON', 'CON']);
    expect(m.state).toMatchObject({ pendingLevelUps: 2, hp: 32, maxHp: 32 });
  });
  it('cannot heal, award XP to, or damage a dead character again', () => {
    const m = member();
    m.state.downedThisEncounter = true;
    damage(m.state, 999, 'Fell into a chasm', true);
    const dead = structuredClone(m.state);
    expect(() => healWithItem(m.character, m.state, m.state.inventory[0].id)).toThrow('dead');
    grantXp(m.character, m.state, 500);
    damage(m.state, 1, 'Another cause');
    expect(m.state).toEqual(dead);
  });
  it('always critically hits on 20, doubles damage dice, and uses the actual weapon beside a shield', () => {
    const m = member();
    m.state.equipment.left = m.state.equipment.right;
    m.state.equipment.right = baseItem('shield', 'Shield', 'shield');
    const e = encounter([m], { defense: 30, hp: 5, tier: 'boss' });
    const dice = [20, 3, 3, 2, 2];
    runCombat([m], e, input(m), () => dice.shift()!);
    expect(e.victory).toBe(true);
    expect(m.state.level).toBe(2);
    expect(m.state.pendingLevelUps).toBe(1);
    expect(dice).toEqual([]);
  });
  it.each([
    {
      name: 'INT pistol ignores stronger STR',
      natural: false,
      score: 6,
      critical: false,
      hybrid: false,
      face: 3,
      damage: 6,
      bonus: 0,
    },
    {
      name: 'INT modifier applies twice',
      natural: false,
      score: 9,
      critical: false,
      hybrid: false,
      face: 3,
      damage: 10,
      bonus: 2,
    },
    {
      name: 'negative modifier applies twice',
      natural: false,
      score: 1,
      critical: false,
      hybrid: false,
      face: 3,
      damage: 2,
      bonus: -2,
    },
    {
      name: 'minimum applies after the combined sum',
      natural: false,
      score: 1,
      critical: false,
      hybrid: false,
      face: 1,
      damage: 1,
      bonus: -2,
    },
    {
      name: 'natural trait adds d6',
      natural: true,
      score: 9,
      critical: false,
      hybrid: false,
      face: 3,
      damage: 10,
      bonus: 2,
    },
    {
      name: 'critical doubles both dice without doubling modifiers',
      natural: false,
      score: 9,
      critical: true,
      hybrid: false,
      face: 3,
      damage: 16,
      bonus: 2,
    },
    {
      name: 'critical doubles natural trait dice too',
      natural: true,
      score: 9,
      critical: true,
      hybrid: false,
      face: 3,
      damage: 16,
      bonus: 2,
    },
    {
      name: 'hybrid modifier is rounded before doubling',
      natural: false,
      score: 6,
      critical: false,
      hybrid: true,
      face: 3,
      damage: 8,
      bonus: 1,
    },
  ])(
    'adds innate and weapon dice: $name',
    ({ natural, score, critical, hybrid, face, damage: amount, bonus }) => {
      const m = member();
      m.character.traits = [{ ...blankTrait('Natural weapons'), natural }];
      m.character.stats.STR = m.state.stats.STR = 11;
      m.state.stats.INT = score;
      m.state.equipment.right = {
        ...baseItem('pistol', 'Pistol', 'weapon'),
        scaling: hybrid ? ['STR', 'INT'] : ['INT'],
        damage: '1d6',
      };
      m.state.equipment.left = {
        ...baseItem('focus', 'Focus', 'focus'),
        scaling: ['INT'],
        attackBonus: 1,
      };
      const e = encounter([m], { hp: 100 });
      e.initiative = e.initiative.filter((entry) => entry.id === m.id);
      const dice = vi.fn((sides: number, _label: string, _actor: string, _stat: string, _mod?: number) =>
        sides === 20 ? (critical ? 20 : 15) : face,
      );
      runCombat([m], e, input(m), dice);
      expect(e.enemies[0].hp).toBe(100 - amount);
      expect(dice.mock.calls[0][4]).toBe(bonus + 1); // Accuracy adds scaling once and the focus.
      expect(dice.mock.calls.map(([sides]) => sides)).toEqual([
        20,
        6,
        ...(critical ? [6] : []),
        natural ? 6 : 4,
        ...(critical ? [natural ? 6 : 4] : []),
      ]);
      expect(dice.mock.calls.every(([, , , stat]) => stat === (hybrid ? 'STR' : 'INT'))).toBe(true);
    },
  );
  it('uses either explicitly chosen weapon and does not spend combat ability uses for ordinary attacks', () => {
    for (const hand of ['left', 'right'] as const) {
      const m = member();
      const ability = m.character.abilities[0];
      m.state.abilityUses = { [ability.name]: 1 };
      m.state.equipment.left = { ...baseItem('left-blade', 'Left blade', 'weapon'), damage: '1d8' };
      m.state.equipment.right = { ...baseItem('right-blade', 'Right blade', 'weapon'), damage: '1d6' };
      const e = encounter([m]);
      e.initiative = e.initiative.filter((entry) => entry.id === m.id);
      const dice = vi.fn((sides: number) => (sides === 20 ? 15 : 3));
      const logs = runCombat([m], e, input(m, { weaponSlot: hand }), dice);
      expect(dice.mock.calls.map(([sides]) => sides)).toEqual([20, hand === 'left' ? 8 : 6, 4]);
      expect(logs.some((log) => log.includes(m.state.equipment[hand]!.name))).toBe(true);
      expect(e.enemies[0].hp).toBe(24);
      expect(m.state.abilityUses?.[ability.name]).toBe(1);
    }
  });
  it('falls back from an empty or nonweapon hand to an equipped weapon', () => {
    for (const invalid of [null, baseItem('shield', 'Shield', 'shield')]) {
      const m = member();
      m.state.equipment.left = m.state.equipment.right;
      m.state.equipment.right = invalid;
      const e = encounter([m]);
      e.initiative = e.initiative.filter((entry) => entry.id === m.id);
      const dice = vi.fn((sides: number) => (sides === 20 ? 15 : 3));
      runCombat([m], e, input(m, { weaponSlot: 'right' }), dice);
      expect(dice.mock.calls.map(([sides]) => sides)).toEqual([20, 6, 4]);
      expect(e.enemies[0].hp).toBe(24);
    }
  });
  it('uses unarmed or innate strikes when no equipped weapon is available and preserves explicit natural attacks', () => {
    for (const innate of [false, true]) {
      const m = member();
      m.character.traits = [{ ...blankTrait('Natural strike'), natural: innate }];
      m.state.equipment.left = baseItem('focus', 'Focus', 'focus');
      m.state.equipment.right = null;
      const e = encounter([m]);
      e.initiative = e.initiative.filter((entry) => entry.id === m.id);
      const dice = vi.fn((sides: number) => (sides === 20 ? 15 : 3));
      const logs = runCombat([m], e, input(m, { weaponSlot: 'left' }), dice);
      expect(dice.mock.calls.map(([sides]) => sides)).toEqual([20, innate ? 6 : 4]);
      expect(logs.some((log) => log.includes('innate strike'))).toBe(true);
      m.state.equipment.right = { ...baseItem('blade', 'Blade', 'weapon'), damage: '1d8' };
      dice.mockClear();
      runCombat([m], e, input(m, { weaponSlot: 'natural' }), dice);
      expect(dice.mock.calls.map(([sides]) => sides)).toEqual([20, innate ? 6 : 4]);
    }
  });
  it('rejects combat equipment changes while continuing the normal attack', () => {
    const m = member();
    const weapon = { ...baseItem('backpack-blade', 'Backpack blade', 'weapon'), damage: '1d8' };
    addItem(m.character, m.state, weapon);
    const e = encounter([m]);
    e.initiative = e.initiative.filter((entry) => entry.id === m.id);
    const dice = vi.fn((sides: number) => (sides === 20 ? 15 : 3));
    runCombat(
      [m],
      e,
      input(m, {
        minor: 'equip',
        minorItemId: weapon.id,
        minorSlot: 'left',
        weaponSlot: 'left',
      }),
      dice,
    );
    expect(m.state.equipment.left).toBeNull();
    expect(m.state.inventory.some((item) => item.id === weapon.id)).toBe(true);
    expect(dice.mock.calls.map(([sides]) => sides)).toEqual([20, 6, 4]);
    expect(m.state.abilityUses).toEqual({});
  });
  it('resolves a natural 1 as failure despite a high attack bonus', () => {
    const m = member();
    m.state.stats.STR = 50;
    const e = encounter([m]);
    const dice = [1, 4, 2];
    runCombat([m], e, input(m), () => dice.shift()!);
    expect(e.enemies[0].hp).toBe(30);
    expect(m.state.hp).toBe(16);
  });
  it('does not bring an escaped character back into later rounds', () => {
    const a = member('A');
    const b = member('B');
    const e = encounter([a, b]);
    a.state.conditions = ['Escaped'];
    a.state.conditionTurns.Escaped = 999;
    const before = a.state.hp;
    const dice = [20];
    runCombat([a, b], e, input(b, { main: 'flee' }), () => dice.shift()!);
    expect(e.escaped).toBe(true);
    expect(a.state.hp).toBe(before);
    expect(a.state.conditions).not.toContain('Escaped');
  });
  it('requires two light weapons for an off-hand attack and does not add its damage modifier', () => {
    const m = member();
    m.state.stats.DEX = 9;
    const right = { ...baseItem('r', 'Right blade', 'weapon'), scaling: ['DEX' as const], light: true };
    const left = { ...right, id: 'l', name: 'Left blade' };
    m.state.equipment = { ...m.state.equipment, right, left };
    const e = encounter([m]);
    const dice = [12, 2, 2, 12, 2, 2, 2];
    runCombat([m], e, input(m, { minor: 'offhand' }), () => dice.shift()!);
    expect(e.enemies[0].hp).toBe(18); // (2+2 dice + 2*2 DEX) main; (2+2 dice) off-hand; 2 enemy damage.
  });
  it('uses the other light hand for an off-hand attack and skips heavy or shared two-handed weapons', () => {
    const m = member();
    const right = { ...baseItem('r', 'Right blade', 'weapon'), light: true, damage: '1d8' };
    const left = { ...baseItem('l', 'Left blade', 'weapon'), light: true, damage: '1d6' };
    m.state.equipment = { ...m.state.equipment, right, left };
    const e = encounter([m]);
    e.initiative = e.initiative.filter((entry) => entry.id === m.id);
    const dice = vi.fn((sides: number) => (sides === 20 ? 15 : 3));
    runCombat([m], e, input(m, { weaponSlot: 'left', minor: 'offhand' }), dice);
    expect(dice.mock.calls.map(([sides]) => sides)).toEqual([20, 6, 4, 20, 8, 4]);
    dice.mockClear();
    m.state.equipment.left!.light = false;
    expect(runCombat([m], e, input(m, { main: 'defend', minor: 'offhand' }), dice)).toContain(
      `${m.character.name}'s off-hand attack has no effect: it requires two distinct light one-handed weapons. The minor action is spent.`,
    );
    m.state.equipment.left = m.state.equipment.right = { ...right, hands: 2 };
    expect(runCombat([m], e, input(m, { main: 'defend', minor: 'offhand' }), dice)).toContain(
      `${m.character.name}'s off-hand attack has no effect: it requires two distinct light one-handed weapons. The minor action is spent.`,
    );
    expect(dice).not.toHaveBeenCalled();
    expect(m.state.guarding).toBe(true);
  });
  it('preserves inventory and resolves the main attack when an optional equip or heal is unusable', () => {
    for (const minor of ['equip', 'heal'] as const) {
      const m = member();
      const originalEquipment = structuredClone(m.state.equipment);
      const originalInventory = structuredClone(m.state.inventory);
      const e = encounter([m]);
      const dice = vi.fn((sides: number) => (sides === 20 ? 15 : 3));
      const logs = runCombat(
        [m],
        e,
        input(m, {
          minor,
          minorItemId: 'not-owned',
          minorSlot: 'left',
        }),
        dice,
      );
      expect(
        logs.some((log) =>
          log.includes(minor === 'equip' ? 'cannot change equipment during combat' : 'minor action is spent'),
        ),
      ).toBe(true);
      expect(logs.some((log) => log.includes(`${m.character.name} hits`))).toBe(true);
      expect(logs.some((log) => log.includes(`hits ${m.character.name}`))).toBe(true);
      expect(e.enemies[0].hp).toBe(24);
      expect(m.state.equipment).toEqual(originalEquipment);
      expect(m.state.inventory).toEqual(originalInventory);
    }
  });
  it('does not swallow dice failures during an optional off-hand attack', () => {
    const m = member();
    m.state.equipment.left = { ...baseItem('left', 'Left blade', 'weapon'), light: true };
    m.state.equipment.right = { ...baseItem('right', 'Right blade', 'weapon'), light: true };
    const e = encounter([m]);
    const error = new RuleError('Dice source unavailable');
    expect(() =>
      runCombat([m], e, input(m, { main: 'defend', minor: 'offhand' }), () => {
        throw error;
      }),
    ).toThrow(error);
  });
  it('rolls loot rarity but preserves instance-owned item names and kinds', () => {
    const item = randomLoot('new-id', 2, (sides) => sides, { ...loot, scaling: ['STR'] });
    expect(item).toMatchObject({ name: 'Custom item', rarity: 'Legendary', damage: '2d8' });
  });
  it('applies enemy loot counts, rarity boundaries and an independent healing-item roll', () => {
    const cases: [Enemy['tier'], number[], Item['rarity'][], boolean][] = [
      ['minor', [50, 51], ['Common'], false],
      ['minor', [51, 50], ['Uncommon'], true],
      ['normal', [50, 51, 50], ['Uncommon'], true],
      ['normal', [51, 51, 51], ['Rare'], false],
      ['normal', [50, 50, 60, 51], ['Uncommon', 'Common'], false],
      ['normal', [51, 50, 61, 50], ['Rare', 'Uncommon'], true],
      ['normal', [50, 50, 90, 51], ['Uncommon', 'Uncommon'], false],
      ['normal', [51, 50, 91, 51], ['Rare', 'Rare'], false],
      ['normal', [51, 50, 100, 51], ['Rare', 'Rare'], false],
      ['elite', [50, 51, 51], ['Rare', 'Common', 'Uncommon'], false],
      ['elite', [80, 81, 50], ['Rare', 'Uncommon', 'Rare'], true],
      ['elite', [95, 96, 51], ['Rare', 'Rare', 'Legendary'], false],
      ['boss', [50, 1, 81, 100, 50], ['Legendary', 'Common', 'Rare', 'Legendary'], true],
      ['boss', [51, 51, 80, 95, 51], ['Cursed', 'Uncommon', 'Uncommon', 'Rare'], false],
    ];
    for (const [tier, draws, expected, healing] of cases) {
      const remaining = [...draws];
      const roll = vi.fn((sides: number) => (sides === 100 ? remaining.shift()! : 1));
      const items = rollEnemyLoot(
        'enemy',
        2,
        {
          tier,
          name: 'Custom foe',
          description: 'Instance-specific enemy',
          damage: '1d4',
          equipmentBlueprints: [
            { ...loot, scaling: [...loot.scaling] },
            { ...loot, name: 'Custom tonic', kind: 'consumable', scaling: [] },
          ],
        },
        roll,
      );
      expect(items.filter((item) => item.kind !== 'consumable').map((item) => item.rarity)).toEqual(expected);
      expect(items.filter((item) => item.kind === 'consumable')).toHaveLength(Number(healing));
      if (healing) expect(items.at(-1)).toMatchObject({ name: 'Custom tonic', rarity: 'Common', healing: 6 });
      expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
      expect(items[0].name).toBe(loot.name);
      expect(remaining).toEqual([]);
      expect(roll.mock.calls.filter(([sides]) => sides === 100)).toHaveLength(draws.length);
      expect(
        items
          .filter((item) => ['Rare', 'Legendary', 'Cursed'].includes(item.rarity))
          .every((item) => item.onHit || item.immunities?.length),
      ).toBe(true);
    }
    const fallback = rollEnemyLoot(
      'fallback',
      1,
      {
        tier: 'boss',
        name: 'Bewaker',
        description: '',
        damage: '1d4',
      },
      () => 1,
      'Nederlands',
    );
    expect(fallback.map((item) => item.kind)).toEqual(['weapon', 'relic', 'relic', 'relic', 'consumable']);
    expect(fallback[0]).toMatchObject({ name: 'Bewaker: wapen', damage: '1d4' });
    expect(fallback.at(-1)).toMatchObject({ name: 'Bewaker: genezend middel', healing: 6 });
  });
  it('uses the dependency-free local dice source with validated die sizes', async () => {
    await localDice.prepare();
    expect(localDice.label).toContain('Local');
    for (const sides of [4, 6, 8, 10, 12, 20, 100]) {
      const result = localDice.draw(sides);
      expect(Number.isInteger(result) && result >= 1 && result <= sides).toBe(true);
    }
    expect(() => localDice.draw(0)).toThrow();
    expect(() => localDice.draw(2.5)).toThrow();
  });
});

it('keeps defending active until the character’s own next initiative slot', () => {
  const m = member();
  m.state.guarding = true;
  const e = encounter([m]);
  e.initiative.reverse();
  const dice = [11, 2];
  runCombat([m], e, input(m), () => dice.shift()!);
  expect(m.state.hp).toBe(20);
  expect(m.state.guarding).toBe(false);
  expect(dice).toEqual([]);
});
it('can resolve an encounter through influence without killing the enemy', () => {
  const m = member();
  const e = encounter([m]);
  runCombat(
    [m],
    e,
    input(m, {
      main: 'creative',
      effect: 'influence',
      stat: 'INT',
      dc: 15,
      description: 'Negotiate a truce',
    }),
    () => 15,
  );
  expect(e.victory).toBe(true);
  expect(e.enemies[0].withdrawn).toBe(true);
  expect(e.enemies[0].hp).toBe(30);
  expect(m.state.kills).toBe(0);
  expect(m.state.xp).toBe(30);
});

it('stacks identical consumables across independent drops without merging different effects', () => {
  const m = member();
  const potion = m.state.inventory[0];
  const copy = { ...potion, id: 'another-drop' };
  addItem(m.character, m.state, copy, 2);
  expect(m.state.inventory).toHaveLength(1);
  expect(m.state.inventory[0].quantity).toBe(3);
  expect(occupiedSlots(m.state)).toBe(1);
  addItem(m.character, m.state, { ...copy, id: 'stronger', healing: 12 });
  expect(m.state.inventory).toHaveLength(2);
  expect(occupiedSlots(m.state)).toBe(2);
  const scene = initialScene('Custom place');
  offerGroundItem(scene, removeItem(m.state, potion.id));
  offerGroundItem(scene, removeItem(m.state, potion.id));
  expect(scene.loot).toHaveLength(1);
  expect(scene.loot[0].quantity).toBe(2);
  expect(m.state.inventory[0].quantity).toBe(1);
});
it('does not alter the inventory when stacking would exceed capacity', () => {
  const m = member();
  const potion = m.state.inventory[0];
  addItem(m.character, m.state, potion, 2);
  for (let i = 0; i < 7; i++) addItem(m.character, m.state, baseItem(`held-${i}`, `Held ${i}`, 'relic'));
  expect(() => addItem(m.character, m.state, { ...potion, id: 'extra-drop' })).toThrow('Backpack full');
  expect(m.state.inventory[0].quantity).toBe(3);
  expect(occupiedSlots(m.state)).toBe(8);
});

it('rolls five independent equipment types, allows repeated types, and selects exactly two usable pieces', () => {
  const character = templateCharacter('Spectre');
  character.traits = [{ ...blankTrait('Incorporeal'), blocked: ['body', 'head'], heavyRestricted: true }];
  const allWeapons = rollStartingEquipment(character, () => 1);
  expect(allWeapons.map((item) => item.kind)).toEqual(Array(5).fill('weapon'));
  for (let roll = 1; roll <= 5; roll++) {
    const items = rollStartingEquipment(character, (sides) => Math.min(roll, sides));
    expect(items).toHaveLength(5);
    expect(items.every((item) => usableSlots(character, character.stats, item).length > 0)).toBe(true);
    expect(items.some((item) => ['armour', 'helmet'].includes(item.kind))).toBe(false);
  }
  const corporeal = templateCharacter();
  const draws = [2, 1, 2, 1, 2, 1, 2, 1, 5];
  corporeal.equipmentOptions = rollStartingEquipment(corporeal, () => draws.shift()!);
  expect(corporeal.equipmentOptions.map((item) => item.kind)).toEqual([
    'armour',
    'armour',
    'armour',
    'armour',
    'shield',
  ]);
  const state = initialState(corporeal, 'test');
  const ids = state.starterEquipment.slice(0, 2).map((item) => item.id);
  const before = structuredClone(state);
  for (const invalid of [
    [],
    [ids[0]],
    [ids[0], ids[0]],
    [ids[0], 'forged'],
    [...ids, state.starterEquipment[2].id],
  ]) {
    expect(() => chooseStartingEquipment(corporeal, state, invalid)).toThrow('exactly two');
    expect(state).toEqual(before);
  }
  chooseStartingEquipment(corporeal, state, ids);
  expect(state.equipmentChosen).toBe(true);
  expect(state.equipment.body?.id).toBe(ids[0]);
  expect(state.inventory.find((item) => item.id === ids[1])).toBeDefined();
  expect(() => chooseStartingEquipment(corporeal, state, ids)).toThrow('already chosen');
  const bootsOnly = templateCharacter();
  bootsOnly.traits = [{ ...blankTrait(), blocked: ['left', 'right', 'body', 'head', 'relic'] }];
  expect(
    rollStartingEquipment(bootsOnly, () => {
      throw new Error('Only one choice; no die needed');
    }).every((item) => item.kind === 'boots'),
  ).toBe(true);
});

it('equips one starting relic and stows another when both selected pieces share the relic slot', () => {
  const character = templateCharacter();
  character.equipmentOptions = rollStartingEquipment(character, (sides) => sides);
  expect(character.equipmentOptions.every((item) => item.kind === 'relic')).toBe(true);
  character.selectedEquipmentIds = character.equipmentOptions.slice(0, 2).map((item) => item.id);
  const state = initialState(character, 'test');
  expect(state.equipment.relic?.id).toBe('test-starter-0');
  expect(state.equipment.left).toBeNull();
  expect(state.equipment.right).toBeNull();
  expect(state.inventory.find((item) => item.id === 'test-starter-1')?.quantity).toBe(1);
});

it('preserves generated abilities and equips saved picks when a new campaign begins', () => {
  const character = templateCharacter();
  character.selectedEquipmentIds = character.equipmentOptions.slice(0, 2).map((item) => item.id);
  const normalized = normalizeCharacter(character);
  expect(normalized.abilities).toEqual(character.abilities);
  const state = initialState(normalized, 'campaign');
  expect(state.equipmentChosen).toBe(true);
  expect([state.equipment.right?.name, state.equipment.left?.name]).toEqual(
    character.equipmentOptions.slice(0, 2).map((item) => item.name),
  );
});

it('applies focus bonuses only to matching equipped attacks and deduplicates shared hand slots', () => {
  const m = member();
  const focus = { ...baseItem('focus', 'War focus', 'focus'), scaling: ['STR' as const], attackBonus: 1 };
  addItem(m.character, m.state, focus);
  let e = encounter([m], { defense: 12 });
  e.initiative = e.initiative.filter((entry) => entry.id === m.id);
  runCombat([m], e, input(m), (sides) => (sides === 20 ? 11 : 3));
  expect(e.enemies[0].hp).toBe(30); // A backpack bonus does not apply.
  equip(m.character, m.state, focus.id, 'left');
  runCombat([m], e, input(m), (sides) => (sides === 20 ? 11 : 3));
  expect(e.enemies[0].hp).toBe(24);
  m.state.equipment.left = { ...focus, scaling: ['INT'] };
  runCombat([m], e, input(m), (sides) => (sides === 20 ? 11 : 3));
  expect(e.enemies[0].hp).toBe(24);
  m.state.equipment.left = m.state.equipment.right = focus;
  expect(equipmentBonus(m.state, 'STR', 'attackBonus')).toBe(1);
});

it('uses a combat ability’s saved attribute, real damage, upgrade strength, and one-use limit', () => {
  const m = member();
  const ability = m.character.abilities[0];
  ability.stat = 'INT';
  ability.level = 2;
  m.state.stats.INT = 7;
  m.state.equipment.left = { ...baseItem('focus', 'Spell focus', 'focus'), scaling: ['INT'], attackBonus: 1 };
  const e = encounter([m], { defense: 12 });
  e.initiative = e.initiative.filter((entry) => entry.id === m.id);
  const action = input(m, { main: 'ability', abilityName: ability.name, stat: 'STR' });
  const records: { stat: string; bonus: number | undefined }[] = [];
  runCombat([m], e, action, (sides, _label, _actor, stat, bonus) => {
    records.push({ stat, bonus });
    return sides === 20 ? 11 : 3;
  });
  expect(records[0]).toEqual({ stat: 'INT', bonus: 2 });
  expect(e.enemies[0].hp).toBe(21); // 2d6 (3+3) + INT modifier 1 + level-two bonus 2.
  expect(m.state.abilityUses?.[ability.name]).toBe(1);
  const dice = vi.fn(() => 20);
  const logs = runCombat([m], e, action, dice);
  expect(logs).toContain(
    `${m.character.name}'s ${ability.name} has already been used. It recharges after a successful encounter. The main action is spent.`,
  );
  expect(dice).not.toHaveBeenCalled();
  expect(e.enemies[0].hp).toBe(21);
});

it('spends a strike use on a miss, preserves it while stunned, and doubles ability dice on a critical', () => {
  for (const scenario of ['miss', 'stunned', 'critical']) {
    const m = member();
    const ability = m.character.abilities[0];
    if (scenario === 'stunned') m.state.conditions.push('Stunned');
    const e = encounter([m]);
    e.initiative = e.initiative.filter((entry) => entry.id === m.id);
    const dice = vi.fn((sides: number) => (sides === 20 ? (scenario === 'critical' ? 20 : 2) : 3));
    const logs = runCombat([m], e, input(m, { main: 'ability', abilityName: ability.name }), dice);
    expect(m.state.abilityUses?.[ability.name] ?? 0).toBe(scenario === 'stunned' ? 0 : 1);
    expect(e.enemies[0].hp).toBe(scenario === 'critical' ? 18 : 30);
    expect(logs.filter((log) => log.includes('encounter use is spent'))).toHaveLength(
      scenario === 'stunned' ? 0 : 1,
    );
    if (scenario === 'miss') {
      expect(logs[0]).toBe(`${m.character.name} uses ${ability.name}; its encounter use is spent.`);
      expect(logs[1]).toContain('misses');
    }
    if (scenario === 'stunned') expect(dice).not.toHaveBeenCalled();
  }
});

it('heals any living ally and preserves mend uses for unavailable or full-health targets', () => {
  const caster = member('Healer');
  const ally = member('Construct');
  caster.character.abilities[0] = {
    ...caster.character.abilities[0],
    effect: 'mend',
    stat: 'INT',
    level: 2,
  };
  caster.state.stats.INT = 7;
  ally.character.traits = [blankTrait('Mechanical')];
  ally.state.hp = 10;
  const e = encounter([caster, ally]);
  e.initiative = e.initiative.filter((entry) => entry.id === caster.id);
  const action = input(caster, {
    main: 'ability',
    abilityName: caster.character.abilities[0].name,
    targetId: ally.id,
  });
  runCombat([caster, ally], e, action, () => 4);
  expect(ally.state.hp).toBe(17); // d6=4, modifier=1, upgrade=2.
  resetAbilities(caster.character, caster.state, 'combat');
  ally.state.hp = 0;
  expect(runCombat([caster, ally], e, action, () => 4).some((log) => log.includes('living ally'))).toBe(true);
  ally.state.hp = ally.state.maxHp;
  expect(runCombat([caster, ally], e, action, () => 4).some((log) => log.includes('full health'))).toBe(true);
  expect(caster.state.abilityUses?.[caster.character.abilities[0].name]).toBeUndefined();
});

it('guards an ally against exactly one enemy attack and assists their next attack', () => {
  const caster = member('Protector');
  const ally = member('Fighter');
  caster.character.abilities[0] = { ...caster.character.abilities[0], effect: 'guard', level: 2 };
  const e = encounter([caster, ally]);
  const action = input(caster, {
    main: 'ability',
    abilityName: caster.character.abilities[0].name,
    targetId: ally.id,
  });
  action.enemyTargets = [{ enemyId: 'adversary', memberId: ally.id }];
  runCombat([caster, ally], e, action, (sides) => (sides === 20 ? 13 : 3));
  expect(ally.state.hp).toBe(20); // Defense 10+4 stops the enemy's 13.
  expect(ally.state.abilityGuard).toBeUndefined();
  runCombat([caster, ally], e, { ...action, actions: [] }, (sides) => (sides === 20 ? 13 : 3));
  expect(ally.state.hp).toBe(17);
  resetAbilities(caster.character, caster.state, 'combat');
  caster.character.abilities[0].effect = 'assist';
  e.initiative = e.initiative.filter((entry) => entry.id !== 'adversary');
  action.actions.push(input(ally).actions[0]);
  const dice = [1, 15, 3, 3];
  runCombat([caster, ally], e, action, () => dice.shift()!);
  expect(e.enemies[0].hp).toBe(24);
  expect(ally.state.hp).toBe(17); // Advantage avoids the natural-one backlash.
  expect(ally.state.abilityAssist).toBeUndefined();
  expect(dice).toEqual([]);
});

it('applies focus and assistance to creative attack rolls without increasing their damage', () => {
  const hero = member();
  hero.state.equipment.left = {
    ...baseItem('focus', 'Spark focus', 'focus'),
    scaling: ['INT'],
    attackBonus: 1,
  };
  hero.state.abilityAssist = 1;
  const e = encounter([hero]);
  e.initiative = e.initiative.filter((entry) => entry.id === hero.id);
  const dice = [1, 8, 3];
  runCombat([hero], e, input(hero, { main: 'creative', stat: 'INT', effect: 'damage', dc: 10 }), () =>
    dice.shift()!,
  );
  expect(e.enemies[0].hp).toBe(27); // +2 hits DC 10; only the d6 contributes damage.
  expect(hero.state.hp).toBe(20);
  expect(hero.state.abilityAssist).toBeUndefined();
  expect(dice).toEqual([]);
});

it('gives every rolled focus and relic a usable bonus and scales loot power with rarity', () => {
  const character = templateCharacter();
  for (const kindRoll of [6, 7]) {
    const items = rollStartingEquipment(character, (sides) => (sides === 7 ? kindRoll : 3));
    expect(
      items.every((item) => item.scaling.length && (item.attackBonus === 1 || item.checkBonus === 1)),
    ).toBe(true);
  }
  for (const kind of ['focus', 'relic'] as const) {
    const item = randomLoot('rare', 1, (sides) => sides, { ...loot, kind, scaling: [] });
    expect(item.scaling).toEqual(['INT']);
    expect(kind === 'focus' ? item.attackBonus : item.checkBonus).toBe(3);
  }
});

it('wastes unusable minors and continues enemy damage and conditions without changing inventory', () => {
  for (const scenario of [
    'missing-selection',
    'missing-equip-selection',
    'full-health',
    'wrong-slot',
    'full-backpack',
  ]) {
    const hero = member();
    hero.state.hp = scenario === 'full-health' ? hero.state.maxHp : 10;
    hero.state.conditions = ['Burning'];
    hero.state.conditionTurns.Burning = 2;
    let request = input(hero, { minor: 'heal', minorItemId: hero.state.inventory[0].id });
    if (scenario === 'missing-selection') request.actions[0].minorItemId = null;
    if (scenario === 'missing-equip-selection')
      request = input(hero, { minor: 'equip', minorItemId: 'unselected-item', minorSlot: null });
    if (scenario === 'wrong-slot' || scenario === 'full-backpack') {
      const gear = { ...baseItem('great', 'Great blade', 'weapon'), hands: 2 as const };
      addItem(hero.character, hero.state, gear);
      request = input(hero, { minor: 'equip', minorItemId: gear.id, minorSlot: 'right' });
      if (scenario === 'wrong-slot') request.actions[0].minorSlot = 'body';
      else {
        hero.state.equipment.left = baseItem('shield', 'Shield', 'shield');
        for (let i = 0; i < 6; i++)
          addItem(hero.character, hero.state, baseItem(`relic-${i}`, `Relic ${i}`, 'relic'));
      }
    }
    const inventory = structuredClone(hero.state.inventory);
    const equipment = structuredClone(hero.state.equipment);
    const hp = hero.state.hp;
    const e = encounter([hero]);
    const dice = vi.fn((sides: number) => (sides === 20 ? 12 : 2));
    const logs = runCombat([hero], e, request, dice);
    expect(logs.join(' ')).toContain(
      request.actions[0].minor === 'equip'
        ? 'cannot change equipment during combat'
        : 'minor action is spent',
    );
    expect(hero.state.inventory).toEqual(inventory);
    expect(hero.state.equipment).toEqual(equipment);
    expect(hero.state.hp).toBe(hp - (scenario === 'full-backpack' ? 2 : 4));
    expect(hero.state.conditionTurns.Burning).toBe(1);
    expect(hero.state.abilityUses).toEqual({});
    expect(e.enemies[0].hp).toBe(26);
    expect(e.round).toBe(2);
    expect(dice).toHaveBeenCalledTimes(scenario === 'full-backpack' ? 6 : 5);
  }
});

it('wastes unavailable support main actions and still resolves allies and enemies', () => {
  for (const scenario of ['dead', 'missing', 'full-health', 'guard', 'assist']) {
    const caster = member('Caster');
    const ally = member('Ally');
    const ability = caster.character.abilities[0];
    ability.effect = scenario === 'guard' || scenario === 'assist' ? scenario : 'mend';
    ally.state.hp = scenario === 'dead' ? 0 : scenario === 'full-health' ? ally.state.maxHp : 10;
    const e = encounter([caster, ally]);
    const request = input(caster, {
      main: 'ability',
      abilityName: ability.name,
      targetId: ['missing', 'guard', 'assist'].includes(scenario) ? 'missing-target' : ally.id,
    });
    if (scenario !== 'dead') request.actions.push(input(ally).actions[0]);
    const beforeHp = ally.state.hp;
    const logs = runCombat([caster, ally], e, request, (sides) => (sides === 20 ? 12 : 2));
    expect(logs.join(' ')).toContain('main action is spent and the use is preserved');
    expect(caster.state.abilityUses).toEqual({});
    expect(ally.state.hp).toBe(beforeHp);
    expect(ally.state.abilityGuard).toBeUndefined();
    expect(ally.state.abilityAssist).toBeUndefined();
    expect(caster.state.hp).toBe(18);
    expect(e.enemies[0].hp).toBe(scenario === 'dead' ? 30 : 26);
    expect(e.round).toBe(2);
  }
});

it('rejects structurally invalid combat plans before any actions or rolls', () => {
  const hero = member();
  const e = encounter([hero]);
  const dice = vi.fn(() => 12);
  const duplicate = input(hero);
  duplicate.actions.push(duplicate.actions[0]);
  expect(() => runCombat([hero], e, duplicate, dice)).toThrow('one main and one minor');
  expect(() =>
    runCombat([hero], e, input(hero, { main: 'ability', abilityName: 'Invented ability' }), dice),
  ).toThrow('Choose a current ability');
  expect(dice).not.toHaveBeenCalled();
  expect(e.round).toBe(1);
});

it('redirects normal attacks, saved strikes, and off-hand attacks after an earlier initiative kill', () => {
  for (const main of ['attack', 'ability'] as const) {
    const first = member('First');
    const second = member('Second');
    const e = encounter([first, second], { hp: 2 });
    e.enemies.push({ ...e.enemies[0], id: 'survivor', name: 'Surviving adversary', hp: 30 });
    e.initiative.push({ id: 'survivor', total: 1 });
    second.state.equipment.left = {
      ...baseItem('left-blade', 'Left blade', 'weapon'),
      light: true,
      damage: '1d8',
    };
    second.state.equipment.right = { ...baseItem('right-blade', 'Right blade', 'weapon'), light: true };
    const ability = second.character.abilities[0];
    ability.dice = '2d8';
    ability.bonus = 3;
    const request = input(first);
    request.actions.push(
      input(second, {
        main,
        ...(main === 'ability' ? { abilityName: ability.name } : {}),
        minor: 'offhand',
        weaponSlot: 'left',
      }).actions[0],
    );
    const dice = vi.fn((sides: number) => (sides === 20 ? 12 : 2));
    const logs = runCombat([first, second], e, request, dice);
    expect(logs).toContain(
      `Second redirects their ${main === 'ability' ? ability.name : 'attack'} from Custom adversary to Surviving adversary because Custom adversary fell earlier this round.`,
    );
    expect(logs).toContain(
      'Second redirects their off-hand attack from Custom adversary to Surviving adversary because Custom adversary fell earlier this round.',
    );
    expect(logs.join(' ')).toContain(
      `hits Surviving adversary with ${main === 'ability' ? ability.name : 'Left blade'} for ${main === 'ability' ? 7 : 4}`,
    );
    expect(logs.join(' ')).toContain('hits Surviving adversary with Right blade for 4');
    expect(e.enemies.map((enemy) => enemy.hp)).toEqual([0, main === 'ability' ? 19 : 22]);
    expect(second.state.abilityUses).toEqual(main === 'ability' ? { [ability.name]: 1 } : {});
    expect(dice.mock.calls.map(([sides]) => sides).filter((sides) => sides === 8)).toHaveLength(
      main === 'ability' ? 2 : 1,
    );
    expect(first.state.hp).toBe(18);
    expect(e.round).toBe(2);
  }
});

it('redirects an off-hand attack after its own main attack kills the target', () => {
  for (const main of ['attack', 'ability'] as const) {
    const hero = member();
    hero.state.equipment.left = { ...baseItem('left', 'Left blade', 'weapon'), light: true };
    hero.state.equipment.right = { ...baseItem('right', 'Right blade', 'weapon'), light: true };
    const ability = hero.character.abilities[0];
    const e = encounter([hero], { hp: 2 });
    e.enemies.push({ ...e.enemies[0], id: 'survivor', name: 'Survivor', hp: 30 });
    e.initiative = [{ id: hero.id, total: 15 }];
    const logs = runCombat(
      [hero],
      e,
      input(hero, {
        main,
        ...(main === 'ability' ? { abilityName: ability.name } : {}),
        minor: 'offhand',
      }),
      (sides) => (sides === 20 ? 12 : 2),
    );
    expect(e.enemies.map((enemy) => enemy.hp)).toEqual([0, 26]);
    expect(logs.join(' ')).toContain('redirects their off-hand attack');
    expect(hero.state.abilityUses).toEqual(main === 'ability' ? { [ability.name]: 1 } : {});
  }
});

it('prefers a valid backup, otherwise the first living fighting enemy, after a kill or withdrawal', () => {
  for (const reason of ['kill', 'withdraw']) {
    for (const backup of ['living', 'dead', 'withdrawn']) {
      const first = member('First');
      const second = member('Second');
      const e = encounter([first, second], { hp: 2 });
      const original = e.enemies[0];
      e.enemies.push(
        { ...original, id: 'dead', hp: 0 },
        { ...original, id: 'withdrawn', hp: 30, withdrawn: true },
        { ...original, id: 'default', name: 'First survivor', hp: 30 },
        {
          ...original,
          id: 'backup',
          name: 'Backup survivor',
          hp: backup === 'dead' ? 0 : 30,
          withdrawn: backup === 'withdrawn',
        },
      );
      e.initiative = e.initiative.filter((actor) => actor.id !== original.id);
      const request = input(first, reason === 'withdraw' ? { main: 'creative', effect: 'influence' } : {});
      request.actions.push(input(second, { backupTargetId: 'backup' }).actions[0]);
      const logs = runCombat([first, second], e, request, (sides) => (sides === 20 ? 18 : 2));
      expect(e.enemies.find((enemy) => enemy.id === 'default')!.hp).toBe(backup === 'living' ? 30 : 26);
      expect(e.enemies.find((enemy) => enemy.id === 'backup')!.hp).toBe(
        backup === 'living' ? 26 : backup === 'dead' ? 0 : 30,
      );
      expect(logs.join(' ')).toContain(
        `to ${backup === 'living' ? 'Backup survivor' : 'First survivor'} because Custom adversary ${reason === 'kill' ? 'fell' : 'withdrew'} earlier this round`,
      );
      expect(e.enemies.find((enemy) => enemy.id === 'withdrawn')!.hp).toBe(30);
    }
  }
});

it('keeps explicit target restrictions and creative maneuvers from redirecting', () => {
  for (const main of ['attack', 'ability', 'creative'] as const) {
    const first = member('First');
    const second = member('Second');
    const ability = second.character.abilities[0];
    const e = encounter([first, second], { hp: 2 });
    e.enemies.push({ ...e.enemies[0], id: 'survivor', hp: 30 });
    const request = input(first);
    request.actions.push(
      input(second, {
        main,
        ...(main === 'ability' ? { abilityName: ability.name } : {}),
        ...(main === 'creative' ? { effect: 'stun' } : { allowRetarget: false, minor: 'offhand' }),
      }).actions[0],
    );
    const logs = runCombat([first, second], e, request, (sides) => (sides === 20 ? 12 : 2));
    expect(e.enemies[1].hp).toBe(30);
    expect(e.enemies[1].stunned).toBeUndefined();
    expect(logs.join(' ')).toContain('main action is spent');
    expect(logs.join(' ')).not.toContain('redirects');
    expect(second.state.abilityUses).toEqual({});
  }
});

it('does not redirect pre-existing unavailable targets or ignore a restriction without a target', () => {
  for (const target of ['dead', 'withdrawn', 'restricted-unspecified']) {
    const hero = member();
    const e = encounter([hero]);
    e.enemies[0].hp = target === 'dead' ? 0 : 30;
    e.enemies[0].withdrawn = target === 'withdrawn';
    e.enemies.push({ ...e.enemies[0], id: 'survivor', hp: 30, withdrawn: false });
    e.initiative = [{ id: hero.id, total: 15 }];
    const dice = vi.fn(() => 12);
    const logs = runCombat(
      [hero],
      e,
      input(hero, {
        minor: 'offhand',
        ...(target === 'restricted-unspecified' ? { targetId: null, allowRetarget: false } : {}),
      }),
      dice,
    );
    expect(e.enemies[1].hp).toBe(30);
    expect(logs.join(' ')).toContain('main action is spent');
    expect(logs.join(' ')).not.toContain('redirects');
    expect(dice).not.toHaveBeenCalled();
  }
});

it('rejects unknown primary or backup enemy IDs before resolving any action', () => {
  for (const field of ['targetId', 'backupTargetId']) {
    const first = member('First');
    const second = member('Second');
    const e = encounter([first, second]);
    const before = structuredClone(e);
    const request = input(first);
    request.actions.push(input(second, { [field]: 'unknown' }).actions[0]);
    const dice = vi.fn(() => 12);
    expect(() => runCombat([first, second], e, request, dice)).toThrow('unknown enemy target');
    expect(e).toEqual(before);
    expect(dice).not.toHaveBeenCalled();
  }
});

it.each(['adversary', null])(
  'skips unused attacks on %s when the last enemy falls and still resolves healing',
  (targetId) => {
    for (const main of ['attack', 'ability'] as const) {
      for (const minor of ['offhand', 'heal'] as const) {
        const first = member('First');
        const second = member('Second');
        const ability = second.character.abilities[0];
        second.state.hp = 10;
        const itemId = second.state.inventory[0].id;
        const e = encounter([first, second], { hp: 2 });
        const request = input(first);
        request.actions.push(
          input(second, {
            main,
            targetId,
            ...(main === 'ability' ? { abilityName: ability.name } : {}),
            minor,
            minorItemId: itemId,
          }).actions[0],
        );
        const dice = vi.fn((sides: number) => (sides === 20 ? 12 : 2));
        const logs = runCombat([first, second], e, request, dice);
        expect(e.victory).toBe(true);
        expect(logs).toContain(
          `Second skips their ${main === 'ability' ? ability.name : 'attack'}: no enemies remain${main === 'ability' ? '; the use is preserved' : ''}.`,
        );
        expect(logs.join(' ')).not.toContain(`Second uses ${ability.name}; its encounter use is spent`);
        expect(dice).toHaveBeenCalledTimes(3);
        if (minor === 'heal') {
          expect(logs).toContain('Second uses a healing consumable.');
          expect(second.state.inventory.some((item) => item.id === itemId)).toBe(false);
        } else expect(logs).toContain('Second skips their off-hand attack: no enemies remain.');
      }
    }
  },
);

it('logs a submitted action prevented by being downed before initiative, even after enemies run out of targets', () => {
  const hero = member('Last survivor');
  hero.state.hp = 1;
  const e = encounter([hero]);
  e.enemies.push({ ...e.enemies[0], id: 'other-enemy', name: 'Other enemy' });
  e.initiative = [e.initiative[1], { id: 'other-enemy', total: 1 }, e.initiative[0]];
  const inventory = structuredClone(hero.state.inventory);
  const dice = vi.fn((sides: number) => (sides === 20 ? 12 : 2));
  const logs = runCombat(
    [hero],
    e,
    input(hero, { main: 'ability', abilityName: hero.character.abilities[0].name }),
    dice,
  );
  expect(logs.filter((log) => log.includes('submitted action'))).toEqual([
    'Last survivor cannot carry out their submitted action because they were downed before their turn.',
  ]);
  expect(hero.state.hp).toBe(0);
  expect(isDowned(hero.state)).toBe(true);
  expect(e.escaped).toBe(false);
  expect(hero.state.abilityUses).toEqual({});
  expect(hero.state.inventory).toEqual(inventory);
  expect(e.enemies.map((enemy) => enemy.hp)).toEqual([30, 30]);
  expect(dice).toHaveBeenCalledTimes(2);
});

it('lets an escaped character rejoin with a submitted attack', () => {
  const hero = member('Escaped hero');
  hero.state.conditions = ['Escaped'];
  hero.state.conditionTurns.Escaped = 999;
  const e = encounter([hero]);
  const dice = vi.fn(() => 12);
  const logs = runCombat([hero], e, input(hero), dice);
  expect(logs[0]).toBe('Escaped hero rejoins the fight.');
  expect(logs.some((log) => log.includes('hits Custom adversary'))).toBe(true);
  expect(dice).toHaveBeenCalled();
  expect(hero.state.hp).toBeLessThan(20);
  expect(hero.state.conditions).not.toContain('Escaped');
  expect(e.enemies[0].hp).toBeLessThan(30);
});

it('logs selected minor actions prevented by a fatal main action or successful escape', () => {
  for (const main of ['attack', 'flee'] as const) {
    for (const minor of ['heal', 'offhand'] as const) {
      const hero = member('Unlucky hero');
      hero.state.hp = 1;
      const e = encounter([hero]);
      const inventory = structuredClone(hero.state.inventory);
      const dice = vi.fn((sides: number) => (main === 'flee' ? 12 : sides === 20 ? 1 : 4));
      const logs = runCombat(
        [hero],
        e,
        input(hero, { main, minor, minorItemId: hero.state.inventory[0].id }),
        dice,
      );
      expect(logs.join(' ')).toContain(
        `minor action after ${main === 'flee' ? 'escaping the fight' : 'being downed'}`,
      );
      expect(hero.state.inventory).toEqual(inventory);
      expect(e.enemies[0].hp).toBe(30);
      expect(hero.state.hp).toBe(main === 'flee' ? 1 : 0);
      expect(dice).toHaveBeenCalledTimes(main === 'flee' ? 1 : 2);
    }
  }
});

it('logs actual condition damage and downing without damage to dead or immune characters', () => {
  for (const condition of ['Burning', 'Bleeding', 'Poisoned'] as const) {
    for (const scenario of ['injured', 'dying', 'dead', 'immune']) {
      const hero = member('Afflicted hero');
      hero.state.hp = scenario === 'dying' ? 1 : scenario === 'dead' ? 0 : 10;
      hero.state.conditions = [condition];
      if (scenario === 'immune') hero.character.traits[0].immunities = [condition];
      const hp = hero.state.hp;
      const e = encounter([hero]);
      e.initiative = [];
      const dice = vi.fn(() => 12);
      const logs = runCombat([hero], e, { ...input(hero), actions: [] }, dice);
      const lost = ['dead', 'immune'].includes(scenario) ? 0 : Math.min(hp, condition === 'Burning' ? 2 : 1);
      expect(hero.state.hp).toBe(hp - lost);
      expect(logs).toEqual(
        lost
          ? [
              `Afflicted hero takes ${lost} ${condition} damage${scenario === 'dying' ? ' and is downed' : ''}.`,
            ]
          : [],
      );
      expect(dice).not.toHaveBeenCalled();
    }
  }
  const hero = member('Dying hero');
  hero.state.hp = 1;
  hero.state.conditions = ['Burning', 'Bleeding', 'Poisoned'];
  const e = encounter([hero]);
  e.initiative = [];
  expect(runCombat([hero], e, { ...input(hero), actions: [] }, () => 12)).toEqual([
    'Dying hero takes 1 Burning damage and is downed.',
  ]);
});

it('logs newly applied hit conditions and lethal enemy hits after the player’s action', () => {
  for (const scenario of ['new', 'existing', 'immune', 'lethal']) {
    const hero = member('Target');
    if (scenario === 'existing') hero.state.conditions = ['Burning'];
    if (scenario === 'immune') hero.character.traits[0].immunities = ['Burning'];
    if (scenario === 'lethal') hero.state.hp = 1;
    const e = encounter([hero], { onHit: 'Burning' });
    const logs = runCombat([hero], e, input(hero, { main: 'defend' }), (sides) => (sides === 20 ? 15 : 3));
    expect(logs[0]).toBe('Target defends (+2 defense).');
    expect(logs[1]).toBe(
      `Custom adversary hits Target for 3${scenario === 'lethal' ? ', downing Target' : ''}.`,
    );
    expect(logs.filter((log) => log.includes('becomes Burning'))).toEqual(
      scenario === 'new' ? ["Target becomes Burning from Custom adversary's attack."] : [],
    );
    expect(hero.state.hp).toBe(scenario === 'lethal' ? 0 : scenario === 'immune' ? 17 : 15);
    if (scenario === 'lethal') expect(logs.filter((log) => log.includes('Burning'))).toEqual([]);
  }
});

it('downs a character on their first catastrophic backlash without additional dice', () => {
  for (const main of ['attack', 'flee', 'creative', 'move', 'interact'] as const) {
    const hero = member('Unlucky hero');
    hero.state.hp = 1;
    const e = encounter([hero]);
    const dice = vi.fn((sides: number) => (sides === 20 ? 1 : 4));
    const logs = runCombat([hero], e, input(hero, { main, dc: 10 }), dice);
    expect(logs.join(' ')).toMatch(/down/);
    expect(hero.state.hp).toBe(0);
    expect(isDead(hero.state)).toBe(false);
    expect(isDowned(hero.state)).toBe(true);
    expect(dice).toHaveBeenCalledTimes(main === 'attack' ? 2 : 1);
  }
});

it('logs only HP actually restored by lifesteal and encounter recovery', () => {
  for (const hp of [18, 19, 20]) {
    const hero = member('Vampire');
    hero.character.traits[0].lifesteal = true;
    hero.character.traits[1].regeneration = 1;
    hero.state.hp = hp;
    const e = encounter([hero], { hp: 1 });
    const dice = vi.fn((sides: number) => (sides === 20 ? 12 : 2));
    const logs = runCombat([hero], e, input(hero, { weaponSlot: 'natural' }), dice);
    expect(logs.filter((log) => log.includes('from lifesteal'))).toEqual(
      hp < 20 ? ['Vampire recovers 1 HP from lifesteal.'] : [],
    );
    expect(logs.filter((log) => log.includes('after the successful encounter'))).toEqual(
      hp === 18 ? ['Vampire recovers 1 HP after the successful encounter.'] : [],
    );
    expect(hero.state.hp).toBe(20);
    expect(e.victory).toBe(true);
    expect(dice).toHaveBeenCalledTimes(2);
  }
});

it('logs enemies killed by ordinary attacks, creative actions, or their own backlash', () => {
  for (const source of ['attack', 'creative', 'backlash'] as const) {
    const hero = member('Victor');
    const e = encounter([hero], { hp: 1 });
    const main = source === 'backlash' ? 'defend' : source;
    const dice = vi.fn((sides: number) => (source === 'backlash' ? 1 : sides === 20 ? 12 : 2));
    const logs = runCombat([hero], e, input(hero, { main }), dice);
    expect(logs.join(' ')).toContain(source === 'backlash' ? 'and dies' : 'killing Custom adversary');
    expect(e.enemies[0].hp).toBe(0);
    expect(e.victory).toBe(true);
    expect(dice).toHaveBeenCalledTimes(source === 'backlash' ? 1 : source === 'attack' ? 3 : 2);
  }
});

it('carries out targetless movement and interaction without attacking or evading enemy consequences', () => {
  for (const main of ['move', 'interact'] as const) {
    const hero = member('Mira');
    const description =
      main === 'move' ? 'Move deeper into the next room.' : 'Cry and kiss my friend goodbye.';
    hero.state.abilityAssist = 2;
    hero.state.abilityUses = { [hero.character.abilities[0].name]: 1 };
    const e = encounter([hero]);
    const dice = vi.fn((sides: number, _label: string, _actor: string) => (sides === 20 ? 12 : 2));
    const logs = runCombat([hero], e, input(hero, { main, targetId: null, description }), dice);
    expect(logs[0]).toBe(
      `Mira carries out their ${main === 'move' ? 'movement' : 'interaction'}: ${description}`,
    );
    expect(dice.mock.calls.map(([, , actor]) => actor)).toEqual(['adversary', 'adversary']);
    expect(e.enemies[0].hp).toBe(30);
    expect(e.enemies[0].stunned).toBeUndefined();
    expect(e.enemies[0].withdrawn).toBeUndefined();
    expect(e.escaped).toBe(false);
    expect(hero.state.hp).toBe(18);
    expect(hero.state.conditions).not.toContain('Escaped');
    expect(hero.state.guarding).toBe(false);
    expect(hero.state.abilityAssist).toBe(2);
    expect(hero.state.abilityUses).toEqual({ [hero.character.abilities[0].name]: 1 });
  }
});

it('checks risky movement with only its saved stat and leaves the actor vulnerable on success or failure', () => {
  for (const result of [2, 12, 20, 1]) {
    const hero = member('Mira');
    hero.state.stats.INT = 9;
    hero.state.equipment.left = {
      ...baseItem('focus', 'War focus', 'focus'),
      scaling: ['INT'],
      attackBonus: 3,
    };
    hero.state.abilityAssist = 2;
    const e = encounter([hero]);
    const dice = vi.fn((sides: number, _label: string, actor: string, _stat: string, _bonus?: number) =>
      actor === hero.id ? result : sides === 20 ? 12 : 2,
    );
    const logs = runCombat(
      [hero],
      e,
      input(hero, {
        main: 'move',
        targetId: null,
        stat: 'INT',
        dc: 10,
        description: 'Navigate the passage into the next room.',
      }),
      dice,
    );
    expect(dice.mock.calls[0].slice(2)).toEqual([hero.id, 'INT', 2, 10]);
    expect(dice).toHaveBeenCalledTimes(3);
    expect(logs[0]).toContain(result === 2 || result === 1 ? 'fails to carry out' : 'carries out');
    expect(logs[0]).toContain('Navigate the passage into the next room.');
    expect(hero.state.hp).toBe(result === 1 ? 14 : 18);
    expect(hero.state.conditions).not.toContain('Escaped');
    expect(hero.state.abilityUses).toEqual({});
    expect(hero.state.abilityAssist).toBe(2);
    expect(e.enemies[0].hp).toBe(30);
    expect(e.escaped).toBe(false);
    if (result === 1) expect(logs[1]).toContain('risky movement backfires for 4 damage');
  }
});

it('distinguishes first downing, death on a second downing, and legacy zero-HP dead characters', () => {
  const hero = member();
  damage(hero.state, 999, 'Ordinary injury');
  expect(hero.state.hp).toBe(0);
  expect(isDowned(hero.state)).toBe(true);
  expect(isDead(hero.state)).toBe(false);
  expect(hero.state.deathReason).toBeNull();
  expect(heal(hero.state, 0)).toBe(0);
  expect(isDowned(hero.state)).toBe(true);
  expect(heal(hero.state, 3)).toBe(3);
  expect(hero.state.conditions).not.toContain('Downed');
  damage(hero.state, 999, 'A critical injury', true);
  expect(isDead(hero.state)).toBe(true);
  expect(hero.state.deathReason).toBe('A critical injury');
  expect(() => heal(hero.state, 3)).toThrow('dead');
  const legacy = member();
  legacy.state.hp = 0;
  expect(isDead(legacy.state)).toBe(true);
});

it('always downs on the first zero HP hit and kills on the second, including critical and maximum damage', () => {
  for (const previousDowning of [false, true])
    for (const scenario of [
      { attackRoll: 15, damage: '1d4', dice: [3], attack: 0 },
      { attackRoll: 20, damage: '1d4', dice: [2, 2], attack: 0 },
      { attackRoll: 15, damage: '1d4', dice: [4], attack: 0 },
      { attackRoll: 15, damage: '2d4', dice: [4, 4], attack: 0 },
      { attackRoll: 15, damage: '2d4', dice: [4, 3], attack: 0 },
      { attackRoll: 15, damage: '1d4', dice: [2], attack: 2 },
    ]) {
      const hero = member('Target');
      hero.state.hp = 1;
      hero.state.downedThisEncounter = previousDowning;
      const e = encounter([hero], { damage: scenario.damage, attack: scenario.attack });
      const dice = [...scenario.dice];
      const logs = runCombat([hero], e, input(hero, { main: 'defend' }), (sides) =>
        sides === 20 ? scenario.attackRoll : dice.shift()!,
      );
      expect(hero.state.hp).toBe(0);
      expect(isDead(hero.state)).toBe(previousDowning);
      expect(isDowned(hero.state)).toBe(!previousDowning);
      expect(hero.state.deathReason).toBe(previousDowning ? 'Killed by Custom adversary.' : null);
      expect(logs.join(' ')).toContain(`${previousDowning ? 'killing' : 'downing'} Target`);
      expect(dice).toEqual([]);
      expect(e.escaped).toBe(false);
    }
});

it('keeps downed characters unable to act or self-heal and preserves Downed across condition ticks', () => {
  const hero = member();
  damage(hero.state, hero.state.hp, 'An ordinary hit');
  hero.state.conditionTurns.Downed = 0;
  const inventory = structuredClone(hero.state.inventory);
  expect(() => healWithItem(hero.character, hero.state, inventory[0].id)).toThrow('needs an ally');
  const e = encounter([hero]);
  const dice = vi.fn(() => 12);
  expect(() => runCombat([hero], e, input(hero), dice)).toThrow('unavailable character');
  const emptyPlan = { ...input(hero), actions: [] };
  runCombat([hero], e, emptyPlan, dice);
  runCombat([hero], e, emptyPlan, dice);
  expect(isDowned(hero.state)).toBe(true);
  expect(hero.state.inventory).toEqual(inventory);
  expect(dice).not.toHaveBeenCalled();
  expect(e.escaped).toBe(false);
});

it('lets a healthy ally spend their entire turn using their own consumable on a downed target', () => {
  const healer = member('Healer');
  const ally = member('Ally');
  damage(ally.state, ally.state.hp, 'An ordinary hit');
  ally.state.conditionTurns.Downed = 999;
  const allyInventory = structuredClone(ally.state.inventory);
  const itemId = healer.state.inventory[0].id;
  const e = encounter([healer, ally]);
  e.initiative = e.initiative.filter((entry) => entry.id !== 'adversary');
  const logs = runCombat(
    [healer, ally],
    e,
    input(healer, { main: 'heal', mainItemId: itemId, targetId: ally.id }),
    () => 12,
  );
  expect(ally.state.hp).toBe(6);
  expect(ally.state.conditions).not.toContain('Downed');
  expect(ally.state.conditionTurns.Downed).toBeUndefined();
  expect(ally.state.deathReason).toBeNull();
  expect(healer.state.inventory).toEqual([]);
  expect(ally.state.inventory).toEqual(allyInventory);
  expect(logs.join(' ')).toContain('on Ally, restoring 6 HP');
  expect(healer.state.guarding).toBe(false);
});

it('preserves an ally healing consumable when the target is dead', () => {
  const healer = member('Healer');
  const ally = member('Ally');
  ally.state.downedThisEncounter = true;
  damage(ally.state, ally.state.hp, 'An injury', true);
  const before = structuredClone([healer.state, ally.state]);
  expect(() => healWithItem(healer.character, healer.state, healer.state.inventory[0].id, ally)).toThrow(
    'dead',
  );
  expect([healer.state, ally.state]).toEqual(before);
});

it('lets a saved mend ability help up a downed ally and spends the healer’s combat use', () => {
  const healer = member('Healer');
  const ally = member('Ally');
  const ability = healer.character.abilities[0];
  ability.effect = 'mend';
  damage(ally.state, ally.state.hp, 'An ordinary hit');
  const e = encounter([healer, ally]);
  e.initiative = e.initiative.filter((entry) => entry.id === healer.id);
  runCombat(
    [healer, ally],
    e,
    input(healer, { main: 'ability', abilityName: ability.name, targetId: ally.id }),
    () => 4,
  );
  expect(ally.state.hp).toBe(4);
  expect(isDowned(ally.state)).toBe(false);
  expect(healer.state.abilityUses?.[ability.name]).toBe(1);
  expect(ally.state.abilityUses).toEqual({});
  expect(() => mendWithAbility(healer.character, healer.state, ability.name, ally, () => 4)).toThrow(
    'already been used',
  );
});

it('preserves mend uses and rolls when the healer is downed or the target is dead', () => {
  for (const scenario of ['downed-healer', 'dead-target']) {
    const healer = member('Healer');
    const ally = member('Ally');
    const ability = healer.character.abilities[0];
    ability.effect = 'mend';
    ally.state.downedThisEncounter = scenario === 'dead-target';
    damage(ally.state, ally.state.hp, 'An injury', scenario === 'dead-target');
    if (scenario === 'downed-healer') damage(healer.state, healer.state.hp, 'An injury');
    const before = structuredClone([healer.state, ally.state]);
    const dice = vi.fn(() => 4);
    expect(() => mendWithAbility(healer.character, healer.state, ability.name, ally, dice)).toThrow();
    expect([healer.state, ally.state]).toEqual(before);
    expect(dice).not.toHaveBeenCalled();
  }
});

it('keeps guard and assist unavailable on downed allies', () => {
  for (const effect of ['guard', 'assist'] as const) {
    const healer = member('Support');
    const ally = member('Ally');
    const ability = healer.character.abilities[0];
    ability.effect = effect;
    damage(ally.state, ally.state.hp, 'An injury');
    const e = encounter([healer, ally]);
    e.initiative = e.initiative.filter((entry) => entry.id === healer.id);
    const dice = vi.fn(() => 4);
    const logs = runCombat(
      [healer, ally],
      e,
      input(healer, { main: 'ability', abilityName: ability.name, targetId: ally.id }),
      dice,
    );
    expect(logs.join(' ')).toContain('target is unavailable');
    expect(healer.state.abilityUses).toEqual({});
    expect(ally.state.abilityGuard).toBeUndefined();
    expect(ally.state.abilityAssist).toBeUndefined();
    expect(dice).not.toHaveBeenCalled();
  }
});

describe('shield blocking', () => {
  function fixture() {
    const hero = member();
    const shield = { ...baseItem('block-shield', 'Block shield', 'shield'), defense: 1 };
    hero.state.equipment.left = shield;
    const e = encounter([hero], { damage: '1d12' });
    e.initiative = e.initiative.filter((actor) => actor.id !== hero.id);
    const request = input(hero);
    request.actions = [];
    return { hero, shield, e, request };
  }

  it.each([
    ['Common', 4],
    ['Uncommon', 6],
    ['Rare', 8],
    ['Legendary', 10],
    ['Cursed', 10],
  ] as const)('blocks a hit with the %s shield die without attribute scaling', (rarity, sides) => {
    const { hero, shield, e, request } = fixture();
    shield.rarity = rarity;
    hero.state.stats.CON = 13;
    const hp = hero.state.hp;
    const uses = structuredClone(hero.state.abilityUses);
    const dice = vi.fn((size: number) => (size === 20 ? 15 : size === 12 ? 12 : sides));
    const events: string[] = [];
    const logs = runCombat([hero], e, request, dice, (event) => events.push(event.fact));
    expect(hero.state.hp).toBe(hp - (12 - sides));
    expect(dice.mock.calls.map(([size]) => size)).toEqual([20, 12, sides]);
    expect(dice).toHaveBeenLastCalledWith(sides, 'Block shield: shield block', hero.id, 'CON');
    expect(hero.state.abilityUses).toEqual(uses);
    expect(defense(hero.character, hero.state)).toBe(11);
    expect(logs.join(' ')).toContain(`12 incoming damage; Block shield: 1d${sides} block = ${sides}`);
    expect(events).toEqual(logs);
  });

  it.each(['miss', 'fumble', 'backpack', 'no-shield', 'Stunned', 'Frozen', 'Electrocuted'])(
    'does not roll a block for %s',
    (scenario) => {
      const { hero, shield, e, request } = fixture();
      if (scenario === 'backpack') hero.state.inventory.push({ ...shield, quantity: 1 });
      if (scenario === 'backpack' || scenario === 'no-shield') hero.state.equipment.left = null;
      if (['Stunned', 'Frozen', 'Electrocuted'].includes(scenario)) applyCondition(hero.state, scenario);
      const hp = hero.state.hp;
      const attack = scenario === 'miss' ? 2 : scenario === 'fumble' ? 1 : 15;
      const dice = vi.fn((size: number) => (size === 20 ? attack : 8));
      runCombat([hero], e, request, dice);
      expect(dice.mock.calls.map(([size]) => size)).toEqual(attack < 3 ? [20] : [20, 12]);
      expect(hero.state.hp).toBe(hp - (attack < 3 ? 0 : 8));
    },
  );

  it.each([false, true])(
    'doubles critical attack dice but rolls the block once (critical: %s)',
    (critical) => {
      const { hero, e, request } = fixture();
      const hp = hero.state.hp;
      const dice = vi.fn((size: number) => (size === 20 ? (critical ? 20 : 15) : size === 12 ? 5 : 3));
      runCombat([hero], e, request, dice);
      expect(dice.mock.calls.map(([size]) => size)).toEqual(critical ? [20, 12, 12, 4] : [20, 12, 4]);
      expect(hero.state.hp).toBe(hp - ((critical ? 10 : 5) - 3));
    },
  );

  it.each([false, true])('rolls once per distinct shield (two-handed: %s)', (twoHanded) => {
    const { hero, shield, e, request } = fixture();
    shield.hands = twoHanded ? 2 : 1;
    hero.state.equipment.right = twoHanded
      ? { ...shield }
      : { ...baseItem('second-shield', 'Second shield', 'shield'), rarity: 'Uncommon' };
    const hp = hero.state.hp;
    const dice = vi.fn((size: number) => (size === 20 ? 15 : size === 12 ? 8 : 3));
    runCombat([hero], e, request, dice);
    expect(dice.mock.calls.map(([size]) => size)).toEqual(twoHanded ? [20, 12, 4] : [20, 12, 4, 6]);
    expect(hero.state.hp).toBe(hp - (twoHanded ? 5 : 2));
  });

  it('rolls both shields even when the first fully blocks, and still applies on-hit ailments', () => {
    const { hero, e, request } = fixture();
    hero.state.equipment.right = baseItem('second-shield', 'Second shield', 'shield');
    applyCondition(hero.state, 'Shocked');
    e.enemies[0].onHit = 'Weakened';
    e.enemies[0].equipment = [
      {
        ...baseItem('enemy-weapon', 'Enemy blade', 'weapon'),
        rarity: 'Rare',
        onHit: { ailment: 'Chilled', chance: 25 },
      },
    ];
    const hp = hero.state.hp;
    const dice = vi.fn((size: number) => (size === 20 ? 15 : size === 12 || size === 100 ? 1 : 4));
    const logs = runCombat([hero], e, request, dice);
    expect(hero.state.hp).toBe(hp);
    expect(dice.mock.calls.map(([size]) => size)).toEqual([20, 12, 4, 4, 100]);
    expect(hero.state.conditions).toEqual(expect.arrayContaining(['Shocked', 'Weakened', 'Chilled']));
    expect(logs.join(' ')).toContain('hits Test hero for 0');
  });

  it('blocks every enemy hit, adds Shocked only to remaining damage, and leaves ongoing damage intact', () => {
    const { hero, e, request } = fixture();
    applyCondition(hero.state, 'Shocked');
    applyCondition(hero.state, 'Burning');
    e.enemies.push({ ...e.enemies[0], id: 'second-enemy' });
    e.initiative.push({ id: 'second-enemy', total: 0 });
    const hp = hero.state.hp;
    const dice = vi.fn((size: number) => (size === 20 ? 15 : size === 12 ? 5 : 3));
    runCombat([hero], e, request, dice);
    expect(dice.mock.calls.map(([size]) => size)).toEqual([20, 12, 4, 20, 12, 4]);
    expect(hero.state.hp).toBe(hp - 3 - 3 - 3); // Two (5 - 3 + Shocked) hits, then Burning + Shocked.
    damage(hero.state, 2, 'A fall');
    expect(hero.state.hp).toBe(hp - 12);
    expect(dice).toHaveBeenCalledTimes(6);
  });
});

describe('turn-based ailments and cures', () => {
  it('gives ailments distinct defaults, refreshes them without stacking and honors immunity', () => {
    const hero = member();
    applyCondition(hero.state, 'Burning', hero.character);
    applyCondition(hero.state, 'Poisoned', hero.character);
    expect(hero.state.conditionTurns).toMatchObject({ Burning: 3, Poisoned: 4 });
    tickConditions(hero);
    expect(hero.state.conditionTurns).toMatchObject({ Burning: 2, Poisoned: 3 });
    applyCondition(hero.state, 'Burning', hero.character);
    expect(hero.state.conditions.filter((condition) => condition === 'Burning')).toHaveLength(1);
    expect(hero.state.conditionTurns.Burning).toBe(3);
    hero.character.traits[0].immunities = ['Frozen'];
    expect(applyCondition(hero.state, 'Frozen', hero.character)).toBe(false);
    expect(hero.state.conditions).not.toContain('Frozen');
    for (let i = 0; i < 3; i++) tickConditions(hero);
    expect(hero.state.conditions).toEqual([]);
  });

  it('applies shock to damage events and extra bleeding damage for movement, preserving special states', () => {
    const hero = member();
    hero.state.hp = 20;
    applyCondition(hero.state, 'Shocked');
    applyCondition(hero.state, 'Bleeding');
    hero.state.conditions.push('Escaped');
    hero.state.conditionTurns.Escaped = 999;
    damage(hero.state, 2, 'A hit');
    expect(hero.state.hp).toBe(17);
    expect(tickConditions(hero, true)).toEqual(['Test hero takes 3 Bleeding damage.']);
    expect(hero.state.hp).toBe(14);
    expect(hero.state.conditionTurns.Escaped).toBe(999);
  });

  it('keeps shock active for end-of-turn damage regardless of condition order', () => {
    for (const order of [
      ['Shocked', 'Burning'],
      ['Burning', 'Shocked'],
    ]) {
      const hero = member();
      hero.state.hp = 20;
      hero.state.conditions = order;
      hero.state.conditionTurns = { Shocked: 1, Burning: 1 };
      tickConditions(hero);
      expect(hero.state.hp).toBe(17);
      expect(hero.state.conditions).toEqual([]);
    }
  });

  it.each(['Burning', 'Frozen', 'Weakened', 'Shocked', 'Chilled'] as const)(
    'inflicts %s on enemies and executes its mechanics',
    (condition) => {
      const hero = member();
      const ability = hero.character.abilities[0];
      ability.inflicts = condition;
      ability.dice = '1d4';
      const e = encounter([hero]);
      const rolls = vi.fn((sides: number, _label: string, _actor: string, _stat: string, _bonus?: number) =>
        sides === 20 ? 12 : 2,
      );
      const logs = runCombat([hero], e, input(hero, { main: 'ability', abilityName: ability.name }), rolls);
      const remaining = conditionDuration(condition) - 1;
      if (remaining) {
        expect(e.enemies[0].conditions).toContain(condition);
        expect(e.enemies[0].conditionTurns![condition]).toBe(remaining);
      } else {
        expect(e.enemies[0].conditions).not.toContain(condition);
        expect(e.enemies[0].conditionTurns![condition]).toBeUndefined();
      }
      expect(logs.join(' ')).toContain(`becomes ${condition}`);
      if (condition === 'Burning') expect(e.enemies[0].hp).toBe(26);
      if (condition === 'Frozen') expect(hero.state.hp).toBe(hero.state.maxHp);
      if (condition === 'Weakened')
        expect(rolls.mock.calls.find((call) => call[1]?.includes('attacks'))?.[4]).toBe(-2);
    },
  );

  it('does not inflict on a miss and counts ailment kills toward victory', () => {
    const hero = member();
    const ability = hero.character.abilities[0];
    ability.inflicts = 'Burning';
    ability.dice = '1d4';
    const missed = encounter([hero], { defense: 30 });
    runCombat([hero], missed, input(hero, { main: 'ability', abilityName: ability.name }), () => 2);
    expect(missed.enemies[0].conditions).toEqual([]);
    hero.state.abilityUses = {};
    const dying = encounter([hero], { hp: 3 });
    runCombat([hero], dying, input(hero, { main: 'ability', abilityName: ability.name }), (sides) =>
      sides === 20 ? 12 : 1,
    );
    expect(dying.enemies[0].hp).toBe(0);
    expect(dying.victory).toBe(true);
  });

  it('heals and cures together, including a full-HP target and a pure cleanse', () => {
    const caster = member('Healer');
    const target = member('Patient');
    const ability = caster.character.abilities[0];
    ability.effect = 'mend';
    ability.stat = 'INT';
    ability.dice = '1d4';
    ability.cures = ['Shocked'];
    target.state.hp = 10;
    applyCondition(target.state, 'Shocked');
    expect(mendWithAbility(caster.character, caster.state, ability.name, target, () => 4)).toBe(4);
    expect(target.state.hp).toBe(14);
    expect(target.state.conditions).not.toContain('Shocked');
    caster.state.abilityUses = {};
    target.state.hp = target.state.maxHp;
    applyCondition(target.state, 'Shocked');
    expect(mendWithAbility(caster.character, caster.state, ability.name, target, () => 4)).toBe(0);
    expect(matchingCures(ability, target.state)).toEqual([]);
    caster.state.abilityUses = {};
    ability.effect = 'cleanse';
    delete ability.dice;
    applyCondition(target.state, 'Shocked');
    expect(
      mendWithAbility(caster.character, caster.state, ability.name, target, () => {
        throw Error('Cleanse must not roll HP');
      }),
    ).toBe(0);
    expect(target.state.conditions).toEqual([]);
    expect(caster.state.abilityUses![ability.name]).toBe(1);
  });

  it('spends a treatment main action, clearing Burning before damage only on success', () => {
    for (const succeeds of [true, false]) {
      const hero = member();
      applyCondition(hero.state, 'Burning');
      const e = encounter([hero]);
      e.initiative = [{ id: hero.id, total: 15 }];
      const before = hero.state.hp;
      runCombat(
        [hero],
        e,
        input(hero, {
          main: 'interact',
          targetId: null,
          cureCondition: 'Burning',
          description: 'Smother the fire with the nearby blanket.',
          dc: 10,
        }),
        () => (succeeds ? 12 : 2),
      );
      expect(hero.state.conditions.includes('Burning')).toBe(!succeeds);
      expect(hero.state.hp).toBe(before - (succeeds ? 0 : 2));
      expect(e.enemies[0].hp).toBe(30);
    }
  });

  it.each(['Frozen', 'Electrocuted', 'Stunned'] as const)(
    'enforces %s action limits without spending blocked resources',
    (condition) => {
      const hero = member();
      hero.state.hp = 10;
      applyCondition(hero.state, condition);
      const ability = hero.character.abilities[0];
      const item = hero.state.inventory.find((item) => item.healing > 0)!;
      const e = encounter([hero]);
      e.initiative = [{ id: hero.id, total: 15 }];
      runCombat(
        [hero],
        e,
        input(hero, { main: 'ability', abilityName: ability.name, minor: 'heal', minorItemId: item.id }),
        () => 4,
      );
      expect(hero.state.abilityUses?.[ability.name]).toBeUndefined();
      expect(hero.state.inventory.some((saved) => saved.id === item.id)).toBe(condition !== 'Stunned');
      expect(e.enemies[0].hp).toBe(30);
    },
  );
});

it.each(['normal', 'repair', 'necrotic'])(
  'discards legacy %s healing types and lets items and Mend heal any living character',
  (mode) => {
    const healer = member('Healer');
    const ally = member('Ally');
    ally.character = characterSchema.parse({
      ...ally.character,
      traits: ally.character.traits.map((trait) => ({ ...trait, healing: mode })),
    });
    healer.character = characterSchema.parse({
      ...healer.character,
      abilities: healer.character.abilities.map((ability) => ({ ...ability, healing: 'necrotic' })),
    });
    expect(ally.character.traits.every((trait) => !('healing' in trait))).toBe(true);
    expect(healer.character.abilities.every((ability) => !('healing' in ability))).toBe(true);
    healer.character.abilities[0].effect = 'mend';
    ally.state.hp = 1;
    expect(healWithItem(healer.character, healer.state, healer.state.inventory[0].id, ally)).toBe(6);
    expect(healer.state.inventory).toHaveLength(0);
    expect(
      mendWithAbility(healer.character, healer.state, healer.character.abilities[0].name, ally, () => 4),
    ).toBe(4);
    expect(ally.state.hp).toBe(11);
    expect(healer.state.abilityUses?.[healer.character.abilities[0].name]).toBe(1);
    expect(abilityMechanics(healer.character.abilities[0])).not.toMatch(/normal|repair|necrotic/);
  },
);
