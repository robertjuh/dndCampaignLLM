import type { Ability, Action, Character, CharacterState, Member } from '../shared/schema';

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

export function requestsAbility(text: string): boolean {
  // ponytail: English/Dutch intent guard; the model handles other languages and idioms.
  text = resourceText(text);
  return (
    /\b(?:abilit(?:y|ies)|power|skill|technique|special move|vaardighe(?:id|den)|kracht|techniek|vermogen|speciale (?:aanval|actie|zet))\b/i.test(
      text,
    ) &&
    /\b(?:use(?:d)?|using|activate(?:d)?|activating|invoke(?:d)?|perform|with|try|gebruik\w*|activeer\w*|met|zet\w*)\b/i.test(
      text,
    )
  );
}

export function requestedAbility(
  character: Character,
  action: Action,
  kind: Ability['kind'],
  suggestedName?: string | null,
): Ability | undefined {
  if (action.passed) return undefined;
  const abilities = character.abilities.filter((ability) => ability.kind === kind);
  if (action.abilityName) return abilities.find((ability) => ability.name === action.abilityName);
  const text = resourceText(action.text);
  const named = character.abilities.find((ability) => mentionsName(text, ability.name));
  if (named) return named.kind === kind ? named : undefined;
  if (!requestsAbility(text)) return undefined;
  return (
    abilities.find((ability) => ability.name.toLowerCase() === suggestedName?.toLowerCase()) ??
    (abilities.length === 1 && !/\b(?:or|of)\b/i.test(text) ? abilities[0] : undefined)
  );
}

export function requestedConsumable(
  member: Pick<Member, 'character' | 'state'>,
  action: Action,
  suggestedId?: string | null,
): CharacterState['inventory'][number] | undefined {
  if (action.passed) return undefined;
  const text = resourceText(action.text);
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
  if (
    !concrete &&
    (!healing ||
      action.abilityName ||
      requestsAbility(text) ||
      requestedAbility(member.character, action, 'combat') ||
      requestedAbility(member.character, action, 'utility'))
  )
    return undefined;
  return items.find((item) => item.id === suggestedId) ?? items.find((item) => item.healing > 0);
}
