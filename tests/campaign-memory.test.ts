import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openDatabase } from '../server/db';
import { retrieveCampaignMemory, rebuildCampaignMemory } from '../server/campaign-memory';
import { Game, type GMContext, type GameTools } from '../server/game';
import { ChatGPTGM, PracticeGM, adjudicationInput } from '../server/providers';
import { initialScene, initialState } from '../shared/rules';
import { ensureLocations } from '../shared/locations';
import { templateCharacter } from '../shared/schema';
import { validateAdjudication } from '../server/turn-resolution';
import type { ChatGPTAuth } from '../server/auth';

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
  vi.unstubAllEnvs();
});

function fixture() {
  const db = openDatabase(':memory:');
  cleanup.push(() => db.close());
  const character = templateCharacter('Archivist');
  const member = {
    id: 'actor',
    playerId: 'player',
    playerName: 'Player',
    characterId: 'sheet',
    character,
    state: initialState(character, 'actor'),
    active: true,
  };
  const scene = ensureLocations(initialScene('Workshop'), [member.id]);
  scene.currencyName = 'credits';
  scene.encounterRisk = { danger: 'safe', reason: 'A public workshop.' };
  scene.npcs = {
    mechanic: {
      id: 'mechanic',
      name: 'Mira',
      aliases: ['the mechanic', 'de monteur'],
      locationId: scene.location.id!,
      status: 'alive',
      allegiance: null,
      fact: 'Mira works at the bench.',
    },
  };
  const context: GMContext = {
    config: {
      ruleset: 'roguelike-v1',
      name: 'Memory',
      setting: 'Workshop',
      premise: '',
      tone: '',
      instructions: '',
      language: 'English',
      custom: [],
      provider: 'practice',
      model: '',
    },
    scene,
    members: [member],
    history: Array.from({ length: 12 }, () => ({ summary: 'A quiet day.' })),
    journal: [],
    gmMemory: [],
    turn: {
      id: 'current-turn',
      number: 40,
      phase: 'resolving',
      roster: [member.id],
      actions: [{ memberId: member.id, text: 'Ask the mechanic about that deal.', passed: false }],
      rolls: [],
      result: null,
      error: null,
    },
  };
  const campaignId = randomUUID();
  db.prepare('INSERT INTO players(id,name) VALUES(?,?)').run('owner', 'Host');
  db.prepare('INSERT INTO campaigns(id, owner_id, code, display_token, config) VALUES(?,?,?,?,?)').run(
    campaignId,
    'owner',
    campaignId,
    randomUUID(),
    JSON.stringify(context.config),
  );
  function turn(
    number: number,
    text = 'Mira promises a safe room in return for repairing the beacon.',
    extra: Record<string, unknown> = {},
    campaign = campaignId,
  ) {
    const id = randomUUID();
    const event = {
      id: 'promise',
      kind: 'world',
      memberId: member.id,
      npcIds: ['mechanic'],
      locationRef: scene.location.id,
      fact: text,
      dependsOn: [],
    };
    const draft = {
      gmMemory: [{ cause: 'PRIVATE: the mayor is a dragon.' }],
      resolution: { events: [event], journal: [] },
      ...extra,
    };
    db.prepare(
      `INSERT INTO turns(id,campaign_id,number,phase,roster,draft,result) VALUES(?,?,?,'complete','[]',?,?)`,
    ).run(
      id,
      campaign,
      number,
      JSON.stringify(draft),
      JSON.stringify({ summary: 'Decorative narration invents a gold crown.' }),
    );
    return id;
  }
  return { db, context, campaignId, turn };
}

it.each(['Ask the mechanic about that deal.', 'Vraag de monteur naar die afspraak.'])(
  'recalls a journal-evicted agreement without extra model work: %s',
  (text) => {
    const f = fixture();
    f.turn(1);
    f.context.turn.actions[0].text = text;
    f.context.journal = [{ kind: 'npc', name: 'Mira', detail: 'Mira recently repaired a wheel.' }];
    const memory = retrieveCampaignMemory(f.db, f.campaignId, f.context);
    expect(memory.diagnostics.status).toBe('ok');
    expect(memory.facts).toHaveLength(1);
    expect(memory.facts[0]).toMatchObject({
      turnNumber: 1,
      sourceId: 'promise',
      actorIds: ['actor'],
      entityIds: expect.arrayContaining(['mechanic']),
    });
    expect(memory.facts[0].text).toContain('safe room');
    expect(JSON.stringify(memory)).not.toMatch(/PRIVATE|gold crown/);
    f.context.retrievedMemory = memory;
    const input = adjudicationInput(f.context);
    expect(input.retrievedMemory?.facts).toEqual(memory.facts);
    expect(input.history).toHaveLength(12);
  },
);

