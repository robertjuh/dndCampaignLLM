import type { Ability, Action, Character, CharacterState, Member, Scene } from '../shared/schema';
import { availableAbilities } from '../shared/rules';
import { npcNames } from '../shared/npcs';

const resourceText = (text: string) =>
  text
    .split(/(\b(?:but|maar)\b|[;.!?])/i)
    .filter(
      (clause) =>
        !/\b(?:do not|don't|will not|won't|never)\s+(?:use|activate|invoke|drink|consume|take|apply)\b|\b(?:gebruik\w*|activeer\w*|drink\w*|neem)\b[^.!?;]*\b(?:niet|geen)\b/i.test(
          clause,
        ),
    )
    .join('');
const mentionsName = (text: string, name: string) =>
  new RegExp(`(?:^|\\W)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\W)`, 'i').test(text);

export function requestedHealingNPC(scene: Pick<Scene, 'npcs'>, text: string) {
  const treatment = resourceText(text).split(/\b(?:and|then|while|en|dan|terwijl)\b/i).filter((clause) =>
    /\b(?:heal\w*|treat\w*|mend|revive\w*|genees\w*|(?:use|apply|gebruik\w*)\b.*\bon)\b/i.test(clause) &&
    !/\b(?:myself|self|me|mijzelf|mezelf|drink\w*)\b/i.test(clause),
  ).join(' ');
  const matches = Object.values(scene.npcs ?? {}).filter((npc) => npcNames(npc).some((name) => {
    const parts = name.split(/\s+/);
    return mentionsName(treatment, name) || [parts[0], parts.at(-1)!].some(
      (part) => part.length > 3 && mentionsName(treatment, part),
    );
  }));
  return matches.length === 1 ? matches[0] : undefined;
}

export function requestsAbility(text: string): boolean {
  // ponytail: English/Dutch intent guard; the model handles other languages and idioms.
  text = resourceText(text);
  return /\b(?:use(?:d)?|using|activate(?:d)?|activating|invoke(?:d)?|perform|with|try|gebruik\w*|activeer\w*|met|zet\w*)\s+(?:(?!(?:no|not|never|without|geen|niet|zonder|to|om|and|en|his|her|their|zijn|haar|hun|recharge|regain|restore|recover)\b)[\p{L}\p{M}'’\-]+\s+){0,5}(?:abilit(?:y|ies)|powers?|skills?|techniques?|magic|spells?|special move|vaardighe(?:id|den)|krachten?|techniek(?:en)?|vermogen(?:s)?|magie|spreuk(?:en)?|speciale (?:aanval|actie|zet))\b/iu.test(
    text,
  );
}

export function requestedAbility(
  character: Character,
  action: Action,
  kind: Ability['kind'] | undefined,
  suggestedName?: string | null,
  state?: CharacterState,
): Ability | undefined {
  if (action.passed || action.supportAction || action.gathering) return undefined;
  const all = availableAbilities(character, state);
  const abilities = all.filter((ability) => !kind || ability.kind === kind);
  if (action.abilityName) return abilities.find((ability) => ability.name === action.abilityName);
  const text = resourceText(action.text);
  const named = all.find(
    (ability) =>
      mentionsName(text, ability.name) ||
      (!!ability.equipmentId &&
        mentionsName(
          text,
          Object.values(state!.equipment).find((item) => item?.id === ability.equipmentId)!.grantedAbility!
            .name,
        )),
  );
  if (named) return !kind || named.kind === kind ? named : undefined;
  if (!requestsAbility(text)) return undefined;
  const category = text
    .match(/\b(combat|utility)\s+(?:ability|abilities|skill|power)\b/i)?.[1]
    ?.toLowerCase();
  if (category && kind && category !== kind) return undefined;
  const suggested = all.find((ability) => ability.name.toLowerCase() === suggestedName?.toLowerCase());
  if (suggested)
    return abilities.includes(suggested) && (!category || suggested.kind === category)
      ? suggested
      : undefined;
  const eligible = category ? abilities.filter((ability) => ability.kind === category) : abilities;
  return eligible.length === 1 && !/\b(?:or|of)\b/i.test(text) ? eligible[0] : undefined;
}

export function requestedConsumable(
  member: Pick<Member, 'character' | 'state'>,
  action: Action,
  suggestedId?: string | null,
  inferHealing = true,
): CharacterState['inventory'][number] | undefined {
  if (action.passed || action.supportAction || action.gathering) return undefined;
  let text = resourceText(action.text);
  const ability = requestedAbility(member.character, action, undefined, null, member.state);
  if (ability)
    text = text.replace(
      new RegExp(`(?:^|\\W)${ability.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\W)`, 'gi'),
      ' ',
    );
  if (
    !/\b(?:use(?:d)?|using|drink\w*|drank|consume\w*|take|apply|heal(?:ed|s)?|revive(?:d|s)?|gebruik\w*|neem|genees(?:t|de)?)\b/i.test(
      text,
    )
  )
    return undefined;
  const items = member.state.inventory.filter((item) => item.kind === 'consumable');
  const named = items.find((item) => mentionsName(text, item.name));
  if (named) return named;
  const concrete =
    /\b(?:potion|medkit|bandag\w*|consumable|healing item|drank\w*|verband|geneesmiddel|drink\w*|consume\w*)\b/i.test(
      text,
    );
  const healing = /\b(?:heal\w*|revive|genees\w*)\b/i.test(text);
  if (!concrete && (!inferHealing || !healing || action.abilityName || requestsAbility(text) || ability))
    return undefined;
  return items.find((item) => item.id === suggestedId) ?? items.find((item) => item.healing > 0);
}
