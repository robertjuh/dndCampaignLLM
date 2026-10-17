import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openDatabase } from '../server/db';
import { Game, type GameMaster, type GMContext } from '../server/game';
import { PracticeGM, adjudicationInput, ChatGPTGM } from '../server/providers';
import {
  factionExample,
  validateGeneratedWorld,
  validateConnections,
  validateFactionEffects,
  applyFactionEffects,
  publicMember,
} from '../server/factions';
import {
  factionWorldSchema,
  factionAttitude,
  clampReputation,
  type FactionWorld,
  type FactionEffect,
} from '../shared/factions';
import { templateCharacter, type CampaignConfig } from '../shared/schema';
import { factualNarration, type TurnAdjudication } from '../shared/turn-resolution';
import type { ChatGPTAuth } from '../server/auth';
import { createApp } from '../server/app';

const config: CampaignConfig = {
  ruleset: 'roguelike-v1',
  name: 'Factions',
  setting: 'A disputed harbor',
  premise: 'Control of the old gate is contested.',
  tone: 'Intrigue',
  instructions: '',
  language: 'English',
  custom: [],
  provider: 'practice',
  model: '',
};
const cleanup: (() => void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture(
  options: {
    generated?: boolean;
    path?: string;
    language?: 'English' | 'Nederlands';
    overrides?: Partial<GameMaster>;
  } = {},
) {
  const db = openDatabase(options.path ?? ':memory:');
  cleanup.push(() => {
    if (db.open) db.close();
  });
  const practice = new PracticeGM();
  const generateFactions = vi.fn(async (_context: GMContext, example: FactionWorld) => ({
    ...example,
    factions: example.factions.map((faction, index) => ({
      ...faction,
      name: ['Gate Wardens', 'Harbor League', 'Veiled Archive'][index],
      privateAgenda: `Secret agenda ${index}: claim the gate alone.`,
    })),
  }));
  const connectFactions = vi.fn(practice.connectFactions.bind(practice));
  let effects: (context: GMContext, value: TurnAdjudication) => void = () => {};
  const provider: GameMaster = {
    generateFactions,
    connectFactions,
    adjudicate: async (context, tools) => {
      const value = await practice.adjudicate(context, tools);
      effects(context, value);
      return value;
    },
    narrate: vi.fn(practice.narrate.bind(practice)),
    ...options.overrides,
  };
  const draw = vi.fn((sides: number) => (sides === 100 ? (options.generated ? 1 : 99) : Math.min(12, sides)));
  const game = new Game(db, () => provider, draw);
  const host = game.identify();
  const campaign = game.create(host.id, { ...config, language: options.language ?? 'English' });
  const players = [game.identify(), game.identify()];
  players.forEach((player, index) => {
    const character = game.saveCharacter(player.id, templateCharacter(['Mira', 'Rowan'][index]));
    game.join(campaign.inviteCode!, player.id, character.id);
    const member = game.members(campaign.id).find((member) => member.playerId === player.id)!;
    game.manageCharacter(campaign.id, player.id, {
      type: 'starter',
      itemIds: member.state.starterEquipment.slice(0, 2).map((item) => item.id),
    });
  });
  return {
    db,
    game,
    host,
    campaign,
    players,
    provider,
    draw,
    generateFactions,
    connectFactions,
    setEffects: (next: typeof effects) => {
      effects = next;
    },
    snapshot: () => game.snapshot(campaign.id, host.id),
    world: () => JSON.parse(game.campaign(campaign.id).factions!) as FactionWorld,
    start: async () => {
      game.start(campaign.id, host.id);
      await game.idle();
    },
    next: async () => {
      const turn = game.snapshot(campaign.id, host.id).turn!;
      players.forEach((player) => game.submit(campaign.id, player.id, turn.id, 'Greet the envoy.', false));
      await game.idle();
    },
    draft: () => JSON.parse(game.pending(campaign.id)!.draft!),
  };
}
function event(value: TurnAdjudication, fact: string) {
  const id = `world:faction:${value.events.length}`;
  value.events.push({
    id,
    sequence: value.events.length,
    kind: 'world',
    memberId: null,
    actionId: null,
    fact,
    receiptRefs: [],
    dependsOn: [],
    phase: 'aftermath',
    result: null,
  });
  return id;
}
function discovery(context: GMContext, value: TurnAdjudication, index = 0) {
  const faction = context.factions!.factions[index];
  const eventId = event(
    value,
    `An envoy identifies ${faction.name} as the organization controlling the gate.`,
  );
  (value.factionEffects ??= []).push({
    type: 'discover',
    factionId: faction.id,
    eventId,
    knownDescription: 'Its envoys negotiate access to the old gate.',
  });
  return { faction, eventId };
}

it('rejects hidden faction roll reasons before dice or charges and preserves the accepted public reason', async () => {
  const f = fixture();
  f.setEffects((context, value) => discovery(context, value));
  await f.start();
  f.draw.mockClear();
  const actor = f.game.members(f.campaign.id)[0];
  const ability = actor.character.abilities.find((ability) => ability.kind === 'utility')!;
  const reason = 'Mira examines the Gate Wardens emblem while the envoy watches guardedly.';
  f.provider.adjudicate = async (context, tools) => {
    const hidden = context.factions!.factions[1];
    const check = {
      memberId: actor.id,
      stat: ability.stat,
      dc: 10 as const,
      mode: 'disadvantage' as const,
      abilityName: ability.name,
      lethal: false,
      reason,
    };
    const state = structuredClone(context.members[0].state);
    for (const secret of [hidden.name.toUpperCase(), hidden.id]) {
      expect(() => tools({ ...check, reason: `The envoy serves ${secret}.` })).toThrow(
        'undiscovered faction',
      );
      expect(f.draw).not.toHaveBeenCalled();
      expect(f.snapshot().turn!.rolls).toEqual([]);
      expect(f.draft().members[0].state).toEqual(state);
    }
    const roll = tools(check);
    expect(roll).toMatchObject({ reason, mode: 'normal', dice: [12] });
    expect(tools({ ...check, reason: `A changed explanation mentioning ${hidden.name}.` })).toEqual(roll);
    expect(() => tools({ ...check, mode: 'normal' })).toThrow('already locked');
    expect(() => tools({ ...check, dc: 15 })).toThrow('already locked');
    expect(f.draw).toHaveBeenCalledTimes(1);
    expect(f.draft().members[0].state.abilityUses[ability.name]).toBe(1);
    throw new Error('Controlled interruption after the public roll');
  };
  const turn = f.snapshot().turn!;
  f.game.submit(f.campaign.id, f.players[0].id, turn.id, 'Examine the emblem.', false, false, ability.name);
  f.game.submit(f.campaign.id, f.players[1].id, turn.id, '', true);
  await f.game.idle();
  expect(f.snapshot().turn).toMatchObject({
    phase: 'failed',
    error: expect.stringContaining('Controlled interruption after the public roll'),
    rolls: [{ reason, mode: 'normal' }],
  });
  expect(JSON.stringify(f.snapshot())).not.toContain(f.world().factions[1].name);
});

it('creates three private factions before the opening and reveals them gradually with per-character attitudes', async () => {
  const f = fixture();
  f.setEffects((context, value) => {
    if (context.turn.number === 0) discovery(context, value);
    else {
      discovery(context, value, 1);
      const faction = context.factions!.factions[0];
      for (const [index, member] of context.members.entries()) {
        const eventId = event(
          value,
          `${member.character.name} ${index ? 'betrays' : 'aids'} the envoy while witnesses report their name.`,
        );
        (value.factionEffects ??= []).push({
          type: 'reputation',
          factionId: faction.id,
          memberId: member.id,
          characterId: member.characterId,
          eventId,
          amount: index ? -2 : 2,
          reason: 'A consequential witnessed deed.',
          awareness: 'The envoy witnesses the deed and reports the character’s name.',
          achievementKey: `gate-deed-${index}`,
        });
      }
    }
  });
  await f.start();
  expect(f.snapshot().turn?.phase, f.snapshot().turn?.error ?? '').toBe('collecting');
  expect(f.world().factions).toHaveLength(3);
  expect(f.snapshot().factions?.map((faction) => faction.name)).toEqual(['Gate Wardens']);
  expect(JSON.stringify(f.snapshot())).not.toMatch(
    /Harbor League|Veiled Archive|Secret agenda|privateAgenda|factionCandidates/,
  );
  await f.next();
  const s = f.snapshot();
  expect(s.turn?.phase, s.turn?.error ?? '').toBe('collecting');
  expect(s.factions).toHaveLength(2);
  const scores = s.members.map((member) => member.state.factionReputation![f.world().factions[0].id]);
  expect(scores).toEqual([2, -2]);
  expect(scores.map(factionAttitude)).toEqual(['Friendly', 'Hostile']);
  expect(s.history.at(-1)?.factionChanges?.map((change) => change.amount)).toEqual([2, -2]);
  expect(JSON.stringify(s)).not.toMatch(/Veiled Archive|Secret agenda|privateAgenda|factionEffects/);
  expect(
    (f.game.export(f.campaign.id, f.host.id) as { factions: FactionWorld }).factions.factions,
  ).toHaveLength(3);
  expect(() => f.game.export(f.campaign.id, f.players[0].id)).toThrow('leader');
});

it('keeps optional connection rolls, opt-out and affiliations independent from reputation and templates', async () => {
  const f = fixture({ generated: true });
  f.game.setFactionPreference(f.campaign.id, f.players[1].id, 'unaffiliated');
  await f.start();
  const members = f.game.members(f.campaign.id);
  expect(members[0].state.factionAffiliation?.kind).toBe('contact');
  expect(members[1].state.factionAffiliation).toBeUndefined();
  expect(f.snapshot().factions).toHaveLength(1);
  expect(f.snapshot().history[0].result?.narration).toContain('Mira knows Gate Wardens');
  const context = { factions: f.world(), members } as GMContext;
  const value = {
    factionEffects: [
      {
        type: 'reputation',
        factionId: f.world().factions[0].id,
        memberId: members[0].id,
        characterId: members[0].characterId,
        amount: -2,
        reason: 'Betrayal',
      },
    ],
  } as TurnAdjudication;
  applyFactionEffects(context.factions!, members, value, 1);
  applyFactionEffects(context.factions!, members, value, 2);
  expect(factionAttitude(members[0].state.factionReputation![f.world().factions[0].id])).toBe('Hostile');
  expect(members[0].state.factionAffiliation?.kind).toBe('contact');
  expect(f.game.characters(f.players[0].id)[0]).not.toHaveProperty('factionAffiliation');
  expect(() => f.game.setFactionPreference(f.campaign.id, f.players[0].id, 'allow')).toThrow('before');
});

it('validates faction world identities, preserved lore, eligible connections and bounded reputation', () => {
  const example = factionExample([randomUUID(), randomUUID(), randomUUID()], 'Harbor', [], 0);
  expect(factionWorldSchema.safeParse({ ...example, factions: example.factions.slice(0, 2) }).success).toBe(
    false,
  );
  const duplicate = structuredClone(example);
  duplicate.factions[1].name = duplicate.factions[0].name;
  expect(factionWorldSchema.safeParse(duplicate).success).toBe(false);
  const invalidLink = structuredClone(example);
  invalidLink.relations[0].to = 'missing';
  expect(factionWorldSchema.safeParse(invalidLink).success).toBe(false);
  const premature = structuredClone(example);
  premature.factions[0].discoveredTurn = 0;
  premature.factions[0].knownDescription = 'Public lore';
  expect(() => validateGeneratedWorld(premature, example)).toThrow('Preserve established');
  expect([-5, -2, -1, 0, 1, 2, 5].map(factionAttitude)).toEqual([
    'Hostile',
    'Hostile',
    'Neutral',
    'Neutral',
    'Neutral',
    'Friendly',
    'Friendly',
  ]);
  expect([clampReputation(-7), clampReputation(7)]).toEqual([-5, 5]);
});

it('accepts six initial factions, preserves seed identities, and keeps appended factions private', () => {
  const ids = Array.from({ length: 6 }, () => randomUUID());
  const seed = factionExample(ids.slice(0, 3), 'Mountain frontier', [], 0);
  const world = factionExample(ids, 'Mountain frontier', [], 0);
  expect(validateGeneratedWorld(world, seed).factions).toHaveLength(6);
  for (const defect of [
    'seed order',
    'seed missing',
    'premature discovery',
    'wrong activity turn',
    'too many',
  ]) {
    const invalid = structuredClone(world);
    if (defect === 'seed order')
      [invalid.factions[0], invalid.factions[1]] = [invalid.factions[1], invalid.factions[0]];
    if (defect === 'seed missing') invalid.factions.splice(0, 1);
    if (defect === 'premature discovery')
      Object.assign(invalid.factions[3], { discoveredTurn: 0, knownDescription: 'Revealed too soon.' });
    if (defect === 'wrong activity turn') invalid.factions[3].activityTurn = 1;
    if (defect === 'too many')
      invalid.factions.push({ ...invalid.factions[5], id: randomUUID(), name: 'Seventh faction' });
    expect(() => validateGeneratedWorld(invalid, seed), defect).toThrow();
  }
});

it('initializes six requested factions in one response and reuses them after an interrupted opening', async () => {
  const f = fixture();
  const fetcher = vi.fn(async (_url, init) => {
    const request = JSON.parse(init!.body as string);
    expect(request.instructions).toContain('SIX TOTAL');
    const input = JSON.parse(request.input[0].content);
    const seed: FactionWorld = input.schemaExample;
    const world = factionExample(
      [...seed.factions.map((faction) => faction.id), ...Array.from({ length: 3 }, () => randomUUID())],
      'Mountain frontier',
      [],
      0,
    );
    world.factions.forEach((faction, index) => {
      faction.name = `Frontier delegation ${index + 1}`;
    });
    return new Response(
      `data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(world) }] }] } })}\n\n`,
    );
  }) as unknown as typeof fetch;
  const gm = new ChatGPTGM(
    { accessToken: async () => 'test' } as unknown as ChatGPTAuth,
    f.host.id,
    'test-model',
    fetcher,
  );
  f.provider.generateFactions = gm.generateFactions.bind(gm);
  const narrate = f.provider.narrate!;
  f.provider.narrate = async () => {
    throw new Error('Interrupted opening narration');
  };
  await f.start();
  expect(f.snapshot().turn?.phase).toBe('failed');
  const saved = f.draft().factions;
  expect(saved.factions).toHaveLength(6);
  f.provider.narrate = narrate;
  f.game.retry(f.campaign.id, f.host.id);
  await f.game.idle();
  expect(f.snapshot().turn?.phase, f.snapshot().turn?.error ?? '').toBe('collecting');
  expect(f.world()).toEqual(saved);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(f.snapshot())).not.toContain('Frontier delegation');
});

