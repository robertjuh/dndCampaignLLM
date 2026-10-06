import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normalizeCombatInput } from '../server/combat';
import { environmentalFacts } from '../server/environment';
import { requestedAbility, requestedConsumable } from '../server/action-resources';
import type { GMContext } from '../server/game';
import { baseItem, equip, initialScene, initialState, runCombat } from '../shared/rules';
import { enemySchema, templateCharacter, type Member, type EnvironmentalAction } from '../shared/schema';

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
  it.each(['stun', 'influence', 'damage', 'flee'] as const)(
    'uses a scoped utility for %s during combat with advantage, level scaling and one charge',
    (effect) => {
      const context = fixture(
        effect === 'flee'
          ? 'I escape using my utility ability'
          : 'Use my utility ability against Ork Breachmob',
      );
      const actor = context.members[0];
      const ability = actor.character.abilities[1];
      ability.stat = 'CHA';
      ability.level = 2;
      ability.bonus = 1;
      context.turn.actions[0].abilityName = ability.name;
      const plan = normalizeCombatInput(context, {
        actions: [
          {
            memberId: actor.id,
            main: effect === 'flee' ? 'flee' : 'creative',
            abilityName: ability.name,
            targetId: 'enemy-0',
            stat: 'STR',
            dc: effect === 'influence' ? 15 : 10,
            ...(effect === 'flee' ? {} : { effect }),
          },
        ],
        enemyTargets: context.scene.encounter!.enemies.map((enemy) => ({
          enemyId: enemy.id,
          memberId: actor.id,
        })),
      });
      expect(plan.actions[0]).toMatchObject({
        main: effect === 'flee' ? 'flee' : 'creative',
        abilityName: ability.name,
        stat: 'CHA',
      });
      const checks: { stat?: string; bonus?: number }[] = [];
      const before = context.scene.encounter!.enemies[0].hp;
      runCombat(context.members, context.scene.encounter!, plan, (sides, _label, id, stat, bonus) => {
        if (id === actor.id && sides === 20) {
          checks.push({ stat, bonus });
          return checks.length === 1 ? 1 : effect === 'influence' ? 11 : 6;
        }
        return sides === 20 ? 12 : Math.min(2, sides);
      });
      expect(checks).toEqual([
        { stat: 'CHA', bonus: 4 },
        { stat: 'CHA', bonus: 4 },
      ]);
      expect(actor.state.abilityUses?.[ability.name]).toBe(1);
      if (effect === 'flee') expect(actor.state.conditions).toContain('Escaped');
      if (effect === 'influence') expect(context.scene.encounter!.enemies[0].withdrawn).toBe(true);
      if (effect === 'stun') expect(actor.state.hp).toBe(actor.state.maxHp - 2); // Only the other enemy attacks.
      if (effect === 'damage') expect(context.scene.encounter!.enemies[0].hp).toBe(before - 2);
      const retryChecks: string[] = [];
      runCombat(context.members, context.scene.encounter!, plan, (sides, label) => {
        if (label.includes('advantage')) retryChecks.push(label);
        return Math.min(2, sides);
      });
      expect(retryChecks).toEqual([]);
    },
  );

  it.each(['combat', 'utility'] as const)('uses %s Mend to heal and cure an ally in combat', (kind) => {
    const context = fixture('Use Field mend on Krail Venn');
    const [actor, target] = context.members;
    const ability = {
      ...actor.character.abilities[0],
      kind,
      name: 'Field mend',
      effect: 'mend' as const,
      stat: 'INT' as const,
      dice: '1d4' as const,
      cures: ['Shocked' as const],
    };
    actor.character.abilities = [ability];
    context.turn.actions[0].abilityName = ability.name;
    target.state.hp = 10;
    target.state.conditions.push('Shocked');
    target.state.conditionTurns.Shocked = 3;
    const plan = normalizeCombatInput(context);
    expect(plan.actions[0]).toMatchObject({
      main: 'ability',
      abilityName: ability.name,
      targetId: target.id,
    });
    context.scene.encounter!.initiative = [{ id: actor.id, total: 15 }];
    runCombat(context.members, context.scene.encounter!, plan, () => 4);
    expect(target.state.hp).toBe(14);
    expect(target.state.conditions).not.toContain('Shocked');
    expect(actor.state.abilityUses?.[ability.name]).toBe(1);
  });

  it.each([1, 2])(
    'uses an equipped weapon and randomly selects living enemy %i for a vague attack',
    (choice) => {
      const context = fixture('I attack the enemy');
      const member = context.members[0];
      const plan = normalizeCombatInput(context, {
        actions: [{ memberId: member.id, main: 'attack', weaponSlot: 'natural', targetId: 'enemy-0' }],
      });
      expect(plan.actions[0]).toMatchObject({
        main: 'attack',
        targetId: null,
        weaponSlot: 'left',
        abilityName: null,
      });
      runCombat(context.members, context.scene.encounter!, plan, (sides, label) =>
        label.includes('random enemy') ? choice : Math.min(12, sides),
      );
      expect(context.scene.encounter!.enemies[choice - 1].hp).toBeLessThan(30);
      expect(context.scene.encounter!.enemies[2 - choice].hp).toBe(30);
      expect(member.state.abilityUses?.['Focused strike'] ?? 0).toBe(0);
    },
  );

  it('preserves an explicitly unarmed attack despite an equipped weapon', () => {
    const context = fixture('I punch the Ork Breachmob');
    expect(normalizeCombatInput(context).actions[0]).toMatchObject({
      weaponSlot: 'natural',
      targetId: 'enemy-0',
    });
  });
  it('preserves a target described by proximity rather than name', () => {
    const context = fixture('I attack the closest enemy with my Knife');
    expect(
      normalizeCombatInput(context, {
        actions: [{ memberId: context.members[0].id, main: 'attack', targetId: 'enemy-1' }],
      }).actions[0].targetId,
    ).toBe('enemy-1');
  });
  it.each(['I attack only Ork Breachmob', 'Ik val alleen Ork Breachmob aan'])(
    'preserves explicit target restrictions despite model suggestions: %s',
    (text) => {
      const context = fixture(text);
      const action = normalizeCombatInput(context, {
        actions: [
          {
            memberId: context.members[0].id,
            main: 'attack',
            allowRetarget: true,
            backupTargetId: 'enemy-1',
          },
        ],
      }).actions[0];
      expect(action).toMatchObject({ targetId: 'enemy-0', allowRetarget: false, backupTargetId: null });
    },
  );

  it('keeps the first named target as primary and honours an explicitly named backup', () => {
    const context = fixture('Attack Violet Vox-Herald; if it falls, attack Ork Breachmob instead.');
    expect(normalizeCombatInput(context).actions[0]).toMatchObject({
      main: 'attack',
      targetId: 'enemy-1',
      allowRetarget: true,
      backupTargetId: 'enemy-0',
    });
    context.turn.actions[0].abilityName = 'Focused strike';
    expect(normalizeCombatInput(context).actions[0]).toMatchObject({
      main: 'ability',
      abilityName: 'Focused strike',
      targetId: 'enemy-1',
      backupTargetId: 'enemy-0',
    });
  });

  it('keeps an explicitly named unavailable target and a model-resolved restricted target', () => {
    const context = fixture('Attack only Ork Breachmob.');
    context.scene.encounter!.enemies[0].hp = 0;
    let plan = normalizeCombatInput(context);
    expect(plan.actions[0]).toMatchObject({ targetId: 'enemy-0', allowRetarget: false });
    let logs = runCombat(context.members, context.scene.encounter!, plan, () => 12);
    expect(logs.join(' ')).toContain('main action is spent');
    expect(context.scene.encounter!.enemies[1].hp).toBe(30);
    context.turn.actions[0].text = 'Use my strike on an enemy.';
    context.turn.actions[0].abilityName = 'Focused strike';
    expect(normalizeCombatInput(context).actions[0].targetId).toBe('enemy-1');
    delete context.turn.actions[0].abilityName;
    context.turn.actions[0].text = 'Attack only the herald.';
    plan = normalizeCombatInput(context, {
      actions: [{ memberId: context.members[0].id, main: 'attack', targetId: 'enemy-1' }],
    });
    expect(plan.actions[0]).toMatchObject({ targetId: 'enemy-1', allowRetarget: false });
    logs = runCombat(context.members, context.scene.encounter!, plan, (sides) => (sides === 20 ? 12 : 2));
    expect(logs.join(' ')).toContain('hits Violet Vox-Herald');
  });

  it('allows retargeting for a named target but ignores an invented or unavailable backup', () => {
    const context = fixture('Attack Violet Vox-Herald.');
    const proposal = {
      actions: [{ memberId: context.members[0].id, main: 'attack', backupTargetId: 'enemy-0' }],
    };
    expect(normalizeCombatInput(context, proposal).actions[0]).toMatchObject({
      targetId: 'enemy-1',
      allowRetarget: true,
      backupTargetId: null,
    });
    context.turn.actions[0].text = 'Attack Violet Vox-Herald if Ork Breachmob is distracted.';
    expect(normalizeCombatInput(context, proposal).actions[0].backupTargetId).toBeNull();
    context.turn.actions[0].text = 'Attack Violet Vox-Herald; otherwise attack Ork Breachmob.';
    context.scene.encounter!.enemies[0].withdrawn = true;
    expect(normalizeCombatInput(context, proposal).actions[0]).toMatchObject({
      targetId: 'enemy-1',
      backupTargetId: null,
    });
  });

  it.each(['help-up', 'heal-ally'] as const)(
    'preserves a trusted %s action despite conflicting model suggestions',
    (type) => {
      const context = fixture('I help up Krail Venn');
      const [helper, ally] = context.members;
      ally.state.hp = 0;
      ally.state.conditions.push('Downed');
      ally.state.downedThisEncounter = true;
      context.turn.roster = [helper.id];
      const item = helper.state.inventory[0];
      context.turn.actions[0].supportAction =
        type === 'help-up' ? { type, targetId: ally.id } : { type, targetId: ally.id, itemId: item.id };
      const plan = normalizeCombatInput(context, {
        actions: [
          {
            memberId: helper.id,
            main: 'attack',
            abilityName: 'Focused strike',
            targetId: 'enemy-0',
            minor: 'offhand',
          },
        ],
      });
      expect(plan.actions[0]).toMatchObject({
        main: type === 'help-up' ? 'help-up' : 'heal',
        targetId: ally.id,
        mainItemId: type === 'help-up' ? null : item.id,
        abilityName: null,
        minor: 'none',
        weaponSlot: null,
      });
      context.scene.encounter!.initiative = context.scene.encounter!.initiative.filter(
        (actor) => actor.id === helper.id,
      );
      runCombat(context.members, context.scene.encounter!, plan, () => 12);
      expect(ally.state.hp).toBe(type === 'help-up' ? 1 : 6);
      expect(context.scene.encounter!.enemies[0].hp).toBe(30);
      expect(helper.state.abilityUses).toEqual({});
    },
  );

  it('distinguishes help up, ally healing that uses the turn, and self healing alongside an attack', () => {
    const context = fixture('I help Krail Venn up');
    const [helper, ally] = context.members;
    ally.state.hp = 0;
    ally.state.conditions.push('Downed');
    expect(normalizeCombatInput(context).actions[0]).toMatchObject({
      main: 'help-up',
      targetId: ally.id,
      mainItemId: null,
      minor: 'none',
    });
    context.turn.actions[0].text = 'Attack the enemy and use my healing item on Krail Venn';
    expect(normalizeCombatInput(context).actions[0]).toMatchObject({
      main: 'heal',
      targetId: ally.id,
      mainItemId: helper.state.inventory[0].id,
      minor: 'none',
      abilityName: null,
    });
    context.turn.actions[0].text = 'Attack the enemy and drink a potion myself';
    expect(normalizeCombatInput(context).actions[0]).toMatchObject({
      main: 'attack',
      targetId: null,
      mainItemId: null,
      minor: 'heal',
      minorItemId: helper.state.inventory[0].id,
      minorTargetId: null,
    });
  });

  it('uses the campaign language for fallback loot while preserving enemy and biome names', () => {
    const context = fixture();
    context.scene.location.name = 'Glass Forest';
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
              main: 'heal',
              targetId: ally.id,
              mainItemId: healer.state.inventory.find((item) => item.healing > 0)!.id,
              minor: 'none',
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
        targetId: null,
        minor: 'none',
      });
      expect(context).toEqual(before);
      const copy = structuredClone(context);
      expect(
        runCombat(copy.members, copy.scene.encounter!, plan, (sides) => Math.min(12, sides)).some((log) =>
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
    const logs = runCombat(context.members, context.scene.encounter!, plan, () => 12);
    expect(logs).toContain(
      `${member.character.name}'s ${ability.name} has already been used. It recharges after a successful encounter. The main action is spent.`,
    );
    expect(member.state.abilityUses?.[ability.name]).toBe(1);
  });

  it.each([
    'Ik ren richting brom en sla zen tyfushoofd in 2. Ik gebruik zijn dood om mijn abilities weer terug te krijgen',
    'I attack and use his death to regain my abilities.',
    'I attack with my weapon to recharge my power.',
    'Maak brom af met een harde klap op de grond die de aarde laat beven',
  ])('does not activate an ability for an attack or recharge wish: %s', (text) => {
    const context = fixture(text);
    const member = context.members[0];
    member.state.abilityUses = { 'Focused strike': 1 };
    const plan = normalizeCombatInput(context, {
      actions: [{ memberId: member.id, main: 'attack', abilityName: 'Focused strike' }],
    });
    expect(plan.actions[0]).toMatchObject({ main: 'attack', abilityName: null });
    runCombat(context.members, context.scene.encounter!, plan, (sides) => (sides === 20 ? 12 : 2));
    expect(context.scene.encounter!.enemies.some((enemy) => enemy.hp < 30)).toBe(true);
    expect(member.state.abilityUses).toEqual({ 'Focused strike': 1 });
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
      runCombat(copy.members, copy.scene.encounter!, plan, (sides) => Math.min(12, sides)).some((log) =>
        log.includes('with Knife'),
      ),
    ).toBe(true);
    member.state.inventory = [];
    member.state.equipment.left = null;
    const barePlan = normalizeCombatInput(context);
    expect(barePlan.actions[0]).toMatchObject({ main: 'attack', weaponSlot: 'natural', minor: 'none' });
    expect(
      runCombat(context.members, context.scene.encounter!, barePlan, (sides) => Math.min(12, sides)).some(
        (log) => log.includes('innate strike'),
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

it('normalizes environmental treatment as a main interaction targeting the affected ally', () => {
  const context = fixture('I smother the flames on Krail Venn with the nearby blanket.');
  const [actor, ally] = context.members;
  const plan = normalizeCombatInput(context, {
    actions: [
      {
        memberId: actor.id,
        main: 'interact',
        targetId: ally.id,
        cureCondition: 'Burning',
        description: 'Use the nearby blanket to smother the fire.',
      },
    ],
  });
  expect(plan.actions[0]).toMatchObject({
    main: 'interact',
    targetId: ally.id,
    cureCondition: 'Burning',
    abilityName: null,
  });
  expect(plan.actions[0].dc).toBeUndefined();
  const attacking = fixture('I attack the enemy.');
  const attack = normalizeCombatInput(attacking, {
    actions: [{ memberId: attacking.members[0].id, main: 'interact', cureCondition: 'Burning' }],
  });
  expect(attack.actions[0]).toMatchObject({ main: 'attack', cureCondition: null });
});

it.each(['already downed', 'last fighter falls', 'last fighter escapes'])(
  'ends a split-party encounter when %s and permanently kills those left behind',
  (scenario) => {
    const context = fixture('I hide in the alley.');
    const [escaped, ally] = context.members;
    escaped.state.conditions.push('Escaped');
    escaped.state.abilityUses = { 'Keen observation': 1 };
    escaped.state.hp -= 2;
    const abandoned = structuredClone(ally);
    abandoned.id = 'abandoned';
    abandoned.character.name = 'Abandoned ally';
    abandoned.state.hp = 0;
    abandoned.state.conditions = ['Downed'];
    context.members.push(abandoned);
    if (scenario === 'already downed') {
      ally.state.hp = 0;
      ally.state.conditions = ['Downed'];
    } else if (scenario === 'last fighter falls') {
      ally.state.hp = 1;
    } else {
      context.turn.actions.push({ memberId: ally.id, text: 'Flee', passed: false });
    }
    const escapedHp = escaped.state.hp;
    const logs = runCombat(
      context.members,
      context.scene.encounter!,
      normalizeCombatInput(context),
      (sides) => (sides === 20 ? 20 : 2),
    );
    expect(context.scene.encounter).toMatchObject({ victory: false, escaped: true });
    expect(abandoned.state).toMatchObject({
      hp: 0,
      conditions: [],
      deathReason: expect.stringContaining('Left behind'),
    });
    expect(logs).toContain('The surviving party escapes. Combat ends.');
    expect(escaped.state).toMatchObject({ hp: escapedHp, xp: 0, abilityUses: { 'Keen observation': 1 } });
    expect(escaped.state.conditions).not.toContain('Escaped');
    if (scenario !== 'last fighter escapes') {
      expect(ally.state.conditions).not.toContain('Downed');
      expect(ally.state.deathReason).toContain('Left behind');
    } else {
      expect(ally.state.hp).toBeGreaterThan(0);
      expect(ally.state.deathReason).toBeNull();
    }
  },
);

it.each([
  [true, true],
  [true, false],
  [false, true],
  [false, false],
])(
  'executes an escaped utility check with saved stat, relic bonus, advantage and one charge (selected: %s, planned: %s)',
  (selected, planned) => {
    const context = fixture('Use my utility ability to search the alley.');
    const [actor] = context.members;
    actor.state.conditions.push('Escaped');
    const ability = actor.character.abilities.find((ability) => ability.kind === 'utility')!;
    ability.stat = 'WIS';
    ability.bonus = 2;
    actor.state.equipment.relic = { ...baseItem('relic', 'Lens', 'relic'), scaling: ['WIS'], checkBonus: 3 };
    if (selected) context.turn.actions[0].abilityName = ability.name;
    const plan = normalizeCombatInput(
      context,
      planned
        ? {
            actions: [
              { memberId: actor.id, main: 'ability', abilityName: ability.name, stat: 'STR', dc: 15 },
            ],
            enemyTargets: [{ enemyId: 'enemy-0', memberId: actor.id }],
          }
        : undefined,
    );
    expect(plan.actions[0]).toMatchObject({
      main: 'interact',
      stat: 'WIS',
      reengage: false,
      abilityName: ability.name,
    });
    expect(plan.enemyTargets).toEqual([]);
    const checks: { stat?: string; bonus?: number }[] = [];
    const hp = actor.state.hp;
    runCombat(context.members, context.scene.encounter!, plan, (sides, _label, id, stat, bonus) => {
      if (id === actor.id && sides === 20) {
        checks.push({ stat, bonus });
        return checks.length === 1 ? 1 : 20;
      }
      return Math.min(12, sides);
    });
    expect(checks).toHaveLength(2);
    expect(checks.every((check) => check.stat === 'WIS' && check.bonus! >= 5)).toBe(true);
    expect(actor.state).toMatchObject({ hp, abilityUses: { [ability.name]: 1 } });
    expect(actor.state.conditions).toContain('Escaped');
    const logs = runCombat(context.members, context.scene.encounter!, plan, () => 12);
    expect(logs.some((log) => log.includes('already been used'))).toBe(true);
  },
);

it.each(['help-up', 'heal', 'treat', 'mend', 'interact'])(
  'blocks an escaped %s targeting a fighter without spending resources or rejoining',
  (kind) => {
    const context = fixture();
    const [actor, ally] = context.members;
    actor.state.conditions.push('Escaped');
    ally.state.conditions.push('Burning');
    ally.state.conditionTurns.Burning = 3;
    const potion = { ...baseItem('potion', 'Potion', 'consumable'), quantity: 1, healing: 4 };
    actor.state.inventory.push(potion);
    const mend = {
      ...actor.character.abilities[0],
      name: 'Restore',
      kind: 'combat' as const,
      effect: 'mend' as const,
    };
    actor.character.abilities.push(mend);
    context.turn.actions[0].text =
      kind === 'help-up'
        ? 'I help Krail Venn up.'
        : kind === 'heal'
          ? 'Use Potion on Krail Venn.'
          : kind === 'mend'
            ? 'Use Restore on Krail Venn.'
            : 'I inspect Krail Venn.';
    const plan = normalizeCombatInput(context, {
      actions: [
        {
          memberId: actor.id,
          main: kind === 'mend' ? 'ability' : kind === 'treat' ? 'interact' : kind,
          abilityName: kind === 'mend' ? mend.name : null,
          targetId: ally.id,
          cureCondition: kind === 'treat' ? 'Burning' : null,
        },
      ],
    });
    expect(plan.actions[0].reengage).toBe(false);
    const logs = runCombat(context.members, context.scene.encounter!, plan, () => 2);
    expect(logs.some((log) => log.includes('cannot interact'))).toBe(true);
    expect(actor.state.conditions).toContain('Escaped');
    expect(actor.state.inventory.find((item) => item.id === potion.id)?.quantity).toBe(1);
    expect(actor.state.abilityUses?.[mend.name]).toBeUndefined();
    expect(ally.state.conditions).toContain('Burning');
  },
);

it('lets an escaped character mend themselves without rejoining', () => {
  const context = fixture('Use Restore on myself.');
  const [actor] = context.members;
  actor.state.conditions.push('Escaped');
  actor.state.hp -= 10;
  actor.character.abilities.push({
    ...actor.character.abilities[0],
    name: 'Restore',
    kind: 'combat',
    effect: 'mend',
  });
  const plan = normalizeCombatInput(context);
  expect(plan.actions[0]).toMatchObject({ main: 'ability', targetId: actor.id, reengage: false });
  const hp = actor.state.hp;
  runCombat(context.members, context.scene.encounter!, plan, () => 2);
  expect(actor.state.hp).toBeGreaterThan(hp);
  expect(actor.state.conditions).toContain('Escaped');
  expect(actor.state.abilityUses?.Restore).toBe(1);
});

function cannonFixture(text = 'Knal de boegharpoenier voor zijnen donder volle bak met het kannon jonge') {
  const context = fixture(text);
  context.members.forEach((member) => (member.state.stats.INT = 5));
  context.scene.encounter!.enemies[0].name = 'Asgrijze Boegharpoenier';
  context.scene.environment = { sources: {}, spentResources: [] };
  context.journal = [
    {
      kind: 'fact',
      name: 'Prepared cannon',
      detail: 'The mounted cannon is loaded with a dry charge and a chain shot, aimed at the enemy ship.',
    },
    {
      kind: 'fact',
      name: 'Spare shot',
      detail: 'A sealed spare powder charge and one chain shot are available beside the cannon.',
    },
  ];
  const profile: EnvironmentalAction = {
    sourceId: 'journal:fact:Prepared cannon',
    name: 'Mounted cannon',
    evidence: context.journal[0].detail,
    operation: 'attack',
    roll: 'defense',
    damage: '2d6',
    damageBonus: 1,
    consumption: 'reload',
    reloadSourceId: null,
    reloadEvidence: null,
  };
  const plan = (extra: Partial<EnvironmentalAction> = {}, main = 'creative') =>
    normalizeCombatInput(context, {
      actions: [
        {
          memberId: context.members[0].id,
          main,
          stat: 'INT',
          targetId: 'enemy-0',
          effect: 'damage',
          environment: { ...profile, ...extra },
        },
      ],
    });
  const execute = (input = plan(), die = 12) => {
    const rolls: { actor: string; sides: number; label: string; dc?: number }[] = [];
    const events: { status: string | null; fact: string }[] = [];
    const logs = runCombat(
      context.members,
      context.scene.encounter!,
      input,
      (sides, label, actor, _stat, _mod, dc) => {
        rolls.push({ actor, sides, label, dc });
        return sides === 20 ? (actor === context.members[0].id ? die : 2) : 3;
      },
      (event) => events.push(event),
      context.scene.environment,
    );
    return { logs, events, rolls: rolls.filter((roll) => roll.actor === context.members[0].id) };
  };
  return { context, profile, plan, execute };
}

describe('grounded environmental combat', () => {
  it.each([
    'Knal de boegharpoenier voor zijnen donder volle bak met het kannon jonge',
    'I fire the prepared cannon at the harpooner',
  ])('resolves %s using its proposed source and enemy target instead of an equipped weapon', (text) => {
    const f = cannonFixture(text);
    const input = f.plan({}, 'attack');
    expect(input.actions[0]).toMatchObject({
      main: 'creative',
      effect: 'damage',
      weaponSlot: null,
      targetId: 'enemy-0',
      environment: f.profile,
    });
    const before = structuredClone(f.context.members[0].state.equipment);
    const result = f.execute(input);
    expect(result.rolls.map((roll) => roll.sides)).toEqual([20, 6, 6]);
    expect(result.rolls[0].dc).toBe(10);
    expect(result.rolls[0].label).toContain('Mounted cannon against Asgrijze Boegharpoenier');
    expect(f.context.scene.encounter!.enemies[0].hp).toBe(23);
    expect(f.context.scene.encounter!.enemies[1].hp).toBe(30);
    expect(f.context.scene.environment!.sources[f.profile.sourceId].ready).toBe(false);
    expect(f.context.members[0].state.equipment).toEqual(before);
    expect(result.events).toContainEqual(
      expect.objectContaining({ status: 'success', fact: expect.stringContaining('takes 7 damage') }),
    );
  });

  it('uses a difficulty check for an uncertain maneuver and spends the shot on a miss', () => {
    const f = cannonFixture();
    const input = f.plan({ roll: 'check' });
    input.actions[0].dc = 15;
    const result = f.execute(input, 12);
    expect(result.rolls.map((roll) => roll.sides)).toEqual([20]);
    expect(result.rolls[0].dc).toBe(15);
    expect(f.context.scene.encounter!.enemies[0].hp).toBe(30);
    expect(f.context.scene.environment!.sources[f.profile.sourceId].ready).toBe(false);
    expect(result.events).toContainEqual(
      expect.objectContaining({ status: 'failure', fact: expect.stringContaining('no damage is dealt') }),
    );
  });

  it.each([1, 20])('keeps critical rules and source consumption on a natural %i', (die) => {
    const f = cannonFixture();
    const hp = f.context.members[0].state.hp;
    const result = f.execute(f.plan(), die);
    expect(f.context.scene.encounter!.enemies[0].hp).toBe(die === 20 ? 17 : 30);
    expect(result.rolls.filter((roll) => roll.sides === 6)).toHaveLength(die === 20 ? 4 : 0);
    expect(f.context.members[0].state.hp).toBe(die === 1 ? hp - 4 : hp);
    expect(f.context.scene.environment!.sources[f.profile.sourceId].ready).toBe(false);
  });

  it('preserves the source when the target is unavailable before execution', () => {
    const f = cannonFixture();
    const input = f.plan();
    f.context.scene.encounter!.enemies[0].hp = 0;
    const result = f.execute(input);
    expect(result.rolls).toHaveLength(0);
    expect(f.context.scene.environment!.sources).toEqual({});
    expect(result.events).toContainEqual(
      expect.objectContaining({
        status: 'blocked',
        fact: expect.stringContaining('target is no longer available'),
      }),
    );
  });

  it.each(['unknown source', 'invented evidence', 'oversized dice', 'oversized bonus'])(
    'explains a blocked %s without firing a different weapon',
    (invalid) => {
      const f = cannonFixture();
      const change =
        invalid === 'unknown source'
          ? { sourceId: 'journal:fact:Invented artillery' }
          : invalid === 'invented evidence'
            ? { evidence: 'There is a magical infinite-ammunition cannon.' }
            : invalid === 'oversized dice'
              ? { damage: '4d12' }
              : { damageBonus: 500 };
      const input = f.plan(change);
      expect(input.actions[0].blockedReason).toBeTruthy();
      const result = f.execute(input);
      expect(result.rolls).toHaveLength(0);
      expect(f.context.scene.encounter!.enemies[0].hp).toBe(30);
      expect(f.context.scene.environment!.sources).toEqual({});
      expect(result.events).toContainEqual(
        expect.objectContaining({ status: 'blocked', fact: expect.stringContaining('no effect') }),
      );
    },
  );

  it('retains the saved profile and blocks a second shot until a separate reload', () => {
    const f = cannonFixture();
    f.execute();
    const changed = f.plan({
      name: 'Unlimited super cannon',
      damage: '4d6',
      damageBonus: 3,
      consumption: 'none',
    });
    expect(changed.actions[0].environment).toMatchObject(f.profile);
    const second = f.execute(changed);
    expect(second.rolls).toHaveLength(0);
    expect(f.context.scene.encounter!.enemies[0].hp).toBe(23);
    expect(second.events).toContainEqual(
      expect.objectContaining({ status: 'blocked', fact: expect.stringContaining('needs reloading') }),
    );
  });

  it.each(['once', 'none'] as const)('preserves the reuse rule for a %s opportunity', (consumption) => {
    const f = cannonFixture();
    f.execute(f.plan({ consumption }));
    const second = f.execute(f.plan({ consumption }));
    expect(f.context.scene.encounter!.enemies[0].hp).toBe(consumption === 'once' ? 23 : 16);
    expect(second.rolls).toHaveLength(consumption === 'once' ? 0 : 3);
    expect(f.context.scene.environment!.sources[f.profile.sourceId].ready).toBe(consumption === 'none');
  });

  it('preserves the loaded opportunity when its actor cannot act', () => {
    const f = cannonFixture();
    f.context.members[0].state.conditions.push('Stunned');
    const result = f.execute();
    expect(result.rolls).toHaveLength(0);
    expect(f.context.scene.environment!.sources).toEqual({});
    expect(result.events).toContainEqual(
      expect.objectContaining({
        status: 'blocked',
        fact: expect.stringContaining('loses their main action'),
      }),
    );
  });

  it('uses the target’s reduced defense when it is Chilled', () => {
    const f = cannonFixture();
    f.context.scene.encounter!.enemies[0].conditions = ['Chilled'];
    const result = f.execute(f.plan(), 8);
    expect(result.rolls[0].dc).toBe(8);
    expect(f.context.scene.encounter!.enemies[0].hp).toBe(23);
  });

  it('preserves ally healing when the model proposes an unrelated environmental attack', () => {
    const f = cannonFixture('Use Potion on Krail Venn.');
    f.context.members[0].state.inventory.push({
      ...baseItem('potion', 'Potion', 'consumable'),
      quantity: 1,
      healing: 4,
    });
    f.context.members[1].state.hp -= 5;
    const input = f.plan();
    expect(input.actions[0]).toMatchObject({ main: 'heal', targetId: f.context.members[1].id });
    expect(input.actions[0].environment).toBeUndefined();
    f.execute(input);
    expect(f.context.scene.environment!.sources).toEqual({});
  });

  it('reloads with a grounded fresh supply once, and accepts a later authoritative replenishment', () => {
    const f = cannonFixture();
    f.execute();
    f.context.turn.actions[0].text = 'Reload the cannon with the spare powder charge and chain shot.';
    const reload = () =>
      f.plan(
        {
          operation: 'reload',
          reloadSourceId: 'journal:fact:Spare shot',
          reloadEvidence: f.context.journal[1].detail,
        },
        'interact',
      );
    const first = f.execute(reload());
    expect(first.rolls).toHaveLength(0);
    expect(f.context.scene.environment!.sources[f.profile.sourceId].ready).toBe(true);
    expect(first.events).toContainEqual(
      expect.objectContaining({ status: 'success', fact: expect.stringContaining('ammunition is consumed') }),
    );
    f.context.turn.actions[0].text = 'Fire the cannon at the harpooner.';
    f.execute();
    f.context.turn.actions[0].text = 'Reload the cannon.';
    expect(f.execute(reload()).events).toContainEqual(
      expect.objectContaining({ status: 'blocked', fact: expect.stringContaining('no unspent ammunition') }),
    );
    f.context.journal[1].detail =
      'A newly delivered powder charge and fresh chain shot are available beside the cannon.';
    expect(f.execute(reload()).events).toContainEqual(
      expect.objectContaining({ status: 'success', fact: expect.stringContaining('reloads') }),
    );
    expect(f.context.scene.environment!.spentResources).toHaveLength(3);
  });

  it('allows only one use of a shared loaded source in initiative order', () => {
    const f = cannonFixture();
    f.context.turn.actions.push({
      memberId: f.context.members[1].id,
      text: 'Fire the cannon too.',
      passed: false,
    });
    const input = normalizeCombatInput(f.context, {
      actions: f.context.members.map((member) => ({
        memberId: member.id,
        main: 'creative',
        effect: 'damage',
        targetId: 'enemy-0',
        stat: 'INT',
        environment: f.profile,
      })),
    });
    const result = f.execute(input);
    expect(f.context.scene.encounter!.enemies[0].hp).toBe(23);
    expect(result.events).toContainEqual(
      expect.objectContaining({ status: 'blocked', fact: expect.stringContaining('needs reloading') }),
    );
  });

  it('does not turn a peaceful interaction or selected ability into environmental damage', () => {
    const f = cannonFixture('I inspect the mounted cannon.');
    expect(f.plan().actions[0]).toMatchObject({ main: 'interact', targetId: null });
    expect(f.plan().actions[0].environment).toBeUndefined();
    f.context.turn.actions[0].text = 'Use Focused strike on the harpooner.';
    f.context.turn.actions[0].abilityName = 'Focused strike';
    expect(f.plan().actions[0]).toMatchObject({ main: 'ability', abilityName: 'Focused strike' });
    expect(f.plan().actions[0].environment).toBeUndefined();
  });

  it('exposes stable public fact references without changing the context', () => {
    const f = cannonFixture();
    const before = structuredClone(f.context);
    expect(environmentalFacts(f.context)['journal:fact:Prepared cannon']).toBe(f.context.journal[0].detail);
    expect(f.context).toEqual(before);
  });
});
