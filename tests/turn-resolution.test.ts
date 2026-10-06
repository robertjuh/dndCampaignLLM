import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Game, type GameMaster, type GMContext, type GameTools, type StageBudget } from '../server/game';
import { openDatabase } from '../server/db';
import { PracticeGM, ChatGPTGM, adjudicationInput } from '../server/providers';
import { normalizeCombatInput } from '../server/combat';
import { engineEvents, engineComponents, validateAdjudication } from '../server/turn-resolution';
import {
  actionId,
  aggregateComponents,
  type ActionComponent,
  assembleResolvedNarration,
  factualNarration,
  narrationParagraphs,
  turnNarrationSchema,
  type TurnAdjudication,
  type TurnResolution,
} from '../shared/turn-resolution';
import {
  templateCharacter,
  enemySchema,
  type CampaignConfig,
  type EnvironmentalAction,
} from '../shared/schema';
import { applyCondition, baseItem, initialScene, initialState } from '../shared/rules';
import type { ChatGPTAuth } from '../server/auth';

const config: CampaignConfig = {
  ruleset: 'roguelike-v1',
  name: 'Resolution',
  setting: 'The sealed sanctuary',
  premise: '',
  tone: 'Mysterious',
  language: 'English',
  instructions: '',
  custom: [],
  provider: 'practice',
  model: '',
};
const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);

function proposal(context: GMContext): TurnAdjudication {
  const events = engineEvents(context);
  const actions = context.turn.actions.map((submitted, index) => {
    const id = actionId(context.turn.id, submitted.memberId);
    const constraints = engineComponents(context, submitted.memberId);
    const name = context.members.find((member) => member.id === submitted.memberId)!.character.name;
    const component = (phase: 'main' | 'minor'): ActionComponent | null => {
      const expected = constraints[phase];
      if (submitted.passed || expected === null || (phase === 'minor' && !expected)) return null;
      const disposition = expected ?? { status: 'success' as const, basis: 'routine' as const };
      const own = events.filter((event) => event.actionId === id && event.phase === phase);
      const fact =
        disposition.status === 'blocked'
          ? `${name} cannot act.`
          : disposition.status === 'failure'
            ? `${name} fails to unlock the closure.`
            : index === 0
              ? `${name}'s hand unlocks the recessed closure.`
              : `${name} opens the unlocked door.`;
      if (!own.length) {
        const event = {
          id: `act:${index}`,
          sequence: events.length,
          kind: 'action' as const,
          memberId: submitted.memberId,
          actionId: id,
          phase,
          result: disposition.status,
          fact,
          receiptRefs: [],
          dependsOn:
            index && disposition.status === 'success' && events.some((event) => event.id === 'act:0')
              ? [{ eventId: 'act:0', requires: 'success' as const }]
              : [],
        };
        events.push(event);
        own.push(event);
      }
      return {
        ...disposition,
        fact: own.map((event) => event.fact).join(' '),
        reason: 'The established recess and saved mechanical effects support this outcome.',
        eventIds: own.map((event) => event.id),
        receiptRefs: [...new Set(own.flatMap((event) => event.receiptRefs))],
      };
    };
    const components = { main: component('main'), minor: component('minor') };
    if (submitted.passed)
      events.push({
        id: `act:${index}`,
        sequence: events.length,
        kind: 'action',
        memberId: submitted.memberId,
        actionId: id,
        phase: null,
        result: null,
        fact: `${name} waits.`,
        receiptRefs: [],
        dependsOn: [],
      });
    const own = events.filter((event) => event.actionId === id);
    return {
      actionId: id,
      memberId: submitted.memberId,
      ...aggregateComponents(components, submitted.passed),
      components,
      fact: own.map((event) => event.fact).join(' '),
      reason: 'The established recess is the unlocked door mechanism.',
      eventIds: own.map((event) => event.id),
      receiptRefs: [...new Set(own.flatMap((event) => event.receiptRefs))],
    };
  });
  events.push({
    id: 'world:discovery',
    sequence: events.length,
    kind: 'world',
    memberId: null,
    actionId: null,
    phase: null,
    result: null,
    fact: 'The sanctuary contains a bronze sun disk and traces of the lost caravan.',
    receiptRefs: [],
    dependsOn:
      actions.length &&
      actions.every((action) => action.status === 'success') &&
      events.some((event) => event.id === 'act:1')
        ? [{ eventId: 'act:1', requires: 'success' }]
        : [],
  });
  return {
    version: 2,
    turnId: context.turn.id,
    actions,
    events,
    changes: [],
    journal: [
      { kind: 'location', name: 'Sanctuary', detail: 'Bronze sun disk; traces of the lost caravan.' },
    ],
    location: null,
    safeRest: false,
    rewards: {
      xp: context.turn.number ? 10 : 0,
      gold: 0,
      reason: 'Discovery of the sanctuary and new caravan clues.',
    },
  };
}
function temporaryDatabasePath() {
  const directory = mkdtempSync(join(tmpdir(), 'turn-resolution-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'game.sqlite');
}

function changeMain(
  value: TurnAdjudication,
  memberId: string,
  status: ActionComponent['status'],
  fact: string,
) {
  const action = value.actions.find((action) => action.memberId === memberId)!;
  const main = action.components.main!;
  main.status = status;
  main.fact = fact;
  for (const event of value.events)
    if (main.eventIds.includes(event.id)) {
      event.result = status;
      event.fact = fact;
    }
  Object.assign(action, aggregateComponents(action.components));
  action.fact = [main.fact, action.components.minor?.fact].filter(Boolean).join(' ');
  return value;
}

function fixture(overrides: Partial<GameMaster> = {}, databasePath = ':memory:') {
  const db = openDatabase(databasePath);
  cleanup.push(() => {
    if (db.open) db.close();
  });
  const practice = new PracticeGM();
  const adjudicate = vi.fn(async (context: GMContext, tools: GameTools) =>
    context.turn.number === 0 ? practice.adjudicate(context, tools) : proposal(context),
  );
  const narrate = vi.fn(practice.narrate.bind(practice));
  const provider: GameMaster = {
    resolve: practice.resolve.bind(practice),
    adjudicate,
    narrate,
    ...overrides,
  };
  const draw = vi.fn((sides: number) => Math.min(12, sides));
  const factory = () => provider;
  const game = new Game(db, factory, draw);
  const host = game.identify();
  const p1 = game.identify();
  const p2 = game.identify();
  const c = game.create(host.id, config);
  for (const [player, name] of [
    [p1, 'Amon-Sah'],
    [p2, 'Zafir al-Raml'],
  ] as const) {
    const char = game.saveCharacter(player.id, templateCharacter(name));
    game.join(c.inviteCode!, player.id, char.id);
    const member = game.members(c.id).find((member) => member.playerId === player.id)!;
    game.manageCharacter(c.id, player.id, {
      type: 'starter',
      itemIds: member.state.starterEquipment.slice(0, 2).map((item) => item.id),
    });
  }
  const start = async () => {
    game.start(c.id, host.id);
    await game.idle();
    expect(game.snapshot(c.id, host.id).turn!.phase).toBe('collecting');
  };
  const submit = () => {
    const turn = game.snapshot(c.id, host.id).turn!;
    game.submit(c.id, p1.id, turn.id, 'Ik plaats mijn hand in de uitsparing.', false);
    game.submit(c.id, p2.id, turn.id, 'Open de deur', false);
    return turn.id;
  };
  const draft = (turnId: string) =>
    JSON.parse((db.prepare('SELECT draft FROM turns WHERE id = ?').get(turnId) as { draft: string }).draft);
  return { db, game, host, p1, p2, c, draw, provider, adjudicate, narrate, factory, start, submit, draft };
}

it('records causal routine outcomes and discovery XP, without dice or copied prompts', async () => {
  const f = fixture();
  await f.start();
  const id = f.submit();
  await f.game.idle();
  const turn = f.game.snapshot(f.c.id, f.host.id).history.at(-1)!;
  expect(turn.id).toBe(id);
  expect(turn.rolls).toEqual([]);
  expect(f.draw).not.toHaveBeenCalled();
  expect(turn.result!.narration).toContain("Amon-Sah's hand unlocks");
  expect(turn.result!.narration).not.toContain('Ik plaats');
  expect(turn.result!.narration).not.toContain('Open de deur');
  expect(turn.resolution!.actions.map((action) => [action.status, action.basis])).toEqual([
    ['success', 'routine'],
    ['success', 'routine'],
  ]);
  expect(turn.resolution!.events[1].dependsOn).toEqual([{ eventId: 'act:0', requires: 'success' }]);
  expect(turn.resolution!.events[2].dependsOn).toEqual([{ eventId: 'act:1', requires: 'success' }]);
  expect(f.game.members(f.c.id).map((member) => member.state.xp)).toEqual([10, 10]);
  expect(turn.result!.summary.match(/\+10 XP/g)).toHaveLength(2);
  expect(f.draft(id)).toMatchObject({
    pipelineVersion: 1,
    adjudication: { version: 2 },
    resolution: { version: 2 },
    narration: { version: 2 },
  });
  expect(
    f.db.prepare("SELECT kind FROM events WHERE turn_id = ? AND kind LIKE 'stage:%' ORDER BY id").all(id),
  ).toEqual([
    { kind: 'stage:adjudication' },
    { kind: 'stage:finalization' },
    { kind: 'stage:narration' },
    { kind: 'stage:publication' },
  ]);
});

it('prevents model-authored world outcomes from being hidden as bookkeeping', () => {
  const c = context();
  const value = proposal(c);
  value.events.find((event) => event.kind === 'world')!.presentation = 'log';
  expect(() => validateAdjudication(c, value)).toThrow('Only the engine');
});

it('restarts from a saved resolution, preserves concurrent participation, and uses factual continuity', async () => {
  const f = fixture();
  await f.start();
  const realNarrate = f.provider.narrate!;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const entry = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.provider.narrate = vi.fn(async () => {
    entered();
    await waiting;
    throw new Error('Narrator unavailable');
  });
  const id = f.submit();
  await entry;
  const before = f.draft(id);
  expect(before.resolution.rewards.map((reward: { xp: number }) => reward.xp)).toEqual([10, 10]);
  expect(f.game.members(f.c.id).map((member) => member.state.xp)).toEqual([0, 0]);
  const late = f.game.identify();
  const char = f.game.saveCharacter(late.id, templateCharacter('Late arrival'));
  f.game.join(f.c.inviteCode!, late.id, char.id);
  f.game.setActive(
    f.c.id,
    f.host.id,
    f.game.members(f.c.id).find((member) => member.playerId === f.p2.id)!.id,
    false,
  );
  expect(() =>
    f.game.completeChallenge(f.c.id, id, {
      memberId: before.members[0].id,
      reason: 'late gameplay',
      bossEquivalent: false,
    }),
  ).toThrow('Gameplay is locked');
  release();
  await f.game.idle();
  expect(f.game.snapshot(f.c.id, f.host.id).turn!.error).toContain('narration:');
  expect(f.draft(id).resolution).toEqual(before.resolution);
  const calls = f.adjudicate.mock.calls.length;
  f.provider.narrate = async (resolution, config) => ({
    ...(await realNarrate(resolution, config)),
    summary: 'Presentation-only wording.',
  });
  const restarted = new Game(f.db, f.factory, f.draw);
  restarted.retry(f.c.id, f.host.id);
  await restarted.idle();
  expect(f.adjudicate).toHaveBeenCalledTimes(calls);
  expect(f.draw).not.toHaveBeenCalled();
  const members = restarted.members(f.c.id);
  expect(members.find((member) => member.playerId === late.id)!.state.xp).toBe(0);
  expect(members.find((member) => member.playerId === f.p2.id)!.active).toBe(false);
  expect(restarted.snapshot(f.c.id, f.host.id).turn!.roster).not.toContain(
    members.find((member) => member.playerId === f.p2.id)!.id,
  );
  const lateMember = restarted.members(f.c.id).find((member) => member.playerId === late.id)!;
  restarted.manageCharacter(f.c.id, late.id, {
    type: 'starter',
    itemIds: lateMember.state.starterEquipment.slice(0, 2).map((item) => item.id),
  });
  const next = restarted.snapshot(f.c.id, f.host.id).turn!;
  f.provider.adjudicate = async (context) => {
    expect(context.history.at(-1)!.summary).toContain('bronze sun disk');
    expect(context.history.at(-1)!.summary).not.toContain('Presentation-only');
    return proposal(context);
  };
  restarted.submit(f.c.id, f.p1.id, next.id, 'Wait by the mechanism', false);
  restarted.submit(f.c.id, late.id, next.id, '', true);
  await restarted.idle();
});

it('saves the accepted environmental proposal and locked die before a finalization interruption', async () => {
  const f = fixture();
  await f.start();
  const actor = f.game.members(f.c.id)[0];
  actor.state.hp = 4;
  applyCondition(actor.state, 'Burning');
  f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(actor.state), actor.id);
  f.provider.adjudicate = vi.fn(async (context: GMContext): Promise<TurnAdjudication> => ({
    ...proposal(context),
    changes: [{ type: 'hp', memberId: actor.id, amount: -4, reason: 'A collapsing stone strikes the hand.' }],
  }));
  f.db.exec(
    `CREATE TRIGGER interrupt_finalization BEFORE UPDATE OF draft ON turns WHEN NEW.draft LIKE '%"resolution":%' BEGIN SELECT RAISE(ABORT, 'checkpoint interrupted'); END;`,
  );
  const id = f.submit();
  await f.game.idle();
  const draft = f.draft(id);
  expect(draft.adjudication.changes[0].amount).toBe(-4);
  expect(draft.resolution).toBeUndefined();
  expect(f.game.members(f.c.id)[0].state.hp).toBe(4);
  expect(f.draw).toHaveBeenCalledTimes(1);
  const rolls = f.game.snapshot(f.c.id, f.host.id).turn!.rolls;
  f.db.exec('DROP TRIGGER interrupt_finalization');
  f.game.retry(f.c.id, f.host.id);
  await f.game.idle();
  expect(f.provider.adjudicate).toHaveBeenCalledTimes(1);
  expect(f.draw).toHaveBeenCalledTimes(1);
  expect(f.game.snapshot(f.c.id, f.host.id).history.at(-1)!.rolls).toEqual(rolls);
  expect(f.game.members(f.c.id)[0].state.hp).toBe(0);
  expect(f.narrate.mock.calls.at(-1)![0].events.some((event) => event.fact.includes('Downed'))).toBe(true);
});

it('retries interrupted publication without narration or duplicate reward/tick application', async () => {
  const f = fixture();
  await f.start();
  const actor = f.game.members(f.c.id)[0];
  applyCondition(actor.state, 'Poisoned');
  f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(actor.state), actor.id);
  f.db.exec(
    `CREATE TRIGGER interrupt_publication BEFORE UPDATE OF phase ON turns WHEN NEW.phase = 'complete' BEGIN SELECT RAISE(ABORT, 'publication interrupted'); END;`,
  );
  const id = f.submit();
  await f.game.idle();
  const draft = f.draft(id);
  expect(draft.narration).toBeDefined();
  expect(f.game.members(f.c.id)[0].state.hp).toBe(actor.state.hp);
  expect(draft.members[0].state.hp).toBe(actor.state.hp - 1);
  const requests = f.narrate.mock.calls.length;
  f.db.exec('DROP TRIGGER interrupt_publication');
  f.game.retry(f.c.id, f.host.id);
  await f.game.idle();
  expect(f.narrate).toHaveBeenCalledTimes(requests);
  expect(f.game.members(f.c.id)[0].state.hp).toBe(actor.state.hp - 1);
  expect(f.game.members(f.c.id)[0].state.xp).toBe(10);
  expect(
    f.db
      .prepare("SELECT COUNT(*) AS count FROM events WHERE turn_id = ? AND kind = 'turn_committed'")
      .get(id),
  ).toEqual({ count: 1 });
});

