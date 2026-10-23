import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { GMContext } from '../server/game';
import type { Investigation, InvestigationResult } from '../shared/investigation';
import { initialScene, initialState } from '../shared/rules';
import { templateCharacter } from '../shared/schema';
import { bindNPCSource } from '../server/npcs';
import {
  bindInvestigationSource,
  investigationFact,
  investigationNarration,
  knownInvestigationAnswer,
  validateInvestigationLeads,
} from '../server/investigations';

function context(): GMContext {
  const character = templateCharacter('Sofa king');
  const id = randomUUID();
  return {
    config: {
      ruleset: 'roguelike-v1',
      name: 'Canal',
      setting: 'A canal city',
      premise: 'Find the missing skiff.',
      tone: 'Adventure',
      language: 'English',
      instructions: '',
      custom: [],
      provider: 'practice',
      model: '',
    },
    members: [
      {
        id,
        playerId: randomUUID(),
        playerName: 'Sofa king',
        characterId: randomUUID(),
        character,
        state: initialState(character, id),
        active: true,
      },
    ],
    scene: {
      ...initialScene('Canal'),
      location: { id: 'canal', name: 'Canal', atmosphere: 'A busy canal.', hazard: '' },
      memberLocations: { [id]: 'canal' },
      places: {
        landing: {
          location: { id: 'landing', name: 'Landing', atmosphere: 'A low landing.', hazard: '' },
          encounter: null,
          loot: [],
        },
      },
      worldMap: {
        nodes: {
          canal: { id: 'canal', name: 'Canal', visited: true },
          landing: { id: 'landing', name: 'Landing', visited: true },
        },
        connections: [
          { from: 'canal', to: 'landing', label: 'Towpath', bidirectional: true, blocked: false },
        ],
      },
    },
    gmMemory: [],
    journal: [],
    history: [],
    receipts: {},
    turn: {
      id: randomUUID(),
      number: 7,
      phase: 'resolving',
      roster: [id],
      actions: [{ memberId: id, text: 'Ask the canal pilot about the skiff.', passed: false }],
      rolls: [],
      result: null,
      error: null,
    },
  };
}

function receipt(ctx: GMContext): InvestigationResult {
  return {
    memberId: ctx.members[0].id,
    source: { kind: 'feature', id: 'skiff-marking', name: 'Skiff marking', locationId: 'canal' },
    question: 'Who owns the skiff?',
    thread: 'premise',
    hookId: 'skiff-owner',
    answer: 0,
    signature: 'unchanged',
    success: true,
    reused: false,
    actionFact: 'The marking identifies the skiff.',
    finding: {
      fact: 'The skiff belongs to Tavi.',
      text: 'The fresh marking is Tavi’s; his mooring is at the landing.',
      lead: 'Tavi’s mooring is at the landing.',
      leadLocationId: 'landing',
      narrativeVersion: 1,
    },
  };
}

it('recognizes a successful answer across hooks and sources without treating hidden or failed answers as known', () => {
  const ctx = context();
  const found = receipt(ctx);
  ctx.gmMemory = [
    {
      id: 'different-hook',
      locationId: 'canal',
      cause: 'A smuggler repainted the boat.',
      discoveries: [found.finding.fact],
      actors: 'Tavi',
      nextChange: 'The boat departs.',
      dueTurn: 9,
      status: 'open',
    },
  ];
  expect(knownInvestigationAnswer(ctx, found.finding.fact)).toBe(false);
  ctx.receipts = { [`investigation:${found.memberId}`]: { ...found, success: false } };
  expect(knownInvestigationAnswer(ctx, found.finding.fact)).toBe(false);
  ctx.receipts = { [`investigation:${found.memberId}`]: found };
  expect(knownInvestigationAnswer(ctx, 'THE SKIFF BELONGS TO TAVI!')).toBe(true);
  expect(knownInvestigationAnswer(ctx, 'The skiff belongs to Tavia.')).toBe(false);
  ctx.receipts = {};
  ctx.gmMemory[0].revealed = [0];
  expect(knownInvestigationAnswer(ctx, found.finding.fact)).toBe(true);
});

it('remembers completed successful evidence after its note was pruned, while preserving failed attempts', () => {
  const ctx = context();
  const result = receipt(ctx);
  const investigation = {
    hookId: result.hookId,
    answer: 0,
    signature: result.signature,
    success: false,
    question: result.question,
    text: result.finding.text,
    lead: result.finding.lead,
    leadLocationId: 'landing',
  };
  ctx.scene.searches = {
    'skiff-marking': {
      information: investigationFact(result.finding),
      rewardRolled: false,
      investigation,
      attempts: { original: { information: investigationFact(result.finding), investigation } },
    },
  };
  expect(knownInvestigationAnswer(ctx, result.finding.fact)).toBe(false);
  ctx.scene.searches['skiff-marking'].attempts!.original.investigation.success = true;
  expect(knownInvestigationAnswer(ctx, result.finding.fact)).toBe(true);
});

