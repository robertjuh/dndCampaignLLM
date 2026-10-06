# Turn-resolution repair plan

Status: implemented and verified, 5 October 2026. All five review findings are covered by passing regressions. The full suite passes 455 tests, the production build succeeds, and the turn-navigation/roll-accordion browser regression passes. All four isolated live-provider scenarios passed using 21 of the user-approved maximum of 40 model requests.

Implementation uses v2 adjudication/resolution contracts, shared component and receipt validation, frozen party identity and encounter routing, and `server/turn-recovery.ts` for deterministic checkpoint repair. Narration revisions prevent publishing prose approved against corrected facts. Additional review covered combat passes, skipped requested minors, equipment-slot attribution, reused resource receipts after encounter introduction, and attempts to disguise a failed main event with unrelated metadata.

Verification is in `tests/turn-resolution.test.ts`, `tests/turn-resolution-contracts.test.ts` and `tests/turn-recovery.test.ts`, including file-backed restart, all saved checkpoint boundaries and rollback of an interrupted repair. Ambiguous old free-form claims intentionally retain an explicit recovery error and their saved mechanics.

Live acceptance used the configured ChatGPT connection and `gpt-5.6-sol`, synthetic characters, in-memory campaigns and deterministic local dice. Existing campaigns were untouched. Every completed turn used a v2 resolution; manual prose review found no copied submissions or contradictory outcomes.

| Live scenario | Model requests | Observed result |
| --- | --- | --- |
| Hand recess, then open door | 5 | Both routine actions succeeded with zero rolls. The new chapel/map discovery justified +10 XP per character. Retrying interrupted publication made no further model request. |
| Self potion plus blocked main | 4 | The potion restored 4 HP; Stunned blocked opening the door. Main stayed blocked, minor succeeded and aggregate was partial. No XP was awarded. |
| Cleanse, then investigate | 8 | Cleanse removed Stunned from the ally without healing; the ally then completed one successful WIS check. The narrated discovery agreed with that saved result. |
| Encounter introduction retry | 4 | A controlled interruption after saving `startCombat` resumed through the live provider. The start receipt and initiative rolls were unchanged; no combat execution receipt was created, and narration left the first actions for the next turn. |

The goal is to fix all five reproduced failures while keeping the existing adjudication → finalization → narration → publication architecture. Reuse SQLite drafts, immutable tool receipts, existing combat metadata, provider budgets and the current retry UI.

## Decisions

### 1. Keep identity, current state and turn eligibility separate

Use all members in the frozen draft as the separated pipeline's party registry, both at claim and on refresh. `startingMembers` supplies the turn's character identities and names; `draft.members` supplies current mechanical state. The frozen roster and submitted actions determine who may act. A revived or inactive ally remains a valid recipient without receiving an invented submission. Late joins enter the next turn.

Resource events must resolve their actor and normalized target ID against that registry. An explicitly unknown target is a consistency error. An omitted target defaults to self only when normalizing the resource request. Remove the event adapter's fallback that substitutes the actor for a missing recipient.

Keep saved event IDs and execution order, but derive mechanical facts from their receipts. In particular, `executionEvents` must not retain an old healing fact merely because its ID is already cached. Its stored order supplies chronology; the resource receipt supplies who used what on whom.

Files: `server/game.ts`, `server/turn-resolution.ts`.

### 2. Route combat from the beginning of the turn

Determine whether a combat round is due from the encounter in the frozen starting context, with an explicit guard for a saved `startCombat` receipt. The refreshed scene may contain an encounter introduced by this turn; that encounter's first combat actions belong to the next collecting turn.

A retry after `start_combat` resumes adjudication with the saved encounter, initiative and loot draws. Preserve the existing `combat()` guard that prevents executing the introduction as a combat round. Existing combat still uses its saved plan and execution receipt.

File: `server/game.ts`.

### 3. Record main and minor results, then derive the aggregate

Add a small main/minor breakdown to action outcomes. Each requested component records its status, basis, fact/reason and relevant event/receipt references. A null component means that slot was not requested; an unresolved submitted main action cannot be omitted just because a potion succeeded. Passes have no action components and retain their explicit `passed` disposition.

