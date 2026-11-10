import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { ChatGPTGM, adjudicationInput } from '../server/providers';
import { assertEncounterProposal, prepareEncounterChecks, type EncounterChecks } from '../server/encounters';
import { validateAdjudication } from '../server/turn-resolution';
import type { ChatGPTAuth } from '../server/auth';
import type { GMContext, GameTools, StageBudget } from '../server/game';
import { initialScene, initialState } from '../shared/rules';
import { ensureLocations } from '../shared/locations';
import { enemySchema, templateCharacter, type Encounter } from '../shared/schema';
import { turnAdjudicationSchema } from '../shared/turn-resolution';

function fixture(introduce: boolean) {
  const id = randomUUID();
  const character = templateCharacter('Scout');
  const scene = ensureLocations(initialScene('Forest road'), [id]);
  scene.encounterRisk = { danger: 'dangerous', reason: 'Raiders use this exposed road.' };
  const context: GMContext = {
    config: {
      ruleset: 'roguelike-v1',
      name: 'Road',
      setting: 'Forest road',
      premise: 'Find the caravan.',
      tone: '',
      instructions: '',
      language: 'English',
      custom: [],
      provider: 'chatgpt',
      model: 'test',
    },
    members: [
      {
        id,
        playerId: randomUUID(),
        playerName: 'Player',
        characterId: randomUUID(),
        character,
        state: initialState(character, id),
        active: true,
      },
    ],
    scene,
    journal: [],
    history: [],
    receipts: {},
    turn: {
      id: randomUUID(),
      number: 1,
      phase: 'resolving',
      roster: [id],
      actions: [{ memberId: id, text: 'Inspect the road.', passed: false }],
      rolls: [],
      result: null,
      error: null,
    },
  };
  const checks: EncounterChecks = {};
  const draw = vi.fn(() => 1);
  const enemy = enemySchema.parse({
    id: 'raider',
    name: 'Road raider',
    tier: 'minor',
    hp: 8,
    defense: 8,
    attack: 0,
    damage: '1d4',
    description: 'A desperate local raider.',
    tactic: 'Demand payment.',
  });
  const startCombat = vi.fn((enemies: unknown, locationId?: string) => {
    expect(locationId).toBe(scene.location.id);
    expect(enemies).toEqual([enemy]);
    const encounter = {
      enemies: [{ ...enemy, maxHp: enemy.hp, initiative: 10 }],
      round: 1,
      initiative: [],
      victory: false,
      escaped: false,
    };
    context.receipts!.startCombatByLocation = { [locationId!]: encounter };
    context.receipts!.startCombat = encounter;
    scene.encounter = encounter;
    return encounter;
  });
  const tools = Object.assign(vi.fn(), {
    startCombat,
    combat: vi.fn(),
    offerLoot: vi.fn(),
    completeChallenge: vi.fn(),
    validateAdjudication: (value: unknown) => validateAdjudication(context, value),
    prepareEncounters: (value: Parameters<NonNullable<GameTools['prepareEncounters']>>[0]) => {
      context.receipts!.encounterChecks = checks;
      return prepareEncounterChecks(context, value, checks, draw).required;
    },
  }) as GameTools;
  const requests: any[] = [];
  const fetcher = vi.fn(async (_url, init) => {
    const request = JSON.parse(init!.body as string);
    requests.push(request);
    let output;
    if (introduce && requests.length === 2) {
      output = [
        {
          type: 'function_call',
          namespace: 'game',
          name: 'start_combat',
          call_id: 'start-local-fight',
          arguments: JSON.stringify({ locationId: scene.location.id, enemies: [enemy] }),
        },
      ];
    } else {
      const {
        encounterRisks: _risk,
        worldProgress: _progress,
        ...proposal
      } = adjudicationInput(context).schemaExample;
      // Omitting optional JSON fields must not bypass server-owned checks in production.
      if (scene.encounter)
        proposal.events.push({
          id: 'world:raider',
          sequence: proposal.events.length,
          kind: 'world',
          actionId: null,
          memberId: null,
          phase: 'aftermath',
          result: null,
          locationRef: scene.location.id,
          fact: 'A road raider steps from cover and demands payment.',
          dependsOn: [],
          receiptRefs: ['tool:startCombatByLocation'],
        });
      output = [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(proposal) }] }];
    }
    return new Response(
      `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })}\n\n`,
    );
  }) as unknown as typeof fetch;
  const gm = new ChatGPTGM(
    { accessToken: async () => 'test' } as unknown as ChatGPTAuth,
    'owner',
    'test',
    fetcher,
  );
  return { context, gm, tools, checks, draw, startCombat, requests };
}

it('continues the same adjudication stage to create a mandatory local encounter with one saved check', async () => {
  const f = fixture(true);
  const value = await f.gm.adjudicate(f.context, f.tools);
  expect(f.draw).toHaveBeenCalledTimes(1);
  expect(f.startCombat).toHaveBeenCalledTimes(1);
  expect(f.requests).toHaveLength(3);
  expect(f.requests[0].instructions.length).toBeLessThan(36_000);
  expect(JSON.parse(f.requests[1].input[0].content).encounterChecks.checks['place:1'].triggered).toBe(true);
  expect(value.events.some((event) => event.id === 'world:raider')).toBe(true);
  expect(f.context.scene.encounter?.round).toBe(1);
  expect(f.tools.combat).not.toHaveBeenCalled();
});

