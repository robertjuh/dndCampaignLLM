import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openDatabase } from '../server/db';
import { Game, type GameMaster, type GMContext, type GameTools } from '../server/game';
import { ChatGPTGM, PracticeGM } from '../server/providers';
import { engineEvents } from '../server/turn-resolution';
import { baseItem } from '../shared/rules';
import type { ChatGPTAuth } from '../server/auth';
import { templateCharacter, type CampaignConfig, type Check } from '../shared/schema';
import {
  assembleResolvedNarration,
  narrationParagraphs,
  factualNarration,
  type TurnNarration,
  type TurnResolution,
} from '../shared/turn-resolution';

const config: CampaignConfig = {
  ruleset: 'roguelike-v1',
  name: 'Cooperation',
  setting: 'A floating community',
  premise: '',
  tone: 'Adventurous',
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

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'playtest-followup-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'game.sqlite');
  const db = openDatabase(filename);
  cleanup.push(() => {
    if (db.open) db.close();
  });
  const practice = new PracticeGM();
  const provider: GameMaster = {
    adjudicate: practice.adjudicate.bind(practice),
    narrate: practice.narrate.bind(practice),
  };
  const draw = vi.fn((sides: number) => Math.min(12, sides));
  const game = new Game(db, () => provider, draw);
  const host = game.identify();
  const players = [game.identify(), game.identify()];
  const campaign = game.create(host.id, config);
  for (const [index, player] of players.entries()) {
    const character = game.saveCharacter(player.id, templateCharacter(index ? 'Loader' : 'Helper'));
    game.join(campaign.inviteCode!, player.id, character.id);
    const member = game.members(campaign.id).find((member) => member.playerId === player.id)!;
    game.manageCharacter(campaign.id, player.id, {
      type: 'starter',
      itemIds: member.state.starterEquipment.slice(0, 2).map((item) => item.id),
    });
    // Isolate assistance from randomly chosen starting gear.
    const current = game.members(campaign.id).find((member) => member.playerId === player.id)!;
    current.state.equipment = { left: null, right: null, body: null, head: null, boots: null, relic: null };
    current.state.stats.STR = 5;
    db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(current.state), current.id);
  }
  game.start(campaign.id, host.id);
  await game.idle();
  const [helper, loader] = game.members(campaign.id);
  const submit = (texts = ['Hold the mounting steady for Loader.', 'Load the mounted weapon.']) => {
    const turn = game.snapshot(campaign.id, host.id).turn!;
    game.submit(campaign.id, players[0].id, turn.id, texts[0], false);
    game.submit(campaign.id, players[1].id, turn.id, texts[1], false);
    return turn.id;
  };
  const draft = (id: string) =>
    JSON.parse((db.prepare('SELECT draft FROM turns WHERE id = ?').get(id) as { draft: string }).draft);
  const adjudicateSaved = (context: GMContext, tools: GameTools) =>
    practice.adjudicate(
      context,
      Object.assign(
        (input: Check) => context.turn.rolls.find((roll) => roll.memberId === input.memberId) ?? tools(input),
        tools,
      ),
    );
  return {
    filename,
    db,
    game,
    host,
    players,
    campaign,
    helper,
    loader,
    provider,
    practice,
    draw,
    submit,
    draft,
    adjudicateSaved,
  };
}

const check = (memberId: string, extra: Partial<Check> = {}): Check => ({
  memberId,
  stat: 'STR',
  dc: 10,
  mode: 'normal',
  lethal: false,
  reason: 'Control the heavy mounting on the moving deck.',
  ...extra,
});

