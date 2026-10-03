import { expect, it } from 'vitest';
import { assembleNarration, narrationBeats } from '../server/narration';
import type { GMContext } from '../server/game';
import { baseItem, initialScene, initialState } from '../shared/rules';
import { campaignSchema, maxNarrationLength, outcomeSchema, templateCharacter } from '../shared/schema';

function context(language: GMContext['config']['language'] = 'Nederlands'): GMContext {
  const members = ['Mira', 'Mara for Hire'].map((name, index) => {
    const character = templateCharacter(name);
    const id = `player-${index}`;
    return {
      id,
      playerId: id,
      playerName: name,
      characterId: id,
      character,
      active: true,
      state: initialState(character, id),
    };
  });
  return {
    config: campaignSchema.parse({
      name: 'Test',
      setting: 'Forest',
      premise: '',
      tone: '',
      language,
      instructions: '',
      custom: [],
      provider: 'practice',
    }),
    members,
    scene: initialScene('Forest'),
    history: [],
    journal: [],
    turn: {
      id: 'turn',
      number: 1,
      phase: 'resolving',
      roster: members.map((member) => member.id),
      actions: [
        {
          memberId: members[0].id,
          text: 'Onderzoek de poort.',
          passed: false,
          abilityName: 'Focus from Dawn',
        },
        { memberId: members[1].id, text: '', passed: true },
      ],
      rolls: [],
      result: null,
      error: null,
    },
  };
}

it.each(['Nederlands', 'English'] as const)(
  'uses %s for authoritative action, check, resource, condition and pass facts',
  (language) => {
    const gm = context(language);
    const [member, target] = gm.members;
    gm.turn.rolls = [
      {
        id: 'roll',
        memberId: member.id,
        stat: 'INT',
        dc: 10,
        reason: 'Onderzoek',
        mode: 'normal',
        lethal: false,
        abilityName: 'Focus from Dawn',
        dice: [1],
        modifier: 2,
        total: 3,
        success: false,
        critical: 'failure',
        source: 'test',
      },
    ];
    gm.resourceUses = [
      {
        memberId: member.id,
        itemId: 'potion',
        abilityName: null,
        sourceName: 'Potion with Hope',
        targetId: target.id,
        restored: 4,
        state: member.state,
        targetState: target.state,
      },
    ];
    const beats = narrationBeats(gm, gm.turn.rolls, [
      { type: 'hp', memberId: member.id, amount: -2, reason: 'Vallend puin.' },
      {
        type: 'condition',
        memberId: member.id,
        name: 'Bleeding',
        remove: false,
        reason: 'Een scherpe steen.',
      },
    ]);
    expect(beats.map((beat) => beat.id)).toEqual(['action:player-0', 'action:player-1']);
    const narration = assembleNarration('', beats, {});
    if (language === 'Nederlands') {
      expect(narration).toContain('Mira probeert: Onderzoek de poort. (met Focus from Dawn)');
      expect(narration).toContain(
        "Mira's INT check mislukt (3 tegen DC 10): natural 1, catastrofale mislukking.",
      );
      expect(narration).toContain('Mira gebruikt Focus from Dawn, waarbij de ability use wordt verbruikt.');
      expect(narration).toContain(
        'Mira gebruikt Potion with Hope, waarbij één item wordt verbruikt, en herstelt 4 HP bij Mara for Hire.',
      );
      expect(narration).toContain('Mira verliest 2 HP: Vallend puin.');
      expect(narration).toContain('Mira krijgt Bleeding: Een scherpe steen.');
      expect(narration).toContain('Mara for Hire wacht en onderneemt geen actie.');
      expect(narration).not.toMatch(/ attempts:| check fails| against DC | waits and takes no action/);
    } else {
      expect(narration).toContain('Mira attempts: Onderzoek de poort. (using Focus from Dawn)');
      expect(narration).toContain(
        "Mira's INT check fails (3 against DC 10): natural 1, catastrophic failure. Mira uses Focus from Dawn, spending its use.",
      );
      expect(narration).toContain(
        'Mira uses Potion with Hope, consuming one item, restoring 4 HP to Mara for Hire.',
      );
      expect(narration).toContain('Mira loses 2 HP: Vallend puin.');
      expect(narration).toContain('Mira gains Bleeding: Een scherpe steen.');
      expect(narration).toContain('Mara for Hire waits and takes no action.');
    }
  },
);

