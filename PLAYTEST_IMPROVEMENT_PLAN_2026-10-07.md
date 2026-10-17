# Lava planet improvements

Status: implemented and verified, 7 October 2026. All eight workstreams are delivered; see the [implementation and validation report](PLAYTEST_IMPLEMENTATION_2026-10-07.md) for behavior, evidence, the saved-game correction and practical limits. The sections below retain the approved implementation scope and acceptance criteria.

Based on [the Lava planet audit](PLAYTEST_ANALYSIS_2026-10-07.md) and the players' clarification about the unavailable wrench control. It follows the already implemented [clarity/location work](PLAYTHROUGH_CLARITY_PLAN.md), rather than replacing it.

## Intended result

Players can ask the GM for orientation and receive useful scene context. Routine travel reaches meaningful developments. Saved positions and item access match the places described in the story. Failed checks keep their consequences without erasing completed preparation. Public memory agrees with current item ownership. Factions can influence relevant scenes without compulsory encounters or reputation awards.

Use the existing SQLite state, location helpers and adjudication → finalization → narration → review pipeline. Keep current model request budgets and main/minor resource limits. No new service, dependency, map engine or separate help model call is needed.

## 1. Answer requests for orientation

Treat submissions such as “Wat moet ik doen?”, “Ik weet niet waar ik heen kan”, “What can I see?” and “Describe my surroundings” as requests to the GM when they do not explicitly address an in-world person. Let adjudication interpret the wording in context; avoid a brittle exact-phrase router.

- Describe the asking character's own place: observable surroundings, reachable features, established routes and obstacles, useful discoveries and what remains uncertain.
- Use the current inventory when referring to collected tools. Do not repeat stale ownership claims from the journal.
- Expand ordinary observable detail when the existing scene is too vague. Adjudication establishes and freezes that detail in public events/location facts before narration. Hidden compartments, secret routes, NPC motives and undiscovered faction knowledge still need their normal fictional basis.
- Keep orientation routine. It needs no roll, consumes no item or ability charge, grants no XP by itself and does not move the character. An information-only question must not silently activate an ability merely because its card was selected.
- An explicit question to a named/present NPC remains dialogue. A player asking “Ik vraag Ferrum wat ik moet doen” while Ferrum is out of hearing range may receive the established no-answer consequence, plus useful local orientation where appropriate.
- Mixed submissions still resolve their actual acts: “I inspect the locked panel; what surrounds it?” can require a check for the panel while answering the observable-surroundings part routinely.
- Information alone does not overcome incapacitation or grant another action. During combat, preserve the round, enemy actions and applicable main-action restrictions; a question must never default to an attack. A GM explanation can be a world fact even if the character's physical main action is blocked.
- Keep the existing group-turn submission behavior. The question marks that player ready and is answered in the completed turn; normal turn/condition ticks still apply. It is useful participation rather than a blocked shout. A separate instant-help endpoint is outside this change.

Example response, grounded in Lava man's established turn-9 surroundings:

> In de koele leidingkamer steken gebarsten buizen uit de wand. De markeringen wijzen omhoog naar een centrale drukverdeler; aan de overkant loopt een brede donkere tunnel verder. De Drukregelaarssleutel zit in je backpack. Een uitgang is nog niet bevestigd.

This gives usable context without choosing an action, inventing an NPC answer or presenting a recommended-action menu. The GM can recognize the player's expressed wish to escape without assigning a new party goal.

Primary changes: adjudication/combat interpretation and narration/review prompts in `server/providers.ts`; examples and behavior in `GAMEPLAYLOOPPROMPT.md` and `README.md`. Reuse routine outcomes and public world events.

Acceptance: an isolated version of “Wat moet ik doen?” produces useful local facts, no echo-only blocked outcome, no suggested command, no secret discovery, no roll/reward/resource use and no additional model stage. Check explicit NPC dialogue and a mixed question/action too.

## 2. Let routine travel cover meaningful ground

