# Mechaplanet playthrough analysis — 6 October 2026

The saved mechanics held together in the reviewed turns, and grouped narration is substantially clearer than in the earlier Seaworld audit. The main problems are presentation and interpretation: a contradictory XP review caused the victory scene to fall back to a mechanical transcript; accepted narration changed weapons into firearms; creative intent lost its distinctive execution; and structured-output corrections made one turn take over four minutes.

## Evidence and scope

Read-only audit of `data/gather.sqlite`, campaign **mechaplanet**, ID `acbb0b4c-7094-4535-b582-ab8f1f8f3240`. This was the latest campaign with recorded gameplay activity in the database. It used `gpt-5.6-sol`, Dutch output, an apocalyptic mecha-war setting, and the instruction **“A lot of combat, first turn already starts in combat.”**

Reviewed the opening and all completed player turns **1–9**, published **21:30:00–22:30:03 Europe/Amsterdam on 6 October**. Turn 10 was collecting with no submissions in the snapshot. This is an unfinished campaign, not a completed adventure. Fransinator, Kraak and Jeff steinberg participated through turn 7; turns 8–9 used Kraak and Jeff's two-person roster. Fransinator was sitting out in the snapshot.

Evidence includes all **25 submissions and structured action outcomes**, **82 saved dice receipts** of several kinds, **61 finalized events**, accepted adjudications, resolutions, narration, stage diagnostics, equipment events, journal updates, and character-state snapshots. Five receipts were noncombat checks; the other dice include initiative, attacks, damage, loot and shield blocking. These are not 82 independent skill checks. Current implementation and the previous analysis were read to investigate causes.

The SQLite database was opened read-only and backed up into `/tmp` for a consistent audit. No live campaign state, completed turn, credential, provider connection, or source code was changed. No provider requests, gameplay retries, or tests were run. Rejected model candidates are not saved in full: their contents can only be inferred from bounded review feedback. Source references below describe the current working tree, which already contains unrelated uncommitted changes; there is no saved build identifier establishing its exact correspondence to the running server.

## Turn-by-turn record

Processing is the sum of recorded stage durations, excluding player thinking, submissions, equipment handling and level-up selection. Requests include planning, adjudication, narration and review. Times are rounded.

| Turn | Published locally | Main result                                                                                       | XP per character | Processing | Requests |
| ---- | ----------------- | ------------------------------------------------------------------------------------------------- | ---------------: | ---------: | -------: |
| 0    | 21:30:00          | Kranz-9 and two loyaliteitsdrones start combat                                                    |                0 |     1m 00s |        5 |
| 1    | 21:35:31          | Two strikes destroy Kranz-9; Jeff suffers a natural-1 backlash                                    |                0 |     1m 23s |        6 |
| 2    | 21:40:42          | All three player attempts fail; Fransinator takes 7 damage                                        |                0 |     1m 44s |        6 |
| 3    | 21:45:49          | Jeff damages A-17; other attacks miss; Fransinator reaches 7 HP                                   |                0 |     1m 31s |        6 |
| 4    | 21:50:45          | Both drones die; recovery, charge restoration and six loot items; factual narration fallback      |               80 |     1m 46s |        6 |
| 5    | 21:57:13          | Jeff covers Kraak's movement; Fransinator secures already acquired gear                           |                0 |     1m 14s |        3 |
| 6    | 22:04:42          | Recorded slogans worsen suspicion; Jeff spots approaching reinforcements                          |               10 |     2m 14s |        5 |
| 7    | 22:08:48          | Fransinator identifies reinforcements; Jeff's material search fails; party reaches level 2        |               10 |     1m 44s |        4 |
| 8    | 22:18:47          | Jeff's second search fails and wreckage collapses; Kraak finds a code cylinder; new combat begins |                0 |     4m 22s |       11 |
| 9    | 22:30:03          | Kraak deals 11 damage to Eisenwacht, blocks 4 incoming damage, and becomes Stunned                |                0 |     0m 48s |        4 |

