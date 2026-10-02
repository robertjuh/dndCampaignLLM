import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/db';
import { PracticeGM } from '../server/providers';
import { Game, type GameMaster, type GMContext } from '../server/game';
import {
  templateCharacter,
  outcomeSchema,
  type CampaignConfig,
  type Outcome,
  type Check,
} from '../shared/schema';

const config: CampaignConfig = {
  ruleset: 'roguelike-v1',
  name: 'The test table',
  setting: 'A quiet forest',
  premise: '',
  tone: 'Mysterious',
  language: 'English',
  instructions: '',
  custom: [{ key: 'Year', value: '9999' }],
  provider: 'practice',
  model: '',
};
const outcome = (overrides: Partial<Outcome> = {}): Outcome =>
  outcomeSchema.parse({
    narration: 'A lantern flickers.',
    summary: 'The party stands at the gate.',
    choices: ['Look inside.'],
    changes: [],
    journal: [],
    ...overrides,
  });
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});
function fixture(provider: GameMaster = { resolve: async () => outcome() }, filename = ':memory:') {
  const db = openDatabase(filename);
  cleanup.push(() => {
    if (db.open) db.close();
  });
  const draw = vi.fn(() => 12);
  const game = new Game(
    db,
    () => ({ ...provider, levelUp: provider.levelUp ?? new PracticeGM().levelUp }),
    draw,
  );
  const host = game.identify();
  const p1 = game.identify();
  const p2 = game.identify();
  const c1 = game.saveCharacter(p1.id, templateCharacter('Mira'));
  const c2 = game.saveCharacter(p2.id, templateCharacter('Rowan'));
  const c = game.create(host.id, config);
  game.join(c.inviteCode!, p1.id, c1.id);
  game.join(c.inviteCode!, p2.id, c2.id);
  for (const member of game.members(c.id))
    game.manageCharacter(c.id, member.playerId, {
      type: 'starter',
      itemIds: member.state.starterEquipment.slice(0, 2).map((item) => item.id),
    });
  return { game, db, host, p1, p2, c, c1, c2, draw };
}

it('edits only owned templates and lobby characters, resets readiness, and preserves active runs', async () => {
  const { game, p1, p2, host, c, c1 } = fixture();
  expect(() => game.updateCharacter(p2.id, c1.id, templateCharacter('Stolen'))).toThrow('not found');
  const edited = game.editLobbyCharacter(c.id, p1.id, templateCharacter('Revised character'));
  expect(edited.id).toBe(c1.id);
  const member = game.members(c.id).find((m) => m.playerId === p1.id)!;
  expect(member.character.name).toBe('Revised character');
  expect(member.state.equipmentChosen).toBe(false);
  expect(member.state.starterEquipment).toHaveLength(5);
  expect(() => game.editLobbyCharacter(c.id, host.id, edited)).toThrow('Join');
  expect(() => game.start(c.id, host.id)).toThrow('starting equipment');
  game.manageCharacter(c.id, p1.id, {
    type: 'starter',
    itemIds: member.state.starterEquipment.slice(0, 2).map((item) => item.id),
  });
  game.start(c.id, host.id);
  await game.idle();
  expect(() => game.editLobbyCharacter(c.id, p1.id, templateCharacter('Reset'))).toThrow('started');
  game.updateCharacter(p1.id, c1.id, templateCharacter('Future character'));
  expect(game.members(c.id).find((m) => m.playerId === p1.id)!.character.name).toBe('Revised character');
  expect(game.characters(p1.id)[0].name).toBe('Future character');
});
async function start(f: ReturnType<typeof fixture>) {
  f.game.start(f.c.id, f.host.id);
  await f.game.idle();
  return f.game.snapshot(f.c.id, f.host.id).turn!;
}
function submitBoth(f: ReturnType<typeof fixture>, turnId: string) {
  f.game.submit(f.c.id, f.p1.id, turnId, 'Investigate the door.', false);
  f.game.submit(f.c.id, f.p2.id, turnId, 'Watch the road.', false);
}

