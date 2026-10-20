import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openDatabase } from '../server/db';
import { Game, type GameMaster, type GMContext, type GameTools } from '../server/game';
import { PracticeGM, ChatGPTGM } from '../server/providers';
import type { ChatGPTAuth } from '../server/auth';
import { applyCondition, baseItem } from '../shared/rules';
import { templateCharacter, type CampaignConfig } from '../shared/schema';
import { actionId, factualNarration, type TurnAdjudication } from '../shared/turn-resolution';

const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
const config: CampaignConfig = {
  ruleset: 'roguelike-v1',
  name: 'Recovery',
  setting: 'A quiet sanctuary',
  premise: '',
  tone: '',
  language: 'English',
  instructions: '',
  custom: [],
  provider: 'practice',
  model: '',
};

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'gather-recovery-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'game.sqlite');
  const db = openDatabase(filename);
  cleanup.push(() => {
    if (db.open) db.close();
  });
  const practice = new PracticeGM();
  const adjudicate = vi.fn(async (context: GMContext, tools: GameTools) => {
    const result = await practice.adjudicate(context, tools);
    if (context.turn.number) {
      result.rewards = { xp: 10, gold: 0, reason: 'A new sanctuary clue is established.' };
      result.events.push({
        id: 'world:clue',
        sequence: result.events.length,
        kind: 'world',
        memberId: null,
        actionId: null,
        phase: null,
        result: null,
        fact: 'The sanctuary contains a map of the old wells.',
        receiptRefs: [],
        dependsOn: [],
      });
    }
    return result;
  });
  const narrate = vi.fn(practice.narrate.bind(practice));
  const provider: GameMaster = { adjudicate, narrate };
  const draw = vi.fn((sides: number) => Math.min(12, sides));
  const game = new Game(db, () => provider, draw);
  const host = game.identify();
  const players = [game.identify(), game.identify()];
  const campaign = game.create(host.id, config);
  for (const [index, player] of players.entries()) {
    const character = game.saveCharacter(player.id, templateCharacter(index ? 'Zafir' : 'Amon'));
    game.join(campaign.inviteCode!, player.id, character.id);
    const member = game.members(campaign.id).find((member) => member.playerId === player.id)!;
    game.manageCharacter(campaign.id, player.id, {
      type: 'starter',
      itemIds: member.state.starterEquipment.slice(0, 2).map((item) => item.id),
    });
  }
  game.start(campaign.id, host.id);
  await game.idle();
  expect(game.snapshot(campaign.id, host.id).turn!.phase).toBe('collecting');
  const [actor, target] = game.members(campaign.id);
  const potion = { ...baseItem('recovery-potion', 'Red Potion', 'consumable'), healing: 4, quantity: 1 };
  actor.state.inventory.push(potion);
  applyCondition(actor.state, 'Poisoned');
  target.state.hp = 0;
  target.state.conditions.push('Downed');
  for (const member of [actor, target])
    db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(member.state), member.id);
  const turnId = game.snapshot(campaign.id, host.id).turn!.id;
  db.prepare('UPDATE turns SET roster = ? WHERE id = ?').run(JSON.stringify([actor.id]), turnId);
  const draft = () =>
    JSON.parse((db.prepare('SELECT draft FROM turns WHERE id = ?').get(turnId) as { draft: string }).draft);
  const save = (value: unknown) =>
    db.prepare('UPDATE turns SET draft = ? WHERE id = ?').run(JSON.stringify(value), turnId);
  const submit = () => game.submit(campaign.id, players[0].id, turnId, 'Use Red Potion on Zafir', false);
  const restart = () => {
    db.close();
    const reopened = openDatabase(filename);
    cleanup.push(() => {
      if (reopened.open) reopened.close();
    });
    return { db: reopened, game: new Game(reopened, () => provider, draw) };
  };
  return {
    db,
    game,
    host,
    campaign,
    actor,
    target,
    potion,
    turnId,
    draft,
    save,
    submit,
    restart,
    provider,
    practice,
    adjudicate,
    narrate,
    draw,
  };
}

