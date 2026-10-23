import { expect, it } from 'vitest';
import { templateCharacter, characterSchema } from '../shared/schema';
import {
  characterHandicaps,
  characterDrawbacks,
  abilityPowerSummary,
  abilityBonus,
  initialState,
  modifier,
  chooseStartingAbilities,
  normalizeCharacter,
  rollCharacterCreation,
  startingStats,
  validateAbilityTheme,
  strikeAilments,
} from '../shared/rules';
import { openDatabase } from '../server/db';
import { Game, validateLevelUpReward, type LevelUpContext } from '../server/game';
import { PracticeGM } from '../server/providers';

function offers() {
  const sheet = templateCharacter();
  sheet.abilities.push(
    { ...sheet.abilities[0], name: 'Other combat' },
    { ...sheet.abilities[1], name: 'Other utility', description: 'Find safe paths through wilderness.' },
  );
  return sheet;
}

it.each([
  ['Explosive crossbow shot', 'Burning', 'Weakened'],
  ['Ontploffende kruisboogpijl', 'Bleeding', 'Weakened'],
  ['Fire bolt', 'Burning', 'Frozen'],
  ['Frost lance', 'Frozen', 'Burning'],
  ['Chilling arrow', 'Chilled', 'Burning'],
  ['Lightning arc', 'Electrocuted', 'Poisoned'],
  ['Venom arrow', 'Poisoned', 'Weakened'],
  ['Crippling crossbow shot', 'Weakened', 'Burning'],
] as const)('keeps %s ailments consistent with the delivery', (name, fitting, wrong) => {
  const ability = { ...templateCharacter().abilities[0], name, description: 'A precise attack.' };
  expect(() => validateAbilityTheme({ ...ability, inflicts: fitting })).not.toThrow();
  expect(() => validateAbilityTheme({ ...ability, inflicts: wrong })).toThrow('damage theme');
});

it('rolls an explosive character’s starting strike ailment from a fitting pool and rejects expanded starting offers', () => {
  expect(strikeAilments('A gifted crossbow engineer')).toEqual(['Bleeding']);
  const sheet = offers();
  sheet.concept = 'An explosive crossbow specialist';
  const created = rollCharacterCreation(sheet, 'strike', 0, () => 1);
  expect(created.abilityOptions![0].inflicts).toBe('Burning');
  sheet.abilities[0].targeting = 'area';
  expect(() => rollCharacterCreation(sheet, 'strike', 0, () => 1)).toThrow();
  expect(() => normalizeCharacter(sheet)).toThrow('character level 2');
});

it.each([
  ['strike', 'multiple', 'combat'],
  ['strike', 'area', 'combat'],
  ['mend', 'party', 'combat'],
  ['restoration', 'party', 'utility'],
] as const)(
  'unlocks new %s/%s at character level 2 with matching ability power',
  (effect, targeting, kind) => {
    const character = templateCharacter();
    const context: LevelUpContext = {
      character,
      state: initialState(character, 'test'),
      config: {
        ruleset: 'roguelike-v1',
        name: 'Test',
        setting: 'Forest',
        premise: '',
        tone: '',
        language: 'English',
        instructions: '',
        custom: [],
        provider: 'practice',
        model: '',
      },
      choice: kind === 'combat' ? 'new-combat' : 'new-utility',
      target: null,
      attributes: [],
    };
    const ability = { ...character.abilities[0], name: 'New ability', effect, targeting, kind };
    const reward = { ability, description: 'A new technique.' };
    expect(() => validateLevelUpReward(context, reward)).toThrow('character level 2');
    context.state.level = 2;
    ability.level = 2;
    expect(validateLevelUpReward(context, reward).ability).toMatchObject({ level: 2, targeting });
    context.target = ability;
    context.choice = kind === 'combat' ? 'upgrade-combat' : 'upgrade-utility';
    expect(
      validateLevelUpReward(context, { ...reward, ability: { ...ability, level: 3 } }).ability,
    ).toMatchObject({ level: 3, targeting });
    expect(() =>
      validateLevelUpReward(context, { ...reward, ability: { ...ability, level: 3, targeting: 'single' } }),
    ).toThrow('preserve');
  },
);

