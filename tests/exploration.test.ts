import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { openDatabase } from '../server/db';
import { Game, type GameMaster, type GMContext, type GameTools } from '../server/game';
import { PracticeGM, ChatGPTGM, adjudicationInput } from '../server/providers';
import type { ChatGPTAuth } from '../server/auth';
import { engineEvents, validateAdjudication } from '../server/turn-resolution';
import { travelNextHop } from '../server/world-map';
import { ensureLocations, memberScene, placeScene } from '../shared/locations';
import {
  actionId,
  aggregateComponents,
  turnResolutionSchema,
  type TurnAdjudication,
} from '../shared/turn-resolution';
import { initialScene } from '../shared/rules';
import { templateCharacter, type LootBlueprint } from '../shared/schema';

const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
const potion: LootBlueprint = {
  name: 'Sealed field potion',
  kind: 'consumable',
  scaling: [],
  hands: 1,
  light: true,
  description: 'A sealed healing potion in a discarded field pack.',
};

async function table({
  chance = 15,
  checkDie = 12,
  sources = ['field-pack', 'field-pack'],
  reward = potion,
  storyTool = false,
  checked = true,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'exploration-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'game.sqlite');
  const db = openDatabase(filename);
  cleanup.push(() => {
    if (db.open) db.close();
  });
  const practice = new PracticeGM();
  let lastContext: GMContext;
  let lastValue: TurnAdjudication;
  const adjudicate = async (context: GMContext, tools: GameTools): Promise<TurnAdjudication> => {
    if (!context.turn.number) return practice.adjudicate(context, tools);
    for (const [index, action] of context.turn.actions.entries()) {
      if (!checked || action.passed || memberScene(context.scene, action.memberId).searches?.[sources[index]])
        continue;
      tools({
        memberId: action.memberId,
        stat: 'WIS',
        dc: 10,
        mode: 'normal',
        reason: 'Read washed-out tracks beside the field pack.',
        lethal: false,
      });
    }
    if (storyTool && !context.turn.actions[0].passed)
      tools.offerLoot({
        item: { ...potion, name: 'Field letter', kind: 'tool' },
        memberId: context.turn.actions[0].memberId,
        sourceId: sources[0],
        locationId: context.scene.location.id,
        reason: 'The successful search reveals a portable letter.',
      });
    const events = engineEvents(context);
    const actions = context.turn.actions.map((submitted, index) => {
      const id = actionId(context.turn.id, submitted.memberId);
      const roll = context.turn.rolls.find((roll) => roll.memberId === submitted.memberId && !roll.notation);
      const status = roll && !roll.success ? ('failure' as const) : ('success' as const);
      const outcomeId = `action:${index}`;
      const fact =
        roll && !roll.success ? 'The precise trail cannot be read.' : 'The visible trail continues downhill.';
      const receiptRefs = roll ? [`roll:${roll.id}`] : [];
      events.push({
        id: outcomeId,
        sequence: events.length,
        kind: 'action',
        phase: submitted.passed ? null : 'main',
        result: submitted.passed ? null : status,
        actionId: id,
        memberId: submitted.memberId,
        fact: submitted.passed ? 'The companion waits.' : fact,
        receiptRefs,
        dependsOn: [],
      });
      const main = {
        status,
        basis: roll ? ('check' as const) : ('routine' as const),
        fact,
        reason: 'The recorded search result.',
        receiptRefs,
        eventIds: [...(roll ? [`check:${roll.id}`] : []), outcomeId],
      };
      if (submitted.passed)
        return {
          actionId: id,
          memberId: submitted.memberId,
          status: 'passed' as const,
          basis: 'none' as const,
          fact: 'The companion waits.',
          reason: 'Passed.',
          receiptRefs: [],
          eventIds: [outcomeId],
          components: { main: null, minor: null },
        };
      const informationEventId = `information:${index}`;
      const locationId = memberScene(context.scene, submitted.memberId).location.id!;
      events.push({
        id: informationEventId,
        sequence: events.length,
        kind: 'world',
        phase: 'aftermath',
        result: null,
        actionId: null,
        memberId: null,
        locationRef: locationId,
        fact: 'A shallow mud channel continues downhill beside a sheltered rock alcove.',
        receiptRefs: [],
        dependsOn: roll
          ? [{ eventId: `check:${roll.id}`, requires: roll.success ? 'success' : 'occurrence' }]
          : [],
      });
      return {
        actionId: id,
        memberId: submitted.memberId,
        ...main,
        components: { main, minor: null },
        intent: 'search' as const,
        search: {
          sourceId: sources[index],
          locationId,
          informationEventId,
          reward: roll?.success ? reward : null,
        },
      };
    });
    const value: TurnAdjudication = {
      version: 2,
      turnId: context.turn.id,
      actions,
      events,
      changes: [],
      journal: [],
      location: null,
      rewards: { xp: 0, gold: 0, reason: 'No automatic reward.' },
    };
    lastContext = structuredClone(context);
    lastValue = structuredClone(value);
    return value;
  };
  const provider: GameMaster = { adjudicate, narrate: practice.narrate.bind(practice) };
  const draw = vi.fn((sides: number) => (sides === 20 ? checkDie : sides === 100 ? chance : 1));
  const game = new Game(db, () => provider, draw);
  const host = game.identify();
  const players = [game.identify(), game.identify()];
  const campaign = game.create(host.id, {
    ruleset: 'roguelike-v1',
    name: 'Exploration',
    setting: 'Rainy crater',
    premise: '',
    tone: 'Immersive',
    language: 'English',
    instructions: '',
    custom: [],
    provider: 'practice',
    model: '',
  });
  for (const [index, player] of players.entries()) {
    const saved = game.saveCharacter(player.id, templateCharacter(index ? 'Companion' : 'Explorer'));
    game.join(campaign.inviteCode!, player.id, saved.id);
    const member = game.members(campaign.id).find((member) => member.playerId === player.id)!;
    game.manageCharacter(campaign.id, player.id, {
      type: 'starter',
      itemIds: member.state.starterEquipment.slice(0, 2).map((item) => item.id),
    });
    const ready = game.members(campaign.id).find((member) => member.playerId === player.id)!;
    ready.state.equipment = { left: null, right: null, body: null, head: null, boots: null, relic: null };
    ready.state.stats.WIS = 5;
    db.prepare('UPDATE members SET state=? WHERE id=?').run(JSON.stringify(ready.state), ready.id);
  }
  game.start(campaign.id, host.id);
  await game.idle();
  const submit = async (both = false, text = 'Search the wet ground.') => {
    const turn = game.snapshot(campaign.id, host.id).turn!;
    for (const [index, player] of players.entries())
      game.submit(campaign.id, player.id, turn.id, index && !both ? '' : text, !!index && !both);
    await game.idle();
    return turn.id;
  };
  return {
    db,
    filename,
    game,
    host,
    campaign,
    provider,
    draw,
    submit,
    context: () => lastContext!,
    value: () => lastValue!,
  };
}

it.each([1, 15, 16, 100])(
  'uses the saved 15%% bonus boundary (d100=%i) and never rerolls an unchanged source',
  async (chance) => {
    const f = await table({ chance });
    const id = await f.submit();
    const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    const done = snapshot.history.at(-1)!;
    expect(done.id).toBe(id);
    expect(done.phase).toBe('complete');
    expect(done.resolution!.actions[0].status).toBe('success');
    expect(snapshot.scene.loot).toHaveLength(chance <= 15 ? 1 : 0);
    expect(snapshot.scene.searches!['field-pack'].rewardRolled).toBe(true);
    if (chance <= 15) {
      expect(snapshot.scene.loot[0].healing).toBeGreaterThan(0);
      expect(done.result!.narration).toContain(potion.name);
    } else expect(done.result!.narration).not.toContain(potion.name);
    const draws = f.draw.mock.calls.length;
    await f.submit();
    expect(f.draw).toHaveBeenCalledTimes(draws);
    expect(f.game.snapshot(f.campaign.id, f.host.id).scene.loot).toEqual(snapshot.scene.loot);
  },
);

it('keeps a failed search failed while recording useful information and no bonus roll', async () => {
  const f = await table({ checkDie: 2 });
  await f.submit();
  const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
  const done = snapshot.history.at(-1)!;
  expect(done.phase).toBe('complete');
  const resolution = done.resolution!;
  if (resolution.version !== 2) throw new Error('Expected component outcomes.');
  expect(resolution.actions[0].components.main!.status).toBe('failure');
  expect(done.result!.narration).toContain('mud channel');
  expect(snapshot.scene.searches!['field-pack']).toMatchObject({
    rewardRolled: false,
    information: expect.stringContaining('alcove'),
  });
  expect(snapshot.scene.loot).toHaveLength(0);
  expect(f.draw).toHaveBeenCalledTimes(1);
});

it.each([
  { label: 'routine inspection', checked: false, checkDie: 12, status: 'success' },
  { label: 'successful search', checked: true, checkDie: 12, status: 'success' },
  { label: 'failed search', checked: true, checkDie: 2, status: 'failure' },
  {
    label: 'failed search with misplaced ordering metadata',
    checked: true,
    checkDie: 2,
    status: 'failure',
    misplaced: true,
  },
  {
    label: 'successful search with omitted ordering metadata',
    checked: true,
    checkDie: 12,
    status: 'success',
    misplaced: false,
  },
])(
  'moves one location and resolves a $label there in the same turn',
  async ({ checked, checkDie, status, misplaced }) => {
    const f = await table({ checked, checkDie, chance: 100 });
    const before = f.game.snapshot(f.campaign.id, f.host.id);
    const from = before.scene.location.id!;
    const to = randomUUID();
    before.scene.worldMap!.nodes[to] = { id: to, name: 'Landing', visited: false };
    before.scene.worldMap!.connections.push({
      from,
      to,
      label: 'Open path to the landing',
      blocked: false,
      bidirectional: true,
    });
    f.db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(before.scene), f.campaign.id);
    const adjudicate = f.provider.adjudicate!;
    let mixed!: TurnAdjudication;
    f.provider.adjudicate = async (context, tools) => {
      const value = await adjudicate(context, tools);
      const action = value.actions[0];
      const roll = context.turn.rolls.find((roll) => roll.memberId === action.memberId && !roll.notation);
      const moveId = 'action:walk';
      const fact = 'Explorer follows the open path and arrives at the landing.';
      value.events.unshift({
        id: moveId,
        sequence: 0,
        kind: 'action',
        memberId: action.memberId,
        actionId: action.actionId,
        phase: 'movement',
        result: 'success',
        locationRef: to,
        ...(roll ? { beforeEventId: `check:${roll.id}` } : {}),
        fact,
        receiptRefs: [],
        dependsOn: [],
      });
      action.components.movement = {
        status: 'success',
        basis: 'routine',
        fact,
        reason: 'The adjacent path is open; the investigation happens after arrival.',
        receiptRefs: [],
        eventIds: [moveId],
      };
      action.eventIds = [moveId, ...action.eventIds];
      Object.assign(action, aggregateComponents(action.components));
      action.fact = `${fact} ${action.components.main!.fact}`;
      action.search!.locationId = to;
      action.travel = { goalId: to, via: [], avoid: [] };
      for (const event of value.events.filter(
        (event) => event.id === 'action:0' || event.id === action.search!.informationEventId,
      )) {
        event.locationRef = to;
        event.dependsOn.push({ eventId: moveId, requires: 'success' });
      }
      value.events.splice(1 + engineEvents(context).length, 0, {
        id: 'world:landing',
        sequence: 0,
        kind: 'world',
        memberId: null,
        actionId: null,
        phase: null,
        result: null,
        locationRef: to,
        fact: 'A small landing overlooks a muddy channel; the open path leads back uphill.',
        receiptRefs: [],
        dependsOn: [{ eventId: moveId, requires: 'success' }],
      });
      value.events.forEach((event, sequence) => (event.sequence = sequence));
      value.placeUpdates = [
        { ref: to, location: { name: 'Landing', atmosphere: 'Wet mud and a sheltered alcove.', hazard: '' } },
      ];
      value.memberLocations = [{ memberId: action.memberId, locationId: to, movementEventId: moveId }];
      value.arrivals = [{ locationId: to, eventId: 'world:landing' }];
      if (misplaced !== undefined) {
        const move = value.events.find((event) => event.id === moveId)!;
        if (misplaced) (action.components.movement as any).beforeEventId = move.beforeEventId;
        delete move.beforeEventId;
        const outcome = value.events.find((event) => event.id === 'action:0')!;
        outcome.dependsOn.push({
          eventId: `check:${roll!.id}`,
          requires: roll!.success ? 'success' : 'occurrence',
        });
        const information = value.events.find((event) => event.id === action.search!.informationEventId)!;
        information.dependsOn = [{ eventId: outcome.id, requires: roll!.success ? 'success' : 'occurrence' }];
        action.eventIds.push(information.id);
        action.components.main!.eventIds.push(information.id);
      }
      mixed = structuredClone(value);
      return value;
    };
    const narrate = vi.spyOn(f.provider, 'narrate');
    const id = await f.submit(false, 'Walk down to the landing, then investigate the muddy channel.');
    const after = f.game.snapshot(f.campaign.id, f.host.id);
    expect(after.turn?.phase, after.turn?.error ?? '').toBe('collecting');
    const done = after.history.at(-1)!;
    expect(done.id).toBe(id);
    expect(done.phase, after.turn?.error ?? '').toBe('complete');
    const resolution = done.resolution!;
    if (resolution.version !== 2) throw new Error('Expected component outcomes.');
    expect(resolution.actions[0]).toMatchObject({
      status: status === 'failure' ? 'partial' : 'success',
      components: { movement: { status: 'success', basis: 'routine' }, main: { status } },
      search: { locationId: to },
    });
    expect(resolution.memberLocations).toEqual({ [before.members[0].id]: to, [before.members[1].id]: from });
    expect(memberScene(after.scene, before.members[0].id).searches!['field-pack'].information).toContain(
      'alcove',
    );
    expect(memberScene(after.scene, before.members[1].id).searches).toBeUndefined();
    expect(done.rolls.filter((roll) => !roll.notation)).toHaveLength(checked ? 1 : 0);
    expect(narrate).toHaveBeenCalledTimes(1);
    const prose = done.result!.narration;
    expect(prose).toContain('arrives at the landing');
    expect(prose).toContain('open path leads back uphill');
    expect(prose).toContain('shallow mud channel');
    expect(prose.indexOf('arrives at the landing')).toBeLessThan(
      prose.indexOf(status === 'failure' ? 'cannot be read' : 'continues downhill'),
    );
    expect(resolution.arrivals).toEqual([{ locationId: to, eventId: 'world:landing' }]);
    expect(after.scene.worldMap!.nodes[to].visited).toBe(true);
    if (misplaced !== undefined) {
      const raw = structuredClone(mixed);
      const validate = (value: unknown) => validateAdjudication(f.context(), value);
      expect(validate(raw).events.find((event) => event.id === 'action:walk')!.beforeEventId).toBe(
        `check:${done.rolls[0].id}`,
      );
      expect(raw).toEqual(mixed); // Repair does not mutate the rejected proposal.
      const bad = structuredClone(raw);
      (bad.actions[0].components.movement as any).beforeEventId = 'check:another-actor';
      expect(() => validate(bad)).toThrow();

      // A missing search observation must not discard an independently valid arrival.
      const broken = structuredClone(raw);
      broken.actions[0].search!.informationEventId = 'missing-information';
      const requests: any[] = [];
      const fetcher = vi.fn(async (_url, init) => {
        requests.push(JSON.parse(init!.body as string));
        const output = requests.length === 1 ? broken : { malformed: true };
        return new Response(
          `data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] } })}\n\n`,
        );
      }) as unknown as typeof fetch;
      const auth = { accessToken: async () => 'test' } as unknown as ChatGPTAuth;
      const replay = { ...f.context(), requestBudget: { used: 0, limit: 8 } };
      const recovered = await new ChatGPTGM(auth, 'owner', 'model', fetcher).adjudicate(
        replay,
        Object.assign(vi.fn(), { validateAdjudication: validate }) as unknown as GameTools,
      );
      expect(recovered.memberLocations).toEqual(raw.memberLocations);
      expect(recovered.actions[0].components.movement?.status).toBe('success');
      expect(recovered.actions[0].components.main?.status).toBe(status);
      expect(recovered.rewards.xp).toBe(0);
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  },
);

it.each(['missing information', 'wrong dependency', 'remote search', 'story tool'])(
  'rejects %s in search evidence',
  async (defect) => {
    const f = await table({ checkDie: 2 });
    await f.submit();
    const value = f.value();
    const search = value.actions[0].search!;
    const information = value.events.find((event) => event.id === search.informationEventId)!;
    if (defect === 'missing information') search.informationEventId = 'missing';
    if (defect === 'wrong dependency') information.dependsOn[0].requires = 'success';
    if (defect === 'remote search') search.locationId = randomUUID();
    if (defect === 'story tool') search.reward = { ...potion, kind: 'tool' };
    expect(() => validateAdjudication(f.context(), value)).toThrow();
  },
);

it.each([true, false])(
  'deduplicates a shared source but supports independent search rewards (shared=%s)',
  async (shared) => {
    const f = await table({ sources: shared ? ['cache', 'cache'] : ['cache-a', 'cache-b'] });
    await f.submit(true);
    const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.history.at(-1)!.phase).toBe('complete');
    expect(snapshot.scene.loot.reduce((sum, item) => sum + item.quantity, 0)).toBe(shared ? 1 : 2);
    expect(f.draw.mock.calls.filter(([sides]) => sides === 100)).toHaveLength(shared ? 2 : 4);
  },
);