- For “follow the tunnel/river/known route,” resolve the intended journey to its next meaningful arrival, obstacle or choice. Do not require a new submission merely to traverse another equivalent stretch of corridor.
- Preserve the scope of the submission. “Go to the grille” stops at the grille; it does not authorize forcing it open. Stop before an unchosen branch or action requiring another main act. An established destination can be reached without inventing intervening barriers.
- Describe progress and the destination's significance: what has been left behind, what is newly observable and how this bears on an expressed concern. Returning to a known place restores its saved state.
- When an objective is actually achieved, acknowledge its established scope. Do not extend an escape or task indefinitely by inventing another mandatory layer. New independent developments remain possible.
- Retain campaign tone and explicit combat emphasis. Neither a combat quota nor a guaranteed quiet/safe scene belongs in this plan.
- Make changing danger observable where supported: a pressure surge alters a passage, distant movement approaches, or an NPC reacts. Do not add arbitrary damage, timers or checks to compensate for slow pacing. Burning immunity remains distinct from immunity to structural or other hazards.

Primary changes: the scene-clarity/adjudication contract and gameplay reference. No travel scheduler or automatic continuation turns.

Acceptance: a short isolated escape scenario advances from an ordinary route to a materially different situation without repeated “another tunnel” submissions. Distinct obstacles and genuine branch choices still matter. Assess this with real model output; mocked destinations only establish plumbing.

## 3. Register the places required by a split turn

Define a place as the area for which shared object access, interaction, encounter participation are plausible. Separate rooms/branches beyond ordinary interaction can have separate IDs while retaining a common regional name in their descriptions. A rename or atmosphere refresh does not create a new place.

### Extend the existing contract

- Add a bounded collection of place updates with temporary references such as `new:upper-passage` and `new:drain-shaft`. Each supplies the existing location description and its own safety decision. Bound new arrivals by the opening roster or the characters with supported movement; prohibit unattached arbitrary map expansion.
- Keep one explicit shared scene focus. Individual `memberLocations` may refer to that focus, established UUIDs or the declared new references. Two players can therefore arrive in two independently new places during one turn.
- The server allocates UUIDs and saves the reference-to-ID mapping with the accepted checkpoint. Retries/restarts reuse it. Never make the model invent production UUIDs or allocate new IDs during narration/publication.
- Keep legacy `location`, `current` and `destination` outputs supported for saved checkpoints. Normalize fresh outputs through one shared helper; do not duplicate transitions in current and compatibility publication paths.
- Let pending discovery receipts reference the discovering character's declared destination, including a destination other than shared focus. Validate that the character actually arrives before placing the item. Preserve existing loot/tool limits and immutable receipts.

### Validate the cause of movement

- At turn 0, allow placement of actual starting roster members without submitted actions. Reject unknown/duplicate member IDs. This resolves the opening prompt/validator contradiction.
- Later changed positions require a supported successful movement effect belonging to the submitting actor. A successful search or unrelated check must not authorize travel.
- Same-place updates and unchanged position confirmations are distinct from actual movement. A failed/pass action must not teleport, but reporting its unchanged position is harmless.
- Model-authored separation must be represented in structured positions. Provide explicit prompt examples of separated branches and reconnecting routes; validate structured separation facts against positions. Do not depend on a broad regex parser of narrative prose.
- Preserve failed risky traversal. The compound-action rules below identify which movement actually completed.

### Apply all local state together

- Reuse `ensureLocations`, `memberScene`, `placeScene`, `savePlace` and `updateLocation` with the smallest necessary extension for registering several places. Persist encounter, loot, search exhaustion, environmental sources at each place.
- Apply all resulting positions atomically. Shared scene focus cannot drag the other characters along.
- Freeze the relevant occupied-place descriptions and hazards in the resolution for narration/review. Keep the current-focus fields for compatibility; an upper chamber and hazardous lower shaft must retain distinct local conditions.
- Check help/healing/support, combat planning, environmental sources, pickups and drops against the actor's place. Existing locality helpers remain the source of truth.
- Preserve the existing split-party display and local-loot panels. Feed them accurate IDs and show the character's own place clearly. In historical views, current equipment controls remain explicitly current.

Primary files: `shared/schema.ts`, `shared/turn-resolution.ts`, `shared/locations.ts`, `server/turn-resolution.ts`, `server/game.ts`, `server/providers.ts`, and affected recovery/UI paths.

Acceptance: two characters enter two new rooms in one turn; each sees local objects, can collect only local loot when otherwise unlocked, and has the correct interaction rules. Return/reunion, same-place renaming, narration retry and restart preserve IDs and spent/reward state.

## 4. Preserve completed movement before a failed embellishment

The existing components preserve failed checked main actions, but cannot separately express an earlier routine movement in the same submission. Do not solve this by relabelling a failed check as success.