The reviewed session used **56 model requests** and **17m 46s** of recorded processing. Player turns averaged **1m 52s**, with a median of **1m 44s**. Excluding turn 8, the player-turn average was **1m 33s**. Of the 25 action outcomes, 15 were successes and 10 failures; none were passes, blocked acts or main/minor partial outcomes.

## Findings

### 1. The narrator and reviewer disagree about XP — confirmed fault, highest priority

Turn 4's narrator was rejected twice for omitting each character's **80 XP**. The second feedback explicitly states that combat events, initiative, recovery, charge restoration, victory, loot and current HP/conditions were correct, then demands XP in the closing or situation summary. The two-attempt budget exhausted and the engine published factual narration.

This directly conflicts with the narrator's instruction: **“Keep XP rewards and DCs out of all prose; the server appends actual rewards.”** Publication does append all three XP rewards. They were mechanically applied once and each character ended the turn at 80 XP; there is no missing-reward finding here.

The reviewer receives the resolution's rewards but lacks the narrator's explicit server-appendix exemption. See [narration and review prompts](server/providers.ts), lines 1143 and 1171, and [publication](server/game.ts), lines 1875–1883. The first review also objected to an unsupported movement phrase, so that rejection was not solely about XP. The second rejection identifies XP alone as the remaining problem.

**Recommended change:** give the reviewer the same reward presentation rule as the narrator. Check reward application and the appended display independently from generated prose. Increasing the retry budget would prolong the contradiction.

### 2. The fallback preserves gameplay but seriously degrades the victory presentation — confirmed

The victory scene becomes **15 separate mechanical paragraphs**: misses, damage, recovery, individual charge returns, victory, and one paragraph per loot item. The situation summary repeats those events, then exposes **`Location: {"name":...}`** and **`Safe rest: false`** in an otherwise Dutch story.

The narrator normally uses grouped version-2 passages. This turn uses the factual fallback's version-1 event-per-paragraph representation. [The fallback](shared/turn-resolution.ts), lines 172–201, derives its summary from a recap that [finalization](server/game.ts), lines 1848–1852, builds with raw location JSON and an English rest marker.

**Recommended change:** retain the reliable fallback, but produce its situation text from structured current state in the campaign language. Group recovery and loot where coverage permits. Internal recap serialization should not become player-facing narration. This finding also explains why turn 4 feels more repetitive despite containing only 181 narration words: fragmentation and a duplicated summary matter more than word count alone.

### 3. Accepted narration invents the wrong attack method — confirmed fidelity gap

Kraak's equipped **“Kraak’s weapon 2”** is a light, one-handed **kerfmes**, a knife. Turn 3 says **“Kraak opent het vuur”** and describes a shot missing B-04. The server recorded a knife attack and miss, not gunfire.

Turn 9 similarly describes Ost-2 firing a salvo, although its saved weapon is **Elektrische vangarm Ost-2**, an electrically charged grabbing arm. Damage and miss outcomes remain correct, but how they happen contradicts saved equipment.

The narrator and reviewer receive the finalized resolution alone. Its character snapshots contain HP, conditions, uses and progression, but not equipment descriptions. Combat events often contain only a weapon name; enemy miss events may contain no weapon at all. The original descriptions therefore cannot inform those stages. See [resolution construction](server/game.ts), lines 1833–1843, and [narrator input](server/providers.ts), lines 1125–1139.

**Recommended change:** freeze a small amount of relevant execution context with each action/event—actual weapon type or description and established attack method—then use it in narration and review. Do not resolve this by letting the narrator invent mechanics or consult mutable current character state.

### 4. Fransinator's hot-oil attack loses its distinctive intent — confirmed presentation loss

