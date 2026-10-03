import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/db';
import { baseItem, isDowned, isDead } from '../shared/rules';
import { PracticeGM } from '../server/providers';
import { Game, type GameMaster, type GMContext } from '../server/game';
import {
  templateCharacter,
  combatSchema,
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
  const draw = vi.fn((_sides: number) => 12);
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

it('saves free equipment changes with their turn and includes them once in the summary after a restart and retry', async () => {
  let attempt = 0;
  const filename = join(mkdtempSync(join(tmpdir(), 'gather-equipment-')), 'game.sqlite');
  const f = fixture(
    {
      resolve: async (context) => {
        if (context.turn.number > 0 && ++attempt === 1) throw new Error('Interrupted narration');
        return outcome();
      },
    },
    filename,
  );
  const turn = await start(f);
  const member = f.game.members(f.c.id).find((member) => member.playerId === f.p1.id)!;
  const blade = { ...baseItem('new-blade', 'Moon blade', 'weapon'), hands: 2 as const, quantity: 1 };
  member.state.inventory.push(blade);
  f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(member.state), member.id);
  const changed = f.game.manageCharacter(f.c.id, f.p1.id, { type: 'equip', itemId: blade.id, slot: 'right' });
  expect(changed.turn).toMatchObject({ id: turn.id, phase: 'collecting', actions: [] });
  expect(changed.turn!.equipmentChanges).toEqual([
    {
      memberId: member.id,
      characterName: 'Mira',
      description: 'Equipped Moon blade (both hands). Stowed: Starting weapon 2, Starting weapon 1.',
    },
  ]);
  expect(changed.members.find((member) => member.playerId === f.p1.id)!.state.equipment.left?.id).toBe(
    blade.id,
  );
  expect(() =>
    f.game.manageCharacter(f.c.id, f.p1.id, { type: 'equip', itemId: 'missing', slot: 'right' }),
  ).toThrow();
  expect(f.game.snapshot(f.c.id, f.p1.id).turn!.equipmentChanges).toHaveLength(1);
  submitBoth(f, turn.id);
  await f.game.idle();
  expect(f.game.snapshot(f.c.id, f.host.id).turn!.phase).toBe('failed');
  f.db.close();
  const reopened = openDatabase(filename);
  cleanup.push(() => reopened.close());
  const contexts: GMContext[] = [];
  const resumed = new Game(
    reopened,
    () => ({
      resolve: async (context) => {
        contexts.push(context);
        return outcome();
      },
    }),
    () => 12,
  );
  resumed.retry(f.c.id, f.host.id);
  await resumed.idle();
  expect(contexts[0].turn.equipmentChanges).toHaveLength(1);
  const completed = resumed.snapshot(f.c.id, f.p1.id);
  const summary = completed.history.at(-1)!.result!.summary;
  expect(summary).toContain('Equipment changes:\nMira: Equipped Moon blade (both hands).');
  expect(summary.match(/Equipped Moon blade/g)).toHaveLength(1);
  expect(completed.turn!.equipmentChanges).toEqual([]);
});

it('records atomic loot swaps, rejects equipment changes in combat, and leaves failed changes unrecorded', async () => {
  const f = fixture();
  const turn = await start(f);
  const snapshot = f.game.snapshot(f.c.id, f.p1.id);
  const member = snapshot.members.find((member) => member.playerId === f.p1.id)!;
  const drop = member.state.inventory[0];
  snapshot.scene.loot.push({ ...baseItem('boots', 'Iron boots', 'boots'), quantity: 1 });
  f.db.prepare('UPDATE campaigns SET scene = ? WHERE id = ?').run(JSON.stringify(snapshot.scene), f.c.id);
  const changed = f.game.manageCharacter(f.c.id, f.p1.id, {
    type: 'take-equip',
    itemId: 'boots',
    slot: 'boots',
    dropItemIds: [drop.id],
  });
  expect(changed.turn!.equipmentChanges![0].description).toBe(
    `Equipped Iron boots (feet). Dropped: ${drop.name} ×1.`,
  );
  expect(changed.scene.loot.some((item) => item.id === drop.id)).toBe(true);
  const scene = changed.scene;
  scene.encounter = { enemies: [], round: 1, initiative: [], victory: false, escaped: false };
  f.db.prepare('UPDATE campaigns SET scene = ? WHERE id = ?').run(JSON.stringify(scene), f.c.id);
  for (const action of [
    { type: 'equip', itemId: 'boots', slot: 'boots' as const },
    { type: 'unequip', slot: 'boots' as const },
    { type: 'take-equip', itemId: drop.id, slot: 'right' as const },
  ]) {
    expect(() => f.game.manageCharacter(f.c.id, f.p1.id, action)).toThrow('outside combat');
  }
  expect(f.game.snapshot(f.c.id, f.p1.id).turn).toMatchObject({
    id: turn.id,
    phase: 'collecting',
    actions: [],
  });
  expect(f.game.snapshot(f.c.id, f.p1.id).turn!.equipmentChanges).toHaveLength(1);
});