- Preserve “before/after/then” execution order where the action economy and fiction permit it. Distinguish a check governing traversal from a check governing a stunt after arrival.
- Add only the bounded optional routine-movement component needed alongside main/minor outcomes for noncombat submissions. It represents ordinary traversal/preparation already within the allowed intent, not another full main action. Risky traversal, ability-assisted movement and resource use stay in main.
- Keep the checked main component and its receipt failed when its roll fails. If preceding routine movement succeeded, the overall outcome can be partial. Update aggregation, reference validation and engine constraints accordingly; old outcomes without this component retain their behavior.
- Position changes reference the exact successful movement event. A successful unrelated minor potion cannot justify movement, and a failed door unlock cannot permit entering through that door.
- Noncombat fictional ordering must place earlier completed traversal before the later stunt. Receipt acquisition order must not force narration to reverse the submitted sequence. Preserve immutable engine facts and combat initiative order; compose the additional noncombat movement event in the proper causal position.
- An absent enemy is an unavailable target. Do not spawn one merely to satisfy “kill every enemy,” grant an automatic kill or allow multiple full main acts. Explain which part was unavailable without losing the supported preceding act.

Primary files: shared action/event schemas and aggregation, adjudication/engine constraints, location validation and narration assembly/prompts.

Acceptance: routine tunnel traversal succeeds, a subsequent backflip check fails, no enemy is killed, and position remains at the reached destination. A failed check required to cross that tunnel instead retains the origin. A failed unlock plus a successful potion still cannot open the door. Cover legacy outcomes and retry reuse of the single saved check.

## 5. Make current item facts authoritative

- Keep journal discovery prose durable: where/how an item was found and its known purpose. Do not embed mutable “still lying there/uncollected” claims as permanent discovery lore.
- Bind item-discovery entries to a stable optional `itemId`. Persist that reference with an additive journal field, preserving existing entries and keys. Avoid matching arbitrary prose to inventory by item name.
- Derive current item availability from authoritative inventories and place loot. Show the holder or ground place only to the extent permitted by established public knowledge. Never convert another character's private/remote possessions into nearby loot.
- Use the same item-reference projection in public journal display and future GM context. Freeze its turn-specific public view for narration/review; current views may change after equipment actions while completed turn text remains historical.
- Equipment transactions already record pickups/drops. Use those events to reconcile linked public item facts; do not generate a new model request for ownership bookkeeping.
- Preserve per-player equipment locks. Show the applicable disabled reason next to pickup, including “already submitted,” processing, capacity or locality, so unavailable does not look like a mysterious location rule.

For the existing wrench entry, a targeted audited correction can replace the stale availability sentence with timeless discovery/purpose and link the proven item ID. Do not build a general multilingual journal-rewriting parser.

Primary files: journal schema/storage/migration and projection in `shared/schema.ts`, `server/db.ts`, `server/game.ts`; `src/EquipmentPanel.tsx` and journal rendering/context assembly.

Acceptance: find → take → drop → take leaves one authoritative item, the correct holder/ground place and no stale current “uncollected” claim. Explicitly test both independent locks: Ferrum submitted/Lava not submitted, and both unsubmitted in different places. The former tests readiness; the latter tests locality.

## 6. Make summaries emphasize changes

- Give narration and review the same instruction: describe meaningful changes, positions when relevant, newly known facts and established unresolved concerns in roughly two to four sentences.
- Supply a compact frozen previous situation or state delta, using the saved starting/current place state and journal. The narrator needs a concrete basis for recognizing what is unchanged.
- Omit unchanged safety and separation warnings unless they bear directly on this turn's action/question. Persistent hazard information remains available in the location UI.
- Keep rewards and equipment bookkeeping in the existing server appendix. Preserve event coverage and the factual fallback. Fallback summaries should use the same structured delta where possible and must not expose raw state serialization.
- Treat repetition as a presentation defect rather than adding another model review stage. Correct prompt examples and use the existing review; avoid increasing retries for cosmetic preferences or rejecting material facts simply because they recur when needed.

Primary files: resolution construction, factual fallback, narrator/reviewer input and prompts, gameplay reference.

Acceptance: several consecutive unsafe travel scenes retain visible safety state without closing on the same warning each time. Changed hazards and questions about them are still explained. XP coverage does not reintroduce the narrator/reviewer reward conflict.

## 7. Exercise factions through relevant world developments

