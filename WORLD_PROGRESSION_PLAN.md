# World progression

Repeated searches and travel should change what the party can understand or affect. Progress can be a consequential discovery, an NPC acting on an established concern, a visible threat changing, or an objective being resolved. It does not require combat, treasure, a new obstacle, or an action chosen for a player.

## Implemented contract

1. Supply the adjudicator with existing public threads from the premise, party goal, journal, character motivations and recent factual history. Continue those threads instead of inventing a replacement mystery after each clue.
2. Track consecutive meaningful turns without progress by canonical location. Characters together share a counter; separated locations retain independent counters when screen focus changes. Passes, information-only orientation, blocked acts and engine-owned combat/support do not increase it.
3. Require a concrete development by the second meaningful local turn without progress. Every first arrival also needs understandable significance tied to an existing thread. Ordinary travel covers one meaningful adjacent stretch; it must not substitute another equivalent patch of trail for arrival.
4. Record development in `worldProgress`: its location, public world event, kind, existing thread ID and changed journal entry containing that concise progress fact. Reject missing/locality-breaking evidence, invented thread IDs, unrelated or unchanged journal facts and exact repeated information. Update the saved counter and recent facts once with finalization; retries retain their original state. Recovery preserves retained journal facts.
5. Keep failed main actions failed. A failed search can reveal a distinct lesser opportunity, or trigger a proportionate established-world response, using an occurrence dependency on the failed check. It cannot reveal the failed goal, reverse dice, force a player decision, invent damage, or force combat to satisfy pacing.

The server checks structure, locality, continuity anchors, durable updates and repeated facts. Fictional significance remains the adjudicator's job: prose paraphrases cannot be proved equivalent with a keyword filter. The prompt explicitly requires an actionable change in knowledge or world state; repeated weather, obscured views and another unspecified clue do not qualify.

## Examples

For a missing caravan thread, a development could establish a survivor who witnessed its diversion, recognizable evidence of an already established faction's involvement, or a concrete destination and what happened there. An unsuccessful search for the captives keeps their whereabouts unknown; a visible loading ramp or a survivor independently arriving may establish a different opportunity without granting the failed answer.

A newly entered workshop should expose its working mechanism, present occupants and concern, consequential evidence, or a resolved connection to the journey. It need not hide another compulsory puzzle. Completed escape and investigation objectives are recorded as complete rather than extended with a new mandatory step.

## Compatibility and verification

Existing saves begin with no counters. Old accepted checkpoints lacking `worldProgress` retain their original contract. New model adjudications supply `worldProgress: []` and evidence when due; the server normalizes omitted fields so omission cannot bypass the contract. There is no extra model stage, dependency, retroactive reroll, or rewrite of completed play history.

Focused tests cover separate locations and focus changes, idle/orientation/blocked/combat turns, stalled and first-arrival enforcement, changed journal evidence, repeated facts, failed-search occurrence dependencies, grounding and locality, and retry-safe finalization.

Verification on 17 October 2026: all 816 unit/integration tests, 10 focused browser tests and the production build passed. Tests use isolated databases and mocked model responses; the existing playrun was not replayed.
