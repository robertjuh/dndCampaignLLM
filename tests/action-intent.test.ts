import { expect, it } from 'vitest';
import { actionObligations, submittedActionObligations } from '../server/action-intent';
import type { GMContext } from '../server/game';

it('retains the recorded unchecked canal search separately from arrival', () => {
  const text = "Oke thanks boys I'm going to the city canal walk and search it";
  const obligations = actionObligations(text);
  expect(obligations).toEqual([{ kind: 'search', evidence: 'search it', index: 53, afterTravel: true }]);
  expect(text.slice(obligations[0].index)).toBe(obligations[0].evidence);
});

it.each([
  ['Go into the wreck interior and search around', 'search', 'search around'],
  ['I go to the dock to inspect the skiff markings', 'inspect', 'inspect the skiff markings'],
  ['I travel to ask the pilot where Tavi went', 'talk', 'ask the pilot where Tavi went'],
  ['Travel to meet the pilot', 'talk', 'meet the pilot'],
  ['Go downstairs, then examine the gate', 'inspect', 'examine the gate'],
  ['Enter the wreck and use my lamp', 'use', 'use my lamp'],
  ['Follow the caravan and collect the notice', 'collect', 'collect the notice'],
  ['Ik ga naar de markt en doorzoek het kraam', 'search', 'doorzoek het kraam'],
  ['Ik loop naar de aanlegsteiger en bekijk de markeringen', 'inspect', 'bekijk de markeringen'],
  ['Ik reis naar de tempel en praat met de priester', 'talk', 'praat met de priester'],
  ['Ik ga naar het plein en pak de brief', 'collect', 'pak de brief'],
])('preserves a concrete destination act: %s', (text, kind, evidence) => {
  expect(actionObligations(text)).toEqual([
    { kind, evidence, index: text.indexOf(evidence), afterTravel: true },
  ]);
});

it('keeps source interaction before departure distinct from a destination inspection', () => {
  expect(actionObligations('Take the notice and go to the court and inspect the seal')).toEqual([
    { kind: 'collect', evidence: 'Take the notice', index: 0, afterTravel: false },
    { kind: 'inspect', evidence: 'inspect the seal', index: 40, afterTravel: true },
  ]);
  expect(actionObligations('Meet the guide, then walk downstairs.')[0]).toMatchObject({
    kind: 'talk',
    afterTravel: false,
  });
});

it.each([
  'Go to the canal walk.',
  'I go look for the wreck.',
  'I walk towards the wreck, looking around as I go.',
  'I take the stairs and go to the market.',
  'I take a look around.',
  'I take cover.',
  'I pick up the pace and follow the caravan.',
  'Ik neem de trap en loop naar buiten.',
  'Ik zoek de weg naar de haven.',
  'I use the road to reach the canal.',
  'I follow the search party.',
  'I cry and wave goodbye to the pilot.',
  'I wait.',
  'I attack the warden.',
  'I say "go to the canal and search it".',
  "I say 'search Oren's tent' and go to the canal.",
  'The pilot says “inspect the wreck”. I walk to the canal.',
  "I don't search the wreck and inspect the hull.",
  'I will not collect the notice.',
  'I would search the wreck.',
  'If the guard leaves, I search the wreck.',
  'Ik doorzoek het wrak niet.',
  'Ik ga niet naar de markt en pak de brief.',
  'Als de bewaker weggaat, inspecteer ik de poort.',
])('leaves ambiguous, incidental, quoted and unsubmitted acts to the GM: %s', (text) => {
  expect(actionObligations(text)).toEqual([]);
});

it.each([
  ['Ask the mechanic if he knows where to search', 'talk'],
  ['I question the pilot about his search', 'talk'],
  ['I search for a use for the broken tool', 'search'],
  ["I don't search the wreck but I inspect the gate", 'inspect'],
  ['Ik inspecteer de poort maar pak geen brief', 'inspect'],
])('distinguishes questions and objects from extra player actions: %s', (text, kind) => {
  expect(actionObligations(text).map((obligation) => obligation.kind)).toEqual([kind]);
});

it('excludes server-owned passes and gathering travel without changing the submission', () => {
  const context = {
    turn: {
      actions: [
        { memberId: 'active', text: 'Search the wreck', passed: false },
        { memberId: 'pass', text: 'Search the wreck', passed: true },
        {
          memberId: 'gather',
          text: 'Travel to ask the pilot',
          passed: false,
          gathering: { locationId: 'dock' },
        },
      ],
    },
  } as GMContext;
  const before = structuredClone(context);
  expect(submittedActionObligations(context, 'active')).toHaveLength(1);
  for (const memberId of ['pass', 'gather', 'missing'])
    expect(submittedActionObligations(context, memberId)).toEqual([]);
  expect(context).toEqual(before);
});