Generation and starting ties worked in this save. No evidence requires redesigning reputation formulas or making routine movement earn reputation.

- Strengthen adjudication examples showing how an existing pursuit, contact or faction activity can produce a relevant observable clue, NPC response or world consequence during travel.
- Use existing activity/discovery/reputation effects and checkpointing. Record actual developments when supported; no faction-per-turn quota, automatic offscreen simulator or compulsory encounter.
- Preserve undiscovered names/private agendas. Narration receives public resolved facts, not the hidden registry. Helpful orientation never becomes a faction spoiler dump.
- Reputation changes require attribution through a witness, evidence or reporting and an actual consequential deed. Repeated favors stay deduplicated; affiliation stays separate.
- In a fresh isolated playtest, include an attributable faction deed, a secret deed, a repeat favor and a newly discovered faction. Continuing this campaign can provide additional evidence without prescribing the players' next action.

Primary files: faction contract/examples in `server/providers.ts`; existing validators/effects in `server/factions.ts`; corresponding tests/documentation.

Acceptance: a relevant existing faction affects a scene coherently; a witnessed deed changes only responsible characters' scores once; a secret deed does not immediately change reputation; new public knowledge does not reveal private agendas.

## 8. Reduce avoidable waiting and improve audit evidence

- First remove the opening correction, compound movement correction and unnecessary travel turns. These directly address recorded costs without changing models or retry budgets.
- Retain request/stage timing, byte counts and bounded correction feedback. Compare similar simple-travel, split-arrival, search and combat scenarios with the same selected model; report median and slowest turns, corrections, fallback and requests. The old exploration/combat averages are not a controlled benchmark.
- Keep ordinary no-tool turns at the existing baseline of one adjudication, one narration and one review request. Multi-place arrival and orientation should not add a model stage.
- Measure any context reduction before adopting it. Remove duplicate context already represented in structured state, but retain relevant local facts, faction context and public progress. Defer broad long-term-memory infrastructure.
- Record a build identifier and action submission time in bounded diagnostics so later audits can correlate source and per-player locks. Do not record credentials or save full private payloads merely for this issue. A submission timestamp assists later audits; browser checks still verify the actual disabled reason.

Acceptance: fresh orientation/arrival cases introduce no avoidable validation correction and no extra stage; timing comparisons distinguish tool continuations from corrections. Preserve reliability and factual review rather than setting an unsupported absolute latency target.

## Delivery order, saved games and verification

1. Implement orientation/pacing prompt examples and fix opening placement validation. Update the gameplay reference and README with the new help behavior.
2. Implement routine-movement provenance and multi-place registration together. Validate per-place hazards, pending loot placement and all interaction callers, then the existing split UI.
3. Add item-linked journal projection and clear pickup lock reasons. Add the summary delta and faction examples in the existing pipeline.
4. Preserve started checkpoints on their compatibility route. Fresh turns use the new fields/contracts. Completed narration, adjudications, rolls, rewards and equipment receipts remain historical evidence.
5. Prepare an idempotent correction for current Lava planet positions and the linked wrench fact from unambiguous saved evidence. First run it on a SQLite backup and inspect the before/after state. Apply only at a fresh turn boundary, retaining inventory, loot IDs, exhausted caches and rewards, with a correction event. Ambiguous current ownership/positions remain explicit rather than guessed; no live state is changed while this is merely a plan.
6. Extend existing focused tests in `tests/location-continuity.test.ts`, `tests/turn-resolution.test.ts`, `tests/factions.test.ts` and equipment/playtest browser coverage. Assert state, resources, causal outcomes and lock reasons rather than exact generated sentences. Reuse fixtures and avoid duplicating whole suites for prompt wording.
7. Run `npm run check`, focused tests, the full regression suite, affected browser tests and `npm run build`. Check restart/retry paths for stable IDs, no duplicate pickup/reward/recovery and no regenerated won encounter.
8. During implementation validation, use fresh isolated connected-provider campaigns for orientation, ordinary travel, two new arrivals, ordered movement/stunt, faction attribution and combat victory. Record usage/results separately from deterministic tests. Do not use the active campaign as a mutation fixture. A live playtest is still needed to establish improved model behavior.

Completion requires all eight workstreams to have either implemented behavior plus relevant evidence or a clearly documented remaining limitation. Passing mechanical tests alone does not establish better pacing, helpful orientation or natural faction involvement.
