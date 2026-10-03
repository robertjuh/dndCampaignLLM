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
  type Ability,
  stats,
  slots,
} from './schema';

export class RuleError extends Error {}

export const RULESET = 'roguelike-v1';
export const modifier = (score: number) => Math.floor((score - 5) / 2);
export const abilityStrength = (ability: Ability) => ability.level - 1;
export function abilityMechanics(ability: Ability): string {
  const strength = abilityStrength(ability);
  if (ability.kind === 'utility')
    return `Advantage${strength ? ` and +${strength}` : ''} on a relevant ${ability.stat} check · Once per floor; safe rest restores use`;
  const effect = {
    strike: `2d6 + ${ability.stat} modifier${strength ? ` + ${strength * 2}` : ''} damage · Attack roll vs defense`,
    mend: `1d6 + ${ability.stat} modifier${strength ? ` + ${strength * 2}` : ''} HP restored · ${ability.healing} healing · Self or ally`,
    guard: `+${3 + strength} defense against the next enemy attack · Self or ally`,
    assist: `Advantage${strength ? ` and +${strength}` : ''} on the next attack · Self or ally`,
  }[ability.effect];
  return `${effect} · Main action · Once per combat`;
}
export const equippedItems = (state: CharacterState) =>
  Object.values(state.equipment).filter(
    (item, i, all): item is Item => !!item && all.findIndex((other) => other?.id === item.id) === i,
  );
export const equipmentBonus = (
  state: CharacterState,
  stat: Stat | Stat[],
  kind: 'attackBonus' | 'checkBonus',
) =>
  equippedItems(state)
    .filter((item) =>
      (typeof stat === 'string' ? [stat] : stat).some((attribute) => item.scaling.includes(attribute)),
    )
    .reduce((sum, item) => sum + (item[kind] ?? 0), 0);