it('filters unfinished, recent, future and other-campaign evidence before limiting results', () => {
  const f = fixture();
  f.turn(1, 'Mira promised a safe room.');
  const unfinished = f.turn(2, 'UNFINISHED: Mira promises a treasure room.');
  f.db.prepare("UPDATE turns SET phase='failed' WHERE id=?").run(unfinished);
  f.turn(35, 'RECENT: Mira refuses another deal.');
  f.turn(45, 'FUTURE: Mira gives a diamond.');
  const foreign = randomUUID();
  f.db
    .prepare('INSERT INTO campaigns(id,owner_id,code,display_token,config) VALUES(?,?,?,?,?)')
    .run(foreign, 'owner', foreign, foreign, '{}');
  for (let number = 1; number < 80; number++)
    f.turn(number, 'FOREIGN: Mira promises a treasure room.', {}, foreign);
  const memory = retrieveCampaignMemory(f.db, f.campaignId, f.context);
  expect(memory.facts.map((fact) => fact.text)).toEqual(['Mira promised a safe room.']);
});

it('excludes a reopened turn even when its formerly completed facts were already indexed', () => {
  const f = fixture();
  const id = f.turn(1);
  expect(retrieveCampaignMemory(f.db, f.campaignId, f.context).facts).toHaveLength(1);
  f.db.prepare("UPDATE turns SET phase='failed' WHERE id=?").run(id);
  expect(retrieveCampaignMemory(f.db, f.campaignId, f.context).facts).toEqual([]);
});

it('deduplicates current knowledge, caps complete facts, and selects deterministically', () => {
  const f = fixture();
  for (let number = 0; number < 25; number++)
    f.turn(number, `Mira's deal number ${number}: ${'a detailed promise '.repeat(80)}`);
  const first = retrieveCampaignMemory(f.db, f.campaignId, f.context);
  const second = retrieveCampaignMemory(f.db, f.campaignId, f.context);
  expect(first.facts.length).toBeGreaterThan(0);
  expect(first.facts.length).toBeLessThanOrEqual(8);
  expect(JSON.stringify(first).length).toBeLessThanOrEqual(8000);
  expect(first.facts).toEqual(second.facts);
  expect(second.diagnostics.indexedTurns).toBe(0);
  const current = first.facts[0];
  f.context.journal = [{ kind: 'fact', name: 'Known promise', detail: current.text }];
  expect(retrieveCampaignMemory(f.db, f.campaignId, f.context).facts).not.toContainEqual(current);
});

it('does not pad a search with unrelated local conversations and restores a lost full-text index', () => {
  const f = fixture();
  f.turn(1);
  f.context.turn.actions[0].text = 'Inspect the washed-out footprints.';
  expect(retrieveCampaignMemory(f.db, f.campaignId, f.context).facts).toEqual([]);
  const legacy = f.turn(2, '', { resolution: undefined });
  f.db
    .prepare('UPDATE turns SET result=? WHERE id=?')
    .run(JSON.stringify({ summary: 'The footprints lead to the drainage channel.' }), legacy);
  expect(retrieveCampaignMemory(f.db, f.campaignId, f.context).facts.map((fact) => fact.turnNumber)).toEqual([
    2,
  ]);
  f.db.exec('DROP TABLE campaign_memory_search');
  expect(retrieveCampaignMemory(f.db, f.campaignId, f.context).facts.map((fact) => fact.turnNumber)).toEqual([
    2,
  ]);
});

it('deduplicates complete journal facts against current knowledge and recalls newly committed facts', () => {
  const f = fixture();
  const old = 'Mira promises a safe room after the beacon is repaired.';
  f.turn(1, '', {
    scene: f.context.scene,
    resolution: { events: [], journal: [{ kind: 'npc', name: 'Mira', detail: old }] },
  });
  expect(retrieveCampaignMemory(f.db, f.campaignId, f.context).facts[0].text).toBe(old);
  f.context.journal = [{ kind: 'npc', name: 'Mira', detail: old }];
  expect(retrieveCampaignMemory(f.db, f.campaignId, f.context).facts).toEqual([]);
  f.turn(2, 'Mira now asks for the beacon casing as well.');
  const next = retrieveCampaignMemory(f.db, f.campaignId, f.context);
  expect(next.diagnostics.indexedTurns).toBe(1);
  expect(next.facts.map((fact) => fact.turnNumber)).toEqual([2]);
});

