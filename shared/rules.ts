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
  type EnvironmentalState,
  environmentalActionSchema,
  stats,
  slots,
} from './schema';
import { ailments, ailmentRules, conditionDuration, isAilment } from './ailments';

type ConditionState = Pick<CharacterState, 'conditions' | 'conditionTurns'> &
  Partial<Pick<CharacterState, 'equipment'>>;
export const hasImmunity = (character: Character, state: ConditionState, name: string) =>
  character.traits.some((trait) => trait.immunities.some((immune) => immune === name)) ||
  (!!state.equipment &&
    equippedItems(state as CharacterState).some((item) =>
      item.immunities?.some((immune) => immune === name),
    ));
export function removeCondition(state: ConditionState, name: string) {
  state.conditions = state.conditions.filter((condition) => condition !== name);
  delete state.conditionTurns[name];
}
export function applyCondition(state: ConditionState, name: string, character?: Character) {
  if (character && hasImmunity(character, state, name)) return false;
  if (!state.conditions.includes(name)) state.conditions.push(name);
  state.conditionTurns[name] = conditionDuration(name);
  return true;
}
export const matchingCures = (ability: Ability, state: ConditionState) =>
  (ability.cures ?? []).filter((condition) => state.conditions.includes(condition));
export function cureWithAbility(ability: Ability, state: ConditionState) {
  const cured = matchingCures(ability, state);
  for (const condition of cured) removeCondition(state, condition);
  return cured;
}
export const incapacitatingCondition = (state: ConditionState) =>
  state.conditions.find((condition) => ['Stunned', 'Frozen', 'Electrocuted'].includes(condition));
export const ailmentCheckPenalty = (state: ConditionState, stat: Stat) =>
  stat === 'DEX' && state.conditions.includes('Chilled') ? 2 : 0;
const shockedDamage = (conditions: string[], amount: number) =>
  Math.max(0, amount) + (amount > 0 && conditions.includes('Shocked') ? 1 : 0);
export function tickConditions(member: Member, moving = false): string[] {
  const logs: string[] = [];
  const { state, character } = member;
  if (isDead(state)) return logs;
  const conditions = [...state.conditions];
  for (const condition of conditions) {
    if (condition === 'Downed' || condition === 'Escaped') continue;
    const immune = hasImmunity(character, state, condition);
    const amount =
      !immune && isAilment(condition)
        ? ailmentRules[condition].damage + (condition === 'Bleeding' && moving ? 1 : 0)
        : 0;
    if (amount) {
      const hp = state.hp;
      damage(state, amount, `${condition} damage.`);
      if (hp > state.hp)
        logs.push(
          `${character.name} takes ${hp - state.hp} ${condition} damage${state.hp === 0 ? ` and ${isDowned(state) ? 'is downed' : 'dies'}` : ''}.`,
        );
    }
  }
  for (const condition of conditions) {
    if (condition === 'Downed' || condition === 'Escaped') continue;
    const immune = hasImmunity(character, state, condition);
    state.conditionTurns[condition] = (state.conditionTurns[condition] ?? conditionDuration(condition)) - 1;
    if (state.conditionTurns[condition] <= 0 || immune) removeCondition(state, condition);
  }
  return logs;
}

export class RuleError extends Error {}

export const RULESET = 'roguelike-v1';
export const modifier = (score: number) => Math.floor((score - 5) / 2);
export const abilityStrength = (ability: Ability) => ability.level - 1;
export const abilityDice = (ability: Ability) =>
  ability.dice ?? (ability.effect === 'strike' ? '2d6' : '1d6');
export const abilityBonus = (ability: Ability) =>
  (ability.kind === 'utility' && ability.effect === 'assist' ? 2 : 0) +
  (ability.bonus ?? 0) +
  abilityStrength(ability) * (['strike', 'mend'].includes(ability.effect) ? 2 : 1);
export function abilityMechanics(ability: Ability): string {
  const bonus = abilityBonus(ability);
  if (ability.kind === 'utility' && ability.effect === 'assist')
    return `Advantage and +${bonus} on a relevant ${ability.stat} check · In or out of combat · Main action`;
  const effect = {
    strike: `${abilityDice(ability)} + ${ability.stat} modifier${bonus ? ` + ${bonus}` : ''} damage · Attack roll vs defense`,
    mend: `${abilityDice(ability)} + ${ability.stat} modifier${bonus ? ` + ${bonus}` : ''} HP restored · Self or ally`,
    guard: `+${3 + bonus} defense against the next enemy attack · Self or ally`,
    assist: `Advantage${bonus ? ` and +${bonus}` : ''} on the next attack · Self or ally`,
    cleanse: 'Remove the listed ailments · Self or ally',
  }[ability.effect];
  const ailmentEffect = ability.inflicts
    ? ` · Inflicts ${ability.inflicts} on hit (${conditionDuration(ability.inflicts)} turns)`
    : ability.cures?.length
      ? ` · Cures ${ability.cures.join(' and ')}`
      : '';
  return `${effect}${ailmentEffect}${['mend', 'cleanse'].includes(ability.effect) ? ' · In or out of combat' : ''} · Main action`;
}
export function abilityPowerSummary(ability: Ability, scores: Record<Stat, number>): string | null {
  if (!['strike', 'mend'].includes(ability.effect)) return null;
  const [count, sides] = abilityDice(ability).split('d').map(Number);
  const bonus = modifier(scores[ability.stat]) + abilityBonus(ability);
  let totals = [0];
  for (let i = 0; i < count; i++)
    totals = totals.flatMap((total) => Array.from({ length: sides }, (_, face) => total + face + 1));
  const amounts = totals.map((total) => Math.max(1, total + bonus));
  // const average = Math.round((amounts.reduce((sum, value) => sum + value, 0) / amounts.length) * 10) / 10;
  const deviation = Math.sqrt((count * (sides * sides - 1)) / 12);
  //const consistency = deviation <= 2 ? 'Steady dice' : deviation <= 3 ? 'Balanced dice' : 'Swingy dice';
  const unit = ability.effect === 'strike' ? 'damage' : 'HP';
  // const scope = ability.effect === 'strike' ? 'on a normal hit' : 'before HP cap';
  const scope = '';
  return `${Math.min(...amounts)}–${Math.max(...amounts)} ${unit}`;
}
export const equippedItems = (state: CharacterState) =>
  Object.values(state.equipment).filter(
    (item, i, all): item is Item => !!item && all.findIndex((other) => other?.id === item.id) === i,
  );
export const shieldBlockSides = (rarity: Item['rarity']) =>
  ({ Common: 4, Uncommon: 6, Rare: 8, Legendary: 10, Cursed: 10 })[rarity];
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
type GrantedAbility = Ability & { equipmentId?: string };
export const abilityUseKey = (ability: GrantedAbility) =>
  ability.equipmentId ? `equipment:${ability.equipmentId}` : ability.name;