describe('automatic group turns', () => {
  it('waits for the complete roster and resolves the final submission exactly once', async () => {
    const resolve = vi.fn(async () => outcome());
    const f = fixture({ resolve });
    const turn = await start(f);
    f.game.submit(f.c.id, f.p1.id, turn.id, 'Look around.', false);
    expect(f.game.snapshot(f.c.id, f.host.id).turn?.phase).toBe('collecting');
    expect(resolve).toHaveBeenCalledTimes(1);
    f.game.submit(f.c.id, f.p1.id, turn.id, 'Inspect the gate instead.', false);
    expect(f.game.snapshot(f.c.id, f.host.id).turn?.actions).toHaveLength(1);
    f.game.submit(f.c.id, f.p2.id, turn.id, '', true);
    expect(() => f.game.submit(f.c.id, f.p2.id, turn.id, '', true)).toThrow('already processing');
    f.game.kick(f.c.id);
    await f.game.idle();
    expect(resolve).toHaveBeenCalledTimes(2);
    const s = f.game.snapshot(f.c.id, f.host.id);
    expect(s.history).toHaveLength(2);
    expect(s.turn?.number).toBe(2);
    expect(s.turn?.actions).toEqual([]);
  });
  it('keeps a late joiner out of the current turn and includes them in the next', async () => {
    const f = fixture();
    const turn = await start(f);
    const p3 = f.game.identify();
    const c3 = f.game.saveCharacter(p3.id, templateCharacter('Ash'));
    f.game.join(f.c.inviteCode!, p3.id, c3.id);
    expect(() => f.game.submit(f.c.id, p3.id, turn.id, 'Hello', false)).toThrow('next turn');
    submitBoth(f, turn.id);
    await f.game.idle();
    expect(f.game.snapshot(f.c.id, f.host.id).turn?.roster).toHaveLength(3);
  });
  it('does not count a second browser tab as a second player', () => {
    const f = fixture();
    const same = f.game.identify(f.p1.token);
    expect(same.id).toBe(f.p1.id);
    f.game.join(f.c.inviteCode!, same.id, f.c1.id);
    expect(f.game.members(f.c.id)).toHaveLength(2);
  });
  it('honours pause, explicit sit-out, and solo turns', async () => {
    const f = fixture();
    const turn = await start(f);
    f.game.pause(f.c.id, f.host.id, true);
    f.game.setActive(f.c.id, f.host.id, f.game.members(f.c.id)[1].id, false);
    f.game.submit(f.c.id, f.p1.id, turn.id, 'Go in.', false);
    expect(f.game.snapshot(f.c.id, f.host.id).turn?.phase).toBe('collecting');
    f.game.pause(f.c.id, f.host.id, false);
    await f.game.idle();
    expect(f.game.snapshot(f.c.id, f.host.id).turn?.number).toBe(2);
  });
});

