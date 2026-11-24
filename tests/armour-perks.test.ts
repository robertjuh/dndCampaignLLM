import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  combatSchema,
  enemySchema,
  itemSchema,
  templateCharacter,
  type Encounter,
  type Item,
  type Member,
  type Slot,
} from '../shared/schema';
import { armourPerks, perkKinds, protectiveKinds, type ArmourPerk } from '../shared/equipment-perks';
import {
  addItem,
  applyCondition,
  baseItem,
  defense,
  effectiveStats,
  equip,
  grantEquipmentPowers,
  healWithItem,
  helpUp,
  initialState,
  initiativeBonus,
  itemAttributes,
  maxHp,
  mendWithAbility,
  perkBonus,
  randomLoot,
  recoverAfterEncounter,
  rollStartingEquipment,
  runCombat,
  tickConditions,
  unequip,
  type Dice,
} from '../shared/rules';

function hero(): Member {
  const character = templateCharacter('Perk bearer');
  character.traits = [];
  const id = randomUUID();
  const state = initialState(character, id);
  state.stats = { STR: 5, DEX: 5, INT: 5, CHA: 5, CON: 5, WIS: 5 };
  state.hp = state.maxHp = 20;
  state.equipment.right = { ...baseItem('blade', 'Blade', 'weapon'), scaling: ['STR'], light: true };
  return { id, character, state, playerId: id, playerName: 'Player', characterId: id, active: true };
}
function piece(slot: Slot, perk: ArmourPerk, rarity: Item['rarity'] = 'Rare'): Item {
  const kind = {
    body: 'armour',
    head: 'helmet',
    boots: 'boots',
    left: 'shield',
    right: 'shield',
    relic: 'relic',
  }[slot] as Item['kind'];
  return { ...baseItem(`${perk}-${slot}`, perk, kind), rarity, perk };
}
function wear(member: Member, perk: ArmourPerk, slots: Slot[], rarity: Item['rarity'] = 'Rare') {
  for (const slot of slots) member.state.equipment[slot] = piece(slot, perk, rarity);
}
function fight(members: Member[], enemies = 1): Encounter {
  return {
    enemies: Array.from({ length: enemies }, (_, i) => ({
      ...enemySchema.parse({
        id: `foe-${i}`,
        name: `Foe ${i}`,
        tier: 'normal',
        hp: 200,
        defense: 10,
        attack: 0,
        damage: '1d8',
        description: '',
        tactic: 'Attack',
      }),
      maxHp: 200,
      initiative: 1,
      conditions: [],
      conditionTurns: {},
    })),
    initiative: [
      ...members.map((member) => ({ id: member.id, total: 20 })),
      ...Array.from({ length: enemies }, (_, i) => ({ id: `foe-${i}`, total: 1 })),
    ],
    round: 1,
    victory: false,
    escaped: false,
  };
}
function plan(member: Member, overrides = {}) {
  return combatSchema.parse({
    actions: [
      {
        memberId: member.id,
        main: 'interact',
        targetId: null,
        stat: 'STR',
        description: 'Watch',
        minor: 'none',
        minorItemId: null,
        ...overrides,
      },
    ],
    enemyTargets: [],
    loot: { name: 'Loot', kind: 'weapon', scaling: ['STR'], hands: 1, light: false, description: '' },
  });
}
const dice = (sides: number) => (sides === 20 ? 15 : Math.min(4, sides));

it('rolls only eligible new-item perks, preserves old items, and gives Common protective pieces +1 and -1', () => {
  const seen = new Set<ArmourPerk>();
  for (const kind of protectiveKinds)
    for (const rarity of ['Common', 'Uncommon', 'Rare', 'Cursed', 'Legendary'] as const) {
      for (let choice = 1; choice <= armourPerks.length; choice++) {
        const item = randomLoot(
          'new',
          1,
          (sides) => Math.min(choice, sides),
          { name: 'Gear', kind, scaling: [], hands: 1, light: false, description: '' },
          rarity,
        );
        expect(itemSchema.safeParse(item).success).toBe(true);
        if (rarity === 'Common') {
          expect(item.attributeBonus?.amount).toBe(1);
          expect(item.attributePenalty).toBeDefined();
          expect(item.perk).toBeUndefined();
          expect(itemAttributes(item).reduce((sum, [, value]) => sum + value, 0)).toBe(0);
        } else {
          expect(perkKinds[item.perk!]).toContain(kind);
          expect(item.attributePenalty).toBeUndefined();
          seen.add(item.perk!);
        }
      }
    }
  expect([...seen].sort()).toEqual([...armourPerks].sort());
  expect(Object.values(perkKinds).every((kinds) => new Set(kinds).size >= 2)).toBe(true);
  const old = grantEquipmentPowers(
    { ...baseItem('old', 'Old coat', 'armour'), attributeBonus: { stat: 'STR', amount: 1 } },
    () => 1,
  );
  expect(old.attributePenalty).toBeUndefined();
  expect(old.perk).toBeUndefined();
  expect(
    rollStartingEquipment(templateCharacter(), () => 1)
      .filter((item) => protectiveKinds.some((kind) => kind === item.kind))
      .every((item) => !!item.attributePenalty),
  ).toBe(true);
  expect(itemSchema.safeParse({ ...piece('boots', 'thorns'), rarity: 'Common' }).success).toBe(false);
  expect(itemSchema.safeParse(piece('boots', 'thorns')).success).toBe(false);
});