it('does not let current dead NPC state or completed quest state be replaced by history', () => {
  const f = fixture();
  f.turn(1, 'Mira is alive and offers to help with the beacon.');
  f.context.scene.npcs!.mechanic.status = 'dead';
  f.context.scene.quests = {
    beacon: {
      id: 'beacon',
      name: 'Beacon repair',
      description: 'Visit the workshop.',
      giverId: 'mechanic',
      recipientId: 'mechanic',
      objectives: [
        {
          id: 'visit',
          description: 'Visit the workshop.',
          condition: { kind: 'visit', locationId: f.context.scene.location.id! },
        },
      ],
      reward: { description: 'Shelter.', currency: 0, items: [], access: [] },
      status: 'completed',
      offeredTurn: 1,
      acceptedTurn: 2,
      completedTurn: 3,
      progress: { visit: { current: 1, complete: true, evidence: ['visit'] } },
      priorDeaths: [],
    },
  };
  const before = structuredClone(f.context.scene);
  f.context.retrievedMemory = retrieveCampaignMemory(f.db, f.campaignId, f.context);
  expect(f.context.retrievedMemory.facts).toHaveLength(1);
  expect(f.context.scene).toEqual(before);
  expect(adjudicationInput(f.context).scene.npcs.mechanic.status).toBe('dead');
  expect(adjudicationInput(f.context).scene.quests!.beacon.status).toBe('completed');
});

it('keeps dependency conditions with a fact and labels legacy summaries', () => {
  const f = fixture();
  f.turn(1, '', {
    resolution: {
      events: [
        {
          id: 'refusal',
          kind: 'action',
          memberId: 'actor',
          fact: 'Mira refuses the free repair.',
          dependsOn: [],
        },
        {
          id: 'offer',
          kind: 'world',
          npcIds: ['mechanic'],
          fact: 'Mira offers a paid repair instead.',
          dependsOn: [{ eventId: 'refusal', requires: 'occurrence' }],
        },
      ],
      journal: [],
    },
  });
  const legacy = f.turn(2, '', { resolution: undefined });
  f.db
    .prepare('UPDATE turns SET result=? WHERE id=?')
    .run(JSON.stringify({ summary: 'Mira agreed to store the beacon overnight.' }), legacy);
  const memory = retrieveCampaignMemory(f.db, f.campaignId, f.context);
  expect(memory.facts.find((fact) => fact.sourceId === 'offer')?.text).toContain('refuses the free repair');
  expect(memory.facts.find((fact) => fact.turnNumber === 2)?.kind).toBe('legacy-summary');
});

it('allocates recall across separate acting characters and preserves source attribution', () => {
  const f = fixture();
  const other = structuredClone(f.context.members[0]);
  other.id = 'other-actor';
  f.context.members.push(other);
  const locationId = 'other-room';
  f.context.scene.places![locationId] = {
    location: { id: locationId, name: 'Archive', atmosphere: '', hazard: '' },
    encounter: null,
    loot: [],
  };
  f.context.scene.memberLocations![other.id] = locationId;
  f.context.turn.actions.push({
    memberId: other.id,
    text: 'Read the astronomer telescope notes.',
    passed: false,
  });
  for (let number = 1; number < 10; number++) f.turn(number, `Mira promise ${number}.`);
  f.turn(11, '', {
    resolution: {
      events: [
        {
          id: 'telescope',
          kind: 'world',
          memberId: other.id,
          locationRef: locationId,
          fact: 'The astronomer left telescope notes about a comet.',
          dependsOn: [],
        },
      ],
      journal: [],
    },
  });
  const memory = retrieveCampaignMemory(f.db, f.campaignId, f.context);
  expect(memory.facts.slice(0, 2).map((fact) => fact.actorIds)).toEqual([['actor'], ['other-actor']]);
});

it('indexes in bounded idempotent batches and rebuilds without changing historical rows', () => {
  const f = fixture();
  f.context.turn.number = 150;
  for (let number = 1; number < 100; number++) f.turn(number, `Mira promise ${number}.`);
  const before = f.db.prepare('SELECT id, draft, result FROM turns ORDER BY number').all();
  const first = retrieveCampaignMemory(f.db, f.campaignId, f.context);
  expect(first.diagnostics).toMatchObject({ indexedTurns: 64, backlog: 35 });
  const second = retrieveCampaignMemory(f.db, f.campaignId, f.context);
  expect(second.diagnostics).toMatchObject({ indexedTurns: 35, backlog: 0 });
  const count = () =>
    (f.db.prepare('SELECT COUNT(*) AS count FROM campaign_memory').get() as { count: number }).count;
  expect(count()).toBe(99);
  retrieveCampaignMemory(f.db, f.campaignId, f.context);
  expect(count()).toBe(99);
  rebuildCampaignMemory(f.db, f.campaignId);
  expect(count()).toBe(0);
  retrieveCampaignMemory(f.db, f.campaignId, f.context);
  expect(count()).toBe(64);
  expect(f.db.prepare('SELECT id, draft, result FROM turns ORDER BY number').all()).toEqual(before);
});

