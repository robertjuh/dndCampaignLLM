import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/db';
import { Game, type GameMaster } from '../server/game';
import { baseItem } from '../shared/rules';
import { outcomeSchema, templateCharacter, type CampaignConfig, type Outcome } from '../shared/schema';

const config: CampaignConfig = {
  ruleset: 'roguelike-v1',
  name: 'A continuing campaign',
  setting: 'The changing tower',
  premise: '',
  tone: 'Strange',
  language: 'English',
  instructions: '',
  custom: [],
  provider: 'practice',
  model: '',
};
const outcome = (overrides: Partial<Outcome> = {}): Outcome =>
  outcomeSchema.parse({
    narration: 'The party moves through the tower.',
    summary: 'Another step through the tower.',
    choices: ['Continue.'],
    changes: [],
    journal: [],
    lethalWarning: 'Falling from the tower is fatal.',
    ...overrides,
  });
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function fixture(filename = ':memory:') {
  const db = openDatabase(filename);
  cleanup.push(() => {
    if (db.open) db.close();
  });
  const control: {
    mode: 'idle' | 'death' | 'advance' | 'wipe';
    fail: boolean;
    entered?: () => void;
    wait?: Promise<void>;
    arrivals: string[];
  } = { mode: 'idle', fail: false, arrivals: [] };
  const draw = vi.fn((_sides: number) => 12);
  const provider: GameMaster = {
    resolve: async (ctx, tools) => {
      if (!ctx.turn.number) return outcome();
      control.arrivals = (ctx.arrivingCharacters ?? []).map(({ character }) => character.name);
      if (control.mode === 'death' || control.mode === 'wipe') {
        for (const member of control.mode === 'death' ? ctx.members.slice(0, 1) : ctx.members)
          tools({
            memberId: member.id,
            stat: 'DEX',
            dc: 20,
            reason: 'Cross the broken bridge.',
            mode: 'normal',
            lethal: true,
          });
      }
      if (control.mode === 'advance') {
        tools({
          memberId: ctx.members.find((member) => member.state.hp > 0)!.id,
          stat: 'INT',
          dc: 10,
          reason: 'Find the staircase.',
          mode: 'normal',
          lethal: false,
        });
        tools.completeChallenge({
          memberId: ctx.members.find((member) => member.state.hp > 0)!.id,
          reason: 'Find a safe way across the broken terrain.',
          bossEquivalent: false,
        });
        control.entered?.();
        await control.wait;
        if (control.fail) throw new Error('Interrupted after the staircase check.');
        return outcome({
          xp: 7,
          gold: 9,
          location: { name: 'A floating garden', atmosphere: 'Rain rises.', hazard: 'Moving roots.' },
        });
      }
      return outcome();
    },
  };
  const game = new Game(db, () => provider, draw);
  const host = game.identify();
  const p1 = game.identify();
  const p2 = game.identify();
  const save = (playerId: string, name: string) => {
    const sheet = templateCharacter(name);
    sheet.selectedEquipmentIds = sheet.equipmentOptions.slice(0, 2).map((item) => item.id);
    return game.saveCharacter(playerId, sheet);
  };
  const c1 = save(p1.id, 'Mira');
  const c2 = save(p2.id, 'Rowan');
  const replacement = save(p1.id, 'Ash');
  const c = game.create(host.id, config);
  game.join(c.inviteCode!, p1.id, c1.id);
  game.join(c.inviteCode!, p2.id, c2.id);
  return { db, game, host, p1, p2, c, c1, c2, replacement, control, draw, provider };
}
type Fixture = ReturnType<typeof fixture>;
const member = (f: Fixture, playerId = f.p1.id) =>
  f.game.members(f.c.id).find((m) => m.playerId === playerId)!;
