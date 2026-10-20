import { interruptNarration } from './narration-interruption';
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
  type Enemy,
} from '../shared/schema';
import { applyCondition, baseItem, initialScene, initialState } from '../shared/rules';
import { occupiedPlaces } from '../shared/locations';
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
    const scene = game.snapshot(c.id, host.id).scene;
    scene.encounterRisk = { danger: 'safe', reason: 'The sealed sanctuary has no wandering threats.' };
    db.prepare('UPDATE campaigns SET scene = ? WHERE id = ?').run(JSON.stringify(scene), c.id);
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

it('finalizes explicit pickup once and resumes publication after a restart without another interpretation', async () => {
  const f = fixture();
  await f.start();
  const scene = f.game.snapshot(f.c.id, f.host.id).scene;
  scene.loot.push({ ...baseItem('ampoules', 'Sealed ampoules', 'tool'), quantity: 1 });
  f.db.prepare('UPDATE campaigns SET scene = ? WHERE id = ?').run(JSON.stringify(scene), f.c.id);
  f.provider.adjudicate = vi.fn(async (context) => {
    const value = proposal(context);
    value.events = value.events.filter((event) => event.kind === 'action');
    value.events.forEach((event, sequence) => (event.sequence = sequence));
    value.journal = [];
    value.rewards = { xp: 0, gold: 0, reason: 'Routine handling.' };
    const action = value.actions[0];
    const event = value.events.find((event) => event.actionId === action.actionId)!;
    event.locationRef = context.scene.location.id;
    event.fact = action.fact = action.components.main!.fact = 'Collects the ampoules.';
    value.pickups = [{ memberId: action.memberId, itemId: 'ampoules', eventId: event.id }];
    return value;
  });
  f.db.exec(
    "CREATE TRIGGER interrupt_pickup_publication BEFORE UPDATE OF phase ON turns WHEN NEW.phase = 'complete' BEGIN SELECT RAISE(ABORT, 'publication interrupted'); END;",
  );
  const turn = f.game.snapshot(f.c.id, f.host.id).turn!;
  f.game.submit(f.c.id, f.p1.id, turn.id, 'Ik neem de ampullen mee.', false);
  f.game.submit(f.c.id, f.p2.id, turn.id, '', true);
  await f.game.idle();
  expect(f.game.snapshot(f.c.id, f.host.id).turn!.phase).toBe('failed');
  const saved = f.draft(turn.id);
  expect(saved.members[0].state.inventory.find((item: any) => item.id === 'ampoules').quantity).toBe(1);
  expect(saved.scene.loot.some((item: any) => item.id === 'ampoules')).toBe(false);
  expect(saved.receipts.pickups).toHaveLength(1);
  expect(f.game.members(f.c.id)[0].state.inventory.some((item) => item.id === 'ampoules')).toBe(false);
  const calls = vi.mocked(f.provider.adjudicate!).mock.calls.length;
  const narrations = f.narrate.mock.calls.length;
  f.db.exec('DROP TRIGGER interrupt_pickup_publication');
  const restarted = new Game(f.db, f.factory, f.draw);
  restarted.retry(f.c.id, f.host.id);
  await restarted.idle();
  expect(restarted.snapshot(f.c.id, f.host.id).turn!.phase).toBe('collecting');
  expect(restarted.members(f.c.id)[0].state.inventory.find((item) => item.id === 'ampoules')!.quantity).toBe(
    1,
  );
  expect(vi.mocked(f.provider.adjudicate!).mock.calls).toHaveLength(calls);
  expect(f.narrate.mock.calls).toHaveLength(narrations);
  expect(f.draft(turn.id).resolution).toEqual(saved.resolution);
});

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

it('resumes saved exploration at a new place after encounter creation without calling the adjudicator again', async () => {
  const f = fixture();
  await f.start();
  f.draw.mockImplementation((sides) => (sides === 6 ? 1 : Math.min(12, sides)));
  f.provider.adjudicate = vi.fn(async (context, tools) => {
    const value = proposal(context);
    const deck = 'new:deck';
    value.events = value.events.filter((event) => event.kind === 'action');
    value.memberLocations = value.actions.map((action) => {
      const event = value.events.find((event) => event.actionId === action.actionId)!;
      event.effect = 'movement';
      event.locationRef = deck;
      event.fact = action.fact = action.components.main!.fact = 'Boards through the open gangway.';
      return { memberId: action.memberId, locationId: deck, movementEventId: event.id };
    });
    value.events.push({
      id: 'arrival',
      sequence: value.events.length,
      kind: 'world',
      memberId: null,
      actionId: null,
      phase: null,
      result: null,
      locationRef: deck,
      receiptRefs: [],
      dependsOn: [{ eventId: value.events[0].id, requires: 'success' }],
      fact: 'The deck contains a cargo manifest beside the captain. The open gangway leads back to the sanctuary.',
    });
    value.location = null;
    value.sceneFocus = deck;
    value.placeUpdates = [
      {
        ref: deck,
        location: { name: 'Cargo deck', atmosphere: 'Cargo crates.', hazard: 'An armed captain.' },
      },
    ];
    value.mapUpdates = {
      locations: [{ ref: deck, name: 'Cargo deck' }],
      connections: [
        {
          from: context.scene.location.id!,
          to: deck,
          label: 'Open gangway',
          blocked: false,
          bidirectional: true,
          eventId: value.events[0].id,
        },
      ],
    };
    value.arrivals = [{ locationId: deck, eventId: 'arrival' }];
    value.journal = [{ kind: 'fact', name: 'Cargo deck', detail: value.events.at(-1)!.fact }];
    value.worldProgress = [
      {
        locationId: deck,
        eventId: 'arrival',
        kind: 'discovery',
        thread: 'premise',
        journal: { kind: 'fact', name: 'Cargo deck' },
      },
    ];
    value.encounterRisks = [
      {
        locationId: deck,
        eventId: 'arrival',
        danger: 'dangerous',
        reason: 'An armed captain guards the deck.',
      },
    ];
    value.rewards = { xp: 0, gold: 0, reason: 'No new reward.' };
    const accepted = tools.validateAdjudication!(value);
    expect(tools.prepareEncounters!(accepted)).toHaveLength(1);
    tools.startCombat(
      [
        {
          id: 'captain',
          name: 'Captain',
          tier: 'normal',
          hp: 18,
          defense: 12,
          attack: 2,
          damage: '1d8',
          description: 'An armed captain.',
          tactic: 'Defend the deck.',
          onHit: null,
        },
      ],
      deck,
    );
    throw new Error('Connection lost after saving the encounter.');
  });
  const turn = f.game.snapshot(f.c.id, f.host.id).turn!;
  f.game.submit(f.c.id, f.p1.id, turn.id, 'I walk onto the cargo deck.', false);
  f.game.submit(f.c.id, f.p2.id, turn.id, 'Ik volg de kapitein aan boord.', false);
  await f.game.idle();
  expect(f.game.snapshot(f.c.id, f.host.id).turn!.phase).toBe('failed');
  const baseline = f.draft(turn.id).receipts.encounterProposal;
  const started = f.draft(turn.id).receipts.startCombatByLocation['new:deck'];
  expect(started.round).toBe(1);
  const draws = f.draw.mock.calls.length;
  const restarted = new Game(f.db, f.factory, f.draw);
  restarted.retry(f.c.id, f.host.id);
  await restarted.idle();
  const snapshot = restarted.snapshot(f.c.id, f.host.id);
  expect(snapshot.turn!.phase, snapshot.turn!.error ?? '').toBe('collecting');
  expect(f.provider.adjudicate).toHaveBeenCalledTimes(1);
  expect(f.draw).toHaveBeenCalledTimes(draws);
  expect(snapshot.scene.location.name).toBe('Cargo deck');
  expect(snapshot.scene.encounter!.round).toBe(1);
  expect(snapshot.scene.encounter!.enemies).toEqual(started.enemies);
  expect(f.draft(turn.id).resolution.executionContext).toContainEqual(
    expect.objectContaining({
      actorId: 'captain',
      name: 'Captain',
      description: 'An armed captain.',
      equipment: started.enemies[0].equipment.map(({ name, kind, description }: any) => ({
        name,
        kind,
        description,
      })),
    }),
  );
  expect(f.draft(turn.id).adjudication.actions).toEqual(baseline.actions);
  expect(f.draft(turn.id).adjudication.rewards).toEqual(baseline.rewards);
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
    interruptNarration(f.db, 'Narrator unavailable');
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
  };
}