it.each([
  { language: 'English', stat: 'INT', equipped: true, bonus: 1 },
  { language: 'Nederlands', stat: 'INT', equipped: true, bonus: 1 },
  { language: 'English', stat: 'STR', equipped: true, bonus: 0 },
  { language: 'English', stat: 'INT', equipped: false, bonus: 0 },
] as const)(
  'freezes passive relic evidence for $language $stat checks (equipped: $equipped)',
  async ({ language, stat, equipped, bonus }) => {
    const f = await fixture();
    const member = f.game.members(f.campaign.id)[0];
    const relic = {
      ...baseItem('cylinder', 'Inspecteurscodecilinder', 'relic'),
      scaling: ['INT' as const, 'WIS' as const],
      checkBonus: 1,
      description: 'A sealed cylinder bearing regime authentication.',
    };
    member.state.stats.INT = 7;
    member.state.equipment.relic = equipped ? relic : null;
    if (!equipped) member.state.inventory.push({ ...relic, quantity: 1 });
    f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(member.state), member.id);
    const campaignConfig = { ...config, language };
    f.db
      .prepare('UPDATE campaigns SET config = ? WHERE id = ?')
      .run(JSON.stringify(campaignConfig), f.campaign.id);
    f.provider.adjudicate = async (context, tools) => {
      tools(check(member.id, { stat }));
      return f.adjudicateSaved(context, tools);
    };
    const narrate = f.provider.narrate!;
    f.provider.narrate = async (resolution, config, budget) => {
      if (resolution.turnId === turnId) throw new Error('Interrupted narration');
      return narrate(resolution, config, budget);
    };
    const turn = f.game.snapshot(f.campaign.id, f.host.id).turn!;
    const turnId = turn.id;
    f.game.submit(
      f.campaign.id,
      f.players[0].id,
      turn.id,
      'Alter the archive through the damaged relay.',
      false,
    );
    f.game.submit(f.campaign.id, f.players[1].id, turn.id, '', true);
    await f.game.idle();
    const saved = f.draft(turnId).resolution as TurnResolution;
    const roll = f.game.snapshot(f.campaign.id, f.host.id).turn!.rolls[0];
    expect(roll.modifier).toBe((stat === 'INT' ? 1 : 0) + bonus);
    expect(roll.equipmentBonuses).toEqual(bonus ? [{ itemId: relic.id, name: relic.name, bonus }] : []);
    const fact = saved.events.find((event) => event.id === `check:${roll.id}`)!.fact;
    if (bonus) {
      expect(fact).toContain(relic.name);
      expect(fact).toContain(language === 'Nederlands' ? 'passief +1' : 'passively contributes +1');
    } else expect(fact).not.toContain(relic.name);
    expect(fact).not.toContain('authentication');
    const draws = f.draw.mock.calls.length;
    f.provider.narrate = narrate;
    f.game.retry(f.campaign.id, f.host.id);
    await f.game.idle();
    const restored = new Game(f.db, () => f.provider).snapshot(f.campaign.id, f.host.id).history.at(-1)!;
    expect(restored.id).toBe(turnId);
    expect(restored.resolution).toEqual(saved);
    expect(restored.rolls[0]).toEqual(roll);
    expect(f.draw).toHaveBeenCalledTimes(draws);
  },
);

function resolution(): Extract<TurnResolution, { version: 2 }> {
  return {
    version: 2,
    turnId: 'turn',
    actions: [],
    characters: [],
    rewards: [],
    changes: [],
    journal: [],
    location: null,
    safeRest: false,
    factualRecap: 'The loading failed.',
    events: [
      {
        id: 'check',
        sequence: 0,
        kind: 'mechanics',
        memberId: null,
        actionId: null,
        phase: 'main',
        result: 'failure',
        fact: 'The loading check failed.',
        receiptRefs: [],
        dependsOn: [],
      },
      {
        id: 'outcome',
        sequence: 1,
        kind: 'action',
        memberId: null,
        actionId: null,
        phase: 'main',
        result: 'failure',
        fact: 'The charge could not be seated.',
        receiptRefs: [],
        dependsOn: [{ eventId: 'check', requires: 'occurrence' }],
      },
      {
        id: 'world',
        sequence: 2,
        kind: 'world',
        memberId: null,
        actionId: null,
        phase: 'aftermath',
        result: null,
        fact: 'The weapon remains unloaded.',
        receiptRefs: [],
        dependsOn: [{ eventId: 'outcome', requires: 'occurrence' }],
      },
    ],
  };
}