it.each([
  ['strike', 'combat', 1, '2–12 damage', 0],
  ['strike', 'combat', 2, '4–14 damage', 2],
  ['strike', 'combat', 5, '10–20 damage', 8],
  ['strike', 'combat', 10, '20–30 damage', 18],
  ['mend', 'utility', 5, '11–16 HP', 10],
  ['restoration', 'combat', 5, '9–14 HP', 8],
  ['barrier', 'combat', 5, '12–17 damage blocked', 11],
  ['guard', 'combat', 5, null, 4],
  ['rally', 'combat', 5, null, 6],
  ['assist', 'utility', 5, null, 8],
] as const)(
  'new %s/%s at character level %i has matching power and engine results',
  (effect, kind, level, range, bonus) => {
    const character = templateCharacter();
    const state = initialState(character, 'power-check');
    state.level = level;
    const context: LevelUpContext = {
      character,
      state,
      config: {
        ruleset: 'roguelike-v1',
        name: 'Test',
        setting: 'Forest',
        premise: '',
        tone: '',
        language: 'English',
        instructions: '',
        custom: [],
        provider: 'practice',
        model: '',
      },
      choice: kind === 'combat' ? 'new-combat' : 'new-utility',
      target: null,
      attributes: [],
    };
    const reward = {
      ability: { ...character.abilities[0], name: 'New technique', effect, kind, level },
      description: 'A new technique.',
    };
    const ability = validateLevelUpReward(context, reward).ability!;
    expect(ability.level).toBe(level);
    expect(abilityPowerSummary(ability, state.stats)).toBe(range);
    expect(abilityBonus(ability)).toBe(bonus);
    for (const wrong of [1, level + 1])
      if (wrong !== level)
        expect(() =>
          validateLevelUpReward(context, { ...reward, ability: { ...ability, level: wrong } }),
        ).toThrow(`power level ${level}`);
  },
);

it('weights the preferred combat effect five times as heavily and always offers two different effects', () => {
  const outcomes = Array.from({ length: 11 }, (_, i) => {
    let first = true;
    const character = rollCharacterCreation(offers(), 'mend', 0, () => {
      if (first) {
        first = false;
        return i + 1;
      }
      return 1;
    });
    const combat = character.abilityOptions!.filter((a) => a.kind === 'combat');
    expect(combat[0].effect).not.toBe(combat[1].effect);
    expect(character.abilities).toEqual([]);
    expect(character.creationBonuses).toEqual({ attributes: [], abilityPower: 0, version: 2 });
    return combat[0].effect;
  });
  expect(outcomes.filter((effect) => effect === 'mend')).toHaveLength(5);
  for (const effect of ['strike', 'guard', 'rally', 'cleanse', 'restoration', 'barrier'])
    expect(outcomes.filter((candidate) => candidate === effect)).toHaveLength(1);
});

it('rolls bounded dice variants for strikes and mends', () => {
  for (const variant of [1, 2, 3]) {
    const character = rollCharacterCreation(offers(), 'strike', 0, (sides) => (sides === 3 ? variant : 1));
    expect(character.abilityOptions![0].dice).toBe(['2d4', '2d6', '1d12'][variant - 1]);
    expect(abilityPowerSummary(character.abilityOptions![0], character.stats)).toBe(
      ['4–10 damage', '2–12 damage', '1–12 damage'][variant - 1],
    );
  }
  for (const variant of [1, 2, 3]) {
    const character = rollCharacterCreation(offers(), 'mend', 0, (sides) => (sides === 3 ? variant : 2));
    expect(character.abilityOptions![0].dice).toBe(['1d4', '1d6', '1d8'][variant - 1]);
    expect(abilityPowerSummary(character.abilityOptions![0], character.stats)).toBe(
      ['5–8 HP', '4–9 HP', '3–10 HP'][variant - 1],
    );
  }
});

it('rolls utility Mend healing power and a cure while keeping utility assist scoped to checks', () => {
  const draft = offers();
  draft.abilities[1].effect = 'mend';
  const created = rollCharacterCreation(draft, 'strike', 0, () => 1);
  const utilities = created.abilityOptions!.filter((ability) => ability.kind === 'utility');
  expect(utilities[0]).toMatchObject({ effect: 'mend', dice: '1d4', bonus: 2, cures: ['Bleeding'] });
  expect(abilityPowerSummary(utilities[0], created.stats)).toBe('5–8 HP');
  expect(utilities[1]).toMatchObject({ effect: 'assist' });
  expect(utilities[1].cures).toBeUndefined();
  expect(characterSchema.safeParse(created).success).toBe(true);
});

it('compensates each drawback with attributes or power that applies to either combat choice', () => {
  const sheet = offers();
  sheet.traits[0].blocked = ['head', 'boots'];
  const attributes = rollCharacterCreation(sheet, 'strike', 2, () => 1);
  expect(attributes.creationBonuses).toEqual({
    attributes: ['STR', 'STR', 'STR', 'STR'],
    abilityPower: 0,
    version: 2,
  });
  expect(startingStats(attributes).STR).toBe(9);
  expect(modifier(attributes.stats.STR)).toBe(2);
  expect(initialState(attributes, 'fresh').stats.STR).toBe(9);
  const power = rollCharacterCreation(sheet, 'strike', 2, (sides) => sides);
  expect(power.creationBonuses).toEqual({ attributes: [], abilityPower: 2, version: 2 });
  expect(power.abilityOptions!.filter((a) => a.kind === 'combat').map((a) => a.bonus)).toEqual([2, 2]);
  expect(characterSchema.parse(power).abilityOptions).toEqual(power.abilityOptions);
  expect(() =>
    normalizeCharacter({ ...power, creationBonuses: { attributes: [], abilityPower: 0 } }),
  ).toThrow('compensated');
});