describe('downing and allied recovery', () => {
  async function downFirst(impact = 12, failsCritically = false, invalidFloor = false) {
    const contexts: GMContext[] = [];
    let corrected = false;
    const f = fixture({
      resolve: async (ctx, tools) => {
        contexts.push(structuredClone(ctx));
        if (ctx.turn.number !== 1) return outcome();
        const member = ctx.members.find((member) => member.character.name === 'Mira')!;
        if (failsCritically)
          tools({
            memberId: member.id,
            stat: 'DEX',
            dc: 10,
            reason: 'Dodge the trap.',
            mode: 'normal',
            lethal: false,
          });
        return outcome({
          changes: [
            ...(corrected
              ? [
                  {
                    type: 'condition' as const,
                    memberId: member.id,
                    name: 'Weakened',
                    remove: false,
                    reason: 'A lingering injury.',
                  },
                ]
              : []),
            { type: 'hp', memberId: member.id, amount: -2, reason: 'A falling stone.' },
          ],
          nextFloor:
            invalidFloor && !corrected
              ? { biome: 'Invalid floor', atmosphere: 'Too soon.', hazard: '' }
              : null,
        });
      },
    });
    const first = f.game.members(f.c.id)[0];
    first.state.hp = 1;
    f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(first.state), first.id);
    const turn = await start(f);
    f.draw.mockReturnValue(impact);
    submitBoth(f, turn.id);
    await f.game.idle();
    return {
      ...f,
      contexts,
      correctOutcome: () => {
        corrected = true;
      },
    };
  }

  it('downs ordinary lethal environmental damage and lets an ally spend their item to restore the turn roster', async () => {
    const f = await downFirst();
    const [downed, healer] = f.game.members(f.c.id);
    expect(isDowned(downed.state)).toBe(true);
    expect(downed.state.deathReason).toBeNull();
    expect(f.game.snapshot(f.c.id, f.host.id).history.at(-1)!.result!.narration).toContain(
      'Mira is downed at 0 HP.',
    );
    expect(f.game.snapshot(f.c.id, f.host.id).turn!.roster).toEqual([healer.id]);
    expect(() => f.game.queueReplacement(f.c.id, downed.playerId, f.c1.id)).toThrow('fallen');
    expect(() =>
      f.game.manageCharacter(f.c.id, downed.playerId, { type: 'heal', itemId: downed.state.inventory[0].id }),
    ).toThrow();
    const item = healer.state.inventory.find((item) => item.healing > 0)!;
    f.game.manageCharacter(f.c.id, healer.playerId, { type: 'heal', itemId: item.id, targetId: downed.id });
    const restored = f.game.members(f.c.id)[0];
    expect(restored.state.hp).toBe(item.healing);
    expect(isDowned(restored.state)).toBe(false);
    expect(f.game.members(f.c.id)[1].state.inventory.some((entry) => entry.id === item.id)).toBe(false);
    expect(f.game.snapshot(f.c.id, f.host.id).turn!.roster).toContain(downed.id);
    const turn = f.game.snapshot(f.c.id, f.host.id).turn!;
    submitBoth(f, turn.id);
    await f.game.idle();
    expect(f.game.snapshot(f.c.id, f.host.id).turn!.number).toBe(3);
  });

  it('uses a saved Mend ability outside combat to revive an ally and records its use and roll', async () => {
    const f = await downFirst();
    const [downed, healer] = f.game.members(f.c.id);
    const ability = {
      ...healer.character.abilities[0],
      name: 'Field mend',
      effect: 'mend' as const,
      stat: 'INT' as const,
    };
    healer.character.abilities.push(ability);
    f.db
      .prepare('UPDATE members SET sheet = ? WHERE id = ?')
      .run(JSON.stringify(healer.character), healer.id);
    f.draw.mockReturnValue(4);
    const restored = f.game.manageCharacter(f.c.id, healer.playerId, {
      type: 'heal',
      abilityName: ability.name,
      targetId: downed.id,
    });
    expect(restored.members[0].state.hp).toBe(4);
    expect(restored.members[1].state.abilityUses?.[ability.name]).toBe(1);
    expect(restored.turn!.rolls.at(-1)).toMatchObject({ memberId: healer.id, dice: [4], notation: 'd6' });
    expect(() =>
      f.game.manageCharacter(f.c.id, healer.playerId, {
        type: 'heal',
        abilityName: ability.name,
        targetId: downed.id,
      }),
    ).toThrow();
    expect(f.draw).toHaveBeenCalledTimes(2);
  });

  it('kills only on critical environmental impact or player critical failure and prevents allied corpse healing', async () => {
    for (const [impact, failsCritically] of [
      [20, false],
      [1, true],
    ] as const) {
      const f = await downFirst(impact, failsCritically);
      const [fallen, healer] = f.game.members(f.c.id);
      expect(isDead(fallen.state)).toBe(true);
      expect(fallen.state.deathReason).toBe('A falling stone.');
      expect(f.game.snapshot(f.c.id, f.host.id).history.at(-1)!.result!.narration).toContain(
        'Mira dies: A falling stone.',
      );
      expect(f.draw).toHaveBeenCalledTimes(1);
      const item = healer.state.inventory.find((item) => item.healing > 0)!;
      expect(() =>
        f.game.manageCharacter(f.c.id, healer.playerId, {
          type: 'heal',
          itemId: item.id,
          targetId: fallen.id,
        }),
      ).toThrow('dead');
      expect(f.game.members(f.c.id)[1].state.inventory).toEqual(healer.state.inventory);
    }
  });

  it('includes downed allies in GM context without requiring their submissions', async () => {
    const f = await downFirst();
    const [downed, healer] = f.game.members(f.c.id);
    const row = f.game.snapshot(f.c.id, f.host.id).turn!;
    f.game.submit(f.c.id, healer.playerId, row.id, 'Watch over Mira.', false);
    await f.game.idle();
    const snapshot = f.game.snapshot(f.c.id, f.host.id);
    expect(snapshot.turn!.number).toBe(3);
    expect(snapshot.turn!.roster).toEqual([healer.id]);
    expect(isDowned(snapshot.members.find((member) => member.id === downed.id)!.state)).toBe(true);
    expect(f.contexts.at(-1)!.members.map((member) => member.id)).toContain(downed.id);
    expect(f.contexts.at(-1)!.turn.actions.map((action) => action.memberId)).toEqual([healer.id]);
  });

  it('keeps lethal-impact dice locked when a failed commit is retried with reordered narrative changes', async () => {
    const f = await downFirst(12, false, true);
    const failed = f.game.snapshot(f.c.id, f.host.id).turn!;
    expect(failed.phase).toBe('failed');
    expect(failed.rolls).toHaveLength(1);
    expect(f.game.members(f.c.id)[0].state.hp).toBe(1);
    f.draw.mockReturnValue(20);
    f.correctOutcome();
    f.game.retry(f.c.id, f.host.id);
    await f.game.idle();
    expect(f.game.snapshot(f.c.id, f.host.id).history.at(-1)!.rolls[0].dice).toEqual([12]);
    expect(f.draw).toHaveBeenCalledTimes(1);
    expect(isDowned(f.game.members(f.c.id)[0].state)).toBe(true);
  });

  it('retains a recovered ally in combat narration context and restores their next-turn roster', async () => {
    const contexts: GMContext[] = [];
    const f = fixture({
      resolve: async (ctx) => {
        contexts.push(structuredClone(ctx));
        return outcome();
      },
    });
    const turn = await start(f);
    const [downed, healer] = f.game.members(f.c.id);
    downed.state.hp = 0;
    downed.state.conditions.push('Downed');
    f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(downed.state), downed.id);
    f.db.prepare('UPDATE turns SET roster = ? WHERE id = ?').run(JSON.stringify([healer.id]), turn.id);
    const scene = f.game.snapshot(f.c.id, f.host.id).scene;
    scene.encounter = {
      enemies: [
        {
          id: 'foe',
          name: 'Gatekeeper',
          tier: 'normal',
          hp: 30,
          maxHp: 30,
          initiative: 1,
          attack: 0,
          defense: 10,
          damage: '1d4',
          onHit: null,
          description: '',
          tactic: '',
        },
      ],
      round: 1,
      initiative: [
        { id: healer.id, total: 15 },
        { id: downed.id, total: 10 },
      ],
      victory: false,
      escaped: false,
    };
    f.db.prepare('UPDATE campaigns SET scene = ? WHERE id = ?').run(JSON.stringify(scene), f.c.id);
    f.game.submit(f.c.id, healer.playerId, turn.id, 'Heal Mira with my healing item', false);
    await f.game.idle();
    const narration = contexts.at(-1)!;
    expect(narration.members.find((member) => member.id === downed.id)!.state.hp).toBeGreaterThan(0);
    expect(narration.combatResult!.characters.map((member) => member.id)).toContain(downed.id);
    expect(f.game.snapshot(f.c.id, f.host.id).turn!.roster).toContain(downed.id);
  });
});

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
  it('resolves an unannounced lethal action successfully in the submitted turn', async () => {
    const checks: unknown[] = [];
    const f = fixture({
      resolve: async (ctx, tools) => {
        if (!ctx.turn.number) return outcome({ lethalWarning: 'Accept the risk before crossing the chasm.' });
        checks.push(
          tools({
            memberId: ctx.members[0].id,
            stat: 'DEX',
            dc: 20,
            reason: 'Cross the chasm',
            mode: 'normal',
            lethal: true,
          }),
        );
        return outcome();
      },
    });
    const turn = await start(f);
    expect(f.game.snapshot(f.c.id, f.host.id).scene.lethalWarning).toBeNull();
    expect(f.game.snapshot(f.c.id, f.host.id).history[0].result?.lethalWarning).toBeNull();
    f.draw.mockReturnValue(20);
    f.game.submit(f.c.id, f.p1.id, turn.id, 'Cross the chasm', false);
    f.game.submit(f.c.id, f.p2.id, turn.id, 'Stay safely on shore', false);
    await f.game.idle();
    const s = f.game.snapshot(f.c.id, f.host.id);
    expect(s.status).toBe('active');
    expect(s.history.at(-1)?.id).toBe(turn.id);
    expect(s.history.at(-1)?.rolls[0]).toMatchObject({
      lethal: true,
      success: true,
      critical: 'success',
      dice: [20],
    });
    expect(s.turn?.number).toBe(turn.number + 1);
    expect(s.members.every((m) => m.state.hp > 0)).toBe(true);
    expect(checks).toHaveLength(1);
    expect(f.draw).toHaveBeenCalledTimes(1);
  });
  it('preserves an unannounced lethal natural-one death through a failed narration and receipt retry', async () => {
    let fail = true;
    const checks: unknown[] = [];
    const f = fixture({
      resolve: async (ctx, tools) => {
        if (!ctx.turn.number) return outcome();
        const first = ctx.members[0];
        const check: Check = {
          memberId: first.id,
          stat: 'DEX',
          dc: 20,
          reason: 'Jump',
          mode: 'normal',
          lethal: true,
        };
        checks.push(tools(check));
        expect(() => tools({ ...check, lethal: false })).toThrow('already locked');
        if (fail) throw new Error('Narration interrupted after the fatal check.');
        return outcome();
      },
    });
    const turn = await start(f);
    f.draw.mockReturnValue(1);
    expect(f.game.snapshot(f.c.id, f.host.id).scene.lethalWarning).toBeNull();
    f.game.submit(f.c.id, f.p1.id, turn.id, 'Jump', false);
    f.game.submit(f.c.id, f.p2.id, turn.id, 'Stay', false);
    await f.game.idle();
    const failed = f.game.snapshot(f.c.id, f.host.id).turn!;
    expect(failed.phase).toBe('failed');
    expect(failed.rolls[0]).toMatchObject({ lethal: true, success: false, critical: 'failure', dice: [1] });
    const draft = f.db.prepare('SELECT draft FROM turns WHERE id = ?').get(turn.id) as { draft: string };
    expect(JSON.parse(draft.draft).members[0].state.hp).toBe(0);
    expect(f.draw).toHaveBeenCalledTimes(1);
    fail = false;
    f.draw.mockReturnValue(20);
    f.game.retry(f.c.id, f.host.id);
    await f.game.idle();
    const s = f.game.snapshot(f.c.id, f.host.id);
    expect(s.status).toBe('active');
    expect(s.turn?.roster).toEqual([s.members[1].id]);
    expect(s.members[0].state.hp).toBe(0);
    expect(s.members[0].state.deathReason).toBe('Catastrophic failure: Jump');
    expect(checks[1]).toEqual(checks[0]);
    expect(f.draw).toHaveBeenCalledTimes(1);
    expect(s.history.at(-1)?.rolls).toHaveLength(1);
    expect(() =>
      f.game.manageCharacter(f.c.id, f.p1.id, {
        type: 'heal',
        itemId: s.members[0].state.inventory[0].id,
      }),
    ).toThrow('run has ended');
  });
  it('commits combat damage, XP, and physical loot only once after a provider interruption', async () => {
    let fail = true;
    const planCombat = vi.fn(async (ctx: GMContext) =>
      combatSchema.parse({
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
      }),
    );
    const f = fixture({
      planCombat,
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
        expect(ctx.combatResult?.encounter.victory).toBe(true);
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
    expect(planCombat).toHaveBeenCalledTimes(1);
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
  f.db.exec('ALTER TABLE actions DROP COLUMN ability_name');
  f.db.exec('ALTER TABLE members DROP COLUMN replacement');
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

it('applies a selected utility ability and equipped relic, then preserves dice and the single use through retry and reload', async () => {
  const receipts: import('../shared/schema').Roll[] = [];
  let fail = true;
  const f = fixture({
    resolve: async (ctx, tools) => {
      if (!ctx.turn.number) return outcome();
      const action = ctx.turn.actions.find((action) => !action.passed)!;
      receipts.push(
        tools({
          memberId: action.memberId,
          stat: 'INT',
          dc: 15,
          reason: action.text,
          mode: 'normal',
          lethal: false,
          abilityName: action.abilityName,
        }),
      );
      if (fail) throw new Error('Provider interrupted after the roll');
      return outcome();
    },
  });
  const turn = await start(f);
  const member = f.game.members(f.c.id)[0];
  const ability = member.character.abilities.find((ability) => ability.kind === 'utility')!;
  ability.level = 2;
  member.state.stats.INT = 7;
  member.state.equipment.left = {
    ...baseItem('relic', 'Remembered oath', 'relic'),
    scaling: ['INT'],
    checkBonus: 1,
  };
  f.db
    .prepare('UPDATE members SET sheet = ?, state = ? WHERE id = ?')
    .run(JSON.stringify(member.character), JSON.stringify(member.state), member.id);
  const dice = [4, 12];
  f.draw.mockImplementation(() => dice.shift() ?? 12);
  expect(() =>
    f.game.submit(f.c.id, f.p1.id, turn.id, 'Use something imaginary', false, false, 'Invented ability'),
  ).toThrow('current ability');
  expect(() => f.game.submit(f.c.id, f.p1.id, turn.id, '', true, false, ability.name)).toThrow('Passing');
  f.game.submit(f.c.id, f.p1.id, turn.id, 'Examine the fortifications', false, false, ability.name);
  f.game.submit(f.c.id, f.p2.id, turn.id, '', true);
  await f.game.idle();
  expect(receipts[0]).toMatchObject({
    dice: [4, 12],
    modifier: 3,
    total: 15,
    success: true,
    mode: 'advantage',
    abilityName: ability.name,
  });
  expect(f.game.snapshot(f.c.id, f.host.id).turn!.phase).toBe('failed');
  expect(f.game.members(f.c.id)[0].state.abilityUses?.[ability.name] ?? 0).toBe(0);
  const beforeRetry = f.draw.mock.calls.length;
  fail = false;
  f.game.retry(f.c.id, f.host.id);
  await f.game.idle();
  expect(receipts[1]).toEqual(receipts[0]);
  expect(f.draw.mock.calls.length).toBe(beforeRetry);
  const restored = new Game(f.db, () => new PracticeGM());
  expect(restored.members(f.c.id)[0].state.abilityUses?.[ability.name]).toBe(1);
  const next = f.game.snapshot(f.c.id, f.host.id).turn!;
  expect(() => f.game.submit(f.c.id, f.p1.id, next.id, 'Examine again', false, false, ability.name)).toThrow(
    'already been used',
  );
  const scene = f.game.snapshot(f.c.id, f.host.id).scene;
  scene.safeRest = true;
  f.db.prepare('UPDATE campaigns SET scene = ? WHERE id = ?').run(JSON.stringify(scene), f.c.id);
  f.game.manageCharacter(f.c.id, f.p1.id, { type: 'rest' });
  expect(f.game.members(f.c.id)[0].state.abilityUses?.[ability.name]).toBeUndefined();
  expect(() =>
    f.game.submit(f.c.id, f.p1.id, next.id, 'Use the restored ability', false, false, ability.name),
  ).not.toThrow();
});

it('requires explicit utility selection, rejects the wrong stat, and cancels disadvantage with ability advantage', async () => {
  let memberId = '';
  const f = fixture({
    resolve: async (ctx, tools) => {
      if (!ctx.turn.number) return outcome();
      const action = ctx.turn.actions.find((action) => !action.passed)!;
      const base = {
        memberId: action.memberId,
        stat: 'INT' as const,
        dc: 10 as const,
        reason: 'Observe',
        mode: 'disadvantage' as const,
        lethal: false,
      };
      expect(() => tools(base)).toThrow('exactly the ability selected');
      expect(() => tools({ ...base, stat: 'DEX', abilityName: action.abilityName })).toThrow(
        'saved attribute',
      );
      const result = tools({ ...base, abilityName: action.abilityName });
      expect(result).toMatchObject({ dice: [12], mode: 'normal' });
      memberId = action.memberId;
      return outcome();
    },
  });
  const turn = await start(f);
  const member = f.game.members(f.c.id)[0];
  f.game.submit(
    f.c.id,
    f.p1.id,
    turn.id,
    'Observe the room',
    false,
    false,
    member.character.abilities[1].name,
  );
  f.game.submit(f.c.id, f.p2.id, turn.id, '', true);
  await f.game.idle();
  expect(f.game.snapshot(f.c.id, f.host.id).turn!.phase).toBe('collecting');
  expect(memberId).toBe(member.id);
  expect(f.draw).toHaveBeenCalledTimes(1);
});

it('identifies the selected ability and action when the GM skips its check, then validates saved mechanics on retry', async () => {
  let resolveCheck = false;
  let validationError = '';
  const f = fixture({
    resolve: async (ctx, tools) => {
      if (!ctx.turn.number) return outcome();
      const action = ctx.turn.actions.find((action) => !action.passed)!;
      if (resolveCheck) {
        tools({
          memberId: action.memberId,
          stat: 'INT',
          dc: 10,
          reason: action.text,
          mode: 'normal',
          lethal: false,
          abilityName: action.abilityName,
        });
        expect(() => tools.validateResolution!(outcome())).not.toThrow();
      } else {
        try {
          tools.validateResolution!(outcome());
        } catch (error) {
          validationError = (error as Error).message;
        }
      }
      return outcome();
    },
  });
  const turn = await start(f);
  const member = f.game.members(f.c.id)[0];
  const ability = member.character.abilities[1];
  f.game.submit(f.c.id, f.p1.id, turn.id, 'Read the inscription', false, false, ability.name);
  f.game.submit(f.c.id, f.p2.id, turn.id, '', true);
  await f.game.idle();
  const failed = f.game.snapshot(f.c.id, f.host.id).turn!;
  expect(failed.phase).toBe('failed');
  expect(failed.error).toBe(validationError);
  expect(failed.error).toContain(`Mira · ${ability.name} (INT): "Read the inscription"`);
  expect(f.draw).not.toHaveBeenCalled();
  resolveCheck = true;
  f.game.retry(f.c.id, f.host.id);
  await f.game.idle();
  expect(f.game.snapshot(f.c.id, f.host.id).turn!.phase).toBe('collecting');
  expect(f.game.members(f.c.id)[0].state.abilityUses?.[ability.name]).toBe(1);
  expect(f.draw).toHaveBeenCalledTimes(2);
});

it.each([
  'Use Keen observation to investigate the platform.',
  'I use my ability to investigate the platform.',
])('spends an ability inferred from "%s" exactly once through retry', async (text) => {
  const receipts: import('../shared/schema').Roll[] = [];
  let fail = true;
  const f = fixture({
    resolve: async (ctx, tools) => {
      if (!ctx.turn.number) return outcome();
      const action = ctx.turn.actions.find((action) => !action.passed)!;
      const member = ctx.members.find((member) => member.id === action.memberId)!;
      receipts.push(
        tools({
          memberId: member.id,
          abilityName: member.character.abilities[1].name,
          stat: 'INT',
          dc: 10,
          mode: 'normal',
          lethal: false,
          reason: action.text,
        }),
      );
      if (fail) throw new Error('Interrupted after inferred ability use');
      return outcome();
    },
  });
  const turn = await start(f);
  f.game.submit(f.c.id, f.p1.id, turn.id, text, false);
  f.game.submit(f.c.id, f.p2.id, turn.id, '', true);
  await f.game.idle();
  expect(f.game.snapshot(f.c.id, f.host.id).turn!.phase).toBe('failed');
  expect(receipts[0]).toMatchObject({ abilityName: 'Keen observation', mode: 'advantage', dice: [12, 12] });
  expect(f.game.members(f.c.id)[0].state.abilityUses).toEqual({});
  const draws = f.draw.mock.calls.length;
  fail = false;
  f.game.retry(f.c.id, f.host.id);
  await f.game.idle();
  expect(receipts[1]).toEqual(receipts[0]);
  expect(f.draw.mock.calls.length).toBe(draws);
  expect(f.game.members(f.c.id)[0].state.abilityUses?.['Keen observation']).toBe(1);
  const next = f.game.snapshot(f.c.id, f.host.id).turn!;
  f.game.submit(f.c.id, f.p1.id, next.id, text, false);
  f.game.submit(f.c.id, f.p2.id, next.id, '', true);
  await f.game.idle();
  expect(f.game.snapshot(f.c.id, f.host.id).turn!).toMatchObject({
    phase: 'failed',
    error: expect.stringContaining('already been used'),
  });
  expect(f.draw.mock.calls.length).toBe(draws);
});

it('lets the GM select a relevant saved utility ability before locking a generic request’s check', async () => {
  const f = fixture({
    resolve: async (ctx, tools) => {
      if (!ctx.turn.number) return outcome();
      const [investigator, watcher] = ctx.members;
      const check: Check = {
        memberId: investigator.id,
        abilityName: null,
        stat: 'INT',
        dc: 10,
        mode: 'normal',
        lethal: false,
        reason: 'Investigate the platform.',
      };
      expect(() => tools(check)).toThrow('saved name and stat');
      expect(() => tools({ ...check, abilityName: 'Invented ability' })).toThrow('saved utility ability');
      expect(() => tools({ ...check, abilityName: investigator.character.abilities[0].name })).toThrow(
        'saved utility ability',
      );
      expect(() =>
        tools({ ...check, memberId: watcher.id, abilityName: watcher.character.abilities[1].name }),
      ).toThrow('requested in the player');
      expect(f.draw).not.toHaveBeenCalled();
      expect(f.db.prepare('SELECT * FROM rolls WHERE turn_id = ?').all(ctx.turn.id)).toEqual([]);
      expect(tools({ ...check, abilityName: 'Platform sense', stat: 'DEX' })).toMatchObject({
        abilityName: 'Platform sense',
        stat: 'DEX',
        mode: 'advantage',
        dice: [12, 12],
      });
      return outcome();
    },
  });
  const member = f.game.members(f.c.id)[0];
  member.character.abilities.push({
    ...member.character.abilities[1],
    name: 'Platform sense',
    description: 'Feel the platform’s structural weaknesses.',
    stat: 'DEX',
  });
  f.db.prepare('UPDATE members SET sheet = ? WHERE id = ?').run(JSON.stringify(member.character), member.id);
  const turn = await start(f);
  f.game.submit(f.c.id, f.p1.id, turn.id, 'I use my ability to investigate the platform.', false);
  f.game.submit(f.c.id, f.p2.id, turn.id, 'Watch the road.', false);
  await f.game.idle();
  const result = f.game.snapshot(f.c.id, f.host.id);
  expect(result.turn!.phase).toBe('collecting');
  expect(result.members[0].state.abilityUses).toEqual({ 'Platform sense': 1 });
  expect(result.members[1].state.abilityUses).toEqual({});
  expect(f.draw).toHaveBeenCalledTimes(2);
});

it('consumes one potion from a stack, heals mechanically, and reuses its receipt through retry', async () => {
  const receipts: unknown[] = [];
  let fail = true;
  const f = fixture({
    resolve: async (ctx, tools) => {
      if (!ctx.turn.number) return outcome();
      const action = ctx.turn.actions.find((action) => !action.passed)!;
      const member = ctx.members.find((member) => member.id === action.memberId)!;
      const input = {
        memberId: member.id,
        itemId: member.state.inventory.find((item) => item.healing > 0)!.id,
        abilityName: null,
        targetId: null,
      };
      const receipt = tools.useResource!(input);
      receipts.push(receipt);
      expect(tools.useResource!(input)).toEqual(receipt);
      expect(() => tools.useResource!({ ...input, targetId: ctx.members[1].id })).toThrow();
      expect(() =>
        tools.validateResolution!(
          outcome({ changes: [{ type: 'hp', memberId: member.id, amount: 6, reason: 'The potion.' }] }),
        ),
      ).toThrow();
      if (fail) throw new Error('Interrupted after potion use');
      return outcome();
    },
  });
  const turn = await start(f);
  const member = f.game.members(f.c.id)[0];
  member.state.hp = 10;
  member.state.inventory[0].quantity = 2;
  f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(member.state), member.id);
  f.game.submit(f.c.id, f.p1.id, turn.id, 'Drink a potion.', false);
  f.game.submit(f.c.id, f.p2.id, turn.id, '', true);
  await f.game.idle();
  expect(f.game.snapshot(f.c.id, f.host.id).turn!.phase).toBe('failed');
  expect(f.game.members(f.c.id)[0].state).toMatchObject({ hp: 10, inventory: [{ quantity: 2 }] });
  expect(receipts[0]).toMatchObject({ memberId: member.id, targetId: member.id, restored: 6 });
  fail = false;
  f.game.retry(f.c.id, f.host.id);
  await f.game.idle();
  expect(receipts[1]).toEqual(receipts[0]);
  expect(f.game.snapshot(f.c.id, f.host.id).turn!.phase).toBe('collecting');
  expect(new Game(f.db, () => new PracticeGM()).members(f.c.id)[0].state).toMatchObject({
    hp: 16,
    inventory: [{ id: member.state.inventory[0].id, quantity: 1 }],
  });
  expect(f.draw).not.toHaveBeenCalled();
});

it('rejects narrated potion healing without consuming the owned potion', async () => {
  const f = fixture({
    resolve: async (ctx) =>
      !ctx.turn.number
        ? outcome()
        : outcome({
            changes: [{ type: 'hp', memberId: ctx.members[0].id, amount: 6, reason: 'Drink a potion.' }],
          }),
  });
  const turn = await start(f);
  const member = f.game.members(f.c.id)[0];
  member.state.hp = 10;
  f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(member.state), member.id);
  f.game.submit(f.c.id, f.p1.id, turn.id, 'Drink a potion.', false);
  f.game.submit(f.c.id, f.p2.id, turn.id, '', true);
  await f.game.idle();
  expect(f.game.snapshot(f.c.id, f.host.id).turn!.phase).toBe('failed');
  expect(f.game.members(f.c.id)[0].state).toMatchObject({ hp: 10, inventory: member.state.inventory });
});

it.each(['Drink my potion.', 'Drink my Crimson potion.'])(
  'requires a consumption receipt for "%s" and repairs the omitted use on retry',
  async (text) => {
    let usePotion = false;
    const f = fixture({
      resolve: async (ctx, tools) => {
        if (!ctx.turn.number) return outcome();
        if (usePotion) {
          const [actor, watcher] = ctx.members;
          const input = {
            memberId: actor.id,
            itemId: actor.state.inventory.find((item) => item.name === 'Crimson potion')!.id,
            abilityName: null,
            targetId: null,
          };
          expect(() =>
            tools.useResource!({ ...input, memberId: watcher.id, itemId: watcher.state.inventory[0].id }),
          ).toThrow();
          if (text.includes('Crimson'))
            expect(() =>
              tools.useResource!({
                ...input,
                itemId: actor.state.inventory.find((item) => item.name === 'Azure potion')!.id,
              }),
            ).toThrow();
          const receipt = tools.useResource!(input);
          expect(tools.useResource!(input)).toEqual(receipt);
          expect(receipt).toMatchObject({ restored: 6 });
        }
        return outcome({ narration: 'Mira drank her potion.' });
      },
    });
    const turn = await start(f);
    const member = f.game.members(f.c.id)[0];
    member.state.hp = 10;
    member.state.inventory[0].name = 'Crimson potion';
    member.state.inventory.push({ ...member.state.inventory[0], id: 'azure-potion', name: 'Azure potion' });
    f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(member.state), member.id);
    f.game.submit(f.c.id, f.p1.id, turn.id, text, false);
    f.game.submit(f.c.id, f.p2.id, turn.id, 'Watch the road.', false);
    await f.game.idle();
    expect(f.game.snapshot(f.c.id, f.host.id).turn!).toMatchObject({
      phase: 'failed',
      error: expect.stringContaining('use_resource'),
    });
    expect(f.game.members(f.c.id)[0].state).toMatchObject({ hp: 10, inventory: member.state.inventory });
    usePotion = true;
    f.game.retry(f.c.id, f.host.id);
    await f.game.idle();
    const result = f.game.snapshot(f.c.id, f.host.id);
    expect(result.turn!.phase).toBe('collecting');
    expect(result.members[0].state).toMatchObject({
      hp: 16,
      inventory: [{ id: 'azure-potion', name: 'Azure potion', quantity: 1 }],
    });
    expect(result.members[1].state.inventory).toHaveLength(1);
  },
);

it('requires inferred Mend usage before reviving an ally and repairs its omitted use on retry', async () => {
  let useMend = false;
  const f = fixture({
    resolve: async (ctx, tools) => {
      if (ctx.turn.number === 1)
        return outcome({
          changes: [{ type: 'hp', memberId: ctx.members[0].id, amount: -2, reason: 'A falling stone.' }],
        });
      if (ctx.turn.number === 2 && useMend) {
        const healer = ctx.members.find((member) => member.character.name === 'Rowan')!;
        const target = ctx.members.find((member) => member.character.name === 'Mira')!;
        const input = {
          memberId: healer.id,
          itemId: null,
          abilityName: healer.character.abilities[0].name,
          targetId: target.id,
        };
        const receipt = tools.useResource!(input);
        expect(tools.useResource!(input)).toEqual(receipt);
        expect(receipt).toMatchObject({ targetId: target.id, restored: 4 });
      }
      return outcome();
    },
  });
  const [target, healer] = f.game.members(f.c.id);
  target.state.hp = 1;
  healer.character.abilities[0] = {
    ...healer.character.abilities[0],
    name: 'Field mend',
    effect: 'mend',
    stat: 'INT',
  };
  f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(target.state), target.id);
  f.db.prepare('UPDATE members SET sheet = ? WHERE id = ?').run(JSON.stringify(healer.character), healer.id);
  let turn = await start(f);
  submitBoth(f, turn.id);
  await f.game.idle();
  expect(isDowned(f.game.members(f.c.id)[0].state)).toBe(true);
  f.draw.mockReturnValue(4);
  turn = f.game.snapshot(f.c.id, f.host.id).turn!;
  f.game.submit(f.c.id, f.p2.id, turn.id, 'Use Field mend to help Mira up.', false);
  await f.game.idle();
  expect(f.game.snapshot(f.c.id, f.host.id).turn!).toMatchObject({
    phase: 'failed',
    error: expect.stringContaining('use_resource'),
  });
  expect(isDowned(f.game.members(f.c.id)[0].state)).toBe(true);
  expect(f.game.members(f.c.id)[1].state.abilityUses?.['Field mend']).toBeUndefined();
  useMend = true;
  f.game.retry(f.c.id, f.host.id);
  await f.game.idle();
  const restored = f.game.snapshot(f.c.id, f.host.id);
  expect(restored.turn!.phase).toBe('collecting');
  expect(restored.members[0].state.hp).toBe(4);
  expect(isDowned(restored.members[0].state)).toBe(false);
  expect(restored.members[1].state.abilityUses?.['Field mend']).toBe(1);
  expect(restored.history.at(-1)!.rolls.at(-1)).toMatchObject({
    memberId: healer.id,
    dice: [4],
    notation: 'd6',
  });
  expect(restored.turn!.roster).toContain(target.id);
});