function survivingSpiderContext() {
  const c = context();
  c.turn.actions = [c.turn.actions[0]];
  c.scene.location.id = randomUUID();
  const spider: Enemy = {
    ...enemySchema.parse({
      id: 'spider',
      name: 'De Operazangende Schaduwspin',
      tier: 'elite',
      hp: 5,
      defense: 12,
      attack: 5,
      damage: '1d8',
      description: 'A shadow spider.',
      tactic: 'Guard',
    }),
    maxHp: 38,
    initiative: 19,
  };
  c.scene.encounter = { enemies: [spider], round: 7, initiative: [], victory: false, escaped: false };
  c.combatResult = {
    encounter: c.scene.encounter,
    logs: [],
    characters: [],
    loot: [],
    events: [
      {
        actorId: c.members[0].id,
        phase: 'main',
        status: 'success',
        fact: `Amon-Sah hits ${spider.name} with a saber for 13.`,
      },
    ],
  };
  c.receipts = { combat: c.combatResult };
  const value = proposal(c);
  value.rewards = { xp: 0, gold: 0, reason: 'No combat victory.' };
  return { c, value, spider };
}

it.each(['action', 'component', 'world', 'journal', 'place'] as const)(
  'rejects a false combat victory in adjudicated %s text before publication',
  (area) => {
    const { c, value, spider } = survivingSpiderContext();
    expect(() => validateAdjudication(c, value)).not.toThrow();
    const falseDeath = `${spider.name} is verslagen; haar gestolen vioolsnaren liggen op het web.`;
    if (area === 'action') value.actions[0].fact = falseDeath;
    if (area === 'component') value.actions[0].components.main!.reason = falseDeath;
    if (area === 'world') value.events.at(-1)!.fact = 'Haar gestalte lost op; het combat eindigt.';
    if (area === 'journal') value.journal[0].detail = falseDeath;
    if (area === 'place')
      value.placeUpdates = [
        {
          ref: c.scene.location.id!,
          location: {
            name: c.scene.location.name,
            atmosphere: 'The web settles.',
            hazard: 'Er is geen actieve vijand meer; de webvloer hangt boven een diepte.',
          },
        },
      ];
    expect(() => validateAdjudication(c, value)).toThrow(/still has 5\/38 HP|is still active/);
  },
);

it.each(['passage', 'closing', 'summary'] as const)(
  'rejects a false enemy death in narration %s against frozen final HP',
  (area) => {
    const { c, spider } = survivingSpiderContext();
    const r = resolution();
    r.placeStates = occupiedPlaces(c.scene);
    const narration = factualNarration(r, config.language);
    expect(narration.version).toBe(2);
    if (narration.version !== 2) throw new Error('Expected version 2.');
    const falseDeath = `${spider.name} is dead and drops her loot.`;
    if (area === 'passage') narration.passages[0].text = falseDeath;
    if (area === 'closing') narration.closing = falseDeath;
    if (area === 'summary') narration.summary = falseDeath;
    expect(() => assembleResolvedNarration(r, narration)).toThrow('still has 5/38 HP');
  },
);

it.each(['is al verslagen', 'al is verslagen', 'is already defeated'])(
  'rejects a propagated death claim using %s',
  (claim) => {
    const { c, value, spider } = survivingSpiderContext();
    value.actions[0].components.main!.reason = `${spider.name} ${claim}.`;
    expect(() => validateAdjudication(c, value)).toThrow('still has 5/38 HP');
  },
);

it('distinguishes living enemies, conditional goals, recorded kills and withdrawal victories', () => {
  const { c, value, spider } = survivingSpiderContext();
  value.events.at(-1)!.fact =
    `${spider.name} is not dead. If combat ends, the party can recover the strings.`;
  expect(() => validateAdjudication(c, value)).not.toThrow();
  value.events.at(-1)!.fact = `${spider.name} is verslagen.`;
  spider.withdrawn = true;
  c.scene.encounter!.victory = true;
  expect(() => validateAdjudication(c, value)).not.toThrow();
  value.events.at(-1)!.fact = `${spider.name} is dead.`;
  expect(() => validateAdjudication(c, value)).toThrow('still has 5/38 HP');
  spider.hp = 0;
  expect(() => validateAdjudication(c, value)).not.toThrow();
});

it('passes compact final enemy HP and combat status into adjudication without reapplying damage', () => {
  const { c } = survivingSpiderContext();
  const input = adjudicationInput(c);
  expect(input.mechanicsTiming).toContain('AFTER');
  expect(input.combatState[c.scene.location.id!].encounter).toMatchObject({
    victory: false,
    escaped: false,
    enemies: [{ hp: 5, maxHp: 38, withdrawn: false }],
  });
});
function completed(value: unknown) {
  return new Response(
    `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] } })}\n\n`,
  );
}
const auth = { accessToken: async () => 'test-token' } as unknown as ChatGPTAuth;

it('uses saved turn numbers for opening narration and keeps legacy resolutions readable', async () => {
  const seen: (number | undefined)[] = [];
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    const data = JSON.parse(body.input[0].content);
    if (data.candidate) return completed({ approved: true, feedback: '' });
    const r = data.resolution as TurnResolution;
    seen.push(r.turnNumber);
    expect(body.instructions.includes('Opening narration:')).toBe(r.turnNumber === 0);
    return completed({
      version: 2,
      turnId: r.turnId,
      passages: r.events.map((event) => ({ eventIds: [event.id], text: event.fact })),
      closing: '',
      summary: 'The sanctuary remains open to exploration.',
    });
  }) as typeof fetch;
  const gm = new ChatGPTGM(auth, 'owner', 'model', fetcher);
  const f = fixture({ narrate: gm.narrate.bind(gm) });
  await f.start();
  const openingId = f.game.snapshot(f.c.id, f.host.id).history[0].id;
  const opening = f.draft(openingId).resolution as TurnResolution;
  expect(opening.turnNumber).toBe(0);
  const turnId = f.submit();
  await f.game.idle();
  expect(f.draft(turnId).resolution.turnNumber).toBe(1);
  // Older saved openings have no turn metadata; their existing facts still narrate safely.
  delete opening.turnNumber;
  const legacy = await gm.narrate(opening, config);
  expect(assembleResolvedNarration(opening, legacy)).toEqual(legacy);
  expect(seen).toEqual([0, 0, 1, undefined]);
});