Use one receipt adapter and one aggregate reducer for validation, provider examples and the practice provider. The server derives the aggregate; any aggregate fields retained in the proposal must match that calculation.

| Executed action | Authoritative slot |
| --- | --- |
| Check or selected utility ability | Main |
| Help-up or ally support | Main |
| Mend/Cleanse or an ally consumable | Main |
| Self consumable | Minor |
| Combat effects | Existing typed main/minor/aftermath metadata |

Stamp slot metadata on new resource receipts. Adapt existing receipts deterministically from their item/ability source and normalized target ID. Reuse that classification in action-budget guards so conflicting main uses are rejected before consuming another resource. Return an exact matching saved receipt first; then reject another main use when a check, support or main resource already spent that slot. Preserve legal main-action plus self-consumable minor combinations. This also closes the current gap that permits an ability and an ally item to consume two main actions.

| Component results | Aggregate |
| --- | --- |
| Successful main; no minor | `success` |
| Successful main and minor | `success` |
| Failed or blocked main; successful minor | `partial` |
| Successful main; failed or blocked requested minor | `partial` |
| Successful minor only | `success` |
| All attempted components blocked | `blocked` |
| Failure without a successful component | `failure` |
| A component is partial | `partial` |

Retain each component's failure even when the aggregate is partial. The aggregate basis follows the main component when present, otherwise the minor component. A failed main check plus a successful potion therefore remains a failed check within an aggregate `partial` action.

Executed receipts take precedence over capability snapshots. A successful check after an ally's Cleanse remains successful even if the actor started Stunned. A lethal failed check remains failed even if it subsequently downs the actor. When no main receipt exists, use current draft capability to determine whether the proposed main action is blocked. Existing tool rules continue to decide whether an action is legal at execution time.

Files: `shared/turn-resolution.ts`, `server/turn-resolution.ts`, `server/game.ts`, `server/providers.ts`.

### 4. Distinguish a cause from a successful prerequisite

Version the adjudication and resolution payloads as version 2. Keep `pipelineVersion: 1`, because the worker stages remain the same.

Events gain typed `phase` (`main`, `minor`, `aftermath`, or null) and `result` metadata. Mechanical values come from receipts; routine effects are adjudicated explicitly. Informational events may have a null result. Replace ambiguous dependency strings in v2 with:

```ts
{ eventId: string; requires: 'occurrence' | 'success' }
```

An occurrence dependency establishes that an earlier event caused this consequence, regardless of whether the attempted action succeeded. A success dependency requires `result === 'success'` on the exact referenced effect. It never reads the aggregate action's status.

| Example | Relationship | Result |
| --- | --- | --- |
| Failed opening attempt triggers an existing alarm | Occurrence of failed attempt | Allowed |
| Failed search exposes a new clue | Occurrence of failed search | Allowed; check remains failed |
| Opening a door requires unlocking its closure | Success of unlocking effect | Rejected if unlocking failed |
| Failed unlocking plus successful self potion | Success of unlocking effect | Potion cannot satisfy it |
| Partial action contains one fully achieved effect | Success of that specific effect | Allowed |

Validate phase/result against the component and authoritative receipts. A failed checked main action cannot append a contradictory successful main effect. Keep exact action coverage, receipt ownership and engine-event ordering. Reject unknown, duplicate, self and forward dependency references. The adjudicator must declare successful prerequisites where the fiction requires them; occurrence links are not evidence that a prerequisite was achieved.

Update prompts and examples together. Replace “every check failure stays failure” with “the checked main component stays failed”; permit partial aggregates and discoveries caused by failure. Keep the existing fidelity review and flat request budgets.

Files: `shared/turn-resolution.ts`, `server/turn-resolution.ts`, `server/providers.ts`, finalization event construction in `server/game.ts`.

## Saved-turn recovery

Retain version-1 read schemas for existing history, exports and checkpoints. New turns and pending turns without accepted adjudication use v2, reusing existing mechanics. Healthy accepted v1 checkpoints finish their saved stage through the compatibility reader; avoid bulk reinterpretation of their ambiguous dependencies.

Run a narrowly scoped pending-draft consistency check before choosing the resume stage. Healthy means consistent with saved receipts and supported action/world claims; schema validity alone is insufficient. In particular, an old potion-forced aggregate success may contain an unsupported main-success claim. Record a deterministic correction in the existing turn event log and save it atomically.