it('keeps Dutch combat facts in narration without model prose, preserving names, numbers and intent', () => {
  const gm = context();
  gm.members[0].state.equipment.left = baseItem('knife', 'Knife with advantage', 'weapon');
  gm.turn.actions[0].text = 'I move away from danger with my torch. '.repeat(20);
  const intent = gm.turn.actions[0].text.slice(0, 500);
  gm.turn.actions[0].characterName = 'Mira from Before';
  const logs = [
    'Mira from Before misses Mara for Hire with Knife with advantage.',
    'Mara for Hire critically hits Mira from Before for 8, downing Mira from Before.',
    'Mira from Before is stunned and loses their main action.',
    `Mira from Before carries out their movement: ${intent}`,
    "Mira from Before's minor action has no effect: This healing item is incompatible with your character. The minor action is spent.",
    'Mara for Hire uses a healing consumable on Mira from Before, helping them up.',
    'Victory. Each surviving character gains 30 XP. A physical item must be offered as loot.',
  ];
  gm.combatResult = {
    logs,
    encounter: { enemies: [], initiative: [], round: 2, victory: true, escaped: false },
    characters: gm.members.map((member) => ({
      id: member.id,
      name: member.character.name,
      state: member.state,
    })),
    loot: [],
  };
  const beats = narrationBeats(gm);
  expect(beats.map((beat) => beat.id)).toEqual(logs.map((_, index) => `combat:${index}`));
  expect(beats.map((beat) => beat.fact)).toEqual([
    'Mira from Before mist Mara for Hire met Knife with advantage.',
    'Mara for Hire geeft een critical hit aan Mira from Before voor 8, waardoor dit personage Downed raakt: Mira from Before.',
    'Mira from Before is Stunned en verliest de main action.',
    `Mira from Before voert de verplaatsing uit: ${intent}`,
    "Mira from Before's minor action heeft geen effect: Dit healing item is niet geschikt voor het personage. De minor action is verbruikt.",
    'Mara for Hire gebruikt een healing consumable bij Mira from Before, waardoor dit personage weer overeind komt.',
    'Overwinning. Elk overlevend personage krijgt 30 XP. Een fysiek item moet als loot worden aangeboden.',
  ]);
  const fallback = assembleNarration('', beats, undefined);
  expect(fallback).toBe(beats.map((beat) => beat.fact).join('\n\n'));
  gm.config.language = 'English';
  expect(narrationBeats(gm).map((beat) => beat.fact)).toEqual(logs);
});

it('keeps every recorded outcome when atmosphere and event prose exhaust the narration budget', () => {
  const beats = Array.from({ length: 60 }, (_, index) => ({
    id: `combat:${index}`,
    fact: `Character ${index} misses their enemy with their weapon.`,
  }));
  const prose = Object.fromEntries(
    beats.map((beat) => [beat.id, `${beat.fact} ${'Dust and sparks fill the room. '.repeat(100)}`]),
  );
  prose['combat:unknown'] = 'An invented action.';
  const narration = assembleNarration('Atmosphere. '.repeat(1800), beats, prose);
  expect(narration.length).toBeLessThanOrEqual(maxNarrationLength);
  for (const beat of beats) expect(narration).toContain(beat.fact);
  expect(narration).not.toContain('An invented action.');
  expect(narration.indexOf(beats[59].fact)).toBeGreaterThan(narration.indexOf(beats[0].fact));
  expect(
    outcomeSchema.safeParse({ narration, summary: 'A round.', choices: [], changes: [], journal: [] })
      .success,
  ).toBe(true);
});

it.each([
  {
    id: 'combat:0',
    fact: 'Mara Vex misses Grot Bomb-Sapper with her knife.',
    prose: 'Mara lunges through the smoke with her knife.',
  },
  {
    id: 'action:player',
    fact: "Mira attempts: Inspect the gate. Mira's INT check fails (1 against DC 10): natural 1, catastrophic failure.",
    prose: 'Mira traces the gate’s symbols with her fingertips.',
  },
])('keeps the recorded failure when nonblank prose omits it ($id)', ({ id, fact, prose }) => {
  const narration = assembleNarration('', [{ id, fact }], { [id]: prose });
  expect(narration).toContain(fact);
  expect(narration).toContain(prose);
});

it('prioritizes detailed player outcomes over an introduction that fills the budget', () => {
  const beat = { id: 'combat:0', fact: 'Mara Vex misses Grot Bomb-Sapper with her knife.' };
  const prose =
    'Mara lunges through the smoke with her knife, but the sapper ducks beneath her swing. Her attack misses.';
  const intro = 'A'.repeat(maxNarrationLength - beat.fact.length - 2);
  const narration = assembleNarration(intro, [beat], { [beat.id]: prose });
  expect(narration).toContain(beat.fact);
  expect(narration.includes(prose)).toBe(true);
  expect(narration.length).toBeLessThanOrEqual(maxNarrationLength);
});
