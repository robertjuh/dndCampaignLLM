# Position continuity investigation and fix plan — 17 October 2026

Implemented with the user's constraint that the changes must not add LLM calls. The findings below describe the original failures; both recorded proposals now resolve locally with their intended positions preserved.

The server now fills unambiguous movement markers, derives a shared position fact for malformed separation references, and validates position agreement during adjudication and finalization. Partial recovery includes an actor's proposed position whenever retaining their movement or main component, so it cannot keep an arrival while discarding the position. Compact repairs accept omitted sequence numbers, use the existing location-reference normalizer, and identify unresolved movement consequences correctly. New position-continuity failures use coherent local recovery rather than adding a model repair request. No new LLM stage or larger request/retry budget was introduced.

Regression checks cover the recorded turns 4 and 6, including preserved failed search dice, mixed movement/search components, immutable retained positions, missing patch sequences, malformed positions, negated or unrelated requests, and movement within a place. End-to-end server tests compare explicit and omitted movement markers: both use the normal three model requests (adjudication, narration, review), and publication retry after a restart uses zero additional requests. These requests are mocked; implementation and verification made no live LLM calls. The isolated browser test verifies Sir rexmen and Matthes appear at the same saved destination on both phone and shared-screen layouts.

Validation passed: `npm test` (746 tests across 26 files), `npm run build`, and `GOOGLE_CALLBACK_PORT=0 npm run test:e2e -- tests/browser/world-map.spec.ts` (one browser test covering phone and shared screen). The ephemeral callback port avoids the running server's port 3001, and Playwright uses its own temporary database.

The current campaign was audited without writes. Turn 9 passed the new continuity check; a final check of turn 10 confirmed its published summary and saved positions agree, including Sir rexmen back at the inn. No historical turns were replayed and no current positions required correction. A live resolution was in progress during implementation, so the running server was not restarted as part of this change; a production process must load the updated code between turns.

The movement failures in turns 4 and 6 are server-side recovery bugs. The model proposed Sir rexmen's moves, but the server committed his arrival facts without committing his new positions. The browser correctly displayed those saved positions. The partial adjudication recovery introduced in the previous improvement caused this inconsistency.

Scope: the newest **Warhammer: Ashes of the Grey Mountains — new run**, campaign `1699c37e-5648-415c-a0b1-52389f69b581`. The initial investigation used read-only SQLite queries, saved model requests/responses, and offline replay through the adjudication validator and repair merger. The implementation changes application code and tests; it does not modify the live campaign database.

| Turn | Submitted movement and proposed result                                                                       | Committed state                       | Published story                         |
| ---- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------- | --------------------------------------- |
| 4    | Sir rexmen: “Go to the Grey pass”; model proposes Border Approach → Grey Pass Coaching Inn                   | Still Border Approach                 | Arrives at the inn with Matthes         |
| 4    | Matthes: “Go to the grey pass to look for supplies”; model proposes Border Approach → Grey Pass Coaching Inn | Correctly at the inn                  | Arrives and inspects supplies           |
| 4    | Marta: “Go to the mountain road”; model proposes inn → Mountain Road                                         | Still at the inn                      | Arrives at the culvert on Mountain Road |
| 6    | Sir rexmen: “Go to the Mountain road”; model proposes inn → Mountain Road                                    | Still at the inn                      | Arrives at the culvert                  |
| 6    | Marta: “Head to the upper mountain road and search”                                                          | Correctly reaches Upper Mountain Road | Arrives, then fails the search check    |

The difference between these actors is the structured representation of their moves. Matthes's turn-4 move and Marta's turn-6 move use a dedicated `movement` component. Sir rexmen's moves and Marta's turn-4 move use their `main` component, but omit `effect:"movement"` on the supporting event. The validator requires that marker for main-component movement. This is a metadata error rather than a failed in-world journey.

In both turns, recovery then:

1. Removes positions supported by those unmarked events.
2. Retains and locks the corresponding main components, including the successful arrival facts.
3. Discards the affected travel metadata, bypassing the existing check that an open route should make progress.
4. Sends a repair request with **zero unresolved actions**, although movement consequences remain unresolved.
5. Rejects the returned repair because its new events omit `sequence`, despite telling the model that the server recomputes sequence.
6. Publishes the retained partial result. Narration follows the retained arrival facts while map occupants follow the saved positions.

The validator checks that a position change has a movement proof. It does not enforce the reverse relationship, which lets this broken projection pass. Turn 4 also retains a party-split world fact describing the uncommitted arrivals. Neither turn remained failed: both completed with inconsistent partial recovery.

Offline replay confirmed the following, without new model calls or dice:

