import type { GMContext } from './game';
import { requestsPickup } from './turn-pickups';

export type ActionObligation = {
  kind: 'search' | 'inspect' | 'talk' | 'collect' | 'use';
  /** The player's actual words, for a correction that names the omitted action. */
  evidence: string;
  index: number;
  /** Explicitly follows a journey in this submission; not inferred from world state. */
  afterTravel: boolean;
};

const verbs =
  /\b(search(?:ing)?|investigat(?:e|ing)|doorzoek(?:en)?|onderzoek(?:en)?|zoek(?:en)?|inspect(?:ing)?|examin(?:e|ing)|inspecteer|bekijk(?:en)?|ask(?:ing)?|question(?:ing)?|talk(?:ing)?\s+(?:to|with)|speak(?:ing)?\s+(?:to|with)|meet(?:ing)?\s+(?:with\s+)?|vraag|ondervraag|praat\s+(?:met|tegen)|spreek\s+met|use|using|gebruik|take|collect|grab|pocket|pick\s+(?:\w+\s+){0,3}up|neem|pak|verzamel|raap)\b/giu;
const nonAction =
  /\b(?:not|never|don['’]t|won['’]t|can['’]t|cannot|would|could|might|if|unless|niet|nooit|geen|zou|zouden|misschien|als|tenzij)\b/iu;
const travel =
  /\b(?:go(?:ing)?|walk(?:ing)?|head(?:ing)?|travel(?:ling|ing)?|move|moving|return(?:ing)?|ga|gaan|loop|lopen|reis|reizen|keer)\s+(?:(?:back|over|straight|terug)\s+)*(?:to|towards?|into|inside|outside|upstairs|downstairs|through|naar|richting|in|binnen)\b|\b(?:enter|descend|ascend)\s+|\b(?:follow(?:ing)?|volg(?:en)?)\s+(?:(?:the|a|my|de|het|een)\s+)?(?:cart|caravan|wagon|kar|wagen|karavaan)\b/iu;

/**
 * ponytail: a conservative omission guard, not a natural-language action parser.
 * The GM still interprets targets, feasibility, action budget and ambiguous language.
 * These explicit affirmative requests need an outcome; a move alone is insufficient.
 */
export function actionObligations(text: string): ActionObligation[] {
  // Preserve offsets while excluding quoted instructions and quoted speech.
  const unquoted = text.replace(
    /"[^"\n]*"|“[^”\n]*”|(?<![\p{L}\p{N}])'(?:[^'\n]|(?<=[\p{L}\p{N}])'(?=[\p{L}\p{N}]))*'(?![\p{L}\p{N}])/gu,
    (quote) => ' '.repeat(quote.length),
  );
  const obligations: ActionObligation[] = [];
  let travelled = false;
  // Sentence/contrast boundaries reset negation. Conjoined verbs keep their own
  // evidence while a conditional or negative introduction remains excluded.
  for (const sentence of unquoted.matchAll(/[^.;!\n]+/gu)) {
    let excluded = false;
    for (const clause of sentence[0].matchAll(
      /(?:^|\b(?:and|then|en|daarna|but|maar)\b)(.*?)(?=\b(?:and|then|en|daarna|but|maar)\b|$)/giu,
    )) {
      const raw = clause[1];
      const start = sentence.index! + clause.index! + clause[0].length - raw.length;
      if (/^\b(?:but|maar)\b/iu.test(clause[0].trim())) excluded = false;
      const actions = [...raw.matchAll(verbs)];
      if (nonAction.test(raw.slice(0, actions[0]?.index ?? raw.length))) excluded = true;
      if (excluded) continue;
      const crossing = travel.exec(raw);
      let speaking = false;
      for (const match of actions) {
        if (speaking) break; // A requested search inside a question belongs to its addressee.
        const verb = match[0].toLowerCase();
        const before = raw.slice(0, match.index);
        const after = raw.slice(match.index! + match[0].length);
        if (/^\s+(?:not|niet|nooit|geen)\b/iu.test(after)) continue;
        // Looking for a place to reach is navigation, not an invented local search.
        if (
          /^(?:zoek|zoeken)$/u.test(verb) &&
          /^\s+(?:de\s+weg|een\s+weg|naar\s+(?:de|het)\s+\w+\s+(?:om|waar))/iu.test(after)
        )
          continue;
        if (/^(?:meet|meeting)/u.test(verb) && /^\s+(?:up\b|the\s+(?:road|path|route)\b)/iu.test(after))
          continue;
        if (
          /^(?:use|using|gebruik)$/u.test(verb) &&
          /^\s+(?:(?:the|a|my|de|het|een|mijn)\s+)?(?:road|path|route|stairs?|steps?|weg|route|trap|trappen)\b/iu.test(
            after,
          )
        )
          continue;
        const kind: ActionObligation['kind'] = /^(?:search|investigat|doorzoek|onderzoek|zoek)/u.test(verb)
          ? 'search'
          : /^(?:inspect|examin|bekijk)/u.test(verb)
            ? 'inspect'
            : /^(?:ask|question|talk|speak|meet|vraag|ondervraag|praat|spreek)/u.test(verb)
              ? 'talk'
              : /^(?:use|using|gebruik)$/u.test(verb)
                ? 'use'
                : 'collect';
        if (kind !== 'talk' && /\b(?:niet|nooit|geen)\b/iu.test(after)) continue;
        // Reuse the inventory consent guard, including its movement/observation idioms.
        if (kind === 'collect' && !requestsPickup(raw.slice(match.index))) continue;
        // "a search party", "the question", "for use" describe things, not acts.
        if (
          /\b(?:a|an|the|een|de|het|for|voor|my|your|his|her|our|their|zijn|haar|hun|ons|onze|about|of)\s*$/iu.test(
            before,
          )
        )
          continue;
        obligations.push({
          kind,
          evidence: text.slice(start + match.index!, start + raw.length).trim(),
          index: start + match.index!,
          afterTravel: travelled || !!(crossing && crossing.index < match.index!),
        });
        if (kind === 'talk') speaking = true;
      }
      if (crossing) travelled = true;
    }
  }
  return obligations;
}

export function submittedActionObligations(context: GMContext, memberId: string) {
  const submitted = context.turn.actions.find((action) => action.memberId === memberId);
  return submitted && !submitted.passed && !submitted.gathering
    ? actionObligations(submitted.text).map((obligation) => ({
      ...obligation, id: `intent:${obligation.index}`,
      beforeTravel: !obligation.afterTravel && /\b(?:and|then|en|daarna)\s+(?:(?:I|ik)\s+)?(?:go|walk|travel|move|enter|descend|ascend|ga|loop|reis)\b/i.test(submitted.text.slice(obligation.index + obligation.evidence.length)),
    }))
    : [];
}