const grouped = (r: TurnResolution): TurnNarration => ({
  version: 2,
  turnId: r.turnId,
  passages: [
    {
      eventIds: r.events.map((event) => event.id),
      text: 'The charge slips out before it seats; the weapon remains unloaded.',
    },
  ],
  closing: '',
  summary: 'The weapon is still unloaded.',
});

it('covers a check, concrete outcome and world restatement in one published paragraph', () => {
  const r = resolution();
  const narration = assembleResolvedNarration(r, grouped(r));
  expect(narrationParagraphs(r, narration)).toEqual([
    'The charge slips out before it seats; the weapon remains unloaded.',
  ]);
  const legacy = {
    version: 1,
    turnId: r.turnId,
    eventNarrations: Object.fromEntries(r.events.map((event) => [event.id, event.fact])),
    closing: '',
    summary: 'Unloaded.',
  };
  expect(narrationParagraphs(r, assembleResolvedNarration(r, legacy))).toHaveLength(3);
});

it.each(['missing', 'duplicate', 'unknown', 'causality', 'mutation'])(
  'rejects grouped narration with %s errors',
  (error) => {
    const r = resolution();
    const input = grouped(r) as Extract<TurnNarration, { version: 2 }>;
    if (error === 'missing') input.passages[0].eventIds.pop();
    if (error === 'duplicate') input.passages[0].eventIds[1] = 'check';
    if (error === 'unknown') input.passages[0].eventIds[2] = 'invented';
    if (error === 'causality') input.passages[0].eventIds.reverse();
    expect(() => assembleResolvedNarration(r, error === 'mutation' ? { ...input, xp: 10 } : input)).toThrow();
  },
);

it('keeps combat order when passages combine events', () => {
  const r = resolution();
  for (const event of r.events) {
    event.kind = 'combat';
    event.dependsOn = [];
  }
  const input = grouped(r) as Extract<TurnNarration, { version: 2 }>;
  input.passages[0].eventIds = ['check', 'world', 'outcome'];
  expect(() => assembleResolvedNarration(r, input)).toThrow('initiative');
});

it('gives successful checked assistance advantage and preserves its causal receipt across restart', async () => {
  const f = await fixture();
  let assisted: ReturnType<GameTools>;
  f.draw.mockReturnValueOnce(19).mockReturnValueOnce(7).mockReturnValueOnce(12);
  f.provider.adjudicate = vi.fn(async (context: GMContext, tools: GameTools) => {
    tools(check(f.helper.id, { assistsMemberId: f.loader.id }));
    assisted = tools(check(f.loader.id, { assistedBy: [f.helper.id] }));
    return f.adjudicateSaved(context, tools);
  });
  const narrate = vi.fn(async (r: TurnResolution): Promise<TurnNarration> => ({
    version: 2,
    turnId: r.turnId,
    passages: r.events.map((event) => ({ eventIds: [event.id], text: event.fact })),
    closing: '',
    summary: 'The supporting action is resolved before loading.',
  }));
  f.provider.narrate = narrate;
  const publish = vi.spyOn(f.game as unknown as { publish: () => void }, 'publish').mockImplementation(() => {
    throw new Error('Controlled interruption before publication');
  });
  const id = f.submit();
  await f.game.idle();
  const saved = f.draft(id);
  expect(saved.resolution, f.game.snapshot(f.campaign.id, f.host.id).turn!.error ?? '').toBeDefined();
  expect(assisted!).toMatchObject({ dice: [7, 12], total: 12, success: true, mode: 'advantage' });
  const [helperCheck, loadingCheck] = saved.resolution.events;
  expect(loadingCheck.dependsOn).toEqual([{ eventId: helperCheck.id, requires: 'success' }]);
  expect(loadingCheck.fact).toContain("Helper's successful assistance");
  expect(saved.narration.version).toBe(2);
  const draws = f.draw.mock.calls.length;
  publish.mockRestore();
  f.db.close();
  const reopened = openDatabase(f.filename);
  cleanup.push(() => reopened.close());
  const resumed = new Game(reopened, () => f.provider, f.draw);
  resumed.retry(f.campaign.id, f.host.id);
  await resumed.idle();
  const done = resumed.snapshot(f.campaign.id, f.host.id).history.at(-1)!;
  expect(done.id).toBe(id);
  expect(done.rolls.map((roll) => roll.memberId)).toEqual([f.helper.id, f.loader.id]);
  expect(done.rolls[1]).toEqual(assisted!);
  expect(f.draw).toHaveBeenCalledTimes(draws);
  expect(narrate).toHaveBeenCalledTimes(1);
  expect(f.provider.adjudicate).toHaveBeenCalledTimes(1);
});