it.each(['Use the cross slash ability on the Gatekeeper.', 'Use my combat ability on the Gatekeeper.'])(
  'uses the combat ability inferred from "%s" despite a conflicting attack plan',
  async (text) => {
    let combatLogs: string[] = [];
    const f = fixture({
      planCombat: async (ctx) => ({
        actions: ctx.turn.actions
          .filter((action) => !action.passed)
          .map((action) => ({ memberId: action.memberId, main: 'attack', targetId: 'foe', stat: 'INT' })),
      }),
      resolve: async (ctx, tools) => {
        if (ctx.turn.number === 1)
          tools.startCombat([
            {
              id: 'foe',
              name: 'Gatekeeper',
              tier: 'normal',
              hp: 60,
              defense: 10,
              attack: 0,
              damage: '1d4',
              description: 'Test foe',
              tactic: 'Guard',
            },
          ]);
        if (ctx.turn.number === 2) combatLogs = ctx.combatResult!.logs;
        return outcome();
      },
    });
    const member = f.game.members(f.c.id)[0];
    member.character.abilities[0].name = 'Cross slash';
    f.db
      .prepare('UPDATE members SET sheet = ? WHERE id = ?')
      .run(JSON.stringify(member.character), member.id);
    f.draw.mockImplementation((sides: number) => Math.min(12, sides));
    let turn = await start(f);
    submitBoth(f, turn.id);
    await f.game.idle();
    turn = f.game.snapshot(f.c.id, f.host.id).turn!;
    f.game.submit(f.c.id, f.p1.id, turn.id, text, false);
    f.game.submit(f.c.id, f.p2.id, turn.id, '', true);
    await f.game.idle();
    const result = f.game.snapshot(f.c.id, f.host.id);
    expect(result.turn!.phase).toBe('collecting');
    expect(result.members[0].state.abilityUses?.['Cross slash']).toBe(1);
    expect(combatLogs.some((line) => line.includes('Cross slash'))).toBe(true);
    expect(result.scene.encounter!.enemies[0].hp).toBe(48);
  },
);