it('narrates the whole party after a partially completed investigation instead of falling back to rolls', async () => {
  const f = fixture();
  await f.start();
  let current!: GMContext;
  let adjudicated!: TurnAdjudication;
  const story =
    'Amon-Sah studies the exposed fittings of the sanctuary door, following the worn groove with his fingers. ' +
    'The inspection reveals how the bronze latch fits its housing, but the sealed interior remains beyond his reach. ' +
    'Beside him, Zafir al-Raml examines the markings and makes out their pattern. ' +
    'They now understand the visible mechanism; the inner chamber remains unexplored.';
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    const data = JSON.parse(body.input[0].content);
    if (data.task === 'Narrate the finalized turn.')
      return completed({
        version: 2,
        turnId: data.resolution.turnId,
        passages: [{ eventIds: data.resolution.events.map((event: any) => event.id), text: story }],
        closing: '',
        summary: 'The visible latch is understood; the inner chamber remains unexplored.',
      });
    if (data.candidate) return completed({ approved: true, feedback: '' });
    const value = proposal(current);
    const actor = value.actions[0];
    const fact = 'Amon-Sah inspects the exposed latch but cannot inspect the sealed interior.';
    changeMain(value, actor.memberId, 'partial', fact);
    value.events.find((event) => event.id === 'act:0')!.effect = 'search';
    value.events = value.events.filter((event) => event.id !== 'world:discovery');
    const ally = value.actions[1];
    const allyMain = ally.components.main!;
    ally.fact = allyMain.fact = 'Zafir al-Raml reads the visible markings and makes out their pattern.';
    ally.eventIds.push('act:markings');
    allyMain.eventIds.push('act:markings');
    value.events.push({
      id: 'act:markings',
      sequence: value.events.length,
      kind: 'action',
      memberId: ally.memberId,
      actionId: ally.actionId,
      phase: 'main',
      result: 'success',
      fact: ally.fact,
      receiptRefs: allyMain.receiptRefs,
      dependsOn: [{ eventId: allyMain.eventIds[0], requires: 'success' }],
    });
    value.events.push({
      id: 'world:latch',
      sequence: value.events.length,
      kind: 'world',
      memberId: null,
      actionId: null,
      phase: null,
      result: null,
      locationRef: current.scene.location.id!,
      fact: 'The exposed bronze latch fits a worn groove; the sealed interior remains unexplored.',
      receiptRefs: [],
      dependsOn: [{ eventId: 'act:0', requires: 'occurrence' }],
    });
    actor.intent = 'search';
    actor.search = {
      sourceId: 'sanctuary:door',
      locationId: current.scene.location.id!,
      informationEventId: 'world:latch',
      reward: null,
    };
    value.journal = [];
    value.rewards.xp = 0;
    adjudicated = structuredClone(value);
    return completed(value);
  }) as unknown as typeof fetch;
  const gm = new ChatGPTGM(auth, 'owner', 'model', fetcher);
  f.provider.adjudicate = async (context, tools) => {
    tools({
      memberId: context.turn.actions[1].memberId,
      stat: 'WIS',
      dc: 10,
      mode: 'normal',
      reason: 'Read the visible markings.',
      lethal: false,
    });
    current = context;
    return gm.adjudicate(context, tools);
  };
  f.provider.narrate = gm.narrate.bind(gm);
  const turn = f.game.snapshot(f.c.id, f.host.id).turn!;
  f.game.submit(f.c.id, f.p1.id, turn.id, 'Inspect the latch and the sealed interior.', false);
  f.game.submit(f.c.id, f.p2.id, turn.id, 'Read the markings.', false);
  await f.game.idle();
  const snapshot = f.game.snapshot(f.c.id, f.host.id);
  const done = snapshot.history.at(-1)!;
  expect(done.id).toBe(turn.id);
  expect(done.phase, snapshot.turn?.error ?? '').toBe('complete');
  expect(done.resolution!.actions.map((action) => action.status)).toEqual(['partial', 'success']);
  expect(done.result!.narration).toBe(story);
  expect(f.draft(turn.id).adjudicationFallback).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(3); // Adjudication, narration and fidelity review.
  expect(done.rolls).toHaveLength(1);
  expect(f.draw).toHaveBeenCalledTimes(1); // A partial search earns no bonus-loot roll.
  expect(snapshot.scene.searches!['sanctuary:door']).toMatchObject({ rewardRolled: false });

  const missing = structuredClone(adjudicated);
  missing.actions[0].search = null;
  expect(() => validateAdjudication(current, missing)).toThrow('useful information event');
  const blocked = changeMain(
    structuredClone(adjudicated),
    adjudicated.actions[0].memberId,
    'blocked',
    'The inspection cannot be performed.',
  );
  blocked.actions[0].basis = blocked.actions[0].components.main!.basis = 'none';
  expect(() => validateAdjudication(current, blocked)).toThrow('resolved noncombat main search action');

  const moved = changeMain(
    structuredClone(adjudicated),
    adjudicated.actions[0].memberId,
    'success',
    'Amon-Sah finishes inspecting the exposed latch.',
  );
  moved.placeUpdates = [
    { ref: 'new:interior', location: { name: 'Inner chamber', atmosphere: 'Still air.', hazard: '' } },
  ];
  moved.memberLocations = [
    { memberId: moved.actions[0].memberId, locationId: 'new:interior', movementEventId: 'act:0' },
  ];
  expect(() => validateAdjudication(current, moved)).toThrow('explicit movement effect');
});

it.each([
  { mode: 'advantage' as const, dice: [4, 16], success: true },
  { mode: 'advantage' as const, dice: [2, 4], success: false },
  { mode: 'disadvantage' as const, dice: [4, 16], success: false },
  { mode: 'disadvantage' as const, dice: [12, 16], success: true },
  { mode: 'normal' as const, dice: [12], success: true },
])(
  'preserves a contextual $mode response with success=$success in the existing four requests',
  async (scenario) => {
    const f = fixture();
    const attitude = scenario.mode === 'disadvantage' ? 'supports Flo’s captors' : 'sympathizes with Flo';
    const background = `The postmoth ${attitude} and recognizes the emblem on Amon-Sah's visible banner.${scenario.mode === 'normal' ? ' A nearby guard inhibits disclosure.' : ''}`;
    const opening = f.provider.adjudicate!;
    f.provider.adjudicate = async (context, tools) => {
      const value = await opening(context, tools);
      value.journal.push({ kind: 'npc', name: 'Postmoth', detail: background });
      value.events.push({
        id: 'world:postmoth',
        sequence: value.events.length,
        kind: 'world',
        memberId: null,
        actionId: null,
        phase: null,
        result: null,
        fact: background,
        receiptRefs: [],
        dependsOn: [],
      });
      return value;
    };
    await f.start();
    const reaction =
      scenario.mode === 'advantage'
        ? 'The postmoth brightens at Flo’s emblem.'
        : 'The postmoth answers guardedly beneath Flo’s emblem.';
    const fact = `${reaction} ${scenario.success ? 'Amon-Sah learns that the prison scroll went to the quay.' : 'Amon-Sah gets no information about the prison scroll.'}`;
    const reason = `Amon-Sah asks about Flo while the postmoth ${scenario.mode === 'advantage' ? 'responds warmly to his emblem' : 'remains guarded'}.`;
    let current: GMContext;
    const requests: string[] = [];
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      const input = JSON.parse(body.input[0].content);
      requests.push(input.task);
      if (input.turn) {
        expect(input.journal).toContainEqual({ kind: 'npc', name: 'Postmoth', detail: background });
        expect(body.instructions).toContain('Situational noncombat checks:');
        if (!input.turn.rolls.length) {
          const tool = body.tools[0].tools.find((tool: { name: string }) => tool.name === 'roll_check');
          expect(tool.parameters.required).toContain('circumstances');
          expect(tool.parameters.properties.circumstances.description).toContain('independently');
          return new Response(
            `data: ${JSON.stringify({
              type: 'response.completed',
              response: {
                output: [
                  {
                    type: 'function_call',
                    namespace: 'game',
                    name: 'roll_check',
                    call_id: 'inquiry',
                    arguments: JSON.stringify({
                      memberId: input.turn.actions[0].memberId,
                      stat: 'CHA',
                      dc: 10,
                      mode: 'normal',
                      circumstances: {
                        favorable: scenario.mode !== 'disadvantage',
                        adverse: scenario.mode !== 'advantage',
                      },
                      reason,
                      lethal: false,
                    }),
                  },
                ],
              },
            })}\n\n`,
          );
        }
        const value = proposal(current);
        value.events = value.events.filter((event) => event.kind !== 'world');
        const action = value.actions[0];
        const main = action.components.main!;
        const event = {
          id: 'action:inquiry',
          sequence: value.events.length,
          kind: 'action' as const,
          memberId: action.memberId,
          actionId: action.actionId,
          phase: 'main' as const,
          result: main.status,
          fact,
          receiptRefs: main.receiptRefs,
          dependsOn: [{ eventId: main.eventIds[0], requires: 'occurrence' as const }],
        };
        value.events.push(event);
        main.eventIds.push(event.id);
        main.fact += ` ${fact}`;
        main.reason = reason;
        action.eventIds.push(event.id);
        action.fact = main.fact;
        action.reason = reason;
        value.journal = [{ kind: 'npc', name: 'Postmoth', detail: `${background} ${fact}` }];
        value.rewards = { xp: 0, gold: 0, reason: 'An inquiry is resolved.' };
        value.events = value.events.filter((event) => event.kind !== 'mechanics');
        return completed(value);
      }
      expect(body.tools).toBeUndefined();
      expect(body.instructions).toContain('recorded in resolved event facts');
      expect(input.resolution.events).toContainEqual(expect.objectContaining({ id: 'action:inquiry', fact }));
      expect(input.resolution.checkReasons).toEqual({
        [`check:${current.turn.rolls[0].id}`]: reason,
      });
      expect(input.resolution.actions[0].components.main.status).toBe(
        scenario.success ? 'success' : 'failure',
      );
      if (input.candidate) return completed({ approved: true, feedback: '' });
      return completed({
        version: 2,
        turnId: input.resolution.turnId,
        passages: [
          {
            eventIds: input.resolution.events.map((event: { id: string }) => event.id),
            text: `${fact} Zafir al-Raml waits nearby.`,
          },
        ],
        closing: '',
        summary: fact,
      });
    }) as unknown as typeof fetch;
    const gm = new ChatGPTGM(auth, 'owner', 'model', fetcher);
    f.provider.adjudicate = (context, tools) => {
      current = context;
      return gm.adjudicate(context, tools);
    };
    f.provider.narrate = gm.narrate.bind(gm);
    const dice = [...scenario.dice];
    f.draw.mockClear().mockImplementation(() => dice.shift() ?? 12);
    const turn = f.game.snapshot(f.c.id, f.host.id).turn!;
    f.game.submit(f.c.id, f.p1.id, turn.id, 'Ask the postmoth about Flo.', false);
    f.game.submit(f.c.id, f.p2.id, turn.id, '', true);
    await f.game.idle();
    const snapshot = f.game.snapshot(f.c.id, f.host.id);
    expect(snapshot.turn!.phase, snapshot.turn!.error ?? '').toBe('collecting');
    const done = snapshot.history.at(-1)!;
    expect(done.id).toBe(turn.id);
    expect(done.rolls).toMatchObject([
      { mode: scenario.mode, dice: scenario.dice, success: scenario.success, reason },
    ]);
    expect(done.result!.narration).toContain(fact);
    expect(done.resolution!.checkReasons).toEqual({ [`check:${done.rolls[0].id}`]: reason });
    expect(f.draw).toHaveBeenCalledTimes(scenario.dice.length);
    expect(requests).toEqual([
      'Adjudicate submitted intent using authoritative receipts; return structured outcomes.',
      'Adjudicate submitted intent using authoritative receipts; return structured outcomes.',
      'Narrate the finalized turn.',
      'Review all event paragraphs, closing and situation summary against the finalized resolution.',
    ]);
  },
);

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
  const narrationInput = JSON.parse((inputs[1] as { input: { content: string }[] }).input[0].content);
  const narratedFacts = narrationInput.resolution;
  expect(narratedFacts).not.toHaveProperty('factualRecap');
  expect(narratedFacts.events).toEqual(r.events);
  expect(r.factualRecap).toBeTruthy(); // The durable history still has its full recap.
  const review = JSON.parse((inputs[2] as { input: { content: string }[] }).input[0].content);
  expect(Object.keys(review)).toEqual(['task', 'narrationStyle', 'resolution', 'candidate']);
  expect(review.narrationStyle).toEqual(narrationInput.narrationStyle);
});