it('keeps a supported check failed when advantage is still insufficient', async () => {
  const f = await fixture();
  f.draw.mockReturnValueOnce(19).mockReturnValueOnce(7).mockReturnValueOnce(8);
  f.provider.adjudicate = async (context: GMContext, tools: GameTools) => {
    tools(check(f.helper.id, { assistsMemberId: f.loader.id }));
    const result = tools(check(f.loader.id, { dc: 20, assistedBy: [f.helper.id] }));
    expect(result).toMatchObject({ mode: 'advantage', dice: [7, 8], success: false });
    return f.adjudicateSaved(context, tools);
  };
  f.submit();
  await f.game.idle();
  const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
  expect(snapshot.history.at(-1)!.number, snapshot.turn!.error ?? '').toBe(1);
  const done = snapshot.history.at(-1)!;
  expect(done.resolution!.actions.find((action) => action.memberId === f.loader.id)!.status).toBe('failure');
  expect(done.resolution!.events[1].dependsOn).toEqual([
    { eventId: done.resolution!.events[0].id, requires: 'success' },
  ]);
});

it.each(['failed', 'unrelated', 'late', 'self', 'duplicate'])(
  'rejects %s assistance without rolling or changing saved dice',
  async (kind) => {
    const f = await fixture();
    f.draw.mockReturnValue(kind === 'failed' ? 2 : 12);
    f.provider.adjudicate = async (context: GMContext, tools: GameTools) => {
      if (kind === 'late') {
        tools(check(f.loader.id));
        const draws = f.draw.mock.calls.length;
        expect(() => tools(check(f.helper.id, { assistsMemberId: f.loader.id }))).toThrow('already locked');
        expect(f.draw).toHaveBeenCalledTimes(draws);
      } else {
        tools(check(f.helper.id, { assistsMemberId: kind === 'unrelated' ? null : f.loader.id }));
        const draws = f.draw.mock.calls.length;
        const assistedBy =
          kind === 'self' ? [f.loader.id] : kind === 'duplicate' ? [f.helper.id, f.helper.id] : [f.helper.id];
        expect(() => tools(check(f.loader.id, { assistedBy }))).toThrow(/Assistance|Assisting/);
        expect(f.draw).toHaveBeenCalledTimes(draws);
        tools(check(f.loader.id));
      }
      return f.adjudicateSaved(context, tools);
    };
    f.submit();
    await f.game.idle();
    const done = f.game.snapshot(f.campaign.id, f.host.id).history.at(-1)!;
    expect(done.number, f.game.snapshot(f.campaign.id, f.host.id).turn!.error ?? '').toBe(1);
    expect(done.rolls.find((roll) => roll.memberId === f.loader.id)!.mode).toBe('normal');
  },
);