In turn 4 Fransinator describes heating his mass and projecting glowing oil at A-17. The saved combat plan retains that description, but normalizes it to an ordinary natural attack. The finalized fact and fallback merely say **“Fransinator’s innate strike”** dealt 5 damage and killed A-17.

Using bounded innate-attack mechanics is reasonable; the submission does not authorize automatic Burning or extra damage. The loss is that its feasible oil-based execution never reaches the final account. This begins before narration: the accepted action outcome itself is generic.

**Recommended change:** preserve an established, feasible description of how the innate attack occurred in adjudication, alongside its fixed damage receipt. Keep unsupported heat levels or additional ailments out unless the engine actually grants them. This session does not establish that the environmental-attack feature is broken: no saved environmental attack profile was executed.

### 5. Combat victory leaves a stale canonical hazard and journal entry — confirmed continuity fault

After turn 4 destroys every first-encounter enemy, `resolution.location.hazard` still says the open terrain is under fire from **two surveillance drones**. The victory fallback copies that claim into the situation summary. The public journal's loyaliteitsonderzoek entry also remains at the opening's hostile interception until turn 5 updates it to say the enemies were destroyed.

Turn 5 repairs both the location and journal, but a contradiction remains in completed turn 4 and its saved factual history. Victory events and `encounter.victory` are correct; the descriptive state lagged behind.

**Recommended change:** have combat aftermath establish accurate surviving threats and update public facts in the victory turn. Continue denying rest if exposure or radiation justifies it, while removing claims about destroyed enemies. The server can validate obvious conflicts against its encounter state without inventing a replacement scene.

### 6. Model corrections account for substantial delay — confirmed

Across all ten completed scenes:

| Stage                                   | Recorded time | Share of processing | Model requests |
| --------------------------------------- | ------------: | ------------------: | -------------: |
| Adjudication, including combat planning |       11m 18s |               63.6% |             26 |
| Narration and review                    |        6m 28s |               36.4% |             30 |
| Finalization and publication together   |        0.142s |          under 0.1% |              0 |

Five of nine player turns require a second narration/review pair: **1, 2, 3, 4 and 8**. Those second pairs consume **2m 01s** in aggregate, adding ten requests above one generation/review pair per scene.

Recorded request input totals approximately **2.49 MB** across repeated calls, and output approximately **0.32 MB**. The largest input is **113,320 bytes** on turn 8. These are serialized payload sizes, not tokens, prices, or unique context volume. They cannot establish which upstream inference factor dominates latency.

**Recommended change:** first remove contradictory and avoidable correction causes. Local database or publication optimization would have negligible effect on this observed delay. Keep request-level telemetry; it now makes the causes much more inspectable than the previous audit.

### 7. Turn 8 nearly exhausts the adjudication request budget on references and ownership — confirmed

Turn 8 takes **3m 33s in adjudication**, then **49s in narration**, for **4m 22s total** and **11 requests**. Adjudication uses seven of its eight allowed requests. Its corrections are:

1. `Unknown receipt: roll:8bcf2829-ccf5-4bf9-92f7-6b20c711dbbf`.
2. `Action outcomes must reference their own resolved events.`
3. `An action cannot claim another actor’s receipt.`

The unknown reference is a transcription error: Kraak's actual saved receipt is **`8bcf2829-ccf9-4bf9-92f7-6b20c711dbbf`**, with `ccf9` rather than `ccf5`. The evidence therefore does not show a missing roll or an engine failure to expose a valid receipt. The next three correction responses consume about **1m 57s**. Turn 6 also needs a correction for action-event ownership.

These turns involve independent submissions; the ownership errors are not proof of failed cooperative assistance. Final accepted outcomes correctly retain Jeff's failure and Kraak's success, and there is one saved check per actor.

**Recommended change:** simplify exact-reference assembly using existing engine-owned events and validated actor associations, and make correction feedback identify the affected action/component and valid references. Preserve ownership validation; accepting borrowed receipts would undermine the authoritative outcomes.