it('reports the actual faction identity error instead of incorrectly blaming JSON formatting', async () => {
  const seed = factionExample(
    Array.from({ length: 3 }, () => randomUUID()),
    'Harbor',
    [],
    0,
  );
  const requests: any[] = [];
  const gm = new ChatGPTGM(
    { accessToken: async () => 'test' } as unknown as ChatGPTAuth,
    'owner',
    'test-model',
    async (_url, init) => {
      requests.push(JSON.parse(init!.body as string));
      const value = structuredClone(seed);
      if (requests.length === 1)
        [value.factions[0], value.factions[1]] = [value.factions[1], value.factions[0]];
      return new Response(
        `data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] } })}\n\n`,
      );
    },
  );
  const context = { config, members: [], journal: [] } as unknown as GMContext;
  const budget = { used: 0, limit: 3, corrections: [] as { request: number; feedback: string }[] };
  expect(await gm.generateFactions(context, seed, budget)).toEqual(seed);
  expect(requests[1].input.at(-1).content).toContain('Preserve supplied faction IDs and order.');
  expect(budget.corrections[0].feedback).not.toContain('valid JSON');
});

it('rejects duplicate deeds, unrelated actors, unknown IDs, excessive deltas and premature public names', async () => {
  const f = fixture();
  await f.start();
  const s = f.snapshot();
  const members = f.game.members(f.campaign.id);
  const faction = f.world().factions[0];
  const context: GMContext = {
    config,
    factions: f.world(),
    members,
    startingMembers: members,
    scene: s.scene,
    journal: s.journal,
    history: [],
    turn: s.turn!,
  };
  const value: TurnAdjudication = {
    version: 2,
    turnId: s.turn!.id,
    actions: [],
    events: [],
    changes: [],
    journal: [],
    location: null,
    rewards: { xp: 0, gold: 0, reason: 'None' },
  };
  const eventId = event(value, 'Mira helps an unnamed envoy who reports her identity.');
  const effect: FactionEffect = {
    type: 'reputation',
    factionId: faction.id,
    memberId: members[0].id,
    characterId: members[0].characterId,
    eventId,
    amount: 2,
    reason: 'Helped the envoy.',
    awareness: 'The envoy reports her identity.',
    achievementKey: 'envoy-help',
  };
  value.factionEffects = [effect];
  validateFactionEffects(context, value);
  const receipts = applyFactionEffects(context.factions!, members, value, 1);
  expect(receipts[0]).toMatchObject({ before: 0, after: 2, amount: 2 });
  expect(publicMember(members[0], context.factions).state.factionReputation).toEqual({});
  expect(() => validateFactionEffects(context, value)).toThrow('already');
  members[0].state.factionAchievements = {};
  value.factionEffects.push(effect);
  expect(() => validateFactionEffects(context, value)).toThrow('Combine');
  value.factionEffects = [{ ...effect, characterId: randomUUID() }];
  expect(() => validateFactionEffects(context, value)).toThrow('frozen character');
  value.factionEffects = [{ ...effect, factionId: randomUUID() }];
  expect(() => validateFactionEffects(context, value)).toThrow('existing faction');
  value.factionEffects = [];
  value.events[0].fact = faction.name;
  expect(() => validateFactionEffects(context, value)).toThrow('undiscovered');
  value.events[0].fact = 'Mira meets an unnamed envoy.';
  context.scene.location.atmosphere = `An item inscribed with ${context.factions!.factions[2].name} is visible.`;
  expect(() => validateFactionEffects(context, value)).toThrow('undiscovered');
  context.scene.location.atmosphere = 'A quiet gate.';
  value.events[0].fact = `Mira meets ${faction.name}.`;
  value.factionEffects = [
    { type: 'discover', factionId: faction.id, eventId, knownDescription: 'Envoys guard the gate.' },
    { ...effect, reason: `Helped the secret ${context.factions!.factions[2].name}.` },
  ];
  expect(() => validateFactionEffects(context, value)).toThrow('undiscovered');
  expect(() =>
    validateConnections(
      [
        {
          memberId: members[0].id,
          characterId: members[0].characterId,
          factionId: faction.id,
          source: 'generated',
          kind: 'member',
          reason: 'Past friend',
          score: 2,
          knownDescription: 'Envoys',
        },
      ],
      context,
      [{ memberId: members[0].id, characterId: members[0].characterId, generated: false }],
    ),
  ).toThrow('successful saved roll');
});