it.each(['normal', 'disadvantage'] as const)(
  'applies assistance to %s once when combined with a utility ability',
  async (mode) => {
    const f = await fixture();
    f.provider.adjudicate = async (context: GMContext, tools: GameTools) => {
      tools(check(f.helper.id, { assistsMemberId: f.loader.id }));
      const ability = f.loader.character.abilities.find((ability) => ability.kind === 'utility')!;
      const result = tools(
        check(f.loader.id, {
          stat: ability.stat,
          abilityName: ability.name,
          mode,
          assistedBy: [f.helper.id],
        }),
      );
      expect(result.mode).toBe(mode === 'disadvantage' ? 'normal' : 'advantage');
      expect(result.dice).toHaveLength(mode === 'disadvantage' ? 1 : 2);
      return f.adjudicateSaved(context, tools);
    };
    const turn = f.game.snapshot(f.campaign.id, f.host.id).turn!;
    const ability = f.loader.character.abilities.find((ability) => ability.kind === 'utility')!;
    f.game.submit(
      f.campaign.id,
      f.players[0].id,
      turn.id,
      'Support Loader in inspecting the mechanism.',
      false,
    );
    f.game.submit(
      f.campaign.id,
      f.players[1].id,
      turn.id,
      `Use ${ability.name} to inspect the mechanism.`,
      false,
      false,
      ability.name,
    );
    await f.game.idle();
    const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
    expect(snapshot.history.at(-1)!.number, snapshot.turn!.error ?? '').toBe(1);
    expect(snapshot.history.at(-1)!.rolls.find((roll) => roll.memberId === f.loader.id)!.abilityName).toBe(
      ability.name,
    );
  },
);

function completed(value: unknown) {
  return new Response(
    `data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
      },
    })}\n\n`,
  );
}
const auth = { accessToken: async () => 'test-token' } as unknown as ChatGPTAuth;

it('keeps recovery in the saved log while both narrator and reviewer receive the same story contract', async () => {
  const r = resolution();
  r.events.push({
    ...r.events[2],
    id: 'recovery',
    sequence: 3,
    kind: 'mechanics',
    fact: 'Helper recovers 2 HP and restores one ability charge.',
    presentation: 'log',
  });
  r.executionContext = [
    {
      actorId: 'helper',
      name: 'Helper',
      description: 'A traveller',
      equipment: [{ name: 'Knife', kind: 'weapon', description: 'A short steel knife.' }],
    },
  ];
  r.events[0].fact += ' The equipped Archive relic passively contributes +1 to this INT check.';
  r.location = { name: 'Deck', atmosphere: 'A quiet deck.', hazard: '' };
  r.factualRecap = 'Location: {raw JSON}. Safe rest: false. Helper restores one ability charge.';
  const fallback = factualNarration(r, 'English');
  expect(narrationParagraphs(r, fallback).join(' ')).not.toContain('ability charge');
  expect(fallback.summary).not.toMatch(/raw JSON|Location:|Safe rest: false/);
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    const input = JSON.parse(body.input[0].content);
    expect(input.resolution.events.map((event: any) => event.id)).toEqual(['check', 'outcome', 'world']);
    expect(input.resolution.executionContext[0].equipment[0].description).toBe('A short steel knife.');
    expect(input.resolution.events[0].fact).toContain('Archive relic passively contributes +1');
    expect(body.instructions).toContain('never require or narrate XP');
    expect(body.instructions).toContain('ability charges spent/restored');
    expect(body.instructions).toContain('Recorded passive equipment bonuses apply automatically');
    expect(body.instructions).toContain('A passive check bonus does not establish active item use');
    return completed(
      input.candidate
        ? { approved: true, feedback: '' }
        : grouped({ ...r, events: r.events.filter((event) => event.presentation !== 'log') }),
    );
  }) as unknown as typeof fetch;
  const narration = await new ChatGPTGM(auth, 'owner', 'model', fetcher).narrate(r, config);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(narrationParagraphs(r, narration)).toHaveLength(1);
  expect(r.events.at(-1)!.fact).toContain('charge');
  expect(() => assembleResolvedNarration(r, grouped(r))).toThrow('event IDs');
});

