import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db';
import { Game } from '../server/game';
import { PracticeGM } from '../server/providers';
import { requestedAbility } from '../server/action-resources';
import {
  combatSchema,
  enemySchema,
  itemSchema,
  templateCharacter,
  type Item,
  type Member,
} from '../shared/schema';
import {
  abilityUseKey,
  applyCondition,
  availableAbilities,
  availableAbility,
  baseItem,
  equip,
  initialState,
  randomLoot,
  recoverAfterEncounter,
  runCombat,
  spendAbility,
  tickConditions,
  unequip,
} from '../shared/rules';

function gear(kind: Item['kind'], rarity: Item['rarity'] = 'Legendary', id: string = kind) {
  return randomLoot(
    id,
    1,
    () => 1,
    { name: `Test ${kind}`, kind, scaling: ['INT'], hands: 1, light: true, description: 'Test gear.' },
    rarity,
  );
}
function fixture() {
  const character = templateCharacter('Hero');
  const member: Member = {
    id: randomUUID(),
    playerId: 'player',
    playerName: 'Player',
    characterId: 'sheet',
    character,
    state: initialState(character, 'hero'),
    active: true,
  };
  member.state.equipment.right = {
    ...baseItem('sword', 'Sword', 'weapon'),
    damage: '1d6',
    scaling: ['INT'],
    light: true,
  };
  const enemy = {
    ...enemySchema.parse({
      id: 'enemy',
      name: 'Enemy',
      tier: 'normal',
      hp: 200,
      defense: 10,
      attack: 0,
      damage: '1d4',
      description: '',
      tactic: '',
    }),
    maxHp: 200,
    initiative: 1,
    conditions: [] as string[],
    equipment: [] as Item[],
    conditionTurns: {},
  };
  const encounter = {
    enemies: [enemy],
    initiative: [{ id: member.id, total: 20 }],
    round: 1,
    victory: false,
    escaped: false,
  };
  const action = combatSchema.parse({
    actions: [
      {
        memberId: member.id,
        main: 'attack',
        targetId: enemy.id,
        stat: 'INT',
        description: 'Attack',
        minor: 'none',
        minorItemId: null,
      },
    ],
    enemyTargets: [],
    loot: { name: 'Loot', kind: 'weapon', scaling: ['STR'], hands: 1, light: true, description: '' },
  });
  return { member, encounter, enemy, action };
}

it('guarantees rarity powers on all equippable kinds and keeps consumables separate', () => {
  for (const kind of [
    'weapon',
    'shield',
    'focus',
    'boots',
    'helmet',
    'armour',
    'relic',
    'consumable',
  ] as const)
    for (const rarity of ['Common', 'Uncommon', 'Rare', 'Cursed', 'Legendary'] as const) {
      const item = gear(kind, rarity);
      expect(itemSchema.safeParse(item).success).toBe(true);
      const eligible = kind !== 'consumable' && ['Rare', 'Cursed', 'Legendary'].includes(rarity);
      expect(!!item.onHit || !!item.immunities?.length).toBe(eligible);
      expect(!!item.grantedAbility).toBe(eligible && rarity === 'Legendary');
      if (item.grantedAbility)
        expect(item.grantedAbility.kind).toBe(
          ['weapon', 'shield', 'focus'].includes(kind) ? 'combat' : 'utility',
        );
    }
  const item = gear('weapon');
  expect(itemSchema.safeParse({ ...item, rarity: 'Common' }).success).toBe(false);
  expect(itemSchema.safeParse({ ...item, onHit: { ailment: 'Burning', chance: 101 } }).success).toBe(false);
  expect(itemSchema.safeParse({ ...gear('boots'), grantedAbility: item.grantedAbility }).success).toBe(false);
});