describe('roll and state integrity', () => {
  it('reuses a roll after a provider failure and prevents a changed-DC reroll', async () => {
    let fail = true;
    const values: number[] = [];
    const f = fixture({
      resolve: async (ctx, roll) => {
        if (!ctx.turn.number) return outcome();
        const check: Check = {
          memberId: ctx.members[0].id,
          stat: 'INT',
          dc: 10,
          reason: 'Inspect the gate.',
          mode: 'normal',
          lethal: false,
        };
        const r = roll(check);
        values.push(r.total);
        expect(() => roll({ ...check, dc: 15 })).toThrow('locked');
        if (fail) throw new Error('Provider interrupted.');
        return outcome({
          changes: [{ type: 'hp', memberId: check.memberId, amount: -1, reason: 'A scrape at the gate.' }],
        });
      },
    });
    const turn = await start(f);
    submitBoth(f, turn.id);
    await f.game.idle();
    expect(f.game.snapshot(f.c.id, f.host.id).turn?.phase).toBe('failed');
    expect(f.draw).toHaveBeenCalledTimes(1);
    fail = false;
    f.game.retry(f.c.id, f.host.id);
    await f.game.idle();
    expect(values).toEqual([12, 12]);
    expect(f.draw).toHaveBeenCalledTimes(1);
    expect(f.game.members(f.c.id)[0].state.hp).toBe(19);
  });
  it('rolls back the entire turn if an inventory mutation is invalid', async () => {
    const f = fixture({
      resolve: async (ctx) =>
        !ctx.turn.number
          ? outcome()
          : outcome({
              changes: [
                { type: 'hp', memberId: ctx.members[0].id, amount: -4, reason: 'A trap.' },
                {
                  type: 'item',
                  memberId: ctx.members[0].id,
                  name: 'Nonexistent potion',
                  amount: -1,
                  reason: 'Drink it.',
                },
              ],
            }),
    });
    const turn = await start(f);
    submitBoth(f, turn.id);
    await f.game.idle();
    expect(f.game.members(f.c.id)[0].state.hp).toBe(20);
    expect(f.game.snapshot(f.c.id, f.host.id).history).toHaveLength(1);
    expect(f.game.snapshot(f.c.id, f.host.id).turn?.phase).toBe('failed');
  });
  it('enforces aggregate HP limits rather than allowing repeated small mutations', async () => {
    const f = fixture({
      resolve: async (ctx) =>
        !ctx.turn.number
          ? outcome()
          : outcome({
              changes: [1, 2].map(() => ({
                type: 'hp' as const,
                memberId: ctx.members[0].id,
                amount: -4,
                reason: 'A trap.',
              })),
            }),
    });
    const turn = await start(f);
    submitBoth(f, turn.id);
    await f.game.idle();
    expect(f.game.members(f.c.id)[0].state.hp).toBe(20);
  });
  it('isolates campaign instances from the library and other campaigns', async () => {
    const f = fixture({
      resolve: async (ctx) =>
        !ctx.turn.number
          ? outcome()
          : outcome({
              changes: [{ type: 'hp', memberId: ctx.members[0].id, amount: -3, reason: 'A scrape.' }],
            }),
    });
    const other = f.game.create(f.host.id, config);
    f.game.join(other.inviteCode!, f.p1.id, f.c1.id);
    const turn = await start(f);
    submitBoth(f, turn.id);
    await f.game.idle();
    expect(f.game.members(f.c.id)[0].state.hp).toBe(17);
    expect(f.game.members(other.id)[0].state.hp).toBe(20);
    expect(f.game.characters(f.p1.id)[0].name).toBe('Mira');
  });
  it('rejects invalid character builds and cross-campaign ownership', () => {
    const f = fixture();
    const sheet = templateCharacter();
    sheet.stats.INT = 100;
    expect(() => f.game.saveCharacter(f.p1.id, sheet)).toThrow();
    expect(() => f.game.requireHost(f.c.id, f.p1.id)).toThrow();
    const stranger = f.game.identify();
    expect(() => f.game.canRead(f.c.id, stranger.id)).toThrow();
    expect(() => f.game.join(f.c.inviteCode!, stranger.id, f.c1.id)).toThrow();
    expect(f.game.snapshot(f.c.id, f.p1.id)).not.toHaveProperty('displayToken');
  });
  it('persists pending actions and completed history across host restarts', async () => {
    const filename = join(mkdtempSync(join(tmpdir(), 'gather-db-')), 'test.sqlite');
    const f = fixture(undefined, filename);
    const turn = await start(f);
    f.game.submit(f.c.id, f.p1.id, turn.id, 'Remember this action.', false);
    f.db.close();
    const db = openDatabase(filename);
    cleanup.push(() => db.close());
    const game = new Game(db, () => ({ resolve: async () => outcome() }));
    const restored = game.snapshot(f.c.id, f.host.id);
    expect(restored.turn?.actions[0].text).toBe('Remember this action.');
    expect(restored.history).toHaveLength(1);
    expect(restored.config.custom[0].value).toBe('9999');
    expect(game.identify(f.p1.token).id).toBe(f.p1.id);
  });
  it('marks interrupted resolutions recoverable without discarding dice receipts', async () => {
    const filename = join(mkdtempSync(join(tmpdir(), 'gather-recovery-')), 'test.sqlite');
    const f = fixture(undefined, filename);
    const turn = await start(f);
    f.db.prepare("UPDATE turns SET phase = 'resolving' WHERE id = ?").run(turn.id);
    f.db
      .prepare('INSERT INTO actions(turn_id, member_id, text, passed) VALUES(?, ?, ?, 0)')
      .run(turn.id, turn.roster[0], 'Try the gate');
    f.game.roll(f.c.id, turn.id, {
      memberId: turn.roster[0],
      stat: 'DEX',
      dc: 10,
      mode: 'normal',
      lethal: false,
      reason: 'Try the gate',
    });
    f.db.close();
    const db = openDatabase(filename);
    cleanup.push(() => db.close());
    const game = new Game(db, () => ({ resolve: async () => outcome() }));
    const restored = game.snapshot(f.c.id, f.host.id);
    expect(restored.turn?.phase).toBe('failed');
    expect(restored.turn?.rolls).toHaveLength(1);
  });
});