function pauseNarration(f: Awaited<ReturnType<typeof fixture>>) {
  f.db.exec(
    `CREATE TRIGGER interrupt_narration BEFORE UPDATE OF draft ON turns WHEN NEW.draft LIKE '%"narration":%' BEGIN SELECT RAISE(ABORT, 'narration checkpoint interrupted'); END;`,
  );
}

it.each(['writing-timeout', 'writing-disconnect', 'review-timeout', 'review-http'])(
  'publishes finalized gameplay once after a %s failure',
  async (failure) => {
    const f = await fixture();
    const callsBefore = f.adjudicate.mock.calls.length;
    let requests = 0;
    const fetcher = vi.fn(async () => {
      if (failure.startsWith('writing') || ++requests > 1) {
        if (failure.endsWith('timeout'))
          throw new DOMException('Provider deadline exceeded.', 'TimeoutError');
        if (failure.endsWith('http')) return new Response('Service unavailable', { status: 503 });
        throw new TypeError('fetch failed');
      }
      const saved = f.draft();
      const candidate = factualNarration(saved.resolution, 'English');
      return new Response(
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [
              { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(candidate) }] },
            ],
          },
        })}\n\n`,
      );
    }) as unknown as typeof fetch;
    const gm = new ChatGPTGM(
      { accessToken: async () => 'test' } as unknown as ChatGPTAuth,
      'owner',
      'test',
      fetcher,
    );
    f.provider.narrate = gm.narrate.bind(gm);
    f.submit();
    await f.game.idle();
    const snapshot = f.game.snapshot(f.campaign.id, f.host.id),
      done = snapshot.history.at(-1)!;
    expect(snapshot.turn!.phase, snapshot.turn!.error ?? '').toBe('collecting');
    expect(done.id).toBe(f.turnId);
    expect(done.result!.narration).toContain('Zafir');
    expect(done.result!.narration).not.toContain('Provider deadline');
    expect(f.adjudicate).toHaveBeenCalledTimes(callsBefore + 1);
    expect(fetcher).toHaveBeenCalledTimes(failure.startsWith('writing') ? 1 : 2);
    expect(snapshot.members.find((member) => member.id === f.target.id)!.state.hp).toBe(4);
    expect(
      snapshot.members
        .find((member) => member.id === f.actor.id)!
        .state.inventory.some((item) => item.id === f.potion.id),
    ).toBe(false);
    expect(f.draw).not.toHaveBeenCalled();
    const stage = f.db
      .prepare("SELECT payload FROM events WHERE turn_id=? AND kind='stage:narration'")
      .all(f.turnId) as { payload: string }[];
    expect(stage).toHaveLength(1);
    expect(JSON.parse(stage[0].payload).fallback).toContain('Narration unavailable');
    expect(
      f.db
        .prepare("SELECT COUNT(*) AS total FROM events WHERE turn_id=? AND kind='turn_auto_retry'")
        .get(f.turnId),
    ).toEqual({ total: 0 });
  },
);

function asV1(draft: any) {
  const legacyEvents = (events: any[]) =>
    events.map(({ phase: _phase, result: _result, ...event }) => ({
      ...event,
      dependsOn: event.dependsOn.map((dependency: any) =>
        typeof dependency === 'string' ? dependency : dependency.eventId,
      ),
    }));
  for (const checkpoint of [draft.adjudication, draft.resolution]) {
    if (!checkpoint) continue;
    checkpoint.version = 1;
    checkpoint.actions = checkpoint.actions.map(({ components: _components, ...action }: any) => action);
    checkpoint.events = legacyEvents(checkpoint.events);
  }
  if (draft.receipts.executionEvents)
    draft.receipts.executionEvents = legacyEvents(draft.receipts.executionEvents);
  for (const [key, receipt] of Object.entries(draft.receipts))
    if (key.startsWith('resource:')) delete (receipt as any).slot;
  delete draft.resolutionRevision;
  delete draft.narrationRevision;
  return draft;
}

function wrongRecipient(draft: any) {
  const event = (draft.adjudication?.events ?? draft.receipts.executionEvents).find((event: any) =>
    event.id.startsWith('resource:'),
  );
  const correct = event.fact as string;
  const wrong = correct.replace('; Zafir recovers ', '; Amon recovers ');
  expect(wrong).not.toBe(correct);
  for (const events of [draft.receipts.executionEvents, draft.adjudication?.events, draft.resolution?.events])
    for (const event of events ?? []) if (event.fact === correct) event.fact = wrong;
  for (const checkpoint of [draft.adjudication, draft.resolution])
    for (const action of checkpoint?.actions ?? []) {
      if (action.fact === correct) action.fact = wrong;
      for (const component of Object.values(action.components ?? {}) as any[])
        if (component?.fact === correct) component.fact = wrong;
    }
  if (draft.resolution)
    draft.resolution.factualRecap = draft.resolution.factualRecap.replaceAll(correct, wrong);
  if (draft.narration?.version === 1)
    for (const [id, text] of Object.entries(draft.narration.eventNarrations))
      if (text === correct) draft.narration.eventNarrations[id] = wrong;
  if (draft.narration?.version === 2)
    for (const passage of draft.narration.passages) passage.text = passage.text.replaceAll(correct, wrong);
  return { correct, wrong, eventId: event.id as string };
}

it('repairs a cached v1 recipient fact before continuing adjudication, without another item use', async () => {
  const f = await fixture();
  const realAdjudicate = f.provider.adjudicate!;
  f.provider.adjudicate = async (context, tools) => {
    await realAdjudicate(context, tools);
    throw new Error('Lost connection before accepting adjudication');
  };
  f.submit();
  await f.game.idle();
  const saved = asV1(f.draft());
  expect(saved.adjudication).toBeUndefined();
  const { correct, wrong, eventId } = wrongRecipient(saved);
  const stateAfterTool = structuredClone(saved.members);
  f.save(saved);
  f.provider.adjudicate = realAdjudicate;
  const restarted = f.restart();
  restarted.game.retry(f.campaign.id, f.host.id);
  await restarted.game.idle();
  const done = restarted.game.snapshot(f.campaign.id, f.host.id).history.at(-1)!;
  expect(done.id).toBe(f.turnId);
  expect(done.resolution!.version).toBe(2);
  expect(done.resolution!.events.find((event) => event.id === eventId)!.fact).toBe(correct);
  expect(done.result!.narration).not.toContain(wrong);
  expect(restarted.game.members(f.campaign.id).find((member) => member.id === f.target.id)!.state.hp).toBe(4);
  expect(stateAfterTool.find((member: any) => member.id === f.target.id).state.hp).toBe(4);
  expect(
    restarted.game
      .members(f.campaign.id)
      .find((member) => member.id === f.actor.id)!
      .state.inventory.some((item) => item.id === f.potion.id),
  ).toBe(false);
  expect(f.draw).not.toHaveBeenCalled();
});

it.each(['adjudication', 'resolution', 'narration'] as const)(
  'repairs a wrong recipient saved at %s and resumes exactly once after restart',
  async (checkpoint) => {
    const f = await fixture();
    if (checkpoint === 'adjudication')
      f.db.exec(
        `CREATE TRIGGER interrupt_checkpoint BEFORE UPDATE OF draft ON turns WHEN NEW.draft LIKE '%"resolution":%' BEGIN SELECT RAISE(ABORT, 'finalization interrupted'); END;`,
      );
    else if (checkpoint === 'resolution') pauseNarration(f);
    else
      f.db.exec(
        `CREATE TRIGGER interrupt_checkpoint BEFORE UPDATE OF phase ON turns WHEN NEW.phase = 'complete' BEGIN SELECT RAISE(ABORT, 'publication interrupted'); END;`,
      );
    f.submit();
    await f.game.idle();
    expect(f.game.snapshot(f.campaign.id, f.host.id).turn!.phase).toBe('failed');
    const saved = asV1(f.draft());
    expect(saved[checkpoint]).toBeDefined();
    const originalState = structuredClone(saved.members);
    const originalRewards = structuredClone(saved.resolution?.rewards);
    const { correct, wrong, eventId } = wrongRecipient(saved);
    f.save(saved);
    if (checkpoint !== 'resolution') f.db.exec('DROP TRIGGER interrupt_checkpoint');
    const calls = f.adjudicate.mock.calls.length;
    f.db.exec('DROP TRIGGER IF EXISTS interrupt_narration');
    f.provider.narrate = f.narrate;
    const narrations = f.narrate.mock.calls.length;
    const restarted = f.restart();
    restarted.game.retry(f.campaign.id, f.host.id);
    await restarted.game.idle();
    const snapshot = restarted.game.snapshot(f.campaign.id, f.host.id);
    const done = snapshot.history.at(-1)!;
    expect(done.id, snapshot.turn?.error ?? '').toBe(f.turnId);
    expect(done.resolution!.version).toBe(1);
    expect(f.adjudicate).toHaveBeenCalledTimes(calls);
    expect(f.narrate).toHaveBeenCalledTimes(narrations + 1);
    expect(f.draw).not.toHaveBeenCalled();
    expect(done.result!.narration).toContain(correct);
    expect(done.resolution!.factualRecap).not.toContain(wrong);
    const repaired = JSON.parse(
      (restarted.db.prepare('SELECT draft FROM turns WHERE id = ?').get(f.turnId) as { draft: string }).draft,
    );
    for (const events of [
      repaired.receipts.executionEvents,
      repaired.adjudication.events,
      repaired.resolution.events,
    ])
      expect(events.find((event: any) => event.id === eventId).fact).toBe(correct);
    expect(repaired.narrationRevision).toBe(repaired.resolutionRevision);
    if (checkpoint !== 'adjudication') {
      expect(repaired.members.map((member: any) => member.state)).toEqual(
        originalState.map((member: any) => member.state),
      );
      expect(repaired.resolution.rewards).toEqual(originalRewards);
    }
    const actor = restarted.game.members(f.campaign.id).find((member) => member.id === f.actor.id)!;
    expect(actor.state.hp).toBe(f.actor.state.hp - 1);
    expect(actor.state.xp).toBe(10);
    expect(restarted.game.members(f.campaign.id).find((member) => member.id === f.target.id)!.state.hp).toBe(
      4,
    );
    expect(
      restarted.db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE turn_id = ? AND kind = 'turn_committed'")
        .get(f.turnId),
    ).toEqual({ n: 1 });
    expect(
      restarted.db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE turn_id = ? AND kind = 'checkpoint_repaired'")
        .get(f.turnId),
    ).toEqual({ n: 1 });
  },
);

it('keeps healthy v1 accepted narration and publishes without another provider request', async () => {
  const f = await fixture();
  f.db.exec(
    `CREATE TRIGGER interrupt_publication BEFORE UPDATE OF phase ON turns WHEN NEW.phase = 'complete' BEGIN SELECT RAISE(ABORT, 'publication interrupted'); END;`,
  );
  f.submit();
  await f.game.idle();
  const saved = asV1(f.draft());
  f.save(saved);
  const calls = f.adjudicate.mock.calls.length;
  const narrations = f.narrate.mock.calls.length;
  f.db.exec('DROP TRIGGER interrupt_publication');
  f.game.retry(f.campaign.id, f.host.id);
  await f.game.idle();
  expect(f.game.snapshot(f.campaign.id, f.host.id).history.at(-1)!.id).toBe(f.turnId);
  expect(f.adjudicate).toHaveBeenCalledTimes(calls);
  expect(f.narrate).toHaveBeenCalledTimes(narrations);
  expect(f.draft().narration).toEqual(saved.narration);
  expect(f.draft().resolution).toEqual(saved.resolution);
});

it('regenerates narration bound to an older revision while preserving finalized mechanics', async () => {
  const f = await fixture();
  f.db.exec(
    `CREATE TRIGGER interrupt_publication BEFORE UPDATE OF phase ON turns WHEN NEW.phase = 'complete' BEGIN SELECT RAISE(ABORT, 'publication interrupted'); END;`,
  );
  f.submit();
  await f.game.idle();
  const saved = f.draft();
  saved.resolutionRevision = 2;
  saved.narrationRevision = 1;
  f.save(saved);
  const calls = f.adjudicate.mock.calls.length;
  const narrations = f.narrate.mock.calls.length;
  f.db.exec('DROP TRIGGER interrupt_publication');
  f.game.retry(f.campaign.id, f.host.id);
  await f.game.idle();
  expect(f.game.snapshot(f.campaign.id, f.host.id).history.at(-1)!.id).toBe(f.turnId);
  expect(f.adjudicate).toHaveBeenCalledTimes(calls);
  expect(f.narrate).toHaveBeenCalledTimes(narrations + 1);
  expect(f.draft().members.map((member: any) => member.state)).toEqual(
    saved.members.map((member: any) => member.state),
  );
  expect(f.draft().narrationRevision).toBe(2);
});

it('preserves ambiguous accepted claims and their mechanics through repeated failed recovery', async () => {
  const f = await fixture();
  pauseNarration(f);
  f.submit();
  await f.game.idle();
  const saved = asV1(f.draft());
  wrongRecipient(saved);
  saved.adjudication.actions[0].fact = 'Amon heals himself and the sealed doorway opens in response.';
  saved.resolution.actions[0].fact = saved.adjudication.actions[0].fact;
  f.save(saved);
  const calls = f.adjudicate.mock.calls.length;
  f.db.exec('DROP TRIGGER IF EXISTS interrupt_narration');
  f.provider.narrate = f.narrate;
  const narrations = f.narrate.mock.calls.length;
  for (let attempt = 0; attempt < 2; attempt++) {
    f.game.retry(f.campaign.id, f.host.id);
    await f.game.idle();
    const turn = f.game.snapshot(f.campaign.id, f.host.id).turn!;
    expect(turn.phase).toBe('failed');
    expect(turn.error).toMatch(/recovery|repair|ambiguous|unsupported|free.form/i);
    expect(f.draft()).toEqual(saved);
  }
  expect(f.adjudicate).toHaveBeenCalledTimes(calls);
  expect(f.narrate).toHaveBeenCalledTimes(narrations);
  expect(f.draw).not.toHaveBeenCalled();
});

it('rolls back a fact repair and its audit event together if saving the repaired draft fails', async () => {
  const f = await fixture();
  pauseNarration(f);
  f.submit();
  await f.game.idle();
  const saved = asV1(f.draft());
  wrongRecipient(saved);
  f.save(saved);
  f.db.exec(
    `CREATE TRIGGER interrupt_repair BEFORE UPDATE OF draft ON turns WHEN NEW.draft LIKE '%"resolutionRevision":1%' BEGIN SELECT RAISE(ABORT, 'repair interrupted'); END;`,
  );
  f.db.exec('DROP TRIGGER IF EXISTS interrupt_narration');
  f.provider.narrate = f.narrate;
  f.game.retry(f.campaign.id, f.host.id);
  await f.game.idle();
  expect(f.game.snapshot(f.campaign.id, f.host.id).turn!.phase).toBe('failed');
  expect(f.draft()).toEqual(saved);
  expect(
    f.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE turn_id = ? AND kind = 'checkpoint_repaired'")
      .get(f.turnId),
  ).toEqual({ n: 0 });
  f.db.exec('DROP TRIGGER interrupt_repair');
  f.game.retry(f.campaign.id, f.host.id);
  await f.game.idle();
  expect(f.game.snapshot(f.campaign.id, f.host.id).history.at(-1)!.id).toBe(f.turnId);
});

it('retains an accepted routine success when finalization later incapacitates the actor', async () => {
  const f = await fixture();
  // A one-turn Frozen now expires in this finalization; downing retains the original recovery scenario.
  f.actor.state.hp = 2;
  f.actor.state.conditions = [];
  f.actor.state.conditionTurns = {};
  f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(f.actor.state), f.actor.id);
  f.provider.adjudicate = vi.fn(async (context: GMContext): Promise<TurnAdjudication> => {
    const id = actionId(context.turn.id, f.actor.id);
    const fact = 'Amon opens the unlatched wooden shutter.';
    const reason = 'The shutter is unlocked and within reach.';
    const main = {
      status: 'success' as const,
      basis: 'routine' as const,
      fact,
      reason,
      receiptRefs: [],
      eventIds: ['shutter'],
    };
    return {
      version: 2,
      turnId: context.turn.id,
      actions: [{ actionId: id, memberId: f.actor.id, ...main, components: { main, minor: null } }],
      events: [
        {
          id: 'shutter',
          sequence: 0,
          kind: 'action',
          memberId: f.actor.id,
          actionId: id,
          phase: 'main',
          result: 'success',
          fact,
          receiptRefs: [],
          dependsOn: [],
        },
      ],
      changes: [
        {
          type: 'hp',
          memberId: f.actor.id,
          amount: -2,
          reason: 'The opened shutter exposes the established freezing mist.',
        },
      ],
      journal: [],
      location: null,
      rewards: { xp: 0, gold: 0, reason: 'No discovery.' },
    };
  });
  pauseNarration(f);
  f.game.submit(f.campaign.id, f.actor.playerId, f.turnId, 'Open the unlocked shutter', false);
  await f.game.idle();
  const saved = f.draft();
  expect(saved.resolution.actions[0].status).toBe('success');
  expect(saved.members.find((member: any) => member.id === f.actor.id).state.conditions).toContain('Downed');
  f.db.exec('DROP TRIGGER IF EXISTS interrupt_narration');
  f.provider.narrate = f.narrate;
  f.game.retry(f.campaign.id, f.host.id);
  await f.game.idle();
  expect(f.game.snapshot(f.campaign.id, f.host.id).history.at(-1)!.id).toBe(f.turnId);
  expect(f.provider.adjudicate).toHaveBeenCalledTimes(1);
  expect(f.draft().resolution).toEqual(saved.resolution);
  expect(f.draft().members.map((member: any) => member.state)).toEqual(
    saved.members.map((member: any) => member.state),
  );
});

it('rejects an old minor-only receipt used as proof of an unrecorded main success', async () => {
  const f = await fixture();
  f.actor.state.hp -= 4;
  f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(f.actor.state), f.actor.id);
  pauseNarration(f);
  f.game.submit(f.campaign.id, f.actor.playerId, f.turnId, 'Drink Red Potion', false);
  await f.game.idle();
  const saved = asV1(f.draft());
  for (const value of [saved.adjudication, saved.resolution])
    value.actions[0].fact = 'Amon drinks the potion and opens the sealed gate.';
  f.save(saved);
  const calls = f.adjudicate.mock.calls.length;
  f.db.exec('DROP TRIGGER IF EXISTS interrupt_narration');
  f.provider.narrate = f.narrate;
  f.game.retry(f.campaign.id, f.host.id);
  await f.game.idle();
  const failed = f.game.snapshot(f.campaign.id, f.host.id).turn!;
  expect(failed.phase).toBe('failed');
  expect(failed.error).toContain('unsupported main-success claim');
  expect(f.draft()).toEqual(saved);
  expect(f.adjudicate).toHaveBeenCalledTimes(calls);
});

it('keeps a requested routine main when a practice actor becomes Stunned after submitting a potion action', async () => {
  const f = await fixture();
  f.game.pause(f.campaign.id, f.host.id, true);
  f.actor.state.hp -= 4;
  f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(f.actor.state), f.actor.id);
  f.game.submit(f.campaign.id, f.actor.playerId, f.turnId, 'Drink Red Potion and talk to the guard', false);
  applyCondition(f.actor.state, 'Stunned');
  f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(f.actor.state), f.actor.id);
  f.game.pause(f.campaign.id, f.host.id, false);
  await f.game.idle();
  const saved = f.draft();
  expect(saved.resolution.actions[0]).toMatchObject({
    status: 'partial',
    components: { main: { status: 'blocked' }, minor: { status: 'success' } },
  });
  expect(f.draw).not.toHaveBeenCalled();
});