it('resumes saved search rewards after a narration interruption without rerolling or duplicating items', async () => {
  const f = await table();
  const narrate = f.provider.narrate!;
  f.provider.narrate = async () => {
    throw new Error('Controlled interruption');
  };
  const id = await f.submit();
  const saved = JSON.parse(
    (f.db.prepare('SELECT draft FROM turns WHERE id=?').get(id) as { draft: string }).draft,
  );
  expect(saved.resolution).toBeDefined();
  const draws = f.draw.mock.calls.length;
  f.db.close();
  const db = openDatabase(f.filename);
  cleanup.push(() => db.close());
  f.provider.narrate = narrate;
  const resumed = new Game(db, () => f.provider, f.draw);
  resumed.retry(f.campaign.id, f.host.id);
  await resumed.idle();
  const snapshot = resumed.snapshot(f.campaign.id, f.host.id);
  expect(snapshot.history.at(-1)!.id).toBe(id);
  expect(snapshot.history.at(-1)!.resolution).toEqual(saved.resolution);
  expect(snapshot.scene.loot).toEqual(saved.scene.loot);
  expect(f.draw).toHaveBeenCalledTimes(draws);
});

it('keeps search sources and loot local when characters search separate places outside shared focus', async () => {
  const f = await table({ sources: ['cache', 'cache'] });
  const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
  const other = randomUUID();
  snapshot.scene.places![other] = {
    location: { id: other, name: 'Remote alcove', atmosphere: 'Wet stone.', hazard: '' },
    encounter: null,
    loot: [],
  };
  snapshot.scene.worldMap!.nodes[other] = { id: other, name: 'Remote alcove', visited: true };
  snapshot.scene.memberLocations![snapshot.members[1].id] = other;
  f.db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(snapshot.scene), f.campaign.id);
  await f.submit(true);
  const result = f.game.snapshot(f.campaign.id, f.host.id);
  expect(result.history.at(-1)!.phase).toBe('complete');
  for (const member of result.members) {
    const place = memberScene(result.scene, member.id);
    expect(place.searches!['cache'].rewardRolled).toBe(true);
    expect(place.loot).toHaveLength(1);
  }
  expect(placeScene(result.scene, other).loot[0].id).not.toBe(result.scene.loot[0].id);
});

