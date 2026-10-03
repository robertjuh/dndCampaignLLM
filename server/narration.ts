import { maxNarrationLength, type Outcome, type Roll } from '../shared/schema';
import type { GMContext } from './game';

type NarrationBeat = { id: string; fact: string };

// Translate fixed engine phrasing; keep names, mechanics and submitted text exact.
const dutchCombatPhrases: [string, string][] = [
  ['Victory. Each surviving character gains ', 'Overwinning. Elk overlevend personage krijgt '],
  [' XP. A physical item must be offered as loot.', ' XP. Een fysiek item moet als loot worden aangeboden.'],
  [
    ' cannot carry out their submitted action because they were downed before their turn.',
    ' kan de ingediende actie niet uitvoeren omdat het personage vóór de beurt Downed raakte.',
  ],
  [
    ' cannot carry out their submitted action because they died before their turn.',
    ' kan de ingediende actie niet uitvoeren omdat het personage vóór de beurt stierf.',
  ],
  [
    "'s off-hand attack has no effect: it requires two distinct light one-handed weapons.",
    "'s off-hand attack heeft geen effect: deze vereist twee verschillende light one-handed weapons.",
  ],
  ["'s minor action has no effect: ", "'s minor action heeft geen effect: "],
  [' The minor action is spent.', ' De minor action is verbruikt.'],
  [
    ' The main action is spent and the use is preserved.',
    ' De main action is verbruikt en de ability use blijft beschikbaar.',
  ],
  [
    ' target is unavailable; the main action is spent and the use is preserved.',
    ' heeft geen beschikbaar doelwit; de main action is verbruikt en de ability use blijft beschikbaar.',
  ],
  [
    ' has no effect: the living ally target is unavailable.',
    ' heeft geen effect: de levende bondgenoot is niet beschikbaar als doelwit.',
  ],
  [
    ' has no effect: the healing is incompatible with ',
    ' heeft geen effect: de healing is niet geschikt voor ',
  ],
  [' has no effect: ', ' heeft geen effect: '],
  [' is already at full health.', ' heeft al volledige HP.'],
  ['; its encounter use is spent.', '; de encounter use is verbruikt.'],
  [
    "'s target is no longer available; the main action is spent.",
    "'s doelwit is niet meer beschikbaar; de main action is verbruikt.",
  ],
  [
    "'s off-hand target is unavailable; the minor action is spent.",
    "'s off-hand doelwit is niet beschikbaar; de minor action is verbruikt.",
  ],
  [
    ' cannot take their healing minor action after dying.',
    ' kan de healing minor action niet uitvoeren na de dood.',
  ],
  [
    ' cannot take their off-hand attack minor action after dying.',
    ' kan de off-hand attack minor action niet uitvoeren na de dood.',
  ],
  [
    ' cannot take their healing minor action after escaping the fight.',
    ' kan de healing minor action niet uitvoeren na het ontsnappen uit het gevecht.',
  ],
  [
    ' cannot take their off-hand attack minor action after escaping the fight.',
    ' kan de off-hand attack minor action niet uitvoeren na het ontsnappen uit het gevecht.',
  ],
  [' rolls a natural 1 with ', ' rolt een natural 1 met '],
  [': the attack fails catastrophically and causes ', ': de attack mislukt catastrofaal en veroorzaakt '],
  [' and causes their death', ' en leidt tot de dood'],
  [' and death', ' en de dood'],
  [' and dies', ' en sterft'],
  [' and is downed', ' en raakt Downed'],
  [' critically hits ', ' geeft een critical hit aan '],
  [' hits ', ' raakt '],
  [' misses ', ' mist '],
  [', killing ', ', waardoor dit doelwit sterft: '],
  [', downing ', ', waardoor dit personage Downed raakt: '],
  [' attacks with advantage', ' voert een attack uit met advantage'],
  [' and +', ' en +'],
  [' recovers ', ' herstelt '],
  [' HP from lifesteal.', ' HP door lifesteal.'],
  [' HP from regeneration after victory.', ' HP door regeneration na de overwinning.'],
  [' rejoins the fight.', ' keert terug in het gevecht.'],
  [' holds position.', ' blijft op de plek.'],
  [' changes equipment as their minor action.', ' wisselt equipment als minor action.'],
  [' is stunned and loses their main action.', ' is Stunned en verliest de main action.'],
  [' defends (+2 defense).', ' verdedigt zich (+2 defense).'],
  [' continues away from the fight.', ' gaat verder weg van het gevecht.'],
  [' escapes the fight.', ' ontsnapt uit het gevecht.'],
  [' cannot escape.', ' kan niet ontsnappen.'],
  [' damage from a catastrophic failed escape', ' damage door een catastrofaal mislukte ontsnapping'],
  [' fails to carry out their movement: ', ' slaagt niet in de verplaatsing: '],
  [' fails to carry out their interaction: ', ' slaagt niet in de interactie: '],
  [' carries out their movement: ', ' voert de verplaatsing uit: '],
  [' carries out their interaction: ', ' voert de interactie uit: '],
  ['movement within the scene', 'verplaatsing binnen de scène'],
  ['interaction within the scene', 'interactie binnen de scène'],
  ["'s risky movement backfires for ", "'s riskante verplaatsing slaat terug met "],
  ["'s risky interaction backfires for ", "'s riskante interactie slaat terug met "],
  ["'s improvised action backfires for ", "'s geïmproviseerde actie slaat terug met "],
  ["'s approach persuades ", "'s aanpak overtuigt "],
  [' to stop fighting.', ' om te stoppen met vechten.'],
  ["'s maneuver prevents ", "'s manoeuvre voorkomt "],
  ["'s next attack.", "'s volgende attack."],
  ["'s creative action deals ", "'s creatieve actie veroorzaakt "],
  [' damage to ', ' damage bij '],
  ["'s creative action fails.", "'s creatieve actie mislukt."],
  [' uses a healing consumable on ', ' gebruikt een healing consumable bij '],
  [' uses a healing consumable.', ' gebruikt een healing consumable.'],
  [', helping them up', ', waardoor dit personage weer overeind komt'],
  [' is unable to attack this round.', ' kan deze ronde geen attack uitvoeren.'],
  [' catastrophically fails and suffers 2 damage', ' faalt catastrofaal en krijgt 2 damage'],
  [' becomes ', ' krijgt '],
  [' takes ', ' krijgt '],
  [' uses ', ' gebruikt '],
  [' gains +', ' krijgt +'],
  [' gains advantage', ' krijgt advantage'],
  [' defense against the next enemy attack.', ' defense tegen de volgende enemy attack.'],
  [' on their next attack.', ' op de volgende attack.'],
  ['Choose an inventory item and an equipment slot.', 'Kies een inventory item en een equipment slot.'],
  ['Choose a healing consumable.', 'Kies een healing consumable.'],
  ['The healing target is unavailable.', 'Het doelwit voor healing is niet beschikbaar.'],
  [
    'The target is already at full health; the consumable is preserved.',
    'Het doelwit heeft al volledige HP; de consumable blijft beschikbaar.',
  ],
  ['A dead character cannot be healed.', 'Een overleden personage kan geen healing ontvangen.'],
  [
    'This healing item is incompatible with your character.',
    'Dit healing item is niet geschikt voor het personage.',
  ],
  ['That item is not in your backpack.', 'Dat item zit niet in de backpack.'],
  [
    'Backpack full. Choose what to drop before taking this item.',
    'De backpack is vol. Kies wat je weglegt voordat je dit item pakt.',
  ],
  [
    'Your character’s anatomy prevents using that equipment slot.',
    'De anatomie van het personage verhindert het gebruik van dat equipment slot.',
  ],
  [
    'Your character’s anatomy prevents using a two-handed item.',
    'De anatomie van het personage verhindert het gebruik van een two-handed item.',
  ],
  ['This item requires ', 'Dit item vereist '],
  ['This item does not fit that slot.', 'Dit item past niet in dat slot.'],
  [
    'Your traits prevent using heavy strength weapons or plate armour.',
    'De traits verhinderen het gebruik van heavy strength weapons of plate armour.',
  ],
  [' from ', ' door '],
  [' with ', ' met '],
  [' for ', ' voor '],
];