describe('roguelike multiplayer lifecycle', () => {
  it('enforces equipment choices and pauses each level-up for a generated reward', async () => {
    const f = fixture({ resolve: async (ctx) => outcome({ xp: ctx.turn.number ? 40 : 0 }) });
    let turn = await start(f);
    for (let i = 0; i < 3; i++) {
      submitBoth(f, turn.id);
      await f.game.idle();
      turn = f.game.snapshot(f.c.id, f.host.id).turn!;
    }
    expect(f.game.members(f.c.id)[0].state).toMatchObject({
      level: 2,
      xp: 20,
      pendingLevelUps: 1,
      maxHp: 25,
    });
    expect(() => f.game.submit(f.c.id, f.p1.id, turn.id, 'Continue', false)).toThrow('Choose');
    f.draw.mockReturnValue(1);
    await f.game.levelUp(f.c.id, f.p1.id, 'attributes');
    f.game.submit(f.c.id, f.p1.id, turn.id, 'Continue', false);
    expect(f.game.snapshot(f.c.id, f.host.id).turn?.phase).toBe('collecting');
  });
  it('requires a prior warning and player acceptance for lethal checks, with irreversible death', async () => {
    let accepted = false;
    const f = fixture({
      resolve: async (ctx, tools) => {
        if (!ctx.turn.number) return outcome({ lethalWarning: 'A fall here is fatal.' });
        for (const m of ctx.members) {
          const check: Check = {
            memberId: m.id,
            stat: 'DEX',
            dc: 20,
            reason: 'Cross the chasm',
            mode: 'normal',
            lethal: true,
          };
          if (!accepted) {
            expect(() => tools(check)).toThrow('explicitly accepted');
          } else tools(check);
        }
        return outcome();
      },
    });
    const turn = await start(f);
    f.draw.mockReturnValue(1);
    accepted = true;
    f.game.submit(f.c.id, f.p1.id, turn.id, 'Cross', false, true);
    f.game.submit(f.c.id, f.p2.id, turn.id, 'Cross', false, true);
    await f.game.idle();
    const s = f.game.snapshot(f.c.id, f.host.id);
    expect(s.status).toBe('ended');
    expect(s.turn).toBeNull();
    expect(s.members.every((m) => m.state.hp === 0)).toBe(true);
    expect(() =>
      f.game.manageCharacter(f.c.id, f.p1.id, { type: 'heal', itemId: s.members[0].state.inventory[0].id }),
    ).toThrow('run has ended');
    expect(f.game.characters(f.p1.id)).toHaveLength(1);
  });
  it('rejects unaccepted lethal checks and excludes dead characters while survivors continue', async () => {
    const f = fixture({
      resolve: async (ctx, tools) => {
        if (!ctx.turn.number) return outcome({ lethalWarning: 'The ledge may collapse.' });
        const first = ctx.members[0];
        const check: Check = {
          memberId: first.id,
          stat: 'DEX',
          dc: 20,
          reason: 'Jump',
          mode: 'normal',
          lethal: true,
        };
        expect(() => tools({ ...check, memberId: ctx.members[1].id })).toThrow('explicitly accepted');
        tools(check);
        return outcome();
      },
    });
    const turn = await start(f);
    f.draw.mockReturnValue(1);
    f.game.submit(f.c.id, f.p1.id, turn.id, 'Jump', false, true);
    f.game.submit(f.c.id, f.p2.id, turn.id, 'Stay', false);
    await f.game.idle();
    const s = f.game.snapshot(f.c.id, f.host.id);
    expect(s.status).toBe('active');
    expect(s.turn?.roster).toEqual([s.members[1].id]);
    expect(s.members[0].state.hp).toBe(0);
  });
  it('commits combat damage, XP, and physical loot only once after a provider interruption', async () => {
    let fail = true;
    const f = fixture({
      resolve: async (ctx, tools) => {
        if (!ctx.turn.number) return outcome();
        if (ctx.turn.number === 1) {
          tools.startCombat([
            {
              id: 'custom-enemy',
              name: 'User-world adversary',
              tier: 'normal',
              hp: 1,
              defense: 5,
              attack: 0,
              damage: '1d4',
              description: 'Custom',
              tactic: 'Defend',
            },
          ]);
          return outcome();
        }
        tools.combat({
          actions: ctx.turn.actions.map((a) => ({
            memberId: a.memberId,
            main: 'attack',
            targetId: 'custom-enemy',
            stat: 'STR',
            description: a.text,
            minor: 'none',
            minorItemId: null,
            minorSlot: null,
          })),
          enemyTargets: [],
          loot: {
            name: 'A unique user-world prize',
            kind: 'helmet',
            scaling: [],
            hands: 1,
            light: false,
            description: 'Custom loot.',
          },
        });
        if (fail) throw new Error('Interrupted after combat.');
        return outcome();
      },
    });
    f.draw.mockImplementation(() => 4);
    let turn = await start(f);
    submitBoth(f, turn.id);
    await f.game.idle();
    turn = f.game.snapshot(f.c.id, f.host.id).turn!;
    f.draw.mockImplementation(() => 6);
    submitBoth(f, turn.id);
    await f.game.idle();
    const draws = f.draw.mock.calls.length;
    expect(f.game.snapshot(f.c.id, f.host.id).turn?.phase).toBe('failed');
    expect(f.game.members(f.c.id)[0].state.xp).toBe(0);
    fail = false;
    f.game.retry(f.c.id, f.host.id);
    await f.game.idle();
    const s = f.game.snapshot(f.c.id, f.host.id);
    expect(s.turn?.phase).toBe('collecting');
    expect(s.scene.loot).toHaveLength(1);
    expect(s.scene.loot[0].name).toBe('A unique user-world prize');
    expect(s.members[0].state.xp).toBe(30);
    expect(f.draw.mock.calls).toHaveLength(draws);
  });
  it('lets a player explicitly take shared loot and prevents another player duplicating it', async () => {
    const f = fixture({
      resolve: async (ctx, tools) => {
        if (ctx.turn.number)
          tools.offerLoot({
            item: {
              name: 'User-defined treasure',
              kind: 'relic',
              scaling: [],
              hands: 1,
              light: false,
              description: 'A keepsake',
            },
            reason: 'Found after searching',
          });
        return outcome();
      },
    });
    const turn = await start(f);
    submitBoth(f, turn.id);
    await f.game.idle();
    const item = f.game.snapshot(f.c.id, f.host.id).scene.loot[0];
    expect(f.game.members(f.c.id)[0].state.inventory.some((i) => i.id === item.id)).toBe(false);
    f.game.manageCharacter(f.c.id, f.p1.id, { type: 'take', itemId: item.id });
    expect(() => f.game.manageCharacter(f.c.id, f.p2.id, { type: 'take', itemId: item.id })).toThrow(
      'no longer available',
    );
  });
  it('recovers a collecting turn after the entire party sits out', async () => {
    const f = fixture();
    const turn = await start(f);
    const members = f.game.members(f.c.id);
    for (const m of members) f.game.setActive(f.c.id, f.host.id, m.id, false);
    expect(f.game.snapshot(f.c.id, f.host.id).turn?.roster).toEqual([]);
    f.game.setActive(f.c.id, f.host.id, members[0].id, true);
    f.game.submit(f.c.id, f.p1.id, turn.id, 'Return', false);
    await f.game.idle();
    expect(f.game.snapshot(f.c.id, f.host.id).turn?.number).toBe(2);
  });
});

