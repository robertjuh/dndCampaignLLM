import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import saved from './fixtures/akoedabar-search.json';
import { compileSceneTurn, type SceneTurn } from '../server/scene-turn';
import { applyNPCUpdates } from '../server/npcs';
import { initialState } from '../shared/rules';
import { memberScene } from '../shared/locations';
import { templateCharacter, type Scene } from '../shared/schema';
import { gmMemorySchema } from '../shared/gm-memory';
import type { GMContext } from '../server/game';

function fixture(): GMContext {
  const members = saved.members.map((member) => {
    const character = { ...templateCharacter(member.name), stats: member.stats };
    return {
      id: member.id, character, characterId: randomUUID(), playerId: randomUUID(),
      playerName: member.name, active: true, state: initialState(character, member.id),
    };
  });
  return {
    sceneProtocol: true, members, startingMembers: structuredClone(members),
    scene: structuredClone(saved.scene) as Scene, journal: [], history: [], receipts: {}, gmMemory: [],
    config: {
      ruleset: 'roguelike-v1', name: 'Recorded playtest', setting: 'Hillys', premise: '',
      tone: '', instructions: '', language: 'English', custom: [], provider: 'practice', model: '',
    },
    turn: {
      id: randomUUID(), number: 8, phase: 'resolving', roster: members.map((member) => member.id),
      actions: members.map((member) => ({ memberId: member.id, text: '', passed: true })),
      rolls: [], result: null, error: null,
    },
  };
}

it('preserves the recorded unchecked canal search and its destination order', () => {
  const context = fixture();
  const actor = context.members[0].id;
  const [docks, canal] = ['Hillys City Landing Docks', 'Hillys City Canal Walk'].map((name) =>
    Object.values(context.scene.worldMap!.nodes).find((node) => node.name === name)!.id,
  );
  context.scene.memberLocations![actor] = docks;
  context.turn.actions[0] = {
    memberId: actor, text: "Oke thanks boys I'm going to the city canal walk and search it", passed: false,
  };
  const move: SceneTurn['beats'][number] = {
    kind: 'move', actor, to: canal,
    fact: 'Sofa king reaches the Canal Walk.', text: 'Sofa king climbs the stairway to the Canal Walk.',
  };
  const search: SceneTurn['beats'][number] = {
    kind: 'act', actor, slot: 'main', intent: 'search',
    fact: 'Sofa king finds the canal-side delivery schedules.',
    text: 'A delivery schedule posted beside the rail identifies the regular skiff stops.',
    finding: { source: 'canal-delivery-schedule', fact: 'A public schedule identifies the regular skiff stops.' },
  };
  const scene = (beats: SceneTurn['beats']): SceneTurn => ({ version: 3, notes: [], summary: 'Canal arrival.', beats });
  expect(() => compileSceneTurn(context, scene([move]))).toThrow('submitted search');
  expect(() => compileSceneTurn(context, scene([search, move]))).toThrow('AFTER ordinary arrival');
  const complete = compileSceneTurn(context, scene([move, search]));
  expect(complete.actions[0].components).toMatchObject({
    movement: { status: 'success', basis: 'routine' }, main: { status: 'success', basis: 'routine' },
  });
  expect(complete.actions[0].search?.locationId).toBe(canal);
  expect(context.turn.rolls).toEqual([]);
});

