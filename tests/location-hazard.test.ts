import { expect, it } from 'vitest';
import { locationHazard } from '../shared/locations';

it('omits all-clear filler while preserving concrete hazards', () => {
  for (const text of [
    undefined,
    '',
    '   ',
    'None.',
    'No immediate threat is apparent.',
    '  No known hazards.  ',
    'There are no visible dangers.',
    'No immediate violence or active hazard is evident.',
    'Geen direct gevaar zichtbaar.',
    'Er is geen onmiddellijke dreiging aanwezig.',
  ])
    expect(locationHazard(text), String(text)).toBe('');

  for (const text of [
    'Loose stones along the roadside.',
    'No shelter from the acid rain.',
    'No guards remain to hold back the wolves.',
    'No immediate threat is apparent, but the bridge is unstable.',
    'Geen beschutting tegen de zure regen.',
  ])
    expect(locationHazard(text)).toBe(text);

  expect(locationHazard('Slippery quay edges; no immediate threat is evident.')).toBe('Slippery quay edges.');
  expect(
    locationHazard('Heavy carts share the road. No immediate violence or active threat is evident.'),
  ).toBe('Heavy carts share the road.');
  expect(locationHazard('Heavy wagon traffic, but no immediate threat is apparent.')).toBe(
    'Heavy wagon traffic.',
  );
  expect(locationHazard('No immediate threat is apparent. Loose stones line the roadside.')).toBe(
    'Loose stones line the roadside.',
  );
  expect(locationHazard('Gladde stenen; er is geen direct gevaar zichtbaar.')).toBe('Gladde stenen.');
});