it('reuses faction generation and connection rolls after failed initialization, and survives restart after finalization without reapplying reputation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gather-factions-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const f = fixture({ generated: true, path: join(dir, 'game.sqlite') });
  let first = true;
  const practice = new PracticeGM();
  f.provider.connectFactions = vi.fn(async (context, candidates) => {
    if (first) {
      first = false;
      throw new Error('Interrupted connection generation.');
    }
    return practice.connectFactions(context, candidates);
  });
  await f.start();
  expect(f.snapshot().turn?.phase).toBe('failed');
  const rollCalls = f.draw.mock.calls.filter(([sides]) => sides === 100).length;
  expect(f.draft().receipts.factionCandidates).toHaveLength(2);
  expect(JSON.stringify(f.snapshot())).not.toContain('Gate Wardens');
  f.game.retry(f.campaign.id, f.host.id);
  await f.game.idle();
  expect(f.snapshot().turn?.phase).toBe('collecting');
  expect(f.generateFactions).toHaveBeenCalledTimes(1);
  expect(f.draw.mock.calls.filter(([sides]) => sides === 100)).toHaveLength(rollCalls);
  f.setEffects((context, value) => {
    const member = context.members[0];
    const eventId = event(value, 'Mira delivers a letter to the envoy, who reports her help.');
    value.factionEffects = [
      {
        type: 'reputation',
        factionId: context.factions!.factions[0].id,
        memberId: member.id,
        characterId: member.characterId,
        eventId,
        amount: 1,
        reason: 'Delivered the letter.',
        awareness: 'The envoy received it.',
        achievementKey: 'letter-delivery',
      },
    ];
  });
  f.provider.narrate = vi.fn(async () => {
    throw new Error('Narration interrupted.');
  });
  await f.next();
  expect(f.snapshot().turn?.phase).toBe('failed');
  const before = f.draft();
  expect(before.members[0].state.factionReputation[f.world().factions[0].id]).toBe(3);
  expect(f.snapshot().members[0].state.factionReputation?.[f.world().factions[0].id]).toBe(2);
  expect(f.snapshot().turn?.resolution).toBeUndefined();
  const factionId = f.world().factions[0].id;
  f.db.close();
  const db = openDatabase(join(dir, 'game.sqlite'));
  cleanup.push(() => db.close());
  const provider: GameMaster = {
    generateFactions: vi.fn(),
    adjudicate: vi.fn(),
    narrate: async (resolution) => factualNarration(resolution, 'English'),
  };
  const restarted = new Game(db, () => provider);
  restarted.retry(f.campaign.id, f.host.id);
  await restarted.idle();
  expect(
    restarted.snapshot(f.campaign.id, f.host.id).turn?.phase,
    restarted.snapshot(f.campaign.id, f.host.id).turn?.error ?? '',
  ).toBe('collecting');
  expect(restarted.members(f.campaign.id)[0].state.factionReputation?.[factionId]).toBe(3);
  expect(provider.generateFactions).not.toHaveBeenCalled();
  expect(provider.adjudicate).not.toHaveBeenCalled();
});