it('counts every mechanical restriction and rejects too many or a different rolled count', () => {
  const sheet = offers();
  sheet.traits[0].blocked = ['head', 'head'];
  sheet.traits[1].blocked = ['head'];
  expect(characterHandicaps(sheet)).toEqual(['slot:head']);
  sheet.traits[0].stats.INT = -2;
  sheet.traits[0].hp = -1;
  sheet.traits[0].heavyRestricted = true;
  expect(characterHandicaps(sheet)).toHaveLength(4);
  expect(() => rollCharacterCreation(sheet, 'strike', 2, () => 1)).toThrow('exactly 2');
  expect(() => rollCharacterCreation(sheet, 'strike', 5, () => 1)).toThrow();
  expect(() => rollCharacterCreation(offers(), 'strike', 1, () => 1)).toThrow('exactly 1');
});

it('keeps compensation inside the starting stat cap and falls back to combat power when attributes are full', () => {
  const sheet = offers();
  for (const stat of Object.keys(sheet.traits[0].stats) as (keyof typeof sheet.stats)[])
    sheet.traits[0].stats[stat] = 8;
  sheet.traits[0].blocked = ['head'];
  const character = rollCharacterCreation(sheet, 'strike', 1, () => 1);
  expect(character.stats).toEqual({ STR: 13, DEX: 13, INT: 13, CHA: 13, CON: 13, WIS: 13 });
  expect(character.creationBonuses).toEqual({ attributes: [], abilityPower: 1, version: 2 });
});

it('gives major restrictions twice the compensation of minor restrictions, still allowing at most two', () => {
  for (const [slot, expected] of [
    ['head', 1],
    ['body', 2],
    ['left', 2],
  ] as const) {
    const sheet = offers();
    sheet.traits[0].blocked = [slot];
    const character = rollCharacterCreation(sheet, 'strike', 1, (sides) => sides);
    expect(characterDrawbacks(character)[0].severity).toBe(expected);
    expect(character.creationBonuses!.abilityPower).toBe(expected);
    expect(normalizeCharacter(character).creationBonuses).toEqual(character.creationBonuses);
  }
  const sheet = offers();
  sheet.traits[0].blocked = ['body', 'left'];
  const character = rollCharacterCreation(sheet, 'strike', 2, (sides) => sides);
  expect(character.creationBonuses!.abilityPower).toBe(4);
  expect(characterSchema.parse(character).creationBonuses!.abilityPower).toBe(4);
});

it('crosses a modifier threshold with one or two attribute points without erasing a weakness', () => {
  for (const [initial, points] of [
    [5, 2],
    [6, 1],
  ] as const) {
    const sheet = offers();
    sheet.traits[0].stats.STR = initial - 5;
    sheet.traits[0].blocked = ['head'];
    const character = rollCharacterCreation(sheet, 'strike', 1, () => 1);
    expect(character.creationBonuses!.attributes).toEqual(Array(points).fill('STR'));
    expect(modifier(character.stats.STR) - modifier(initial)).toBe(1);
    expect(normalizeCharacter(character).stats).toEqual(character.stats);
    if (initial === 5)
      expect(() =>
        normalizeCharacter({
          ...character,
          creationBonuses: { attributes: ['STR'], abilityPower: 0, version: 2 },
        }),
      ).toThrow('compensated');
  }
  const sheet = offers();
  sheet.traits[0].stats.STR = -2;
  const character = rollCharacterCreation(sheet, 'strike', 1, () => 1);
  expect(character.stats.STR).toBe(3);
  expect(character.creationBonuses!.attributes).toEqual(['DEX', 'DEX']);
});

it('shows exact power ranges, including negative modifiers and the minimum one-point effect', () => {
  const sheet = templateCharacter();
  const ability = { ...sheet.abilities[0], dice: '1d12' as const };
  expect(abilityPowerSummary(ability, sheet.stats)).toBe('1–12 damage');
  expect(abilityPowerSummary({ ...ability, dice: '2d4', bonus: 2 }, sheet.stats)).toBe('4–10 damage');
  expect(abilityPowerSummary({ ...ability, effect: 'mend', dice: '1d4' }, { ...sheet.stats, STR: 0 })).toBe(
    '1–3 HP',
  );
  expect(abilityPowerSummary(sheet.abilities[1], sheet.stats)).toBeNull();
});