it('deduplicates provider snapshots without dropping history events or changed starting state', () => {
  const c = context();
  c.startingMembers = structuredClone(c.members);
  c.journal = [{ kind: 'quest', name: 'Restore the violin', detail: 'The violin now has four strings.' }];
  c.history = [
    {
      source: 'resolution',
      summary: [
        'Romano repairs the violin.',
        'quest Restore the violin: The violin had no strings.',
        `Location: ${JSON.stringify(c.scene.location)}.`,
        'fact Earlier clue: A hidden inscription was found.',
        'Location: invalid legacy prose.',
      ].join('\n'),
    },
  ];
  const before = structuredClone(c);
  const input = adjudicationInput(c);
  expect(input.startingMembers![0]).not.toHaveProperty('state');
  expect(input.contextSemantics).toContain('same state');
  expect(input.movementProof).toEqual({ phase: 'main', effect: 'movement', result: 'success' });
  expect(input.journal).toEqual(c.journal);
  expect(input.history[0].summary).toBe(
    'Romano repairs the violin.\nfact Earlier clue: A hidden inscription was found.\nLocation: invalid legacy prose.',
  );
  expect(c).toEqual(before);
  c.members[0].state.hp--;
  expect(adjudicationInput(c).startingMembers![0].state).toMatchObject({ hp: before.members[0].state.hp });
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
    // Bound the fixed contract including situational checks, factions, exploration and locations.
    expect(request.instructions.length).toBeLessThan(36_000);
    expect(request.instructions).toContain('Batch independent tool calls');
    expect(request.instructions).toContain(
      'one ordinary move to an adjacent location plus one explicitly submitted main action there',
    );
    expect(request.instructions).toContain('Risky, ability-assisted or resource-dependent travel uses main');
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

it('publishes a narration timeout from finalized facts without another adjudication', async () => {
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
  expect(f.provider.narrate).toHaveBeenCalledTimes(1);
  expect(f.game.members(f.c.id).map((member) => member.state.xp)).toEqual([10, 10]);
});

it.each([
  ['arrival', 'approved'],
  ['arrival', 'rejected'],
  ['arrival', 'disconnected'],
  ['opening', 'approved'],
  ['opening', 'rejected'],
  ['opening', 'disconnected'],
] as const)(
  'expands a short %s within the existing budget and keeps approved prose when polish is %s',
  async (scene, polish) => {
    const r = resolution();
    r.turnNumber = 20;
    r.arrivals = [{ locationId: 'new:room', eventId: r.events.at(-1)!.id }];
    r.executionContext = [
      {
        actorId: r.actions[0].memberId,
        name: r.actions[0].characterName,
        description: '',
        personality: 'Cautious and curious; speaks briefly before acting.',
        equipment: [],
      },
    ];
    if (scene === 'opening') {
      r.turnNumber = 0;
      r.actions = [];
      r.events = [{ ...r.events.at(-1)!, dependsOn: [] }];
      r.executionContext = [];
    }
    const before = structuredClone(r);
    const story = r.events.map((event) => event.fact).join(' ');
    const expanded =
      scene === 'opening'
        ? `The bronze sun disk catches the light. ${story}`
        : `${r.actions[0].characterName} leans toward the mechanism. “Slowly. Let me look.” ${story}`;
    let writing = 0;
    let reviewing = 0;
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      const data = JSON.parse(body.input[0].content);
      expect(body.tools).toBeUndefined();
      if (data.candidate) {
        reviewing++;
        return completed({
          storyApproved: reviewing === 1 || polish !== 'rejected',
          summaryApproved: true,
          feedback: reviewing === 2 && polish === 'rejected' ? 'An invented exit.' : '',
        });
      }
      writing++;
      if (writing === 2) {
        expect(body.input.at(-1).content).toContain('outcomes are approved');
        expect(body.input.at(-1).content).toContain(
          scene === 'opening' ? '400–650 words' : 'frozen player personality',
        );
        if (scene === 'opening')
          expect(body.input.at(-1).content).toContain('leaving player dialogue and choices open');
        if (polish === 'disconnected') throw new Error('Connection lost during optional polish.');
      }
      return completed({
        version: 2,
        turnId: r.turnId,
        passages: [{ eventIds: r.events.map((event) => event.id), text: writing === 1 ? story : expanded }],
        closing: '',
        summary: 'The sanctuary is revealed.',
      });
    }) as unknown as typeof fetch;
    const budget: StageBudget = { used: 0, limit: 4 };
    const narrated = await new ChatGPTGM(auth, 'owner', 'model', fetcher).narrate(r, config, budget);
    expect(narrationParagraphs(r, narrated)).toEqual([polish === 'approved' ? expanded : story]);
    expect(writing).toBe(2);
    expect(reviewing).toBe(polish === 'disconnected' ? 1 : 2);
    expect(fetcher).toHaveBeenCalledTimes(polish === 'disconnected' ? 3 : 4);
    expect(budget.used).toBeLessThanOrEqual(4);
    expect(budget.fallback).toBeUndefined();
    expect(r).toEqual(before);
  },
);