it('retains a recovered downed ally as a story outcome while charge bookkeeping stays in the log', async () => {
  const f = await fixture();
  const context: GMContext = {
    config,
    members: f.game.members(f.campaign.id),
    history: [],
    journal: [],
    scene: f.game.snapshot(f.campaign.id, f.host.id).scene,
    turn: f.game.snapshot(f.campaign.id, f.host.id).turn!,
    receipts: {
      challenge: { recovery: ['Loader regains one charge.'], revived: ['Loader'], logRecovery: true },
    },
  };
  const events = engineEvents(context);
  expect(events[0]).toMatchObject({ presentation: 'log' });
  expect(events[1].presentation).toBeUndefined();
  const r = { ...resolution(), events };
  expect(narrationParagraphs(r, factualNarration(r, 'English'))).toEqual([
    'Loader regains consciousness after the encounter.',
  ]);
});

it('resumes an older finalized challenge without changing its saved presentation contract', async () => {
  const f = await fixture();
  f.helper.state.hp -= 3;
  f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(f.helper.state), f.helper.id);
  const narrate = f.provider.narrate!;
  f.provider.narrate = async () => {
    throw new Error('Controlled narration interruption');
  };
  const id = f.submit();
  await f.game.idle();
  const draft = f.draft(id);
  expect(draft.resolution).toBeDefined();
  expect(draft.receipts.challenge).toBeDefined();
  expect(draft.receipts.challenge.recovery.length).toBeGreaterThan(0);
  delete draft.receipts.challenge.logRecovery;
  for (const events of [draft.receipts.executionEvents, draft.adjudication.events, draft.resolution.events])
    for (const event of events)
      if (event.id.startsWith('recovery:')) {
        delete event.presentation;
        event.phase = null;
      }
  f.db.prepare('UPDATE turns SET draft = ? WHERE id = ?').run(JSON.stringify(draft), id);
  f.provider.narrate = narrate;
  f.game.retry(f.campaign.id, f.host.id);
  await f.game.idle();
  expect(f.game.snapshot(f.campaign.id, f.host.id).history.at(-1)!.id).toBe(id);
  expect(f.draft(id).resolution).toEqual(draft.resolution);
});

const searchItem = {
  name: 'Service key',
  kind: 'tool' as const,
  scaling: [],
  hands: 1 as const,
  light: false,
  description: 'A brass key for the maintenance hatch beside the mounting.',
};

it('persists a searched story item across retry, supports explicit backpack pickup and exhausts its source', async () => {
  const f = await fixture();
  let exhausted: unknown;
  f.provider.adjudicate = async (context, tools) => {
    tools(check(f.helper.id));
    exhausted = tools.offerLoot({
      item: searchItem,
      memberId: f.helper.id,
      sourceId: 'floating-deck:service-desk',
      reason: 'The submitted search finds the service key.',
    });
    return f.adjudicateSaved(context, tools);
  };
  const publish = vi.spyOn(f.game as unknown as { publish: () => void }, 'publish').mockImplementation(() => {
    throw new Error('Controlled search publication interruption');
  });
  const id = f.submit(['Search the service desk.', 'Watch the deck.']);
  await f.game.idle();
  const saved = f.draft(id);
  expect(saved.scene.loot).toHaveLength(1);
  expect(saved.scene.loot[0]).toMatchObject({
    name: 'Service key',
    kind: 'tool',
    rarity: 'Common',
    scaling: [],
    attackBonus: 0,
    checkBonus: 0,
  });
  const draws = f.draw.mock.calls.length;
  publish.mockRestore();
  f.game.retry(f.campaign.id, f.host.id);
  await f.game.idle();
  expect(f.draw).toHaveBeenCalledTimes(draws);
  expect(f.game.snapshot(f.campaign.id, f.host.id).scene.loot).toHaveLength(1);
  f.game.manageCharacter(f.campaign.id, f.players[0].id, { type: 'take', itemId: saved.scene.loot[0].id });
  expect(f.game.members(f.campaign.id)[0].state.inventory).toContainEqual(saved.scene.loot[0]);
  f.submit(['Search the service desk again.', 'Watch the deck.']);
  await f.game.idle();
  expect(exhausted).toEqual({
    exhausted: true,
    sourceId: 'floating-deck:service-desk',
    itemName: 'Service key',
  });
  expect(f.game.snapshot(f.campaign.id, f.host.id).scene.loot).toHaveLength(0);
  expect(
    f.game.members(f.campaign.id)[0].state.inventory.filter((item) => item.name === 'Service key'),
  ).toHaveLength(1);
});