it('selects plausible scaling after rolling effects instead of inheriting the offensive stat for Mend', () => {
  const sheet = offers();
  sheet.traits[0].stats.STR = 6;
  sheet.traits[0].stats.CON = 4;
  const character = rollCharacterCreation(sheet, 'mend', 0, () => 2);
  expect(character.abilityOptions![0]).toMatchObject({ effect: 'mend', stat: 'CON' });
});

it('keeps earlier saved compensation and power intact', () => {
  const sheet = offers();
  sheet.traits[0].blocked = ['body'];
  const character = rollCharacterCreation(sheet, 'strike', 1, () => 1);
  character.creationBonuses = { attributes: ['STR'], abilityPower: 0 };
  character.abilityOptions![0].dice = '2d8';
  const saved = normalizeCharacter(characterSchema.parse(character));
  expect(saved.stats.STR).toBe(6);
  expect(saved.abilityOptions![0].dice).toBe('2d8');
});

it('requires one offered ability of each kind and persists only the choices as usable abilities', () => {
  const sheet = rollCharacterCreation(offers(), 'strike', 0, () => 1);
  const db = openDatabase(':memory:');
  try {
    const game = new Game(db, () => new PracticeGM());
    const player = game.identify();
    expect(() => game.saveCharacter(player.id, sheet)).toThrow('before saving');
    expect(() => chooseStartingAbilities(sheet, ['Focused strike', 'Other combat'])).toThrow('one offered');
    expect(() => chooseStartingAbilities(sheet, ['Invented', 'Other utility'])).toThrow('one offered');
    sheet.abilities = chooseStartingAbilities(sheet, ['Other combat', 'Other utility']);
    const saved = game.saveCharacter(player.id, sheet);
    const restored = new Game(db, () => new PracticeGM()).characters(player.id)[0];
    expect(restored.abilities).toEqual(sheet.abilities);
    expect(restored.abilityOptions).toEqual(sheet.abilityOptions);
    expect(() => game.updateCharacter(player.id, saved.id, { ...sheet, abilities: [] })).toThrow(
      'before saving',
    );
    // Posted mechanics cannot replace those of the actual offer.
    expect(
      normalizeCharacter({ ...sheet, abilities: sheet.abilities.map((a) => ({ ...a, bonus: 3 })) }).abilities,
    ).toEqual(sheet.abilities);
    const report = game.abilityChoiceStats();
    expect(report).toMatchObject({ characters: 1, offers: 4, selections: 2 });
    expect(
      report.rows.filter((row) => row.kind === 'combat').reduce((sum, row) => sum + row.selected, 0),
    ).toBe(1);
    game.updateCharacter(player.id, saved.id, sheet);
    expect(new Game(db, () => new PracticeGM()).abilityChoiceStats()).toEqual(report);
    sheet.abilities = chooseStartingAbilities(sheet, ['Focused strike', 'Other utility']);
    game.updateCharacter(player.id, saved.id, sheet);
    const changed = game.abilityChoiceStats();
    expect(changed).toMatchObject({ characters: 1, offers: 4, selections: 2 });
    expect(changed.rows.find((row) => row.effect === 'strike')!.selected).toBe(1);
    game.saveCharacter(player.id, templateCharacter('Legacy character'));
    expect(game.abilityChoiceStats()).toEqual(changed);
  } finally {
    db.close();
  }
});

it('rolls explicit inflict, healing-plus-cure and standalone cleanse mechanics without adding utility effects', () => {
  for (const preferred of ['strike', 'mend', 'cleanse'] as const) {
    let first = true;
    const created = rollCharacterCreation(offers(), preferred, 0, () => {
      if (first) {
        first = false;
        return preferred === 'strike' ? 1 : preferred === 'mend' ? 2 : 5;
      }
      return 1;
    });
    const ability = created.abilityOptions![0];
    expect(ability.effect).toBe(preferred);
    if (preferred === 'strike') expect(ability.inflicts).toBe('Bleeding');
    if (preferred === 'cleanse') expect(ability.cures).toHaveLength(1);
    expect(
      created
        .abilityOptions!.filter((offer) => offer.kind === 'utility')
        .every((offer) => !offer.inflicts && !offer.cures),
    ).toBe(true);
    expect(characterSchema.safeParse(created).success).toBe(true);
  }
  const mend = rollCharacterCreation(offers(), 'mend', 0, (sides) => (sides === 11 || sides === 9 ? 2 : 1))
    .abilityOptions![0];
  expect(mend).toMatchObject({ effect: 'mend', cures: ['Burning'] });
});
