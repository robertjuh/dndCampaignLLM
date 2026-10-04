import type { z } from 'zod';
import { combatSchema, lootSchema, type CombatInput, type Member } from '../shared/schema';
import { isDowned, naturalWeapon } from '../shared/rules';
import type { GMContext } from './game';
import { requestedAbility, requestedConsumable } from './action-resources';

type CombatAction = CombatInput['actions'][number];
const fields = combatSchema.shape.actions.element.shape;
const object = (input: unknown): Record<string, unknown> =>
  input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
const parse = <T>(schema: z.ZodType<T>, input: unknown, fallback: T): T => {
  const result = schema.safeParse(input);
  return result.success ? result.data : fallback;
};
const mentions = (text: string, name: string) => !!name && text.includes(name.toLowerCase());
const diplomatic = (text: string) =>
  /\b(?:persuad\w*|negotiat\w*|diplomacy|peace|surrender|parley|convince|overtuig\w*|onderhandel\w*|vrede)\b/.test(
    text,
  );
const returningToCombat = (text: string) =>
  /(?:^|[;:,.!?]|\b(?:and|then|en|dan)\b)\s*(?:(?:i|ik)\s+(?:(?:will|want to|try to|attempt to|wil|probeer te)\s+)?)?(?:re[- ]?engage|rejoin\s+(?:the\s+)?(?:fight|battle|combat)|(?:return|go|move|come|head)\s+(?:back\s+)?(?:to|into)\s+(?:the\s+)?(?:fight|battle|combat)|(?:ga|loop|keer)\s+terug\s+(?:naar|in)\s+(?:(?:het|de)\s+)?(?:gevecht|strijd)|doe\s+weer\s+mee\s+(?:aan|met)\s+(?:(?:het|de)\s+)?(?:gevecht|strijd))\b/.test(
    text.split(/\b(?:before|after|while|voordat|nadat|terwijl)\b/)[0],
  );

function submittedIntent(text: string, proposed: unknown): CombatAction['main'] | undefined {
  // ponytail: guard clear English/Dutch intent; the model handles idioms, not a full language parser.
  const primary = text.split(/\b(?:before|after|while|voordat|nadat|terwijl)\b/)[0];
  const refusal =
    /\b(?:do not|don't|won't|will not|refuse to)\s+(?:attack|fight|shoot|strike|hit)\b|\b(?:niet aanvallen|niet vechten|geen aanval)\b/g;
  const refusesAttack = refusal.test(primary);
  const intent = primary.replace(refusal, '');
  const choices: CombatAction['main'][] = [];
  if (
    /(?:^|[;:,.!?]|\b(?:and|then|en|dan)\b)\s*(?:(?:i|ik)\s+(?:(?:will|want to|try to|attempt to|wil|probeer te)\s+)?)?(?:flee|escape(?!\s+(?:hatch|route|door|pod))|retreat|run away|vlucht(?:en)?|ontsnap(?:pen)?|trek terug)\b/.test(
      intent,
    )
  )
    choices.push('flee');
  if (
    /(?:^|[;:,.!?]|\b(?:and|then|en|dan|to|om)\b)\s*(?:(?:i|ik)\s+(?:(?:will|want to|try to|attempt to|wil|probeer te)\s+)?)?(?:attack|strike|hit|shoot|stab|punch|kick|bite|slash|blast|fire(?!\s+up)|aanval|aanvallen|schiet|sla|steek|schop|bijt)\b/.test(
      intent,
    )
  )
    choices.push('attack');
  if (/\b(?:defend|guard|protect|take cover|verdedig\w*|bescherm\w*|bewaak)\b/.test(intent))
    choices.push('defend');
  if (diplomatic(intent)) choices.push('creative');
  if (
    /\b(?:move|walk|crawl|climb|advance|continue (?:deeper|forward|through)|go|loop|kruip|klim|beweeg\w*|ga|verder)\b/.test(
      intent,
    )
  )
    choices.push('move');
  if (
    /\b(?:cry|weep|mourn|kiss|hug|wave|goodbye|farewell|wait|watch|look|listen|search|inspect|explor\w*|talk|chat|say|huil\w*|kus\w*|knuffel\w*|zwaai|afscheid|wacht|kijk|luister|zoek|onderzoek|verken\w*|praat)\b/.test(
      intent,
    ) ||
    refusesAttack
  )
    choices.push('interact');
  if (/\b(?:or|of)\b/.test(primary) && choices.includes(proposed as CombatAction['main']))
    return proposed as CombatAction['main'];
  return choices[0];
}