it.each([
  [15, 25, true],
  [15, 26, false],
  [2, 1, false],
  [20, 100, true],
])('weapon hit %i with chance roll %i inflicts an ailment: %s', (attack, chance, applies) => {
  const f = fixture();
  f.member.state.equipment.right = gear('weapon', 'Rare');
  const dice = vi.fn((sides: number) => (sides === 20 ? attack : sides === 100 ? chance : 1));
  runCombat([f.member], f.encounter, f.action, dice);
  expect(f.enemy.conditions.includes('Burning')).toBe(applies);
  expect(dice.mock.calls.filter(([sides]) => sides === 100)).toHaveLength(attack === 15 ? 1 : 0);
});

it('only matching equipped focuses afflict main attacks; duplicate hand slots apply once', () => {
  for (const mode of [
    'equipped',
    'backpack',
    'mismatch',
    'duplicate',
    'ability',
    'offhand',
    'dead',
    'immune',
  ] as const) {
    const f = fixture();
    const focus = gear('focus', 'Rare');
    if (mode === 'backpack') f.member.state.inventory.push({ ...focus, quantity: 1 });
    else f.member.state.equipment.left = focus;
    if (mode === 'mismatch') focus.scaling = ['STR'];
    if (mode === 'duplicate') {
      f.member.state.equipment.right = focus;
      f.member.character.stats.INT = f.member.state.stats.INT = 9;
    }
    if (mode === 'ability') {
      f.member.character.abilities[0].stat = 'INT';
      f.action.actions[0].main = 'ability';
      f.action.actions[0].abilityName = f.member.character.abilities[0].name;
    }
    if (mode === 'offhand') {
      f.action.actions[0].main = 'defend';
      f.action.actions[0].minor = 'offhand';
    }
    if (mode === 'dead') f.enemy.hp = 1;
    if (mode === 'immune') f.enemy.equipment = [gear('boots', 'Rare')];
    const logs = runCombat([f.member], f.encounter, f.action, (sides) => (sides === 20 ? 15 : 1));
    const applies = ['equipped', 'duplicate', 'ability'].includes(mode);
    expect(f.enemy.conditions.includes('Burning')).toBe(applies);
    expect(logs.filter((log) => log.includes('from Test focus.'))).toHaveLength(applies ? 1 : 0);
  }
});

it('equipped immunity prevents application and ticking, and expires when stowed', () => {
  const f = fixture();
  const boots = gear('boots', 'Rare');
  f.member.state.stats.INT = 13;
  f.member.state.inventory.push({ ...boots, quantity: 1 });
  applyCondition(f.member.state, 'Burning', f.member.character);
  equip(f.member.character, f.member.state, boots.id, 'boots');
  expect(f.member.state.conditions).not.toContain('Burning');
  expect(applyCondition(f.member.state, 'Burning', f.member.character)).toBe(false);
  f.member.state.conditions.push('Burning');
  const hp = f.member.state.hp;
  expect(tickConditions(f.member)).toEqual([]);
  expect(f.member.state.hp).toBe(hp);
  unequip(f.member.character, f.member.state, 'boots');
  expect(applyCondition(f.member.state, 'Burning', f.member.character)).toBe(true);
});

it('Legendary charges belong to the item and survive stowing, re-equipping and recovery', () => {
  const f = fixture();
  const weapon = gear('weapon');
  f.member.state.stats.INT = 13;
  f.member.state.inventory.push({ ...weapon, quantity: 1 });
  expect(availableAbilities(f.member.character, f.member.state).filter((a) => a.equipmentId)).toEqual([]);
  equip(f.member.character, f.member.state, weapon.id, 'right');
  const ability = availableAbilities(f.member.character, f.member.state).find((a) => a.equipmentId)!;
  expect(
    requestedAbility(
      f.member.character,
      { memberId: f.member.id, text: `Use ${weapon.grantedAbility!.name}`, passed: false },
      'combat',
      null,
      f.member.state,
    )?.name,
  ).toBe(ability.name);
  f.action.actions[0].main = 'ability';
  f.action.actions[0].abilityName = ability.name;
  runCombat([f.member], f.encounter, f.action, (sides) => (sides === 20 ? 2 : 1)); // A miss spends the charge.
  expect(f.member.state.abilityUses?.[abilityUseKey(ability)]).toBe(1);
  unequip(f.member.character, f.member.state, 'right');
  expect(() => availableAbility(f.member.character, f.member.state, ability.name, 'combat')).toThrow(
    'Choose a current ability',
  );
  equip(f.member.character, f.member.state, weapon.id, 'right');
  expect(() => availableAbility(f.member.character, f.member.state, ability.name, 'combat')).toThrow(
    'already been used',
  );
  unequip(f.member.character, f.member.state, 'right');
  recoverAfterEncounter([f.member]);
  expect(f.member.state.abilityUses?.[abilityUseKey(ability)]).toBe(0);
  expect(f.member.character.abilities).toHaveLength(2);
});