it('requires a persistent conversation partner and reuses their role identity', () => {
  const context = fixture();
  const actor = context.members[0].id;
  context.turn.actions[0] = { memberId: actor, text: 'Ask the pilot about the skiff.', passed: false };
  const bare: SceneTurn = {
    version: 3, notes: [], summary: 'The pilot answers.', beats: [{
      kind: 'act', actor, slot: 'main', intent: 'action',
      fact: 'The Canal Walk pilot identifies the skiff markings.', text: 'The pilot describes the blue skiff markings.',
    }],
  };
  expect(() => compileSceneTurn(context, bare)).toThrow('Persist the person');
  const first = structuredClone(bare);
  first.beats = [{
    kind: 'meet', actor,
    person: { npcId: 'canal-pilot', name: 'Canal Walk pilot', aliases: ['pilot'] },
    fact: 'The Canal Walk pilot identifies the blue-striped skiff.', text: 'The pilot describes the blue skiff markings.',
  }];
  applyNPCUpdates(context.scene, compileSceneTurn(context, first), (ref) => ref);
  const later = structuredClone(bare);
  later.beats = [{
    kind: 'meet', actor, person: { npcId: 'another-pilot-id', name: '  Canal   Walk pilot ' },
    fact: 'The Canal Walk pilot recognizes Sofa king and confirms the skiff markings.',
    text: 'The same pilot recognizes Sofa king and confirms the markings.',
  }];
  applyNPCUpdates(context.scene, compileSceneTurn(context, later), (ref) => ref);
  expect(Object.keys(context.scene.npcs!)).toEqual(['canal-pilot']);
  expect(context.scene.npcs!['canal-pilot'].locationId).toBe(memberScene(context.scene, actor).location.id);
});

it('keeps both split-party outcomes in the summary and narrates the saved finding once', () => {
  const context = fixture();
  context.turn = { ...context.turn, ...structuredClone(saved.turn) } as GMContext['turn'];
  context.receipts = structuredClone(saved.receipts);
  context.gmMemory = gmMemorySchema.parse(saved.gmMemory);
  const finding = context.receipts![`investigation:${context.members[0].id}`] as {
    finding: { narrativeVersion?: 1; text: string; fact: string; lead: string };
  };
  finding.finding.narrativeVersion = 1;
  finding.finding.text = `${finding.finding.text} The witness at the Landing Docks can describe the skiff.`;
  const response = structuredClone(saved.response) as SceneTurn;
  const move = response.beats[1];
  if (move.kind !== 'move') throw new Error('Expected the saved wreck arrival.');
  move.fact = 'Lobsterano enters the wreck interior.';
  move.text = 'Lobsterano slips through the stern gap.';
  move.place!.deadEnd = 'The hull encloses this compartment; the stern gap is its only exit.';
  response.beats[0] = {
    kind: 'act', actor: context.members[0].id, slot: 'main', intent: 'search',
    fact: 'The Canal Walk pilot describes the blue-striped skiff.', text: 'The pilot answers.',
    npcs: [{ npcId: 'canal-pilot', name: 'Canal Walk pilot' }],
  };
  response.beats.push({
    kind: 'act', actor: context.members[1].id, slot: 'main', intent: 'search',
    fact: 'Lobsterano finds the Mammago Salvage Tool Case.',
    text: 'Lobsterano finds the Mammago Salvage Tool Case behind a loose panel.',
    finding: { source: 'wreck-interior:tool-case', fact: 'The missing case lies behind a loose panel.' },
  });
  const value = compileSceneTurn(context, response);
  expect(value.sceneDraft!.summary).toContain('Lobsterano finds');
  expect(value.sceneDraft!.summary).toContain('pilot');
  expect(value.sceneDraft!.passages.filter((passage) => passage.text.includes('Scene loot is available'))).toEqual([]);
  const prose = value.sceneDraft!.passages.map((passage) => passage.text).join('\n');
  expect(prose).not.toContain(finding.finding.fact);
  expect(prose.match(/The witness at the Landing Docks can describe the skiff/g)).toHaveLength(1);
  expect(value.journal.some((entry) => entry.detail.includes(finding.finding.fact))).toBe(true);
  // Another character's ordinary travel cannot make a repeated answer rewardable.
  (context.receipts![`investigation:${context.members[0].id}`] as { reused: boolean }).reused = true;
  delete context.receipts!.executionEvents;
  delete context.receipts!.loot;
  context.turn.rolls = [];
  context.turn.actions[1].text = 'Go into the wreck interior.';
  response.beats.pop();
  response.rewards = { xp: 30, reason: 'The same answer was repeated.' };
  expect(compileSceneTurn(context, response).rewards.xp).toBe(0);
});