export function availableAbility(
  character: Character,
  state: CharacterState,
  name: string,
  kind: Ability['kind'],
): Ability {
  const ability = character.abilities.find((ability) => ability.name === name && ability.kind === kind);
  if (!ability) throw new RuleError('Choose a current ability for this kind of action.');
  if ((state.abilityUses?.[ability.name] ?? 0) >= 1)
    throw new RuleError('That ability has already been used.');
  return ability;
}
export function spendAbility(state: CharacterState, ability: Ability) {
  state.abilityUses = { ...state.abilityUses, [ability.name]: 1 };
}
export function resetAbilities(character: Character, state: CharacterState, kind: Ability['kind']) {
  state.abilityUses = Object.fromEntries(
    Object.entries(state.abilityUses ?? {}).filter(
      ([name]) => !character.abilities.some((ability) => ability.name === name && ability.kind === kind),
    ),
  );
  if (kind === 'combat') {
    delete state.abilityGuard;
    delete state.abilityAssist;
  }
}
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
  if (slots.every((slot) => all.some((t) => t.blocked.includes(slot))))
    throw new RuleError('Leave at least one equipment slot usable for starting equipment.');
  return result;
}
export function normalizeCharacter(character: Character): Character {
  const result = { ...character, role: character.species, stats: startingStats(character), equipment: [] };
  if (
    new Set(result.equipmentOptions.map((item) => item.id)).size !== 5 ||
    result.equipmentOptions.some((item) => !usableSlots(result, result.stats, item).length)
  )
    throw new RuleError('Provide five distinct, equippable starting equipment choices.');
  if (
    result.equipmentOptions.some(
      (item) =>
        item.rarity !== 'Common' ||
        item.hands !== 1 ||
        item.healing !== 0 ||
        item.initiativePenalty !== 0 ||
        Object.values(item.requirements).some((n) => n !== 0) ||
        item.damage !== (item.kind === 'weapon' ? '1d6' : '1d4') ||
        item.defense !== (['armour', 'helmet', 'boots', 'shield'].includes(item.kind) ? 1 : 0) ||
        item.attackBonus !== (item.kind === 'focus' ? 1 : 0) ||
        item.checkBonus !== (item.kind === 'relic' ? 1 : 0),
    )
  )
    throw new RuleError('Starting equipment must use common, level-one power.');
  if (new Set(result.abilities.map((ability) => ability.name.toLowerCase())).size !== result.abilities.length)
    throw new RuleError('Ability names must be unique.');
  const selected = result.selectedEquipmentIds;
  if (
    selected.length &&
    (selected.length !== 2 ||
      new Set(selected).size !== 2 ||
      selected.some((id) => !result.equipmentOptions.some((item) => item.id === id)))
  )
    throw new RuleError('Choose exactly two different starting equipment pieces.');
  return result;
}
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
    (state.abilityGuard ?? 0) +
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
  attackBonus: 0,
  checkBonus: 0,
  description: '',
});
export function usableSlots(character: Character, scores: Record<Stat, number>, item: Item): Slot[] {
  if (stats.some((stat) => scores[stat] < item.requirements[stat])) return [];
  if (
    character.traits.some((t) => t.heavyRestricted) &&
    item.scaling.includes('STR') &&
    (item.kind === 'armour' || (item.kind === 'weapon' && item.hands === 2))
  )
    return [];
  const blocked = new Set(character.traits.flatMap((t) => t.blocked));
  if (['weapon', 'shield', 'focus', 'relic'].includes(item.kind)) {
    if (item.hands === 2 && (blocked.has('left') || blocked.has('right'))) return [];
    return (['right', 'left'] as Slot[]).filter((slot) => !blocked.has(slot));
  }
  const slot = ({ armour: 'body', helmet: 'head', boots: 'boots' } as Partial<Record<Item['kind'], Slot>>)[
    item.kind
  ];
  return slot && !blocked.has(slot) ? [slot] : [];
}
export function rollStartingEquipment(character: Character, draw: (sides: number) => number): Item[] {
  const scores = startingStats(character);
  const candidates: Item[] = [];
  for (const kind of ['weapon', 'armour', 'helmet', 'boots', 'shield', 'focus', 'relic'] as const) {
    for (const stat of ['weapon', 'armour', 'focus', 'relic'].includes(kind) ? stats : [null]) {
      const item = {
        ...baseItem('candidate', `${character.name}’s ${kind}`, kind),
        scaling: stat ? [stat] : [],
        light: kind === 'weapon' && stat === 'DEX',
        damage: kind === 'weapon' ? '1d6' : '1d4',
        defense: ['armour', 'helmet', 'boots', 'shield'].includes(kind) ? 1 : 0,
        attackBonus: kind === 'focus' ? 1 : 0,
        checkBonus: kind === 'relic' ? 1 : 0,
      };
      if (usableSlots(character, scores, item).length) candidates.push(item);
    }
  }
  if (!candidates.length) throw new RuleError('This character cannot equip starting equipment.');
  const kinds = [...new Set(candidates.map((item) => item.kind))];
  const pick = <T>(values: T[]) => values[values.length === 1 ? 0 : draw(values.length) - 1];
  return Array.from({ length: 5 }, (_, i) => {
    const kind = pick(kinds);
    const item = pick(candidates.filter((item) => item.kind === kind));
    return { ...item, id: `starter-${i}`, name: `${item.name} ${i + 1}` };
  });
}
export function chooseStartingEquipment(character: Character, state: CharacterState, ids: string[]) {
  if (state.equipmentChosen) throw new RuleError('Your starting equipment is already chosen.');
  if (
    ids.length !== 2 ||
    new Set(ids).size !== 2 ||
    ids.some((id) => !state.starterEquipment.some((item) => item.id === id))
  )
    throw new RuleError('Choose exactly two different starting equipment pieces.');
  const copy = structuredClone(state);
  for (const id of ids) {
    const item = copy.starterEquipment.find((item) => item.id === id)!;
    const available = usableSlots(character, copy.stats, item);
    if (!available.length) throw new RuleError('This starting item cannot be equipped by your character.');
    addItem(character, copy, item);
    const empty = available.find(
      (slot) =>
        !copy.equipment[slot] && (item.hands !== 2 || (!copy.equipment.left && !copy.equipment.right)),
    );
    if (empty) equip(character, copy, item.id, empty);
  }
  copy.equipmentChosen = true;
  copy.starterEquipment = [];
  Object.assign(state, copy);
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
    pendingLevelUps: 0,
    abilityUses: {},
    gold: 0,
    inventory: [{ ...potion, quantity: 1 }],
    equipment: { left: null, right: null, body: null, head: null, boots: null },
    conditions: [],
    conditionTurns: {},
    starterEquipment: character.equipmentOptions.map((item) => ({ ...item, id: `${seed}-${item.id}` })),
    equipmentChosen: false,
    kills: 0,
    bosses: 0,
    deathReason: null,
    restedFloor: null,
  };
  state.hp = state.maxHp = maxHp(character, state);
  if (character.selectedEquipmentIds.length)
    chooseStartingEquipment(
      character,
      state,
      character.selectedEquipmentIds.map((id) => `${seed}-${id}`),
    );
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
  if (
    item.hands === 2 &&
    character.traits.some((t) => t.blocked.includes('left') || t.blocked.includes('right'))
  )
    throw new RuleError('Your character’s anatomy prevents using a two-handed item.');
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
export function takeItem(
  character: Character,
  state: CharacterState,
  scene: Scene,
  itemId: string,
  slot?: Slot,
  dropItemIds: string[] = [],
) {
  const copy = structuredClone(state);
  const ground = structuredClone(scene);
  const item = ground.loot.find((item) => item.id === itemId);
  if (!item) throw new RuleError('That item is no longer available.');
  if (new Set(dropItemIds).size !== dropItemIds.length)
    throw new RuleError('Choose each item to drop only once.');
  for (const id of dropItemIds) {
    const dropped = copy.inventory.find((item) => item.id === id);
    if (!dropped) throw new RuleError('That item is not in your backpack.');
    const quantity = dropped.quantity;
    removeItem(copy, id, quantity);
    offerGroundItem(ground, dropped, quantity);
  }
  if (slot) {
    // Equip before checking capacity so an empty equipment slot works with a full backpack.
    const owned = copy.inventory.find((owned) => owned.id === item.id);
    if (owned) owned.quantity++;
    else copy.inventory.push({ ...item, quantity: 1 });
    equip(character, copy, item.id, slot);
  } else addItem(character, copy, item);
  if (occupiedSlots(copy) > capacity(character)) throw new RuleError('Backpack full. Choose what to drop.');
  item.quantity--;
  ground.loot = ground.loot.filter((item) => item.quantity > 0);
  Object.assign(state, copy);
  scene.loot = ground.loot;
}
export const isDowned = (state: Pick<CharacterState, 'hp' | 'conditions'>) =>
  state.hp <= 0 && state.conditions.includes('Downed');