it('deduplicates two-handed granted abilities and gives different items independent charges', () => {
  const f = fixture();
  const first = gear('focus', 'Legendary', 'first');
  const second = gear('focus', 'Legendary', 'second');
  f.member.state.equipment.right = first;
  f.member.state.equipment.left = first;
  expect(availableAbilities(f.member.character, f.member.state).filter((a) => a.equipmentId)).toHaveLength(1);
  f.member.state.equipment.left = second;
  const abilities = availableAbilities(f.member.character, f.member.state).filter((a) => a.equipmentId);
  expect(new Set(abilities.map((a) => a.name)).size).toBe(2);
  spendAbility(f.member.state, abilities[0]);
  expect(() =>
    availableAbility(f.member.character, f.member.state, abilities[1].name, 'combat'),
  ).not.toThrow();
});

it('migrates existing gear and hand-held relics without rewriting completed history or rerolling on reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gear-migration-'));
  const path = join(dir, 'game.sqlite');
  let db = openDatabase(path);
  try {
    const game = new Game(db, () => new PracticeGM());
    const host = game.identify();
    const player = game.identify();
    const sheet = game.saveCharacter(player.id, templateCharacter('Hero'));
    const campaign = game.create(host.id, {
      ruleset: 'roguelike-v1',
      name: 'Test',
      setting: 'Test',
      premise: '',
      tone: '',
      language: 'English',
      instructions: '',
      custom: [],
      provider: 'practice',
      model: '',
    });
    game.join(campaign.inviteCode!, player.id, sheet.id);
    const member = game.members(campaign.id)[0];
    const boots = gear('boots');
    delete boots.immunities;
    delete boots.grantedAbility;
    member.state.equipment.boots = boots;
    const firstRelic = gear('relic', 'Legendary', 'first-relic');
    const secondRelic = gear('relic', 'Legendary', 'second-relic');
    member.state.equipment.right = firstRelic;
    member.state.equipment.left = secondRelic;
    const { relic: _slot, ...legacyEquipment } = member.state.equipment;
    const legacyState = {
      ...member.state,
      equipment: legacyEquipment,
      inventory: Array.from({ length: 8 }, (_, i) => ({
        ...baseItem(`spare-${i}`, 'Spare', 'tool'),
        quantity: 1,
      })),
      abilityUses: { 'equipment:first-relic': 1 },
    };
    db.prepare('UPDATE members SET state=? WHERE id=?').run(JSON.stringify(legacyState), member.id);
    db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify({ loot: [boots] }), campaign.id);
    const historical = JSON.stringify({ item: boots });
    db.prepare(
      "INSERT INTO turns(id,campaign_id,number,phase,roster,draft,result) VALUES('old',?,0,'complete','[]',?,?)",
    ).run(campaign.id, historical, historical);
    const draft = { members: [{ ...member, state: legacyState }], saved: { state: legacyState } };
    db.prepare(
      "INSERT INTO turns(id,campaign_id,number,phase,roster,draft) VALUES('pending',?,1,'failed','[]',?)",
    ).run(campaign.id, JSON.stringify(draft));
    db.pragma('user_version = 8');
    db.close();
    db = openDatabase(path);
    const state = JSON.parse(
      (db.prepare('SELECT state FROM members WHERE id=?').get(member.id) as { state: string }).state,
    );
    const scene = JSON.parse(
      (db.prepare('SELECT scene FROM campaigns WHERE id=?').get(campaign.id) as { scene: string }).scene,
    );
    expect(state.equipment.boots.grantedAbility.kind).toBe('utility');
    expect(state.equipment.boots.immunities).toHaveLength(1);
    expect(scene.loot[0]).toEqual(state.equipment.boots);
    expect(state.equipment.relic).toEqual(firstRelic);
    expect(state.equipment.left).toBeNull();
    expect(state.equipment.right).toBeNull();
    expect(state.inventory).toHaveLength(9);
    expect(state.inventory.find((item: Item) => item.id === secondRelic.id)).toEqual({
      ...secondRelic,
      quantity: 1,
    });
    expect(state.abilityUses).toEqual(legacyState.abilityUses);
    const pending = JSON.parse(
      (db.prepare("SELECT draft FROM turns WHERE id='pending'").get() as { draft: string }).draft,
    );
    expect(pending.members[0].state).toEqual(state);
    expect(pending.saved.state).toEqual(state);
    expect(db.prepare("SELECT draft,result FROM turns WHERE id='old'").get()).toEqual({
      draft: historical,
      result: historical,
    });
    const saved = JSON.stringify(state);
    db.close();
    db = openDatabase(path);
    expect(
      JSON.parse(
        (db.prepare('SELECT state FROM members WHERE id=?').get(member.id) as { state: string }).state,
      ),
    ).toEqual(JSON.parse(saved));
  } finally {
    if (db.open) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('routes a Legendary utility through the game and reuses its check and charge after interruption', async () => {
  const db = openDatabase(':memory:');
  try {
    let fail = false;
    const practice = new PracticeGM();
    const provider = {
      adjudicate: practice.adjudicate.bind(practice),
      narrate: async (...args: Parameters<PracticeGM['narrate']>) => {
        if (fail) throw new Error('Interrupted narration.');
        return practice.narrate(...args);
      },
    };
    const draws = vi.fn((sides: number) => Math.min(2, sides));
    const game = new Game(db, () => provider, draws);
    const host = game.identify();
    const player = game.identify();
    const sheet = game.saveCharacter(player.id, templateCharacter('Hero'));
    const campaign = game.create(host.id, {
      ruleset: 'roguelike-v1',
      name: 'Test',
      setting: 'Test',
      premise: '',
      tone: '',
      language: 'English',
      instructions: '',
      custom: [],
      provider: 'practice',
      model: '',
    });
    game.join(campaign.inviteCode!, player.id, sheet.id);
    const member = game.members(campaign.id)[0];
    game.manageCharacter(campaign.id, player.id, {
      type: 'starter',
      itemIds: member.state.starterEquipment.slice(0, 2).map((item) => item.id),
    });
    game.start(campaign.id, host.id);
    await game.idle();
    const state = game.members(campaign.id)[0].state;
    const boots = gear('boots');
    state.equipment.boots = boots;
    db.prepare('UPDATE members SET state=? WHERE id=?').run(JSON.stringify(state), member.id);
    const ability = availableAbilities(member.character, state).find((a) => a.equipmentId)!;
    const turn = game.snapshot(campaign.id, host.id).turn!;
    fail = true;
    game.submit(
      campaign.id,
      player.id,
      turn.id,
      `Use ${ability.name} to climb the slope.`,
      false,
      false,
      ability.name,
    );
    await game.idle();
    const before = draws.mock.calls.length;
    fail = false;
    game.retry(campaign.id, host.id);
    await game.idle();
    const result = game.snapshot(campaign.id, host.id);
    expect(result.turn?.phase).toBe('collecting');
    expect(result.history.at(-1)?.rolls[0]).toMatchObject({
      abilityName: ability.name,
      stat: 'DEX',
      mode: 'advantage',
      modifier: 4,
    });
    expect(result.members[0].state.abilityUses?.[abilityUseKey(ability)]).toBe(1);
    expect(draws.mock.calls).toHaveLength(before);
    expect(result.members[0].character.abilities).toHaveLength(2);
  } finally {
    db.close();
  }
});
