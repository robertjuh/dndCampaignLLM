# Fairy forest first-turn latency audit — 7 October 2026

The first player turn in **Het feeenboss** took **285.291 seconds (4 minutes 45 seconds)** of measured stage time. It completed successfully, but two separation-format corrections and one narration correction added four model requests. Requests associated with those corrections took **144.112 seconds**. No timeout, provider failure, automatic retry or factual fallback was recorded.

## Evidence

Read-only audit of campaign `5c859eb3-3b66-4690-827a-d757589ee726`, using SQLite's online backup at `/tmp/gather-fairy-playtest-audit.sqlite`. Reviewed opening 0, player turn 1, all three submissions, the check receipt, adjudication/resolution/narration checkpoints, stage events and current scene/map. Turn 2 was collecting without a draft at snapshot time. No live campaign data was changed.

The campaign uses `gpt-5.6-sol` and Dutch narration. Recorded gameplay build `a2da1b14bd4e6aa4` exactly matched the local source before this audit's prompt changes. Published turn 1 is timestamped **21:21:06 Europe/Amsterdam**. Times below measure server processing, excluding player submission waits.

## Where the time went

| Stage | Requests | Seconds | Recorded correction |
| --- | ---: | ---: | --- |
| Adjudication | 4 | 193.200 | `separations[0].memberIds` first contained fewer than two IDs, then more than two. |
| Finalization | 0 | 0.006 | None. |
| Narration and fidelity review | 4 | 92.081 | The failed search was described twice. |
| Publication | 0 | 0.004 | None. |

The adjudication requests took 8.214, 77.572, 53.148 and 54.224 seconds. The first obtained the search check; the second proposed a result. Requests 3 and 4 corrected rejected results. The narration/review requests took 38.628, 16.707, 17.038 and 19.702 seconds; the last pair corrected the repetition. Diagnostics store bounded rejection feedback, not full rejected prose, so the exact earlier separation arrays and narrator draft cannot be reconstructed.

This turn needed four baseline requests: a check tool call, adjudication after the receipt, narration and review. Three requests is the baseline only for turns needing no tool continuation. The first four baseline requests here already took **141.121 seconds**; removing corrections cannot promise instant turns. Neither token counts nor time to first token are recorded, and request byte counts alone do not establish a latency cause.

The opening separately took **113.640 seconds**, including faction generation. It used six requests, with one narration correction: violin sounds heard along a visible path had been attributed to the still-unvisited destination. The review preserved the exploration boundary, and the final opening corrected it.

## Findings and focused changes

**Separation contract ambiguity:** the schema requires pairs of UUIDs. The old prompt showed `[A,B]` but did not explicitly state the exact length or explain a three-player split. One character travelling away from two companions therefore produced two rejected answers. Updated `server/providers.ts` to require exactly two distinct members at different resulting places and explain `[C,A]` plus `[C,B]`, with one shared world event. Singleton and whole-party arrays remain invalid. The contract was shortened to retain the existing prompt-size limit.

**Overlapping narration facts:** the saved world event about startled books also restates that the search found nothing. The review correctly identified that repetition in the prose. Updated the narrator contract to cover a later event's new consequence without retelling an outcome already described. This preserves event coverage and the existing fidelity/repetition rules.

**Saved gameplay is consistent:** Natalia and the knight remain on the meadow; Romano occupies the adjacent root vault. Both separation pairs cite the established split, and the map retains the existing arrival UUID, marks it visited and records its new adjacent preview. The knight's one saved DEX check remains failed (3 + 2 = 5 against DC 10), with no found item. Natalia's routine lava release changes the scene without inventing HP damage. The vault discovery receives 10 XP through the saved reward path. Published narration covers the finalized events. No save repair was indicated.

## Validation and limits

TypeScript check passed. The affected provider, turn-resolution, location-continuity, playtest-followup and world-map suites passed: **184 tests in five files**. A separate read-only replay validated the saved three-player adjudication against its immutable check receipt and validated published narration coverage; one-ID and three-ID separation arrays reproduce the recorded schema rejections.

No new connected-provider turn was generated. These prompt changes remove the identified ambiguity and clarify repetition handling; the next natural playtest must establish their effect on model behavior and latency. A running server must reload or restart to use the updated source. Completed history, saved dice, model selection and request/retry budgets were preserved.