it('cancels matching attributes and stacks distinct pieces without counting two-handed gear twice', () => {
  const member = hero();
  const balanced = {
    ...baseItem('balanced', 'Balanced', 'shield'),
    hands: 2 as const,
    attributeBonus: { stat: 'STR' as const, amount: 1 },
    attributePenalty: 'STR' as const,
  };
  member.state.equipment.left = member.state.equipment.right = balanced;
  expect(itemAttributes(balanced)).toEqual([]);
  expect(effectiveStats(member.state)).toEqual(member.state.stats);
  member.state.equipment.head = {
    ...baseItem('tradeoff', 'Tradeoff', 'helmet'),
    attributeBonus: { stat: 'DEX', amount: 1 },
    attributePenalty: 'CON',
  };
  expect(effectiveStats(member.state)).toMatchObject({ DEX: 6, CON: 4 });
  wear(member, 'enduring', ['body', 'head', 'boots', 'left', 'right']);
  member.state.equipment.boots!.rarity = 'Legendary';
  member.state.equipment.left!.rarity = 'Uncommon';
  member.state.equipment.right!.rarity = 'Legendary';
  expect(perkBonus(member.state, 'enduring')).toBe(10);
  member.state.equipment.left = member.state.equipment.right;
  expect(perkBonus(member.state, 'enduring')).toBe(10);
  member.state.inventory.push({ ...piece('head', 'enduring', 'Legendary'), quantity: 1 });
  expect(perkBonus(member.state, 'enduring')).toBe(10);
});

it('adds Hardy maximum HP without healing on swaps or counting stowed pieces', () => {
  const member = hero();
  member.state.hp = 15;
  for (const slot of ['body', 'boots'] as const) {
    const item = piece(slot, 'hardy');
    addItem(member.character, member.state, item);
    equip(member.character, member.state, item.id, slot);
  }
  expect(member.state.maxHp).toBe(28);
  expect(member.state.hp).toBe(15);
  member.state.hp = 28;
  unequip(member.character, member.state, 'body');
  expect(member.state.maxHp).toBe(24);
  expect(member.state.hp).toBe(24);
  expect(maxHp(member.character, member.state)).toBe(24);
});

it('stacks Vigilant with attribute modifiers and initiative penalties', () => {
  const member = hero();
  wear(member, 'vigilant', ['head', 'boots']);
  member.state.equipment.body = { ...baseItem('heavy', 'Heavy coat', 'armour'), initiativePenalty: -2 };
  expect(initiativeBonus(member.state)).toBe(2);
  member.state.stats.DEX = 7;
  expect(initiativeBonus(member.state)).toBe(3);
});

it('stacks Bulwark during Defend and Last Stand only while conscious below half HP', () => {
  const member = hero();
  wear(member, 'bulwark', ['body', 'left']);
  const encounter = fight([member], 0);
  encounter.enemies = fight([member]).enemies;
  runCombat([member], encounter, plan(member, { main: 'defend' }), dice);
  expect(defense(member.character, member.state)).toBe(16);
  runCombat([member], encounter, plan(member), dice);
  expect(defense(member.character, member.state)).toBe(10);
  wear(member, 'last-stand', ['body', 'left']);
  member.state.hp = 10;
  expect(defense(member.character, member.state)).toBe(10);
  member.state.hp = 9;
  expect(defense(member.character, member.state)).toBe(14);
  member.state.hp = 0;
  expect(defense(member.character, member.state)).toBe(10);
});

it('uses combined Reinforced strength on the first hit each round, including across saved rounds', () => {
  let member = hero();
  wear(member, 'reinforced', ['body', 'head']);
  let encounter = fight([member], 2);
  let logs = runCombat([member], encounter, plan(member), dice);
  expect(member.state.hp).toBe(16);
  expect(logs.filter((line) => line.includes('Reinforced prevents'))).toHaveLength(1);
  ({ member, encounter } = JSON.parse(JSON.stringify({ member, encounter })));
  logs = runCombat([member], encounter, plan(member), dice);
  expect(member.state.hp).toBe(12);
  expect(logs.filter((line) => line.includes('Reinforced prevents'))).toHaveLength(1);
});