it('keeps a saved trigger mandatory when the model repeatedly omits the encounter', async () => {
  const f = fixture(false);
  await expect(f.gm.adjudicate(f.context, f.tools)).rejects.toThrow('saved random encounters');
  expect(f.draw).toHaveBeenCalledTimes(1);
  expect(f.requests).toHaveLength(8);
  expect(Object.values(f.checks)[0].triggered).toBe(true);
  expect(f.startCombat).not.toHaveBeenCalled();
});

it.each([true, false])(
  'resumes only the missing split-party encounter with an empty screen focus (completes=%s)',
  async (completes) => {
    const f = fixture(false);
    const context = f.context;
    const road = context.scene.location.id!;
    const depot = randomUUID();
    const second = { ...structuredClone(context.members[0]), id: randomUUID() };
    context.members.push(second);
    context.turn.roster.push(second.id);
    context.turn.actions.push({ memberId: second.id, text: 'Inspect the depot.', passed: false });
    context.scene.places![road] = {
      location: context.scene.location,
      encounter: null,
      loot: [],
      encounterRisk: context.scene.encounterRisk,
    };
    context.scene.places![depot] = {
      location: { id: depot, name: 'Depot', atmosphere: '', hazard: 'Security patrols' },
      encounter: null,
      loot: [],
      encounterRisk: { danger: 'dangerous', reason: 'Security patrols the depot.' },
    };
    context.scene.memberLocations![second.id] = depot;
    context.scene.location = { id: randomUUID(), name: 'Night City', atmosphere: '', hazard: '' };
    const baseline = turnAdjudicationSchema.parse(adjudicationInput(context).schemaExample);
    // Scene v3 saves no explicit focus; the original turn's fallback incorrectly focused the empty city.
    delete baseline.sceneFocus;
    context.receipts!.encounterProposal = structuredClone(baseline);
    for (const [locationId, memberId] of [
      [road, context.members[0].id],
      [depot, second.id],
    ])
      f.checks[locationId] = {
        locationId,
        memberIds: [memberId],
        danger: 'dangerous',
        reason: 'Hostile patrols.',
        die: 1,
        triggered: true,
      };
    context.receipts!.encounterChecks = f.checks;
    const encounter: Encounter = {
      enemies: [],
      round: 1,
      initiative: [],
      victory: false,
      escaped: false,
    };
    context.receipts!.startCombatByLocation = { [road]: structuredClone(encounter) };
    const saved = structuredClone(context.receipts);
    const budget: StageBudget = { used: 0, limit: 2 };
    context.requestBudget = budget;
    const startCombat = vi.fn((_enemies: unknown, locationId?: string) => {
      expect(locationId).toBe(depot);
      (context.receipts!.startCombatByLocation as Record<string, Encounter>)[depot] = encounter;
      return encounter;
    });
    f.tools.startCombat = startCombat;
    f.tools.prepareEncounters = (value) => {
      assertEncounterProposal(context, value, baseline);
      return prepareEncounterChecks(context, value, f.checks, f.draw).required;
    };
    const requests: { requiredLocations?: { locationId: string }[] }[] = [];
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const input = JSON.parse(JSON.parse(String(init?.body)).input[0].content);
      requests.push(input);
      const output =
        completes && fetcher.mock.calls.length === 2
          ? [
              {
                type: 'function_call',
                name: 'start_combat',
                call_id: 'depot-start',
                arguments: JSON.stringify({ locationId: depot, enemies: [] }),
              },
            ]
          : [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }];
      return new Response(
        `data: ${JSON.stringify({ type: 'response.completed', response: { output } })}\n\n`,
      );
    });
    const gm = new ChatGPTGM(
      { accessToken: async () => 'test' } as unknown as ChatGPTAuth,
      'owner',
      'test',
      fetcher,
    );
    if (completes) {
      const accepted = await gm.adjudicate(context, f.tools);
      expect(accepted.actions).toEqual(baseline.actions);
      expect(accepted.events.slice(0, baseline.events.length)).toEqual(baseline.events);
      expect(accepted.events.filter((event) => event.id.startsWith('encounter:introduction:'))).toHaveLength(
        2,
      );
      expect(startCombat).toHaveBeenCalledTimes(1);
    } else {
      await expect(gm.adjudicate(context, f.tools)).rejects.toThrow(/saved random encounters.*Retry/);
      expect(startCombat).not.toHaveBeenCalled();
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const input of requests)
      expect(input.requiredLocations?.map((check) => check.locationId)).toEqual([depot]);
    expect(context.receipts!.encounterProposal).toEqual(saved!.encounterProposal);
    expect(context.receipts!.encounterChecks).toEqual(saved!.encounterChecks);
    expect((context.receipts!.startCombatByLocation as Record<string, Encounter>)[road]).toEqual(
      (saved!.startCombatByLocation as Record<string, Encounter>)[road],
    );
    expect(f.draw).not.toHaveBeenCalled();
    expect(f.tools.combat).not.toHaveBeenCalled();
  },
);