### 8. Fidelity review is strict about some wording and inconsistent about comparable wording — observed

Turn 2 rejects **“beantwoordt het vuur”** as unsupported causal reaction. Turn 3's accepted narration nevertheless says B-04 **“beantwoordt het vuur onmiddellijk”** with no recorded dependency. Its actual correction focuses instead on translating the mechanical term `attack` into `aanval`.

Turn 1's reviewer demands an explicit `natural 1` label. That sits uneasily with the narrator instruction to omit dice numbers, although the catastrophic failure and self-damage are material and should remain explicit. The saved feedback does not preserve enough of the first candidate to establish every detail it already contained.

Turn 8's correction from **“ingenomen”** to **“bereikt/betreden”** is useful: full conquest was not established. This is an example of review protecting meaningful world state, rather than merely policing a synonym.

**Recommended change:** agree on a stable boundary between sensory sequencing and new gameplay causality, explicitly exempt server-rendered information, and make any required critical-result wording consistent. Apply cheap terminology corrections separately where practical. Continue reviewing substantive actor, outcome and world-state claims.

### 9. Immediate self-healing is mechanically explainable but missing from the turn audit trail — confirmed visibility gap

Fransinator ends turn 3 at **7/24 HP** with one **Bus regeneratieolie**. Turn 4 starts at **13/24 HP** with that item absent. The delta is exactly one saved 6-HP healing item's effect. Turn 4 then applies 4 enemy damage and 9 encounter recovery: **13 − 4 + 9 = 18**, matching its final state.

This is consistent with the documented immediate self-healing control. [The item-control path](server/game.ts), line 2246, directly consumes and heals; unlike chat resource execution, it does not create a resource receipt or healing event for the completed turn. The UI explicitly labels self healing **“Instant”**. The saved evidence cannot identify the exact click or timestamp, but it does distinguish this state change from duplicate victory recovery or unexplained regeneration.

**Recommended change:** record immediate consumption, recipient and restored HP as an authoritative between-turn event, preserving the chosen instant interaction. If one minor action per round is intended to constrain this control too, enforce that consistently; this playthrough used one item and does not demonstrate repeated-use abuse.

### 10. Jeff's starting equipment undercuts his marksman concept — confirmed mismatch, balance/design issue

Jeff starts with **DEX 9** but **CHA 3**. His only starting weapon offer is **Gestolen bevelspistool**, which scales with CHA. It therefore correctly attacks at **−1**, while a DEX weapon would use **+2**. He selected the pistol and boots, and chose Cleanse rather than his offered DEX strike.

Against defense-10 drones, the ordinary pistol has a **50% hit chance**; an otherwise comparable DEX weapon would have **65%** under these rules. Jeff hits once in his four first-encounter attacks. Those few results do not establish biased dice. Loot later provides the DEX-based Drone-mitrailleur B-04, which he equips through the controls.

**Recommended change:** make the mechanical cost of concept-mismatched random gear unmistakable in selection. If random equipment is meant to remain unrestricted, preserve it and show the tradeoff. If characters should reliably express their combat concept at creation, bias one compatible offer rather than silently substituting DEX for the saved pistol's CHA scaling. The recorded engine correctly honored the selected weapon.

### 11. Generated equipment and ability prose needs more consistent specificity — confirmed content quality issue

All five of Kraak's starting items retain generic names such as **“Kraak’s helmet 1”**, **“Kraak’s weapon 2”** and **“Kraak’s shield 4”**, despite having setting-specific descriptions. Fransinator and Jeff have much more distinctive equipment names. The database does not reveal whether these names resulted from a failed naming step or an accepted generation response.

Some ability descriptions also communicate their costs more completely than others. Fransinator's strike explicitly states a main action and charge; Kraak's initial strike description mentions a main action without its charge cost. Jeff's utility description speaks only of helping an ally, while other saved utility descriptions explicitly mention self use. Structured mechanics remain authoritative, so these are prose consistency issues rather than evidence of misapplied powers.