it('stacks Thorns once per round after actual HP loss and permits it to defeat the attacker', () => {
  const member = hero();
  wear(member, 'thorns', ['body', 'left']);
  const encounter = fight([member], 2);
  const logs = runCombat([member], encounter, plan(member), (sides, label) =>
    label.includes('shield block') ? 1 : dice(sides),
  );
  expect(encounter.enemies.map((enemy) => enemy.hp)).toEqual([196, 200]);
  expect(logs.filter((line) => line.includes('Thorns deals'))).toHaveLength(1);
  const blocked = hero();
  wear(blocked, 'thorns', ['body', 'left']);
  const blockedFight = fight([blocked]);
  runCombat([blocked], blockedFight, plan(blocked), dice);
  expect(blocked.state.hp).toBe(20);
  expect(blockedFight.enemies[0].hp).toBe(200);
  encounter.enemies[0].hp = 4;
  encounter.enemies[1].hp = 0;
  runCombat([member], encounter, plan(member), (sides, label) =>
    label.includes('shield block') ? 1 : dice(sides),
  );
  expect(encounter.victory).toBe(true);
  expect(member.state.combatPerks).toBeUndefined();
});

it('reduces only the extra critical dice with stacked Fortified', () => {
  const member = hero();
  wear(member, 'fortified', ['body', 'head']);
  const encounter = fight([member]);
  const logs = runCombat([member], encounter, plan(member), (sides) => (sides === 20 ? 20 : 4));
  expect(member.state.hp).toBe(16);
  expect(logs.join(' ')).toContain('Fortified prevents 4 critical damage');
  runCombat([member], encounter, plan(member), dice);
  expect(member.state.hp).toBe(12);
});

it('stacks Escape Artist on the saved fleeing check and clears encounter perks after escape', () => {
  const member = hero();
  wear(member, 'escape-artist', ['head', 'boots']);
  const encounter = fight([member]);
  const roll = vi.fn(() => 8);
  runCombat([member], encounter, plan(member, { main: 'flee', dc: 10 }), roll);
  expect(encounter.escaped).toBe(true);
  expect(roll.mock.calls[0]).toEqual([20, 'Flee combat', member.id, 'DEX', 4, 10]);
  expect(member.state.combatPerks).toBeUndefined();
});

it.each(['scrambler', 'quickstep'] as const)('stacks %s until the next initiative turn', (perk) => {
  const member = hero();
  wear(member, perk, perk === 'scrambler' ? ['boots', 'left'] : ['head', 'boots']);
  const encounter = fight([member], 0);
  encounter.enemies = fight([member]).enemies;
  runCombat(
    [member],
    encounter,
    plan(member, perk === 'scrambler' ? { main: 'flee', dc: 20 } : { main: 'move' }),
    dice,
  );
  expect(defense(member.character, member.state)).toBe(14);
  runCombat([member], encounter, plan(member), dice);
  expect(defense(member.character, member.state)).toBe(10);
});

it('spends Opening Strike on the first attack roll, preserves it across neither misses nor saved rounds', () => {
  let member = hero();
  wear(member, 'opening-strike', ['head', 'boots'], 'Uncommon');
  member.state.equipment.left = { ...baseItem('offhand', 'Offhand', 'weapon'), light: true };
  let encounter = fight([member], 0);
  encounter.enemies = fight([member]).enemies;
  encounter.enemies[0].defense = 12;
  const roll = vi.fn<Dice>((sides) => (sides === 20 ? 10 : 2));
  runCombat([member], encounter, plan(member, { main: 'attack', targetId: 'foe-0', minor: 'offhand' }), roll);
  expect(encounter.enemies[0].hp).toBe(196);
  expect(roll.mock.calls.filter(([sides]) => sides === 20).map((call) => call[4])).toEqual([2, 0]);
  ({ member, encounter } = JSON.parse(JSON.stringify({ member, encounter })));
  runCombat([member], encounter, plan(member, { main: 'attack', targetId: 'foe-0' }), roll);
  expect(encounter.enemies[0].hp).toBe(196);
});