## Follow-up: turns 2–5

Audited a second read-only online backup, `/tmp/gather-fairy-followup-audit.sqlite`. All four new turns completed on their first stage attempts, with zero timeouts, provider failures or factual fallbacks. Recorded build `328531ae95ef6c46` matches the updated source from the first audit, confirming that those fixes were loaded. No separation-format rejection or repeated-action narration rejection occurred in this sample. Turn 6 was collecting at snapshot time.

| Turn | Publication, Europe/Amsterdam | Requests | Processing time | Corrections |
| --- | --- | ---: | ---: | --- |
| 2 | 21:33:21 | 4 | 2m24s | None. |
| 3 | 21:46:18 | 7 | 2m22s | Three invalid `start_combat` enemy damage strings. |
| 4 | 21:52:35 | 7 | 2m27s | Missing combat-action stat; one narration/review correction. |
| 5 | 21:57:39 | 4 | 1m02s | None. |

Processing durations sum recorded stages, excluding time spent entering actions. Median processing time was 2m23s. The sample shows improvement from turn 1, with remaining model latency and avoidable format corrections.

### Confirmed gameplay defect: one-turn stun could expire unused

In turn 4 the spider acted first and missed Natalia. The knight then hit for 12 damage and applied Stunned. Because the configured duration was one party turn and the application turn counted, it expired before the spider's next attack. Turn 5 therefore let the spider hit Romano: 10 incoming damage minus a saved shield block of 2 left 8 damage, reducing him from 20 to 12 HP. His newly applied Stunned blocked his submitted defensive action and then expired.

The duration change from two to one was already committed in `cb9dd11`. Restoring two blindly would override that balance change. The user explicitly chose **“block the next action”** during this audit. The combat engine now preserves a one-turn stun applied after its target's initiative slot until the next round; a stun applied before the slot blocks the current round instead. Ability strikes, equipment effects and enemy on-hit effects share this handling. Reapplication refreshes rather than stacks it; immunity and cures remain authoritative. The numerical default remains one.

The engine also records stun expiration. Turn 4's old situation summary described the spider as still Stunned even though the finalized encounter had no conditions. The old frozen resolution lacked an expiration event; new resolutions supply it so narration and review can distinguish the temporary event from the final state. No completed story or current live state was retroactively rewritten.

### Other findings and corrections

- **Enemy damage tool contract:** `start_combat` advertised any string while its server validator accepted only one to four dice of d4/d6/d8/d10/d12, without modifiers. Added the valid dice enumeration and explained that the engine adds the attack bonus. Rejected arguments were not retained, so their exact text is unknown.
- **Combat-plan stat:** turn 4's `actions.2.stat` was omitted. The field is required even for defense. Made that requirement explicit in the planning contract; this is guidance, not a guarantee against future malformed output.
- **Narration correction:** the reviewer rejected an invented dodge and wording implying paralysis instead of Stunned. The accepted story corrected both. These were corrected before publication, with no repeated mechanics.
- **Stale location journal:** the root-vault entry still says the violin sits in its lectern, despite Romano successfully picking up the consenting NPC and carrying it onward. The NPC entry and saved vault atmosphere correctly record the move. Added a contract instruction to refresh location journal entries when NPCs leave. The violin is treated as a carried NPC rather than equippable loot; its absence from the backpack is consistent with that adjudication. Existing journal prose was retained as audit evidence.
- **Other saved behavior:** the party reunited in turn 2, reached the existing adjacent gallery UUID in turn 3, and began combat without an immediate attack round. Only the new observation in turn 2 awarded XP; turns 3–5 awarded none. The knight's requested strike spent one charge; later misses did not repeat it. Natalia's declared fatal explosion was an attempted creative action, not an automatic death: her saved natural 1 caused exactly 4 backlash damage. She is alive at 20 HP and was already inactive in the turn-5 starting checkpoint, which explains her absence from that roster. No membership-change event records who changed that setting or when.

### Follow-up verification

