import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  blankTrait,
  combatSchema,
  enemySchema,
  templateCharacter,
  type Encounter,
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
  grantXp,
  healWithItem,
  heal,
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
  runCombat,
  scaling,
  equipmentBonus,
  resetAbilities,
  RuleError,
} from '../shared/rules';
import { localDice } from '../server/random';

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
      requirements: { STR: 50, DEX: 0, INT: 0 },
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

describe('customized roguelike mechanics', () => {
  it('derives balanced stats from custom traits, including negative modifiers', () => {
    const c = templateCharacter('Zed', 'Elf-spider warlord');
    c.traits = [
      { ...blankTrait('Many limbs'), stats: { STR: 3, DEX: 1, INT: -1 }, blocked: ['boots'], natural: true },
    ];
    expect(normalizeCharacter(c).stats).toEqual({ STR: 8, DEX: 6, INT: 4 });
    expect([modifier(4), modifier(5), modifier(6), modifier(9)]).toEqual([-1, 0, 0, 2]);
    c.traits[0].stats = { STR: 4, DEX: 4, INT: 4 };
    expect(() => normalizeCharacter(c)).toThrow('balance budget');
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
  it('averages hybrid modifiers and grants a reward choice and HP on every level', () => {
    const m = member();
    m.state.stats = { STR: 9, DEX: 4, INT: 5 };
    expect(scaling(m.state, { ...baseItem('hybrid', 'Hybrid', 'weapon'), scaling: ['STR', 'DEX'] })).toBe(0);
    m.state.stats = { STR: 5, DEX: 5, INT: 5 };
    grantXp(m.character, m.state, 230);
    expect(m.state).toMatchObject({ level: 3, xp: 30, pendingLevelUps: 2, hp: 30, maxHp: 30 });
    expect(() => gainAttributes(m.character, m.state, ['STR'])).toThrow('exactly two');
    gainAttributes(m.character, m.state, ['STR', 'STR']);
    expect(m.state).toMatchObject({ pendingLevelUps: 2, hp: 32, maxHp: 32 });
  });
  it('cannot heal, award XP to, or damage a dead character again', () => {
    const m = member();
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
    const dice = [20, 3, 3];
    runCombat([m], e, input(m), () => dice.shift()!);
    expect(e.victory).toBe(true);
    expect(m.state.level).toBe(2);
    expect(m.state.pendingLevelUps).toBe(1);
    expect(dice).toEqual([]);
  });
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
      expect(dice.mock.calls.map(([sides]) => sides)).toEqual([20, hand === 'left' ? 8 : 6]);
      expect(logs.some((log) => log.includes(m.state.equipment[hand]!.name))).toBe(true);
      expect(e.enemies[0].hp).toBe(27);
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
      expect(dice.mock.calls.map(([sides]) => sides)).toEqual([20, 6]);
      expect(e.enemies[0].hp).toBe(27);
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
    expect(dice.mock.calls.map(([sides]) => sides)).toEqual([20, 6]);
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
    const dice = [12, 2, 12, 2, 2];
    runCombat([m], e, input(m, { minor: 'offhand' }), () => dice.shift()!);
    expect(e.enemies[0].hp).toBe(24); // 2+2 main; 2 off-hand
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
    expect(dice.mock.calls.map(([sides]) => sides)).toEqual([20, 6, 20, 8]);
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
      expect(e.enemies[0].hp).toBe(27);
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
    const item = randomLoot(
      'new-id',
      { number: 2, biome: 'A user-created world', atmosphere: '', hazard: '', encounters: 0, cleared: false },
      () => 100,
      { ...loot, scaling: ['STR'] },
    );
    expect(item).toMatchObject({ name: 'Custom item', rarity: 'Legendary', damage: '2d8' });
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
  bootsOnly.traits = [{ ...blankTrait(), blocked: ['left', 'right', 'body', 'head'] }];
  expect(
    rollStartingEquipment(bootsOnly, () => {
      throw new Error('Only one choice; no die needed');
    }).every((item) => item.kind === 'boots'),
  ).toBe(true);
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
  expect(e.enemies[0].hp).toBe(27);
  m.state.equipment.left = { ...focus, scaling: ['INT'] };
  runCombat([m], e, input(m), (sides) => (sides === 20 ? 11 : 3));
  expect(e.enemies[0].hp).toBe(27);
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
  expect(() => runCombat([m], e, action, () => 20)).toThrow('already been used');
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

it('heals a compatible living ally and preserves mend uses for incompatible, unavailable, or full-health targets', () => {
  const caster = member('Healer');
  const ally = member('Construct');
  caster.character.abilities[0] = {
    ...caster.character.abilities[0],
    effect: 'mend',
    stat: 'INT',
    healing: 'repair',
    level: 2,
  };
  caster.state.stats.INT = 7;
  ally.character.traits = [{ ...blankTrait('Mechanical'), healing: 'repair' }];
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
  caster.character.abilities[0].healing = 'normal';
  expect(runCombat([caster, ally], e, action, () => 4).some((log) => log.includes('incompatible'))).toBe(
    true,
  );
  expect(caster.state.abilityUses?.[caster.character.abilities[0].name]).toBeUndefined();
  ally.state.hp = 0;
  expect(runCombat([caster, ally], e, action, () => 4).some((log) => log.includes('living ally'))).toBe(true);
  ally.state.hp = ally.state.maxHp;
  caster.character.abilities[0].healing = 'repair';
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
  const dice = [1, 15, 3];
  runCombat([caster, ally], e, action, () => dice.shift()!);
  expect(e.enemies[0].hp).toBe(27);
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
    const item = randomLoot('rare', initialScene('Test').floor, () => 100, { ...loot, kind, scaling: [] });
    expect(item.scaling).toEqual(['INT']);
    expect(kind === 'focus' ? item.attackBonus : item.checkBonus).toBe(3);
  }
});

it('wastes unusable minors and continues enemy damage and conditions without changing inventory', () => {
  for (const scenario of [
    'missing-selection',
    'missing-equip-selection',
    'incompatible-healing',
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
    if (scenario === 'incompatible-healing') hero.character.traits[0].healing = 'repair';
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
    expect(hero.state.hp).toBe(hp - 4);
    expect(hero.state.conditionTurns.Burning).toBe(1);
    expect(hero.state.abilityUses).toEqual({});
    expect(e.enemies[0].hp).toBe(28);
    expect(e.round).toBe(2);
    expect(dice).toHaveBeenCalledTimes(4);
  }
});

it('wastes unavailable support main actions and still resolves allies and enemies', () => {
  for (const scenario of ['dead', 'missing', 'full-health', 'incompatible', 'guard', 'assist']) {
    const caster = member('Caster');
    const ally = member('Ally');
    const ability = caster.character.abilities[0];
    ability.effect = scenario === 'guard' || scenario === 'assist' ? scenario : 'mend';
    ally.state.hp = scenario === 'dead' ? 0 : scenario === 'full-health' ? ally.state.maxHp : 10;
    if (scenario === 'incompatible') ally.character.traits[0].healing = 'repair';
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
    expect(e.enemies[0].hp).toBe(scenario === 'dead' ? 30 : 28);
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

it('wastes an action against a target slain earlier in initiative without redirecting it', () => {
  for (const main of ['attack', 'ability'] as const) {
    const first = member('First');
    const second = member('Second');
    const e = encounter([first, second], { hp: 2 });
    e.enemies.push({ ...e.enemies[0], id: 'survivor', name: 'Surviving adversary', hp: 30 });
    e.initiative.push({ id: 'survivor', total: 1 });
    const request = input(first);
    request.actions.push(
      input(second, {
        main,
        ...(main === 'ability' ? { abilityName: second.character.abilities[0].name } : {}),
        minor: 'offhand',
      }).actions[0],
    );
    const logs = runCombat([first, second], e, request, (sides) => (sides === 20 ? 12 : 2));
    expect(logs.join(' ')).toContain('main action is spent');
    expect(logs.join(' ')).toContain('off-hand target is unavailable');
    expect(e.enemies.map((enemy) => enemy.hp)).toEqual([0, 30]);
    expect(second.state.abilityUses).toEqual({});
    expect(first.state.hp).toBe(18);
    expect(e.round).toBe(2);
  }
});

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
        `minor action after ${main === 'flee' ? 'escaping the fight' : 'dying'}`,
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

it('logs fatal attack, escape, and improvised backlash without additional dice', () => {
  for (const main of ['attack', 'flee', 'creative', 'move', 'interact'] as const) {
    const hero = member('Unlucky hero');
    hero.state.hp = 1;
    const e = encounter([hero]);
    const dice = vi.fn((sides: number) => (sides === 20 ? 1 : 4));
    const logs = runCombat([hero], e, input(hero, { main, dc: 10 }), dice);
    expect(logs.join(' ')).toMatch(/death|dies/);
    expect(hero.state.hp).toBe(0);
    expect(isDead(hero.state)).toBe(true);
    expect(isDowned(hero.state)).toBe(false);
    expect(dice).toHaveBeenCalledTimes(main === 'attack' ? 2 : 1);
  }
});

it('logs only HP actually restored by lifesteal and victory regeneration', () => {
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
    expect(logs.filter((log) => log.includes('from regeneration'))).toEqual(
      hp === 18 ? ['Vampire recovers 1 HP from regeneration after victory.'] : [],
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
    expect(dice).toHaveBeenCalledTimes(source === 'backlash' ? 1 : 2);
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

it('distinguishes ordinary downing, critical death, and legacy zero-HP dead characters', () => {
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

it('makes lethal enemy crits and full natural maximum damage fatal, excluding modifiers and partial maxima', () => {
  for (const scenario of [
    { attackRoll: 15, damage: '1d4', dice: [3], attack: 0, fatal: false },
    { attackRoll: 20, damage: '1d4', dice: [2, 2], attack: 0, fatal: true },
    { attackRoll: 15, damage: '1d4', dice: [4], attack: 0, fatal: true },
    { attackRoll: 15, damage: '2d4', dice: [4, 4], attack: 0, fatal: true },
    { attackRoll: 15, damage: '2d4', dice: [4, 3], attack: 0, fatal: false },
    { attackRoll: 15, damage: '1d4', dice: [2], attack: 2, fatal: false },
  ]) {
    const hero = member('Target');
    hero.state.hp = 1;
    const e = encounter([hero], { damage: scenario.damage, attack: scenario.attack });
    const dice = [...scenario.dice];
    const logs = runCombat([hero], e, input(hero, { main: 'defend' }), (sides) =>
      sides === 20 ? scenario.attackRoll : dice.shift()!,
    );
    expect(hero.state.hp).toBe(0);
    expect(isDead(hero.state)).toBe(scenario.fatal);
    expect(isDowned(hero.state)).toBe(!scenario.fatal);
    expect(hero.state.deathReason).toBe(scenario.fatal ? 'Killed by Custom adversary.' : null);
    expect(logs.join(' ')).toContain(`${scenario.fatal ? 'killing' : 'downing'} Target`);
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

it('lets a healthy ally spend their own healing consumable as a minor action to help up a downed target', () => {
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
    input(healer, { main: 'defend', minor: 'heal', minorItemId: itemId, minorTargetId: ally.id }),
    () => 12,
  );
  expect(ally.state.hp).toBe(6);
  expect(ally.state.conditions).not.toContain('Downed');
  expect(ally.state.conditionTurns.Downed).toBeUndefined();
  expect(ally.state.deathReason).toBeNull();
  expect(healer.state.inventory).toEqual([]);
  expect(ally.state.inventory).toEqual(allyInventory);
  expect(logs.join(' ')).toContain('helping them up');
});

it('preserves an ally healing consumable when the target is dead or incompatible', () => {
  for (const incompatible of [false, true]) {
    const healer = member('Healer');
    const ally = member('Ally');
    damage(ally.state, ally.state.hp, 'An injury', !incompatible);
    if (incompatible) ally.character.traits[0].healing = 'repair';
    const before = structuredClone([healer.state, ally.state]);
    expect(() => healWithItem(healer.character, healer.state, healer.state.inventory[0].id, ally)).toThrow(
      incompatible ? 'incompatible' : 'dead',
    );
    expect([healer.state, ally.state]).toEqual(before);
  }
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

it('preserves mend uses and rolls when the healer is downed or the target is dead or incompatible', () => {
  for (const scenario of ['downed-healer', 'dead-target', 'incompatible']) {
    const healer = member('Healer');
    const ally = member('Ally');
    const ability = healer.character.abilities[0];
    ability.effect = 'mend';
    damage(ally.state, ally.state.hp, 'An injury', scenario === 'dead-target');
    if (scenario === 'downed-healer') damage(healer.state, healer.state.hp, 'An injury');
    if (scenario === 'incompatible') ally.character.traits[0].healing = 'repair';
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