Apply a proven engine-fact correction to every stored copy together: cached `executionEvents`, accepted adjudication events, resolution events and derived `factualRecap`. Revalidate affected free-form action/world claims. If their correction would require a new gameplay interpretation, retain the recoverable failure rather than accepting inconsistent copies.

| Saved checkpoint | Recovery policy |
| --- | --- |
| Partial tools; no accepted proposal | Reuse dice and receipts; refresh derived events and continue adjudication with corrected routing and v2 validation. |
| Cached healing event names the wrong recipient | Correct that event from the saved target ID and frozen identities; preserve event IDs, order and receipt references. |
| Healthy accepted adjudication, resolution or narration | Resume from the highest checkpoint and retain it. |
| Wrong recipient fact already accepted or finalized | Correct only facts that can be established from receipts, plus their derived recap. Preserve finalized state, applied effects, rewards, journal/location and locked dice. |
| Narration was approved against a resolution whose facts changed | Invalidate the affected narration checkpoint and run the existing narration/review stage. |
| Accepted free-form claims or v1 dependencies cannot be repaired unambiguously | Preserve the draft and return a specific recovery error identifying the unsupported claim. Do not invent a replacement outcome. |
| Completed turn | Preserve history; report an affected completed turn separately if an audit finds one. |

Save a resolution revision in draft JSON and bind accepted narration to that revision. Publication rejects a mismatch. Existing untouched checkpoints default to revision zero; a factual correction increments the revision and clears narration in the same transaction. Metadata-only adaptation does not change the facts or require new prose.

The recovery path must be idempotent. It does not call gameplay tools, rerun finalization against finalized state, tick conditions again, or grant rewards again. Use existing transactions and event logging; no SQL table migration is required.

## Implementation order and regression tests

1. **Turn the five reproductions into failing regression tests.** Use real `Game` APIs and deterministic providers. Include a file-backed restart for encounter introduction and healing identity, then assert exact saved receipts, dice, state and provider stage calls.
2. **Fix encounter routing and frozen identity lookup.** Test new encounter introduction versus an existing combat round; natural-language revival of a non-roster ally; UI help-up; healing an injured inactive ally; explicit invalid target; unchanged next-turn membership behavior.
3. **Add v2 components, event metadata and dependency validation.** Implement the shared reducer/receipt adapter, then update ChatGPT and practice examples. Test main/minor combinations, potion-only intent, ability-plus-ally-item conflicts in both orders, legal main-plus-self-minor usage, Cleanse followed by a successful/failed check or routine action, uncleansed incapacitation, permitted Stunned self-use, prohibited Frozen/Electrocuted self-use, and lethal failed checks. Test every dependency example above.
4. **Implement checkpoint compatibility and targeted fact recovery.** Test an old cached wrong-target event, affected accepted/finalized checkpoints, stale narration, healthy saved narration, an ambiguous recovery error, and repeated retry after reopening the database. Assert that HP, inventory, charges, condition ticks and rewards are applied once.
5. **Verify and document the result.** Run the focused resolution/provider/game/persistence suites, then the full test suite and `npm run build`. Run the existing roll accordion browser regression. Update the architecture and gameplay documentation. Then playtest the reported door turn, a minor-action failure combination, a Cleanse interaction and encounter introduction/retry with the real provider.

Extend `tests/turn-resolution.test.ts` and reuse existing test helpers. Test the receipt-derived constraints and final state directly; keep at least one invalid proposal constructed independently of provider examples so the example and validator cannot hide the same mistake.

## Done when

- All five original reproductions pass as regressions, including restart recovery.
- Main/minor facts and dependencies agree with receipts, and the narrator receives those same frozen facts.
- A newly started encounter resumes without planning or executing its first round early.
- Retrying narration/publication preserves dice, effects, rewards and healthy accepted prose.
- Late joins, participation changes and replacements still affect the correct next turn.
- The ordinary provider request count and existing stage budgets remain unchanged.
- Automated checks and the targeted real-provider playtest confirm narrated outcomes, justified XP without mandatory dice, and expandable roll details.