it('initializes late arrivals once and resets relationships when a replacement reuses the member seat', async () => {
  const f = fixture();
  f.setEffects((context, value) => {
    if (!context.turn.number) discovery(context, value);
  });
  await f.start();
  const late = f.game.identify();
  const sheet = templateCharacter('Late traveler');
  sheet.selectedEquipmentIds = sheet.equipmentOptions.slice(0, 2).map((item) => item.id);
  const saved = f.game.saveCharacter(late.id, sheet);
  f.game.join(f.campaign.inviteCode!, late.id, saved.id);
  await f.next(); // Arrival is excluded from the already collecting roster.
  expect(
    f.game.members(f.campaign.id).find((member) => member.playerId === late.id)?.state.factionInitialized,
  ).toBeUndefined();
  const turn = f.snapshot().turn!;
  [...f.players, late].forEach((player) => f.game.submit(f.campaign.id, player.id, turn.id, '', true));
  await f.game.idle();
  expect(
    f.game.members(f.campaign.id).find((member) => member.playerId === late.id)?.state.factionInitialized,
  ).toBe(true);
  const dead = f.game.members(f.campaign.id)[0];
  Object.assign(dead.state, {
    hp: 0,
    deathReason: 'Fallen',
    respawnReady: true,
    factionAffiliation: { factionId: f.world().factions[0].id, kind: 'member', reason: 'Old life' },
    factionReputation: { [f.world().factions[0].id]: -5 },
    factionAchievements: { [f.world().factions[0].id]: ['old-deed'] },
  });
  f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(dead.state), dead.id);
  const replacementSheet = templateCharacter('New traveler');
  replacementSheet.selectedEquipmentIds = replacementSheet.equipmentOptions
    .slice(0, 2)
    .map((item) => item.id);
  const replacement = f.game.saveCharacter(f.players[0].id, replacementSheet);
  f.game.queueReplacement(f.campaign.id, f.players[0].id, replacement.id);
  const fresh = f.game.members(f.campaign.id)[0];
  expect(fresh.id).toBe(dead.id);
  expect(fresh.character.name).toBe('New traveler');
  expect(fresh.state.factionReputation).toBeUndefined();
  expect(fresh.state.factionAffiliation).toBeUndefined();
  expect(fresh.state.factionAchievements).toBeUndefined();
});