export function availableAbilities(character: Character, state?: CharacterState): GrantedAbility[] {
  return [
    ...character.abilities,
    ...(state ? equippedItems(state) : []).flatMap((item) =>
      item.grantedAbility
        ? [
            {
              ...item.grantedAbility,
              name: `${item.grantedAbility.name.slice(0, 60)} (${slots.find((slot) => state!.equipment[slot]?.id === item.id)})`,
              equipmentId: item.id,
            },
          ]
        : [],
    ),
  ];
}
export function availableAbility(
  character: Character,
  state: CharacterState,
  name: string,
  kind?: Ability['kind'],
): GrantedAbility {
  const ability = availableAbilities(character, state).find(
    (ability) => ability.name === name && (!kind || ability.kind === kind),
  );
  if (!ability) throw new RuleError('Choose a current ability for this kind of action.');
  if ((state.abilityUses?.[abilityUseKey(ability)] ?? 0) >= 1)
    throw new RuleError(
      `${character.name}'s ${ability.name} has already been used. It recharges after a successful encounter.`,
    );
  return ability;
}
export function spendAbility(state: CharacterState, ability: GrantedAbility) {
  state.abilityUses = { ...state.abilityUses, [abilityUseKey(ability)]: 1 };
}
export function resetAbilities(character: Character, state: CharacterState, kind: Ability['kind']) {
  state.abilityUses = Object.fromEntries(
    Object.entries(state.abilityUses ?? {}).filter(
      ([name]) =>
        !availableAbilities(character, state).some(
          (ability) => abilityUseKey(ability) === name && ability.kind === kind,
        ),
    ),
  );
  if (kind === 'combat') {
    delete state.abilityGuard;
    delete state.abilityAssist;
  }
}
export function startingStats(character: Character): Record<Stat, number> {
  const result = { STR: 5, DEX: 5, INT: 5, CHA: 5, CON: 5, WIS: 5 };
  if (new Set(character.traits.map((t) => t.id)).size !== character.traits.length)
    throw new RuleError('A character cannot have a trait twice.');
  for (const trait of character.traits) for (const stat of stats) result[stat] += trait.stats[stat] ?? 0;
  for (const stat of character.creationBonuses?.attributes ?? []) result[stat]++;
  if (Object.values(result).some((n) => n < 0 || n > 13))
    throw new RuleError('Starting stats must be between 0 and 13 after all trait modifiers.');
  const all = character.traits;
  if (
    all.reduce((n, t) => n + t.defense, 0) > 1 ||
    all.reduce((n, t) => n + t.regeneration, 0) > 1 ||
    Math.abs(all.reduce((n, t) => n + t.hp, 0)) > 4
  )
    throw new RuleError('Trait bonuses cannot stack beyond +1 defense, +1 regeneration, or ±4 HP.');
  if (slots.every((slot) => all.some((t) => t.blocked.includes(slot))))
    throw new RuleError('Leave at least one equipment slot usable for starting equipment.');
  return result;
}
export function characterDrawbacks(character: Character): { key: string; label: string; severity: 1 | 2 }[] {
  const traits = character.traits;
  const keys = [
    ...slots.filter((slot) => traits.some((t) => t.blocked.includes(slot))).map((slot) => `slot:${slot}`),
    ...stats
      .filter((stat) => traits.reduce((n, t) => n + t.stats[stat], 0) < 0)
      .map((stat) => `stat:${stat}`),
    ...(traits.some((t) => t.heavyRestricted) ? ['heavy'] : []),
    ...(traits.reduce((n, t) => n + t.hp, 0) < 0 ? ['hp'] : []),
  ];
  return keys.map((key) => {
    if (key.startsWith('slot:')) {
      const slot = key.slice(5);
      const label = {
        left: 'Left hand unavailable',
        right: 'Right hand unavailable',
        body: 'Cannot wear body armour',
        head: 'Cannot wear helmets',
        boots: 'Cannot wear boots',
        relic: 'Cannot equip relics',
      }[slot as Slot];
      return { key, label, severity: ['left', 'right', 'body'].includes(slot) ? 2 : 1 };
    }
    if (key.startsWith('stat:')) {
      const stat = key.slice(5) as Stat;
      const delta = traits.reduce((n, t) => n + t.stats[stat], 0);
      return { key, label: `Reduced ${stat} (${delta})`, severity: delta <= -3 ? 2 : 1 };
    }
    if (key === 'hp') {
      const hp = traits.reduce((n, t) => n + t.hp, 0);
      return { key, label: `Reduced maximum HP (${hp})`, severity: hp <= -3 ? 2 : 1 };
    }
    return {
      key,
      label: 'Cannot use heavy equipment',
      severity: 1,
    };
  });
}
export const characterHandicaps = (character: Character) => characterDrawbacks(character).map((d) => d.key);

// Mechanics use server dice; the model supplies the affinity and character-specific prose.
export function rollCharacterCreation(
  character: Character,
  preferred: Ability['effect'],
  handicapCount: number,
  draw: (sides: number) => number,
): Character {
  if (characterHandicaps(character).length !== handicapCount || handicapCount > 2)
    throw new RuleError(`Generate exactly ${handicapCount} mechanical drawbacks in total.`);
  const options = character.abilities;
  if (
    options.length !== 4 ||
    options.filter((a) => a.kind === 'combat').length !== 2 ||
    options.filter((a) => a.kind === 'utility').length !== 2 ||
    options.some((a) => a.level !== 1) ||
    new Set(options.map((a) => a.name.toLowerCase())).size !== 4
  )
    throw new RuleError('Generate two distinct combat and two distinct utility ability offers at level 1.');
  const pick = <T>(values: T[]) => values[values.length === 1 ? 0 : draw(values.length) - 1];
  const scores = startingStats(character);
  let pool = (['strike', 'mend', 'guard', 'assist', 'cleanse'] as const).flatMap((effect) =>
    Array<Ability['effect']>(effect === preferred ? 5 : 1).fill(effect),
  );
  const abilityOptions = options.map((option): Ability => {
    const effect = option.kind === 'utility' ? option.effect : pick(pool);
    if (option.kind === 'combat') pool = pool.filter((candidate) => candidate !== effect);
    const power =
      effect === 'strike'
        ? pick([
            { dice: '2d4', bonus: 2 },
            { dice: '2d6', bonus: 0 },
            { dice: '1d12', bonus: 0 },
          ] as const)
        : effect === 'mend'
          ? pick([
              { dice: '1d4', bonus: 2 },
              { dice: '1d6', bonus: 1 },
              { dice: '1d8', bonus: 0 },
            ] as const)
          : { dice: undefined, bonus: draw(3) === 3 ? 1 : 0 };
    let candidates: Stat[] =
      option.kind === 'utility' || effect === 'strike'
        ? [option.stat, ...stats]
        : effect === 'mend'
          ? ['CON', 'WIS', 'INT']
          : effect === 'guard'
            ? ['CON', 'STR', 'DEX']
            : ['CHA', 'WIS', 'INT'];
    if (candidates.every((stat) => scores[stat] < 5)) candidates = [...stats];
    const stat = candidates.reduce((best, stat) => (scores[stat] > scores[best] ? stat : best));
    return {
      ...option,
      effect,
      stat,
      ...power,
    };
  });
  const result: Character = {
    ...character,
    abilities: [],
    abilityOptions,
    creationBonuses: { attributes: [], abilityPower: 0, version: 2 },
  };
  const severity = characterDrawbacks(character).reduce((sum, drawback) => sum + drawback.severity, 0);
  for (let i = 0; i < severity; i++) {
    if (draw(2) === 1) {
      const current = startingStats(result);
      // Award a whole modifier increase; keep reduced attributes below their baseline.
      const eligible = stats.filter((stat) => {
        const next = current[stat] + (current[stat] % 2 === 0 ? 1 : 2);
        return next <= 13 && (current[stat] >= 5 || next < 5);
      });
      if (eligible.length) {
        const stat = pick(eligible);
        const points = current[stat] % 2 === 0 ? 1 : 2;
        for (let j = 0; j < points; j++) result.creationBonuses!.attributes.push(stat);
        continue;
      }
    }
    result.creationBonuses!.abilityPower++;
  }
  for (const ability of abilityOptions)
    if (ability.kind === 'combat')
      ability.bonus = (ability.bonus ?? 0) + result.creationBonuses!.abilityPower;
  for (const ability of abilityOptions) {
    // Roll secondary mechanics after base power and compensation so existing rolls keep their order.
    delete ability.inflicts;
    delete ability.cures;
    if (ability.kind === 'utility' && ability.effect === 'assist') continue;
    if (ability.effect === 'cleanse') ability.cures = [pick([...ailments])];
    else if (draw(2) === 1) {
      if (ability.effect === 'strike') ability.inflicts = pick([...ailments]);
      else ability.cures = [pick([...ailments])];
    }
  }
  result.stats = startingStats(result);
  return result;
}