async function start(f: Fixture) {
  f.game.start(f.c.id, f.host.id);
  await f.game.idle();
}
async function killFirst(f: Fixture) {
  const fallen = member(f);
  fallen.state.downedThisEncounter = true;
  f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(fallen.state), fallen.id);
  f.control.mode = 'death';
  f.draw.mockReturnValue(1);
  const turn = f.game.snapshot(f.c.id, f.host.id).turn!;
  f.game.submit(f.c.id, f.p1.id, turn.id, 'Cross the broken bridge.', false, true);
  f.game.submit(f.c.id, f.p2.id, turn.id, 'Stay safely on shore.', false);
  await f.game.idle();
  expect(member(f).state.hp).toBe(0);
  expect(f.game.snapshot(f.c.id, f.host.id).turn?.roster).toEqual([member(f, f.p2.id).id]);
  f.draw.mockReturnValue(12);
  f.control.mode = 'idle';
}
function submitSurvivor(f: Fixture) {
  const turn = f.game.snapshot(f.c.id, f.host.id).turn!;
  f.game.submit(f.c.id, f.p2.id, turn.id, 'Find the staircase.', false);
}
function archives(f: Fixture) {
  return f.db
    .prepare("SELECT payload FROM events WHERE campaign_id = ? AND kind = 'character_replaced'")
    .all(f.c.id) as { payload: string }[];
}