| Replay                                                            | Result                                                                                         |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Original turn-4 proposal                                          | Rejected for missing movement effect                                                           |
| Same proposal with only the two missing movement markers supplied | Passes adjudication validation; all three proposed positions survive                           |
| Original turn-6 proposal with its missing marker supplied         | Reveals another error: separation entries cite an action event where a world event is required |
| Recorded repairs for turns 4 and 6                                | Both rejected for missing event sequence numbers                                               |
| Turn-4 repair with sequence numbers supplied                      | Still rejected: new movement events are not owned by the actor's action outcome                |
| Turn-6 repair with sequence numbers supplied                      | Passes adjudication validation; both proposed positions survive                                |
| Actually committed adjudications                                  | Both pass the current validator despite their contradictory arrival facts and positions        |

These are adjudication-level checks, not full pipeline replay. They demonstrate why fixing only the prompt or only the sequence parser would leave failures behind.

The implementation order should be:

1. **Make recovery preserve a whole movement decision.** In `server/adjudication-recovery.ts`, retain or repair the actor component, movement event, destination position, travel metadata, and dependent consequences together. Do not lock an arrival component after removing its proposed position. Preserve independently valid progress, including a successful move followed by a failed search. In `server/providers.ts`, include actors with unresolved position consequences in the compact repair request even when their other components are valid. Party-split and destination events must follow the surviving movement decisions. This is the first priority because it prevents silent state corruption.

2. **Fix the compact repair contract.** Accept omitted sequence numbers on repair events and assign them during the existing merge before full validation. Continue validating event ownership, dependencies, saved engine events, and ordering. Supply a valid example containing an actor, its movement component/event, and its position update; an events-only repair is insufficient for turn 4. Permit corrections to unresolved movement metadata without unlocking unrelated validated checks or costs. Keep the existing bounded repair budget.

3. **Repair obvious movement metadata locally.** Extend the existing normalization path rather than adding another resolution pipeline. Where the submitted physical journey, actor-owned successful event, explicit destination update, and route evidence agree, fill the omitted movement marker and run all existing legality checks. A mere successful event or `locationRef` is insufficient evidence. Ambiguous intent stays available for compact repair. Preserve blocked routes, one-way routes, one-hop travel, failed traversal checks, combat restrictions, and each actor's own submission. For separations, derive grouping from resulting positions; either generate the matching world fact from those positions or repair the redundant reference without rejecting otherwise valid movement.

4. **Enforce agreement before saving and narrating.** In the shared validation path, require a successful structured location move to have a matching destination position, and require each position change to have the actor's valid movement proof. Keep this check at finalization as well, so recovery and resumed checkpoints cannot bypass it. Build canonical arrival facts from validated movement decisions and give the narrator those facts plus committed positions. Have the existing narration review check location continuity in passages and summaries. The browser already reads the authoritative positions; it needs regression coverage rather than a compensating display fix.

5. **Replay these cases and verify the whole pipeline.** Add focused regressions to the existing turn-resolution/location tests using minimal fixtures from these two turns. Cover main-only movement, movement plus search, two actors reaching the same place, omitted movement markers, omitted patch sequence, invalid event ownership, and party separation references. Assert both saved positions and published outcomes. Include unsuccessful repair: it must never publish an arrival whose position was discarded. Retain negative coverage for unrelated successes, foreign actors, blocked/one-way routes, and failed traversal. Verify narration retry and restart preserve the move once without rerolling or reapplying costs. Run the relevant tests, the full unit suite and build, then the existing world-map browser checks with per-character occupants.

Creative liberty can fill ordinary travel descriptions, connective events, arrival atmosphere, and useful consequences from the saved intent and mechanics. A formatting error must not become a fictional obstruction or an uncommitted success. The invariant is simple: **if the story says a character arrived, the saved position must reflect that arrival.**

Existing campaign reconciliation is a separate final step after the fix. Later turns already depend on these positions and players have reissued some movement requests. Do not replay completed turns 4 or 6 or blindly apply their destinations to the current scene. At a stable turn boundary, back up the database, audit the latest positions against subsequent accepted moves, and prepare only any still-needed current-position correction. Do not edit underneath an active resolution or duplicate dice, rewards, items, or travel steps.

Relevant implementation: `server/adjudication-recovery.ts`, `server/providers.ts`, `server/turn-resolution.ts`, `server/exploration.ts`, `server/game.ts`, and `src/WorldMap.tsx`.

Saved evidence: turn-4 proposal `data/logs/chatgpt-calls/2ba66f01-9de7-4d92-ac5a-f457a6728b5f.json` and repair `c5d49be0-4fc1-46d2-8362-04530a01a630.json`; turn-6 proposal `bb0c7b50-6482-4db8-94e4-5fa1d01a6e4a.json` and repair `d239fdd8-34c6-40d3-b092-f98696742452.json`. The latter three files are in the same log directory. Completed drafts and published results are in `data/gather.sqlite`.