export function chooseStartingAbilities(character: Character, names: string[]): Ability[] {
  const options = character.abilityOptions;
  const chosen = names.map((name) => options?.find((ability) => ability.name === name));
  if (
    !options ||
    names.length !== 2 ||
    chosen.some((ability) => !ability) ||
    new Set(chosen.map((ability) => ability!.kind)).size !== 2
  )
    throw new RuleError('Choose one offered in-combat ability and one offered out-of-combat ability.');
  return chosen as Ability[];
}
export function normalizeCharacter(character: Character): Character {
  const result = { ...character, role: character.species, stats: startingStats(character), equipment: [] };
  if (result.creationBonuses) {
    const count = characterHandicaps(result).length;
    const { attributes, abilityPower } = result.creationBonuses;
    const severity = characterDrawbacks(result).reduce((sum, d) => sum + d.severity, 0);
    const base = startingStats({ ...result, creationBonuses: undefined });
    const modifierGains = stats.reduce(
      (sum, stat) => sum + modifier(result.stats[stat]) - modifier(base[stat]),
      0,
    );
    const validCompensation =
      result.creationBonuses.version === 2
        ? modifierGains + abilityPower === severity &&
          attributes.length <= modifierGains * 2 &&
          stats.every((stat) => base[stat] >= 5 || result.stats[stat] < 5)
        : attributes.length + abilityPower >= count &&
          attributes.length + abilityPower <= count * 2 &&
          abilityPower <= count;
    if (
      count > 2 ||
      !validCompensation ||
      !result.abilityOptions ||
      result.abilityOptions.some((a) => a.kind === 'combat' && (a.bonus ?? 0) < abilityPower)
    )
      throw new RuleError('New characters allow zero to two compensated mechanical drawbacks.');
  }
  if (result.abilityOptions) {
    const options = result.abilityOptions;
    if (
      new Set(options.map((a) => a.name.toLowerCase())).size !== 4 ||
      options.filter((a) => a.kind === 'combat').length !== 2 ||
      options.filter((a) => a.kind === 'utility').length !== 2 ||
      options.some((a) => a.level !== 1) ||
      new Set(options.filter((a) => a.kind === 'combat').map((a) => a.effect)).size !== 2
    )
      throw new RuleError('Provide two distinct combat effects and two utility ability offers.');
    if (result.abilities.length)
      result.abilities = chooseStartingAbilities(
        result,
        result.abilities.map((a) => a.name),
      );
  }
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
      modifier(state.stats.CON) * 2 +
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
      .reduce((n, item) => n + (item?.defense ?? 0), 0) -
    (state.conditions.includes('Chilled') ? 2 : 0)
  );
}
export const baseItem = (id: string, name: string, kind: Item['kind']): Item => ({
  id,
  name,
  kind,
  rarity: 'Common',
  scaling: [],
  requirements: { STR: 0, DEX: 0, INT: 0, CHA: 0, CON: 0, WIS: 0 },
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
  if (['weapon', 'shield', 'focus'].includes(item.kind)) {
    if (item.hands === 2 && (blocked.has('left') || blocked.has('right'))) return [];
    return (['right', 'left'] as Slot[]).filter((slot) => !blocked.has(slot));
  }
  const slot = (
    { armour: 'body', helmet: 'head', boots: 'boots', relic: 'relic' } as Partial<Record<Item['kind'], Slot>>
  )[item.kind];
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
        !copy.equipment[slot] &&
        (!(slot === 'left' || slot === 'right') ||
          item.hands !== 2 ||
          (!copy.equipment.left && !copy.equipment.right)),
    );
    if (empty) equip(character, copy, item.id, empty);
  }
  copy.equipmentChosen = true;
  copy.starterEquipment = [];
  Object.assign(state, copy);
}
export function initialState(character: Character, seed: string): CharacterState {
  const stats = startingStats(character);
  const potion: Item = {
    ...baseItem(`${seed}-healing`, character.healingItemName, 'consumable'),
    healing: 6,
    description: 'Restores 6 HP.',
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
    equipment: { left: null, right: null, body: null, head: null, boots: null, relic: null },
    conditions: [],
    conditionTurns: {},
    starterEquipment: character.equipmentOptions.map((item) => ({ ...item, id: `${seed}-${item.id}` })),
    equipmentChosen: false,
    kills: 0,
    bosses: 0,
    deathReason: null,
    downedThisEncounter: false,
    restedEncounter: null,
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
  const hand = slot === 'left' || slot === 'right';
  if (
    hand &&
    item.hands === 2 &&
    character.traits.some((t) => t.blocked.includes('left') || t.blocked.includes('right'))
  )
    throw new RuleError('Your character’s anatomy prevents using a two-handed item.');
  for (const stat of stats)
    if (state.stats[stat] < item.requirements[stat])
      throw new RuleError(`This item requires ${item.requirements[stat]} ${stat}.`);
  if (
    hand
      ? !['weapon', 'shield', 'focus'].includes(item.kind)
      : ({ body: 'armour', head: 'helmet', boots: 'boots', relic: 'relic' } as Record<string, string>)[
          slot
        ] !== item.kind
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
  for (const condition of [...state.conditions])
    if (hasImmunity(character, state, condition)) removeCondition(state, condition);
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
export const isInCombat = (scene: Pick<Scene, 'encounter'>, state: Pick<CharacterState, 'conditions'>) =>
  !!scene.encounter &&
  !scene.encounter.victory &&
  !scene.encounter.escaped &&
  !state.conditions.includes('Escaped');
export const canInteract = (
  scene: Pick<Scene, 'encounter'>,
  actor: Pick<CharacterState, 'conditions'>,
  target: Pick<CharacterState, 'conditions'>,
) => isInCombat(scene, actor) === isInCombat(scene, target);
export function heal(state: CharacterState, amount: number) {
  if (isDead(state)) throw new RuleError('A dead character cannot be healed.');
  if (isDowned(state)) state.downedThisEncounter = true;
  const hp = state.hp;
  state.hp = Math.min(state.maxHp, state.hp + Math.max(0, amount));
  if (state.hp > 0) {
    state.conditions = state.conditions.filter((condition) => condition !== 'Downed');
    delete state.conditionTurns.Downed;
    state.deathReason = null;
  }
  return state.hp - hp;
}
export function helpUp(state: CharacterState) {
  if (!isDowned(state)) throw new RuleError('Choose a downed party member to help up.');
  state.downedThisEncounter = true;
  return heal(state, 1);
}
export function recoverAfterEncounter(members: Member[]) {
  const logs: string[] = [];
  for (const member of members) {
    const { character, state } = member;
    if (isDead(state)) continue;
    const restored = heal(
      state,
      Math.max(1, state.stats.CON) + character.traits.reduce((sum, trait) => sum + trait.regeneration, 0),
    );
    if (restored) logs.push(`${character.name} recovers ${restored} HP after the successful encounter.`);
    const ownedAbilities = availableAbilities(character, state).concat(
      state.inventory.flatMap((item) =>
        item.grantedAbility ? [{ ...item.grantedAbility, equipmentId: item.id }] : [],
      ),
    );
    for (const ability of ownedAbilities) {
      const key = abilityUseKey(ability);
      const used = state.abilityUses?.[key] ?? 0;
      if (used > 0) {
        state.abilityUses = { ...state.abilityUses, [key]: Math.max(0, used - 1) };
        logs.push(`${character.name}'s ${ability.name} regains one charge.`);
      }
    }
    state.downedThisEncounter = false;
    state.guarding = false;
    delete state.abilityGuard;
    delete state.abilityAssist;
  }
  return logs;
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
  const ability = availableAbility(character, state, abilityName);
  if (!['mend', 'cleanse'].includes(ability.effect))
    throw new RuleError('Choose a healing or cleansing ability.');
  if (isDead(target.state)) throw new RuleError('A dead character cannot be healed.');
  const cures = matchingCures(ability, target.state);
  if (ability.effect === 'cleanse') {
    if (!cures.length) throw new RuleError('The target has no matching ailment.');
    cureWithAbility(ability, target.state);
    spendAbility(state, ability);
    return 0;
  }
  if (target.state.hp >= target.state.maxHp && !cures.length)
    throw new RuleError('The target is already at full health.');
  const [count, sides] = abilityDice(ability).split('d').map(Number);
  let rolled = 0;
  for (let i = 0; i < count; i++)
    rolled += roll(sides, `${ability.name}: healing`, character.name, ability.stat);
  const amount = Math.max(1, rolled + modifier(state.stats[ability.stat]) + abilityBonus(ability));
  const restored = heal(target.state, amount);
  cureWithAbility(ability, target.state);
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
export function damage(state: CharacterState, amount: number, cause: string, _fatal = false) {
  if (state.hp <= 0) return;
  state.hp = Math.max(0, state.hp - shockedDamage(state.conditions, amount));
  if (state.hp === 0) {
    state.conditions = state.conditions.filter((condition) => condition !== 'Downed');
    delete state.conditionTurns.Downed;
    const dead = state.downedThisEncounter === true;
    if (!dead) state.conditions.push('Downed');
    state.downedThisEncounter = true;
    state.deathReason = dead ? cause : null;
    state.guarding = false;
    delete state.abilityGuard;
    delete state.abilityAssist;
  }
}
export function initialScene(setting: string): Scene {
  return {
    location: { name: setting, atmosphere: '', hazard: '' },
    encounters: 0,
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
export function weaponDamage(
  item: Item,
  roll: Dice,
  actor: string,
  bonus: number,
  critical = false,
  innateDice?: string,
) {
  let total = 0;
  for (const [part, dice] of [item.damage, innateDice].entries()) {
    if (!dice) continue;
    const [count, sides] = dice.split('d').map(Number);
    for (let i = 0; i < count * (critical ? 2 : 1); i++)
      total += roll(
        sides,
        `${item.name}${part ? ' innate' : ''} damage ${i + 1}`,
        actor,
        item.scaling[0] ?? 'STR',
      );
  }
  return Math.max(1, total + bonus);
}
export function grantEquipmentPowers(item: Item, roll: (sides: number) => number): Item {
  if (item.kind === 'tool') return item;
  if (item.kind === 'consumable' || !['Rare', 'Legendary', 'Cursed'].includes(item.rarity)) return item;
  const offensive = item.kind === 'weapon' || item.kind === 'focus';
  if (!item.onHit && !item.immunities?.length) {
    const choices = ['Burning', 'Chilled', 'Shocked', 'Poisoned', 'Weakened', 'Bleeding'] as const;
    const ailment = choices[roll(choices.length) - 1];
    if (offensive) item.onHit = { ailment, chance: item.kind === 'focus' ? 100 : 25 };
    else item.immunities = [ailment];
  }
  if (item.rarity === 'Legendary' && !item.grantedAbility) {
    const ailment = item.onHit?.ailment ?? item.immunities![0];
    const utilityScopes = {
      boots: {
        stat: 'DEX' as const,
        scope: 'traversing difficult terrain, climbing and keeping your footing',
      },
      helmet: { stat: 'WIS' as const, scope: 'spotting hidden threats and inspecting your surroundings' },
      armour: { stat: 'CON' as const, scope: 'enduring harsh environments and sustained physical exertion' },
      relic: {
        stat: item.scaling[0] ?? 'INT',
        scope: 'investigating ancient objects and interpreting inscriptions',
      },
    };
    const utility = utilityScopes[item.kind as keyof typeof utilityScopes];
    item.grantedAbility = utility
      ? {
          name: `${item.name.slice(0, 55)}: insight`,
          description: `Gain advantage and +2 on a relevant ${utility.stat} check for ${utility.scope}. Requires this item equipped and one charge.`,
          kind: 'utility',
          effect: 'assist',
          level: 1,
          stat: utility.stat,
          bonus: 2,
        }
      : {
          name: `${item.name.slice(0, 55)}: ${offensive ? 'surge' : 'ward'}`,
          description: offensive
            ? `Strike one enemy for 2d8 + attribute modifier + 3 damage and inflict ${ailment}. Requires this item equipped; one main action and one charge.`
            : `Protect yourself or one conscious ally with +5 defense against the next enemy attack and cure ${ailment}. Requires this item equipped; one main action and one charge.`,
          kind: 'combat',
          effect: offensive ? 'strike' : 'guard',
          level: 1,
          stat: item.scaling[0] ?? 'CON',
          bonus: offensive ? 3 : 2,
          ...(offensive ? { dice: '2d8' as const, inflicts: ailment } : { cures: [ailment] }),
        };
  }
  return item;
}

export function randomLoot(
  seed: string,
  level: number,
  roll: (sides: number) => number,
  blueprint: LootBlueprint,
  rarity?: Item['rarity'],
): Item {
  if (blueprint.kind === 'tool')
    return { ...baseItem(seed, blueprint.name, 'tool'), description: blueprint.description };
  if (!rarity) {
    const draw = roll(100);
    rarity =
      draw === 1
        ? 'Cursed'
        : draw === 100
          ? 'Legendary'
          : draw > 80
            ? 'Rare'
            : draw > 55
              ? 'Uncommon'
              : 'Common';
  }
  const rank = { Common: 0, Uncommon: 1, Rare: 2, Legendary: 4, Cursed: 2 }[rarity];
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
    for (const stat of item.scaling) item.requirements[stat] = 3 + Math.min(12, level - 1 + rank);
  return grantEquipmentPowers(item, roll);
}

export function rollEnemyLoot(
  seed: string,
  level: number,
  enemy: Pick<Enemy, 'name' | 'tier' | 'damage' | 'description' | 'equipmentBlueprints'>,
  roll: (sides: number, label: string) => number,
  language = 'English',
): Item[] {
  const draw = (label: string) => roll(100, label);
  const rarities: Item['rarity'][] = [];
  switch (enemy.tier) {
    case 'minor':
      rarities.push(draw('guaranteed loot rarity') <= 50 ? 'Common' : 'Uncommon');
      break;
    case 'normal':
      rarities.push(draw('guaranteed loot rarity') <= 50 ? 'Uncommon' : 'Rare');
      if (draw('extra loot chance') <= 50) {
        const rarity = draw('extra loot rarity');
        rarities.push(rarity <= 60 ? 'Common' : rarity <= 90 ? 'Uncommon' : 'Rare');
      }
      break;
    case 'elite':
    case 'boss':
      rarities.push(
        enemy.tier === 'elite' ? 'Rare' : draw('guaranteed loot rarity') <= 50 ? 'Legendary' : 'Cursed',
      );
      for (let i = 0; i < (enemy.tier === 'elite' ? 2 : 3); i++) {
        const rarity = draw('extra loot rarity');
        rarities.push(
          rarity <= 50 ? 'Common' : rarity <= 80 ? 'Uncommon' : rarity <= 95 ? 'Rare' : 'Legendary',
        );
      }
      break;
  }
  const dutch = language === 'Nederlands';
  const blueprints = enemy.equipmentBlueprints?.filter((item) => item.kind !== 'consumable') ?? [];
  const items = rarities.map((rarity, index) => {
    const suffix =
      index === 0 ? (dutch ? ': wapen' : "'s weapon") : dutch ? `: trofee ${index}` : `'s trophy ${index}`;
    const blueprint = blueprints[index % blueprints.length] ?? {
      name: `${enemy.name}${suffix}`.slice(0, 100),
      kind: index === 0 ? ('weapon' as const) : ('relic' as const),
      scaling: index === 0 ? ['STR' as const] : [],
      hands: 1 as const,
      light: false,
      description: enemy.description.slice(0, 500),
    };
    const item = randomLoot(
      `${seed}-${index}`,
      level,
      (sides) => roll(sides, sides === 100 ? 'loot rarity' : 'equipment ailment'),
      blueprint,
      rarity,
    );
    if (item.kind === 'weapon') item.damage = enemy.damage;
    return item;
  });
  if (draw('healing item chance') <= 50) {
    const blueprint = enemy.equipmentBlueprints?.find((item) => item.kind === 'consumable') ?? {
      name: `${enemy.name}${dutch ? ': genezend middel' : "'s healing item"}`.slice(0, 100),
      kind: 'consumable' as const,
      scaling: [],
      hands: 1 as const,
      light: false,
      description: dutch ? 'Herstelt HP bij gebruik.' : 'Restores HP when used.',
    };
    items.push(
      randomLoot(`${seed}-healing`, level, (sides) => roll(sides, 'loot rarity'), blueprint, 'Common'),
    );
  }
  return items;
}

export type CombatEvent = {
  presentation?: 'log';
  actorId: string | null;
  phase: 'main' | 'minor' | 'aftermath';
  status: 'success' | 'failure' | 'blocked' | null;
  fact: string;
};

export function runCombat(
  members: Member[],
  encounter: Encounter,
  input: CombatInput,
  roll: Dice,
  observe?: (event: CombatEvent) => void,
  environment: EnvironmentalState = { sources: {}, spentResources: [] },
) {
  if (encounter.victory || encounter.escaped) throw new RuleError('This combat has already ended.');
  const logs: string[] = [];
  let actorId: string | null = null;
  let phase: CombatEvent['phase'] = 'main';
  const emit = (status: CombatEvent['status'], ...facts: string[]) => {
    for (const fact of facts) {
      logs.push(fact);
      observe?.({ actorId, phase, status, fact });
    }
  };
  const record = (...facts: string[]) => emit(null, ...facts);
  const recordLog = (...facts: string[]) => {
    for (const fact of facts) {
      logs.push(fact);
      observe?.({ actorId, phase, status: null, fact, presentation: 'log' });
    }
  };
  const blocked = (...facts: string[]) => emit('blocked', ...facts);
  const failed = (...facts: string[]) => emit('failure', ...facts);
  const equipmentAilments = (
    items: Item[],
    weapon: Item,
    target: Enemy | Member,
    offhand = false,
    critical = false,
  ) => {
    const state = 'state' in target ? target.state : target;
    if (state.hp <= 0) return;
    for (const item of items) {
      const effect = item.onHit;
      if (
        !effect ||
        (item.kind === 'weapon'
          ? item.id !== weapon.id
          : item.kind !== 'focus' || offhand || !item.scaling.some((stat) => weapon.scaling.includes(stat)))
      )
        continue;
      const immune =
        'state' in target
          ? hasImmunity(target.character, target.state, effect.ailment)
          : target.equipment?.some((gear) => gear.immunities?.includes(effect.ailment));
      if (
        immune ||
        (!(critical && item.kind === 'weapon') &&
          effect.chance < 100 &&
          roll(100, `${item.name}: ${effect.ailment} chance`, actorId!, weapon.scaling[0] ?? 'STR') >
            effect.chance)
      )
        continue;
      applyCondition(state as ConditionState, effect.ailment);
      record(
        `${'character' in target ? target.character.name : target.name} becomes ${effect.ailment} from ${item.name}.`,
      );
    }
  };
  const initiallyAvailableEnemies = new Set(
    encounter.enemies.filter((enemy) => enemy.hp > 0 && !enemy.withdrawn).map((enemy) => enemy.id),
  );
  const fled = new Set(members.filter((m) => m.state.conditions.includes('Escaped')).map((m) => m.id));
  const moving = new Set<string>();
  const ids = input.actions.map((a) => a.memberId);
  const unavailableAbilities = new Map<string, string>();
  if (new Set(ids).size !== ids.length)
    throw new RuleError('Each character gets one main and one minor action.');
  for (const id of ids)
    if (!members.some((m) => m.id === id && m.state.hp > 0))
      throw new RuleError('Combat action references an unavailable character.');
  for (const action of input.actions) {
    if (action.environment) {
      environmentalActionSchema.parse(action.environment);
      if (
        action.abilityName ||
        action.weaponSlot ||
        (action.environment.operation === 'attack'
          ? action.main !== 'creative' || action.effect !== 'damage'
          : action.main !== 'interact')
      )
        throw new RuleError(
          'Environmental actions cannot substitute for abilities or equipped weapon attacks.',
        );
    }
    if (['help-up', 'heal'].includes(action.main) && action.minor !== 'none')
      throw new RuleError('Helping or healing an ally uses the entire turn.');
    const member = members.find((member) => member.id === action.memberId)!;
    const selectedAbility = availableAbilities(member.character, member.state).find(
      (ability) => ability.name === action.abilityName,
    );
    const utilityCheck = selectedAbility?.kind === 'utility' && selectedAbility.effect === 'assist';
    if (utilityCheck && action.stat !== selectedAbility.stat)
      throw new RuleError('A utility ability must use its saved attribute.');
    if (
      utilityCheck
        ? !['ability', 'creative', 'flee', 'move', 'interact'].includes(action.main)
        : (action.main === 'ability') !== !!action.abilityName
    )
      throw new RuleError('An ability action must name the chosen ability.');
    if (action.abilityName) {
      try {
        availableAbility(member.character, member.state, action.abilityName);
      } catch (error) {
        if (
          !(error instanceof RuleError) ||
          !availableAbilities(member.character, member.state).some(
            (ability) => ability.name === action.abilityName,
          )
        )
          throw error;
        unavailableAbilities.set(member.id, error.message);
      }
    }
    const strikes =
      action.main === 'attack' ||
      action.minor === 'offhand' ||
      (action.main === 'ability' &&
        availableAbilities(member.character, member.state).find(
          (ability) => ability.name === action.abilityName,
        )?.effect === 'strike');
    if (strikes)
      for (const targetId of [action.targetId, action.backupTargetId])
        if (targetId != null && !encounter.enemies.some((enemy) => enemy.id === targetId))
          throw new RuleError('Attack references an unknown enemy target.');
  }
  for (const target of input.enemyTargets)
    if (
      !encounter.enemies.some((e) => e.id === target.enemyId) ||
      !members.some((m) => m.id === target.memberId && m.state.hp > 0)
    )
      throw new RuleError('Enemy target is not available.');
  for (const enemy of encounter.enemies) {
    enemy.conditions ??= [];
    enemy.conditionTurns ??= {};
  }
  const minorAction = (member: Member, resolve: () => void) => {
    try {
      resolve();
    } catch (error) {
      if (!(error instanceof RuleError)) throw error;
      blocked(
        `${member.character.name}'s minor action has no effect: ${error.message} The minor action is spent.`,
      );
    }
  };
  const attackTarget = (
    member: Member,
    action: CombatInput['actions'][number],
    offhand = false,
    ability?: Ability,
  ) => {
    const original = encounter.enemies.find((enemy) => enemy.id === action.targetId);
    if (original && original.hp > 0 && !original.withdrawn) return original;
    if (action.targetId === null && action.allowRetarget !== false) {
      const available = encounter.enemies.filter((enemy) => enemy.hp > 0 && !enemy.withdrawn);
      if (available.length)
        return available[
          available.length === 1
            ? 0
            : roll(available.length, `${member.character.name}: random enemy`, member.id, action.stat) - 1
        ];
    }
    const label = offhand ? 'off-hand attack' : (ability?.name ?? 'attack');
    if (
      (original && initiallyAvailableEnemies.has(original.id)) ||
      (action.targetId === null && initiallyAvailableEnemies.size > 0)
    ) {
      const remaining = encounter.enemies.filter((enemy) => enemy.hp > 0 && !enemy.withdrawn);
      if (!remaining.length) {
        blocked(
          `${member.character.name} skips their ${label}: no enemies remain${ability ? '; the use is preserved' : ''}.`,
        );
        return;
      }
      if (original && action.allowRetarget !== false) {
        const target = remaining.find((enemy) => enemy.id === action.backupTargetId) ?? remaining[0];
        record(
          `${member.character.name} redirects their ${label} from ${original.name} to ${target.name} because ${original.name} ${original.hp <= 0 ? 'fell' : 'withdrew'} earlier this round.`,
        );
        return target;
      }
    }
    blocked(
      offhand
        ? `${member.character.name}'s off-hand target is unavailable; the minor action is spent.`
        : ability
          ? `${member.character.name}'s ${ability.name} target is unavailable; the main action is spent and the use is preserved.`
          : `${member.character.name}'s target is no longer available; the main action is spent.`,
    );
  };
  const attack = (
    member: Member,
    target: Enemy,
    offhand = false,
    slot?: 'left' | 'right' | 'natural' | null,
    ability?: Ability,
  ) => {
    const primary = ability
      ? {
          ...baseItem('ability', ability.name, 'weapon'),
          scaling: [ability.stat],
          damage: abilityDice(ability),
        }
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
      blocked(
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
    const targetDefense = target.defense - (target.conditions!.includes('Chilled') ? 2 : 0);
    let die = roll(
      20,
      `${member.character.name}: ${offhand ? 'off-hand ' : ''}attack with ${weapon.name}`,
      member.id,
      stat,
      mod,
      targetDefense,
    );
    if (assist !== undefined) {
      die = Math.max(
        die,
        roll(20, `${member.character.name}: assisted attack`, member.id, stat, mod, targetDefense),
      );
      delete member.state.abilityAssist;
      record(`${member.character.name} attacks with advantage${assist ? ` and +${assist}` : ''}.`);
    }
    if (die === 1) {
      const harm = roll(4, 'Catastrophic attack backlash', member.id, 'STR');
      const suffered = shockedDamage(member.state.conditions, harm);
      damage(member.state, harm, 'A catastrophic attack failure.', true);
      failed(
        `${member.character.name} rolls a natural 1 with ${weapon.name}: the attack fails catastrophically and causes ${suffered} self-damage${member.state.hp === 0 ? ` and ${isDowned(member.state) ? 'downs them' : 'causes their death'}` : ''}.`,
      );
    } else if (die === 20 || die + mod >= targetDefense) {
      const innate = !ability && weapon.id !== 'natural' ? naturalWeapon(member.character) : undefined;
      const dealt = weaponDamage(
        weapon,
        roll,
        member.id,
        offhand
          ? 0
          : scaling(member.state, weapon) * (innate ? 2 : 1) + (ability ? abilityBonus(ability) : 0),
        die === 20,
        innate?.damage,
      );
      const inflicted = shockedDamage(target.conditions!, dealt);
      target.hp = Math.max(0, target.hp - inflicted);
      emit(
        'success',
        `${member.character.name} ${die === 20 ? 'critically hits' : 'hits'} ${target.name} with ${weapon.name} for ${inflicted}${target.hp === 0 ? `, killing ${target.name}` : ''}.`,
      );
      equipmentAilments(equippedItems(member.state), weapon, target, offhand, die === 20);
      if (
        ability?.inflicts &&
        target.hp > 0 &&
        !target.equipment?.some((gear) => gear.immunities?.includes(ability.inflicts!))
      ) {
        applyCondition(target as ConditionState, ability.inflicts);
        record(`${target.name} becomes ${ability.inflicts} from ${ability.name}.`);
      }
      if (weapon.id === 'natural' && member.character.traits.some((t) => t.lifesteal)) {
        const hp = member.state.hp;
        member.state.hp = Math.min(member.state.maxHp, member.state.hp + 1);
        if (member.state.hp > hp)
          record(`${member.character.name} recovers ${member.state.hp - hp} HP from lifesteal.`);
      }
    } else failed(`${member.character.name} misses ${target.name} with ${weapon.name}.`);
  };
  for (const initiative of encounter.initiative) {
    actorId = initiative.id;
    phase = 'main';
    const member = members.find((m) => m.id === initiative.id);
    if (member) {
      const action = input.actions.find((a) => a.memberId === member.id);
      if (member.state.hp <= 0) {
        if (action) {
          blocked(
            `${member.character.name} cannot carry out their submitted action because they ${isDowned(member.state) ? 'were downed' : 'died'} before their turn.`,
          );
          if (action.minor !== 'none') {
            phase = 'minor';
            blocked(
              `${member.character.name} cannot take their minor action after ${isDowned(member.state) ? 'being downed' : 'dying'}.`,
            );
          }
        }
        continue;
      }
      const selectedAbility = availableAbilities(member.character, member.state).find(
        (ability) => ability.name === action?.abilityName,
      );
      const utility =
        selectedAbility?.kind === 'utility' && selectedAbility.effect === 'assist'
          ? selectedAbility
          : undefined;
      const wasEscaped = fled.has(member.id);
      if (wasEscaped && !action) continue;
      if (
        wasEscaped &&
        action &&
        (action.reengage ||
          ['attack', 'defend', 'creative'].includes(action.main) ||
          (action.main === 'ability' &&
            !utility &&
            !['mend', 'cleanse'].includes(selectedAbility?.effect ?? '')) ||
          action.minor === 'offhand')
      ) {
        fled.delete(member.id);
        member.state.conditions = member.state.conditions.filter((condition) => condition !== 'Escaped');
        delete member.state.conditionTurns.Escaped;
        record(`${member.character.name} rejoins the fight.`);
      }
      const target = members.find((ally) => ally.id === action?.targetId);
      if (
        action &&
        action.main !== 'flee' &&
        ((target && fled.has(member.id) !== fled.has(target.id)) ||
          (fled.has(member.id) && encounter.enemies.some((enemy) => enemy.id === action.targetId)))
      ) {
        blocked(
          `${member.character.name} cannot interact with this target while one of them is outside combat. The main action is spent; resources are preserved.`,
        );
        if (action.minor !== 'none') {
          phase = 'minor';
          blocked(
            `${member.character.name}'s minor action is skipped with the unavailable target; resources are preserved.`,
          );
        }
        continue;
      }
      member.state.guarding = false;
      if (!action) {
        record(`${member.character.name} holds position.`);
        continue;
      }
      if (action.minor === 'equip') {
        phase = 'minor';
        blocked(
          `${member.character.name} cannot change equipment during combat; their main action continues with current equipment.`,
        );
        phase = 'main';
      }
      const incapacitated = incapacitatingCondition(member.state);
      if (incapacitated) {
        blocked(
          incapacitated === 'Stunned'
            ? `${member.character.name} is stunned and loses their main action.`
            : `${member.character.name} is ${incapacitated} and cannot act.`,
        );
      } else if (unavailableAbilities.has(member.id)) {
        blocked(`${unavailableAbilities.get(member.id)} The main action is spent.`);
      } else if (action.blockedReason) {
        blocked(
          `${member.character.name}'s action has no effect: ${action.blockedReason} The main action is spent.`,
        );
      } else if (action.environment?.operation === 'reload') {
        const profile = action.environment;
        const source = environment.sources[profile.sourceId];
        if (source?.ready)
          blocked(`${profile.name} is already ready; reloading has no effect. The main action is spent.`);
        else if (
          profile.consumption !== 'reload' ||
          !profile.reloadResourceKey ||
          environment.spentResources.includes(profile.reloadResourceKey) ||
          profile.reloadSourceId === profile.sourceId
        )
          blocked(
            `${profile.name} cannot be reloaded: no unspent ammunition is available. The main action is spent.`,
          );
        else {
          environment.spentResources.push(profile.reloadResourceKey);
          environment.sources[profile.sourceId] = { profile: source?.profile ?? profile, ready: true };
          emit(
            'success',
            `${member.character.name} reloads ${profile.name}; the supplied ammunition is consumed and the source is ready again.`,
          );
        }
      } else if (action.main === 'help-up' || action.main === 'heal') {
        try {
          const target = members.find(
            (ally) => ally.id === action.targetId && fled.has(member.id) === fled.has(ally.id),
          );
          if (!target || target.id === member.id)
            throw new RuleError('Choose another party member to assist.');
          if (action.main === 'help-up') {
            helpUp(target.state);
            record(`${member.character.name} helps up ${target.character.name}, restoring them to 1 HP.`);
          } else {
            if (!action.mainItemId) throw new RuleError('Choose a healing consumable.');
            if (target.state.hp >= target.state.maxHp)
              throw new RuleError('The target is already at full health; the consumable is preserved.');
            const item = member.state.inventory.find((item) => item.id === action.mainItemId);
            const restored = healWithItem(member.character, member.state, action.mainItemId, target);
            record(
              `${member.character.name} uses ${item!.name} on ${target.character.name}, restoring ${restored} HP.`,
            );
          }
        } catch (error) {
          if (!(error instanceof RuleError)) throw error;
          blocked(
            `${member.character.name}'s assistance has no effect: ${error.message} The main action is spent.`,
          );
        }
      } else if (action.main === 'defend') {
        member.state.guarding = true;
        record(`${member.character.name} defends (+2 defense).`);
      } else if (action.main === 'flee') {
        moving.add(member.id);
        if (fled.has(member.id)) {
          record(`${member.character.name} continues away from the fight.`);
        } else {
          const stat = utility?.stat ?? 'DEX';
          const mod =
            modifier(member.state.stats[stat]) -
            ailmentCheckPenalty(member.state, stat) +
            (utility ? abilityBonus(utility) : 0);
          let die = roll(20, 'Flee combat', member.id, stat, mod, action.dc ?? 10);
          if (utility) {
            die = Math.max(
              die,
              roll(20, `${utility.name}: escape advantage`, member.id, stat, mod, action.dc ?? 10),
            );
            spendAbility(member.state, utility);
            recordLog(`${member.character.name} uses ${utility.name}; its encounter use is spent.`);
          }
          if (die !== 1 && (die === 20 || die + mod >= (action.dc ?? 10))) {
            fled.add(member.id);
            record(`${member.character.name} escapes the fight.`);
          } else {
            failed(`${member.character.name} cannot escape.`);
            if (die === 1) {
              const hp = member.state.hp;
              damage(member.state, 4, 'Catastrophic failed escape.', true);
              record(
                `${member.character.name} takes ${hp - member.state.hp} damage from a catastrophic failed escape${member.state.hp === 0 ? ` and ${isDowned(member.state) ? 'is downed' : 'dies'}` : ''}.`,
              );
            }
          }
        }
      } else if (
        action.main === 'move' ||
        action.main === 'interact' ||
        (utility && action.main === 'ability')
      ) {
        if (action.main === 'move') moving.add(member.id);
        const kind = action.main === 'move' ? 'movement' : 'interaction';
        const intent = action.description || `${kind} within the scene`;
        const stat = utility?.stat ?? action.stat;
        const mod =
          modifier(member.state.stats[stat]) -
          ailmentCheckPenalty(member.state, stat) +
          (fled.has(member.id) ? equipmentBonus(member.state, stat, 'checkBonus') : 0) +
          (utility ? abilityBonus(utility) : 0);
        const dc = action.dc ?? (utility ? 10 : undefined);
        let die =
          dc === undefined
            ? undefined
            : roll(20, `${member.character.name}: ${intent}`.slice(0, 500), member.id, stat, mod, dc);
        if (utility) {
          die = Math.max(
            die!,
            roll(20, `${member.character.name}: ${utility.name} advantage`, member.id, stat, mod, dc),
          );
          spendAbility(member.state, utility);
          recordLog(`${member.character.name} uses ${utility.name}; its encounter use is spent.`);
        }
        const success = die === undefined || (die !== 1 && (die === 20 || die + mod >= dc!));
        emit(
          success ? 'success' : 'failure',
          `${member.character.name} ${success ? 'carries out' : 'fails to carry out'} their ${kind}: ${intent}`,
        );
        if (action.main === 'interact' && action.cureCondition && success) {
          const target =
            action.targetId === null ? member : members.find((ally) => ally.id === action.targetId);
          if (target && !isDead(target.state) && target.state.conditions.includes(action.cureCondition)) {
            if (action.mainItemId) {
              const item = member.state.inventory.find((item) => item.id === action.mainItemId);
              if (item?.kind !== 'consumable')
                throw new RuleError(
                  'Treatment requires an owned consumable or an available environmental remedy.',
                );
              removeItem(member.state, item.id);
            }
            removeCondition(target.state, action.cureCondition);
            record(`${member.character.name} removes ${action.cureCondition} from ${target.character.name}.`);
          }
        }
        if (die === 1) {
          const hp = member.state.hp;
          damage(member.state, 4, `Catastrophic failed ${kind}: ${intent}`, true);
          failed(
            `${member.character.name}'s risky ${kind} backfires for ${hp - member.state.hp} damage${member.state.hp === 0 ? ` and ${isDowned(member.state) ? 'downs them' : 'causes their death'}` : ''}.`,
          );
        }
      } else if (action.main === 'ability') {
        const ability = availableAbility(member.character, member.state, action.abilityName!);
        if (ability.effect === 'strike') {
          const target = attackTarget(member, action, false, ability);
          if (target) {
            spendAbility(member.state, ability);
            recordLog(`${member.character.name} uses ${ability.name}; its encounter use is spent.`);
            attack(member, target, false, null, ability);
          }
        } else {
          const target =
            action.targetId === null
              ? member
              : members.find(
                  (ally) =>
                    ally.id === action.targetId &&
                    (ally.state.hp > 0 ||
                      (['mend', 'cleanse'].includes(ability.effect) && isDowned(ally.state))) &&
                    fled.has(member.id) === fled.has(ally.id),
                );
          if (!target)
            blocked(
              `${member.character.name}'s ${ability.name} has no effect: the living ally target is unavailable. The main action is spent and the use is preserved.`,
            );
          else if (
            ability.effect === 'mend' &&
            target.state.hp >= target.state.maxHp &&
            !matchingCures(ability, target.state).length
          )
            blocked(
              `${member.character.name}'s ${ability.name} has no effect: ${target.character.name} is already at full health. The main action is spent and the use is preserved.`,
            );
          else if (ability.effect === 'cleanse' && !matchingCures(ability, target.state).length)
            blocked(
              `${member.character.name}'s ${ability.name} has no effect: ${target.character.name} has no matching ailment. The main action is spent and the use is preserved.`,
            );
          else {
            const strength = abilityBonus(ability);
            const cured = matchingCures(ability, target.state);
            if (ability.effect === 'mend' || ability.effect === 'cleanse') {
              const restored = mendWithAbility(
                member.character,
                member.state,
                ability.name,
                target,
                (sides, label, _actor, stat) => roll(sides, label, member.id, stat),
              );
              record(
                ability.effect === 'cleanse'
                  ? `${member.character.name} uses ${ability.name} on ${target.character.name}.`
                  : `${member.character.name} uses ${ability.name}: ${target.character.name} recovers ${restored} HP.`,
              );
            } else if (ability.effect === 'guard') {
              target.state.abilityGuard = Math.max(target.state.abilityGuard ?? 0, 3 + strength);
              record(
                `${member.character.name} uses ${ability.name}: ${target.character.name} gains +${target.state.abilityGuard} defense against the next enemy attack.`,
              );
            } else {
              target.state.abilityAssist = Math.max(target.state.abilityAssist ?? 0, strength);
              record(
                `${member.character.name} uses ${ability.name}: ${target.character.name} gains advantage${strength ? ` and +${strength}` : ''} on their next attack.`,
              );
            }
            if (!['mend', 'cleanse'].includes(ability.effect)) {
              cureWithAbility(ability, target.state);
              spendAbility(member.state, ability);
            }
            if (cured.length)
              record(`${ability.name} removes ${cured.join(' and ')} from ${target.character.name}.`);
          }
        }
      } else if (action.main === 'attack') {
        const target = attackTarget(member, action);
        if (target) attack(member, target, false, action.weaponSlot);
      } else {
        const target = encounter.enemies.find((e) => e.id === action.targetId && e.hp > 0 && !e.withdrawn);
        const proposed = action.environment;
        const source = proposed ? environment.sources[proposed.sourceId] : undefined;
        const profile = source?.profile ?? proposed;
        if (!target) {
          blocked(`${member.character.name}'s target is no longer available; the main action is spent.`);
        } else if (profile && source && !source.ready) {
          blocked(
            profile.consumption === 'reload'
              ? `${profile.name} needs reloading; no shot or damage occurs. The main action is spent.`
              : `${profile.name} is already used up; no damage occurs. The main action is spent.`,
          );
        } else {
          if (profile) {
            environment.sources[profile.sourceId] ??= { profile, ready: true };
            if (profile.consumption !== 'none') {
              environment.sources[profile.sourceId].ready = false;
              if (!environment.spentResources.includes(profile.sourceId))
                environment.spentResources.push(profile.sourceId);
              record(
                profile.consumption === 'reload'
                  ? `${member.character.name} uses ${profile.name}; its loaded shot is spent and it needs reloading.`
                  : `${member.character.name} uses ${profile.name}; this environmental opportunity is now used up.`,
              );
            }
          }
          const assist = action.effect === 'influence' ? undefined : member.state.abilityAssist;
          const mod =
            modifier(member.state.stats[action.stat]) +
            (action.effect === 'influence' ? 0 : equipmentBonus(member.state, action.stat, 'attackBonus')) +
            (assist ?? 0) -
            ailmentCheckPenalty(member.state, action.stat) -
            (action.effect !== 'influence' && member.state.conditions.includes('Weakened') ? 2 : 0) +
            (utility ? abilityBonus(utility) : 0);
          const dc =
            profile?.roll === 'defense'
              ? target.defense - (target.conditions!.includes('Chilled') ? 2 : 0)
              : Math.max(action.effect === 'influence' ? 15 : 5, action.dc ?? 10);
          let die = roll(
            20,
            profile
              ? `${member.character.name}: ${profile.name} against ${target.name}`
              : action.description || 'Creative combat action',
            member.id,
            action.stat,
            mod,
            dc,
          );
          if (utility || assist !== undefined) {
            die = Math.max(die, roll(20, 'Assisted creative attack', member.id, action.stat, mod, dc));
            if (assist !== undefined) delete member.state.abilityAssist;
          }
          if (utility) {
            spendAbility(member.state, utility);
            recordLog(`${member.character.name} uses ${utility.name}; its encounter use is spent.`);
          }
          if (die === 1) {
            const suffered = shockedDamage(member.state.conditions, 4);
            damage(member.state, 4, 'A catastrophic improvised action.', true);
            failed(
              `${member.character.name}'s improvised action backfires for ${suffered} damage${member.state.hp === 0 ? ` and ${isDowned(member.state) ? 'downs them' : 'causes their death'}` : ''}.`,
            );
          } else if (die === 20 || die + mod >= dc) {
            if (action.effect === 'influence') {
              target.withdrawn = true;
              record(`${member.character.name}'s approach persuades ${target.name} to stop fighting.`);
            } else if (action.effect === 'stun') {
              target.stunned = true;
              record(`${member.character.name}'s maneuver prevents ${target.name}'s next attack.`);
            } else {
              const improvised = {
                ...baseItem(
                  'improvised',
                  profile?.name ?? (action.description || 'Improvised action'),
                  'weapon',
                ),
                damage: profile?.damage ?? '1d6',
                scaling: [action.stat],
              };
              const dealt = weaponDamage(
                improvised,
                roll,
                member.id,
                profile ? profile.damageBonus : modifier(member.state.stats[action.stat]),
                die === 20,
              );
              const inflicted = shockedDamage(target.conditions!, dealt);
              target.hp = Math.max(0, target.hp - inflicted);
              const fact = profile
                ? `${member.character.name} uses ${profile.name}: ${target.name} takes ${inflicted} damage${target.hp === 0 ? `, killing ${target.name}` : ''}.`
                : `${member.character.name}'s creative action deals ${inflicted} damage to ${target.name}${target.hp === 0 ? `, killing ${target.name}` : ''}.`;
              if (profile) emit('success', fact);
              else record(fact);
            }
          } else
            failed(
              profile
                ? `${member.character.name} misses ${target.name} with ${profile.name}; no damage is dealt.`
                : `${member.character.name}'s creative action fails.`,
            );
        }
      }
      phase = 'minor';
      if (member.state.hp > 0 && (!fled.has(member.id) || wasEscaped)) {
        if (['Frozen', 'Electrocuted'].includes(incapacitated ?? '')) {
          if (action.minor !== 'none')
            blocked(`${member.character.name} cannot take their minor action while ${incapacitated}.`);
        } else if (action.minor === 'heal') {
          minorAction(member, () => {
            if (!action.minorItemId) throw new RuleError('Choose a healing consumable.');
            if (action.minorTargetId && action.minorTargetId !== member.id)
              throw new RuleError('Healing a party member uses your main action.');
            const target = action.minorTargetId
              ? members.find((ally) => ally.id === action.minorTargetId)
              : member;
            if (!target) throw new RuleError('The healing target is unavailable.');
            if (target.state.hp >= target.state.maxHp)
              throw new RuleError('The target is already at full health; the consumable is preserved.');
            const wasDowned = isDowned(target.state);
            healWithItem(member.character, member.state, action.minorItemId, target);
            emit(
              'success',
              target.id === member.id
                ? `${member.character.name} uses a healing consumable.`
                : `${member.character.name} uses a healing consumable on ${target.character.name}${wasDowned ? ', helping them up' : ''}.`,
            );
          });
        }
        if (
          action.minor === 'offhand' &&
          !['Frozen', 'Electrocuted', 'Chilled'].some((condition) =>
            member.state.conditions.includes(condition),
          )
        ) {
          const target = attackTarget(member, action, true);
          if (target) attack(member, target, true, action.weaponSlot);
        }
        if (action.minor === 'offhand' && member.state.conditions.includes('Chilled'))
          blocked(`${member.character.name} is Chilled and cannot make an off-hand attack.`);
      } else if (action.minor === 'heal' || action.minor === 'offhand') {
        blocked(
          `${member.character.name} cannot take their ${action.minor === 'heal' ? 'healing' : 'off-hand attack'} minor action after ${member.state.hp <= 0 ? (isDowned(member.state) ? 'being downed' : 'dying') : 'escaping the fight'}.`,
        );
      }
    } else {
      actorId = null;
      const enemy = encounter.enemies.find((e) => e.id === initiative.id);
      if (!enemy || enemy.hp <= 0 || enemy.withdrawn) continue;
      if (enemy.stunned || incapacitatingCondition(enemy as ConditionState)) {
        enemy.stunned = false;
        record(`${enemy.name} is unable to attack this round.`);
        continue;
      }
      const candidates = members.filter((m) => m.state.hp > 0 && !fled.has(m.id));
      if (!candidates.length) continue;
      const selected = input.enemyTargets.find((t) => t.enemyId === enemy.id)?.memberId;
      const target = candidates.find((m) => m.id === selected) ?? candidates[0];
      const targetDefense = defense(target.character, target.state);
      const enemyAttack = enemy.attack - (enemy.conditions!.includes('Weakened') ? 2 : 0);
      const die = roll(
        20,
        `${enemy.name} attacks ${target.character.name}`,
        enemy.id,
        'STR',
        enemyAttack,
        targetDefense,
      );
      delete target.state.abilityGuard;
      if (die === 1) {
        const harm = shockedDamage(enemy.conditions!, 2);
        enemy.hp = Math.max(0, enemy.hp - harm);
        record(
          `${enemy.name} catastrophically fails and suffers ${harm} damage${enemy.hp === 0 ? ' and dies' : ''}.`,
        );
      } else if (die === 20 || die + enemyAttack >= targetDefense) {
        const weapon = {
          ...(enemy.equipment?.find((item) => item.kind === 'weapon') ??
            baseItem(enemy.id, enemy.name, 'weapon')),
          damage: enemy.damage,
        };
        const baseDamage = weaponDamage(weapon, roll, enemy.id, enemy.attack, die === 20);
        let remainingDamage = baseDamage;
        const blocks: string[] = [];
        if (!incapacitatingCondition(target.state))
          for (const shield of equippedItems(target.state).filter((item) => item.kind === 'shield')) {
            const sides = shieldBlockSides(shield.rarity);
            const block = roll(sides, `${shield.name}: shield block`, target.id, 'CON');
            remainingDamage = Math.max(0, remainingDamage - block);
            blocks.push(`${shield.name}: 1d${sides} block = ${block}`);
          }
        const dealt = shockedDamage(target.state.conditions, remainingDamage);
        damage(target.state, remainingDamage, `Killed by ${enemy.name}.`);
        record(
          `${enemy.name} ${die === 20 ? 'critically hits' : 'hits'} ${target.character.name} for ${dealt}${blocks.length ? ` (${baseDamage} incoming damage; ${blocks.join('; ')})` : ''}${target.state.hp === 0 ? `, ${isDowned(target.state) ? 'downing' : 'killing'} ${target.character.name}` : ''}.`,
        );
        if (target.state.hp > 0 && enemy.onHit && !hasImmunity(target.character, target.state, enemy.onHit)) {
          if (!target.state.conditions.includes(enemy.onHit)) {
            record(`${target.character.name} becomes ${enemy.onHit} from ${enemy.name}'s attack.`);
          }
          applyCondition(target.state, enemy.onHit, target.character);
        }
        equipmentAilments(enemy.equipment ?? [], weapon, target, false, die === 20);
      } else record(`${enemy.name} misses ${target.character.name}.`);
    }
  }
  actorId = null;
  phase = 'aftermath';
  for (const member of members) {
    record(...tickConditions(member, moving.has(member.id)));
    if (fled.has(member.id)) {
      if (!member.state.conditions.includes('Escaped')) member.state.conditions.push('Escaped');
      member.state.conditionTurns.Escaped = 999;
    }
  }
  for (const enemy of encounter.enemies) {
    for (const condition of [...enemy.conditions!]) {
      const amount = isAilment(condition) ? ailmentRules[condition].damage : 0;
      if (amount && enemy.hp > 0 && !enemy.withdrawn) {
        const hp = enemy.hp;
        enemy.hp = Math.max(0, hp - shockedDamage(enemy.conditions!, amount));
        record(
          `${enemy.name} takes ${hp - enemy.hp} ${condition} damage${enemy.hp === 0 ? ' and dies' : ''}.`,
        );
      }
    }
    for (const condition of [...enemy.conditions!]) {
      enemy.conditionTurns![condition] =
        (enemy.conditionTurns![condition] ?? conditionDuration(condition)) - 1;
      if (enemy.conditionTurns![condition] <= 0) removeCondition(enemy as ConditionState, condition);
    }
  }
  encounter.round++;
  encounter.victory = encounter.enemies.every((e) => e.hp === 0 || e.withdrawn);
  encounter.escaped =
    !encounter.victory &&
    members.some((m) => m.state.hp > 0 && m.state.conditions.includes('Escaped')) &&
    members.every((m) => m.state.hp <= 0 || m.state.conditions.includes('Escaped'));
  if (encounter.escaped) {
    for (const member of members.filter((member) => isDowned(member.state) && !fled.has(member.id))) {
      removeCondition(member.state, 'Downed');
      member.state.deathReason = 'Left behind with no conscious ally remaining in combat.';
      record(`${member.character.name} dies permanently: ${member.state.deathReason}`);
    }
    record('The surviving party escapes. Combat ends.');
  }
  if (encounter.victory) {
    const downed = members.filter((member) => isDowned(member.state));
    recordLog(...recoverAfterEncounter(members));
    for (const member of downed)
      if (member.state.hp > 0) record(`${member.character.name} regains consciousness after the fight.`);
    const xp = encounter.enemies.reduce(
      (sum, enemy) => sum + { minor: 15, normal: 30, elite: 50, boss: 100 }[enemy.tier],
      0,
    );
    for (const member of members)
      if (member.state.hp > 0) {
        grantXp(member.character, member.state, xp);
        member.state.kills += encounter.enemies.filter((e) => e.hp === 0).length;
        member.state.bosses += encounter.enemies.filter((e) => e.tier === 'boss').length;
      }
    record(
      `Victory. Each surviving character gains ${xp} XP. Each defeated enemy drops its saved loot as scene loot.`,
    );
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
