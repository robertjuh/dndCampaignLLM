import { describe, expect, it } from 'vitest';
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
  initialState,
  modifier,
  normalizeCharacter,
  occupiedSlots,
  offerGroundItem,
  initialScene,
  removeItem,
  randomLoot,
  runCombat,
  scaling,
} from '../shared/rules';
import { localDice } from '../server/random';

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
    damage(m.state, 999, 'Fell into a chasm');
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