it('executes combat before narration even when the provider has no combat planner', async () => {
  let resolved = false;
  const f = fixture({
    resolve: async (ctx, tools) => {
      if (ctx.turn.number === 1)
        tools.startCombat([
          {
            id: 'foe',
            name: 'Gatekeeper',
            tier: 'normal',
            hp: 60,
            defense: 10,
            attack: 0,
            damage: '1d4',
            description: 'Test foe',
            tactic: 'Guard',
          },
        ]);
      if (ctx.turn.number === 2) {
        expect(ctx.combatResult?.encounter.round).toBe(2);
        expect(ctx.combatResult?.logs.some((line) => line.includes('Mira'))).toBe(true);
        resolved = true;
      }
      return outcome();
    },
  });
  f.draw.mockImplementation((sides: number) => Math.min(12, sides));
  let turn = await start(f);
  submitBoth(f, turn.id);
  await f.game.idle();
  turn = f.game.snapshot(f.c.id, f.host.id).turn!;
  f.game.submit(f.c.id, f.p1.id, turn.id, 'Attack, defend, or use my special ability', false);
  f.game.submit(f.c.id, f.p2.id, turn.id, '', true);
  await f.game.idle();
  expect(f.game.snapshot(f.c.id, f.host.id).turn!.phase).toBe('collecting');
  expect(f.game.snapshot(f.c.id, f.host.id).scene.encounter!.round).toBe(2);
  expect(f.game.members(f.c.id)[0].state.abilityUses).toEqual({});
  expect(resolved).toBe(true);
});

