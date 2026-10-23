import { expect, it } from 'vitest';
import { bindNPCSource } from '../server/npcs';
import { initialScene } from '../shared/rules';
import { ensureLocations } from '../shared/locations';
import { findNPC } from '../shared/npcs';

it('introduces an unnamed witness by stable public role and reuses the saved person through an alias', () => {
  const scene = ensureLocations(initialScene('Canal workshop'), []);
  const at = scene.location.id!;
  const first = bindNPCSource(scene, {
    id: 'new:canal-mechanic',
    name: 'Canal workshop mechanic',
    aliases: ['Mammago mechanic'],
    description: 'The mechanic repairs the canal workshop engines and seeks a missing tool case.',
  }, at);
  expect(first.isNew).toBe(true);
  expect(first.npc).toMatchObject({
    id: 'new:canal-mechanic',
    name: 'Canal workshop mechanic',
    status: 'alive',
    locationId: at,
  });
  // Binding is pure: only a successfully published observed exchange saves the person.
  expect(scene.npcs).toBeUndefined();
  scene.npcs = { [first.id]: first.npc };
  const again = bindNPCSource(scene, {
    id: 'new:another-mechanic-id',
    name: '  MAMMAGO   mechanic ',
    description: 'A differently worded description must not replace a saved person.',
  }, at);
  expect(again.isNew).toBe(false);
  expect(again.id).toBe(first.id);
  expect(again.npc).toEqual(first.npc);
  expect(findNPC(scene, 'MAMMAGO   mechanic')?.id).toBe(first.id);
});

it('cannot turn a remote or dead saved witness into a new local person', () => {
  const scene = ensureLocations(initialScene('Canal workshop'), []);
  const at = scene.location.id!;
  const person = bindNPCSource(scene, {
    id: 'new:pilot', name: 'Canal landing pilot', description: 'The pilot saw the marked skiff.',
  }, at);
  scene.npcs = { [person.id]: person.npc };
  expect(() => bindNPCSource(scene, {
    id: 'new:replacement', name: person.name, description: 'A supposedly different pilot.',
  }, 'elsewhere')).toThrow(/another location/);
  scene.npcs[person.id].status = 'dead';
  expect(() => bindNPCSource(scene, { id: person.id }, at)).toThrow(/dead NPC/);
});

it('requires an explicit introduction and refuses ambiguous person aliases', () => {
  const scene = ensureLocations(initialScene('Canal workshop'), []);
  const at = scene.location.id!;
  expect(() => bindNPCSource(scene, { id: 'new:witness', name: 'Witness' }, at)).toThrow(/description/);
  expect(() => bindNPCSource(scene, {
    id: 'invented-id', name: 'Witness', description: 'A person waiting here.',
  }, at)).toThrow(/new:/);
  const left = bindNPCSource(scene, {
    id: 'new:left', name: 'East landing pilot', aliases: ['Pilot'], description: 'An east landing pilot.',
  }, at).npc;
  const right = { ...left, id: 'new:right', name: 'West landing pilot' };
  scene.npcs = { [left.id]: left, [right.id]: right };
  expect(() => bindNPCSource(scene, {
    id: 'new:third', name: 'Pilot', description: 'A pilot.',
  }, at)).toThrow(/merge two established people/);
});