it('rewards a noncombat boss equivalent once and waits for level-up choices', async () => {
  const f = fixture({
    resolve: async (ctx, tools) => {
      if (!ctx.turn.number) return outcome();
      const memberId = ctx.members[0].id;
      tools({
        memberId,
        stat: 'INT',
        dc: 15,
        reason: 'Resolve the floor trial',
        mode: 'normal',
        lethal: false,
      });
      tools.completeChallenge({
        memberId,
        reason: 'The party negotiates a lasting settlement.',
        bossEquivalent: true,
      });
      return outcome();
    },
  });
  f.draw.mockReturnValue(18);
  const turn = await start(f);
  submitBoth(f, turn.id);
  await f.game.idle();
  const s = f.game.snapshot(f.c.id, f.host.id);
  expect(s.scene.floor.cleared).toBe(true);
  expect(s.members[0].state).toMatchObject({ level: 2, pendingLevelUps: 1, bosses: 1 });
  expect(() => f.game.submit(f.c.id, f.p1.id, s.turn!.id, 'Next floor', false)).toThrow('Choose');
});

it('does not award a floor challenge to a late arrival outside the frozen roster', async () => {
  const f = fixture({
    resolve: async (ctx, tools) => {
      if (!ctx.turn.number) return outcome();
      const memberId = ctx.members[0].id;
      tools({ memberId, stat: 'INT', dc: 15, reason: 'Finish the trial', mode: 'normal', lethal: false });
      const receipt = tools.completeChallenge({
        memberId,
        reason: 'The trial is overcome.',
        bossEquivalent: true,
      }) as { xp: number; members: unknown[] };
      expect(receipt.xp).toBe(100);
      expect(receipt.members).toHaveLength(2);
      return outcome();
    },
  });
  f.draw.mockReturnValue(18);
  const turn = await start(f);
  const late = f.game.identify();
  const sheet = f.game.saveCharacter(late.id, templateCharacter('Late arrival'));
  f.game.join(f.c.inviteCode!, late.id, sheet.id);
  submitBoth(f, turn.id);
  await f.game.idle();
  const m = f.game.members(f.c.id).find((m) => m.playerId === late.id)!;
  expect(m.state).toMatchObject({ level: 1, xp: 0, pendingLevelUps: 0, bosses: 0 });
});

