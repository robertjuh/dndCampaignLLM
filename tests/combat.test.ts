import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normalizeCombatInput } from '../server/combat';
import { requestedAbility, requestedConsumable } from '../server/action-resources';
import type { GMContext } from '../server/game';
import { baseItem, equip, initialScene, initialState, runCombat } from '../shared/rules';
import { enemySchema, templateCharacter, type Member } from '../shared/schema';

function fixture(text = 'Attack the enemy'): GMContext {
  const members = ['Mara Vex', 'Krail Venn'].map((name): Member => {
    const character = templateCharacter(name);
    const id = randomUUID();
    return {
      id,
      playerId: randomUUID(),
      playerName: name,
      characterId: randomUUID(),
      character,
      state: initialState(character, id),
      active: true,
    };
  });
  const [member] = members;
  const knife = { ...baseItem('knife', 'Knife', 'weapon'), scaling: ['DEX' as const], damage: '1d6' };
  member.state.inventory.push({ ...knife, quantity: 1 });
  equip(member.character, member.state, knife.id, 'left');
  const scene = initialScene('A starship');
  const enemies = ['Ork Breachmob', 'Violet Vox-Herald'].map((name, index) => ({
    ...enemySchema.parse({
      id: `enemy-${index}`,
      name,
      tier: 'normal',
      hp: 30,
      defense: 10,
      attack: 0,
      damage: '1d4',
      description: '',
      tactic: '',
    }),
    maxHp: 30,
    initiative: 1,
  }));
  scene.encounter = {
    enemies,
    round: 1,
    victory: false,
    escaped: false,
    initiative: [
      ...members.map((member) => ({ id: member.id, total: 15 })),
      ...enemies.map((enemy) => ({ id: enemy.id, total: 1 })),
    ],
  };
  return {
    config: {
      ruleset: 'roguelike-v1',
      name: 'Test',
      setting: 'A starship',
      premise: '',
      tone: '',
      language: 'English',
      instructions: '',
      custom: [],
      provider: 'practice',
      model: '',
    },
    members,
    scene,
    history: [],
    journal: [],
    turn: {
      id: randomUUID(),
      number: 1,
      phase: 'queued',
      roster: members.map((member) => member.id),
      actions: [{ memberId: member.id, text, passed: false }],
      rolls: [],
      result: null,
      error: null,
    },
  };
}

