import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { itemSchema, templateCharacter, type Item } from '../shared/schema';
import {
  addItem,
  baseItem,
  defense,
  effectiveStats,
  equip,
  grantEquipmentPowers,
  healWithItem,
  initialState,
  rollArmourAttribute,
  rollStartingEquipment,
  scaling,
  unequip,
} from '../shared/rules';
import { openDatabase } from '../server/db';
import { Game } from '../server/game';
import { PracticeGM } from '../server/providers';

it.each([
  ['Common', 1],
  ['Uncommon', 1],
  ['Rare', 2],
  ['Cursed', 2],
  ['Legendary', 3],
] as const)('%s armour rolls one saved attribute bonus of +%i', (rarity, amount) => {
  for (const kind of ['armour', 'helmet', 'boots', 'shield'] as const) {
    const item = rollArmourAttribute({ ...baseItem('gear', 'Protective gear', kind), rarity }, () => 6);
    expect(item.attributeBonus).toEqual({ stat: 'WIS', amount });
    expect(itemSchema.safeParse(item).success).toBe(true);
    expect(
      rollArmourAttribute(item, () => {
        throw new Error('A saved bonus must not reroll');
      }),
    ).toEqual(item);
    expect(
      itemSchema.safeParse({ ...item, attributeBonus: { stat: 'STR', amount: amount === 1 ? 2 : 1 } })
        .success,
    ).toBe(false);
  }
  expect(rollArmourAttribute(baseItem('weapon', 'Knife', 'weapon'), () => 1).attributeBonus).toBeUndefined();
});

it('applies bonuses only while equipped, deduplicates two-handed shields, and never heals through gear swaps', () => {
  const character = templateCharacter();
  character.traits[0].stats.CON = 1;
  const state = initialState(character, 'test');
  const shield: Item = {
    ...baseItem('shield', 'Tower shield', 'shield'),
    hands: 2,
    defense: 1,
    attributeBonus: { stat: 'CON', amount: 1 },
  };
  addItem(character, state, shield);
  expect(effectiveStats(state).CON).toBe(6);
  equip(character, state, shield.id, 'right');
  expect(effectiveStats(state).CON).toBe(7);
  expect(state.stats.CON).toBe(6);
  expect(state.maxHp).toBe(22);
  expect(state.hp).toBe(20);
  expect(defense(character, state)).toBe(11);
  healWithItem(character, state, state.inventory.find((item) => item.healing > 0)!.id);
  expect(state.hp).toBe(22);
  unequip(character, state, 'left');
  expect(state.hp).toBe(20);
  expect(state.maxHp).toBe(20);
  expect(effectiveStats(state).CON).toBe(6);
  equip(character, state, shield.id, 'right');
  expect(state.hp).toBe(20);
  expect(state.maxHp).toBe(22);
  const helmet = {
    ...baseItem('helm', 'Iron cap', 'helmet'),
    rarity: 'Rare' as const,
    attributeBonus: { stat: 'STR' as const, amount: 2 },
  };
  addItem(character, state, helmet);
  equip(character, state, helmet.id, 'head');
  expect(scaling(state, { ...baseItem('axe', 'Axe', 'weapon'), scaling: ['STR'] })).toBe(1);
  expect(grantEquipmentPowers(helmet, () => 1).attributeBonus).toEqual(helmet.attributeBonus);
});

it('generates distinct weapons and a varied, usable non-weapon selection', () => {
  const items = rollStartingEquipment(templateCharacter(), () => 1);
  const weapons = items.filter((item) => item.kind === 'weapon');
  expect(weapons.map((item) => item.scaling[0])).toEqual(['STR', 'DEX']);
  expect(new Set(items.filter((item) => item.kind !== 'weapon').map((item) => item.kind)).size).toBe(5);
  expect(items.some((item) => item.kind === 'focus')).toBe(true);
  expect(items.some((item) => item.kind === 'relic')).toBe(true);
  expect(
    items
      .filter((item) => ['armour', 'helmet', 'boots', 'shield'].includes(item.kind))
      .every((item) => item.attributeBonus?.amount === 1),
  ).toBe(true);
});

it('backfills armour bonuses once and preserves base attributes, wounds, item IDs and completed history', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gather-armour-'));
  const filename = join(directory, 'test.sqlite');
  let db = openDatabase(filename);
  try {
    const game = new Game(db, () => new PracticeGM());
    const player = game.identify();
    const character = templateCharacter();
    character.traits[0].stats.CON = 1;
    const saved = game.saveCharacter(player.id, character);
    const campaign = game.create(player.id, {
      name: 'Test',
      setting: 'Forest',
      premise: '',
      tone: '',
      language: 'English',
      instructions: '',
      custom: [],
      provider: 'practice',
    });
    game.join(campaign.inviteCode!, player.id, saved.id);
    const member = game.members(campaign.id)[0];
    const coat = { ...baseItem('old-coat', 'Padded coat', 'armour'), defense: 1 };
    addItem(character, member.state, coat);
    equip(character, member.state, coat.id, 'body');
    member.state.hp = 17;
    db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(member.state), member.id);
    const history = JSON.stringify({ members: [member] });
    db.prepare(
      'INSERT INTO turns(id, campaign_id, number, phase, roster, draft, result) VALUES(?, ?, 0, ?, ?, ?, ?)',
    ).run('history', campaign.id, 'complete', '[]', history, history);
    db.pragma('user_version = 25');
    db.close();
    db = openDatabase(filename, () => 5);
    const after = new Game(db, () => new PracticeGM()).members(campaign.id)[0];
    expect(after.state.equipment.body).toMatchObject({ ...coat, attributeBonus: { stat: 'CON', amount: 1 } });
    expect(after.state.stats).toEqual(member.state.stats);
    expect(after.state.hp).toBe(17);
    expect(after.state.maxHp).toBe(22);
    expect(db.prepare('SELECT draft, result FROM turns WHERE id = ?').get('history')).toEqual({
      draft: history,
      result: history,
    });
    db.close();
    db = openDatabase(filename, () => {
      throw new Error('Bonuses must survive restart without rerolling');
    });
    expect(new Game(db, () => new PracticeGM()).members(campaign.id)[0].state).toEqual(after.state);
  } finally {
    if (db.open) db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