it.each(['new-combat', 'new-utility', 'upgrade-combat', 'upgrade-utility', 'attributes'] as const)(
  'generates and saves the %s reward once, using server dice and leaving the reusable template intact',
  async (choice) => {
    const levelUp = vi.fn(new PracticeGM().levelUp);
    const f = fixture({ resolve: async () => outcome(), levelUp });
    await start(f);
    const before = f.game.members(f.c.id)[0];
    before.state.pendingLevelUps = 2;
    before.character.abilities.push({ ...before.character.abilities[0], name: 'Second combat technique' });
    f.db
      .prepare('UPDATE members SET sheet = ?, state = ? WHERE id = ?')
      .run(JSON.stringify(before.character), JSON.stringify(before.state), before.id);
    f.draw.mockReturnValue(2);
    await f.game.levelUp(f.c.id, before.playerId, choice);
    const after = f.game.members(f.c.id)[0];
    const context = levelUp.mock.calls[0][0];
    expect(levelUp).toHaveBeenCalledOnce();
    expect(after.state.pendingLevelUps).toBe(1);
    expect(after.state.lastLevelUp).toBeTruthy();
    if (choice === 'attributes') {
      expect(context.attributes).toEqual(['DEX', 'DEX']);
      expect(after.state.stats).toEqual({ STR: 5, DEX: 7, INT: 5 });
      expect(after.character.abilities).toEqual(before.character.abilities);
    } else if (choice.startsWith('upgrade')) {
      expect(context.target?.name).toBe(
        choice === 'upgrade-combat' ? 'Second combat technique' : 'Keen observation',
      );
      expect(after.character.abilities).toHaveLength(3);
      expect(after.character.abilities.find((a) => a.name === context.target!.name)?.level).toBe(2);
      expect(after.character.abilities.filter((a) => a.name !== context.target!.name)).toEqual(
        before.character.abilities.filter((a) => a.name !== context.target!.name),
      );
    } else {
      expect(after.character.abilities).toHaveLength(4);
      expect(after.character.abilities.at(-1)).toMatchObject({
        kind: choice === 'new-combat' ? 'combat' : 'utility',
        level: 1,
      });
    }
    expect(f.game.characters(before.playerId)[0].abilities).toHaveLength(2);
    const restored = new Game(f.db, () => new PracticeGM());
    expect(restored.members(f.c.id)[0]).toEqual(after);
  },
);