it('preserves movement and roleplay through combat execution despite a conflicting attack plan', async () => {
  const movement = 'Continue deeper trough the shaft, into the next area/room';
  const farewell = 'Cry and kiss the daemonet goodbye before she gets obliterated';
  const f = fixture({
    planCombat: async (context) => ({
      actions: context.turn.actions.map((action) => ({
        memberId: action.memberId,
        main: 'attack',
        targetId: 'foe',
        description: 'Attack with a weapon',
        effect: 'damage',
        minor: 'offhand',
      })),
    }),
    resolve: async (context, tools) => {
      if (context.turn.number === 1)
        tools.startCombat([
          {
            id: 'foe',
            name: 'Daemonette',
            tier: 'normal',
            hp: 60,
            defense: 10,
            attack: 0,
            damage: '1d4',
            description: 'A daemon in the relay chamber',
            tactic: 'Pursue the party',
          },
        ]);
      if (context.combatResult) return new PracticeGM().resolve(context, tools);
      return outcome();
    },
  });
  f.draw.mockImplementation((sides: number) => Math.min(12, sides));
  let turn = await start(f);
  submitBoth(f, turn.id);
  await f.game.idle();
  turn = f.game.snapshot(f.c.id, f.host.id).turn!;
  f.game.submit(f.c.id, f.p1.id, turn.id, movement, false);
  f.game.submit(f.c.id, f.p2.id, turn.id, farewell, false);
  await f.game.idle();

  const snapshot = f.game.snapshot(f.c.id, f.host.id);
  expect(snapshot.turn?.phase).toBe('collecting');
  expect(snapshot.turn?.roster).toHaveLength(2);
  expect(snapshot.scene.encounter?.enemies[0].hp).toBe(60);
  const resolved = snapshot.history.find((entry) => entry.id === turn.id)!;
  expect(resolved.result?.narration).toContain(movement);
  expect(resolved.result?.narration).toContain(farewell);
  expect(resolved.result?.narration).toContain('Daemonette hits');
  expect(resolved.rolls.filter((roll) => turn.roster.includes(roll.memberId))).toEqual([]);
  for (const member of snapshot.members) {
    expect(member.state.abilityUses).toEqual({});
    expect(member.state.conditions).not.toContain('Escaped');
  }
});