describe('replacement characters after successful encounters', () => {
  it('admits a replacement queued after a success to the next collecting turn and introduces them there', async () => {
    const f = fixture();
    await start(f);
    await killFirst(f);
    f.control.mode = 'advance';
    submitSurvivor(f);
    await f.game.idle();
    expect(member(f).character.name).toBe('Mira');
    expect(member(f).state.respawnReady).toBe(true);
    const next = f.game.snapshot(f.c.id, f.host.id).turn!;
    expect(next.roster).not.toContain(member(f).id);
    const newcomer = f.game.identify();
    const sheet = templateCharacter('Late traveller');
    sheet.selectedEquipmentIds = sheet.equipmentOptions.slice(0, 2).map((item) => item.id);
    const saved = f.game.saveCharacter(newcomer.id, sheet);
    f.game.join(f.c.inviteCode!, newcomer.id, saved.id);
    const lateMember = member(f, newcomer.id);
    expect(f.game.snapshot(f.c.id, f.host.id).turn!.roster).not.toContain(lateMember.id);
    f.game.queueReplacement(f.c.id, f.p1.id, f.replacement.id);
    const fresh = member(f);
    expect(fresh.character.name).toBe('Ash');
    expect(fresh.state).toMatchObject({ level: 1, xp: 0, gold: 0, hp: fresh.state.maxHp });
    expect(f.game.snapshot(f.c.id, f.host.id).turn!.id).toBe(next.id);
    expect(f.game.snapshot(f.c.id, f.host.id).turn!.roster).toEqual([...next.roster, fresh.id]);
    expect(f.game.snapshot(f.c.id, f.host.id).turn!.roster).not.toContain(lateMember.id);
    expect(archives(f)).toHaveLength(1);
    f.control.mode = 'idle';
    f.game.submit(f.c.id, f.p1.id, next.id, 'Introduce myself.', false);
    f.game.submit(f.c.id, f.p2.id, next.id, 'Welcome Ash.', false);
    await f.game.idle();
    expect(f.control.arrivals).toEqual(['Ash']);
    expect(f.game.snapshot(f.c.id, f.host.id).turn!.roster).toContain(lateMember.id);
    expect(archives(f)).toHaveLength(1);
    expect(f.game.snapshot(f.c.id, f.host.id).history[1].actions[0].characterName).toBe('Mira');
  });

  it('requires an active campaign, a dead member, ownership, and two saved starting choices', async () => {
    const f = fixture();
    expect(() => f.game.queueReplacement(f.c.id, f.p1.id, f.replacement.id)).toThrow();
    await start(f);
    expect(() => f.game.queueReplacement(f.c.id, f.p1.id, f.replacement.id)).toThrow();
    await killFirst(f);
    const stranger = f.game.identify();
    expect(() => f.game.queueReplacement(f.c.id, stranger.id, f.replacement.id)).toThrow();
    expect(() => f.game.queueReplacement(f.c.id, f.p1.id, f.c2.id)).toThrow();
    expect(() => f.game.queueReplacement(f.c.id, f.p1.id, 'missing-character')).toThrow();
    const unchosen = f.game.saveCharacter(f.p1.id, templateCharacter('Unprepared'));
    expect(() => f.game.queueReplacement(f.c.id, f.p1.id, unchosen.id)).toThrow();
    const emitted = vi.fn();
    const unsubscribe = f.game.subscribe(f.c.id, emitted);
    const version = f.game.snapshot(f.c.id, f.p1.id).version;
    f.game.queueReplacement(f.c.id, f.p1.id, f.replacement.id);
    expect(member(f).replacement?.characterId).toBe(f.replacement.id);
    expect(f.game.snapshot(f.c.id, f.p1.id).version).toBe(version + 1);
    f.game.queueReplacement(f.c.id, f.p1.id, null);
    expect(member(f).replacement).toBeNull();
    expect(f.game.snapshot(f.c.id, f.p1.id).version).toBe(version + 2);
    expect(emitted).toHaveBeenCalledTimes(2);
    unsubscribe();
    f.db.prepare("UPDATE campaigns SET status = 'ended' WHERE id = ?").run(f.c.id);
    expect(() => f.game.queueReplacement(f.c.id, f.p1.id, f.replacement.id)).toThrow();
  });

  it('keeps the old character dead until a successful encounter and archives their life', async () => {
    const f = fixture();
    await start(f);
    await killFirst(f);
    const deathTurn = f.game.snapshot(f.c.id, f.host.id).history.at(-1)!;
    f.db.prepare('UPDATE turns SET draft = NULL WHERE id = ?').run(deathTurn.id);
    const retired = member(f);
    Object.assign(retired.state, {
      level: 4,
      xp: 82,
      gold: 77,
      pendingLevelUps: 2,
      kills: 9,
      bosses: 2,
      restedEncounter: 1,
      conditions: ['Poisoned'],
      conditionTurns: { Poisoned: 2 },
      abilityUses: { 'Focused strike': 1 },
      abilityGuard: 4,
      abilityAssist: 2,
      guarding: true,
    });
    retired.state.inventory.push({ ...baseItem('old-treasure', 'Old treasure', 'relic'), quantity: 1 });
    f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(retired.state), retired.id);
    const { id: _id, ...sheet } = structuredClone(f.replacement);
    sheet.abilities.forEach((ability) => (ability.level = 4));
    f.game.updateCharacter(f.p1.id, f.replacement.id, sheet);
    f.game.queueReplacement(f.c.id, f.p1.id, f.replacement.id);
    submitSurvivor(f);
    await f.game.idle();
    expect(member(f).character.name).toBe('Mira');
    expect(member(f).state.hp).toBe(0);
    expect(archives(f)).toHaveLength(0);
    f.control.mode = 'advance';
    submitSurvivor(f);
    await f.game.idle();
    const fresh = member(f);
    expect(fresh.id).toBe(retired.id);
    expect(fresh.playerId).toBe(retired.playerId);
    expect(fresh.characterId).toBe(f.replacement.id);
    expect(fresh.character.name).toBe('Ash');
    expect(fresh.character.abilities.every((ability) => ability.level === 1)).toBe(true);
    expect(fresh.state).toMatchObject({
      level: 1,
      hp: fresh.state.maxHp,
      xp: 0,
      gold: 0,
      pendingLevelUps: 0,
      kills: 0,
      bosses: 0,
      conditions: [],
      conditionTurns: {},
      abilityUses: {},
      deathReason: null,
      restedEncounter: null,
      equipmentChosen: true,
      starterEquipment: [],
    });
    expect(fresh.state.guarding).toBeFalsy();
    expect(fresh.state.abilityGuard ?? 0).toBe(0);
    expect(fresh.state.abilityAssist ?? 0).toBe(0);
    expect(fresh.state.inventory).toHaveLength(1);
    expect(fresh.state.inventory[0].name).toBe(fresh.character.healingItemName);
    expect(
      Object.values(fresh.state.equipment)
        .filter(Boolean)
        .map((item) => item!.name)
        .sort(),
    ).toEqual(
      f.replacement.equipmentOptions
        .slice(0, 2)
        .map((item) => item.name)
        .sort(),
    );
    expect(fresh.replacement).toBeNull();
    const snapshot = f.game.snapshot(f.c.id, f.host.id);
    expect(snapshot.scene.encounters).toBe(1);
    expect(snapshot.scene.location.name).toBe('A floating garden');
    expect(snapshot.turn?.roster).toContain(fresh.id);
    expect(member(f, f.p2.id).state).toMatchObject({ xp: 7, gold: 9 });
    expect(snapshot.history[1].actions.find((action) => action.memberId === fresh.id)?.characterName).toBe(
      'Mira',
    );
    expect(archives(f)).toHaveLength(1);
    const archived = JSON.parse(archives(f)[0].payload);
    expect(archived).toMatchObject({
      member: {
        id: retired.id,
        characterId: f.c1.id,
        character: retired.character,
        state: { ...retired.state, respawnReady: true },
      },
      replacementCharacterId: f.replacement.id,
    });
    expect(f.game.characters(f.p1.id).find((character) => character.id === f.c1.id)?.name).toBe('Mira');
  });

  it('uses the queued snapshot even when the library is regenerated or its picks change', async () => {
    const f = fixture();
    await start(f);
    await killFirst(f);
    f.db
      .prepare('UPDATE campaigns SET config = ? WHERE id = ?')
      .run(JSON.stringify({ ...config, language: 'Nederlands' }), f.c.id);
    f.game.queueReplacement(f.c.id, f.p1.id, f.replacement.id);
    const changed = templateCharacter('A different future character');
    changed.selectedEquipmentIds = changed.equipmentOptions.slice(3, 5).map((item) => item.id);
    f.game.updateCharacter(f.p1.id, f.replacement.id, changed);
    expect(member(f).replacement?.character.name).toBe('Ash');
    f.control.mode = 'advance';
    submitSurvivor(f);
    await f.game.idle();
    expect(member(f).character.name).toBe('Ash');
    expect(member(f).character.selectedEquipmentIds).toEqual(f.replacement.selectedEquipmentIds);
    const narration = f.game.snapshot(f.c.id, f.host.id).history.at(-1)!.result!.narration;
    expect(narration).not.toContain('floor');
    expect(narration).not.toContain('Ash');
    f.control.mode = 'idle';
    const next = f.game.snapshot(f.c.id, f.host.id).turn!;
    f.game.submit(f.c.id, f.p1.id, next.id, 'Introduce myself to the party.', false);
    f.game.submit(f.c.id, f.p2.id, next.id, 'Welcome the new traveller.', false);
    await f.game.idle();
    expect(f.control.arrivals).toEqual(['Ash']);
    expect(f.game.characters(f.p1.id).find((character) => character.id === f.replacement.id)?.name).toBe(
      'A different future character',
    );
  });

  it('reads queue changes made after a mechanic draft was saved, including cancellation', async () => {
    const f = fixture();
    await start(f);
    await killFirst(f);
    f.control.mode = 'advance';
    let release!: () => void;
    const entered = new Promise<void>((resolve) => (f.control.entered = resolve));
    f.control.wait = new Promise<void>((resolve) => (release = resolve));
    submitSurvivor(f);
    await entered;
    expect(f.game.snapshot(f.c.id, f.host.id).turn?.phase).toBe('resolving');
    f.game.queueReplacement(f.c.id, f.p1.id, f.replacement.id);
    f.game.queueReplacement(f.c.id, f.p1.id, null);
    release();
    await f.game.idle();
    expect(member(f).character.name).toBe('Mira');
    expect(member(f).state.hp).toBe(0);
    expect(member(f).replacement).toBeNull();
    expect(f.game.snapshot(f.c.id, f.host.id).scene.encounters).toBe(1);
    expect(archives(f)).toHaveLength(0);
    let releaseAgain!: () => void;
    const enteredAgain = new Promise<void>((resolve) => (f.control.entered = resolve));
    f.control.wait = new Promise<void>((resolve) => (releaseAgain = resolve));
    submitSurvivor(f);
    await enteredAgain;
    f.game.queueReplacement(f.c.id, f.p1.id, f.replacement.id);
    releaseAgain();
    await f.game.idle();
    expect(member(f).character.name).toBe('Ash');
    expect(archives(f)).toHaveLength(1);
  });

  it('restores a queued character after a restart and activates once when a failed turn is retried', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gather-respawn-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const filename = join(directory, 'test.sqlite');
    const f = fixture(filename);
    await start(f);
    await killFirst(f);
    f.game.queueReplacement(f.c.id, f.p1.id, f.replacement.id);
    f.control.mode = 'advance';
    f.control.fail = true;
    submitSurvivor(f);
    await f.game.idle();
    expect(f.game.snapshot(f.c.id, f.host.id).turn?.phase).toBe('failed');
    expect(member(f).state.hp).toBe(0);
    const drawCount = f.draw.mock.calls.length;
    f.db.close();
    const reopened = openDatabase(filename);
    cleanup.push(() => reopened.close());
    f.db = reopened;
    f.game = new Game(reopened, () => f.provider, f.draw);
    expect(member(f).replacement?.character.name).toBe('Ash');
    f.control.fail = false;
    f.game.retry(f.c.id, f.host.id);
    await f.game.idle();
    expect(member(f).character.name).toBe('Ash');
    expect(f.draw).toHaveBeenCalledTimes(drawCount);
    expect(archives(f)).toHaveLength(1);
    expect(f.game.snapshot(f.c.id, f.host.id).scene.encounters).toBe(1);
    expect(() => f.game.retry(f.c.id, f.host.id)).toThrow();
  });

  it('preserves sit-out status when a replacement arrives', async () => {
    const f = fixture();
    await start(f);
    await killFirst(f);
    f.game.setActive(f.c.id, f.host.id, member(f).id, false);
    f.game.queueReplacement(f.c.id, f.p1.id, f.replacement.id);
    f.control.mode = 'advance';
    submitSurvivor(f);
    await f.game.idle();
    expect(member(f).character.name).toBe('Ash');
    expect(member(f).active).toBe(false);
    expect(f.game.snapshot(f.c.id, f.host.id).turn?.roster).not.toContain(member(f).id);
  });

  it('ends the campaign on a party wipe even with a replacement waiting', async () => {
    const f = fixture();
    await start(f);
    await killFirst(f);
    f.game.queueReplacement(f.c.id, f.p1.id, f.replacement.id);
    f.control.mode = 'wipe';
    f.draw.mockReturnValue(1);
    const turn = f.game.snapshot(f.c.id, f.host.id).turn!;
    f.game.submit(f.c.id, f.p2.id, turn.id, 'Cross the broken bridge.', false, true);
    await f.game.idle();
    const snapshot = f.game.snapshot(f.c.id, f.host.id);
    expect(snapshot.status).toBe('ended');
    expect(snapshot.turn).toBeNull();
    expect(snapshot.members.every((m) => m.state.hp === 0)).toBe(true);
    expect(member(f).character.name).toBe('Mira');
    expect(archives(f)).toHaveLength(0);
    expect(() => f.game.queueReplacement(f.c.id, f.p1.id, f.replacement.id)).toThrow();
  });

  it('upgrades existing campaign members without changing their characters or progress', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gather-respawn-migration-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const filename = join(directory, 'test.sqlite');
    const f = fixture(filename);
    await start(f);
    await killFirst(f);
    const before = f.game.members(f.c.id);
    f.db.exec('ALTER TABLE members DROP COLUMN replacement; PRAGMA user_version = 6;');
    f.db.close();
    const reopened = openDatabase(filename);
    cleanup.push(() => reopened.close());
    const restored = new Game(reopened, () => f.provider, f.draw);
    expect(reopened.pragma('user_version', { simple: true })).toBe(11);
    expect(restored.members(f.c.id).map((m) => ({ character: m.character, state: m.state }))).toEqual(
      before.map((m) => ({ character: m.character, state: m.state })),
    );
    expect(restored.members(f.c.id).every((m) => m.replacement === null)).toBe(true);
    restored.queueReplacement(f.c.id, f.p1.id, f.replacement.id);
    expect(restored.members(f.c.id)[0].replacement?.character.name).toBe('Ash');
  });
});