it.each([false, true])(
  'records response progress and partial-stream diagnostics (completed=%s)',
  async (finish) => {
    const c = context();
    const stage = new AbortController();
    c.requestBudget = { used: 0, limit: 8, signal: stage.signal };
    const text = JSON.stringify(proposal(c));
    const fetcher = vi.fn(
      async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), {
                once: true,
              });
              controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'));
              setTimeout(() => {
                controller.enqueue(
                  new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"{"}\n\n'),
                );
                setTimeout(() => {
                  if (!finish) {
                    stage.abort(new DOMException('Deadline', 'TimeoutError'));
                    return;
                  }
                  controller.enqueue(
                    new TextEncoder().encode(
                      `data: ${JSON.stringify({
                        type: 'response.completed',
                        response: {
                          output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
                          usage: {
                            input_tokens: 100,
                            output_tokens: 80,
                            output_tokens_details: { reasoning_tokens: 30 },
                          },
                        },
                      })}\n\n`,
                    ),
                  );
                  controller.close();
                }, 5);
              }, 5);
            },
          }),
        ),
    ) as unknown as typeof fetch;
    const result = await new ChatGPTGM(auth, 'owner', 'model', fetcher)
      .adjudicate(c, {} as GameTools)
      .catch((error) => error);
    const diagnostic = c.requestBudget.requests![0];
    expect(diagnostic.authMs).toBeLessThanOrEqual(diagnostic.headersMs!);
    expect(diagnostic.headersMs).toBeLessThanOrEqual(diagnostic.firstByteMs!);
    expect(diagnostic.firstByteMs).toBeLessThanOrEqual(diagnostic.firstOutputMs!);
    expect(diagnostic.streamBytes).toBeGreaterThan(0);
    if (finish) {
      expect(result.turnId).toBe(c.turn.id);
      expect(diagnostic).toMatchObject({
        outputTextBytes: Buffer.byteLength(text),
        inputTokens: 100,
        outputTokens: 80,
        reasoningTokens: 30,
      });
      expect(diagnostic.failure).toBeUndefined();
    } else {
      expect(result.name).toBe('TimeoutError');
      expect(diagnostic.failure).toContain('stage deadline');
      expect(diagnostic.outputBytes).toBeUndefined();
    }
  },
);

it('allows a slow adjudication to finish beyond the former 90-second request cap', async () => {
  vi.useFakeTimers();
  const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
  try {
    const c = context();
    c.requestBudget = { used: 0, limit: 8, signal: new AbortController().signal };
    const requestTimeout = new AbortController();
    timeoutSpy.mockImplementation((duration) => {
      expect(duration).toBe(180_000);
      setTimeout(() => requestTimeout.abort(new DOMException('Timeout', 'TimeoutError')), duration);
      return requestTimeout.signal;
    });
    const fetcher = vi.fn(
      (_url, init) =>
        new Promise<Response>((resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
          setTimeout(() => resolve(completed(proposal(c))), 120_000);
        }),
    ) as unknown as typeof fetch;
    const pending = new ChatGPTGM(auth, 'owner', 'model', fetcher).adjudicate(c, {} as GameTools);
    await vi.advanceTimersByTimeAsync(90_001);
    expect(requestTimeout.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).turnId).toBe(c.turn.id);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(c.requestBudget.requests![0]).toMatchObject({ durationMs: 120_000 });
    expect(c.requestBudget.requests![0].failure).toBeUndefined();
  } finally {
    timeoutSpy.mockRestore();
    vi.useRealTimers();
  }
});

it('applies request and stage deadlines to streamed output and preserves user cancellation', async () => {
  const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
  try {
    for (const mode of ['request', 'stage', 'cancel'] as const) {
      const c = context();
      const requestTimeout = new AbortController();
      const stage = new AbortController();
      timeoutSpy.mockImplementation((duration) => {
        expect(duration).toBe(180_000);
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
        mode === 'request' ? '180 seconds' : mode === 'stage' ? 'stage deadline' : 'Stopped',
      );
      expect(budget.requests).toHaveLength(1);
      expect(budget.requests![0].failure).toBe(error.message);
    }
  } finally {
    timeoutSpy.mockRestore();
  }
});

it('freezes NPC voice and new attributed conversation hooks for narration, review and the next turn', async () => {
  const f = fixture();
  await f.start();
  const snapshot = f.game.snapshot(f.c.id, f.host.id);
  const scene = snapshot.scene;
  scene.npcs = {
    ...scene.npcs,
    seli: {
      id: 'seli',
      name: 'Seli',
      aliases: [],
      locationId: scene.location.id!,
      status: 'alive',
      allegiance: null,
      fact: 'Seli studies the inscription here.',
    },
  };
  f.db.prepare('UPDATE campaigns SET scene = ? WHERE id = ?').run(JSON.stringify(scene), f.c.id);
  const memory = 'Seli speaks in clipped, dry phrases and has promised to keep the notebook safe.';
  f.db
    .prepare('INSERT INTO journal(campaign_id,kind,name,detail) VALUES(?,?,?,?)')
    .run(f.c.id, 'npc', 'Seli', memory);
  const actor = f.game.members(f.c.id).find((member) => member.playerId === f.p1.id)!;
  actor.character.personality = 'Curious, theatrical, with a fondness for spy stories.';
  f.db.prepare('UPDATE members SET sheet = ? WHERE id = ?').run(JSON.stringify(actor.character), actor.id);
  const claim =
    'Seli claims someone recarved the inscription and left the same mark on her door. Asked what changed, she says the last line. She offers to show her notebook; the offer remains open.';
  const story = `${actor.character.name} asks, “Have the stones confessed yet?”\n“Slightly,” Seli replies. “Someone recarved the inscription. The same mark is on my door.”\n“What changed?”\n“The last line. I can show you my notebook.”\nThe offer hangs in the air while Zafir al-Raml waits.`;
  let current: GMContext;
  const observed: string[] = [];
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    const data = JSON.parse(body.input[0].content);
    if (body.instructions.startsWith('You are the adjudicator')) {
      expect(body.instructions).toContain('natural clarifying follow-ups');
      expect(body.instructions).toContain('Player commitment is the boundary');
      const value = proposal(current);
      const action = value.actions.find((item) => item.memberId === actor.id)!;
      const own = value.events.find((event) => event.actionId === action.actionId)!;
      own.fact =
        action.fact =
        action.components.main!.fact =
          `${actor.character.name} asks Seli about the research and what changed.`;
      const answer = value.events.at(-1)!;
      Object.assign(answer, {
        npcIds: ['seli'],
        locationRef: scene.location.id,
        fact: claim,
        dependsOn: [{ eventId: own.id, requires: 'occurrence' }],
      });
      value.journal = [];
      value.rewards = { xp: 0, gold: 0, reason: 'An ordinary conversation.' };
      return completed(value);
    }
    expect(body.tools).toBeUndefined();
    expect(body.instructions).toContain(
      'Exact wording and each follow-up question need no separate speech event',
    );
    const savedMemory = data.resolution.journal.find((entry: any) => entry.name === 'Seli').detail;
    expect(savedMemory).toContain(memory);
    expect(savedMemory).toContain(claim);
    expect(data.resolution.executionContext.find((p: any) => p.actorId === actor.id).personality).toBe(
      actor.character.personality,
    );
    observed.push(data.candidate ? 'review' : 'writer');
    if (data.candidate) return completed({ approved: true, feedback: '' });
    return completed({
      version: 2,
      turnId: data.resolution.turnId,
      passages: [{ eventIds: data.resolution.events.map((e: any) => e.id), text: story }],
      closing: '',
      summary: 'Seli claims an inscription changed and offers her notebook; no agreement has been made.',
    });
  }) as unknown as typeof fetch;
  const gm = new ChatGPTGM(auth, 'owner', 'model', fetcher);
  f.provider.adjudicate = (context, tools) => {
    current = context;
    return gm.adjudicate(context, tools);
  };
  f.provider.narrate = gm.narrate.bind(gm);
  f.draw.mockClear();
  f.game.submit(f.c.id, f.p1.id, snapshot.turn!.id, 'I ask Seli about her research.', false);
  f.game.submit(f.c.id, f.p2.id, snapshot.turn!.id, '', true);
  await f.game.idle();
  const done = f.game.snapshot(f.c.id, f.host.id);
  expect(done.turn!.phase, done.turn!.error ?? '').toBe('collecting');
  expect(done.history.at(-1)!.result!.narration).toBe(story);
  expect(done.journal.find((entry) => entry.name === 'Seli')!.detail).toContain(claim);
  expect(observed).toEqual(['writer', 'review']);
  expect(f.draw).not.toHaveBeenCalled();
  // The next adjudication receives the same attributed hook and earlier voice after restart.
  let nextMemory = '';
  f.provider.adjudicate = async (context) => {
    nextMemory = context.journal.find((entry) => entry.name === 'Seli')!.detail;
    return proposal(context);
  };
  f.provider.narrate = f.narrate;
  const restarted = new Game(f.db, f.factory, f.draw);
  restarted.submit(f.c.id, f.p1.id, done.turn!.id, '', true);
  restarted.submit(f.c.id, f.p2.id, done.turn!.id, '', true);
  await restarted.idle();
  expect(nextMemory).toContain(memory);
  expect(nextMemory).toContain(claim);
});

