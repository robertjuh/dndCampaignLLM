import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db';
import { Game } from '../server/game';
import { PracticeGM } from '../server/providers';
import { lootSchema, templateCharacter, characterSchema } from '../shared/schema';
import { initialState, validateEquipmentName } from '../shared/rules';

it.each(['Weapon 1', "Robert's armor 1", 'Starting equipment 3', 'Wapen 2'])(
  'rejects the placeholder name %s for new equipment and loot',
  (name) => {
    expect(() => validateEquipmentName({ name })).toThrow('world-fitting name');
    expect(
      lootSchema.safeParse({
        name,
        kind: 'weapon',
        scaling: ['STR'],
        hands: 1,
        light: false,
        description: '',
      }).success,
    ).toBe(false);
    expect(() => validateEquipmentName({ name: 'Chainmail' })).not.toThrow();
    expect(() => validateEquipmentName({ name: 'Tidekeeper’s Coat' })).not.toThrow();
  },
);

it('upgrades legacy offers without changing equipped gear, queued choices, or completed history', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gather-equipment-migration-'));
  const filename = join(directory, 'test.sqlite');
  let db = openDatabase(filename, () => 1);
  try {
    const game = new Game(db, () => new PracticeGM());
    const player = game.identify();
    const saved = game.saveCharacter(player.id, templateCharacter('Mira'));
    const campaign = game.create(player.id, {
      name: 'Harbor',
      setting: 'Coast',
      premise: '',
      tone: '',
      language: 'English',
      instructions: '',
      custom: [],
      provider: 'practice',
    });
    game.join(campaign.inviteCode!, player.id, saved.id);
    const member = game.members(campaign.id)[0];
    const legacy = templateCharacter('Mira');
    legacy.equipmentOptions = legacy.equipmentOptions.slice(0, 5);
    legacy.selectedEquipmentIds = legacy.equipmentOptions.slice(0, 2).map((item) => item.id);
    const chosen = initialState(legacy, 'legacy');
    const queued = { characterId: saved.id, character: legacy };
    db.prepare('UPDATE characters SET sheet = ? WHERE id = ?').run(JSON.stringify(legacy), saved.id);
    db.prepare('UPDATE members SET sheet = ?, state = ?, replacement = ? WHERE id = ?').run(
      JSON.stringify(legacy),
      JSON.stringify(chosen),
      JSON.stringify(queued),
      member.id,
    );
    const historyId = randomUUID();
    const pendingId = randomUUID();
    const history = JSON.stringify({ members: [{ character: legacy, state: chosen }] });
    const unchosen = initialState({ ...legacy, selectedEquipmentIds: [] }, 'pending');
    const pending = JSON.stringify({
      members: [{ character: legacy, state: unchosen }],
      receipts: { saved: 'keep this receipt' },
    });
    const insertTurn = db.prepare(
      'INSERT INTO turns(id, campaign_id, number, phase, roster, draft, result) VALUES(?, ?, ?, ?, ?, ?, ?)',
    );
    insertTurn.run(historyId, campaign.id, 0, 'complete', '[]', history, history);
    insertTurn.run(pendingId, campaign.id, 1, 'failed', '[]', pending, null);
    db.pragma('user_version = 23');
    db.close();
    db = openDatabase(filename, () => 1);
    const restored = new Game(db, () => new PracticeGM());
    const { id: _id, ...sheet } = restored.characters(player.id)[0];
    expect(characterSchema.safeParse(sheet).success).toBe(true);
    expect(sheet.equipmentOptions).toHaveLength(7);
    expect(sheet.equipmentOptions.filter((item) => item.kind === 'weapon')).toHaveLength(2);
    expect(sheet.selectedEquipmentIds).toEqual([]);
    expect(restored.members(campaign.id)[0].state).toMatchObject(chosen);
    expect(restored.members(campaign.id)[0].replacement).toMatchObject(queued);
    expect(initialState(queued.character, 'queued').equipmentChosen).toBe(true);
    expect(db.prepare('SELECT draft, result FROM turns WHERE id = ?').get(historyId)).toEqual({
      draft: history,
      result: history,
    });
    const recovered = JSON.parse(
      (db.prepare('SELECT draft FROM turns WHERE id = ?').get(pendingId) as { draft: string }).draft,
    );
    expect(recovered.members[0].state.starterEquipment).toHaveLength(7);
    expect(recovered.members[0].state.equipmentChosen).toBe(false);
    expect(recovered.receipts).toEqual({ saved: 'keep this receipt' });
    expect(db.pragma('user_version', { simple: true })).toBe(29);
  } finally {
    if (db.open) db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('repairs saved equipment names from their physical descriptions while preserving IDs, stats and history', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gather-equipment-names-'));
  const filename = join(directory, 'test.sqlite');
  let db = openDatabase(filename, () => 1);
  try {
    const game = new Game(db, () => new PracticeGM());
    const player = game.identify();
    const character = templateCharacter('Robert');
    character.selectedEquipmentIds = character.equipmentOptions.slice(0, 3).map((item) => item.id);
    const saved = game.saveCharacter(player.id, character);
    const campaign = game.create(player.id, {
      name: 'Orbital salvage',
      setting: 'An abandoned orbital station',
      premise: '',
      tone: '',
      language: 'Nederlands',
      instructions: '',
      custom: [],
      provider: 'practice',
    });
    game.join(campaign.inviteCode!, player.id, saved.id);
    const member = game.members(campaign.id)[0];
    const weapon = member.character.equipmentOptions[0];
    weapon.name = 'Weapon 1';
    weapon.description = 'A pulse carbine with a scorched receiver.';
    member.character.equipmentOptions[1].name = "Robert's armor 1";
    member.character.equipmentOptions[1].description =
      'Een verouderd drukpak met een gerepareerde zuurstofslang.';
    member.character.equipmentOptions[4].name = 'Helmet 4';
    member.character.equipmentOptions[4].description = '+1 defense.';
    member.character.equipmentOptions[5].name = 'Hullwatch Mk 2';
    for (const item of Object.values(member.state.equipment)) {
      if (!item) continue;
      const original = member.character.equipmentOptions.find((offer) => item.id.endsWith(offer.id))!;
      item.name = original.name;
      item.description = original.description;
    }
    const replacement = { characterId: saved.id, character: member.character };
    db.prepare('UPDATE characters SET sheet = ? WHERE id = ?').run(
      JSON.stringify(member.character),
      saved.id,
    );
    db.prepare('UPDATE members SET sheet = ?, state = ?, replacement = ? WHERE id = ?').run(
      JSON.stringify(member.character),
      JSON.stringify(member.state),
      JSON.stringify(replacement),
      member.id,
    );
    const scene = game.snapshot(campaign.id, player.id).scene;
    scene.loot.push({ ...weapon, id: 'ground-carbine', quantity: 1 });
    db.prepare('UPDATE campaigns SET scene = ? WHERE id = ?').run(JSON.stringify(scene), campaign.id);
    const historyId = randomUUID();
    const history = JSON.stringify({ members: [member] });
    db.prepare(
      'INSERT INTO turns(id, campaign_id, number, phase, roster, draft, result) VALUES(?, ?, 0, ?, ?, ?, ?)',
    ).run(historyId, campaign.id, 'complete', '[]', history, history);
    db.pragma('user_version = 24');
    db.close();
    db = openDatabase(filename, () => 1);
    const restored = new Game(db, () => new PracticeGM());
    const after = restored.members(campaign.id)[0];
    expect(after.character.equipmentOptions.map((item) => item.name)).toEqual([
      'Pulse carbine',
      'Verouderd drukpak',
      'Travel boots',
      'Hunting knife',
      'Hoofdbescherming',
      'Hullwatch Mk 2',
      'Carved keepsake',
    ]);
    expect(after.state.equipment.right?.name).toBe('Pulse carbine');
    expect(after.state.equipment.body?.name).toBe('Verouderd drukpak');
    expect(after.replacement!.character.equipmentOptions[0].name).toBe('Pulse carbine');
    expect(restored.characters(player.id)[0].equipmentOptions[0].name).toBe('Pulse carbine');
    expect(restored.snapshot(campaign.id, player.id).scene.loot[0].name).toBe('Pulse carbine');
    const withoutNames = (input: unknown): unknown =>
      Array.isArray(input)
        ? input.map(withoutNames)
        : input && typeof input === 'object'
          ? Object.fromEntries(
              Object.entries(input)
                .filter(([key]) => key !== 'name' && key !== 'attributeBonus')
                .map(([key, value]) => [key, withoutNames(value)]),
            )
          : input;
    expect(withoutNames(after.state)).toEqual(withoutNames(member.state));
    expect(withoutNames(after.character)).toEqual(withoutNames(member.character));
    expect(db.prepare('SELECT draft, result FROM turns WHERE id = ?').get(historyId)).toEqual({
      draft: history,
      result: history,
    });
    db.close();
    db = openDatabase(filename, () => 1);
    expect(new Game(db, () => new PracticeGM()).members(campaign.id)[0].state).toEqual(after.state);
  } finally {
    if (db.open) db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