it('does not create the requested search item after a failed check or allow a discovery before its check', async () => {
  const f = await fixture();
  f.draw.mockReturnValue(2);
  f.provider.adjudicate = async (context, tools) => {
    const rolled = tools(check(f.helper.id));
    expect(rolled.success).toBe(false);
    expect(() =>
      tools.offerLoot({
        item: searchItem,
        memberId: f.helper.id,
        sourceId: 'floating-deck:service-desk',
        reason: 'Search the locked drawer.',
      }),
    ).toThrow('failed search');
    return f.adjudicateSaved(context, tools);
  };
  f.submit(['Search the locked service desk.', 'Watch the deck.']);
  await f.game.idle();
  expect(f.game.snapshot(f.campaign.id, f.host.id).scene.loot).toHaveLength(0);
  f.provider.adjudicate = async (context, tools) => {
    tools.offerLoot({
      item: searchItem,
      memberId: f.helper.id,
      sourceId: 'floating-deck:open-desk',
      reason: 'The key is plainly visible on the desk.',
    });
    expect(() => tools(check(f.helper.id))).toThrow('before offering');
    const events = engineEvents(context);
    const actions = context.turn.actions.map((action) => {
      const id = `${context.turn.id}:action:${action.memberId}`;
      const event = {
        id: `routine:${action.memberId}`,
        sequence: events.length,
        kind: 'action' as const,
        memberId: action.memberId,
        actionId: id,
        phase: 'main' as const,
        result: 'success' as const,
        fact: 'The visible desk is examined.',
        receiptRefs: [],
        dependsOn: [],
      };
      events.push(event);
      const main = {
        status: 'success' as const,
        basis: 'routine' as const,
        fact: event.fact,
        reason: 'The desk is openly accessible.',
        receiptRefs: [],
        eventIds: [event.id],
      };
      return { actionId: id, memberId: action.memberId, ...main, components: { main, minor: null } };
    });
    return {
      version: 2,
      turnId: context.turn.id,
      events,
      actions,
      changes: [],
      journal: [],
      location: null,
      safeRest: false,
      rewards: { xp: 0, gold: 0, reason: 'Routine discovery.' },
    };
  };
  f.submit(['Pick up the visible key.', 'Watch the deck.']);
  await f.game.idle();
  expect(f.game.snapshot(f.campaign.id, f.host.id).scene.loot).toHaveLength(1);
});

it('reviews grouped narration for repetition as well as fidelity within the existing request budget', async () => {
  const r = resolution();
  const requests: any[] = [];
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    requests.push(body);
    const input = JSON.parse(body.input[0].content);
    if (input.candidate) {
      expect(body.instructions).toContain('Reject a check announcement followed by a second telling');
      return completed({ approved: true, feedback: '' });
    }
    expect(input.schemaExample.version).toBe(2);
    expect(body.instructions).toContain('ONE passage');
    return completed(grouped(r));
  }) as unknown as typeof fetch;
  const result = await new ChatGPTGM(auth, 'owner', 'model', fetcher).narrate(r, config);
  expect(narrationParagraphs(r, result)).toHaveLength(1);
  expect(requests).toHaveLength(2);
  expect(requests.every((body) => !body.tools)).toBe(true);
});