export const isDead = (state: Pick<CharacterState, 'hp' | 'conditions'>) => state.hp <= 0 && !isDowned(state);
export function heal(state: CharacterState, amount: number) {
  if (isDead(state)) throw new RuleError('A dead character cannot be healed.');
  const hp = state.hp;
  state.hp = Math.min(state.maxHp, state.hp + Math.max(0, amount));
  if (state.hp > 0) {
    state.conditions = state.conditions.filter((condition) => condition !== 'Downed');
    delete state.conditionTurns.Downed;
    state.deathReason = null;
  }
  return state.hp - hp;
}
export function healWithItem(
  character: Character,
  state: CharacterState,
  itemId: string,
  target: { character: Character; state: CharacterState } = { character, state },
) {
  if (state.hp <= 0)
    throw new RuleError(
      isDowned(state)
        ? 'A downed character needs an ally to help them up.'
        : 'A dead character cannot be healed.',
    );
  if (isDead(target.state)) throw new RuleError('A dead character cannot be healed.');
  const item = state.inventory.find((i) => i.id === itemId);
  if (item?.kind !== 'consumable' || !item.healing) throw new RuleError('Choose a healing consumable.');
  const mode = target.character.traits.map((t) => t.healing).find((x) => x !== 'normal');
  if (mode && !`${item.name} ${item.description}`.toLowerCase().includes(mode))
    throw new RuleError('This healing item is incompatible with your character.');
  removeItem(state, itemId);
  return heal(target.state, item.healing);
}
export function mendWithAbility(
  character: Character,
  state: CharacterState,
  abilityName: string,
  target: { character: Character; state: CharacterState },
  roll: Dice,
) {
  if (state.hp <= 0) throw new RuleError('An ally must be conscious to use a healing ability.');
  const ability = availableAbility(character, state, abilityName, 'combat');
  if (ability.effect !== 'mend') throw new RuleError('Choose a healing ability.');
  if (isDead(target.state)) throw new RuleError('A dead character cannot be healed.');
  const mode = target.character.traits.find((trait) => trait.healing !== 'normal')?.healing ?? 'normal';
  if (mode !== ability.healing) throw new RuleError('This healing ability is incompatible with the target.');
  if (target.state.hp >= target.state.maxHp) throw new RuleError('The target is already at full health.');
  const amount = Math.max(
    1,
    roll(6, `${ability.name}: healing`, character.name, ability.stat) +
      modifier(state.stats[ability.stat]) +
      abilityStrength(ability) * 2,
  );
  const restored = heal(target.state, amount);
  spendAbility(state, ability);
  return restored;
}
export function grantXp(character: Character, state: CharacterState, amount: number) {
  if (state.hp <= 0) return;
  state.xp += amount;
  while (state.xp >= 100) {
    state.xp -= 100;
    state.level++;
    state.pendingLevelUps++;
    state.maxHp = maxHp(character, state);
    state.hp = Math.min(state.maxHp, state.hp + 5);
  }
}
export function gainAttributes(character: Character, state: CharacterState, attributes: Stat[]) {
  if (attributes.length !== 2 || attributes.some((stat) => !stats.includes(stat)))
    throw new RuleError('Gain exactly two attribute points.');
  const oldMax = state.maxHp;
  for (const stat of attributes) state.stats[stat]++;
  state.maxHp = maxHp(character, state);
  if (state.hp > 0) state.hp = Math.min(state.maxHp, state.hp + state.maxHp - oldMax);
}
export function damage(state: CharacterState, amount: number, cause: string, fatal = false) {
  if (state.hp <= 0) return;
  state.hp = Math.max(0, state.hp - Math.max(0, amount));
  if (state.hp === 0) {
    state.conditions = state.conditions.filter((condition) => condition !== 'Downed');
    delete state.conditionTurns.Downed;
    if (!fatal) state.conditions.push('Downed');
    state.deathReason = fatal ? cause : null;
    state.guarding = false;
    delete state.abilityGuard;
    delete state.abilityAssist;
  }
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
    scaling:
      ['focus', 'relic'].includes(blueprint.kind) && !blueprint.scaling.length ? ['INT'] : blueprint.scaling,
    id: seed,
    rarity,
    damage: ['1d6', '1d8', '1d10', '1d12', '2d8'][rank],
    defense: ['armour', 'shield', 'helmet', 'boots'].includes(blueprint.kind)
      ? Math.min(3, 1 + Math.floor(rank / 2))
      : 0,
    healing: blueprint.kind === 'consumable' ? Math.min(12, 6 + rank * 2) : 0,
    attackBonus: blueprint.kind === 'focus' ? Math.min(3, 1 + Math.floor(rank / 2)) : 0,
    checkBonus: blueprint.kind === 'relic' ? Math.min(3, 1 + Math.floor(rank / 2)) : 0,
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
  for (const action of input.actions) {
    if ((action.main === 'ability') !== !!action.abilityName)
      throw new RuleError('An ability action must name the chosen ability.');
    if (action.abilityName) {
      const member = members.find((member) => member.id === action.memberId)!;
      availableAbility(member.character, member.state, action.abilityName, 'combat');
    }
  }
  for (const target of input.enemyTargets)
    if (
      !encounter.enemies.some((e) => e.id === target.enemyId) ||
      !members.some((m) => m.id === target.memberId && m.state.hp > 0)
    )
      throw new RuleError('Enemy target is not available.');
  const minorAction = (member: Member, resolve: () => void) => {
    try {
      resolve();
    } catch (error) {
      if (!(error instanceof RuleError)) throw error;
      logs.push(
        `${member.character.name}'s minor action has no effect: ${error.message} The minor action is spent.`,
      );
    }
  };
  const attack = (
    member: Member,
    target: Enemy,
    offhand = false,
    slot?: 'left' | 'right' | 'natural' | null,
    ability?: Ability,
  ) => {
    const primary = ability
      ? { ...baseItem('ability', ability.name, 'weapon'), scaling: [ability.stat], damage: '2d6' }
      : slot === 'natural'
        ? naturalWeapon(member.character)
        : ([
            ...(slot ? [member.state.equipment[slot]] : []),
            member.state.equipment.right,
            member.state.equipment.left,
          ].find((item) => item?.kind === 'weapon') ?? naturalWeapon(member.character));
    const weapon = offhand
      ? [member.state.equipment.left, member.state.equipment.right].find(
          (item) => item?.kind === 'weapon' && item.id !== primary?.id,
        )
      : primary;
    if (
      !weapon ||
      (offhand &&
        (!weapon.light ||
          !primary.light ||
          weapon.hands !== 1 ||
          primary.hands !== 1 ||
          primary.id === weapon.id))
    ) {
      logs.push(
        `${member.character.name}'s off-hand attack has no effect: it requires two distinct light one-handed weapons. The minor action is spent.`,
      );
      return;
    }
    const stat = weapon.scaling[0] ?? 'STR';
    const assist = member.state.abilityAssist;
    const mod =
      scaling(member.state, weapon) +
      equipmentBonus(member.state, weapon.scaling.length ? weapon.scaling : ['STR'], 'attackBonus') +
      (assist ?? 0) -
      (member.state.conditions.includes('Weakened') ? 2 : 0);
    let die = roll(
      20,
      `${member.character.name}: ${offhand ? 'off-hand ' : ''}attack with ${weapon.name}`,
      member.id,
      stat,
      mod,
      target.defense,
    );
    if (assist !== undefined) {
      die = Math.max(
        die,
        roll(20, `${member.character.name}: assisted attack`, member.id, stat, mod, target.defense),
      );
      delete member.state.abilityAssist;
      logs.push(`${member.character.name} attacks with advantage${assist ? ` and +${assist}` : ''}.`);
    }
    if (die === 1) {
      const harm = roll(4, 'Catastrophic attack backlash', member.id, 'STR');
      damage(member.state, harm, 'A catastrophic attack failure.', true);
      logs.push(
        `${member.character.name} rolls a natural 1 with ${weapon.name}: the attack fails catastrophically and causes ${harm} self-damage${member.state.hp === 0 ? ' and death' : ''}.`,
      );
    } else if (die === 20 || die + mod >= target.defense) {
      const dealt = weaponDamage(
        weapon,
        roll,
        member.id,
        offhand ? 0 : scaling(member.state, weapon) + (ability ? abilityStrength(ability) * 2 : 0),
        die === 20,
      );
      target.hp = Math.max(0, target.hp - dealt);
      logs.push(
        `${member.character.name} ${die === 20 ? 'critically hits' : 'hits'} ${target.name} with ${weapon.name} for ${dealt}${target.hp === 0 ? `, killing ${target.name}` : ''}.`,
      );
      if (weapon.id === 'natural' && member.character.traits.some((t) => t.lifesteal)) {
        const hp = member.state.hp;
        member.state.hp = Math.min(member.state.maxHp, member.state.hp + 1);
        if (member.state.hp > hp)
          logs.push(`${member.character.name} recovers ${member.state.hp - hp} HP from lifesteal.`);
      }
    } else logs.push(`${member.character.name} misses ${target.name} with ${weapon.name}.`);
  };
  for (const initiative of encounter.initiative) {
    const member = members.find((m) => m.id === initiative.id);
    if (member) {
      const action = input.actions.find((a) => a.memberId === member.id);
      if (member.state.hp <= 0) {
        if (action)
          logs.push(
            `${member.character.name} cannot carry out their submitted action because they ${isDowned(member.state) ? 'were downed' : 'died'} before their turn.`,
          );
        continue;
      }
      const wasEscaped = fled.has(member.id);
      if (wasEscaped && !action) continue;
      if (
        wasEscaped &&
        action &&
        (action.reengage ||
          ['attack', 'defend', 'creative', 'ability'].includes(action.main) ||
          action.minor === 'offhand')
      ) {
        fled.delete(member.id);
        member.state.conditions = member.state.conditions.filter((condition) => condition !== 'Escaped');
        delete member.state.conditionTurns.Escaped;
        logs.push(`${member.character.name} rejoins the fight.`);
      }
      member.state.guarding = false;
      if (!action) {
        logs.push(`${member.character.name} holds position.`);
        continue;
      }
      if (action.minor === 'equip') {
        logs.push(
          `${member.character.name} cannot change equipment during combat; their main action continues with current equipment.`,
        );
      }
      if (member.state.conditions.includes('Stunned')) {
        logs.push(`${member.character.name} is stunned and loses their main action.`);
      } else if (action.main === 'defend') {
        member.state.guarding = true;
        logs.push(`${member.character.name} defends (+2 defense).`);
      } else if (action.main === 'flee') {
        if (fled.has(member.id)) {
          logs.push(`${member.character.name} continues away from the fight.`);
        } else {
          const mod = modifier(member.state.stats.DEX);
          const die = roll(20, 'Flee combat', member.id, 'DEX', mod, action.dc ?? 10);
          if (die !== 1 && (die === 20 || die + mod >= (action.dc ?? 10))) {
            fled.add(member.id);
            logs.push(`${member.character.name} escapes the fight.`);
          } else {
            logs.push(`${member.character.name} cannot escape.`);
            if (die === 1) {
              const hp = member.state.hp;
              damage(member.state, 4, 'Catastrophic failed escape.', true);
              logs.push(
                `${member.character.name} takes ${hp - member.state.hp} damage from a catastrophic failed escape${member.state.hp === 0 ? ' and dies' : ''}.`,
              );
            }
          }
        }
      } else if (action.main === 'move' || action.main === 'interact') {
        const kind = action.main === 'move' ? 'movement' : 'interaction';
        const intent = action.description || `${kind} within the scene`;
        const mod = modifier(member.state.stats[action.stat]);
        const die =
          action.dc === undefined
            ? undefined
            : roll(
                20,
                `${member.character.name}: ${intent}`.slice(0, 500),
                member.id,
                action.stat,
                mod,
                action.dc,
              );
        const success = die === undefined || (die !== 1 && (die === 20 || die + mod >= action.dc!));
        logs.push(
          `${member.character.name} ${success ? 'carries out' : 'fails to carry out'} their ${kind}: ${intent}`,
        );
        if (die === 1) {
          const hp = member.state.hp;
          damage(member.state, 4, `Catastrophic failed ${kind}: ${intent}`, true);
          logs.push(
            `${member.character.name}'s risky ${kind} backfires for ${hp - member.state.hp} damage${member.state.hp === 0 ? ' and causes their death' : ''}.`,
          );
        }
      } else if (action.main === 'ability') {
        const ability = availableAbility(member.character, member.state, action.abilityName!, 'combat');
        if (ability.effect === 'strike') {
          const target = encounter.enemies.find(
            (enemy) => enemy.id === action.targetId && enemy.hp > 0 && !enemy.withdrawn,
          );
          if (!target)
            logs.push(
              `${member.character.name}'s ${ability.name} target is unavailable; the main action is spent and the use is preserved.`,
            );
          else {
            spendAbility(member.state, ability);
            logs.push(`${member.character.name} uses ${ability.name}; its encounter use is spent.`);
            attack(member, target, false, null, ability);
          }
        } else {
          const target =
            action.targetId === null
              ? member
              : members.find(
                  (ally) =>
                    ally.id === action.targetId &&
                    (ally.state.hp > 0 || (ability.effect === 'mend' && isDowned(ally.state))) &&
                    !fled.has(ally.id),
                );
          const mode =
            target?.character.traits.find((trait) => trait.healing !== 'normal')?.healing ?? 'normal';
          if (!target)
            logs.push(
              `${member.character.name}'s ${ability.name} has no effect: the living ally target is unavailable. The main action is spent and the use is preserved.`,
            );
          else if (ability.effect === 'mend' && mode !== ability.healing)
            logs.push(
              `${member.character.name}'s ${ability.name} has no effect: the healing is incompatible with ${target.character.name}. The main action is spent and the use is preserved.`,
            );
          else if (ability.effect === 'mend' && target.state.hp >= target.state.maxHp)
            logs.push(
              `${member.character.name}'s ${ability.name} has no effect: ${target.character.name} is already at full health. The main action is spent and the use is preserved.`,
            );
          else {
            const strength = abilityStrength(ability);
            if (ability.effect === 'mend') {
              const restored = mendWithAbility(
                member.character,
                member.state,
                ability.name,
                target,
                (sides, label, _actor, stat) => roll(sides, label, member.id, stat),
              );
              logs.push(
                `${member.character.name} uses ${ability.name}: ${target.character.name} recovers ${restored} HP (${ability.healing} healing).`,
              );
            } else if (ability.effect === 'guard') {
              target.state.abilityGuard = Math.max(target.state.abilityGuard ?? 0, 3 + strength);
              logs.push(
                `${member.character.name} uses ${ability.name}: ${target.character.name} gains +${target.state.abilityGuard} defense against the next enemy attack.`,
              );
            } else {
              target.state.abilityAssist = Math.max(target.state.abilityAssist ?? 0, strength);
              logs.push(
                `${member.character.name} uses ${ability.name}: ${target.character.name} gains advantage${strength ? ` and +${strength}` : ''} on their next attack.`,
              );
            }
            if (ability.effect !== 'mend') spendAbility(member.state, ability);
          }
        }
      } else {
        const target = encounter.enemies.find((e) => e.id === action.targetId && e.hp > 0 && !e.withdrawn);
        if (!target) {
          logs.push(`${member.character.name}'s target is no longer available; the main action is spent.`);
        } else if (action.main === 'attack') attack(member, target, false, action.weaponSlot);
        else {
          const assist = action.effect === 'influence' ? undefined : member.state.abilityAssist;
          const mod =
            modifier(member.state.stats[action.stat]) +
            (action.effect === 'influence' ? 0 : equipmentBonus(member.state, action.stat, 'attackBonus')) +
            (assist ?? 0);
          const dc = Math.max(action.effect === 'influence' ? 15 : 5, action.dc ?? 10);
          let die = roll(20, action.description || 'Creative combat action', member.id, action.stat, mod, dc);
          if (assist !== undefined) {
            die = Math.max(die, roll(20, 'Assisted creative attack', member.id, action.stat, mod, dc));
            delete member.state.abilityAssist;
          }
          if (die === 1) {
            damage(member.state, 4, 'A catastrophic improvised action.', true);
            logs.push(
              `${member.character.name}'s improvised action backfires for 4 damage${member.state.hp === 0 ? ' and causes their death' : ''}.`,
            );
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
              const dealt = weaponDamage(
                improvised,
                roll,
                member.id,
                modifier(member.state.stats[action.stat]),
                die === 20,
              );
              target.hp = Math.max(0, target.hp - dealt);
              logs.push(
                `${member.character.name}'s creative action deals ${dealt} damage to ${target.name}${target.hp === 0 ? `, killing ${target.name}` : ''}.`,
              );
            }
          } else logs.push(`${member.character.name}'s creative action fails.`);
        }
      }
      if (member.state.hp > 0 && (!fled.has(member.id) || wasEscaped)) {
        if (action.minor === 'heal') {
          minorAction(member, () => {
            if (!action.minorItemId) throw new RuleError('Choose a healing consumable.');
            const target = action.minorTargetId
              ? members.find((ally) => ally.id === action.minorTargetId)
              : member;
            if (!target) throw new RuleError('The healing target is unavailable.');
            if (target.state.hp >= target.state.maxHp)
              throw new RuleError('The target is already at full health; the consumable is preserved.');
            const wasDowned = isDowned(target.state);
            healWithItem(member.character, member.state, action.minorItemId, target);
            logs.push(
              target.id === member.id
                ? `${member.character.name} uses a healing consumable.`
                : `${member.character.name} uses a healing consumable on ${target.character.name}${wasDowned ? ', helping them up' : ''}.`,
            );
          });
        }
        if (action.minor === 'offhand') {
          const target = encounter.enemies.find((e) => e.id === action.targetId && e.hp > 0 && !e.withdrawn);
          if (target) attack(member, target, true, action.weaponSlot);
          else
            logs.push(
              `${member.character.name}'s off-hand target is unavailable; the minor action is spent.`,
            );
        }
      } else if (action.minor === 'heal' || action.minor === 'offhand') {
        logs.push(
          `${member.character.name} cannot take their ${action.minor === 'heal' ? 'healing' : 'off-hand attack'} minor action after ${member.state.hp <= 0 ? 'dying' : 'escaping the fight'}.`,
        );
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
      if (!candidates.length) continue;
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
      delete target.state.abilityGuard;
      if (die === 1) {
        enemy.hp = Math.max(0, enemy.hp - 2);
        logs.push(
          `${enemy.name} catastrophically fails and suffers 2 damage${enemy.hp === 0 ? ' and dies' : ''}.`,
        );
      } else if (die === 20 || die + enemy.attack >= targetDefense) {
        const weapon = { ...baseItem(enemy.id, enemy.name, 'weapon'), damage: enemy.damage };
        let naturalMax = true;
        const dealt = weaponDamage(
          weapon,
          (...args) => {
            const result = roll(...args);
            naturalMax &&= result === args[0];
            return result;
          },
          enemy.id,
          enemy.attack,
          die === 20,
        );
        damage(target.state, dealt, `Killed by ${enemy.name}.`, die === 20 || naturalMax);
        logs.push(
          `${enemy.name} ${die === 20 ? 'critically hits' : 'hits'} ${target.character.name} for ${dealt}${target.state.hp === 0 ? `, ${isDowned(target.state) ? 'downing' : 'killing'} ${target.character.name}` : ''}.`,
        );
        if (
          target.state.hp > 0 &&
          enemy.onHit &&
          !target.character.traits.some((t) => t.immunities.includes(enemy.onHit!))
        ) {
          if (!target.state.conditions.includes(enemy.onHit)) {
            target.state.conditions.push(enemy.onHit);
            logs.push(`${target.character.name} becomes ${enemy.onHit} from ${enemy.name}'s attack.`);
          }
          target.state.conditionTurns[enemy.onHit] = 2;
        }
      } else logs.push(`${enemy.name} misses ${target.character.name}.`);
    }
  }
  for (const member of members) {
    for (const condition of [...member.state.conditions]) {
      if (condition === 'Downed') continue;
      const immune = member.character.traits.some((t) => t.immunities.some((c) => c === condition));
      if (!immune && ['Bleeding', 'Burning', 'Poisoned'].includes(condition)) {
        const hp = member.state.hp;
        damage(member.state, condition === 'Burning' ? 2 : 1, `${condition} damage.`);
        if (member.state.hp < hp)
          logs.push(
            `${member.character.name} takes ${hp - member.state.hp} ${condition} damage${member.state.hp === 0 ? ' and is downed' : ''}.`,
          );
      }
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
    !encounter.victory &&
    members.some((m) => m.state.hp > 0 && m.state.conditions.includes('Escaped')) &&
    members.every((m) => isDead(m.state) || (m.state.hp > 0 && m.state.conditions.includes('Escaped')));
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
        const hp = member.state.hp;
        member.state.hp = Math.min(
          member.state.maxHp,
          member.state.hp + member.character.traits.reduce((n, t) => n + (t.regeneration ?? 0), 0),
        );
        if (member.state.hp > hp)
          logs.push(
            `${member.character.name} recovers ${member.state.hp - hp} HP from regeneration after victory.`,
          );
      }
    logs.push(`Victory. Each surviving character gains ${xp} XP. A physical item must be offered as loot.`);
  }
  if (encounter.victory || encounter.escaped)
    for (const member of members) {
      member.state.guarding = false;
      delete member.state.abilityGuard;
      delete member.state.abilityAssist;
      member.state.conditions = member.state.conditions.filter((c) => c !== 'Escaped');
      delete member.state.conditionTurns.Escaped;
    }
  return logs;
}
