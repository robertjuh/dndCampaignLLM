import {
  type Character,
  type CharacterState,
  type CombatInput,
  type Encounter,
  type Enemy,
  type Item,
  type Member,
  type Scene,
  type Slot,
  type Stat,
  type LootBlueprint,
  stats,
} from './schema';

export class RuleError extends Error {}

export const RULESET = 'roguelike-v1';
export const modifier = (score: number) => Math.floor((score - 5) / 2);
export function startingStats(character: Character): Record<Stat, number> {
  const result = { STR: 5, DEX: 5, INT: 5 };
  if (new Set(character.traits.map((t) => t.id)).size !== character.traits.length)
    throw new RuleError('A character cannot have a trait twice.');
  for (const trait of character.traits) for (const stat of stats) result[stat] += trait.stats[stat] ?? 0;
  if (Object.values(result).some((n) => n < 0 || n > 13))
    throw new RuleError('This combination of traits has an invalid starting stat.');
  const all = character.traits;
  const positive = all.reduce(
    (n, t) =>
      n +
      Object.values(t.stats).reduce((sum, x) => sum + Math.max(0, x), 0) +
      Math.max(0, t.hp) / 2 +
      t.defense * 2 +
      t.regeneration * 2 +
      Number(t.natural) +
      Number(t.lifesteal) * 2 +
      t.immunities.length,
    0,
  );
  const drawbacks = Math.min(
    4,
    all.reduce(
      (n, t) =>
        n +
        Object.values(t.stats).reduce((sum, x) => sum + Math.max(0, -x), 0) +
        Math.max(0, -t.hp) / 2 +
        t.blocked.length +
        Number(t.healing !== 'normal') +
        Number(t.heavyRestricted),
      0,
    ),
  );
  if (positive - drawbacks > 6 || positive > 10)
    throw new RuleError(
      'Traits exceed the starting balance budget: at most 6 net benefit points and 10 before drawbacks.',
    );
  if (
    all.reduce((n, t) => n + t.defense, 0) > 1 ||
    all.reduce((n, t) => n + t.regeneration, 0) > 1 ||
    Math.abs(all.reduce((n, t) => n + t.hp, 0)) > 4
  )
    throw new RuleError('Trait bonuses cannot stack beyond +1 defense, +1 regeneration, or ±4 HP.');
  if (new Set(all.map((t) => t.healing).filter((x) => x !== 'normal')).size > 1)
    throw new RuleError('Choose a single compatible healing mode.');
  if (['left', 'right'].every((slot) => all.some((t) => t.blocked.includes(slot as Slot))))
    throw new RuleError('Leave at least one hand slot usable for your starting equipment.');
  if (new Set(character.weaponOptions.map((w) => w.stat)).size !== 3)
    throw new RuleError('Provide one starting weapon for each stat.');
  return result;
}
export const normalizeCharacter = (character: Character): Character => ({
  ...character,
  role: character.species,
  stats: startingStats(character),
  abilities: [],
  equipment: [],
});
export const maxHp = (character: Character, state: Pick<CharacterState, 'stats' | 'level'>) =>
  Math.max(
    5,
    20 +
      modifier(state.stats.STR) * 2 +
      (state.level - 1) * 5 +
      character.traits.reduce((n, t) => n + (t.hp ?? 0), 0),
  );
export const capacity = (_character: Character) => 8;
export const occupiedSlots = (state: CharacterState) =>
  state.inventory.reduce((n, item) => n + Math.ceil(item.quantity / (item.kind === 'consumable' ? 3 : 1)), 0);
export const scaling = (state: CharacterState, item: Item) =>
  item.scaling.length
    ? Math.floor(item.scaling.reduce((n, stat) => n + modifier(state.stats[stat]), 0) / item.scaling.length)
    : 0;