it('resolves real practice checks and passes through the new pipeline', async () => {
  const practice = new PracticeGM();
  const f = fixture({
    adjudicate: practice.adjudicate.bind(practice),
    narrate: practice.narrate.bind(practice),
  });
  await f.start();
  const turn = f.game.snapshot(f.c.id, f.host.id).turn!;
  f.game.submit(f.c.id, f.p1.id, turn.id, 'Inspect the seal', false);
  f.game.submit(f.c.id, f.p2.id, turn.id, '', true);
  await f.game.idle();
  const done = f.game.snapshot(f.c.id, f.host.id).history.at(-1)!;
  expect(done.id).toBe(turn.id);
  expect(done.resolution!.actions.map((action) => action.status)).toEqual(['success', 'passed']);
  expect(done.rolls).toHaveLength(1);
  expect(done.result!.narration).not.toContain('Inspect the seal');
});

function context(): GMContext {
  const characters = ['Amon-Sah', 'Zafir al-Raml'].map((name) => templateCharacter(name));
  return {
    config,
    members: characters.map((character, index) => ({
      id: `m${index}`,
      playerId: `p${index}`,
      characterId: `c${index}`,
      playerName: character.name,
      character,
      state: initialState(character, `m${index}`),
      active: true,
      replacement: null,
    })),
    turn: {
      id: 'turn',
      number: 1,
      phase: 'resolving',
      roster: ['m0', 'm1'],
      actions: [
        { memberId: 'm0', text: 'Hand in recess', passed: false },
        { memberId: 'm1', text: 'Open the door', passed: false },
      ],
      rolls: [],
      result: null,
      error: null,
    },
    history: [],
    journal: [],
    scene: initialScene('The sealed sanctuary'),
    receipts: {},
  };
}
function resolution(): Extract<TurnResolution, { version: 2 }> {
  const c = context();
  const p = proposal(c);
  return {
    version: 2,
    turnId: 'turn',
    actions: p.actions.map((action) => ({
      ...action,
      characterId: action.memberId,
      characterName: c.members.find((member) => member.id === action.memberId)!.character.name,
    })),
    events: p.events,
    rewards: [],
    characters: c.members.map((member) => ({
      memberId: member.id,
      characterName: member.character.name,
      hp: member.state.hp,
      maxHp: member.state.maxHp,
      conditions: member.state.conditions,
      abilityUses: member.state.abilityUses ?? {},
      level: member.state.level,
      xp: member.state.xp,
      gold: member.state.gold,
    })),
    factualRecap: p.events.map((event) => event.fact).join('\n'),
    changes: [],
    journal: p.journal,
    location: null,
    safeRest: false,
  };
}
function completed(value: unknown) {
  return new Response(
    `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] } })}\n\n`,
  );
}
const auth = { accessToken: async () => 'test-token' } as unknown as ChatGPTAuth;

it.each([
  'missing actor',
  'duplicate actor',
  'unknown receipt',
  'forward dependency',
  'failed prerequisite',
  'engine contradiction',
])('rejects invalid adjudication: %s', (kind) => {
  const c = context();
  const p = proposal(c);
  if (kind === 'missing actor') p.actions.pop();
  if (kind === 'duplicate actor') p.actions.push(p.actions[0]);
  if (kind === 'unknown receipt') p.actions[0].receiptRefs.push('roll:invented');
  if (kind === 'forward dependency') p.events[0].dependsOn.push({ eventId: 'act:1', requires: 'occurrence' });
  if (kind === 'failed prerequisite') {
    p.actions[0].components.main!.status = 'failure';
    p.events[0].result = 'failure';
    p.actions[0].status = 'failure';
  }
  if (kind === 'engine contradiction')
    c.turn.rolls.push({
      memberId: 'm0',
      id: 'r1',
      dice: [2],
      modifier: 0,
      total: 2,
      success: false,
      source: 'test',
      stat: 'INT',
      dc: 10,
      mode: 'normal',
      reason: 'Locked check',
      lethal: false,
    });
  expect(() => validateAdjudication(c, p)).toThrow();
});

it('rejects presentation mutations, unknown events, missing outcomes and oversized prose', () => {
  const r = resolution();
  const valid = {
    version: 1,
    turnId: r.turnId,
    eventNarrations: Object.fromEntries(r.events.map((event) => [event.id, event.fact])),
    closing: '',
    summary: 'The door is open.',
  };
  expect(turnNarrationSchema.safeParse({ ...valid, xp: 10 }).success).toBe(false);
  expect(() => assembleResolvedNarration(r, { ...valid, eventNarrations: {} })).toThrow('exactly');
  expect(() =>
    assembleResolvedNarration(r, {
      ...valid,
      eventNarrations: { ...valid.eventNarrations, invented: 'Invented clue.' },
    }),
  ).toThrow('exactly');
  expect(() => assembleResolvedNarration(r, { ...valid, closing: 'x'.repeat(24000) })).toThrow('budget');
});

it('uses three normal model requests with tools confined to adjudication', async () => {
  const c = context();
  const r = resolution();
  const inputs: unknown[] = [];
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    inputs.push(body);
    if (body.tools) return completed(proposal(c));
    const data = JSON.parse(body.input[0].content);
    return data.candidate
      ? completed({ approved: true, feedback: '' })
      : completed({
          version: 1,
          turnId: 'turn',
          eventNarrations: Object.fromEntries(r.events.map((event) => [event.id, event.fact])),
          closing: '',
          summary: 'The sanctuary is revealed.',
        });
  }) as unknown as typeof fetch;
  const gm = new ChatGPTGM(auth, 'owner', 'model', fetcher);
  const tools = Object.assign(vi.fn(), {
    validateAdjudication: (input: unknown) => validateAdjudication(c, input),
  }) as unknown as GameTools;
  await gm.adjudicate(c, tools);
  await gm.narrate(r, config);
  expect(inputs).toHaveLength(3);
  expect(inputs.map((input) => !!(input as { tools?: unknown }).tools)).toEqual([true, false, false]);
  const review = JSON.parse((inputs[2] as { input: { content: string }[] }).input[0].content);
  expect(Object.keys(review)).toEqual(['task', 'resolution', 'candidate']);
});