it('finds the next hop toward a distant goal while respecting directions, obstacles and route restrictions', () => {
  const scene = initialScene('Ribbenmeer');
  ensureLocations(scene);
  const [lake, bunker, ledge, detour] = [scene.location.id!, randomUUID(), randomUUID(), randomUUID()];
  scene.worldMap = {
    nodes: Object.fromEntries(
      [
        [lake, 'Ribbenmeer'],
        [bunker, 'Bunker 67'],
        [ledge, 'Rotsrichel'],
        [detour, 'Detour'],
      ].map(([id, name]) => [id, { id, name, visited: true }]),
    ),
    connections: [
      { from: lake, to: bunker, label: 'Rib path', blocked: false, bidirectional: true },
      { from: bunker, to: ledge, label: 'Ledge path', blocked: false, bidirectional: false },
      { from: lake, to: detour, label: 'Detour', blocked: false, bidirectional: true },
      { from: detour, to: ledge, label: 'Climb', blocked: false, bidirectional: true },
    ],
  };
  expect(travelNextHop(scene, lake, ledge)).toBe(bunker);
  expect(travelNextHop(scene, lake, ledge, [], [bunker])).toBe(detour);
  expect(travelNextHop(scene, lake, ledge, [detour])).toBe(detour);
  expect(travelNextHop(scene, bunker, lake)).toBe(lake);
  scene.worldMap.connections[2].blocked = true;
  expect(travelNextHop(scene, ledge, lake)).toBeNull();
  scene.worldMap.connections[0].blocked = true;
  expect(travelNextHop(scene, lake, ledge)).toBeNull();
  expect(travelNextHop(scene, lake, randomUUID())).toBeNull();
});