it('freezes sheet personality for the writer and reviewer and permits bounded character voice and footwork', async () => {
  const f = fixture();
  await f.start();
  const actor = f.game.members(f.c.id)[0];
  actor.character.personality = 'Cautious and curious; speaks briefly and checks details before acting.';
  f.db.prepare('UPDATE members SET sheet = ? WHERE id = ?').run(JSON.stringify(actor.character), actor.id);
  let story = '';
  let writing = 0;
  let reviewing = 0;
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    const data = JSON.parse(body.input[0].content);
    const profile = data.resolution.executionContext.find((item: any) => item.actorId === actor.id);
    expect(profile.personality).toBe(actor.character.personality);
    expect(body.instructions).toContain('incidental lines need no separate speech event');
    expect(body.instructions).toContain('SAME saved location');
    expect(body.instructions).toContain('Never use decorative speech to add a decision');
    if (data.candidate) {
      reviewing++;
      expect(data.candidate.passages[0].text).toBe(story);
      return completed({ storyApproved: true, summaryApproved: true, feedback: '', styleFeedback: '' });
    }
    writing++;
    expect(body.instructions).toContain('180–300 words');
    story = `${actor.character.name} leans toward the mechanism. “Slowly. Let me look.” ${data.resolution.events.map((event: any) => event.fact).join(' ')}`;
    // Editing the live sheet must not change the already finalized voice or factual authority.
    f.db
      .prepare('UPDATE members SET sheet = ? WHERE id = ?')
      .run(JSON.stringify({ ...actor.character, personality: 'A later edit.' }), actor.id);
    return completed({
      version: 2,
      turnId: data.resolution.turnId,
      passages: [{ eventIds: data.resolution.events.map((event: any) => event.id), text: story }],
      closing: '',
      summary: 'The sanctuary and caravan traces are revealed.',
    });
  }) as unknown as typeof fetch;
  const gm = new ChatGPTGM(auth, 'owner', 'model', fetcher);
  f.provider.narrate = gm.narrate.bind(gm);
  const id = f.submit();
  await f.game.idle();
  const snapshot = f.game.snapshot(f.c.id, f.host.id);
  const done = snapshot.history.at(-1)!;
  expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
  expect(done.id).toBe(id);
  expect(done.result!.narration).toBe(story);
  expect(done.resolution!.executionContext!.find((item) => item.actorId === actor.id)!.personality).toBe(
    actor.character.personality,
  );
  expect(writing).toBe(1);
  expect(reviewing).toBe(1);
  expect(f.draw).not.toHaveBeenCalled();
});

it.each([false, true])(
  'retains approved story when only the summary fails review (earlier story rejection: %s)',
  async (earlierRejection) => {
    const r = resolution();
    const before = structuredClone(r);
    const story = r.events.map((event) => event.fact).join(' ');
    let reviews = 0;
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      const data = JSON.parse(body.input[0].content);
      expect(body.tools).toBeUndefined();
      if (data.candidate) {
        reviews++;
        expect(body.instructions).toContain('independently from the situation summary');
        return completed({
          storyApproved: !earlierRejection || reviews > 1,
          summaryApproved: false,
          feedback:
            earlierRejection && reviews === 1
              ? 'The story invents a second sanctuary.'
              : 'The summary claims the caravan was rescued; only traces were discovered.',
        });
      }
      return completed({
        version: 2,
        turnId: r.turnId,
        passages: [
          {
            eventIds: r.events.map((event) => event.id),
            text: earlierRejection && !reviews ? 'A second sanctuary appears.' : story,
          },
        ],
        closing: '',
        summary: 'The lost caravan has been rescued.',
      });
    }) as unknown as typeof fetch;
    const budget: StageBudget = { used: 0, limit: 4 };
    const narration = await new ChatGPTGM(auth, 'owner', 'model', fetcher).narrate(r, config, budget);
    expect(narrationParagraphs(r, narration)).toEqual([story]);
    expect(narration.summary).toContain('lost caravan');
    expect(narration.summary).not.toContain('rescued');
    expect(budget.fallback).toBeUndefined();
    expect(budget.corrections!.at(-1)!.feedback).toContain('Situation summary replaced with saved facts');
    expect(fetcher).toHaveBeenCalledTimes(earlierRejection ? 4 : 2);
    expect(r).toEqual(before);
  },
);

it.each(['repeated', 'invented'])(
  'preserves faithful passages when an empty-ID ending contains a %s closing defect',
  async (defect) => {
    const r = resolution();
    r.checkReasons = { [r.events[0].id]: 'Rain and wet foliage obscure the search.' };
    const before = structuredClone(r);
    const story = r.events.map((event) => event.fact).join(' ');
    const closing = defect === 'invented' ? 'An unknown golden key appears.' : r.events[0].fact;
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      const data = JSON.parse(body.input[0].content);
      expect(body.tools).toBeUndefined();
      expect(data.resolution.checkReasons).toEqual(r.checkReasons);
      if (data.candidate) {
        expect(data.candidate.closing).toBe(closing);
        expect(data.candidate.passages).toHaveLength(1);
        expect(body.instructions).toContain('never reject a faithful complete story solely for brevity');
        return completed({
          storyApproved: true,
          closingApproved: false,
          summaryApproved: true,
          feedback: `The closing contains a ${defect} detail.`,
          styleFeedback: 'The passages could have more scene texture.',
        });
      }
      expect(body.instructions).toContain('roughly 70–120 words');
      expect(body.instructions).toContain('Weave material observable help or hindrance');
      return completed({
        version: 2,
        turnId: r.turnId,
        passages: [
          { eventIds: r.events.map((event) => event.id), text: story },
          { eventIds: [], text: closing },
        ],
        closing: '',
        summary: 'The sanctuary is revealed.',
      });
    }) as unknown as typeof fetch;
    const budget: StageBudget = { used: 0, limit: 4 };
    const narrated = await new ChatGPTGM(auth, 'owner', 'model', fetcher).narrate(r, config, budget);
    expect(narrationParagraphs(r, narrated)).toEqual([story]);
    expect(narrated.closing).toBe('');
    expect(budget.fallback).toBeUndefined();
    expect(budget.used).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(budget.corrections!.map((item) => item.feedback)).toEqual([
      expect.stringContaining('Closing removed'),
      expect.stringContaining('Narration style'),
    ]);
    expect(r).toEqual(before);
  },
);