it('keeps a reward available after generation fails or returns an invalid reward and prevents double spending', async () => {
  let release!: () => void;
  let fail = true;
  const levelUp = vi.fn(async (context: import('../server/game').LevelUpContext) => {
    if (fail) throw new Error('Provider unavailable');
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return new PracticeGM().levelUp(context);
  });
  const f = fixture({ resolve: async () => outcome(), levelUp });
  await start(f);
  const member = f.game.members(f.c.id)[0];
  member.state.pendingLevelUps = 1;
  f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(member.state), member.id);
  await expect(f.game.levelUp(f.c.id, f.host.id, 'new-combat')).rejects.toThrow('Join');
  await expect(f.game.levelUp(f.c.id, member.playerId, 'new-combat')).rejects.toThrow('Provider unavailable');
  expect(f.game.members(f.c.id)[0]).toEqual(member);
  fail = false;
  const pending = f.game.levelUp(f.c.id, member.playerId, 'new-combat');
  await expect(f.game.levelUp(f.c.id, member.playerId, 'new-utility')).rejects.toThrow('being generated');
  release();
  await pending;
  expect(f.game.members(f.c.id)[0].state.pendingLevelUps).toBe(0);
  await expect(f.game.levelUp(f.c.id, member.playerId, 'new-combat')).rejects.toThrow('No level-up');
});

it('rejects an upgrade in an empty category and invalid provider rewards without spending the reward', async () => {
  const levelUp = vi.fn(async () => ({ ability: null, description: 'Invalid ability reward' }));
  const f = fixture({ resolve: async () => outcome(), levelUp });
  await start(f);
  const member = f.game.members(f.c.id)[0];
  member.state.pendingLevelUps = 1;
  member.character.abilities = [];
  f.db
    .prepare('UPDATE members SET sheet = ?, state = ? WHERE id = ?')
    .run(JSON.stringify(member.character), JSON.stringify(member.state), member.id);
  await expect(f.game.levelUp(f.c.id, member.playerId, 'upgrade-combat')).rejects.toThrow(
    'no current ability',
  );
  expect(levelUp).not.toHaveBeenCalled();
  await expect(f.game.levelUp(f.c.id, member.playerId, 'new-combat')).rejects.toThrow('category and level');
  expect(f.game.members(f.c.id)[0]).toEqual(member);
});

it('migrates existing equipment and pending stat points without resetting a campaign', async () => {
  const filename = join(mkdtempSync(join(tmpdir(), 'gather-migration-')), 'game.db');
  const f = fixture(undefined, filename);
  const member = f.game.members(f.c.id)[0];
  const { equipmentOptions: _options, selectedEquipmentIds: _selected, ...sheet } = member.character;
  const legacySheet = {
    ...sheet,
    weaponOptions: [
      { name: 'Legacy sword', stat: 'STR', description: '' },
      { name: 'Legacy bow', stat: 'DEX', description: '' },
      { name: 'Legacy wand', stat: 'INT', description: '' },
    ],
    abilities: sheet.abilities.map(({ level: _level, ...ability }) => ability),
  };
  const {
    pendingLevelUps: _pending,
    starterEquipment: _starters,
    equipmentChosen: _chosen,
    ...state
  } = member.state;
  const legacyState = { ...state, statPoints: 10, starterWeapons: [], weaponChosen: true };
  f.db
    .prepare('UPDATE members SET sheet = ?, state = ? WHERE id = ?')
    .run(JSON.stringify(legacySheet), JSON.stringify(legacyState), member.id);
  f.db
    .prepare('UPDATE characters SET sheet = ? WHERE id = ?')
    .run(JSON.stringify(legacySheet), member.characterId);
  const unready = f.game.members(f.c.id)[1];
  f.db
    .prepare('UPDATE members SET sheet = ?, state = ? WHERE id = ?')
    .run(JSON.stringify(legacySheet), JSON.stringify({ ...legacyState, weaponChosen: false }), unready.id);
  f.db.pragma('user_version = 4');
  f.db.close();
  const restoredDb = openDatabase(filename);
  cleanup.push(() => restoredDb.close());
  const restored = new Game(restoredDb, () => new PracticeGM()).members(f.c.id)[0];
  expect(restored.character.equipmentOptions).toHaveLength(5);
  expect(restored.character.abilities.every((ability) => ability.level === 1)).toBe(true);
  expect(restored.state.pendingLevelUps).toBe(2);
  expect(restored.state.equipmentChosen).toBe(true);
  expect(restored.state.equipment).toEqual(member.state.equipment);
  expect(restored.state.inventory).toEqual(member.state.inventory);
  const pending = new Game(restoredDb, () => new PracticeGM()).members(f.c.id)[1];
  expect(pending.state.starterEquipment).toHaveLength(5);
  expect(pending.state.starterEquipment.every((item) => item.id.startsWith(`${unready.id}-`))).toBe(true);
});