it('checks the actual location of an explicitly referenced lead in both prepared branches', () => {
  const ctx = context();
  ctx.scene.npcs = {
    tavi: {
      id: 'tavi',
      name: 'Tavi',
      aliases: [],
      locationId: 'landing',
      status: 'alive',
      allegiance: null,
      fact: 'Tavi moors his boat at the landing.',
    },
  };
  const source = { kind: 'place' as const, id: 'canal', locationId: 'canal' };
  const lead = {
    fact: 'Tavi can identify the marking.',
    locationId: 'canal',
    source: { kind: 'npc' as const, id: 'tavi' },
  };
  const request: Pick<Investigation, 'success' | 'failure'> = {
    success: { text: 'The marking is legible.', lead: { ...lead, locationId: 'landing' } },
    failure: { fact: 'The marking is worn.', text: 'Tavi may recognize it.', lead },
  };
  expect(() => validateInvestigationLeads(ctx, request, source)).toThrow('Tavi is at another location');
  request.failure.lead.locationId = 'landing';
  expect(() => validateInvestigationLeads(ctx, request, source)).not.toThrow();
  request.success.lead.source!.id = 'invented-person';
  expect(() => validateInvestigationLeads(ctx, request, source)).toThrow('saved person');
  request.success.lead.source = undefined;
  request.success.lead.locationId = 'remote-vault';
  expect(() => validateInvestigationLeads(ctx, request, source)).toThrow('open adjacent route');
});

it('introduces a persistent person as an investigation source and reuses their saved role identity', () => {
  const ctx = context();
  const input = {
    kind: 'npc' as const,
    id: 'new:canal-pilot',
    name: 'Canal pilot',
    description: 'The pilot tends a battered hovercraft by the canal.',
    locationId: 'canal',
  };
  const bound = bindInvestigationSource(ctx, ctx.members[0].id, input);
  expect(bound.introduced).toBe(true);
  expect(bound.source).toMatchObject({
    kind: input.kind,
    id: input.id,
    name: input.name,
    locationId: input.locationId,
  });
  expect(bound.source.description).toContain(input.description);
  expect(ctx.scene.npcs).toBeUndefined();
  ctx.scene.npcs = {
    pilot: {
      id: 'pilot',
      name: 'Bram',
      aliases: ['Canal pilot'],
      locationId: 'canal',
      status: 'alive',
      allegiance: null,
      fact: input.description,
    },
  };
  expect(bindInvestigationSource(ctx, ctx.members[0].id, input)).toMatchObject({
    introduced: false,
    source: { id: 'pilot', name: 'Bram' },
  });
  ctx.scene.npcs.pilot.locationId = 'landing';
  expect(() => bindInvestigationSource(ctx, ctx.members[0].id, input)).toThrow(/another location|actually/);
});

it('shares a person introduced by another selected investigation receipt before publication, including a failed interview', () => {
  const ctx = context();
  const input = {
    kind: 'npc' as const,
    id: 'new:canal-pilot',
    name: 'Canal pilot',
    description: 'The pilot tends a battered hovercraft by the canal.',
    locationId: 'canal',
  };
  const first = bindInvestigationSource(ctx, ctx.members[0].id, input);
  ctx.receipts = {
    'investigation:earlier-player': {
      ...receipt(ctx),
      source: first.source,
      signature: first.signature,
      success: false,
    },
  };
  const second = bindInvestigationSource(ctx, ctx.members[0].id, { ...input, id: 'new:other-pilot-id' });
  expect(second.source.id).toBe(first.source.id);
  expect(second.signature).toBe(first.signature);
  expect(second.source.description).toBe(first.source.description);
  // Either character may be narrated first without changing the introduced person's fact.
  expect(bindNPCSource(ctx.scene, second.source, 'canal').npc).toEqual(
    bindNPCSource(ctx.scene, first.source, 'canal').npc,
  );
  const reversed = structuredClone(ctx.scene);
  for (const source of [second.source, first.source]) {
    const person = bindNPCSource(reversed, source, source.locationId);
    (reversed.npcs ??= {})[person.id] = person.npc;
  }
  expect(reversed.npcs![first.source.id].fact).toBe(`${input.name}. ${input.description}`);
  expect(second.introduced).toBe(false);
  expect(ctx.scene.npcs).toBeUndefined();
});

it('renders finished investigation prose once and keeps durable facts separate, including legacy receipts', () => {
  const finding = receipt(context()).finding;
  expect(investigationNarration(finding)).toBe(finding.text);
  expect(investigationFact(finding)).toBe(`${finding.fact}\n${finding.lead}`);
  const legacy = { ...finding, narrativeVersion: undefined, text: 'The marking belongs to Tavi.' };
  expect(investigationNarration(legacy)).toBe(`${legacy.text}\n${legacy.lead}`);
  legacy.text += '\nTAVI’S MOORING IS AT THE LANDING!';
  expect(investigationNarration(legacy)).toBe(legacy.text);
});