it('keeps escaped players acting, recovers saved rosters, and lets them re-engage during combat', async () => {
  const f = fixture({
    planCombat: async (context) => ({
      actions: context.turn.actions.map((action) => ({
        memberId: action.memberId,
        main: 'attack',
        targetId: 'foe',
        reengage: true,
      })),
    }),
    resolve: async (context, tools) => {
      if (context.turn.number === 1)
        tools.startCombat([
          {
            id: 'foe',
            name: 'Gatekeeper',
            tier: 'normal',
            hp: 120,
            defense: 10,
            attack: 0,
            damage: '1d4',
            description: 'A guard in the relay chamber',
            tactic: 'Guard the doorway',
          },
        ]);
      if (context.combatResult) return new PracticeGM().resolve(context, tools);
      return outcome();
    },
  });
  f.draw.mockImplementation((sides: number) => Math.min(12, sides));
  let turn = await start(f);
  submitBoth(f, turn.id);
  await f.game.idle();
  turn = f.game.snapshot(f.c.id, f.host.id).turn!;
  f.game.submit(f.c.id, f.p1.id, turn.id, 'Flee', false);
  f.game.submit(f.c.id, f.p2.id, turn.id, '', true);
  await f.game.idle();

  let snapshot = f.game.snapshot(f.c.id, f.p1.id);
  const escapedId = snapshot.myMemberId!;
  const escapedHp = snapshot.members[0].state.hp;
  expect(snapshot.members[0].state.conditions).toContain('Escaped');
  expect(snapshot.scene.encounter?.escaped).toBe(false);
  expect(snapshot.turn?.roster).toContain(escapedId);
  turn = snapshot.turn!;

  // Reproduce an already saved collecting turn from before the fix.
  f.db
    .prepare('UPDATE turns SET roster = ? WHERE id = ?')
    .run(JSON.stringify(turn.roster.filter((id) => id !== escapedId)), turn.id);
  f.game.resumeQueued();
  expect(f.game.snapshot(f.c.id, f.p1.id).turn?.roster).toContain(escapedId);
  const exploration = 'Keep exploring the next room';
  f.game.submit(f.c.id, f.p1.id, turn.id, exploration, false);
  expect(f.game.snapshot(f.c.id, f.p1.id).turn?.phase).toBe('collecting');
  f.game.submit(f.c.id, f.p2.id, turn.id, '', true);
  await f.game.idle();
  snapshot = f.game.snapshot(f.c.id, f.p1.id);
  expect(snapshot.turn?.phase).toBe('collecting');
  expect(snapshot.members[0].state.conditions).toContain('Escaped');
  expect(snapshot.members[0].state.hp).toBe(escapedHp);
  expect(snapshot.scene.encounter?.enemies[0].hp).toBe(120);
  expect(snapshot.history.at(-1)?.result?.narration).toContain(exploration);

  turn = snapshot.turn!;
  f.game.submit(f.c.id, f.p1.id, turn.id, '', true);
  f.game.submit(f.c.id, f.p2.id, turn.id, '', true);
  await f.game.idle();
  snapshot = f.game.snapshot(f.c.id, f.p1.id);
  expect(snapshot.members[0].state.conditions).toContain('Escaped');
  expect(snapshot.members[0].state.hp).toBe(escapedHp);

  turn = snapshot.turn!;
  f.game.submit(f.c.id, f.p1.id, turn.id, 'I return to the fight.', false);
  f.game.submit(f.c.id, f.p2.id, turn.id, '', true);
  await f.game.idle();
  snapshot = f.game.snapshot(f.c.id, f.p1.id);
  expect(snapshot.turn?.phase).toBe('collecting');
  expect(snapshot.turn?.roster).toContain(escapedId);
  expect(snapshot.members[0].state.conditions).not.toContain('Escaped');
  expect(snapshot.members[0].state.hp).toBeLessThan(escapedHp);
  expect(snapshot.scene.encounter?.enemies[0].hp).toBe(120);
});