it('persists a new consequence of failure without changing the failed check or duplicating its reward on retry', async () => {
  const f = await fixture();
  f.draw.mockReturnValue(2);
  f.provider.adjudicate = async (context: GMContext, tools: GameTools) => {
    const rolled = tools(check(f.loader.id));
    const result = await f.adjudicateSaved(context, tools);
    const event = engineEvents(context).find((event) => event.id === `check:${rolled.id}`)!;
    result.events.push({
      id: 'world:alternate',
      sequence: result.events.length,
      kind: 'world',
      memberId: null,
      actionId: null,
      phase: 'aftermath',
      result: null,
      fact: 'The failed loading exposes an old maintenance hatch under the mounting.',
      receiptRefs: [],
      dependsOn: [{ eventId: event.id, requires: 'occurrence' }],
    });
    result.journal = [
      {
        kind: 'fact',
        name: 'Maintenance hatch',
        detail: 'An old maintenance hatch is exposed under the mounting.',
      },
    ];
    result.rewards = { xp: 10, gold: 0, reason: 'A useful new maintenance access was discovered.' };
    return result;
  };
  const publish = vi.spyOn(f.game as unknown as { publish: () => void }, 'publish').mockImplementation(() => {
    throw new Error('Controlled publication interruption');
  });
  const id = f.submit();
  await f.game.idle();
  publish.mockRestore();
  f.game.retry(f.campaign.id, f.host.id);
  await f.game.idle();
  const snapshot = f.game.snapshot(f.campaign.id, f.host.id);
  const done = snapshot.history.at(-1)!;
  expect(done.id).toBe(id);
  expect(done.resolution!.actions.find((action) => action.memberId === f.loader.id)!.status).toBe('failure');
  expect(snapshot.journal).toContainEqual({
    kind: 'fact',
    name: 'Maintenance hatch',
    detail: 'An old maintenance hatch is exposed under the mounting.',
  });
  expect(snapshot.members.map((member) => member.state.xp)).toEqual([10, 10]);
  expect(done.rolls.find((roll) => roll.memberId === f.loader.id)!.success).toBe(false);
});

it('prompts causal cooperation and consequences for repeated failure using the existing factual history', async () => {
  const f = await fixture();
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    expect(body.instructions).toContain('Resolve uncertain assistance FIRST');
    expect(body.instructions).toContain('A repeated failure should normally change the situation');
    expect(body.instructions).toContain('Keep the checked main action failed');
    const snapshot = JSON.parse(body.input[0].content);
    expect(snapshot.history).toEqual([
      { summary: 'The previous loading attempt failed.', source: 'resolution' },
    ]);
    const rollTool = body.tools[0].tools.find((tool: any) => tool.name === 'roll_check');
    expect(rollTool.parameters.required).toContain('assistsMemberId');
    expect(rollTool.parameters.required).toContain('assistedBy');
    return completed(await f.practice.adjudicate(context, tools));
  }) as unknown as typeof fetch;
  const context: GMContext = {
    config,
    members: f.game.members(f.campaign.id),
    history: [{ summary: 'The previous loading attempt failed.', source: 'resolution' }],
    journal: [],
    scene: f.game.snapshot(f.campaign.id, f.host.id).scene,
    turn: {
      id: randomUUID(),
      number: 0,
      roster: [],
      actions: [],
      rolls: [],
      phase: 'resolving',
      result: null,
      error: null,
    },
  };
  const tools = Object.assign(vi.fn(), {}) as unknown as GameTools;
  await new ChatGPTGM(auth, 'owner', 'model', fetcher).adjudicate(context, tools);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