**Recommended change:** require non-placeholder final names and keep mechanical costs/targets in a shared rendered description, with generated prose describing character flavor. This also helps prevent a generically named knife from being imagined as a gun.

### 12. Attribute rewards can have little immediate effect — observed design issue

Fransinator chooses random attributes at level 2 and receives **STR 9→10** and **INT 7→8**. Both modifiers stay unchanged under `floor((stat − 5) / 2)`: STR remains +2 and INT remains +1. The level still grants its normal +5 HP, and raw scores may affect equipment requirements or future advancement, so the reward is not universally valueless.

Jeff's **CHA 3→4** likewise leaves its modifier unchanged; **CON 6→7** does improve his modifier and raises maximum/current HP by another 2 after the normal level gain. Kraak chooses a new repair Mend that cures Shocked.

**Recommended change:** show before/after practical modifiers when presenting the rolled reward. Changing the random attribute rule is a balance decision; this session supports clearer feedback, not a mandatory redesign.

### 13. Cooperation works for routine actions in this run; checked assistance remains untested — positive finding with a limit

Turn 5 resolves Jeff's covering action before Kraak's movement and records Kraak's event as depending on Jeff's successful event. The movement succeeds without unnecessary checks. This is a better result than the earlier cannon playtest's unrecognized mechanical cooperation.

No check in this session has `assistsMemberId` or `assistedBy`, however. Fransinator's turn-7 utility grants advantage to his own INT check, not another player's dependent attempt. This run cannot accept the checked-helper advantage feature on its own.

Kraak also prepares against an attack in turn 6 and moves to the inspection cabin in turn 7. Those positions are preserved in the fiction; no persistent mechanical guard bonus is recorded. Since no enemy attack occurs on those turns and circumstances subsequently change, that is not established as a mechanics bug. A later playtest should distinguish positional preparation from an actual saved combat defense benefit.

### 14. Repeated failure now changes the scene, but the opportunity is narrow — observed pacing result

Jeff's turn-7 search finds no reliable ambush materials. In turn 8 he changes approach to climbing through wreckage with DEX; that also fails. This time wreckage partially collapses, radiation dust rises, and further searching of that heap is explicitly exhausted. Meanwhile Kraak finds a code cylinder and previously announced reinforcements arrive.

Unlike the earlier cannon loop, the scene advances and the failed action stays failed. There is no fabricated item, damage, or XP for Jeff's unsuccessful searches. The limitation is that the failure mostly closes the attempted route; it does not establish a useful alternate preparation opportunity. The costly 4m 22s resolution amplifies that disappointment.

**Recommended change:** when justified by the setting, let failure expose a concrete clue, changed position or alternative resource as well as a setback. Keep it in adjudication and preserve the failure. Do not require every failure to grant progress or an automatic success.

### 15. Combat pressure fits the request, with early signs of repetition — observed, not a balance verdict

The opening immediately starts combat, honoring the explicit instruction. Kranz-9's group is destroyed over four player rounds. After four exploration/preparation turns, another elite with two drones arrives; turn 9 begins its first mechanical round. Five of nine player turns are combat rounds.

Both encounters use the same broad composition and the entire session stays at the Ruïnecontrolepost. The second group has **62 total starting HP**, versus **46** in the first, while its acting party has shrunk from three players to two. The party has also leveled and gained equipment, so these numbers alone cannot establish unfair difficulty.

**Recommended change:** vary objectives, enemy behavior or terrain interactions in subsequent combats if the campaign continues. The single reviewed opening hour supports watching for repetition; it does not establish that a combat-heavy campaign should have fewer fights or a guaranteed rest between them.

### 16. Loot, progression, shields and ailments behave coherently in the observed cases — positive finding

