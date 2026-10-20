import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { ChatGPTGM, adjudicationInput } from '../server/providers';
import { prepareEncounterChecks, type EncounterChecks } from '../server/encounters';
import { validateAdjudication } from '../server/turn-resolution';
import type { ChatGPTAuth } from '../server/auth';
import type { GMContext, GameTools } from '../server/game';
import { initialScene, initialState } from '../shared/rules';
import { ensureLocations } from '../shared/locations';
import { enemySchema, templateCharacter } from '../shared/schema';

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