it('bounds multi-request adjudication context and reconstructs saved engine events', async () => {
  const c = context();
  for (const member of c.members) {
    c.turn.actions.find((action) => action.memberId === member.id)!.memberId = member.id = randomUUID();
  }
  c.turn.roster = c.members.map((member) => member.id);
  c.startingMembers = structuredClone(c.members);
  c.requestBudget = { used: 0, limit: 8 };
  const before = structuredClone(c.members);
  const requests: any[] = [];
  const checks = c.members.map((member) => ({
    memberId: member.id,
    stat: 'INT' as const,
    dc: 10 as const,
    reason: 'Inspect the mechanism.',
    mode: 'normal' as const,
    abilityName: null,
    lethal: false,
  }));
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    requests.push(body);
    if (requests.length === 1)
      return new Response(
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            output: checks.map((check, index) => ({
              type: 'function_call',
              namespace: 'game',
              name: 'roll_check',
              call_id: `check-${index}`,
              arguments: JSON.stringify(check),
            })),
          },
        })}\n\n`,
      );
    if (requests.length === 2) return completed({ malformed: true });
    const value = proposal(c);
    value.events = value.events.slice(engineEvents(c).length);
    return completed(value);
  }) as unknown as typeof fetch;
  const tools = Object.assign(
    vi.fn((check) => {
      const roll = {
        ...check,
        id: randomUUID(),
        dice: [12],
        modifier: 0,
        total: 12,
        success: true,
        source: 'test',
      };
      c.turn.rolls.push(roll);
      return roll;
    }),
    { validateAdjudication: (value: unknown) => validateAdjudication(c, value) },
  ) as unknown as GameTools;
  const result = await new ChatGPTGM(auth, 'owner', 'model', fetcher).adjudicate(c, tools);
  expect(result.events.slice(0, 2)).toEqual(engineEvents(c));
  expect(tools).toHaveBeenCalledTimes(2);
  expect(requests).toHaveLength(3);
  for (const request of requests) {
    expect(request.instructions.length).toBeLessThan(22_000);
    expect(request.instructions).toContain('Batch independent tool calls');
    expect(
      request.input.filter((item: any) => item.role === 'user' && item.content.startsWith('{')),
    ).toHaveLength(1);
    const current = JSON.parse(request.input[0].content);
    expect(current.members[0].character).not.toHaveProperty('equipmentOptions');
    expect(current.members[0].state).not.toHaveProperty('starterEquipment');
    expect(current.members[0].character.abilities).toEqual(before[0].character.abilities);
    expect(current.members[0].state.inventory).toEqual(before[0].state.inventory);
    expect(current.startingMembers[0]).not.toHaveProperty('character');
    expect(current).not.toHaveProperty('requestBudget');
    expect(current).not.toHaveProperty('receipts');
  }
  expect(JSON.parse(requests[1].input[0].content).turn.rolls).toHaveLength(2);
  expect(requests[1].input.filter((item: any) => item.type === 'function_call_output')).toHaveLength(2);
  expect(requests[2].input).toHaveLength(3); // Snapshot, latest candidate and bounded correction only.
  expect(c.members).toEqual(before);
  expect(c.requestBudget.requests).toHaveLength(3);
  expect(c.requestBudget.requests![0]).toMatchObject({
    request: 1,
    inputBytes: expect.any(Number),
    durationMs: expect.any(Number),
  });
  expect(c.requestBudget.corrections).toHaveLength(1);
  expect(c.requestBudget.corrections![0].feedback.length).toBeLessThanOrEqual(1000);
  expect(adjudicationInput(c).schemaExample.events.every((event) => !event.id.startsWith('check:'))).toBe(
    true,
  );
});

it('automatically retries a timeout after a saved check without rerolling or duplicating rewards', async () => {
  const f = fixture();
  await f.start();
  let attempts = 0;
  let rolls: unknown;
  f.provider.adjudicate = vi.fn(async (context, tools) => {
    if (++attempts === 1) {
      tools({
        memberId: context.members[0].id,
        stat: 'INT',
        dc: 10,
        mode: 'normal',
        reason: 'Inspect the seal.',
        lethal: false,
      });
      rolls = structuredClone(context.turn.rolls);
      throw new DOMException('Request took too long.', 'TimeoutError');
    }
    expect(context.turn.rolls).toEqual(rolls);
    return proposal(context);
  });
  const id = f.submit();
  await f.game.idle();
  const done = f.game.snapshot(f.c.id, f.host.id).history.at(-1)!;
  expect(done.id).toBe(id);
  expect(done.rolls).toEqual(rolls);
  expect(done.automaticRetry).toBe(true);
  expect(f.draw).toHaveBeenCalledTimes(1);
  expect(f.game.members(f.c.id).map((member) => member.state.xp)).toEqual([10, 10]);
  const stages = f.db
    .prepare("SELECT payload FROM events WHERE turn_id = ? AND kind = 'stage:adjudication' ORDER BY id")
    .all(id)
    .map((row: any) => JSON.parse(row.payload));
  expect(stages).toMatchObject([
    { attempt: 1, failureCategory: 'timeout' },
    { attempt: 2, failure: null },
  ]);
});

it('limits automatic retry to once per turn across stages, manual retries and restarts', async () => {
  const databasePath = temporaryDatabasePath();
  const f = fixture({}, databasePath);
  await f.start();
  f.provider.adjudicate = vi.fn(async () => {
    throw new DOMException('Timeout', 'TimeoutError');
  });
  const id = f.submit();
  await f.game.idle();
  expect(f.provider.adjudicate).toHaveBeenCalledTimes(2);
  expect(f.game.snapshot(f.c.id, f.host.id).turn!.phase).toBe('failed');
  f.db.close();
  const reopened = openDatabase(databasePath);
  cleanup.push(() => reopened.close());
  const restarted = new Game(reopened, f.factory, f.draw);
  restarted.retry(f.c.id, f.host.id);
  await restarted.idle();
  expect(f.provider.adjudicate).toHaveBeenCalledTimes(3);
  f.provider.adjudicate = async (context) => proposal(context);
  f.provider.narrate = vi.fn(async () => {
    throw new DOMException('Timeout', 'TimeoutError');
  });
  restarted.retry(f.c.id, f.host.id);
  await restarted.idle();
  expect(f.provider.narrate).toHaveBeenCalledTimes(1);
  expect(
    reopened
      .prepare("SELECT COUNT(*) AS n FROM events WHERE turn_id = ? AND kind = 'turn_auto_retry'")
      .get(id),
  ).toEqual({ n: 1 });
});

it('retries a narration timeout from the finalized result without another adjudication', async () => {
  const f = fixture();
  await f.start();
  const adjudications = f.adjudicate.mock.calls.length;
  let attempts = 0;
  f.provider.narrate = vi.fn(async (resolution, config) => {
    if (++attempts === 1) throw new DOMException('Timeout', 'TimeoutError');
    return f.narrate(resolution, config);
  });
  const id = f.submit();
  await f.game.idle();
  expect(f.game.snapshot(f.c.id, f.host.id).history.at(-1)!.id).toBe(id);
  expect(f.adjudicate).toHaveBeenCalledTimes(adjudications + 1);
  expect(f.provider.narrate).toHaveBeenCalledTimes(2);
  expect(f.game.members(f.c.id).map((member) => member.state.xp)).toEqual([10, 10]);
});

it('applies request and stage deadlines to streamed output and preserves user cancellation', async () => {
  const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
  try {
    for (const mode of ['request', 'stage', 'cancel'] as const) {
      const c = context();
      const requestTimeout = new AbortController();
      const stage = new AbortController();
      timeoutSpy.mockImplementation((duration) => {
        expect(duration).toBe(90_000);
        return requestTimeout.signal;
      });
      const budget: StageBudget = { used: 0, limit: 8, signal: stage.signal };
      c.requestBudget = budget;
      const fetcher = vi.fn(
        async (_url, init) =>
          new Response(
            new ReadableStream({
              start(controller) {
                init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), {
                  once: true,
                });
                queueMicrotask(() =>
                  (mode === 'request' ? requestTimeout : stage).abort(
                    new DOMException('Stopped', mode === 'cancel' ? 'AbortError' : 'TimeoutError'),
                  ),
                );
              },
            }),
          ),
      ) as unknown as typeof fetch;
      const error = await new ChatGPTGM(auth, 'owner', 'model', fetcher)
        .adjudicate(c, {} as GameTools)
        .catch((error) => error);
      expect(error.name).toBe(mode === 'cancel' ? 'AbortError' : 'TimeoutError');
      expect(error.message).toContain(
        mode === 'request' ? '90 seconds' : mode === 'stage' ? 'stage deadline' : 'Stopped',
      );
      expect(budget.requests).toHaveLength(1);
      expect(budget.requests![0].failure).toBe(error.message);
    }
  } finally {
    timeoutSpy.mockRestore();
  }
});

it.each(['fidelity', 'invalid JSON', 'tool call'])(
  'uses a flat narration budget for %s failures',
  async (failure) => {
    const r = resolution();
    let requests = 0;
    let reviews = 0;
    const fetcher = vi.fn(async (_url, init) => {
      requests++;
      const body = JSON.parse(init!.body as string);
      expect(body.tools).toBeUndefined();
      const data = JSON.parse(body.input[0].content);
      if (data.candidate) {
        reviews++;
        return completed({ approved: false, feedback: 'Closing invents a clue.' });
      }
      if (failure === 'invalid JSON') return completed({ summary: 'missing events' });
      if (failure === 'tool call')
        return new Response(
          `data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'function_call', name: 'roll_check', arguments: '{}' }] } })}\n\n`,
        );
      return completed({
        version: 1,
        turnId: r.turnId,
        eventNarrations: Object.fromEntries(r.events.map((event) => [event.id, event.fact])),
        closing: 'An invented key appears.',
        summary: 'The door opens.',
      });
    }) as unknown as typeof fetch;
    const budget: StageBudget = { used: 0, limit: 4 };
    const narrated = await new ChatGPTGM(auth, 'owner', 'model', fetcher).narrate(r, config, budget);
    expect(assembleResolvedNarration(r, narrated)).toEqual(narrated);
    expect(narrationParagraphs(r, narrated).join(' ')).not.toContain('invented key');
    expect(narrationParagraphs(r, narrated)).toEqual(r.events.map((event) => event.fact));
    expect(budget.fallback).toContain('two-attempt');
    expect(budget.corrections).toHaveLength(2);
    expect(requests).toBe(failure === 'fidelity' ? 4 : 2);
    expect(reviews).toBe(failure === 'fidelity' ? 2 : 0);
  },
);

it('completes a saved turn after repeated narration rejection and retains feedback, rolls and rewards', async () => {
  const f = fixture();
  await f.start();
  f.provider.adjudicate = async (context, tools) => {
    tools({
      memberId: context.turn.actions[0].memberId,
      stat: 'INT',
      dc: 10,
      mode: 'normal',
      lethal: false,
      reason: 'Inspect the seal.',
    });
    return proposal(context);
  };
  const feedback = 'The submitted confirming groan is not established for Davyjaws.';
  f.provider.narrate = async () => {
    throw new Error(feedback);
  };
  const id = f.submit();
  await f.game.idle();
  const saved = structuredClone(f.draft(id).resolution);
  const before = f.game.snapshot(f.c.id, f.host.id).turn!;
  expect(before.phase).toBe('failed');
  const draws = f.draw.mock.calls.length;
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    expect(body.instructions).toContain('not an event the story must explicitly announce');
    const data = JSON.parse(body.input[0].content);
    return data.candidate
      ? completed({ approved: false, feedback })
      : completed({
          version: 1,
          turnId: id,
          eventNarrations: Object.fromEntries(saved.events.map((event: any) => [event.id, event.fact])),
          closing: '',
          summary: 'The sanctuary is open.',
        });
  }) as unknown as typeof fetch;
  const gm = new ChatGPTGM(auth, 'owner', 'model', fetcher);
  f.provider.narrate = gm.narrate.bind(gm);
  f.game.retry(f.c.id, f.host.id);
  await f.game.idle();
  const snapshot = f.game.snapshot(f.c.id, f.host.id);
  const done = snapshot.history.at(-1)!;
  expect(done.id).toBe(id);
  expect(done.phase).toBe('complete');
  expect(snapshot.turn!.phase).toBe('collecting');
  expect(done.resolution).toEqual(saved);
  expect(done.actions).toEqual(before.actions);
  expect(done.rolls).toEqual(before.rolls);
  expect(f.draw).toHaveBeenCalledTimes(draws);
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(done.diagnostics).toContain(`narration: Narration exhausted its two-attempt budget. ${feedback}`);
  expect(snapshot.members.map((member) => member.state.xp)).toEqual([10, 10]);
  expect(done.result!.narration).toContain('lost caravan');
});

it.each([false, true])(
  'omits unresolved actions after adjudication exhaustion while preserving checks and spent resources (item executed: %s)',
  async (executeItem) => {
    const f = fixture();
    await f.start();
    const [actor, ally] = f.game.members(f.c.id);
    const ability = actor.character.abilities.find((ability) => ability.kind === 'utility')!;
    const potion = { ...baseItem('potion', 'Red Potion', 'consumable'), healing: 4, quantity: 1 };
    actor.state.inventory.push(potion);
    actor.state.hp -= 4;
    f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(actor.state), actor.id);
    const check = {
      memberId: ally.id,
      stat: 'INT',
      dc: 10,
      mode: 'normal',
      lethal: false,
      reason: 'Inspect the door.',
      abilityName: null,
    };
    let requests = 0;
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      expect(body.instructions).toContain('Unsupported or impossible input must not stop the turn');
      if (++requests === 1)
        return new Response(
          `data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'function_call', name: 'roll_check', call_id: 'ally-check', arguments: JSON.stringify(check) }, ...(executeItem ? [{ type: 'function_call', name: 'use_resource', call_id: 'potion-use', arguments: JSON.stringify({ memberId: actor.id, itemId: potion.id, abilityName: null, targetId: null }) }] : [])] } })}\n\n`,
        );
      return completed({ malformed: true });
    }) as unknown as typeof fetch;
    const gm = new ChatGPTGM(auth, 'owner', 'model', fetcher);
    f.provider.adjudicate = gm.adjudicate.bind(gm);
    const turn = f.game.snapshot(f.c.id, f.host.id).turn!;
    f.game.submit(
      f.c.id,
      f.p1.id,
      turn.id,
      `Use ${ability.name} to teleport the door and drink Red Potion`,
      false,
      false,
      ability.name,
    );
    f.game.submit(f.c.id, f.p2.id, turn.id, 'Inspect the door.', false);
    await f.game.idle();
    const snapshot = f.game.snapshot(f.c.id, f.host.id);
    const done = snapshot.history.at(-1)!;
    expect(done.id).toBe(turn.id);
    expect(done.phase).toBe('complete');
    expect(snapshot.turn!.phase).toBe('collecting');
    expect(done.rolls).toHaveLength(1);
    expect(done.rolls[0]).toMatchObject({ memberId: ally.id, success: true });
    expect(f.draw).toHaveBeenCalledTimes(1);
    expect(done.resolution!.actions.map((action) => action.status)).toEqual([
      executeItem ? 'partial' : 'blocked',
      'success',
    ]);
    const unchanged = snapshot.members.find((member) => member.id === actor.id)!;
    expect(unchanged.state.hp).toBe(executeItem ? actor.state.maxHp : actor.state.hp);
    expect(unchanged.state.inventory.find((item) => item.id === potion.id)?.quantity ?? 0).toBe(
      executeItem ? 0 : 1,
    );
    expect(unchanged.state.abilityUses?.[ability.name] ?? 0).toBe(0);
    expect(done.diagnostics?.some((message) => message.includes('eight-request'))).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(8);
    expect(snapshot.members.map((member) => member.state.xp)).toEqual([0, 0]);
  },
);

it('keeps the trusted narration fallback within the story limit for an oversized resolution', () => {
  const r = resolution();
  r.events = Array.from({ length: 400 }, (_, sequence) => ({
    ...r.events[0],
    id: `event:${sequence}`,
    sequence,
    dependsOn: [],
    fact: 'The door stays closed. ' + 'The recorded result is unchanged. '.repeat(70),
  }));
  r.factualRecap = r.events.map((event) => event.fact).join('\n');
  const narration = factualNarration(r, config.language);
  expect(narrationParagraphs(r, narration)).toHaveLength(400);
  expect(narrationParagraphs(r, narration).join('\n\n').length).toBeLessThanOrEqual(24000);
  expect(narrationParagraphs(r, narration).every((text) => text.includes('stays closed'))).toBe(true);
});

it('uses saved facts if a provider returns copied prompts instead of outcomes', async () => {
  const f = fixture();
  await f.start();
  f.provider.narrate = async (resolution) => ({
    version: 1,
    turnId: resolution.turnId,
    eventNarrations: Object.fromEntries(
      resolution.events.map((event) => [event.id, 'Amon-Sah attempts: Open de deur']),
    ),
    closing: '',
    summary: 'The door is open.',
  });
  const id = f.submit();
  await f.game.idle();
  const done = f.game.snapshot(f.c.id, f.host.id).history.at(-1)!;
  expect(done.id).toBe(id);
  expect(done.result!.narration).not.toContain('attempts:');
  expect(done.diagnostics).toContain(
    'narration: Narration copied a submission instead of describing its outcome.',
  );
});

it('keeps typed combat execution order and skips engine replay after narration failure', async () => {
  const practice = new PracticeGM();
  const f = fixture({
    adjudicate: practice.adjudicate.bind(practice),
    planCombat: practice.planCombat.bind(practice),
  });
  await f.start();
  const members = f.game.members(f.c.id);
  const scene = f.game.snapshot(f.c.id, f.host.id).scene;
  scene.encounter = {
    round: 1,
    victory: false,
    escaped: false,
    initiative: [
      { id: members[1].id, total: 19 },
      { id: 'guardian', total: 15 },
      { id: members[0].id, total: 10 },
    ],
    enemies: [
      {
        id: 'guardian',
        name: 'Guardian',
        tier: 'normal',
        hp: 50,
        maxHp: 50,
        defense: 50,
        attack: 0,
        damage: '1d4',
        initiative: 15,
        description: '',
        tactic: '',
        onHit: null,
      },
    ],
  };
  f.db.prepare('UPDATE campaigns SET scene = ? WHERE id = ?').run(JSON.stringify(scene), f.c.id);
  const original = f.provider.narrate!;
  f.provider.narrate = async () => {
    throw new Error('Paused narrator');
  };
  const turn = f.game.snapshot(f.c.id, f.host.id).turn!;
  f.game.submit(f.c.id, f.p1.id, turn.id, 'Attack the Guardian', false);
  f.game.submit(f.c.id, f.p2.id, turn.id, 'Attack the Guardian', false);
  await f.game.idle();
  const saved = f.draft(turn.id);
  const receipt = saved.receipts.combat;
  expect(receipt.events.map((event: { fact: string }) => event.fact)).toEqual(receipt.logs);
  expect(
    saved.resolution.events
      .filter((event: { kind: string }) => event.kind === 'combat')
      .map((event: { fact: string }) => event.fact),
  ).toEqual(receipt.logs);
  expect(saved.resolution.actions.map((action: { status: string }) => action.status)).toEqual([
    'failure',
    'failure',
  ]);
  expect(
    receipt.events
      .filter((event: { phase: string; actorId: string | null }) => event.phase === 'main' && event.actorId)
      .map((event: { actorId: string }) => event.actorId),
  ).toEqual([members[1].id, members[0].id]);
  const drawCount = f.draw.mock.calls.length;
  f.provider.narrate = original;
  f.game.retry(f.c.id, f.host.id);
  await f.game.idle();
  expect(f.draw).toHaveBeenCalledTimes(drawCount);
  expect(f.game.snapshot(f.c.id, f.host.id).scene.encounter!.round).toBe(2);
});

it('requires and persists victory aftermath, preserves equipment flavor and keeps recovery out of prose', async () => {
  const f = fixture();
  await f.start();
  const members = f.game.members(f.c.id);
  members[0].state.equipment.right = {
    ...baseItem('knife', 'Steel knife', 'weapon'),
    description: 'A short steel knife, used at close range.',
  };
  members[0].state.hp -= 2;
  f.db
    .prepare('UPDATE members SET state = ? WHERE id = ?')
    .run(JSON.stringify(members[0].state), members[0].id);
  const scene = f.game.snapshot(f.c.id, f.host.id).scene;
  scene.location = {
    name: 'Checkpoint',
    atmosphere: 'The drone controls the gate.',
    hazard: 'Drone attacks.',
  };
  scene.encounter = {
    round: 1,
    victory: false,
    escaped: false,
    initiative: [
      { id: members[0].id, total: 20 },
      { id: members[1].id, total: 10 },
      { id: 'drone', total: 1 },
    ],
    enemies: [
      {
        ...enemySchema.parse({
          id: 'drone',
          name: 'Checkpoint drone',
          tier: 'minor',
          hp: 1,
          defense: 5,
          attack: 0,
          damage: '1d4',
          description: 'A mechanical grabbing arm.',
          tactic: 'Guard the gate.',
        }),
        maxHp: 1,
        initiative: 1,
        equipment: [
          {
            ...baseItem('arm', 'Electric arm', 'weapon'),
            description: 'A grabbing arm with electrical contacts.',
          },
        ],
      },
    ],
  };
  f.db.prepare('UPDATE campaigns SET scene = ? WHERE id = ?').run(JSON.stringify(scene), f.c.id);
  let requests = 0;
  let current: GMContext;
  const fetcher = vi.fn(async (_url, init) => {
    requests++;
    const body = JSON.parse(init!.body as string);
    const value = proposal(current);
    value.rewards = { xp: 0, gold: 0, reason: 'Combat rewards belong to the server.' };
    if (requests > 1) {
      expect(JSON.stringify(body.input)).toContain('Victory needs a world aftermath');
      value.location = { name: 'Checkpoint', atmosphere: 'The gate is quiet and accessible.', hazard: '' };
      const aftermath = value.events.find((event) => event.id === 'world:discovery')!;
      aftermath.phase = 'aftermath';
      aftermath.fact = 'With the drone destroyed, the checkpoint gate is accessible again.';
      value.journal = [{ kind: 'location', name: 'Checkpoint', detail: aftermath.fact }];
    }
    return completed(value);
  }) as unknown as typeof fetch;
  const gm = new ChatGPTGM(auth, 'owner', 'model', fetcher);
  f.provider.adjudicate = (context, tools) => {
    current = context;
    return gm.adjudicate(context, tools);
  };
  f.provider.planCombat = (context) => Promise.resolve(normalizeCombatInput(context));
  const turn = f.game.snapshot(f.c.id, f.host.id).turn!;
  f.game.submit(f.c.id, f.p1.id, turn.id, 'Attack the Checkpoint drone with my knife.', false);
  f.game.submit(f.c.id, f.p2.id, turn.id, '', true);
  await f.game.idle();
  const snapshot = f.game.snapshot(f.c.id, f.host.id);
  const done = snapshot.history.at(-1)!;
  expect(done.id, snapshot.turn?.error ?? '').toBe(turn.id);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(snapshot.scene.location).toEqual({
    name: 'Checkpoint',
    atmosphere: 'The gate is quiet and accessible.',
    hazard: '',
  });
  expect(snapshot.journal).toContainEqual({
    kind: 'location',
    name: 'Checkpoint',
    detail: 'With the drone destroyed, the checkpoint gate is accessible again.',
  });
  expect(
    done.resolution!.executionContext!.find((actor) => actor.name === 'Amon-Sah')!.equipment,
  ).toContainEqual({
    name: 'Steel knife',
    kind: 'weapon',
    description: 'A short steel knife, used at close range.',
  });
  expect(
    done.resolution!.executionContext!.find((actor) => actor.name === 'Checkpoint drone')!.equipment[0]
      .description,
  ).toBe('A grabbing arm with electrical contacts.');
  expect(done.resolution!.actionDescriptions![actionId(turn.id, members[0].id)]).toContain('my knife');
  expect(
    done.resolution!.events.some((event) => 'presentation' in event && event.presentation === 'log'),
  ).toBe(true);
  expect(done.result!.narration).toContain('checkpoint gate is accessible');
  expect(done.result!.narration).not.toMatch(/recovers \d+ HP|regains one charge|drops Electric arm/);
  expect(done.result!.summary.match(/\+15 XP/g)).toHaveLength(2);
});

it('records a failed utility check and discovery reward independently, then consumes the ability only once', async () => {
  const f = fixture();
  await f.start();
  const member = f.game.members(f.c.id)[0];
  const ability = member.character.abilities.find((ability) => ability.kind === 'utility')!;
  f.draw.mockImplementation(() => 2);
  f.provider.adjudicate = vi.fn(async (context: GMContext, tools: GameTools) => {
    tools({
      memberId: member.id,
      stat: ability.stat,
      abilityName: ability.name,
      dc: 20,
      mode: 'normal',
      lethal: false,
      reason: 'Investigate the recess with the selected utility ability.',
    });
    const value = proposal(context);
    value.events.find((event) => event.id === 'world:discovery')!.dependsOn = [
      { eventId: value.events.find((event) => event.id.startsWith('check:'))!.id, requires: 'occurrence' },
    ];
    return value;
  });
  const original = f.provider.narrate!;
  f.provider.narrate = async () => {
    throw new Error('Prose unavailable');
  };
  const turn = f.game.snapshot(f.c.id, f.host.id).turn!;
  f.game.submit(
    f.c.id,
    f.p1.id,
    turn.id,
    `Use ${ability.name} to investigate the recess`,
    false,
    false,
    ability.name,
  );
  f.game.submit(f.c.id, f.p2.id, turn.id, '', true);
  await f.game.idle();
  const saved = f.draft(turn.id);
  expect(saved.resolution.actions[0]).toMatchObject({ status: 'failure', basis: 'check' });
  expect(saved.members[0].state.abilityUses[ability.name]).toBe(1);
  expect(saved.resolution.rewards.map((reward: { xp: number }) => reward.xp)).toEqual([10, 10]);
  expect(saved.resolution.actions[1].status).toBe('passed');
  f.provider.narrate = original;
  f.game.retry(f.c.id, f.host.id);
  await f.game.idle();
  expect(f.provider.adjudicate).toHaveBeenCalledTimes(1);
  expect(f.draw).toHaveBeenCalledTimes(2);
  expect(f.game.members(f.c.id)[0].state.abilityUses![ability.name]).toBe(1);
});

it('includes support receipts and blocked/pass outcomes before the narrator runs', async () => {
  const practice = new PracticeGM();
  const f = fixture({ adjudicate: practice.adjudicate.bind(practice) });
  await f.start();
  const members = f.game.members(f.c.id);
  const target = members[1];
  target.state.hp = 0;
  target.state.conditions.push('Downed');
  f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(target.state), target.id);
  // Freeze a single acting member, while including the downed ally as a support target.
  const turn = f.game.snapshot(f.c.id, f.host.id).turn!;
  f.db.prepare('UPDATE turns SET roster = ? WHERE id = ?').run(JSON.stringify([members[0].id]), turn.id);
  f.game.submit(f.c.id, f.p1.id, turn.id, 'Help up my ally', false, false, undefined, {
    type: 'help-up',
    targetId: target.id,
  });
  await f.game.idle();
  const done = f.game.snapshot(f.c.id, f.host.id).history.at(-1)!;
  expect(done.id).toBe(turn.id);
  expect(done.rolls).toHaveLength(0);
  expect(done.resolution!.actions[0]).toMatchObject({
    status: 'success',
    basis: 'engine',
    receiptRefs: ['tool:support'],
  });
  expect(f.game.members(f.c.id)[1].state.hp).toBe(1);
  expect(
    f.narrate.mock.calls
      .at(-1)![0]
      .events.some((event) => event.fact.includes('1 HP') && event.fact.includes('Zafir al-Raml')),
  ).toBe(true);
});

it('enforces the shared eight-request budget including combat planning', async () => {
  const c = context();
  const fetcher = vi.fn(async () => completed({ malformed: true })) as unknown as typeof fetch;
  const gm = new ChatGPTGM(auth, 'owner', 'model', fetcher);
  for (const member of c.members) {
    const oldId = member.id;
    member.id = randomUUID();
    c.turn.actions.find((action) => action.memberId === oldId)!.memberId = member.id;
  }
  c.turn.roster = c.members.map((member) => member.id);
  c.requestBudget = { used: 0, limit: 8 };
  await gm.planCombat(c); // Three invalid plans consume three requests before the safe fallback.
  expect(c.requestBudget.used).toBe(3);
  const result = await gm.adjudicate(
    c,
    Object.assign(vi.fn(), {
      validateAdjudication: (input: unknown) => validateAdjudication(c, input),
    }) as unknown as GameTools,
  );
  expect(result.actions.map((action) => action.status)).toEqual(['blocked', 'blocked']);
  expect(result.changes).toEqual([]);
  expect(result.rewards).toMatchObject({ xp: 0, gold: 0 });
  expect(c.requestBudget.fallback).toContain('eight-request');
  expect(fetcher).toHaveBeenCalledTimes(8);
  expect(c.requestBudget.used).toBe(8);
});

it('accepts the full configured setting and premise limits without truncating opening facts', async () => {
  const c = context();
  c.turn.number = 0;
  c.turn.actions = [];
  c.config = { ...config, setting: 'S'.repeat(500), premise: 'P'.repeat(2500) };
  c.scene = initialScene(c.config.setting);
  const practice = new PracticeGM();
  const adjudication = await practice.adjudicate(
    c,
    Object.assign(vi.fn(), {
      validateAdjudication: (input: unknown) => validateAdjudication(c, input),
    }) as unknown as GameTools,
  );
  expect(adjudication.events.map((event) => event.fact)).toContain(c.config.premise);
  const r = {
    ...resolution(),
    turnId: c.turn.id,
    actions: [],
    events: adjudication.events,
    location: c.scene.location,
  };
  const narration = await practice.narrate(r, c.config);
  expect(narrationParagraphs(r, narration)).toContain(c.config.premise);
});

it.each([false, true])(
  'resumes an encounter introduction after reopening SQLite without planning or replaying dice (with self potion: %s)',
  async (usePotion) => {
    const databasePath = temporaryDatabasePath();
    const f = fixture({}, databasePath);
    await f.start();
    const actor = f.game.members(f.c.id)[0];
    const potion = { ...baseItem('potion', 'Red Potion', 'consumable'), healing: 4, quantity: 1 };
    if (usePotion) {
      actor.state.hp -= 4;
      actor.state.inventory.push(potion);
      f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(actor.state), actor.id);
    }
    const enemies = [
      {
        id: 'guardian',
        name: 'Guardian',
        tier: 'normal',
        hp: 20,
        defense: 10,
        attack: 1,
        damage: '1d4',
        description: 'A guardian enters the doorway.',
        tactic: '',
        onHit: null,
      },
    ];
    let attempts = 0;
    f.provider.planCombat = vi.fn(async () => {
      throw new Error('The first combat round belongs to the next turn.');
    });
    f.provider.adjudicate = vi.fn(async (context: GMContext, tools: GameTools) => {
      attempts++;
      if (usePotion)
        tools.useResource!({ memberId: actor.id, itemId: potion.id, abilityName: null, targetId: null });
      tools.startCombat(enemies);
      if (attempts === 1) throw new Error('Connection lost after encounter introduction.');
      const value = proposal(context);
      value.rewards.xp = 0;
      value.location = { name: 'Guardian doorway', atmosphere: 'A sealed entrance.', hazard: 'Guardian.' };
      return value;
    });
    const turn = f.game.snapshot(f.c.id, f.host.id).turn!;
    f.game.submit(
      f.c.id,
      f.p1.id,
      turn.id,
      usePotion ? 'Drink Red Potion and inspect the guardian doorway' : 'Inspect the guardian doorway',
      false,
    );
    f.game.submit(f.c.id, f.p2.id, turn.id, '', true);
    await f.game.idle();
    expect(f.game.snapshot(f.c.id, f.host.id).turn).toMatchObject({
      id: turn.id,
      phase: 'failed',
      error: expect.stringContaining('Connection lost'),
    });
    const saved = f.draft(turn.id);
    const savedRolls = f.game.snapshot(f.c.id, f.host.id).turn!.rolls;
    const draws = f.draw.mock.calls.length;
    expect(saved.receipts.startCombat).toBeDefined();
    expect(saved.receipts.combat).toBeUndefined();
    f.db.close();
    const reopened = openDatabase(databasePath);
    cleanup.push(() => reopened.close());
    const restarted = new Game(reopened, f.factory, f.draw);
    restarted.retry(f.c.id, f.host.id);
    await restarted.idle();
    const done = restarted.snapshot(f.c.id, f.host.id).history.at(-1)!;
    expect(done.id).toBe(turn.id);
    expect(done.rolls).toEqual(savedRolls);
    expect(f.draw).toHaveBeenCalledTimes(draws);
    expect(f.provider.planCombat).not.toHaveBeenCalled();
    expect(f.provider.adjudicate).toHaveBeenCalledTimes(2);
    expect(restarted.snapshot(f.c.id, f.host.id).scene.encounter).toEqual(saved.scene.encounter);
    expect(restarted.snapshot(f.c.id, f.host.id).scene.encounter!.round).toBe(1);
    expect(restarted.snapshot(f.c.id, f.host.id).scene.location.name).toBe('Guardian doorway');
    const completedDraft = JSON.parse(
      (reopened.prepare('SELECT draft FROM turns WHERE id = ?').get(turn.id) as { draft: string }).draft,
    );
    expect(completedDraft.receipts.startCombat).toEqual(saved.receipts.startCombat);
    expect(completedDraft.receipts.combat).toBeUndefined();
    if (usePotion) {
      expect(completedDraft.receipts[`resource:item:${actor.id}`]).toEqual(
        saved.receipts[`resource:item:${actor.id}`],
      );
      expect(restarted.members(f.c.id).find((member) => member.id === actor.id)!.state).toMatchObject({
        hp: actor.state.maxHp,
      });
      expect(
        restarted
          .members(f.c.id)
          .find((member) => member.id === actor.id)!
          .state.inventory.some((item) => item.id === potion.id),
      ).toBe(false);
    }
  },
);

it('resumes accepted boarding after a finalization interruption and rejects leaving the ongoing fight before acceptance', async () => {
  const databasePath = temporaryDatabasePath();
  const f = fixture({}, databasePath);
  await f.start();
  const deck = { name: 'Ship deck', atmosphere: 'Salt and smoke.', hazard: 'Armed defenders.' };
  const defender = enemySchema.parse({
    id: 'defender',
    name: 'Defender',
    tier: 'normal',
    hp: 60,
    defense: 10,
    attack: 0,
    damage: '1d4',
    description: 'Guards the helm.',
    tactic: 'Guard',
  });
  f.provider.adjudicate = vi.fn(async (context: GMContext, tools: GameTools) => {
    if (context.turn.number === 1) tools.startCombat([defender]);
    const value = proposal(context);
    value.rewards.xp = 0;
    value.location =
      context.turn.number === 1 ? deck : { name: 'Open sea', atmosphere: 'Clear sky.', hazard: '' };
    return value;
  });
  f.db.exec(
    `CREATE TRIGGER interrupt_boarding BEFORE UPDATE OF draft ON turns WHEN NEW.draft LIKE '%"resolution":%' BEGIN SELECT RAISE(ABORT, 'boarding interrupted'); END;`,
  );
  const id = f.submit();
  await f.game.idle();
  expect(f.game.snapshot(f.c.id, f.host.id).turn!.error).toContain('boarding interrupted');
  const saved = f.draft(id);
  expect(saved.adjudication.location).toEqual(deck);
  expect(saved.resolution).toBeUndefined();
  const rolls = f.game.snapshot(f.c.id, f.host.id).turn!.rolls;
  const draws = f.draw.mock.calls.length;
  f.db.exec('DROP TRIGGER interrupt_boarding');
  f.db.close();
  const reopened = openDatabase(databasePath);
  cleanup.push(() => reopened.close());
  const restarted = new Game(reopened, f.factory, f.draw);
  restarted.retry(f.c.id, f.host.id);
  await restarted.idle();
  const snapshot = restarted.snapshot(f.c.id, f.host.id);
  expect(snapshot.scene.location).toEqual(deck);
  expect(snapshot.scene.encounter).toEqual(saved.scene.encounter);
  expect(snapshot.scene.encounter!.round).toBe(1);
  expect(snapshot.history.at(-1)!.rolls).toEqual(rolls);
  expect(f.provider.adjudicate).toHaveBeenCalledTimes(1);
  expect(f.draw).toHaveBeenCalledTimes(draws);
  restarted.submit(f.c.id, f.p1.id, snapshot.turn!.id, 'Move toward the helm', false);
  restarted.submit(f.c.id, f.p2.id, snapshot.turn!.id, '', true);
  await restarted.idle();
  const failed = restarted.snapshot(f.c.id, f.host.id).turn!;
  expect(failed.error).toContain('adjudication: The party cannot leave an active combat');
  const draft = JSON.parse(restarted.pending(f.c.id)!.draft!);
  expect(draft.adjudication).toBeUndefined();
  expect(draft.receipts.combat).toBeDefined();
  expect(restarted.snapshot(f.c.id, f.host.id).scene.location).toEqual(deck);
});

it.each(['revived non-roster', 'injured inactive'] as const)(
  'preserves the actual healing recipient for a %s ally across a narration restart',
  async (mode) => {
    const databasePath = temporaryDatabasePath();
    const f = fixture({}, databasePath);
    await f.start();
    const [actor, target] = f.game.members(f.c.id);
    const potion = { ...baseItem('potion', 'Red Potion', 'consumable'), healing: 4, quantity: 1 };
    actor.state.inventory.push(potion);
    target.state.hp = mode === 'revived non-roster' ? 0 : target.state.maxHp - 4;
    if (mode === 'revived non-roster') target.state.conditions.push('Downed');
    f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(actor.state), actor.id);
    f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(target.state), target.id);
    const turn = f.game.snapshot(f.c.id, f.host.id).turn!;
    if (mode === 'injured inactive') f.game.setActive(f.c.id, f.host.id, target.id, false);
    else f.db.prepare('UPDATE turns SET roster = ? WHERE id = ?').run(JSON.stringify([actor.id]), turn.id);
    f.provider.adjudicate = vi.fn(async (context: GMContext, tools: GameTools) => {
      tools.useResource!({ memberId: actor.id, itemId: potion.id, abilityName: null, targetId: target.id });
      expect(context.members.find((member) => member.id === target.id)).toMatchObject({
        character: { name: 'Zafir al-Raml' },
        state: { hp: target.state.hp + 4 },
      });
      return proposal(context);
    });
    const narrate = f.provider.narrate!;
    f.provider.narrate = vi.fn(async () => {
      throw new Error('Narration interrupted.');
    });
    f.game.submit(f.c.id, f.p1.id, turn.id, 'Use Red Potion to heal Zafir al-Raml', false);
    await f.game.idle();
    const saved = f.draft(turn.id);
    expect(f.game.snapshot(f.c.id, f.host.id).turn!.error).toContain('narration:');
    const healing = saved.resolution.events.find((event: { id: string }) => event.id.startsWith('resource:'));
    expect(healing.fact).toContain('Zafir al-Raml recovers 4 HP');
    expect(healing.fact).not.toContain('Amon-Sah recovers');
    expect(saved.resolution.actions.map((action: { memberId: string }) => action.memberId)).toEqual([
      actor.id,
    ]);
    expect(saved.receipts.executionEvents.find((event: { id: string }) => event.id === healing.id)).toEqual(
      healing,
    );
    const savedMembers = saved.members;
    const draws = f.draw.mock.calls.length;
    f.provider.narrate = narrate;
    f.db.close();
    const reopened = openDatabase(databasePath);
    cleanup.push(() => reopened.close());
    const restarted = new Game(reopened, f.factory, f.draw);
    restarted.retry(f.c.id, f.host.id);
    await restarted.idle();
    const done = restarted.snapshot(f.c.id, f.host.id).history.at(-1)!;
    expect(done.id).toBe(turn.id);
    expect(done.result!.narration).toContain('Zafir al-Raml recovers 4 HP');
    expect(restarted.members(f.c.id).map((member) => member.state)).toEqual(
      savedMembers.map((member: { state: unknown }) => member.state),
    );
    expect(f.provider.adjudicate).toHaveBeenCalledTimes(1);
    expect(f.draw).toHaveBeenCalledTimes(draws);
    expect(
      restarted.members(f.c.id).find((member) => member.id === target.id)!.state.conditions,
    ).not.toContain('Downed');
  },
);

it.each(['failure', 'blocked'] as const)(
  'keeps a %s main action separate from a successful minor potion',
  async (mainStatus) => {
    const f = fixture();
    await f.start();
    const actor = f.game.members(f.c.id)[0];
    actor.state.hp -= 4;
    const potion = { ...baseItem('potion', 'Red Potion', 'consumable'), healing: 4, quantity: 1 };
    actor.state.inventory.push(potion);
    f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(actor.state), actor.id);
    f.provider.adjudicate = async (context, tools) => {
      tools.useResource!({ memberId: actor.id, itemId: potion.id, abilityName: null, targetId: null });
      return changeMain(proposal(context), actor.id, mainStatus, 'The sealed closure remains locked.');
    };
    const turn = f.game.snapshot(f.c.id, f.host.id).turn!;
    f.game.submit(f.c.id, f.p1.id, turn.id, 'Drink Red Potion and open the sealed closure', false);
    f.game.submit(f.c.id, f.p2.id, turn.id, '', true);
    await f.game.idle();
    const done = f.game.snapshot(f.c.id, f.host.id).history.at(-1)!;
    expect(done.id).toBe(turn.id);
    expect(done.resolution!.actions[0]).toMatchObject({
      status: 'partial',
      basis: 'routine',
      components: {
        main: { status: mainStatus, basis: 'routine' },
        minor: { status: 'success', basis: 'engine' },
      },
    });
    expect(f.game.members(f.c.id)[0].state.hp).toBe(actor.state.maxHp);
    expect(f.game.members(f.c.id)[0].state.inventory.some((item) => item.id === potion.id)).toBe(false);
    expect(done.result!.narration).toContain('remains locked');
  },
);

it('allows potion-only intent without inventing a main action', async () => {
  const f = fixture();
  await f.start();
  const actor = f.game.members(f.c.id)[0];
  actor.state.hp -= 4;
  const potion = { ...baseItem('potion', 'Red Potion', 'consumable'), healing: 4, quantity: 1 };
  actor.state.inventory.push(potion);
  f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(actor.state), actor.id);
  f.provider.adjudicate = async (context, tools) => {
    tools.useResource!({ memberId: actor.id, itemId: potion.id, abilityName: null, targetId: null });
    const value = proposal(context);
    const action = value.actions.find((action) => action.memberId === actor.id)!;
    const removed = new Set(action.components.main!.eventIds);
    value.events = value.events
      .filter((event) => !removed.has(event.id))
      .map((event, sequence) => ({ ...event, sequence }));
    action.components.main = null;
    action.eventIds = action.eventIds.filter((id) => !removed.has(id));
    action.fact = action.components.minor!.fact;
    Object.assign(action, aggregateComponents(action.components));
    return value;
  };
  const turn = f.game.snapshot(f.c.id, f.host.id).turn!;
  f.game.submit(f.c.id, f.p1.id, turn.id, 'Drink Red Potion', false);
  f.game.submit(f.c.id, f.p2.id, turn.id, '', true);
  await f.game.idle();
  const done = f.game.snapshot(f.c.id, f.host.id).history.at(-1)!;
  expect(done.id).toBe(turn.id);
  expect(done.resolution!.actions[0]).toMatchObject({
    status: 'success',
    basis: 'engine',
    components: { main: null, minor: { status: 'success', basis: 'engine' } },
  });
  expect(
    done.resolution!.events.some(
      (event) => event.memberId === actor.id && 'phase' in event && event.phase === 'main',
    ),
  ).toBe(false);
});

it.each(['check first', 'potion first'] as const)(
  'permits a failed checked main plus a self potion without promoting the check: %s',
  async (order) => {
    const f = fixture();
    await f.start();
    const actor = f.game.members(f.c.id)[0];
    actor.state.hp -= 4;
    const potion = { ...baseItem('potion', 'Red Potion', 'consumable'), healing: 4, quantity: 1 };
    actor.state.inventory.push(potion);
    f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(actor.state), actor.id);
    f.draw.mockImplementation(() => 2);
    f.provider.adjudicate = async (context, tools) => {
      const check = () =>
        tools({
          memberId: actor.id,
          stat: 'INT',
          dc: 20,
          mode: 'normal',
          lethal: false,
          reason: 'Study the uncertain lock mechanism.',
        });
      const heal = () =>
        tools.useResource!({ memberId: actor.id, itemId: potion.id, abilityName: null, targetId: null });
      if (order === 'check first') {
        check();
        heal();
      } else {
        heal();
        check();
      }
      return proposal(context);
    };
    const turn = f.game.snapshot(f.c.id, f.host.id).turn!;
    f.game.submit(f.c.id, f.p1.id, turn.id, 'Investigate the lock and drink Red Potion', false);
    f.game.submit(f.c.id, f.p2.id, turn.id, '', true);
    await f.game.idle();
    const done = f.game.snapshot(f.c.id, f.host.id).history.at(-1)!;
    expect(done.id).toBe(turn.id);
    expect(done.resolution!.actions[0]).toMatchObject({
      status: 'partial',
      basis: 'check',
      components: {
        main: { status: 'failure', basis: 'check' },
        minor: { status: 'success', basis: 'engine' },
      },
    });
    expect(done.rolls).toHaveLength(1);
    expect(done.rolls[0].success).toBe(false);
    expect(f.game.members(f.c.id)[0].state.hp).toBe(actor.state.maxHp);
    const mechanical = done.resolution!.events.filter((event) => event.receiptRefs.length);
    expect(mechanical[0].id.startsWith(order === 'check first' ? 'check:' : 'resource:')).toBe(true);
  },
);

it('rejects an unknown explicit resource target before spending the item', async () => {
  const f = fixture();
  await f.start();
  const actor = f.game.members(f.c.id)[0];
  const potion = { ...baseItem('potion', 'Red Potion', 'consumable'), healing: 4, quantity: 1 };
  actor.state.inventory.push(potion);
  f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(actor.state), actor.id);
  f.provider.adjudicate = async (_context, tools) => {
    expect(() =>
      tools.useResource!({
        memberId: actor.id,
        itemId: potion.id,
        abilityName: null,
        targetId: randomUUID(),
      }),
    ).toThrow('Choose an ally');
    throw new Error('No item spent for the invalid recipient.');
  };
  const turn = f.game.snapshot(f.c.id, f.host.id).turn!;
  f.game.submit(f.c.id, f.p1.id, turn.id, 'Use Red Potion on an ally', false);
  f.game.submit(f.c.id, f.p2.id, turn.id, '', true);
  await f.game.idle();
  const saved = f.draft(turn.id);
  expect(f.game.snapshot(f.c.id, f.host.id).turn!.error).toContain('No item spent');
  expect(saved.members[0].state.inventory.some((item: { id: string }) => item.id === potion.id)).toBe(true);
  expect(Object.keys(saved.receipts).some((key) => key.startsWith('resource:'))).toBe(false);
});

it.each(['successful check', 'failed check', 'routine act'] as const)(
  'uses executed/current authority after an ally Cleanse, for a %s',
  async (mode) => {
    const f = fixture();
    await f.start();
    const [actor, target] = f.game.members(f.c.id);
    actor.character.abilities.push({
      name: 'Cleanse Stun',
      description: 'Remove Stunned from a living ally.',
      kind: 'combat',
      effect: 'cleanse',
      level: 1,
      stat: 'WIS',

      cures: ['Stunned'],
    });
    applyCondition(target.state, 'Stunned');
    f.db.prepare('UPDATE members SET sheet = ? WHERE id = ?').run(JSON.stringify(actor.character), actor.id);
    f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(target.state), target.id);
    if (mode === 'failed check') f.draw.mockImplementation(() => 2);
    f.provider.adjudicate = async (context, tools) => {
      tools.useResource!({
        memberId: actor.id,
        itemId: null,
        abilityName: 'Cleanse Stun',
        targetId: target.id,
      });
      if (mode !== 'routine act')
        tools({
          memberId: target.id,
          stat: 'INT',
          dc: 10,
          mode: 'normal',
          lethal: false,
          reason: 'Read the inscriptions after the ally removes Stunned.',
        });
      return proposal(context);
    };
    const turn = f.game.snapshot(f.c.id, f.host.id).turn!;
    f.game.submit(f.c.id, f.p1.id, turn.id, 'Use Cleanse Stun on Zafir al-Raml', false);
    f.game.submit(f.c.id, f.p2.id, turn.id, 'Read the inscriptions', false);
    await f.game.idle();
    const done = f.game.snapshot(f.c.id, f.host.id).history.at(-1)!;
    expect(done.id).toBe(turn.id);
    expect(done.resolution!.actions.find((action) => action.memberId === target.id)).toMatchObject({
      status: mode === 'failed check' ? 'failure' : 'success',
      components: {
        main: {
          status: mode === 'failed check' ? 'failure' : 'success',
          basis: mode === 'routine act' ? 'routine' : 'check',
        },
      },
    });
    expect(
      f.draft(turn.id).startingMembers.find((member: { id: string }) => member.id === target.id).state
        .conditions,
    ).toContain('Stunned');
    expect(f.game.members(f.c.id).find((member) => member.id === target.id)!.state.conditions).not.toContain(
      'Stunned',
    );
    expect(
      f.game.members(f.c.id).find((member) => member.id === actor.id)!.state.abilityUses!['Cleanse Stun'],
    ).toBe(1);
    expect(done.rolls.filter((roll) => !roll.notation)).toHaveLength(mode === 'routine act' ? 0 : 1);
  },
);

it('retains a lethal failed main check after the executed check downs its actor', async () => {
  const f = fixture();
  await f.start();
  const actor = f.game.members(f.c.id)[0];
  f.draw.mockImplementation(() => 1);
  f.provider.adjudicate = async (context, tools) => {
    tools({
      memberId: actor.id,
      stat: 'DEX',
      dc: 10,
      mode: 'normal',
      lethal: true,
      reason: 'Cross the exposed deadly chasm.',
    });
    return proposal(context);
  };
  const turn = f.game.snapshot(f.c.id, f.host.id).turn!;
  f.game.submit(f.c.id, f.p1.id, turn.id, 'Cross the exposed deadly chasm', false);
  f.game.submit(f.c.id, f.p2.id, turn.id, '', true);
  await f.game.idle();
  const done = f.game.snapshot(f.c.id, f.host.id).history.at(-1)!;
  expect(done.id).toBe(turn.id);
  expect(done.resolution!.actions[0]).toMatchObject({
    status: 'failure',
    components: { main: { status: 'failure', basis: 'check' } },
  });
  expect(done.rolls[0]).toMatchObject({ dice: [1], success: false, critical: 'failure', lethal: true });
  expect(f.game.members(f.c.id)[0].state).toMatchObject({
    hp: 0,
    conditions: expect.arrayContaining(['Downed']),
  });
  expect(
    done.resolution!.events.some(
      (event) => 'phase' in event && event.phase === 'aftermath' && event.fact.includes('Downed'),
    ),
  ).toBe(true);
});

it.each(['ability first', 'ally item first'] as const)(
  'rejects a second main resource before consuming it: %s',
  async (order) => {
    const f = fixture();
    await f.start();
    const [actor, target] = f.game.members(f.c.id);
    const potion = { ...baseItem('potion', 'Red Potion', 'consumable'), healing: 4, quantity: 1 };
    actor.state.inventory.push(potion);
    actor.character.abilities.push({
      name: 'Mend Ally',
      description: 'Heal one living ally.',
      kind: 'combat',
      effect: 'mend',
      level: 1,
      stat: 'WIS',
    });
    target.state.hp -= 8;
    f.db
      .prepare('UPDATE members SET state = ?, sheet = ? WHERE id = ?')
      .run(JSON.stringify(actor.state), JSON.stringify(actor.character), actor.id);
    f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(target.state), target.id);
    const uses = [
      { memberId: actor.id, itemId: null, abilityName: 'Mend Ally', targetId: target.id },
      { memberId: actor.id, itemId: potion.id, abilityName: null, targetId: target.id },
    ];
    if (order === 'ally item first') uses.reverse();
    let firstRestored = 0;
    f.provider.adjudicate = async (_context, tools) => {
      const first = tools.useResource!(uses[0]);
      firstRestored = first.restored;
      expect(tools.useResource!(uses[0])).toEqual(first);
      const draws = f.draw.mock.calls.length;
      expect(() => tools.useResource!(uses[1])).toThrow(/main action/i);
      expect(f.draw).toHaveBeenCalledTimes(draws);
      throw new Error('Inspect the preserved first main receipt.');
    };
    const turn = f.game.snapshot(f.c.id, f.host.id).turn!;
    f.game.submit(f.c.id, f.p1.id, turn.id, 'Use Mend Ally and Red Potion on Zafir al-Raml', false);
    f.game.submit(f.c.id, f.p2.id, turn.id, '', true);
    await f.game.idle();
    expect(f.game.snapshot(f.c.id, f.host.id).turn!.error).toContain('Inspect the preserved');
    const saved = f.draft(turn.id);
    expect(Object.keys(saved.receipts).filter((key) => key.startsWith('resource:'))).toHaveLength(1);
    const savedActor = saved.members.find((member: { id: string }) => member.id === actor.id);
    expect(savedActor.state.abilityUses['Mend Ally'] ?? 0).toBe(order === 'ability first' ? 1 : 0);
    expect(savedActor.state.inventory.some((item: { id: string }) => item.id === potion.id)).toBe(
      order === 'ability first',
    );
    expect(saved.members.find((member: { id: string }) => member.id === target.id).state.hp).toBe(
      target.state.hp + firstRestored,
    );
  },
);

it.each(['Stunned', 'Frozen', 'Electrocuted'] as const)(
  'applies the current %s restriction to a self consumable before spending it',
  async (condition) => {
    const f = fixture();
    await f.start();
    const actor = f.game.members(f.c.id)[0];
    actor.state.hp -= 4;
    applyCondition(actor.state, condition);
    const potion = { ...baseItem('potion', 'Red Potion', 'consumable'), healing: 4, quantity: 1 };
    actor.state.inventory.push(potion);
    f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(actor.state), actor.id);
    f.provider.adjudicate = async (context, tools) => {
      const use = { memberId: actor.id, itemId: potion.id, abilityName: null, targetId: null };
      if (condition === 'Stunned') {
        tools.useResource!(use);
        return proposal(context);
      }
      expect(() => tools.useResource!(use)).toThrow('incapacitated');
      throw new Error('The prohibited minor action spent no source.');
    };
    const turn = f.game.snapshot(f.c.id, f.host.id).turn!;
    f.game.submit(f.c.id, f.p1.id, turn.id, 'Drink Red Potion and open the closure', false);
    f.game.submit(f.c.id, f.p2.id, turn.id, '', true);
    await f.game.idle();
    const saved = f.draft(turn.id);
    if (condition === 'Stunned') {
      const done = f.game.snapshot(f.c.id, f.host.id).history.at(-1)!;
      expect(done.id).toBe(turn.id);
      expect(done.resolution!.actions[0]).toMatchObject({
        status: 'partial',
        components: {
          main: { status: 'blocked', basis: 'none' },
          minor: { status: 'success', basis: 'engine' },
        },
      });
    } else {
      expect(f.game.snapshot(f.c.id, f.host.id).turn!.error).toContain('spent no source');
      expect(Object.keys(saved.receipts).some((key) => key.startsWith('resource:'))).toBe(false);
      expect(saved.members[0].state.inventory.some((item: { id: string }) => item.id === potion.id)).toBe(
        true,
      );
      expect(saved.members[0].state.hp).toBe(actor.state.hp);
    }
  },
);

it.each(['alarm', 'clue'] as const)(
  'allows a failed action to cause an %s without fulfilling a success prerequisite',
  (consequence) => {
    const c = context();
    c.turn.actions = [c.turn.actions[0]];
    c.turn.roster = [c.members[0].id];
    const value = changeMain(proposal(c), c.members[0].id, 'failure', 'The lock jams before it opens.');
    const event = value.events.find((event) => event.kind === 'world')!;
    event.fact =
      consequence === 'alarm'
        ? 'The jammed lock triggers the existing alarm.'
        : 'The failed search shakes loose a previously hidden clue.';
    event.dependsOn = [{ eventId: 'act:0', requires: 'occurrence' }];
    expect(() => validateAdjudication(c, value)).not.toThrow();
    event.dependsOn[0].requires = 'success';
    expect(() => validateAdjudication(c, value)).toThrow(/success|prerequisite/i);
  },
);

it('does not let a successful minor potion satisfy a failed main effect dependency', () => {
  const c = context();
  c.turn.actions = [c.turn.actions[0]];
  c.turn.roster = [c.members[0].id];
  const actor = c.members[0];
  c.receipts![`resource:item:${actor.id}`] = {
    memberId: actor.id,
    itemId: 'potion',
    abilityName: null,
    targetId: actor.id,
    sourceName: 'Red Potion',
    restored: 4,
    cured: [],
    slot: 'minor',
    state: actor.state,
    targetState: actor.state,
  };
  const value = changeMain(proposal(c), actor.id, 'failure', 'The sealed closure remains locked.');
  expect(value.actions[0].status).toBe('partial');
  value.events.find((event) => event.kind === 'world')!.dependsOn = [
    { eventId: 'act:0', requires: 'success' },
  ];
  expect(() => validateAdjudication(c, value)).toThrow(/success|prerequisite/i);
});

it('allows a fulfilled effect in a partial routine action to support a dependency', () => {
  const c = context();
  c.turn.actions = [c.turn.actions[0]];
  c.turn.roster = [c.members[0].id];
  const value = changeMain(
    proposal(c),
    c.members[0].id,
    'partial',
    'The closure unlocks, but the heavy door cannot yet be moved.',
  );
  value.events[0].result = 'success';
  value.events[1].dependsOn = [{ eventId: 'act:0', requires: 'success' }];
  expect(() => validateAdjudication(c, value)).not.toThrow();
});

it.each(['unknown', 'duplicate', 'self', 'forward'] as const)(
  'rejects an invalid %s event dependency',
  (kind) => {
    const c = context();
    const value = proposal(c);
    if (kind === 'unknown') value.events[1].dependsOn = [{ eventId: 'missing', requires: 'occurrence' }];
    if (kind === 'duplicate') value.events[1].dependsOn.push({ eventId: 'act:0', requires: 'occurrence' });
    if (kind === 'self') value.events[1].dependsOn = [{ eventId: 'act:1', requires: 'occurrence' }];
    if (kind === 'forward') value.events[0].dependsOn = [{ eventId: 'act:1', requires: 'occurrence' }];
    expect(() => validateAdjudication(c, value)).toThrow();
  },
);

it('rejects a fictional successful main effect after the authoritative failed check', () => {
  const c = context();
  c.turn.actions = [c.turn.actions[0]];
  c.turn.roster = [c.members[0].id];
  c.turn.rolls.push({
    memberId: 'm0',
    id: 'failed-check',
    dice: [2],
    modifier: 0,
    total: 2,
    success: false,
    source: 'test',
    stat: 'INT',
    dc: 10,
    mode: 'normal',
    reason: 'Attempt the sealed closure.',
    lethal: false,
  });
  const value = proposal(c);
  const action = value.actions[0];
  const id = 'invented-unlock';
  value.events.push({
    id,
    sequence: value.events.length,
    kind: 'action',
    memberId: 'm0',
    actionId: action.actionId,
    phase: 'main',
    result: 'success',
    fact: 'The failed check nevertheless unlocks the closure.',
    receiptRefs: [],
    dependsOn: [],
  });
  action.eventIds.push(id);
  action.components.main!.eventIds.push(id);
  expect(() => validateAdjudication(c, value)).toThrow();
});

it('saves environmental mechanics before rolling and preserves shots, damage and rolls through restart/retry', async () => {
  const path = temporaryDatabasePath();
  const practice = new PracticeGM();
  const f = fixture({ adjudicate: practice.adjudicate.bind(practice) }, path);
  await f.start();
  const [actor, ally] = f.game.members(f.c.id);
  const scene = f.game.snapshot(f.c.id, f.host.id).scene;
  scene.encounter = {
    enemies: [
      {
        ...enemySchema.parse({
          id: 'harpooner',
          name: 'Asgrijze Boegharpoenier',
          tier: 'normal',
          hp: 30,
          defense: 10,
          attack: 0,
          damage: '1d4',
          description: '',
          tactic: '',
        }),
        maxHp: 30,
        initiative: 1,
      },
    ],
    round: 1,
    victory: false,
    escaped: false,
    initiative: [
      { id: actor.id, total: 15 },
      { id: ally.id, total: 10 },
      { id: 'harpooner', total: 1 },
    ],
  };
  f.db.prepare('UPDATE campaigns SET scene = ? WHERE id = ?').run(JSON.stringify(scene), f.c.id);
  const evidence =
    'The mounted cannon is loaded with a dry charge and chain shot and aimed at the enemy ship.';
  f.db.prepare('INSERT INTO journal VALUES(?, ?, ?, ?)').run(f.c.id, 'fact', 'Prepared cannon', evidence);
  const profile: EnvironmentalAction = {
    sourceId: 'journal:fact:Prepared cannon',
    name: 'Mounted cannon',
    evidence,
    operation: 'attack',
    roll: 'defense',
    damage: '2d6',
    damageBonus: 1,
    consumption: 'reload',
    reloadSourceId: null,
    reloadEvidence: null,
  };
  const planner = vi.fn(async (context: GMContext) =>
    normalizeCombatInput(context, {
      actions: [
        {
          memberId: actor.id,
          main: 'creative',
          effect: 'damage',
          stat: 'INT',
          targetId: 'harpooner',
          environment: profile,
        },
      ],
    }),
  );
  f.provider.planCombat = planner;
  f.provider.narrate = async () => {
    throw new Error('Controlled presentation interruption');
  };
  const turn = f.game.snapshot(f.c.id, f.host.id).turn!;
  f.draw.mockImplementation((sides) => {
    expect(f.draft(turn.id).receipts.combatInput.actions[0].environment).toEqual(profile);
    return sides === 20 ? 12 : 3;
  });
  f.game.submit(f.c.id, f.p1.id, turn.id, 'Knal de boegharpoenier volle bak met het kannon', false);
  f.game.submit(f.c.id, f.p2.id, turn.id, '', true);
  await f.game.idle();
  const failed = f.game.snapshot(f.c.id, f.host.id).turn!;
  expect(failed.phase).toBe('failed');
  expect(f.draft(turn.id).scene.encounter.enemies[0].hp).toBe(23);
  expect(f.draft(turn.id).scene.environment.sources[profile.sourceId].ready).toBe(false);
  const saved = structuredClone(f.draft(turn.id).receipts);
  const draws = f.draw.mock.calls.length;
  f.db.close();
  const reopened = openDatabase(path);
  cleanup.push(() => reopened.close());
  f.provider.narrate = practice.narrate.bind(practice);
  const restarted = new Game(reopened, f.factory, f.draw);
  restarted.retry(f.c.id, f.host.id);
  await restarted.idle();
  const snapshot = restarted.snapshot(f.c.id, f.host.id);
  const done = snapshot.history.at(-1)!;
  expect(done.id).toBe(turn.id);
  expect(done.phase).toBe('complete');
  expect(done.rolls).toEqual(failed.rolls);
  expect(planner).toHaveBeenCalledTimes(1);
  expect(f.draw).toHaveBeenCalledTimes(draws);
  expect(snapshot.scene.encounter!.enemies[0].hp).toBe(23);
  expect(snapshot.scene.environment!.sources[profile.sourceId]).toEqual({ profile, ready: false });
  expect(done.result!.narration).toContain('takes 7 damage');
  expect(done.result!.narration).toContain('needs reloading');
  const receipts = JSON.parse(
    (reopened.prepare('SELECT draft FROM turns WHERE id = ?').get(turn.id) as { draft: string }).draft,
  ).receipts;
  expect(receipts.combatInput).toEqual(saved.combatInput);
  expect(receipts.combat).toEqual(saved.combat);
});

it('gives the model grounded environmental profile options and blocks oversized proposals without another request', async () => {
  const c = context();
  c.journal.push({
    kind: 'fact',
    name: 'Loaded cannon',
    detail: 'A loaded mounted cannon stands ready beside the fighting crew.',
  });
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    expect(body.instructions).toContain('Never replace that source with the character');
    expect(body.instructions).toContain('Earlier successfully loaded/aimed weapons remain prepared');
    const input = JSON.parse(body.input[0].content);
    expect(input.environmentalFacts['journal:fact:Loaded cannon']).toBe(c.journal.at(-1)!.detail);
    const proposed = input.schemaExample;
    proposed.actions[0] = {
      ...proposed.actions[0],
      main: 'creative',
      effect: 'damage',
      environment: {
        ...input.environmentExample,
        sourceId: 'journal:fact:Loaded cannon',
        name: 'Mounted cannon',
        evidence: c.journal.at(-1)!.detail,
        damage: '4d12',
      },
    };
    return completed(proposed);
  }) as unknown as typeof fetch;
  c.members.forEach((member) => {
    const old = member.id;
    member.id = randomUUID();
    c.turn.actions.find((action) => action.memberId === old)!.memberId = member.id;
  });
  c.turn.roster = c.members.map((member) => member.id);
  c.turn.actions[0].text = 'Fire the cannon.';
  c.requestBudget = { used: 0, limit: 8 };
  const plan = await new ChatGPTGM(auth, 'owner', 'model', fetcher).planCombat(c);
  expect(plan.actions[0]).toMatchObject({
    main: 'creative',
    effect: 'damage',
    blockedReason: expect.any(String),
  });
  expect(plan.actions[0].environment).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(c.requestBudget.corrections).toContainEqual(
    expect.objectContaining({ feedback: expect.stringContaining('Environmental proposal rejected:') }),
  );
});
