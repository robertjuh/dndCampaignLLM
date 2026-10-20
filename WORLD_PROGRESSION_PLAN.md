# World progression

Repeated searches and travel should change what the party can understand or affect. Progress can be a consequential discovery, an NPC acting on an established concern, a visible threat changing, or an objective being resolved. It does not require combat, treasure, a new obstacle, or an action chosen for a player.

## Implemented contract

1. Supply the adjudicator with existing public threads from the premise, party goal, journal, character motivations and recent factual history. Continue those threads instead of inventing a replacement mystery after each clue.
2. Track consecutive meaningful turns without progress by canonical location. Characters together share a counter; separated locations retain independent counters when screen focus changes. Passes, information-only orientation, blocked acts and engine-owned combat/support do not increase it.
3. Consider relevant concrete development by the second meaningful local turn without progress. The provider gets one bounded pacing repair; remaining pacing debt carries forward without blocking legal outcomes. First arrivals may simply introduce the surroundings, occupants and ordinary activity; no clue or connection to an existing thread is required. Ordinary travel covers one meaningful adjacent stretch; it must not substitute another equivalent patch of trail for arrival.
4. Record development in `worldProgress`: its location, public world event, kind, existing thread ID and cited journal identity. The server creates missing progress journal entries and persists canonical public event facts, preserving prior knowledge within field limits. Paraphrases do not require another model response; unsupported replacement journal prose is replaced by grounded facts. Reject missing/locality-breaking evidence, invented thread IDs and repeated information. Supply thread identities without duplicating their already supplied prose. Update the saved counter and recent facts once with finalization; retries retain their original state. Recovery preserves retained journal facts.
5. Keep failed main actions failed. A failed search can reveal a distinct lesser opportunity, or trigger a proportionate established-world response, using an occurrence dependency on the failed check. It cannot reveal the failed goal, reverse dice, force a player decision, invent damage, or force combat to satisfy pacing.

The server checks structure, locality, continuity anchors, durable updates and repeated facts. Fictional significance remains the adjudicator's job: prose paraphrases cannot be proved equivalent with a keyword filter. The prompt explicitly requires an actionable change in knowledge or world state; repeated weather, obscured views and another unspecified clue do not qualify.

The 19 October storytelling follow-up distinguishes actual development from another
pending result, bare record identifier or referral to an exhausted source. The
adjudicator may establish consistent missing answers and NPC decisions. Successful
investigations deliver a usable finding at the checked scope; failures retain their
failed goal while exposing another workable opening. NPCs can respond through
commitments and actions. Public event facts lead with consequences and retain only
material limits, so narration need not recite speculative non-results. Existing
state validation, dice and the bounded pacing repair remain authoritative.

## Examples

For a missing caravan thread, a development could establish a survivor who witnessed its diversion, recognizable evidence of an already established faction's involvement, or a concrete destination and what happened there. An unsuccessful search for the captives keeps their whereabouts unknown; a visible loading ramp or a survivor independently arriving may establish a different opportunity without granting the failed answer.

A newly entered workshop can introduce its working mechanism, present occupants and ordinary activity. A visit need not reveal consequential evidence or connect to an existing thread. Independent discoveries may use ordinary events and journal entries without claiming thread progress. Completed escape and investigation objectives are recorded as complete rather than extended with a new mandatory step.

## Compatibility and verification

Existing saves begin with no counters. Old accepted checkpoints lacking `worldProgress` retain their original contract. New model adjudications supply `worldProgress: []` and evidence when grounded thread development occurs; the server normalizes omitted fields so omission cannot bypass pacing guidance. There is no extra model stage, dependency, retroactive reroll, or rewrite of completed play history.

Focused tests cover separate locations and focus changes, idle/orientation/blocked/combat turns, nonblocking pacing debt and first arrivals without thread progress, changed journal evidence, repeated facts, failed-search occurrence dependencies, grounding and locality, and retry-safe finalization. Pacing repair may add grounded evidence once, return no addition, or be malformed; legal outcomes still publish and the counter resets only for validated progress.

Verification on 17 October 2026: all 816 unit/integration tests, 10 focused browser tests and the production build passed. Tests use isolated databases and mocked model responses; the existing playrun was not replayed.