All four saved adjudications validated against their saved roll/resource/combat receipts, and all published narrations passed structural event-coverage checks. A replay on copies of turn 4 reused every original die and retained the same damage while preserving the spider's stun. Continuing that copy through the next round skipped the spider's attack, kept Romano at 20 HP, allowed his defense and recorded expiration. This demonstrates the corrected behavior without changing the historical save.

Regression checks cover ability, equipment and enemy stuns in both initiative orders, expiration after exactly one blocked action, and the enemy tool's advertised damage values against the server schema. TypeScript and the full unit suite were also run; final results are recorded below. No connected model request or browser playtest was generated for these changes.

Final verification: **625 tests in 23 files passed**, TypeScript and production build passed. After the last contract shortening and Dutch expiration translation, the turn-resolution and narration suites passed again (**76 tests**), including the existing prompt-size limit; the extended Dutch fact test also passed. Future turns use the new behavior after the running server reloads. The historical spider attack and Romano's current 12 HP were preserved.


## Focus bonus and spider contradiction: turns 6–10

De gevleugelde ridder's equipped Common focus, **Stemvork van de Runenvlucht**, has `attackBonus: 1` and DEX scaling. His ordinary saber attacks and DEX strike already include that bonus: +2 from DEX and +1 from the focus, for a +3 attack modifier. Turn 9 records a die of 12 and a total of 15. Initiative uses +2, as expected; the focus improves attacks, not initiative or damage. No equipment or bonus correction was needed.

Turn 9 began with the spider at 18/38 HP. The knight's successful attack dealt 13 damage, leaving **5/38 HP**, with `victory: false` and no loot. The adjudicator treated the already-final 5 HP as the pre-attack HP and subtracted damage again in its explanation. It then invented two aftermath events, refreshed four journal entries and marked the gallery enemy-free. The narrator followed those accepted events; its review did not have explicit final enemy HP in the frozen resolution.

Turn 10 propagated that false story into combat planning. The spider genuinely attacked the knight for 9 damage and stunned him before his slot, correctly blocking his attack. Romano's attack was incorrectly cancelled because the planner supplied a false defeated-target `blockedReason`; the engine accepted that prose despite its living enemy state. No attack die or damage was recorded for Romano. The spider remained at 5/38 HP.

### Prevention

- Frozen place states now include compact final encounter HP, withdrawal, victory and escape status. The adjudicator and narrator are explicitly told that recorded damage has already been applied.
- Shared checks reject direct death/defeat and ended-combat claims that contradict living enemies and active encounters, across adjudication, journal/location updates, narration and legacy resolutions. English and Dutch forms include “is already defeated,” “is al verslagen” and “al is verslagen.” These checks target direct statements; the narrative review remains responsible for broader semantic fidelity.
- Ordinary attacks and strike abilities use engine eligibility and retargeting. Model `blockedReason` text cannot cancel those attacks. Environmental-action validation and its genuine blocked reasons remain in place.

### Approved live correction

The user approved the prepared story and journal repair. As turn 10 completed before application, the repair also corrects its propagated death explanation and explicitly records Romano's wrongful cancellation. It does not reroll or compensate his lost action.

The guarded transaction restored the four affected journal details and gallery description, removed false turn-9 aftermath events and paragraphs, corrected both turns' summaries and turn-10 cancellation explanation, and retained the original planning input as audit evidence. It leaves all character state, inventory, rolls, damage, encounter state, rewards and pending actions unchanged. At application, turn 11 was collecting with no submitted actions. Final turn-10 HP is knight 2, Romano 14, spider 5/38; knight is no longer Stunned. The original live database was backed up before mutation and a correction event preserves the old summaries and false blocked reason.

The repair first passed on a database copy, then passed the same checks after live application: both adjudications validate against their receipts; both frozen resolutions parse; both narrations have valid event coverage and agree with final enemy HP. All members, rolls, actions, scene mechanics and rewards compare unchanged. The only turn-10 receipt changes are textual corrections explaining the already-recorded blocked action; its original planning input is retained.

Final verification for this correction: **650 tests in 23 files passed**, including the attack/strike planning regressions, contradictory adjudication and narration checks, and the legacy resolution guard. TypeScript, production build, formatting and diff whitespace checks passed. No connected-model request or extra live combat turn was generated.