describe('server combat interpretation defaults', () => {
  it('uses the campaign language for fallback loot while preserving enemy and biome names', () => {
    const context = fixture();
    context.scene.floor.biome = 'Glass Forest';
    expect(normalizeCombatInput(context).loot).toMatchObject({
      name: 'Salvage from Ork Breachmob',
      description: 'Recovered in Glass Forest.',
    });
    context.config.language = 'Nederlands';
    expect(normalizeCombatInput(context, { loot: null }).loot).toMatchObject({
      name: 'Buit van Ork Breachmob',
      description: 'Gevonden in Glass Forest.',
      kind: 'relic',
    });
  });
  it('targets downed allies outside the action roster with healer-owned items or selected Mend', () => {
    for (const mode of ['item', 'ability']) {
      const context = fixture('Heal Krail Venn with my healing item');
      const [healer, ally] = context.members;
      ally.state.hp = 0;
      ally.state.conditions.push('Downed');
      context.turn.roster = [healer.id];
      context.scene.encounter!.initiative = context.scene.encounter!.initiative.filter(
        (actor) => actor.id === healer.id || actor.id === ally.id,
      );
      if (mode === 'ability') {
        const mend = { ...healer.character.abilities[0], name: 'Field mend', effect: 'mend' as const };
        healer.character.abilities.push(mend);
        context.turn.actions[0].abilityName = mend.name;
        context.turn.actions[0].text = 'Use Field mend to help Krail Venn up';
      }
      const plan = normalizeCombatInput(context);
      expect(plan.actions).toHaveLength(1);
      expect(plan.actions[0]).toMatchObject(
        mode === 'item'
          ? {
              main: 'interact',
              minor: 'heal',
              minorTargetId: ally.id,
              minorItemId: healer.state.inventory.find((item) => item.healing > 0)!.id,
            }
          : { main: 'ability', targetId: ally.id, minor: 'none' },
      );
      runCombat(context.members, context.scene.encounter!, plan, () => 4);
      expect(ally.state.hp).toBeGreaterThan(0);
      expect(ally.state.conditions).not.toContain('Downed');
    }
  });

  it('resolves vague and malformed proposals with an equipped normal attack', () => {
    const context = fixture(
      'Mara: attack, defend, or use Boarding-Action Lunge. Found box with pulse rifles',
    );
    const before = structuredClone(context);
    for (const proposal of [
      undefined,
      null,
      'not JSON',
      { actions: [{}], loot: null },
      { actions: [{ memberId: context.members[0].id, main: 'invalid', stat: 'CHA', minor: 'invented' }] },
    ]) {
      const plan = normalizeCombatInput(context, proposal);
      expect(plan.actions[0]).toMatchObject({
        main: 'attack',
        abilityName: null,
        weaponSlot: 'left',
        stat: 'DEX',
        targetId: 'enemy-0',
        minor: 'none',
      });
      expect(context).toEqual(before);
      const copy = structuredClone(context);
      expect(
        runCombat(copy.members, copy.scene.encounter!, plan, () => 12).some((log) =>
          log.includes('with Knife'),
        ),
      ).toBe(true);
    }
  });

  it('preserves the exact selected ability and stat despite a conflicting plan', () => {
    const context = fixture('Use Focused strike on the Violet Vox-Herald');
    context.turn.actions[0].abilityName = 'Focused strike';
    const plan = normalizeCombatInput(context, {
      actions: [
        {
          memberId: context.members[0].id,
          main: 'attack',
          abilityName: 'Invented ability',
          stat: 'INT',
          targetId: 'enemy-0',
        },
      ],
    });
    expect(plan.actions[0]).toMatchObject({
      main: 'ability',
      abilityName: 'Focused strike',
      stat: 'STR',
      targetId: 'enemy-1',
    });
  });

  it('does not consume an unselected ability named by the model', () => {
    const context = fixture('Attack');
    const plan = normalizeCombatInput(context, {
      actions: [{ memberId: context.members[0].id, main: 'ability', abilityName: 'Focused strike' }],
    });
    expect(plan.actions[0]).toMatchObject({ main: 'attack', abilityName: null, weaponSlot: 'left' });
  });

  it('uses a named combat ability without a UI selection despite an ordinary attack proposal', () => {
    const context = fixture('Use the CROSS SLASH ability on the Violet Vox-Herald');
    const member = context.members[0];
    const ability = member.character.abilities[0];
    ability.name = 'Cross slash';
    ability.stat = 'INT';
    const plan = normalizeCombatInput(context, {
      actions: [{ memberId: member.id, main: 'attack', abilityName: 'Invented ability', stat: 'DEX' }],
    });
    expect(plan.actions[0]).toMatchObject({
      main: 'ability',
      abilityName: ability.name,
      stat: ability.stat,
      targetId: 'enemy-1',
    });
    runCombat(context.members, context.scene.encounter!, plan, (sides) => (sides === 20 ? 12 : 2));
    expect(member.state.abilityUses?.[ability.name]).toBe(1);
    expect(context.scene.encounter!.enemies[1].hp).toBeLessThan(30);
    expect(normalizeCombatInput(context).actions[0].abilityName).toBe(ability.name);
    expect(() => runCombat(context.members, context.scene.encounter!, plan, () => 12)).toThrow(
      'That ability has already been used.',
    );
  });

  it('lets the model choose an owned ability for a generic request and spends only that use', () => {
    const context = fixture('I use my special move on the Violet Vox-Herald');
    const member = context.members[0];
    const ability = { ...member.character.abilities[0], name: 'Cross slash', stat: 'DEX' as const };
    member.character.abilities.push(ability);
    const plan = normalizeCombatInput(context, {
      actions: [{ memberId: member.id, main: 'ability', abilityName: ability.name, stat: 'INT' }],
    });
    expect(plan.actions[0]).toMatchObject({
      main: 'ability',
      abilityName: ability.name,
      stat: 'DEX',
      targetId: 'enemy-1',
    });
    runCombat(context.members, context.scene.encounter!, plan, (sides) => (sides === 20 ? 12 : 2));
    expect(member.state.abilityUses?.[ability.name]).toBe(1);
    expect(member.state.abilityUses?.['Focused strike']).toBeUndefined();
  });

  it.each(['Use my ability', 'Ik gebruik mijn vaardigheid', 'I fight with my power'])(
    'uses the sole combat ability for %j without a model proposal',
    (text) => {
      const context = fixture(text);
      expect(normalizeCombatInput(context).actions[0]).toMatchObject({
        main: 'ability',
        abilityName: 'Focused strike',
        stat: 'STR',
      });
    },
  );

  it('keeps a generic ability alternative optional until the model chooses it', () => {
    const context = fixture('Attack, defend, or use my special ability');
    const member = context.members[0];
    expect(normalizeCombatInput(context).actions[0]).toMatchObject({
      main: 'attack',
      abilityName: null,
    });
    expect(
      normalizeCombatInput(context, { actions: [{ memberId: member.id, main: 'defend' }] }).actions[0],
    ).toMatchObject({ main: 'defend', abilityName: null });
    expect(
      normalizeCombatInput(context, {
        actions: [{ memberId: member.id, main: 'ability', abilityName: 'Focused strike' }],
      }).actions[0],
    ).toMatchObject({ main: 'ability', abilityName: 'Focused strike' });
  });

  it('preserves explicit UI priority and rejects passes, refusals and named abilities of another kind', () => {
    const context = fixture('Use my Fieldcraft ability');
    const member = context.members[0];
    const utility = member.character.abilities.find((ability) => ability.kind === 'utility')!;
    utility.name = 'Fieldcraft';
    const submitted = context.turn.actions[0];
    expect(requestedAbility(member.character, submitted, 'combat', 'Focused strike')).toBeUndefined();
    submitted.text = "I don't use Focused strike; I defend";
    expect(requestedAbility(member.character, submitted, 'combat', 'Focused strike')).toBeUndefined();
    submitted.abilityName = 'Focused strike';
    expect(requestedAbility(member.character, submitted, 'combat')?.name).toBe('Focused strike');
    submitted.passed = true;
    expect(requestedAbility(member.character, submitted, 'combat')).toBeUndefined();
  });

  it('honours a named consumable over model suggestions and resolves generic healing requests', () => {
    const context = fixture('Use my AMBER TONIC');
    const member = context.members[0];
    const tonic = { ...baseItem('amber', 'Amber tonic', 'consumable'), healing: 4, quantity: 1 };
    const other = member.state.inventory.find((item) => item.healing > 0)!;
    member.state.inventory.push(tonic);
    const submitted = context.turn.actions[0];
    expect(requestedConsumable(member, submitted, other.id)?.id).toBe(tonic.id);
    for (const text of ['Drink a potion', 'Ik drink een drankje', 'Heal myself', 'Consume my item']) {
      submitted.text = text;
      expect(requestedConsumable(member, submitted, tonic.id)?.id).toBe(tonic.id);
      expect(requestedConsumable(member, submitted)?.id).toBe(other.id);
    }
    tonic.name = 'A.M. tonic';
    submitted.text = 'Use my A.M. tonic';
    expect(requestedConsumable(member, submitted, other.id)?.id).toBe(tonic.id);
  });

  it('does not infer consumable use from inspection, refusals, passes or a healing ability alone', () => {
    const context = fixture();
    const member = context.members[0];
    const submitted = context.turn.actions[0];
    const item = member.state.inventory.find((item) => item.healing > 0)!;
    const mend = { ...member.character.abilities[0], name: 'Field mend', effect: 'mend' as const };
    member.character.abilities.push(mend);
    for (const text of [
      'Investigate the platform',
      `Inspect my ${item.name}`,
      "Don't drink a potion",
      'Ik drink geen drankje',
      'Use my ability to heal myself',
      'Use Field mend to heal myself',
    ]) {
      submitted.text = text;
      expect(requestedConsumable(member, submitted, item.id)).toBeUndefined();
    }
    submitted.text = 'Heal myself';
    submitted.abilityName = mend.name;
    expect(requestedConsumable(member, submitted, item.id)).toBeUndefined();
    submitted.text = 'Use Field mend and drink a potion';
    expect(requestedConsumable(member, submitted, item.id)?.id).toBe(item.id);
    submitted.passed = true;
    expect(requestedConsumable(member, submitted, item.id)).toBeUndefined();
  });

  it('keeps an unrelated resource refusal from suppressing a requested ability or potion', () => {
    const context = fixture("Don't drink a potion, but use Focused strike");
    const member = context.members[0];
    const submitted = context.turn.actions[0];
    expect(requestedAbility(member.character, submitted, 'combat')?.name).toBe('Focused strike');
    expect(requestedConsumable(member, submitted)).toBeUndefined();
    submitted.text = "Don't use Focused strike, but drink a potion";
    expect(requestedAbility(member.character, submitted, 'combat')).toBeUndefined();
    expect(requestedConsumable(member, submitted)).toBeDefined();
  });

  it('ignores invented, duplicate, and pass actions without dropping actual submissions', () => {
    const context = fixture();
    const [member, passed] = context.members;
    context.turn.actions.push({ memberId: passed.id, text: '', passed: true });
    const plan = normalizeCombatInput(context, {
      actions: [
        { memberId: 'invented', main: 'attack' },
        { memberId: member.id, main: 'defend' },
        { memberId: member.id, main: 'attack' },
        { memberId: passed.id, main: 'attack' },
      ],
      enemyTargets: [
        { enemyId: 'invented', memberId: member.id },
        { enemyId: 'enemy-0', memberId: 'invented' },
        { enemyId: 'enemy-1', memberId: member.id, extra: true },
        { enemyId: 'enemy-1', memberId: passed.id },
      ],
    });
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ memberId: member.id, main: 'attack' });
    expect(plan.enemyTargets).toEqual([{ enemyId: 'enemy-1', memberId: member.id }]);
  });

  it('uses live targets and preserves defend, flee, diplomacy and model creativity', () => {
    const context = fixture('Defend');
    context.scene.encounter!.enemies[0].hp = 0;
    expect(normalizeCombatInput(context).actions[0].main).toBe('defend');
    context.turn.actions[0].text = 'Flee';
    expect(normalizeCombatInput(context).actions[0].main).toBe('flee');
    context.turn.actions[0].text = 'Negotiate peace with the Violet Vox-Herald';
    const diplomaticPlan = normalizeCombatInput(context, {
      actions: [{ memberId: context.members[0].id, main: 'attack', effect: 'damage' }],
    });
    expect(diplomaticPlan.actions[0]).toMatchObject({
      main: 'creative',
      effect: 'influence',
      targetId: 'enemy-1',
    });
    context.turn.actions[0].text = 'Throw a crate at the enemy';
    expect(
      normalizeCombatInput(context, {
        actions: [
          {
            memberId: context.members[0].id,
            main: 'creative',
            effect: 'stun',
            stat: 'DEX',
            dc: 15,
            targetId: 'missing',
          },
        ],
      }).actions[0],
    ).toMatchObject({ main: 'creative', effect: 'stun', stat: 'DEX', dc: 15, targetId: 'enemy-1' });
  });

  it('defaults support to self and honours explicitly named living allies', () => {
    const context = fixture('Guard myself');
    const [member, ally] = context.members;
    member.character.abilities[0].effect = 'guard';
    context.turn.actions[0].abilityName = 'Focused strike';
    expect(
      normalizeCombatInput(context, { actions: [{ memberId: member.id, targetId: 'enemy-0' }] }).actions[0]
        .targetId,
    ).toBe(member.id);
    context.turn.actions[0].text = 'Protect Krail Venn';
    expect(normalizeCombatInput(context).actions[0].targetId).toBe(ally.id);
  });

  it('keeps backpack weapons stowed during combat and falls back to equipped or innate attacks', () => {
    const context = fixture('Attack with my Pulse rifle');
    const member = context.members[0];
    member.state.inventory.push({
      ...baseItem('rifle', 'Pulse rifle', 'weapon'),
      scaling: ['INT'],
      hands: 2,
      damage: '1d8',
      quantity: 1,
    });
    const plan = normalizeCombatInput(context);
    expect(plan.actions[0]).toMatchObject({
      main: 'attack',
      stat: 'DEX',
      minor: 'none',
      minorItemId: null,
      minorSlot: null,
      weaponSlot: 'left',
    });
    expect(member.state.equipment.right).toBeNull();
    const copy = structuredClone(context);
    expect(
      runCombat(copy.members, copy.scene.encounter!, plan, () => 12).some((log) =>
        log.includes('with Knife'),
      ),
    ).toBe(true);
    member.state.inventory = [];
    member.state.equipment.left = null;
    const barePlan = normalizeCombatInput(context);
    expect(barePlan.actions[0]).toMatchObject({ main: 'attack', weaponSlot: 'natural', minor: 'none' });
    expect(
      runCombat(context.members, context.scene.encounter!, barePlan, () => 12).some((log) =>
        log.includes('innate strike'),
      ),
    ).toBe(true);
  });

  it.each([
    ['Continue deeper trough the shaft, into the next area/room', 'move'],
    ['Move deeper through the escape hatch into the next room.', 'move'],
    ['Cry and kiss the daemonet goodbye before she gets obliterated', 'interact'],
    ['Ga verder door de schacht naar de volgende kamer.', 'move'],
    ['Huil en kus de demon vaarwel voordat zij wordt vernietigd.', 'interact'],
    ['I do not attack; I cry for our fallen friend.', 'interact'],
    ['Inspect the enemy attack pattern.', 'interact'],
    ['Move past the attacking enemy.', 'move'],
  ])('preserves %j despite an invented weapon attack and minor', (text, main) => {
    const context = fixture(text);
    const plan = normalizeCombatInput(context, {
      actions: [
        {
          memberId: context.members[0].id,
          main: 'attack',
          targetId: 'enemy-0',
          effect: 'damage',
          weaponSlot: 'left',
          minor: 'offhand',
          dc: 15,
          description: 'Attack the enemy with both weapons.',
        },
      ],
    });
    expect(plan.actions[0]).toMatchObject({
      main,
      description: text,
      targetId: null,
      weaponSlot: null,
      minor: 'none',
      minorItemId: null,
    });
    expect(plan.actions[0].dc).toBeUndefined();
    expect(plan.actions[0].effect).toBeUndefined();
    const before = structuredClone(context);
    const logs = runCombat(context.members, context.scene.encounter!, plan, () => 12);
    expect(context.scene.encounter!.enemies.map((enemy) => enemy.hp)).toEqual(
      before.scene.encounter!.enemies.map((enemy) => enemy.hp),
    );
    expect(logs.some((log) => log.includes(text))).toBe(true);
    expect(logs.some((log) => log.includes('with Knife'))).toBe(false);
  });

  it('uses a neutral fallback for unknown or malformed intent without a risk check', () => {
    const context = fixture('A white light fills the room.');
    for (const proposal of [
      undefined,
      null,
      { actions: [{ memberId: context.members[0].id, main: 'invalid', effect: 'damage', dc: 20 }] },
    ]) {
      const action = normalizeCombatInput(context, proposal).actions[0];
      expect(action).toMatchObject({ main: 'interact', targetId: null, weaponSlot: null, minor: 'none' });
      expect(action.dc).toBeUndefined();
      expect(action.effect).toBeUndefined();
    }
  });

  it('keeps optional risk and genuine targets only for a compatible neutral interpretation', () => {
    const context = fixture('Climb over the shattered railing toward the nearby exit.');
    const action = normalizeCombatInput(context, {
      actions: [{ memberId: context.members[0].id, main: 'move', targetId: null, stat: 'DEX', dc: 15 }],
    }).actions[0];
    expect(action).toMatchObject({ main: 'move', targetId: null, dc: 15, stat: 'DEX', weaponSlot: null });
    context.turn.actions[0].text = 'Kiss the Violet Vox-Herald goodbye';
    expect(normalizeCombatInput(context).actions[0]).toMatchObject({ main: 'interact', targetId: 'enemy-1' });
  });

  it('preserves direct, combined and idiomatic attacks and permits a listed alternative', () => {
    const context = fixture('Move closer and stab the enemy.');
    expect(
      normalizeCombatInput(context, { actions: [{ memberId: context.members[0].id, main: 'move' }] })
        .actions[0],
    ).toMatchObject({ main: 'attack', weaponSlot: 'left' });
    context.turn.actions[0].text = 'Defend Krail Venn from the enemy attack.';
    expect(
      normalizeCombatInput(context, {
        actions: [{ memberId: context.members[0].id, main: 'attack', description: 'Attack the enemy' }],
      }).actions[0],
    ).toMatchObject({ main: 'defend', description: context.turn.actions[0].text, minor: 'none' });
    context.turn.actions[0].text = 'I empty my magazine into its chest.';
    expect(
      normalizeCombatInput(context, { actions: [{ memberId: context.members[0].id, main: 'attack' }] })
        .actions[0],
    ).toMatchObject({ main: 'attack', weaponSlot: 'left' });
    context.turn.actions[0].text = 'Attack, defend, or use an ability';
    expect(
      normalizeCombatInput(context, { actions: [{ memberId: context.members[0].id, main: 'defend' }] })
        .actions[0].main,
    ).toBe('defend');
    context.turn.actions[0].text = 'Cry and kiss the daemonet goodbye';
    context.turn.actions[0].abilityName = 'Focused strike';
    expect(normalizeCombatInput(context).actions[0]).toMatchObject({
      main: 'ability',
      abilityName: 'Focused strike',
      stat: 'STR',
    });
  });

  it('does not add an offhand attack or other minors that the player did not request', () => {
    const context = fixture('Attack the enemy');
    for (const minor of ['offhand', 'heal', 'equip']) {
      expect(
        normalizeCombatInput(context, {
          actions: [
            {
              memberId: context.members[0].id,
              main: 'attack',
              minor,
              minorItemId: 'invented',
              minorSlot: 'right',
            },
          ],
        }).actions[0],
      ).toMatchObject({ main: 'attack', minor: 'none', minorItemId: null, minorSlot: null });
    }
    context.turn.actions[0].text = 'Attack using both weapons';
    expect(
      normalizeCombatInput(context, {
        actions: [{ memberId: context.members[0].id, main: 'attack', minor: 'offhand' }],
      }).actions[0].minor,
    ).toBe('offhand');
  });
});