function combatFact(context: GMContext, fact: string): string {
  if (context.config.language !== 'Nederlands') return fact;
  const names = [
    ...new Set([
      ...context.members.flatMap((member) => [
        member.character.name,
        ...member.character.abilities.map((ability) => ability.name),
        ...member.state.inventory.map((item) => item.name),
        ...Object.values(member.state.equipment).flatMap((item) => (item ? [item.name] : [])),
      ]),
      ...(context.combatResult?.encounter.enemies.map((enemy) => enemy.name) ?? []),
      ...(context.combatResult?.characters.map((character) => character.name) ?? []),
      ...context.turn.actions.flatMap((action) => (action.characterName ? [action.characterName] : [])),
      ...context.turn.actions.flatMap((action) => [action.text, action.text.slice(0, 500)]),
    ]),
  ]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const protectedText: string[] = [];
  if (names.length)
    fact = fact.replace(
      new RegExp(names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g'),
      (name) => `\u0000${protectedText.push(name) - 1}\u0000`,
    );
  for (const [english, dutch] of dutchCombatPhrases) fact = fact.replaceAll(english, dutch);
  return fact.replace(/\u0000(\d+)\u0000/g, (_, index) => protectedText[Number(index)]);
}

export function narrationBeats(
  context: GMContext,
  rolls: Roll[] = context.turn.rolls,
  changes: Outcome['changes'] = [],
): NarrationBeat[] {
  if (context.combatResult)
    return context.combatResult.logs.map((fact, index) => ({
      id: `combat:${index}`,
      fact: combatFact(context, fact),
    }));
  const dutch = context.config.language === 'Nederlands';
  return context.turn.actions.map((action) => {
    const member = context.members.find((member) => member.id === action.memberId);
    const name = action.characterName ?? member?.character.name ?? action.memberId;
    const attempt = action.text.length > 500 ? `${action.text.slice(0, 500)}…` : action.text;
    const facts = [
      action.passed
        ? dutch
          ? `${name} wacht en onderneemt geen actie.`
          : `${name} waits and takes no action.`
        : dutch
          ? `${name} probeert: ${attempt}${action.abilityName ? ` (met ${action.abilityName})` : ''}`
          : `${name} attempts: ${attempt}${action.abilityName ? ` (using ${action.abilityName})` : ''}`,
    ];
    if (!action.passed)
      for (const roll of rolls.filter((roll) => roll.memberId === action.memberId && !roll.notation))
        facts.push(
          dutch
            ? `${name}'s ${roll.stat} check ${roll.success ? 'slaagt' : 'mislukt'} (${roll.total} tegen DC ${roll.dc})${roll.critical === 'success' ? ': natural 20, uitzonderlijk succes' : roll.critical === 'failure' ? ': natural 1, catastrofale mislukking' : ''}.${roll.abilityName ? ` ${name} gebruikt ${roll.abilityName}, waarbij de ability use wordt verbruikt.` : ''}${roll.lethal && roll.critical === 'failure' ? ` ${name} sterft door de levensgevaarlijke actie.` : ''}`
            : `${name}'s ${roll.stat} check ${roll.success ? 'succeeds' : 'fails'} (${roll.total} against DC ${roll.dc})${roll.critical === 'success' ? ': natural 20, extraordinary success' : roll.critical === 'failure' ? ': natural 1, catastrophic failure' : ''}.${roll.abilityName ? ` ${name} uses ${roll.abilityName}, spending its use.` : ''}${roll.lethal && roll.critical === 'failure' ? ` ${name} dies from the lethal action.` : ''}`,
        );
    for (const receipt of context.resourceUses?.filter((receipt) => receipt.memberId === action.memberId) ??
      []) {
      const target = context.members.find((member) => member.id === (receipt.targetId ?? action.memberId));
      facts.push(
        dutch
          ? `${name} gebruikt ${receipt.sourceName}, ${receipt.itemId ? 'waarbij één item wordt verbruikt' : 'waarbij de ability use wordt verbruikt'}${receipt.restored > 0 ? `, en herstelt ${receipt.restored} HP bij ${target?.character.name ?? name}` : ''}.`
          : `${name} uses ${receipt.sourceName}, ${receipt.itemId ? 'consuming one item' : 'spending its ability use'}${receipt.restored > 0 ? `, restoring ${receipt.restored} HP to ${target?.character.name ?? name}` : ''}.`,
      );
    }
    for (const change of changes.filter((change) => change.memberId === action.memberId)) {
      if (change.type === 'hp' && change.amount !== 0)
        facts.push(
          dutch
            ? `${name} ${change.amount < 0 ? 'verliest' : 'herstelt'} ${Math.abs(change.amount)} HP: ${change.reason}`
            : `${name} ${change.amount < 0 ? 'loses' : 'recovers'} ${Math.abs(change.amount)} HP: ${change.reason}`,
        );
      if (change.type === 'condition')
        facts.push(
          dutch
            ? `${name} ${change.remove ? 'verliest' : 'krijgt'} ${change.name}: ${change.reason}`
            : `${name} ${change.remove ? 'loses' : 'gains'} ${change.name}: ${change.reason}`,
        );
    }
    return { id: `action:${action.memberId}`, fact: facts.join(' ') };
  });
}

export function assembleNarration(
  narration: string,
  beats: NarrationBeat[],
  eventNarrations: unknown,
): string {
  if (!beats.length) return narration;
  const prose =
    eventNarrations && typeof eventNarrations === 'object' && !Array.isArray(eventNarrations)
      ? (eventNarrations as Record<string, unknown>)
      : {};
  const paragraphs = beats.map((beat) => beat.fact);
  // Reserve every outcome before adding atmosphere or richer prose. Never cut off later actors.
  let remaining = maxNarrationLength - paragraphs.join('\n\n').length;
  for (let index = 0; index < beats.length; index++) {
    const value = Object.hasOwn(prose, beats[index].id) ? prose[beats[index].id] : undefined;
    if (typeof value !== 'string' || !value.trim()) continue;
    const detail = value.trim();
    const fact = beats[index].fact;
    const text = detail.includes(fact) ? detail : `${fact} ${detail}`;
    const extra = text.length - paragraphs[index].length;
    if (extra > remaining) continue;
    paragraphs[index] = text;
    remaining -= extra;
  }
  const intro = narration.trim();
  const includeIntro = intro.length > 0 && intro.length + 2 <= remaining;
  return [...(includeIntro ? [intro] : []), ...paragraphs].join('\n\n');
}