it.each(['fidelity', 'split fidelity', 'invalid JSON', 'tool call'])(
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
        return completed(
          failure === 'split fidelity'
            ? { storyApproved: false, summaryApproved: true, feedback: 'Closing invents a clue.' }
            : { approved: false, feedback: 'Closing invents a clue.' },
        );
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
    expect(requests).toBe(failure.endsWith('fidelity') ? 4 : 2);
    expect(reviews).toBe(failure.endsWith('fidelity') ? 2 : 0);
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
    interruptNarration(f.db, feedback);
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
  'keeps unresolved story consequences retriable with saved checks and resources (item executed: %s)',
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
    expect(snapshot.turn!.id).toBe(turn.id);
    expect(snapshot.turn!.phase).toBe('failed');
    expect(snapshot.turn!.error).toContain('could not finish the story consequences');
    expect(snapshot.turn!.rolls).toHaveLength(1);
    expect(snapshot.turn!.rolls[0]).toMatchObject({ memberId: ally.id, success: true });
    expect(f.draw).toHaveBeenCalledTimes(1);
    const checkpoint = f.draft(turn.id);
    expect(checkpoint.adjudication).toBeUndefined();
    expect(checkpoint.resolution).toBeUndefined();
    const unchanged = checkpoint.members.find((member: any) => member.id === actor.id)!;
    expect(unchanged.state.hp).toBe(executeItem ? actor.state.maxHp : actor.state.hp);
    expect(unchanged.state.inventory.find((item: any) => item.id === potion.id)?.quantity ?? 0).toBe(
      executeItem ? 0 : 1,
    );
    expect(unchanged.state.abilityUses?.[ability.name] ?? 0).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(4);
    const narrationStage = f.db
      .prepare("SELECT payload FROM events WHERE turn_id=? AND kind='stage:narration'")
      .get(turn.id);
    expect(narrationStage).toBeUndefined();
    expect(snapshot.members.map((member) => member.state.xp)).toEqual([0, 0]);
    f.provider.adjudicate = async (context) => {
      const value = proposal(context);
      value.actions[0].components.main!.basis = 'none';
      return changeMain(value, actor.id, 'blocked', 'The requested teleport is unavailable.');
    };
    f.game.retry(f.c.id, f.host.id);
    await f.game.idle();
    const resumed = f.game.snapshot(f.c.id, f.host.id);
    expect(resumed.turn?.phase, resumed.turn?.error ?? '').toBe('collecting');
    expect(resumed.history.at(-1)!.rolls).toEqual(snapshot.turn!.rolls);
    expect(f.draw).toHaveBeenCalledTimes(1);
    expect(resumed.members.find((member) => member.id === actor.id)!.state.inventory).toEqual(
      unchanged.state.inventory,
    );
  },
);

it('uses saved action outcomes when check events contain only mechanical results', () => {
  const r = resolution();
  const facts = [
    'Amon-Sah searches the equipment corner but finds nothing useful.',
    'Zafir al-Raml sees movement behind the ferns, but cannot identify its source.',
  ];
  r.events = r.actions.map((action, index) => {
    const id = `check:${index}`;
    const status = index ? ('success' as const) : ('failure' as const);
    Object.assign(action, { fact: facts[index], eventIds: [id], status, basis: 'check' });
    Object.assign(action.components.main!, { fact: facts[index], eventIds: [id], status, basis: 'check' });
    return {
      id,
      sequence: index,
      kind: 'mechanics' as const,
      actionId: action.actionId,
      memberId: action.memberId,
      phase: 'main' as const,
      result: status,
      fact: `${action.characterName}: the WIS check ${index ? 'succeeds' : 'fails'}.`,
      receiptRefs: [],
      dependsOn: [],
    };
  });
  const before = structuredClone(r);
  const narration = factualNarration(r, config.language);
  expect(narrationParagraphs(r, narration)).toEqual(facts);
  expect(narration.summary).toContain('finds nothing useful');
  expect(narration.summary).toContain('cannot identify its source');
  expect(narration.summary).not.toContain('WIS check');
  expect(assembleResolvedNarration(r, narration)).toEqual(narration);
  expect(r).toEqual(before);
});