it('reuses the saved combat plan, partial rolls and finished receipt after reload and narration failure', async () => {
  const filename = join(mkdtempSync(join(tmpdir(), 'gather-combat-retry-')), 'game.sqlite');
  let failNarration = true;
  const receipts: unknown[] = [];
  const planCombat = vi.fn((context: GMContext) => new PracticeGM().planCombat(context));
  const provider: GameMaster = {
    planCombat,
    resolve: async (context, tools) => {
      if (context.turn.number === 1)
        tools.startCombat([
          {
            id: 'foe',
            name: 'Gatekeeper',
            tier: 'normal',
            hp: 1,
            defense: 5,
            attack: 0,
            damage: '1d4',
            description: 'A test foe',
            tactic: 'Guard',
          },
        ]);
      if (context.combatResult) {
        receipts.push(structuredClone(context.combatResult));
        if (failNarration) throw new Error('Narration interrupted');
      }
      return outcome();
    },
  };
  const f = fixture(provider, filename);
  f.draw.mockImplementation((sides: number) => Math.min(12, sides));
  let turn = await start(f);
  submitBoth(f, turn.id);
  await f.game.idle();
  turn = f.game.snapshot(f.c.id, f.host.id).turn!;
  f.draw
    .mockImplementationOnce(() => 12)
    .mockImplementationOnce(() => {
      throw new Error('Dice connection interrupted');
    });
  f.game.submit(f.c.id, f.p1.id, turn.id, 'Attack the gatekeeper', false);
  f.game.submit(f.c.id, f.p2.id, turn.id, 'Attack', false);
  await f.game.idle();
  const interrupted = f.game.snapshot(f.c.id, f.host.id).turn!;
  expect(interrupted.phase).toBe('failed');
  expect(interrupted.rolls).toHaveLength(1);
  expect(planCombat).toHaveBeenCalledTimes(1);
  f.db.close();
  const restoredDb = openDatabase(filename);
  cleanup.push(() => restoredDb.close());
  const restored = new Game(restoredDb, () => provider, f.draw);
  restored.retry(f.c.id, f.host.id);
  await restored.idle();
  expect(restored.snapshot(f.c.id, f.host.id).turn?.phase).toBe('failed');
  expect(restored.snapshot(f.c.id, f.host.id).turn?.rolls[0].id).toBe(interrupted.rolls[0].id);
  expect(receipts).toHaveLength(1);
  expect(planCombat).toHaveBeenCalledTimes(1);
  expect(restored.members(f.c.id)[0].state.xp).toBe(0);
  const draws = f.draw.mock.calls.length;
  failNarration = false;
  restored.retry(f.c.id, f.host.id);
  await restored.idle();
  const completed = restored.snapshot(f.c.id, f.host.id);
  expect(completed.turn?.phase).toBe('collecting');
  expect(receipts[1]).toEqual(receipts[0]);
  expect(planCombat).toHaveBeenCalledTimes(1);
  expect(f.draw.mock.calls.length).toBe(draws);
  expect(completed.members.map((member) => member.state.xp)).toEqual([30, 30]);
  expect(completed.scene.loot).toHaveLength(1);
  expect(completed.scene.floor.encounters).toBe(1);
});