- First-encounter rewards are **50 + 15 + 15 = 80 XP per character**, matching one elite and two minor enemies. Turns 6–7 add two distinct 10-XP discoveries: detecting approaching reinforcements, then identifying their composition. Each character reaches exactly 100 accumulated XP and level 2, with 0 XP toward the next level. No gold is awarded.
- Both initial selected strikes spend one use. Victory restores those spent charges. Fransinator's later utility spends its saved use and grants advantage; its dice `[7, 9]` plus modifier/bonus 2 total 11 against DC 10. No duplicate use or discovery reward was observed.
- Six first-encounter loot items are offered. All are acquired through the controls before turn 5 completes, with eight equipment/pickup/drop events preserved in its appended summary. Fransinator's chat action is interpreted against that already acquired state. It does not create another rifle or potion. The code cylinder found in turn 8 remains ground loot; discovery does not silently place it in Kraak's inventory.
- Turn 9's Eisenwacht hit produces 8 incoming damage. Kraak's Common shield rolls 4, leaving 4 damage: **32→28 HP**. Stunned is applied and has one turn remaining after the application-turn tick. No extra Chilled effect is invented when the weapon's 25% ailment roll fails.
- Fransinator's focus is correctly treated as an accuracy aid for his natural attacks, rather than an invented damaging weapon. First-encounter recovery is consistent with CON plus the saved regeneration trait. There is no evidence that “regeneration” promises automatic per-turn healing; the generated “slowly regenerates” flavor could communicate its encounter-recovery timing more clearly.

These observations verify the cases exercised here. They do not establish every shield, immunity, condition or resource combination.

### 17. Checkpoint publication and narration recovery are sound in this sample — positive finding with acceptance limits

Every completed scene records one attempt for each stage, with no persisted stage failure, automatic retry or manual retry. Resolution and narration revisions agree throughout. Turn 4's content fallback still publishes the finalized mechanics once, and turn 8 introduces its encounter without executing a combat round against submissions that were made for exploration. The first attacks wait for turn 9.

Sitting out Fransinator removes him from turns 8–9's actions and combat participants while preserving his character state. He is not silently assigned an attack. The snapshot's active-player flag and roster explain his absence, but no lifecycle event records the precise sit-out time or reason.

This session does **not** exercise a host restart, provider timeout, retry after a finalized resolution, atomic publication retry, ally Mend/Cleanse, a successful minor paired with a failed main, downing, permanent death, replacement arrival, off-hand attacks, checked cooperative assistance, environmental attack/reload consumption, or acting while Stunned. Turn 9 establishes Stunned; the next turn is still pending. No browser interactions or mobile layout were observed during this audit.

## Recommended follow-up order

1. **Align the XP rules for narration and review**, then verify that a rewarded victory publishes immersive text and the server's XP appendix without correction or fallback.
2. **Freeze relevant attack execution details**, preserving knife/grabbing-arm semantics and feasible hot-oil flavor while keeping the original dice and damage authoritative.
3. **Refresh descriptive state in combat aftermath** and make the factual fallback's summary concise, localized and free of internal JSON.
4. **Reduce exact-reference/ownership correction work**, guided by turn 8's recorded typo and action ownership feedback, without loosening validation.
5. **Record immediate healing and participation changes** so meaningful between-turn state transitions can be explained from saved events.
6. **Continue acceptance coverage in an isolated playtest** for checked assistance, main/minor partial outcomes, ally support, environmental attacks and recovery/restart cases. Review the pending Stunned turn if this campaign continues.

The prior Seaworld audit's player turns averaged about 2m 42s and narrated roughly 306–406 words with repeated action accounts. This run averages 1m 52s, and ordinary completed player turns use **80–157 narration words** with no recap-only closing. That is encouraging observed improvement, but the sessions use different actions and encounter types; it is not a controlled performance comparison. The remaining victory fallback and inconsistent fidelity review deserve priority over further broad changes to the resolution pipeline.