it('continues with empty context for a disabled feature or unavailable index, skipping malformed history', () => {
  const f = fixture();
  const bad = f.turn(1);
  f.db.prepare('UPDATE turns SET draft=? WHERE id=?').run('malformed', bad);
  expect(retrieveCampaignMemory(f.db, f.campaignId, f.context).diagnostics.status).toBe('ok');
  vi.stubEnv('GATHER_CAMPAIGN_MEMORY', '0');
  expect(retrieveCampaignMemory(f.db, f.campaignId, f.context)).toMatchObject({
    facts: [],
    diagnostics: { status: 'disabled' },
  });
  vi.stubEnv('GATHER_CAMPAIGN_MEMORY', '1');
  f.db.exec('DROP TABLE campaign_memory_indexed');
  expect(retrieveCampaignMemory(f.db, f.campaignId, f.context)).toMatchObject({
    facts: [],
    diagnostics: { status: 'unavailable' },
  });
});

it('adds no correction or model request for generous references and historical context', async () => {
  const f = fixture();
  f.turn(1);
  f.context.sceneProtocol = true;
  f.context.retrievedMemory = retrieveCampaignMemory(f.db, f.campaignId, f.context);
  f.context.requestBudget = { used: 0, limit: 8 };
  const auth = { accessToken: async () => 'test' } as unknown as ChatGPTAuth;
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(init!.body as string);
    const input = JSON.parse(request.input[0].content);
    expect(input.retrievedMemory.facts[0].text).toContain('safe room');
    expect(request.instructions).toContain('A memory miss never blocks an action');
    const value = {
      version: 3,
      summary: 'Mira explains the deal.',
      beats: [
        {
          kind: 'meet',
          actor: input.members[0].id,
          person: { npcId: 'mechanic', name: 'Mira' },
          fact: 'Mira confirms the beacon repair is the condition for the room.',
          text: 'The archivist steps to the bench. Mira explains that repairing the beacon earns a safe room.',
        },
      ],
    };
    return new Response(
      `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] } })}\n\n`,
    );
  });
  const tools = Object.assign(vi.fn(), {
    validateAdjudication: (input: unknown) => validateAdjudication(f.context, input),
  }) as unknown as GameTools;
  const result = await new ChatGPTGM(auth, 'owner', 'test', fetcher).adjudicate(f.context, tools);
  expect(result.actions[0].status).toBe('success');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(f.context.requestBudget.corrections ?? []).toEqual([]);
});

it.each([false, true])(
  'freezes recall across interruption/restart (%s) and refreshes on a fresh turn',
  async (restart) => {
    const directory = mkdtempSync(join(tmpdir(), 'gather-memory-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const filename = join(directory, 'game.sqlite');
    let db = openDatabase(filename);
    cleanup.push(() => {
      if (db.open) db.close();
    });
    const practice = new PracticeGM();
    const contexts: GMContext[] = [];
    let interrupt = false;
    const provider = {
      adjudicate: async (context: GMContext, tools: GameTools) => {
        contexts.push(structuredClone(context));
        if (interrupt) {
          interrupt = false;
          throw new Error('Simulated interruption');
        }
        return practice.adjudicate(context, tools);
      },
      narrate: practice.narrate.bind(practice),
    };
    let game = new Game(db, () => provider);
    const host = game.identify();
    const config = fixture().context.config;
    const campaign = game.create(host.id, config);
    const player = game.identify();
    game.join(campaign.inviteCode!, player.id, game.saveCharacter(player.id, templateCharacter('Reader')).id);
    const member = game.members(campaign.id)[0];
    game.manageCharacter(campaign.id, player.id, {
      type: 'starter',
      itemIds: member.state.starterEquipment.slice(0, 3).map((item) => item.id),
    });
    game.start(campaign.id, host.id);
    await game.idle();
    let snapshot = game.snapshot(campaign.id, host.id);
    interrupt = true;
    game.submit(campaign.id, player.id, snapshot.turn!.id, 'Look around.', false);
    await game.idle();
    const frozen = contexts.at(-1)!.retrievedMemory;
    expect(frozen?.diagnostics.status).toBe('ok');
    vi.stubEnv('GATHER_CAMPAIGN_MEMORY', '0');
    if (restart) {
      db.close();
      db = openDatabase(filename);
      game = new Game(db, () => provider);
    }
    game.retry(campaign.id, host.id);
    await game.idle();
    expect(contexts.at(-1)!.retrievedMemory).toEqual(frozen);
    snapshot = game.snapshot(campaign.id, host.id);
    expect(snapshot.turn?.phase).toBe('collecting');
    expect(JSON.stringify(snapshot)).not.toContain('retrievedMemory');
    game.submit(campaign.id, player.id, snapshot.turn!.id, 'Look around.', false);
    await game.idle();
    expect(contexts.at(-1)!.retrievedMemory?.diagnostics.status).toBe('disabled');
  },
);