it('preserves bonus dice across an interruption before the resolution is frozen', async () => {
  const f = await table();
  const parse = turnResolutionSchema.parse.bind(turnResolutionSchema);
  const spy = vi.spyOn(turnResolutionSchema, 'parse').mockImplementationOnce(() => {
    throw new Error('Controlled finalization interruption');
  });
  cleanup.push(() => spy.mockRestore());
  const id = await f.submit();
  const interrupted = JSON.parse(
    (f.db.prepare('SELECT draft FROM turns WHERE id=?').get(id) as { draft: string }).draft,
  );
  expect(interrupted.adjudication).toBeDefined();
  expect(interrupted.resolution).toBeUndefined();
  const rolls = f.db.prepare('SELECT check_key,result FROM rolls WHERE turn_id=? ORDER BY check_key').all(id);
  expect(rolls).toHaveLength(3);
  const draws = f.draw.mock.calls.length;
  spy.mockImplementation(parse);
  f.game.retry(f.campaign.id, f.host.id);
  await f.game.idle();
  const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
  expect(snapshot.history.at(-1)!.id, snapshot.turn?.error ?? '').toBe(id);
  expect(snapshot.scene.loot).toHaveLength(1);
  expect(f.draw).toHaveBeenCalledTimes(draws);
  expect(
    f.db.prepare('SELECT check_key,result FROM rolls WHERE turn_id=? ORDER BY check_key').all(id),
  ).toEqual(rolls);
});