export function defense(character: Character, state: CharacterState) {
  const armour = state.equipment.body;
  return (
    10 +
    (state.guarding ? 2 : 0) +
    (armour ? scaling(state, armour) : modifier(state.stats.DEX)) +
    character.traits.reduce((n, t) => n + (t.defense ?? 0), 0) +
    Object.values(state.equipment)
      .filter((item, i, all) => item && all.findIndex((x) => x?.id === item.id) === i)
      .reduce((n, item) => n + (item?.defense ?? 0), 0)
  );
}
export const baseItem = (id: string, name: string, kind: Item['kind']): Item => ({
  id,
  name,
  kind,
  rarity: 'Common',
  scaling: [],
  requirements: { STR: 0, DEX: 0, INT: 0 },
  hands: 1,
  light: false,
  damage: '1d4',
  defense: 0,
  initiativePenalty: 0,
  healing: 0,
  description: '',
});
export function starterWeapons(seed: string, character: Character): Item[] {
  return character.weaponOptions.map((option, i) => ({
    ...baseItem(`${seed}-${i}`, option.name, 'weapon'),
    scaling: [option.stat],
    light: option.stat === 'DEX',
    damage: '1d6',
    description: option.description,
  }));
}
export function initialState(character: Character, seed: string): CharacterState {
  const stats = startingStats(character);
  const healing = character.traits.map((t) => t.healing).find((x) => x !== 'normal');
  const potion: Item = {
    ...baseItem(`${seed}-healing`, character.healingItemName, 'consumable'),
    healing: 6,
    description: `Restores 6 HP. Healing mode: ${healing ?? 'normal'}.`,
  };
  const state: CharacterState = {
    hp: 20,
    maxHp: 20,
    stats,
    level: 1,
    xp: 0,
    statPoints: 0,
    gold: 0,
    inventory: [{ ...potion, quantity: 1 }],
    equipment: { left: null, right: null, body: null, head: null, boots: null },
    conditions: [],
    conditionTurns: {},
    starterWeapons: starterWeapons(seed, character),
    weaponChosen: false,
    kills: 0,
    bosses: 0,
    deathReason: null,
    restedFloor: null,
  };
  state.hp = state.maxHp = maxHp(character, state);
  return state;
}
export function naturalWeapon(character: Character): Item {
  const stat = stats.reduce(
    (best, s) => (character.stats[s] > character.stats[best] ? s : best),
    'STR' as Stat,
  );
  return {
    ...baseItem('natural', `${character.name}’s innate strike`, 'weapon'),
    scaling: [stat],
    damage: character.traits.some((t) => t.natural) ? '1d6' : '1d4',
    description: 'An innate attack or an improvised unarmed strike.',
  };
}
function sameConsumable(a: Item, b: Item) {
  if (a.kind !== 'consumable' || b.kind !== 'consumable') return false;
  const signature = (item: Item) =>
    JSON.stringify([
      item.name,
      item.kind,
      item.rarity,
      item.scaling,
      stats.map((stat) => item.requirements[stat]),
      item.hands,
      item.light,
      item.damage,
      item.defense,
      item.initiativePenalty,
      item.healing,
      item.description,
    ]);
  return signature(a) === signature(b);
}
export function offerGroundItem(scene: Scene, item: Item, quantity = 1) {
  if (!Number.isInteger(quantity) || quantity <= 0)
    throw new RuleError('Item quantity must be a positive integer.');
  const existing = scene.loot.find((entry) => entry.id === item.id || sameConsumable(entry, item));
  if (existing) existing.quantity += quantity;
  else scene.loot.push({ ...item, quantity });
}
export function addItem(character: Character, state: CharacterState, item: Item, quantity = 1) {
  if (!Number.isInteger(quantity) || quantity <= 0)
    throw new RuleError('Item quantity must be a positive integer.');
  const existing = state.inventory.find((i) => i.id === item.id || sameConsumable(i, item));
  const before = existing?.quantity ?? 0;
  if (existing) existing.quantity += quantity;
  else state.inventory.push({ ...item, quantity });
  if (occupiedSlots(state) > capacity(character)) {
    if (existing) existing.quantity = before;
    else state.inventory.pop();
    throw new RuleError('Backpack full. Choose what to drop before taking this item.');
  }
}
export function removeItem(state: CharacterState, itemId: string, quantity = 1) {
  if (!Number.isInteger(quantity) || quantity <= 0)
    throw new RuleError('Item quantity must be a positive integer.');
  const item = state.inventory.find((i) => i.id === itemId);
  if (!item || item.quantity < quantity) throw new RuleError('That item is not in your backpack.');
  item.quantity -= quantity;
  state.inventory = state.inventory.filter((i) => i.quantity > 0);
  return item;
}
export function equip(character: Character, state: CharacterState, itemId: string, slot: Slot) {
  if (character.traits.some((t) => t.blocked?.includes(slot)))
    throw new RuleError('Your character’s anatomy prevents using that equipment slot.');
  const item = state.inventory.find((i) => i.id === itemId);
  if (!item) throw new RuleError('That item is not in your backpack.');
  for (const stat of stats)
    if (state.stats[stat] < item.requirements[stat])
      throw new RuleError(`This item requires ${item.requirements[stat]} ${stat}.`);
  const hand = slot === 'left' || slot === 'right';
  if (
    hand
      ? !['weapon', 'shield', 'focus', 'relic'].includes(item.kind)
      : ({ body: 'armour', head: 'helmet', boots: 'boots' } as Record<string, string>)[slot] !== item.kind
  )
    throw new RuleError('This item does not fit that slot.');
  if (
    character.traits.some((t) => t.heavyRestricted) &&
    ((item.kind === 'weapon' && item.hands === 2 && item.scaling.includes('STR')) ||
      (item.kind === 'armour' && item.scaling.includes('STR')))
  )
    throw new RuleError('Your traits prevent using heavy strength weapons or plate armour.');
  const copy = structuredClone(state);
  removeItem(copy, itemId);
  const displaced = new Map<string, Item>();
  for (const key of hand && item.hands === 2 ? (['left', 'right'] as Slot[]) : [slot]) {
    const old = copy.equipment[key];
    if (old) displaced.set(old.id, old);
  }
  if (hand)
    for (const old of [copy.equipment.left, copy.equipment.right])
      if (old?.hands === 2) displaced.set(old.id, old);
  for (const old of displaced.values()) {
    for (const key of Object.keys(copy.equipment) as Slot[])
      if (copy.equipment[key]?.id === old.id) copy.equipment[key] = null;
    addItem(character, copy, old);
  }
  copy.equipment[slot] = { ...item };
  if (hand && item.hands === 2) {
    copy.equipment.left = { ...item };
    copy.equipment.right = { ...item };
  }
  Object.assign(state, copy);
}
export function unequip(character: Character, state: CharacterState, slot: Slot) {
  const item = state.equipment[slot];
  if (!item) throw new RuleError('That slot is empty.');
  const copy = structuredClone(state);
  addItem(character, copy, item);
  for (const key of Object.keys(copy.equipment) as Slot[])
    if (copy.equipment[key]?.id === item.id) copy.equipment[key] = null;
  Object.assign(state, copy);
}
export function healWithItem(character: Character, state: CharacterState, itemId: string) {
  if (state.hp <= 0) throw new RuleError('A dead character cannot be healed.');
  const item = state.inventory.find((i) => i.id === itemId);
  if (!item?.healing) throw new RuleError('Choose a healing consumable.');
  const mode = character.traits.map((t) => t.healing).find((x) => x !== 'normal');
  if (mode && !`${item.name} ${item.description}`.toLowerCase().includes(mode))
    throw new RuleError('This healing item is incompatible with your character.');
  removeItem(state, itemId);
  state.hp = Math.min(state.maxHp, state.hp + item.healing);
}
export function grantXp(character: Character, state: CharacterState, amount: number) {
  if (state.hp <= 0) return;
  state.xp += amount;
  while (state.xp >= 100) {
    state.xp -= 100;
    state.level++;
    state.statPoints += 5;
    state.maxHp = maxHp(character, state);
    state.hp = Math.min(state.maxHp, state.hp + 5);
  }
}
export function allocate(character: Character, state: CharacterState, points: Record<Stat, number>) {
  if (
    !state.statPoints ||
    Object.values(points).some((n) => !Number.isInteger(n) || n < 0) ||
    stats.reduce((n, s) => n + points[s], 0) !== state.statPoints
  )
    throw new RuleError('Allocate all available stat points between STR, DEX, and INT.');
  const oldMax = state.maxHp;
  for (const stat of stats) state.stats[stat] += points[stat];
  state.statPoints = 0;
  state.maxHp = maxHp(character, state);
  state.hp = Math.min(state.maxHp, state.hp + state.maxHp - oldMax);
}
export function damage(state: CharacterState, amount: number, cause: string) {
  if (state.hp <= 0) return;
  state.hp = Math.max(0, state.hp - Math.max(0, amount));
  if (state.hp === 0) state.deathReason = cause;
}
export function initialScene(setting: string): Scene {
  return {
    floor: { number: 1, biome: setting, atmosphere: '', hazard: '', encounters: 0, cleared: false },
    encounter: null,
    loot: [],
    lethalWarning: null,
    safeRest: false,
    usedRest: false,
  };
}
export type Dice = (
  sides: number,
  label: string,
  actor: string,
  stat: Stat,
  mod?: number,
  dc?: number,
) => number;
export function weaponDamage(item: Item, roll: Dice, actor: string, bonus: number, critical = false) {
  const [count, sides] = item.damage.split('d').map(Number);
  let total = 0;
  for (let i = 0; i < count * (critical ? 2 : 1); i++)
    total += roll(sides, `${item.name} damage ${i + 1}`, actor, item.scaling[0] ?? 'STR');
  return Math.max(1, total + bonus);
}
export function randomLoot(
  seed: string,
  floor: Scene['floor'],
  roll: (sides: number) => number,
  blueprint: LootBlueprint,
): Item {
  const draw = roll(100);
  const rarity: Item['rarity'] =
    draw === 1
      ? 'Cursed'
      : draw === 100
        ? 'Legendary'
        : draw > 95
          ? 'Epic'
          : draw > 80
            ? 'Rare'
            : draw > 55
              ? 'Uncommon'
              : 'Common';
  const rank = { Common: 0, Uncommon: 1, Rare: 2, Epic: 3, Legendary: 4, Cursed: 2 }[rarity];
  const item: Item = {
    ...baseItem(seed, blueprint.name, blueprint.kind),
    ...blueprint,
    id: seed,
    rarity,
    damage: ['1d6', '1d8', '1d10', '1d12', '2d8'][rank],
    defense: ['armour', 'shield', 'helmet', 'boots'].includes(blueprint.kind)
      ? Math.min(3, 1 + Math.floor(rank / 2))
      : 0,
    healing: blueprint.kind === 'consumable' ? Math.min(12, 6 + rank * 2) : 0,
    initiativePenalty: blueprint.kind === 'armour' && blueprint.scaling.includes('STR') ? -2 : 0,
  };
  if (rarity === 'Cursed') {
    item.initiativePenalty = -3;
    item.description += ' Cursed: −3 initiative while equipped.';
  }
  if (['weapon', 'armour'].includes(item.kind))
    for (const stat of item.scaling) item.requirements[stat] = 3 + Math.min(12, floor.number - 1 + rank);
  return item;
}