it('restores utility uses when the party changes floors and combat uses on a new encounter', async () => {
  const f = fixture({
    resolve: async (ctx, tools) => {
      if (!ctx.turn.number) return outcome();
      if (ctx.turn.number === 1)
        return outcome({ nextFloor: { biome: 'Mountain', atmosphere: 'A narrow pass', hazard: '' } });
      tools.startCombat([
        {
          id: 'foe',
          name: 'Gatekeeper',
          tier: 'normal',
          hp: 30,
          defense: 10,
          attack: 0,
          damage: '1d4',
          description: 'Test foe',
          tactic: 'Guard',
        },
      ]);
      return outcome();
    },
  });
  let turn = await start(f);
  const member = f.game.members(f.c.id)[0];
  member.state.abilityUses = Object.fromEntries(
    member.character.abilities.map((ability) => [ability.name, 1]),
  );
  f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(member.state), member.id);
  const scene = f.game.snapshot(f.c.id, f.host.id).scene;
  scene.floor.cleared = true;
  f.db.prepare('UPDATE campaigns SET scene = ? WHERE id = ?').run(JSON.stringify(scene), f.c.id);
  submitBoth(f, turn.id);
  await f.game.idle();
  let after = f.game.members(f.c.id)[0];
  expect(after.state.abilityUses?.[member.character.abilities[1].name]).toBeUndefined();
  expect(after.state.abilityUses?.[member.character.abilities[0].name]).toBe(1);
  turn = f.game.snapshot(f.c.id, f.host.id).turn!;
  submitBoth(f, turn.id);
  await f.game.idle();
  after = f.game.members(f.c.id)[0];
  expect(after.state.abilityUses?.[member.character.abilities[0].name]).toBeUndefined();
  expect(f.game.snapshot(f.c.id, f.host.id).scene.encounter).not.toBeNull();
});

it('uses a normal attack for an unselected ability proposal and saves selected abilities exactly once through retry', async () => {
  let fail = true;
  let stage = 0;
  const planCombat = vi.fn(async (ctx: GMContext) => {
    const action = ctx.turn.actions.find((action) => !action.passed)!;
    const ability = ctx.members.find((member) => member.id === action.memberId)!.character.abilities[0];
    return combatSchema.parse({
      actions: [
        {
          memberId: action.memberId,
          main: 'ability',
          abilityName: ability.name,
          targetId: 'foe',
          stat: 'STR',
          description: action.text,
          minor: 'none',
          minorItemId: null,
        },
      ],
      enemyTargets: [],
      loot: { name: 'Salvage', kind: 'relic', scaling: ['INT'], hands: 1, light: false, description: '' },
    });
  });
  const f = fixture({
    planCombat,
    resolve: async (ctx, tools) => {
      if (!ctx.turn.number) return outcome();
      if (!stage++) {
        tools.startCombat([
          {
            id: 'foe',
            name: 'Gatekeeper',
            tier: 'normal',
            hp: 60,
            defense: 10,
            attack: 0,
            damage: '1d4',
            description: 'Test foe',
            tactic: 'Guard',
          },
        ]);
        return outcome();
      }
      const action = ctx.turn.actions.find((action) => !action.passed)!;
      expect(ctx.combatResult).toBeDefined();
      if (!action.abilityName)
        expect(ctx.members.find((member) => member.id === action.memberId)!.state.abilityUses).toEqual({});
      if (action.abilityName && fail) throw new Error('Provider interrupted after ability use');
      return outcome();
    },
  });
  let turn = await start(f);
  f.draw.mockImplementation((sides: number) => Math.min(12, sides));
  submitBoth(f, turn.id);
  await f.game.idle();
  turn = f.game.snapshot(f.c.id, f.host.id).turn!;
  f.game.submit(f.c.id, f.p1.id, turn.id, 'Attack the gatekeeper', false);
  f.game.submit(f.c.id, f.p2.id, turn.id, '', true);
  await f.game.idle();
  expect(planCombat).toHaveBeenCalledTimes(1);
  turn = f.game.snapshot(f.c.id, f.host.id).turn!;
  const member = f.game.members(f.c.id)[0];
  expect(() =>
    f.game.submit(f.c.id, f.p1.id, turn.id, 'Observe', false, false, member.character.abilities[1].name),
  ).toThrow('current ability');
  f.game.submit(
    f.c.id,
    f.p1.id,
    turn.id,
    'Use focused strike',
    false,
    false,
    member.character.abilities[0].name,
  );
  f.game.submit(f.c.id, f.p2.id, turn.id, '', true);
  await f.game.idle();
  expect(f.game.snapshot(f.c.id, f.host.id).turn!.phase).toBe('failed');
  const draws = f.draw.mock.calls.length;
  fail = false;
  f.game.retry(f.c.id, f.host.id);
  await f.game.idle();
  expect(f.draw.mock.calls.length).toBe(draws);
  expect(planCombat).toHaveBeenCalledTimes(2);
  expect(f.game.members(f.c.id)[0].state.abilityUses?.[member.character.abilities[0].name]).toBe(1);
});

it('adds real powers to existing saved and equipped off-hand items while preserving character selections and progress', () => {
  const filename = join(mkdtempSync(join(tmpdir(), 'gather-powers-migration-')), 'game.db');
  const f = fixture(undefined, filename);
  const member = f.game.members(f.c.id)[0];
  const stripBonuses = (item: ReturnType<typeof baseItem>) => {
    const { attackBonus: _attack, checkBonus: _check, ...legacy } = item;
    return legacy;
  };
  const focus = stripBonuses({ ...baseItem('old-focus', 'Sighting fork', 'focus'), scaling: ['INT'] });
  const relic = stripBonuses({ ...baseItem('old-relic', 'Throne oath', 'relic'), scaling: ['INT'] });
  const legacySheet = {
    ...member.character,
    equipmentOptions: [focus, relic, ...member.character.equipmentOptions.slice(2).map(stripBonuses)],
    selectedEquipmentIds: [focus.id, relic.id],
    abilities: member.character.abilities.map(({ stat: _stat, healing: _healing, ...ability }) => ability),
  };
  const legacyState = {
    ...member.state,
    xp: 42,
    gold: 9,
    equipment: { ...member.state.equipment, right: focus, left: relic },
  };
  const scene = f.game.snapshot(f.c.id, f.host.id).scene;
  const ground = {
    ...stripBonuses(baseItem('old-ground', 'Ancient relic', 'relic')),
    rarity: 'Legendary',
    quantity: 1,
  };
  f.db
    .prepare('UPDATE characters SET sheet = ? WHERE id = ?')
    .run(JSON.stringify(legacySheet), member.characterId);
  f.db
    .prepare('UPDATE members SET sheet = ?, state = ? WHERE id = ?')
    .run(JSON.stringify(legacySheet), JSON.stringify(legacyState), member.id);
  f.db
    .prepare('UPDATE campaigns SET scene = ? WHERE id = ?')
    .run(JSON.stringify({ ...scene, loot: [ground] }), f.c.id);
  f.db.exec('ALTER TABLE actions DROP COLUMN ability_name');
  f.db.exec('ALTER TABLE members DROP COLUMN replacement');
  f.db.pragma('user_version = 5');
  f.db.close();
  const restoredDb = openDatabase(filename);
  cleanup.push(() => restoredDb.close());
  const restored = new Game(restoredDb, () => new PracticeGM());
  const after = restored.members(f.c.id)[0];
  expect(after.state).toMatchObject({ xp: 42, gold: 9, equipmentChosen: true });
  expect(after.state.equipment.right).toMatchObject({ id: focus.id, attackBonus: 1, scaling: ['INT'] });
  expect(after.state.equipment.left).toMatchObject({ id: relic.id, checkBonus: 1, scaling: ['INT'] });
  expect(after.character.selectedEquipmentIds).toEqual([focus.id, relic.id]);
  expect(
    after.character.abilities.every((ability) => ability.stat === 'INT' && ability.healing === 'normal'),
  ).toBe(true);
  expect(restored.characters(member.playerId)[0].equipmentOptions[0].attackBonus).toBe(1);
  expect(restored.snapshot(f.c.id, f.host.id).scene.loot[0]).toMatchObject({
    id: ground.id,
    checkBonus: 3,
    scaling: ['INT'],
  });
});