it('does not replenish an existing story-tool source after a previously failed search', async () => {
  const f = await table();
  const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
  snapshot.scene.searches = {
    'field-pack': { information: 'The pack lies beside a stream.', rewardRolled: false },
  };
  snapshot.scene.searchedLoot = { 'field-pack': 'Saved letter' };
  f.db.prepare('UPDATE campaigns SET scene=? WHERE id=?').run(JSON.stringify(snapshot.scene), f.campaign.id);
  await f.submit();
  expect(f.game.snapshot(f.campaign.id, f.host.id).scene.searches!['field-pack'].rewardRolled).toBe(true);
  expect(f.game.snapshot(f.campaign.id, f.host.id).scene.loot).toHaveLength(0);
});

it('awards a usable potion if generated equipment exceeds the discoverer’s requirements', async () => {
  const f = await table({
    chance: 1,
    reward: { ...potion, name: 'Heavy field blade', kind: 'weapon', scaling: ['STR'] },
  });
  const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
  const actor = f.game.members(f.campaign.id)[0];
  actor.state.stats.STR = 1;
  f.db.prepare('UPDATE members SET state=? WHERE id=?').run(JSON.stringify(actor.state), actor.id);
  await f.submit();
  const result = f.game.snapshot(f.campaign.id, f.host.id);
  expect(result.history.at(-1)!.phase, result.turn?.error ?? '').toBe('complete');
  expect(result.scene.loot[0]).toMatchObject({ kind: 'consumable', healing: 10 });
  expect(result.scene.loot[0].name).toBe('Healing potion');
  expect(snapshot.scene.loot).toHaveLength(0);
});