it('backfills known journal factions at a fresh boundary without inventing historical ties', async () => {
  const f = fixture();
  const generation = f.provider.generateFactions;
  delete f.provider.generateFactions;
  await f.start();
  f.db
    .prepare('INSERT INTO journal(campaign_id,kind,name,detail) VALUES (?, ?, ?, ?)')
    .run(
      f.campaign.id,
      'faction',
      'Old Wardens',
      'An established organization that already helped the party.',
    );
  f.provider.generateFactions = vi.fn(async (_context, example) => example);
  f.game.setActive(f.campaign.id, f.host.id, f.game.members(f.campaign.id)[0].id, true);
  await f.next();
  expect(f.snapshot().turn?.phase, f.snapshot().turn?.error ?? '').toBe('collecting');
  expect(f.world().factions).toHaveLength(3);
  expect(f.world().factions[0]).toMatchObject({
    name: 'Old Wardens',
    knownDescription: 'An established organization that already helped the party.',
  });
  expect(f.connectFactions).not.toHaveBeenCalled();
  expect(f.game.members(f.campaign.id).every((member) => !member.state.factionAffiliation)).toBe(true);
  expect(generation).not.toHaveBeenCalled();
});

it('never publishes hidden faction names invented by narration', async () => {
  const f = fixture({
    overrides: {
      narrate: async (resolution) => ({
        ...factualNarration(resolution, 'English'),
        closing: 'The Veiled Archive is secretly watching.',
      }),
    },
  });
  await f.start();
  expect(f.snapshot().turn?.phase).toBe('collecting');
  expect(f.snapshot().history[0].result?.narration).not.toContain('Veiled Archive');
  expect(JSON.stringify(f.snapshot())).not.toMatch(/Secret agenda|Veiled Archive/);
});