it('uses stacked Retaliator once on the next successful hit and Opportunist once per round', () => {
  const member = hero();
  wear(member, 'retaliator', ['body', 'left']);
  const encounter = fight([member]);
  runCombat([member], encounter, plan(member), (sides, label) =>
    label.includes('shield block') ? 1 : dice(sides),
  );
  expect(member.state.combatPerks?.retaliation).toBe(true);
  encounter.initiative = [{ id: member.id, total: 20 }];
  const logs = runCombat([member], encounter, plan(member, { main: 'attack', targetId: 'foe-0' }), dice);
  expect(encounter.enemies[0].hp).toBe(188);
  expect(logs.join(' ')).toContain('Retaliator adds 4 damage');
  wear(member, 'opportunist', ['head', 'boots']);
  member.state.equipment.left = { ...baseItem('offhand', 'Offhand', 'weapon'), light: true };
  encounter.enemies[0].conditions = ['Weakened'];
  encounter.enemies[0].conditionTurns = { Weakened: 2 };
  const next = runCombat(
    [member],
    encounter,
    plan(member, { main: 'attack', targetId: 'foe-0', minor: 'offhand' }),
    dice,
  );
  expect(next.filter((line) => line.includes('Opportunist adds'))).toHaveLength(1);
  expect(encounter.enemies[0].hp).toBe(168);
});

it('prevents a shared pool of ongoing ailment damage, including Shocked, without changing durations', () => {
  const member = hero();
  wear(member, 'enduring', ['body', 'head']);
  for (const condition of ['Burning', 'Poisoned', 'Shocked']) applyCondition(member.state, condition);
  const logs = tickConditions(member);
  expect(member.state.hp).toBe(19);
  expect(logs.filter((line) => line.includes('Enduring prevents'))).toHaveLength(2);
  expect(member.state.conditionTurns).toMatchObject({ Burning: 2, Poisoned: 3, Shocked: 2 });
});

it('stacks Rescuer on basic Help Up and Recuperating on encounter recovery', () => {
  const member = hero();
  const ally = hero();
  wear(member, 'rescuer', ['head', 'left']);
  ally.state.hp = 0;
  ally.state.conditions = ['Downed'];
  expect(helpUp(ally.state, member.state)).toBe(5);
  expect(ally.state.hp).toBe(5);
  expect(ally.state.downedThisEncounter).toBe(true);
  wear(member, 'recuperating', ['body', 'head', 'boots']);
  member.state.equipment.left = null;
  member.state.hp = 1;
  recoverAfterEncounter([member]);
  expect(member.state.hp).toBe(12);
});

it('adds Restorative to the first real potion or ability heal per round, respecting caps and encounter boundaries', () => {
  const member = hero();
  wear(member, 'restorative', ['body', 'head']);
  member.state.hp = 1;
  member.state.inventory = [{ ...baseItem('potion', 'Potion', 'consumable'), healing: 3, quantity: 5 }];
  expect(healWithItem(member.character, member.state, 'potion')).toBe(3);
  member.state.combatPerks = { round: 1 };
  expect(healWithItem(member.character, member.state, 'potion')).toBe(7);
  expect(healWithItem(member.character, member.state, 'potion')).toBe(3);
  member.state.combatPerks.round = 2;
  expect(healWithItem(member.character, member.state, 'potion')).toBe(6);
  expect(member.state.hp).toBe(20);
  recoverAfterEncounter([member]);
  member.state.hp = 1;
  expect(healWithItem(member.character, member.state, 'potion')).toBe(3);
});

it('applies Restorative to the recipient of ally healing and uses the same round allowance for potions', () => {
  const caster = hero();
  const target = hero();
  wear(target, 'restorative', ['body', 'head']);
  target.state.hp = 1;
  target.state.combatPerks = { round: 1 };
  caster.character.abilities = [
    {
      name: 'Mend',
      description: 'Treat an ally.',
      kind: 'combat',
      effect: 'mend',
      level: 1,
      stat: 'WIS',
      dice: '1d4',
    },
  ];
  expect(mendWithAbility(caster.character, caster.state, 'Mend', target, () => 1)).toBe(7);
  caster.state.inventory = [{ ...baseItem('tonic', 'Tonic', 'consumable'), healing: 3, quantity: 1 }];
  expect(healWithItem(caster.character, caster.state, 'tonic', target)).toBe(3);
  expect(target.state.hp).toBe(11);
});

it('keeps Opening Strike on both advantage dice and spends it on a missed attack', () => {
  const member = hero();
  wear(member, 'opening-strike', ['head', 'boots'], 'Uncommon');
  member.state.abilityAssist = 2;
  const encounter = fight([member], 0);
  encounter.enemies = fight([member]).enemies;
  encounter.enemies[0].defense = 30;
  const roll = vi.fn<Dice>(() => 2);
  runCombat([member], encounter, plan(member, { main: 'attack', targetId: 'foe-0' }), roll);
  expect(roll.mock.calls.map((call) => call[4])).toEqual([4, 4]);
  expect(member.state.combatPerks?.openingStrikeUsed).toBe(true);
  expect(encounter.enemies[0].hp).toBe(200);
  const again = vi.fn<Dice>(() => 2);
  runCombat([member], encounter, plan(member, { main: 'attack', targetId: 'foe-0' }), again);
  expect(again.mock.calls[0][4]).toBe(0);
});