it('keeps a fresh story-tool discovery alongside its independent bonus-loot opportunity', async () => {
  const f = await table({ storyTool: true });
  await f.submit();
  const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
  expect(snapshot.history.at(-1)!.phase, snapshot.turn?.error ?? '').toBe('complete');
  expect(snapshot.scene.loot.map((item) => item.kind).sort()).toEqual(['consumable', 'tool']);
  expect(snapshot.scene.searchedLoot!['field-pack']).toBe('Field letter');
  expect(snapshot.scene.searches!['field-pack'].rewardRolled).toBe(true);
  const draws = f.draw.mock.calls.length;
  await f.submit();
  expect(f.game.snapshot(f.campaign.id, f.host.id).scene.loot).toEqual(snapshot.scene.loot);
  expect(f.draw).toHaveBeenCalledTimes(draws);
});

it('can award equipment the discoverer can actually equip', async () => {
  const f = await table({ reward: { ...potion, name: 'Field boots', kind: 'boots', scaling: ['DEX'] } });
  await f.submit();
  const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
  expect(snapshot.history.at(-1)!.phase, snapshot.turn?.error ?? '').toBe('complete');
  expect(snapshot.scene.loot[0]).toMatchObject({ name: 'Field boots', kind: 'boots', defense: 1 });
});

it('shares the same bonus opportunity across normalized spellings of a local source', async () => {
  const f = await table({ sources: ['ＦＩＥＬＤ-ＰＡＣＫ', 'field-pack'] });
  await f.submit(true);
  const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
  expect(snapshot.history.at(-1)!.phase, snapshot.turn?.error ?? '').toBe('complete');
  expect(Object.keys(snapshot.scene.searches!)).toEqual(['field-pack']);
  expect(snapshot.scene.loot).toHaveLength(1);
});

it('uses a server potion candidate when an otherwise valid successful search omits its optional reward blueprint', async () => {
  const f = await table();
  const adjudicate = f.provider.adjudicate!;
  f.provider.adjudicate = async (context, tools) => {
    const value = await adjudicate(context, tools);
    for (const action of value.actions) if (action.search) action.search.reward = null;
    return value;
  };
  await f.submit();
  const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
  expect(snapshot.history.at(-1)!.phase, snapshot.turn?.error ?? '').toBe('complete');
  expect(snapshot.history.at(-1)!.resolution!.actions[0].status).toBe('success');
  expect(snapshot.scene.loot[0]).toMatchObject({ name: 'Healing potion', kind: 'consumable' });
});