export function runCombat(members: Member[], encounter: Encounter, input: CombatInput, roll: Dice) {
  if (encounter.victory || encounter.escaped) throw new RuleError('This combat has already ended.');
  const logs: string[] = [];
  const fled = new Set(members.filter((m) => m.state.conditions.includes('Escaped')).map((m) => m.id));
  const ids = input.actions.map((a) => a.memberId);
  if (new Set(ids).size !== ids.length)
    throw new RuleError('Each character gets one main and one minor action.');
  for (const id of ids)
    if (!members.some((m) => m.id === id && m.state.hp > 0))
      throw new RuleError('Combat action references an unavailable character.');
  for (const target of input.enemyTargets)
    if (
      !encounter.enemies.some((e) => e.id === target.enemyId) ||
      !members.some((m) => m.id === target.memberId && m.state.hp > 0)
    )
      throw new RuleError('Enemy target is not available.');
  const attack = (
    member: Member,
    target: Enemy,
    offhand = false,
    slot?: 'left' | 'right' | 'natural' | null,
  ) => {
    const primary =
      slot === 'natural'
        ? naturalWeapon(member.character)
        : slot
          ? member.state.equipment[slot]
          : ([member.state.equipment.right, member.state.equipment.left].find(
              (item) => item?.kind === 'weapon',
            ) ?? naturalWeapon(member.character));
    const weapon = offhand
      ? [member.state.equipment.left, member.state.equipment.right].find(
          (item) => item?.kind === 'weapon' && item.id !== primary?.id,
        )
      : primary;
    if (!weapon || weapon.kind !== 'weapon')
      throw new RuleError('Equip a weapon or use your natural attack.');
    if (offhand && (!weapon.light || !primary?.light || primary.id === weapon.id))
      throw new RuleError('An off-hand attack requires two distinct light one-handed weapons.');
    const mod = scaling(member.state, weapon) - (member.state.conditions.includes('Weakened') ? 2 : 0);
    const die = roll(
      20,
      `${member.character.name}: ${offhand ? 'off-hand ' : ''}attack`,
      member.id,
      weapon.scaling[0] ?? 'STR',
      mod,
      target.defense,
    );
    if (die === 1) {
      const harm = roll(4, 'Catastrophic attack backlash', member.id, 'STR');
      damage(member.state, harm, 'A catastrophic attack failure.');
      logs.push(
        `${member.character.name} rolls a natural 1: the attack fails catastrophically and causes ${harm} self-damage.`,
      );
    } else if (die === 20 || die + mod >= target.defense) {
      const dealt = weaponDamage(
        weapon,
        roll,
        member.id,
        offhand ? 0 : scaling(member.state, weapon),
        die === 20,
      );
      target.hp = Math.max(0, target.hp - dealt);
      logs.push(
        `${member.character.name} ${die === 20 ? 'critically hits' : 'hits'} ${target.name} for ${dealt}.`,
      );
      if (weapon.id === 'natural' && member.character.traits.some((t) => t.lifesteal))
        member.state.hp = Math.min(member.state.maxHp, member.state.hp + 1);
    } else logs.push(`${member.character.name} misses ${target.name}.`);
  };
  for (const initiative of encounter.initiative) {
    const member = members.find((m) => m.id === initiative.id);
    if (member) {
      if (member.state.hp <= 0 || fled.has(member.id)) continue;
      member.state.guarding = false;
      const action = input.actions.find((a) => a.memberId === member.id);
      if (!action) {
        logs.push(`${member.character.name} holds position.`);
        continue;
      }
      if (action.minor === 'equip' && action.minorItemId && action.minorSlot) {
        equip(member.character, member.state, action.minorItemId, action.minorSlot);
        logs.push(`${member.character.name} changes equipment as their minor action.`);
      }
      if (member.state.conditions.includes('Stunned')) {
        logs.push(`${member.character.name} is stunned and loses their main action.`);
      } else if (action.main === 'defend') {
        member.state.guarding = true;
        logs.push(`${member.character.name} defends (+2 defense).`);
      } else if (action.main === 'flee') {
        const mod = modifier(member.state.stats.DEX);
        const die = roll(20, 'Flee combat', member.id, 'DEX', mod, action.dc ?? 10);
        if (die !== 1 && (die === 20 || die + mod >= (action.dc ?? 10))) {
          fled.add(member.id);
          logs.push(`${member.character.name} escapes the fight.`);
        } else {
          logs.push(`${member.character.name} cannot escape.`);
          if (die === 1) damage(member.state, 4, 'Catastrophic failed escape.');
        }
      } else {
        const target = encounter.enemies.find((e) => e.id === action.targetId && e.hp > 0 && !e.withdrawn);
        if (!target) {
          logs.push(
            `${member.character.name}'s target is no longer available; the action is not redirected without consent.`,
          );
        } else if (action.main === 'attack') attack(member, target, false, action.weaponSlot);
        else {
          const mod = modifier(member.state.stats[action.stat]);
          const dc = Math.max(action.effect === 'influence' ? 15 : 5, action.dc ?? 10);
          const die = roll(
            20,
            action.description || 'Creative combat action',
            member.id,
            action.stat,
            mod,
            dc,
          );
          if (die === 1) {
            damage(member.state, 4, 'A catastrophic improvised action.');
            logs.push(`${member.character.name}'s improvised action backfires for 4 damage.`);
          } else if (die === 20 || die + mod >= dc) {
            if (action.effect === 'influence') {
              target.withdrawn = true;
              logs.push(`${member.character.name}'s approach persuades ${target.name} to stop fighting.`);
            } else if (action.effect === 'stun') {
              target.stunned = true;
              logs.push(`${member.character.name}'s maneuver prevents ${target.name}'s next attack.`);
            } else {
              const improvised = {
                ...baseItem('improvised', action.description || 'Improvised action', 'weapon'),
                damage: '1d6',
                scaling: [action.stat],
              };
              const dealt = weaponDamage(improvised, roll, member.id, mod, die === 20);
              target.hp = Math.max(0, target.hp - dealt);
              logs.push(
                `${member.character.name}'s creative action deals ${dealt} damage to ${target.name}.`,
              );
            }
          } else logs.push(`${member.character.name}'s creative action fails.`);
        }
      }
      if (member.state.hp > 0 && !fled.has(member.id)) {
        if (action.minor === 'heal' && action.minorItemId) {
          healWithItem(member.character, member.state, action.minorItemId);
          logs.push(`${member.character.name} uses a healing consumable.`);
        }
        if (action.minor === 'offhand') {
          const target = encounter.enemies.find((e) => e.id === action.targetId && e.hp > 0 && !e.withdrawn);
          if (target) attack(member, target, true, action.weaponSlot);
        }
      }
    } else {
      const enemy = encounter.enemies.find((e) => e.id === initiative.id);
      if (!enemy || enemy.hp <= 0 || enemy.withdrawn) continue;
      if (enemy.stunned) {
        enemy.stunned = false;
        logs.push(`${enemy.name} is unable to attack this round.`);
        continue;
      }
      const candidates = members.filter((m) => m.state.hp > 0 && !fled.has(m.id));
      if (!candidates.length) break;
      const selected = input.enemyTargets.find((t) => t.enemyId === enemy.id)?.memberId;
      const target = candidates.find((m) => m.id === selected) ?? candidates[0];
      const targetDefense = defense(target.character, target.state);
      const die = roll(
        20,
        `${enemy.name} attacks ${target.character.name}`,
        enemy.id,
        'STR',
        enemy.attack,
        targetDefense,
      );
      if (die === 1) {
        enemy.hp = Math.max(0, enemy.hp - 2);
        logs.push(`${enemy.name} catastrophically fails and suffers 2 damage.`);
      } else if (die === 20 || die + enemy.attack >= targetDefense) {
        const weapon = { ...baseItem(enemy.id, enemy.name, 'weapon'), damage: enemy.damage };
        const dealt = weaponDamage(weapon, roll, enemy.id, enemy.attack, die === 20);
        damage(target.state, dealt, `Killed by ${enemy.name}.`);
        if (
          target.state.hp > 0 &&
          enemy.onHit &&
          !target.character.traits.some((t) => t.immunities.includes(enemy.onHit!))
        ) {
          if (!target.state.conditions.includes(enemy.onHit)) target.state.conditions.push(enemy.onHit);
          target.state.conditionTurns[enemy.onHit] = 2;
        }
        logs.push(
          `${enemy.name} ${die === 20 ? 'critically hits' : 'hits'} ${target.character.name} for ${dealt}.`,
        );
      } else logs.push(`${enemy.name} misses ${target.character.name}.`);
    }
  }
  for (const member of members) {
    for (const condition of [...member.state.conditions]) {
      const immune = member.character.traits.some((t) => t.immunities.some((c) => c === condition));
      if (!immune && ['Bleeding', 'Burning', 'Poisoned'].includes(condition))
        damage(member.state, condition === 'Burning' ? 2 : 1, `${condition} damage.`);
      const duration = (member.state.conditionTurns[condition] ?? 2) - 1;
      member.state.conditionTurns[condition] = duration;
      if (duration <= 0 || immune) {
        member.state.conditions = member.state.conditions.filter((c) => c !== condition);
        delete member.state.conditionTurns[condition];
      }
    }
    if (fled.has(member.id)) {
      if (!member.state.conditions.includes('Escaped')) member.state.conditions.push('Escaped');
      member.state.conditionTurns.Escaped = 999;
    }
  }
  encounter.round++;
  encounter.victory = encounter.enemies.every((e) => e.hp === 0 || e.withdrawn);
  encounter.escaped =
    !encounter.victory && members.every((m) => m.state.hp <= 0 || m.state.conditions.includes('Escaped'));
  if (encounter.victory) {
    const xp = encounter.enemies.reduce(
      (sum, enemy) => sum + { minor: 15, normal: 30, elite: 50, boss: 100 }[enemy.tier],
      0,
    );
    for (const member of members)
      if (member.state.hp > 0) {
        grantXp(member.character, member.state, xp);
        member.state.kills += encounter.enemies.filter((e) => e.hp === 0).length;
        member.state.bosses += encounter.enemies.filter((e) => e.tier === 'boss').length;
        member.state.hp = Math.min(
          member.state.maxHp,
          member.state.hp + member.character.traits.reduce((n, t) => n + (t.regeneration ?? 0), 0),
        );
      }
    logs.push(`Victory. Each surviving character gains ${xp} XP. A physical item must be offered as loot.`);
  }
  if (encounter.victory || encounter.escaped)
    for (const member of members) {
      member.state.guarding = false;
      member.state.conditions = member.state.conditions.filter((c) => c !== 'Escaped');
      delete member.state.conditionTurns.Escaped;
    }
  return logs;
}