function chooseWeapon(member: Member, text: string, action: CombatAction) {
  const equipped = (['right', 'left'] as const).filter(
    (slot) => member.state.equipment[slot]?.kind === 'weapon',
  );
  const namedSlot = equipped.find((slot) => mentions(text, member.state.equipment[slot]!.name));
  if (namedSlot) {
    action.weaponSlot = namedSlot;
    return member.state.equipment[namedSlot]!;
  }
  if (/\bunarmed\b|\bfists?\b|\bpunch\b|\bkick\b|\bbite\b/.test(text)) {
    action.weaponSlot = 'natural';
    return naturalWeapon(member.character);
  }
  const slot = equipped.find((slot) => slot === action.weaponSlot) ?? equipped[0];
  if (slot) {
    action.weaponSlot = slot;
    return member.state.equipment[slot]!;
  }
  action.weaponSlot = 'natural';
  return naturalWeapon(member.character);
}

/** Turn model suggestions into one executable action per actual submission. */
export function normalizeCombatInput(context: GMContext, input?: unknown): CombatInput {
  const proposal = object(input);
  const suggested = Array.isArray(proposal.actions) ? proposal.actions.map(object) : [];
  const enemies = context.scene.encounter?.enemies.filter((enemy) => enemy.hp > 0 && !enemy.withdrawn) ?? [];
  const allies = context.members.filter(
    (member) =>
      context.turn.roster.includes(member.id) &&
      member.state.hp > 0 &&
      !member.state.conditions.includes('Escaped'),
  );
  const healingTargets = context.members.filter((member) => member.state.hp > 0 || isDowned(member.state));
  const actions = context.turn.actions
    .filter((action) => !action.passed)
    .map((submitted): CombatAction => {
      const member = context.members.find((member) => member.id === submitted.memberId)!;
      const chosen = suggested.find((action) => action.memberId === submitted.memberId) ?? {};
      const text = submitted.text.toLowerCase();
      if (submitted.supportAction) {
        const support = submitted.supportAction;
        return {
          memberId: member.id,
          main: support.type === 'help-up' ? 'help-up' : 'heal',
          mainItemId: support.type === 'heal-ally' ? support.itemId : null,
          targetId: support.targetId,
          stat: 'WIS',
          description: submitted.text.slice(0, 500),
          abilityName: null,
          minor: 'none',
          minorItemId: null,
          minorTargetId: null,
          minorSlot: null,
          weaponSlot: null,
        };
      }
      const intent = submittedIntent(text, chosen.main) ?? (returningToCombat(text) ? 'move' : undefined);
      const combatAbility = requestedAbility(
        member.character,
        submitted,
        'combat',
        typeof chosen.abilityName === 'string' ? chosen.abilityName : null,
      );
      const utility =
        member.state.conditions.includes('Escaped') &&
        !returningToCombat(text) &&
        !['attack', 'defend', 'creative'].includes(intent ?? '') &&
        !(combatAbility && combatAbility.name === chosen.abilityName)
          ? requestedAbility(
              member.character,
              submitted,
              'utility',
              typeof chosen.abilityName === 'string' ? chosen.abilityName : null,
            )
          : undefined;
      const ability = utility ?? combatAbility;
      let main = ability ? 'ability' : (intent ?? parse(fields.main, chosen.main, 'interact'));
      if (!ability && main === 'ability') main = intent ?? 'interact';
      if (main === 'heal' || main === 'help-up') main = 'interact';
      let effect =
        main === 'creative' && intent === 'creative'
          ? ('influence' as const)
          : parse(fields.effect, chosen.effect, undefined);
      if (main === 'creative' && !effect) main = 'interact';
      const neutral = main === 'move' || main === 'interact';
      const compatible = chosen.main === main;
      if (neutral) effect = undefined;
      const support = ability && ability.effect !== 'strike';
      const allyTargets = (
        ability && ['mend', 'cleanse'].includes(ability.effect)
          ? healingTargets
          : context.members.filter((ally) => ally.state.hp > 0 && context.turn.roster.includes(ally.id))
      ).map((ally) => ({
        id: ally.id,
        name: ally.character.name,
      }));
      // ponytail: common English/Dutch restrictions; the model handles more complex targeting prose.
      const allowRetarget =
        !/\b(?:only|solely|exclusively|alleen|uitsluitend)\b/.test(text) &&
        parse(fields.allowRetarget, chosen.allowRetarget, true) !== false;
      const targets = support
        ? allyTargets
        : neutral
          ? [...enemies, ...allyTargets]
          : main === 'attack' || ability?.effect === 'strike'
            ? (context.scene.encounter?.enemies ?? [])
            : enemies;
      const namedTargets = targets
        .filter((target) => mentions(text, target.name))
        .sort((a, b) => text.indexOf(a.name.toLowerCase()) - text.indexOf(b.name.toLowerCase()));
      const vagueAttack =
        /^(?:(?:i|ik)\s+)?(?:attack|strike|hit|aanvallen|aanval)(?:\s+(?:(?:the|an|a|de|een)\s+)?(?:enemy|opponent|foe|vijand))?\s*[.!?]?\s*$/.test(
          text,
        );
      const target =
        namedTargets[0] ??
        targets.find(
          (target) =>
            target.id ===
            ((main === 'attack' && allowRetarget && vagueAttack) || (neutral && !compatible)
              ? null
              : chosen.targetId),
        ) ??
        (support
          ? targets.find((target) => target.id === member.id)
          : neutral || main === 'attack'
            ? undefined
            : enemies[0]);
      const fallbackText =
        text.split(/\b(?:otherwise|else|anders)\b/)[1] ??
        text.match(
          /\b(?:if|als)\b.+?\b(?:attack|strike|hit|shoot|stab|aanval(?:len)?|schiet|sla|steek)\b(.+)/,
        )?.[1];
      const backups = enemies.filter(
        (enemy) => enemy.id !== target?.id && fallbackText && mentions(fallbackText, enemy.name),
      );
      const backup = fallbackText
        ? (backups.find((enemy) => enemy.id === chosen.backupTargetId) ?? backups[0])
        : undefined;
      let minor = parse(fields.minor, chosen.minor, 'none');
      const healingItem = requestedConsumable(
        member,
        submitted,
        typeof chosen.minorItemId === 'string'
          ? chosen.minorItemId
          : typeof chosen.mainItemId === 'string'
            ? chosen.mainItemId
            : null,
      );
      if (healingItem?.healing) minor = 'heal';
      if (
        minor === 'offhand' &&
        (!(main === 'attack' || (main === 'ability' && ability?.effect === 'strike')) ||
          !/\b(?:off[- ]?hand|both (?:arms|hands|weapons)|two weapons|second (?:attack|strike)|dual[- ]?wield|beide (?:armen|handen|wapens)|twee wapens|tweede (?:aanval|slag))\b/.test(
            text,
          ))
      )
        minor = 'none';
      if (minor === 'heal' && !healingItem?.healing) minor = 'none';
      if (minor === 'equip') minor = 'none';
      const action: CombatAction = {
        memberId: member.id,
        main,
        mainItemId: null,
        reengage:
          member.state.conditions.includes('Escaped') &&
          (returningToCombat(text) ||
            main === 'attack' ||
            main === 'defend' ||
            main === 'creative' ||
            (!!ability && ability.kind === 'combat' && !['mend', 'cleanse'].includes(ability.effect)) ||
            minor === 'offhand'),
        abilityName: ability?.name ?? null,
        targetId: target?.id ?? null,
        allowRetarget,
        backupTargetId: !support && !neutral && allowRetarget ? (backup?.id ?? null) : null,
        stat:
          ability?.stat ??
          parse(
            fields.stat,
            neutral && !compatible ? undefined : chosen.stat,
            main === 'move' ? 'DEX' : neutral ? 'INT' : 'STR',
          ),
        description: (!neutral && compatible && typeof chosen.description === 'string'
          ? chosen.description
          : submitted.text
        ).slice(0, 500),
        minor,
        minorItemId: minor === 'none' ? null : parse(fields.minorItemId, chosen.minorItemId, null),
        minorTargetId:
          minor === 'heal'
            ? (healingTargets.find((ally) => ally.id !== member.id && mentions(text, ally.character.name))
                ?.id ??
              healingTargets.find((ally) => ally.id === chosen.minorTargetId)?.id ??
              null)
            : null,
        minorSlot: minor === 'none' ? null : (parse(fields.minorSlot, chosen.minorSlot, null) ?? null),
        weaponSlot: neutral ? null : parse(fields.weaponSlot, chosen.weaponSlot, null),
        dc: neutral && !compatible ? undefined : parse(fields.dc, chosen.dc, undefined),
        effect,
        cureCondition:
          main === 'interact' && compatible ? parse(fields.cureCondition, chosen.cureCondition, null) : null,
      };
      if (action.cureCondition) {
        const treatmentTarget =
          healingTargets.find((ally) => mentions(text, ally.character.name) && ally.id !== member.id) ??
          healingTargets.find((ally) => ally.id === chosen.targetId) ??
          member;
        action.targetId = treatmentTarget.id;
        action.weaponSlot = null;
        action.mainItemId = requestedConsumable(member, submitted)?.id ?? null;
        if (action.mainItemId) {
          action.minor = 'none';
          action.minorItemId = null;
          action.minorTargetId = null;
        }
      }
      if (minor === 'heal') action.minorItemId = healingItem?.id ?? null;
      const namedAlly = context.members.find(
        (ally) => ally.id !== member.id && mentions(text, ally.character.name),
      );
      const helpsUp = /\b(?:help\s+.+\s+(?:up|overeind)|help\s+.+\s+op)\b/.test(text);
      if (!action.cureCondition && (!ability || healingItem) && (helpsUp || (healingItem && namedAlly))) {
        action.main = healingItem ? 'heal' : 'help-up';
        action.mainItemId = healingItem?.id ?? null;
        action.targetId = namedAlly?.id ?? null;
        action.abilityName = null;
        action.minor = 'none';
        action.minorItemId = null;
        action.minorTargetId = null;
        action.minorSlot = null;
        action.weaponSlot = null;
        action.effect = undefined;
        action.dc = undefined;
      }
      if (namedAlly && (support || neutral || ['help-up', 'heal'].includes(action.main)))
        action.targetId = namedAlly.id;
      if (
        (support || neutral) &&
        !namedAlly &&
        compatible &&
        context.members.some((ally) => ally.id === chosen.targetId)
      )
        action.targetId = chosen.targetId as string;
      if (utility) {
        action.targetId = namedAlly?.id ?? (typeof chosen.targetId === 'string' ? chosen.targetId : null);
        action.dc ??= 10;
      }
      if (action.main === 'attack') action.stat = chooseWeapon(member, text, action).scaling[0] ?? 'STR';
      return action;
    });
  const targets = Array.isArray(proposal.enemyTargets) ? proposal.enemyTargets.map(object) : [];
  const returning = actions.filter((action) => action.reengage).map((action) => action.memberId);
  const enemyTargets = targets
    .filter(
      (target, index) =>
        enemies.some((enemy) => enemy.id === target.enemyId) &&
        (allies.some((ally) => ally.id === target.memberId) ||
          returning.includes(target.memberId as string)) &&
        targets.findIndex((other) => other.enemyId === target.enemyId) === index,
    )
    .map(({ enemyId, memberId }) => ({ enemyId, memberId }));
  return combatSchema.parse({
    actions,
    enemyTargets,
    loot: parse(lootSchema, proposal.loot, {
      name: (context.config.language === 'Nederlands'
        ? `Buit van ${enemies[0]?.name ?? 'het gevecht'}`
        : `Salvage from ${enemies[0]?.name ?? 'the encounter'}`
      ).slice(0, 80),
      kind: 'relic',
      scaling: [],
      hands: 1,
      light: false,
      description:
        `${context.config.language === 'Nederlands' ? 'Gevonden in' : 'Recovered in'} ${context.scene.location.name}.`.slice(
          0,
          500,
        ),
    }),
  });
}