it('supplies private agendas and individual character identities only to adjudication and validates model-generated worlds', async () => {
  const f = fixture();
  await f.start();
  const context: GMContext = {
    config,
    factions: f.world(),
    members: f.game.members(f.campaign.id),
    scene: f.snapshot().scene,
    turn: f.snapshot().turn!,
    journal: [],
    history: [],
  };
  const input = adjudicationInput(context);
  expect(input.factions?.factions[2].privateAgenda).toContain('Secret agenda');
  expect(input.members[0].characterId).toBe(context.members[0].characterId);
  const example = f.world();
  const requests: Record<string, any>[] = [];
  const gm = new ChatGPTGM(
    { accessToken: async () => 'test' } as unknown as ChatGPTAuth,
    f.host.id,
    'test-model',
    async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      requests.push(body);
      const payload =
        requests.length === 1 ? { ...example, factions: example.factions.slice(0, 2) } : example;
      return new Response(
        `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(payload) }] }] } })}\n\n`,
      );
    },
  );
  expect((await gm.generateFactions(context, example, { used: 0, limit: 3 })).factions).toHaveLength(3);
  expect(requests).toHaveLength(2);
  expect(requests[0].tools).toBeUndefined();
});

it('filters raw host, player and shared-screen responses and protects preference changes', async () => {
  const f = fixture();
  f.setEffects((context, value) => {
    if (!context.turn.number) discovery(context, value);
  });
  await f.start();
  const { app, game } = await createApp({ db: f.db, auth: {} as ChatGPTAuth, providers: () => f.provider });
  cleanup.push(() => app.close());
  for (const player of [f.host, ...f.players]) {
    const response = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${f.campaign.id}`,
      cookies: { gather_session: player.token! },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toMatch(
      /Harbor League|Veiled Archive|Secret agenda|privateAgenda|factionAchievements/,
    );
  }
  const display = await app.inject({
    method: 'POST',
    url: `/api/campaigns/${f.campaign.id}/display`,
    payload: { token: f.campaign.displayToken },
    headers: { 'x-gather-request': '1' },
  });
  expect(display.statusCode).toBe(200);
  const screen = await app.inject({
    method: 'GET',
    url: `/api/campaigns/${f.campaign.id}`,
    cookies: Object.fromEntries(display.cookies.map((cookie) => [cookie.name, cookie.value])),
  });
  expect(screen.statusCode).toBe(200);
  expect(screen.body).not.toMatch(/Harbor League|Veiled Archive|Secret agenda/);
  const stranger = game.identify();
  const preference = await app.inject({
    method: 'POST',
    url: `/api/campaigns/${f.campaign.id}/faction-preference`,
    cookies: { gather_session: stranger.token! },
    headers: { 'x-gather-request': '1' },
    payload: { preference: 'unaffiliated' },
  });
  expect(preference.statusCode).toBe(409);
});

it('honors an explicit hostile backstory even when generated connections are disabled', async () => {
  const f = fixture();
  const member = f.game.members(f.campaign.id)[0];
  f.game.editLobbyCharacter(f.campaign.id, f.players[0].id, {
    ...member.character,
    background: 'Mira deserted the Gate Wardens, who now consider her a traitor.',
  });
  const edited = f.game.members(f.campaign.id)[0];
  f.game.manageCharacter(f.campaign.id, f.players[0].id, {
    type: 'starter',
    itemIds: edited.state.starterEquipment.slice(0, 2).map((item) => item.id),
  });
  f.game.setFactionPreference(f.campaign.id, f.players[0].id, 'unaffiliated');
  f.provider.connectFactions = async (context, candidates) => {
    expect(candidates).toHaveLength(1);
    expect(candidates[0].generated).toBe(false);
    return [
      {
        ...candidates[0],
        factionId: context.factions!.factions[0].id,
        kind: 'former-member' as const,
        source: 'explicit' as const,
        score: -2 as const,
        reason: 'Deserted the organization.',
        knownDescription: 'Its patrols guard the gate.',
      },
    ].map(({ generated: _, ...connection }) => connection);
  };
  await f.start();
  expect(f.snapshot().turn?.phase, f.snapshot().turn?.error ?? '').toBe('collecting');
  expect(f.snapshot().members[0].state.factionAffiliation?.kind).toBe('former-member');
  expect(factionAttitude(f.snapshot().members[0].state.factionReputation?.[f.world().factions[0].id])).toBe(
    'Hostile',
  );
  expect(f.snapshot().factions).toHaveLength(1);
});

it('persists private activity and saturated reputation while exposing only justified public consequences in Dutch', async () => {
  const f = fixture({ language: 'Nederlands' });
  f.setEffects((context, value) => {
    if (!context.turn.number) discovery(context, value);
  });
  await f.start();
  const member = f.game.members(f.campaign.id)[0];
  const factionId = f.world().factions[0].id;
  member.state.factionReputation = { [factionId]: 4 };
  f.db.prepare('UPDATE members SET state = ? WHERE id = ?').run(JSON.stringify(member.state), member.id);
  f.setEffects((context, value) => {
    const actor = context.members[0];
    const eventId = event(value, 'Mira helpt de gezant, die haar naam aan de organisatie meldt.');
    value.factionEffects = [
      {
        type: 'reputation',
        factionId,
        memberId: actor.id,
        characterId: actor.characterId,
        eventId,
        amount: 2,
        awareness: 'De gezant meldt de hulp.',
        reason: 'De gezant geholpen.',
        achievementKey: 'gezant-hulp',
      },
      {
        type: 'activity',
        factionId: context.factions!.factions[2].id,
        eventId,
        activity: 'Bereidt in het geheim een overname van het archief voor.',
      },
    ];
  });
  await f.next();
  expect(f.snapshot().turn?.phase, f.snapshot().turn?.error ?? '').toBe('collecting');
  expect(f.snapshot().members[0].state.factionReputation?.[factionId]).toBe(5);
  expect(f.snapshot().history.at(-1)?.factionChanges?.[0]).toMatchObject({ before: 4, after: 5, amount: 1 });
  expect(f.snapshot().history.at(-1)?.resolution?.events.at(-1)?.fact).toContain('Vriendelijk');
  expect(f.world().factions[2]).toMatchObject({
    activity: 'Bereidt in het geheim een overname van het archief voor.',
    activityTurn: 1,
  });
  expect(JSON.stringify(f.snapshot())).not.toMatch(/overname van het archief|Veiled Archive/);
});

it('publishes accumulated faction knowledge alongside ten ordinary journal entries without exceeding schema limits', async () => {
  const f = fixture();
  const detail = 'Established public gate history. '.repeat(120);
  f.setEffects((context, value) => {
    for (let index = 0; index < 3; index++) {
      discovery(context, value, index);
      const effect = value.factionEffects!.at(-1)!;
      if (effect.type === 'discover') effect.knownDescription = `${detail} Public faction ${index}.`;
    }
    value.journal = Array.from({ length: 10 }, (_, index) => ({
      kind: 'fact',
      name: `Public note ${index}`,
      detail: 'An established public observation.',
    }));
  });
  await f.start();
  expect(f.snapshot().turn?.phase, f.snapshot().turn?.error ?? '').toBe('collecting');
  expect(f.snapshot().journal).toHaveLength(13);
  expect(f.snapshot().history[0].result?.journal.filter((entry) => entry.kind === 'faction')).toHaveLength(3);
  expect(f.snapshot().factions?.[0].knownDescription).toContain(detail);
});