describe('actions after escaping an ongoing encounter', () => {
  const escaped = (text: string) => {
    const context = fixture(text);
    context.members[0].state.conditions.push('Escaped');
    context.members[0].state.conditionTurns.Escaped = 999;
    return context;
  };

  it.each([
    'Move through the shaft into the next room.',
    'Keep exploring.',
    'Continue exploring.',
    'Explore the next room.',
    'Verken de volgende kamer.',
    'I do not rejoin the fight; inspect the corridor.',
  ])('resolves %j while the other character remains in combat', (text) => {
    const context = escaped(text);
    const plan = normalizeCombatInput(context, {
      actions: [{ memberId: context.members[0].id, main: 'attack', reengage: true }],
      enemyTargets: [{ enemyId: 'enemy-0', memberId: context.members[0].id }],
    });
    expect(plan.actions[0].reengage).toBe(false);
    expect(plan.enemyTargets).toEqual([]);
    const logs = runCombat(context.members, context.scene.encounter!, plan, (sides) =>
      sides === 20 ? 12 : 2,
    );
    expect(logs.some((log) => log.includes(text))).toBe(true);
    expect(context.members[0].state.conditions).toContain('Escaped');
    expect(context.members[0].state.hp).toBe(context.members[0].state.maxHp);
    expect(context.members[1].state.hp).toBeLessThan(context.members[1].state.maxHp);
    expect(context.scene.encounter!.escaped).toBe(false);
  });

  it.each([
    'Attack the enemy.',
    'Defend my ally.',
    'I return to the fight.',
    'Re-engage.',
    'Ik ga terug naar het gevecht.',
  ])('rejoins on %j and allows enemies to respond', (text) => {
    const context = escaped(text);
    const plan = normalizeCombatInput(context, {
      actions: [{ memberId: context.members[0].id, main: 'attack' }],
      enemyTargets: [{ enemyId: 'enemy-0', memberId: context.members[0].id }],
    });
    expect(plan.actions[0].reengage).toBe(true);
    expect(plan.enemyTargets).toEqual([{ enemyId: 'enemy-0', memberId: context.members[0].id }]);
    const logs = runCombat(context.members, context.scene.encounter!, plan, (sides) =>
      sides === 20 ? 20 : 2,
    );
    expect(logs[0]).toBe('Mara Vex rejoins the fight.');
    expect(context.members[0].state.conditions).not.toContain('Escaped');
    expect(context.members[0].state.hp).toBeLessThan(context.members[0].state.maxHp);
    if (!text.startsWith('Attack'))
      expect(context.scene.encounter!.enemies.map((enemy) => enemy.hp)).toEqual([30, 30]);
  });

  it('rejoins with exactly the selected combat ability and preserves escape on a pass', () => {
    const context = escaped('Use my technique.');
    const ability = context.members[0].character.abilities.find((ability) => ability.kind === 'combat')!;
    context.turn.actions[0].abilityName = ability.name;
    const plan = normalizeCombatInput(context);
    expect(plan.actions[0]).toMatchObject({ main: 'ability', abilityName: ability.name, reengage: true });
    runCombat(context.members, context.scene.encounter!, plan, (sides) => (sides === 20 ? 12 : 2));
    expect(context.members[0].state.conditions).not.toContain('Escaped');
    expect(context.members[0].state.abilityUses?.[ability.name]).toBe(1);

    const passing = escaped('');
    passing.turn.actions[0].passed = true;
    runCombat(passing.members, passing.scene.encounter!, normalizeCombatInput(passing), (sides) =>
      sides === 20 ? 12 : 2,
    );
    expect(passing.members[0].state.conditions).toContain('Escaped');
    expect(passing.members[0].state.hp).toBe(passing.members[0].state.maxHp);
  });

  it('allows healing while exploring and does not reroll an already completed escape', () => {
    const context = escaped('Keep exploring and drink a potion.');
    const member = context.members[0];
    member.state.hp -= 6;
    const potion = { ...baseItem('potion', 'Potion', 'consumable'), quantity: 1, healing: 4 };
    member.state.inventory.push(potion);
    const plan = normalizeCombatInput(context, {
      actions: [{ memberId: member.id, main: 'interact', minor: 'heal', minorItemId: potion.id }],
    });
    const logs = runCombat(context.members, context.scene.encounter!, plan, (sides) =>
      sides === 20 ? 12 : 2,
    );
    expect(logs).toContain('Mara Vex uses a healing consumable.');
    expect(member.state.hp).toBe(member.state.maxHp - 2);
    expect(member.state.conditions).toContain('Escaped');

    context.turn.actions[0].text = 'Flee further away.';
    const labels: string[] = [];
    const fleeing = runCombat(
      context.members,
      context.scene.encounter!,
      normalizeCombatInput(context),
      (sides, label) => {
        labels.push(label);
        return sides === 20 ? 12 : 2;
      },
    );
    expect(fleeing).toContain('Mara Vex continues away from the fight.');
    expect(labels).not.toContain('Flee combat');
    expect(member.state.conditions).toContain('Escaped');
  });
});