it('covers check receipts without repeating their later fictional outcomes in the fallback', () => {
  const r = resolution();
  const facts = [
    'Rain hides the depth of the tar from Amon-Sah.',
    'Zafir al-Raml recognizes an impact pattern on the rib despite the wet mud.',
  ];
  const checks = r.actions.map((action, index) => {
    const id = `check:${index}`;
    const outcomeId = `action:${index}`;
    const status = index ? ('success' as const) : ('failure' as const);
    Object.assign(action, { fact: facts[index], eventIds: [id, outcomeId], status, basis: 'check' });
    Object.assign(action.components.main!, {
      fact: facts[index],
      eventIds: [id, outcomeId],
      status,
      basis: 'check',
    });
    return {
      id,
      sequence: index,
      kind: 'mechanics' as const,
      actionId: action.actionId,
      memberId: action.memberId,
      phase: 'main' as const,
      result: status,
      fact: `${action.characterName}: the WIS check ${index ? 'succeeds' : 'fails'}.`,
      receiptRefs: [],
      dependsOn: [],
    };
  });
  r.events = [
    ...checks,
    ...checks.map((check, index) => ({
      ...check,
      id: `action:${index}`,
      sequence: checks.length + index,
      kind: 'action' as const,
      fact: facts[index],
      dependsOn: [{ eventId: check.id, requires: 'occurrence' as const }],
    })),
  ];
  const before = structuredClone(r);
  const narration = factualNarration(r, config.language);
  expect(narration.version).toBe(2);
  if (narration.version !== 2) throw new Error('Expected grouped narration.');
  expect(narration.passages).toEqual([
    { eventIds: r.events.map((event) => event.id), text: facts.join('\n\n') },
  ]);
  expect(assembleResolvedNarration(r, narration)).toEqual(narration);
  expect(r).toEqual(before);

  // A separate successful effect must not hide a failed check in a partial main action.
  r.actions[0].status = 'partial';
  r.actions[0].components.main!.status = 'partial';
  r.events[2].result = 'success';
  r.events[2].fact = 'Amon-Sah startles a bird from the reeds.';
  const partial = factualNarration(r, config.language);
  const partialText = narrationParagraphs(r, partial).join('\n\n');
  expect(partialText).toContain(facts[0]);
  expect(partialText).toContain('startles a bird');
  expect(assembleResolvedNarration(r, partial)).toEqual(partial);
});

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
    interruptNarration(f.db, 'Paused narrator');
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
      const feedback = JSON.parse(body.input[0].content);
      expect(
        JSON.stringify(body.input),
        JSON.stringify(feedback.correctionsToPreserve ?? feedback.feedback),
      ).toContain('Victory needs a local world aftermath');
      value.location = { name: 'Checkpoint', atmosphere: 'The gate is quiet and accessible.', hazard: '' };
      const aftermath = value.events.find((event) => event.id === 'world:discovery')!;
      aftermath.phase = 'aftermath';
      aftermath.fact = 'With the drone destroyed, the checkpoint gate is accessible again.';
      aftermath.locationRef = current.scene.location.id;
      value.journal = [{ kind: 'location', name: 'Checkpoint', detail: aftermath.fact }];
      value.encounterRisks = [
        {
          locationId: current.scene.location.id!,
          eventId: aftermath.id,
          danger: 'safe',
          reason: 'The destroyed drone no longer controls or threatens the checkpoint.',
        },
      ];
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
  expect(snapshot.scene.location).toMatchObject({
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
    interruptNarration(f.db, 'Prose unavailable');
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

it('stops invalid structured responses early within the shared request budget including combat planning', async () => {
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
  expect(c.requestBudget.fallback).toContain('3 invalid structured responses');
  expect(fetcher).toHaveBeenCalledTimes(6);
  expect(c.requestBudget.used).toBe(6);
});

it.each(['repaired', 'malformed', 'rewrites retained facts', 'oversized response', 'provider rejection'])(
  'preserves independent action progress when compact recovery is %s',
  async (repair) => {
    const f = fixture();
    await f.start();
    let current: GMContext;
    let original: TurnAdjudication;
    const requests: any[] = [];
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      requests.push(body);
      if (requests.length === 1) {
        original = proposal(current);
        const invalid = structuredClone(original);
        invalid.events.find((event) => event.id === 'act:1')!.result = 'failure';
        return completed(invalid);
      }
      const input = JSON.parse(body.input[0].content);
      expect(body.tools).toBeUndefined();
      expect(input.task).toContain('Repair only unresolved');
      expect(input.lockedComponents).toEqual([`${current.members[0].id}:main`]);
      expect(input.unresolvedActions.map((action: any) => action.memberId)).toEqual([current.members[1].id]);
      if (repair === 'malformed') return completed({ malformed: true });
      if (repair === 'oversized response') return completed({ extra: 'x'.repeat(2_000_001) });
      if (repair === 'provider rejection') return new Response(null, { status: 503 });
      if (repair === 'rewrites retained facts') {
        const changed = structuredClone(original!);
        changed.actions[0].components.main!.fact = 'A different action was chosen.';
        return completed({ actions: changed.actions, events: changed.events });
      }
      return completed({
        actions: [original!.actions[1]],
        events: original!.events.filter((event) => event.id !== 'act:0'),
        journal: original!.journal,
        rewards: original!.rewards,
      });
    }) as unknown as typeof fetch;
    const gm = new ChatGPTGM(auth, 'owner', 'model', fetcher);
    f.provider.adjudicate = (context, tools) => {
      current = context;
      return gm.adjudicate(context, tools);
    };
    const narrationCalls = f.narrate.mock.calls.length;
    const narrate = f.provider.narrate!;
    if (repair === 'malformed')
      f.provider.narrate = async () => {
        interruptNarration(f.db, 'Interrupted after retained progress was finalized');
      };
    const id = f.submit();
    await f.game.idle();
    if (repair === 'provider rejection') {
      const failed = f.game.snapshot(f.c.id, f.host.id);
      expect(failed.turn?.phase).toBe('failed');
      expect(failed.turn?.error).toContain('ChatGPT is temporarily unavailable');
      expect(f.draft(id).adjudication).toBeUndefined();
      expect(f.narrate).toHaveBeenCalledTimes(narrationCalls);
      expect(fetcher).toHaveBeenCalledTimes(2);
      return;
    }
    if (repair === 'malformed') {
      expect(f.game.snapshot(f.c.id, f.host.id).turn?.phase).toBe('failed');
      expect(f.draft(id).adjudication.actions[0].status).toBe('success');
      f.provider.narrate = narrate;
      f.game.retry(f.c.id, f.host.id);
      await f.game.idle();
    }
    const snapshot = f.game.snapshot(f.c.id, f.host.id);
    expect(snapshot.turn?.phase, snapshot.turn?.error ?? '').toBe('collecting');
    const done = snapshot.history.at(-1)!;
    expect(done.id).toBe(id);
    expect(done.resolution!.actions.map((action) => action.status)).toEqual([
      'success',
      repair === 'repaired' ? 'success' : 'blocked',
    ]);
    expect(done.result!.narration).toContain('unlocks the recessed closure');
    expect(done.result!.narration.includes('bronze sun disk')).toBe(repair === 'repaired');
    expect(done.result!.narration).not.toContain('different action');
    expect(f.draft(id).adjudicationFallback).toBeUndefined();
    expect(f.narrate).toHaveBeenCalledTimes(narrationCalls + 1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(f.draw).not.toHaveBeenCalled();
    expect(snapshot.members.map((member) => member.state.xp)).toEqual(
      repair === 'repaired' ? [10, 10] : [0, 0],
    );
  },
);

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
      value.location = {
        id: context.scene.location.id,
        name: 'Guardian doorway',
        atmosphere: 'A sealed entrance.',
        hazard: 'Guardian.',
      };
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
    value.memberLocations = value.actions
      .filter((action) => action.components.main?.status === 'success')
      .map((action) => ({ memberId: action.memberId, locationId: 'destination' }));
    if (context.turn.number === 1)
      for (const action of value.actions) {
        const event = value.events.find(
          (event) => event.actionId === action.actionId && event.phase === 'main',
        )!;
        event.effect = 'movement';
        event.fact = `${context.members.find((member) => member.id === action.memberId)!.character.name} boards the ship deck.`;
        action.fact = event.fact;
        action.components.main!.fact = event.fact;
        value.memberLocations!.find((position) => position.memberId === action.memberId)!.movementEventId =
          event.id;
      }
    return value;
  });
  f.db.exec(
    `CREATE TRIGGER interrupt_boarding BEFORE UPDATE OF draft ON turns WHEN NEW.draft LIKE '%"resolution":%' BEGIN SELECT RAISE(ABORT, 'boarding interrupted'); END;`,
  );
  const id = f.game.snapshot(f.c.id, f.host.id).turn!.id;
  f.game.submit(f.c.id, f.p1.id, id, 'Board the ship deck.', false);
  f.game.submit(f.c.id, f.p2.id, id, 'Board the ship deck.', false);
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
  expect(snapshot.scene.location).toMatchObject(deck);
  expect(snapshot.scene.encounter).toEqual(saved.scene.encounter);
  expect(snapshot.scene.encounter!.round).toBe(1);
  expect(snapshot.history.at(-1)!.rolls).toEqual(rolls);
  expect(f.provider.adjudicate).toHaveBeenCalledTimes(1);
  expect(f.draw).toHaveBeenCalledTimes(draws);
  restarted.submit(f.c.id, f.p1.id, snapshot.turn!.id, 'Move toward the helm', false);
  restarted.submit(f.c.id, f.p2.id, snapshot.turn!.id, '', true);
  await restarted.idle();
  const failed = restarted.snapshot(f.c.id, f.host.id).turn!;
  expect(failed.error).toMatch(
    /adjudication:.*(?:successful submitted movement|cannot leave an active combat)/,
  );
  const draft = JSON.parse(restarted.pending(f.c.id)!.draft!);
  expect(draft.adjudication).toBeUndefined();
  expect(draft.receipts.combat).toBeDefined();
  expect(restarted.snapshot(f.c.id, f.host.id).scene.location).toMatchObject(deck);
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
      interruptNarration(f.db, 'Narration interrupted.');
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
    const turn = f.game.snapshot(f.c.id, f.host.id).turn!;
    f.game.submit(f.c.id, f.p2.id, turn.id, 'Read the inscriptions', false);
    // The target submitted while able to act, then became stunned before execution.
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
    f.game.submit(f.c.id, f.p1.id, turn.id, 'Use Cleanse Stun on Zafir al-Raml', false);
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
    const turn = f.game.snapshot(f.c.id, f.host.id).turn!;
    f.game.submit(f.c.id, f.p1.id, turn.id, 'Drink Red Potion and open the closure', false);
    // Exercise a condition acquired after submission; already incapacitated players cannot submit.
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
  f.db
    .prepare('INSERT INTO journal(campaign_id,kind,name,detail) VALUES(?, ?, ?, ?)')
    .run(f.c.id, 'fact', 'Prepared cannon', evidence);
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
    interruptNarration(f.db, 'Controlled presentation interruption');
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

it('accepts a victory refresh through the new place contract without a legacy location update', async () => {
  const c = context();
  c.scene.location.id = randomUUID();
  c.combatResult = {
    participantIds: [],
    logs: [],
    events: [],
    characters: [],
    loot: [],
    encounter: { round: 1, victory: true, escaped: false, enemies: [], initiative: [] },
  };
  const value = proposal(c);
  value.rewards.xp = 0;
  value.placeUpdates = [
    {
      ref: c.scene.location.id,
      location: { name: c.scene.location.name, atmosphere: 'The cleared gate is accessible.', hazard: '' },
    },
  ];
  value.sceneFocus = 'current';
  value.events.at(-1)!.phase = 'aftermath';
  const fetcher = vi.fn(async () => completed(value)) as unknown as typeof fetch;
  const tools = Object.assign(vi.fn(), {
    validateAdjudication: (input: unknown) => validateAdjudication(c, input),
  }) as unknown as GameTools;
  const accepted = await new ChatGPTGM(auth, 'owner', 'model', fetcher).adjudicate(c, tools);
  expect(accepted.location).toBeNull();
  expect(accepted.placeUpdates![0].ref).toBe(c.scene.location.id);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
