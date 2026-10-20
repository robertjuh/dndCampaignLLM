# Fluent turn resolution and lower latency — 18 October 2026

Status: implemented in the working tree and verified, 18 October 2026.
The changes apply to the system. No live campaign was reconciled or replayed.

Updated after the turn-14 failure: step 2a is an explicit encounter-continuation
fix, required before treating the recovery work as complete. The existing journal
fix helps this turn, but generous intent interpretation alone cannot resolve it.

The later turn-16 playtest exposed another recovery gap: action/world validation
could accept a retained projection that encounter planning would reject. Encounter
validation now runs before retention without drawing dice. Empty default scene
focus and omitted nullable public-world ownership are derived locally. The saved
turn was replayed to completion in an isolated database with recorded responses,
without rerolling combat or duplicating XP/loot. The live campaign remains untouched.
Follow-up verification passed: **831 unit/integration tests in 36 files**, the
production build, and the isolated saved-turn replay. Older movement repairs
retain their original optional encounter protocol instead of activating it.

Turn 22 exposed a further policy conflict: the hard second-turn pacing gate could
reject both partial recovery and its terminal fallback after a successful check.
Pacing now gets one bounded repair and can carry debt forward while valid actions
publish. Known routes may change through causally grounded remote controls; new
remote discoveries stay forbidden. Hazard prose edits retain the saved danger
classification unless explicitly reassessed. The recorded sailing response is
covered by a focused fixture, including full-journal consolidation and malformed
repair. An isolated database replay publishes departure and closes the gangway
without another roll, a passenger decision or a duplicated reward.
Turn-22 verification: **838 tests in 37 files**, production build and isolated
full-pipeline replay passed. No live campaign was rewritten or replayed.

## Implementation and verification

The [campaign-independent continuity follow-up](WORLD_CONTINUITY_HARDENING_PLAN_2026-10-19.md)
adds durable NPC interactions and public dialogue, bounded affected-ally reaction
coverage, cross-entity identity checks, event-time witnesses and route validation,
and independent recovery of valid exchanges/state changes. NPCs can converse with
players or each other and deliberately avoid fighting. Verification passed:
**966 tests in 43 files**, TypeScript and the production build. No live campaign
or completed history was changed; no new live model check was run.

The scene-continuity follow-up stores public feature state in the existing scene
save: stable IDs/aliases, location, changed properties and the supporting public
event. Ship control, locks, alarms and berth state supersede historical prose;
omitted properties survive. Updates cannot replace character/item mechanics or
invent remote objects. Known remote controls reuse the map's causal-local-action
validation. Bound route passability uses the actual map; detaching or rebinding
closes the old route. Positions, features and routes finalize atomically. Narration
gets frozen feature snapshots and matching journal entries show current status.

Movement now checks route state at the crossing event, including gathering and
mapped travel. A later closure cannot invalidate an earlier crossing. A causally
later opening stays unavailable earlier; an uncaused local world opening of a
known blocked route can be reordered before its matching crossing without a model
repair. Partial recovery retains independently valid feature/route changes, cannot
replace retained feature state, and saved encounter continuations freeze updates.
Focused regressions cover control, rebinding, passengers, provenance, locality,
remote controls, contradictory route state, partial recovery and restart after
finalization. No new model stage, dependency or database migration was introduced.
Verification passed: **889 unit/integration tests in 42 files**, TypeScript
checking and the production build. This follow-up made no live model requests
and did not rewrite campaign data or completed history.

The NPC identity/narration follow-up stores a public NPC registry in the existing
scene save, with stable IDs, aliases, location, allegiance, life status and saved
combat mechanics. Both combat entry paths restore known opponents and reject
death, duplicate participation or unreachable origins before drawing dice. Public
noncombat state changes cite observed resolved events and survive partial recovery
and encounter checkpoints. Existing encounters backfill the registry; completed
history and live campaigns are not rewritten. Current NPC status projects into the
journal, and narration receives the finalized identity/state snapshot.

Once gameplay is finalized, a writing/review provider exception publishes factual
narration immediately instead of spending an automatic retry or failing the turn.
This covers timeouts, network disconnects and HTTP failures. Revision guards and
storage failures remain publication barriers. Older crash tests now interrupt the
durable narration save rather than expecting an ordinary provider error to block
play. New regressions cover aliases, long alias histories, surrender, public
allegiance, observed movement, stale encounter rosters, injuries/loot on return,
permanent death and failed writing/review without repeated resource use.
Verification passed: **874 unit/integration tests in 41 files**, TypeScript
checking and the production build. No live model requests or campaign writes
were made for this follow-up.

The captain/loader follow-up adds NPC reactions to the existing combat planning
response. Grounded local or openly adjacent NPCs can reinforce the current fight
or record another public decision. The server checkpoints arrivals before round
execution, rolls only newcomers' initiative and loot, and lets them attack from
the next round. Explicit attacks can target a joining NPC immediately. Current
NPC decisions persist in the existing journal; earlier descriptions cannot undo
them. No additional model stage, NPC simulation service or database migration is
introduced. Isolated tests cover target resolution, retreat, provenance, locality,
duplicates, and restarts after arrival or after finalized combat. With explicit
user approval, an isolated live planning check against saved turn-7 context passed:
the captain joined and Rustbeard's combined boarding/attack targeted him. It took
67 seconds and three requests, with corrections for an empty equipment list and
an NPC name expanded beyond its quoted evidence. Empty equipment lists now reuse
existing server loot defaults, and the prompt explicitly requires literal quoted
NPC names. Those follow-ups are locally verified; latency has not been remeasured.
Verification passed: **852 unit/integration tests in 38 files**, TypeScript checking
and the production build. New regressions include first-round attack timing,
durable arrival/loot/initiative, current NPC decisions and death updates, local
and adjacent origins, invalid provenance, false death claims, and preserving a
named target when the planning response falls back. No live campaign was changed.

The existing pipeline now uses generous intent defaults, typed explicit pickup,
local repair of harmless metadata, complete server-derived aggregate/component
facts, known pass outcomes, canonical progress journal persistence and direct
resumption of saved encounters. Full and compact model response shapes remain
supported. Progress stages and elapsed time survive reconnect/reload. No new
model stage, dependency or database migration was introduced.

Pickup is simulated before encounter checks and applied once in finalization
through `takeItem`. This preserves capacity, source quantities, event-order
locality, competing claims and retry integrity. A failure blocks dependent
movement/discoveries without discarding independent actions. Pickup completed
before a newly triggered fight retains that order when the encounter resumes.
Existing combat still blocks ordinary ground-loot collection.

An exact saved encounter proposal is the resume authority. With all start receipts
present, the server appends a public introduction and skips adjudication entirely.
Incomplete starts reuse generated opponents and request only missing encounters.
The first combat round waits for new submissions. Older validated checkpoint
journals are retained exactly, including their original wording.

The server copies canonical progress facts and preserves earlier journal content
when it fits. At the limit, an explicit supplied consolidation may replace the
current entry; completed history remains saved. If automatic persistence cannot
fit, one existing compact semantic repair can consolidate that entry. It cannot
enter an endless append-and-reject loop. Discarded unsupported world consequences
do not receive aggregate narrative rewards; actual engine rewards remain receipts.

Verification: **829 unit/integration tests in 36 files**, **14 focused browser
tests**, TypeScript checking and the production build passed. The new isolated
playtest script also passes its standalone TypeScript check. Regressions cover
compact responses, omitted pass events, public journal provenance and limits,
capacity/quantity failures, competing/local/destination pickups, dependency
failure, interrupted publication, and saved encounter resumption at a new place.

Three isolated live scenarios using the connected `gpt-6-sol` provider passed:

| Scenario | Total stage time | Model requests | Corrections |
| --- | ---: | ---: | ---: |
| Explicit ampoule pickup | 27.3 s | 3 | 0 |
| Departure goal without an owned ship | 47.4 s | 3 | 0 |
| Pickup, routine handling and travel | 50.1 s | 3 | 0 |

Each kept the waiting companion at the original location. An initial live run
exposed missing pass bookkeeping; that was fixed generically and all three cases
were rerun successfully. These small scenarios establish working behavior, not a
general latency guarantee or a measured 41% speedup for complex turns.

An offline comparison with the same saved turn-3 context reduced request size
from 100,817 to 93,935 bytes (**6.8%**). Omitting derivable fields and duplicated
progress journal text reduced that recorded structured output's representation
from 14,506 to 11,994 bytes (**17.3%**); that second figure is a format comparison,
not a fresh model output or latency measurement. No network request was used for
this comparison. `scripts/playtest-fluent-turns.ts` reproduces the live scenarios
in isolated in-memory campaigns and can write their diagnostics with `--output`.

The implementation retains narration fidelity review, existing engine rules,
request/tool/deadline limits and historical checkpoint compatibility. Alternative
model selection and early publication of dice remain optional later experiments.

Give the GM authority to complete ordinary execution details, choose reasonable
defaults and make feasible progress toward the player's goal. Let the server
repair bookkeeping and execute supported mutations. Keep the existing
adjudication → finalization → narration/review → publication pipeline.

This plan covers both the latency recommendations and the interpretation changes
discussed after the [latest playtest analysis](PLAYTEST_ANALYSIS_SPACEPIRATES_2026-10-18.md).
Implement the changes in small increments, starting with the recorded causes of
unnecessary requests. Do not add an interpretation model call, another agent,
dependencies, a generic workflow framework or a configuration screen for this.

## Intended behavior

The working policy is:

> Interpret submissions generously. Fill in ordinary execution details and
> contextual defaults. If the requested outcome is unavailable, make the nearest
> feasible progress toward the same goal within this turn. Preserve completed
> steps and clearly describe unfinished parts.

Apply this through the existing adjudicator. Ordinary language interpretation
belongs there; server code should handle typed decisions, known references and
rules rather than grow a natural-language parser.

| Situation | Resolution |
| --- | --- |
| “I inspect the crate.” | Approach and inspect accessible surfaces, labels and ordinary handles as part of the act. Opening a sealed/locked container is a separate meaningful uncertainty when established. |
| “I take the ampoules and leave.” | Collect the accessible item through the server's inventory rules, then perform allowed travel. If collection fails, retain the item at its source and describe that result. |
| “I open that door.” | Use the most recently established plausible local door when context identifies it. Respect locks, explicit exclusions and failed prerequisites. |
| Ordinary attack without equipment details | Reuse existing equipped-weapon and target defaults. Do not activate an unrequested charged ability or replace explicit target restrictions. |
| “We fly away,” with no owned ship | Resolve only the submitting actor's nearest feasible step toward departure, such as reaching an established adjacent boarding area or inspecting transport locally. Do not grant ownership, pay fares or move companions. |
| Goal with several plausible approaches | Prefer a contextual approach with the fewest new commitments, ordinary equipment and the least additional travel. Do not choose combat or a purchase as an implicit prerequisite. |
| Several actions exceed the turn allowance | Complete the supported portion in expressed causal order; stop at the next action-budget or meaningful-risk boundary and describe the remainder as unfinished. |
| No coherent intention can be recovered | Provide brief observable local orientation without inventing a physical action, spending optional resources or granting orientation XP. Resolve the other actors normally. |

Routine substeps are parts of the declared act, not extra checks or extra main
actions. Approaching a crate within the current place differs from crossing a map
connection; neither rule permits crossing extra locations or bypassing combat.
For competing defaults with different meaningful consequences and no grounded
preference, perform their common feasible preparation or stop before choosing
between them. Do not randomly make a major decision for the actor.

The GM may establish ordinary features consistent with the setting, such as a
departures board at a dock or a public cargo-handling area. Those are authored
world facts saved during adjudication. Explicitly existing facts, player choices,
locality and engine receipts constrain them. Ordinary detail must not silently
unlock a blocked route, reveal a secret, guarantee a check result, create owned
equipment or supply a missing scarce resource. Quiet actions may simply succeed;
progress does not require a new obstacle, clue, fight or reward every turn.

Meaningful player commitments remain explicit: initiating violence, joining a
faction, accepting a contract, paying money, discarding valuables, using a charged
ability, choosing another character's action or taking an unrelated objective.
Explicitly requested acts may have their normal costs and risks. Never change
saved dice or convert a failed prerequisite into success to preserve momentum.

## Existing implementation to extend

| Area | Current behavior and relevant files |
| --- | --- |
| Interpretation and provider loop | `server/providers.ts` already requests plausible interpretations, routine outcomes, tool batching and compact output. Replace conflicting instructions and simplify this contract instead of appending another long rules section. |
| Local normalization | `normalizeAdjudicationReferences` in `server/world-map.ts` and `normalizeAdjudicationStructure` in `server/turn-resolution.ts` already repair provable references, movement metadata and ordering. Extend these paths. |
| Validation and recovery | `shared/turn-resolution.ts`, `server/turn-resolution.ts` and `server/adjudication-recovery.ts` validate components and retain dependency-complete progress. Recovery currently may request another model patch before accepting retained results. |
| Durable world facts | `server/world-progression.ts` requires a progress event's exact normalized sentence inside the cited journal detail. Different wording caused three repair requests in the latest run. |
| Inventory | `Game.manageCharacter` in `server/game.ts` supports collecting-phase pickup and uses `takeItem` from `shared/rules.ts`. `offerLoot` establishes ground loot. Generic model item changes are rejected; there is no matching adjudication pickup operation. |
| Checkpoints and presentation | `server/game.ts` saves adjudication, finalized resolution and narration; `shared/schema.ts`, `src/main.tsx` and existing campaign events expose turn state. The resolving UI currently shows a generic spinner. |

Preserve [position continuity](POSITION_CONTINUITY_FIX_PLAN_2026-10-17.md), existing
combat defaults, the gathering exception, location-scoped loot, immutable
receipts, frozen rosters and atomic publication. Completed history is not replayed
or rewritten. An accepted adjudication is resumed as saved; new interpretation
rules apply when an adjudication has not yet been accepted. Finalized turns resume
narration/publication only.

## Implementation sequence

### 1. Reproduce the measured corrections and establish the baseline

Create minimal fixtures from the latest opening and turns 1–3 in the existing
provider/resolution test suites. Retain only the context needed for each failure;
do not commit full private campaign logs or credentials. Include:

- A public world event with a missing genuinely empty `receiptRefs` list.
- An ordinary interaction event carrying redundant `effect:"interact"`.
- Valid local progress whose cited journal entry paraphrases its event fact.
- Rustbeard's explicit pickup before movement to another location.
- The two-destination turn with separate arrivals and a failed search whose result
  must survive every normalization/recovery path.
- Turn 14's saved boarding proposal, triggered encounter at a new place, started
  captain encounter, rewritten continuation and failed retries. Cover an unchanged
  zero reward with a differently worded reason, a changed action description, an
  introduction with the wrong phase/missing receipt, and an introduction-only
  patch referring to the new place declared by the saved proposal.

Record request counts, correction causes, input/output tokens and total stage
time using existing diagnostics. Use the preceding Verdant Engine narration
failure as a negative example: the reviewer must continue rejecting invented
faction responsibilities.

Acceptance: fixtures reproduce the old failures without a network request or a
write to the live database. The performance baseline remains the measured
2:09, 2:07 and 5:14 played turns; the 41% correction opportunity is an estimate,
not a new performance result.

### 2. Resolve proven bookkeeping errors locally

Extend normalization before strict schema/reference validation:

- Remove redundant `effect:"interact"` from an ordinary interaction event when it
  asserts no movement/search proof or mechanical effect. Reject other unknown
  effects instead of broadly dropping invalid metadata.
- Supply `receiptRefs:[]` only for model-authored routine/informational events
  that require no engine receipt. Missing required mechanical evidence stays
  invalid; never default an immutable engine event into another result.
- Reuse existing location aliases, causal ordering and action aggregation.
  Derived status, receipt/event unions and aggregate descriptions should come
  from validated components rather than require another generated copy.

Make journal persistence deterministic. Resolve and validate the progress event's
identity, public visibility, thread, actor presence, locality and dependencies,
then include its canonical fact once in the cited journal entry. Preserve the
previous canonical content, current updates, field limits and existing faction
visibility restrictions. Do not silently truncate history to fit the limit.
If the combined text does not fit, use the bounded semantic recovery path for
that entry; do not regenerate the entire otherwise valid turn. Exact-wording
persistence alone must not trigger a model correction when local insertion fits.

The shared normalizer must be idempotent and used by the initial proposal and
repair paths. Canonical journal content must be present in the saved accepted
adjudication and final resolution, so retries cannot append the same fact again.
Do not add a second semantic-review call for contradictions; preserve the existing
adjudicator's responsibility and the deterministic continuity checks.

Acceptance: the recorded label, empty-list and journal-wording failures pass
locally without correction calls. Wrong actors, fabricated receipts, failed
movement, foreign journal evidence, secret faction text and contradictory engine
results remain rejected. Narration still receives the normal fidelity review.

### 2a. Resume triggered encounters from their saved proposal

The newly observed turn-14 failure is a checkpoint-continuation problem. The
server saved successful boarding and a dangerous-deck d6 result of 1, then created
the captain encounter. Further model responses regenerated the exploration
instead of only supplying the encounter introduction. `assertEncounterProposal`
in `server/encounters.ts` correctly rejected changes to frozen fields, including
the prose reason for an unchanged zero reward. Generic progress recovery then
retained no components, losing the saved deck declaration from its working patch
context. One patch consequently failed with an unknown `new:scheve-lepel-dek`
reference. Other patches hit the already known journal-wording failure.

Treat `receipts.encounterProposal` as a distinct resume boundary within the
existing adjudication stage. Once it exists, use its exact actions, rewards,
positions, map/place declarations, journal and event prefix as the base. Bypass
generic action reinterpretation and generic receipt-only recovery for this path.
Keep `assertEncounterProposal` strict; do not weaken saved-result integrity to
accept regenerated prose.

Start only required encounters without a saved start receipt. Reuse existing enemy
identities, initiative, equipment, encounter dice and participants on retry. Once
all required start receipts exist, assemble a factual public encounter
introduction locally from those receipts and the saved place/context. Introduce
the opponents without executing their first combat round or inventing a new
attack, reaction, clue, secret motive or player action. Supply the required
`phase:aftermath`, locality, causal references and start-combat receipt reference
in code. The normal narrator can turn this saved event into prose.

This should need no further adjudication model request after the required
opponents have been generated. If a particular continuation genuinely needs
additional fictional authorship, the existing bounded request may return only
allowed encounter additions. Merge those into the immutable saved base before
reference normalization and full validation. Never require the model to copy the
whole saved turn exactly or use its changed frozen fields as replacements.

Resolve encounter patches against both established locations and the saved
proposal's new-place declarations. Reuse its `new:` references until normal
canonical ID allocation; keep the map, positions and encounter receipt attached
to the same place. Allowed hazard/atmosphere refreshes must retain place identity.
Apply deterministic journal persistence before freezing the proposal in new
turns; existing valid frozen proposals remain exact on resumption.

Acceptance: reproduce turn 14, including a process restart after the encounter
starts. Retry must finalize the saved boarding and introduce the same captain,
without new dice, enemy generation, action rewrites or another adjudication call
when all start receipts exist. The first fight round waits for new submissions.
Test current and new locations, multiple triggered locations, already started
opponents, missing start receipts, invalid introduction fields, journal prefixes
and conflicting attempted checkpoint mutations. Extend the existing
`encounter-provider`, `encounter-flow`, `encounter-durability` and turn-recovery
tests. Recovery must neither drop the encounter nor teleport the actors back.

### 3. Give the existing adjudicator explicit discretion

Replace overlapping prompt passages with the policy and examples above. Keep a
clear distinction between mundane execution, feasible partial progress, world
authorship and a new player commitment. Ensure combat planning, adjudication,
repair and narration instructions agree on those distinctions.

Use existing components and facts to record the actual interpretation. Keep the
original submission visible. Store any concise explanation in the existing
component `reason`; add no confidence score, model routing layer or separate
intent classifier. Narration should naturally state what happened and what remains
unfinished, without an approval dialog or an apology for interpreting the input.

Resolve travel against existing `travelNextHops`, explicit avoid/via restrictions,
blocked/one-way connections and the actor's own location. Prefer the nearest
supported step toward the submitted goal. A first visit can author its ordinary
arrival facts and exits through existing world/map updates; it cannot invent a
complete distant route. “We” never authorizes other players' movement.

For compound requests, preserve expressed order and dependencies. Collapse
mundane handling into its parent act, retain the existing movement/main/minor
allowances, and stop before a second independent uncertain main action. A failed
main can leave earlier movement or handling intact. If there is no physical
interpretation, use the existing information/orientation representation; condition
ticks and enemy actions retain normal group-turn timing.

At opening generation, provide a concrete opportunity connected to the campaign
and party motivations, such as accessible ship-related activity for space pirates.
Establish observable opportunities without assigning ownership or selecting a
quest for the players. This reuses opening adjudication and existing progression
rules, with no additional world-generation request.

Acceptance: an ambiguity matrix covers Dutch and English submissions, pronouns,
negation, explicit restrictions, uncertain prerequisites, excess action chains,
split parties and nonsensical input. Every actor receives a coherent outcome;
mundane ambiguity adds zero interpretation requests. Defaults never spend an
unrequested consumable/ability, award an unavailable item or change another
actor's submission.

### 4. Execute explicit pickup through finalization

Support pickup as a typed instruction in accepted adjudication, executed in
finalization. This avoids an additional model tool round trip for an existing
ground item. Add an optional `pickups` collection containing the actor ID, real
item ID and owning action-event ID; derive the source location from that event and
the saved item. Missing `pickups` in old checkpoints means no pickup. Update the
practice provider and shared adjudication adapters as needed.

For a newly created story item, reuse the real item ID returned by the existing
`offer_loot` receipt. That tool still establishes the item once; it does not imply
pickup. An item merely inspected or discovered remains on the ground. A loot
blueprint is never an owned item or a valid pickup source.

Extract/reuse the existing pickup mechanics around `takeItem` for the UI and draft
paths, with separate entry guards. Do not call the collecting-only public
`manageCharacter` method from the resolver or remove its processing lock. Enforce
explicit taking intent, item availability/quantity, carrying capacity, permitted
combat state, actor capability, and ownership/location at the action's execution
point. Use existing turn event order for competing claims; stable existing actor
order breaks genuine ties. A second actor cannot obtain the same unit.

Evaluate pickup before/after movement according to event dependencies, not the
actor's final position. Picking up at the origin before leaving and picking up
after a successful arrival are both supported. A failed traversal cannot collect
destination loot. Bound quantities to actual items; use existing story-item
bundles where applicable, without inventing stock.

Pickup instructions are proposed operations, not authoritative ownership claims.
Finalization creates the actual pickup result and updates the owning component,
events, inventory and source loot coherently before narration. Ordinary failures
such as full capacity or an item already taken become partial/blocked outcomes;
they do not restart model generation. Preserve other valid components. Never
drop, equip, buy, consume or steal a guarded item merely to make collection fit.
Theft and guarded access still require their normal adjudication/checks.

Persist pickup results with the existing finalized draft transaction/checkpoint,
including quantity and source changes. Rollback, retry and restart must preserve
exactly-once effects. Publication only copies finalized state. Project journal
item availability from authoritative state instead of permanent ownership prose.
Remove blanket prompt language forbidding explicit pickup while retaining the
prohibition on unrequested inventory mutation and generic narrative item changes.

Acceptance: the ampoules reach Rustbeard's backpack before he leaves, or have a
specific server-owned collection failure. Test existing/new loot, same-item
competition, capacity, negative taking intent, split locations, combat, destination
failure, partial quantities and retry/restart after finalization. Narration-only
retry performs no pickup and draws no dice.

### 5. Prefer a coherent partial result to another correction

Use the current progress-retention helper and real validators. After local
normalization, retain dependency-complete components, matching positions, public
world facts and actual tool receipts. Treat harmless schema failures as local
repair opportunities; treat meaningful contradictions as unresolved components.

Make another semantic patch conditional on whether a required result is still
missing and cannot be represented coherently from the existing proposal and
receipts. Do not request a patch solely because an optional component was omitted
or a bookkeeping correction occurred. Preserve the existing single compact
semantic repair opportunity within the shared request/deadline budget.

The server may derive routine bookkeeping and factual partial outcomes; it must
not invent a clue or NPC decision that the adjudicator never established. If an
unresolved act needs such authorship, use the existing compact patch once when
necessary. On failure, finalize the supported portion and describe the remainder
as unperformed. If nothing meaningful was recoverable, use public orientation or
the existing factual receipt fallback, without treating a format error as an
in-world obstruction. No success, reward or resource use is invented to fill a gap.

Required triggered encounter handling, authentication/provider failures and
checkpoint-integrity failures retain their existing recovery paths. Partial
publication cannot bypass a saved encounter, change immutable receipts or
discard effects already executed by the engine. Keep narration/review enabled
for partial turns with meaningful accepted facts.

Acceptance: one actor's ambiguous component does not discard another actor's
success. A retained arrival always matches its position. Failed checks and exact
success dependencies survive. Coherent retained results cause no optional repair
request; a genuinely missing material consequence consumes at most the existing
one compact patch. Existing request/tool/deadline caps are not increased.

### 6. Reduce generated text and repeated context

Once local recovery and new operations are stable, shrink the provider-facing
shape while keeping complete internal saved outcomes:

- Accept a compact component representation and derive redundant action
  aggregates/receipt unions with existing helpers. Preserve the old full shape as
  a compatibility input. Expand before saving/validating the canonical checkpoint;
  do not make narration or old-history readers infer missing mechanical facts.
- Keep adjudication facts and reasons concise; place sensory detail in narration.
  Copy canonical progress sentences into journal data locally rather than generate
  them twice. Do not collapse distinct main/minor/movement effects.
- Supply progression thread references to already included journal/history facts
  instead of repeating full prose. Keep all needed thread identities and lore.
- Factor repeated instructions and omit genuinely inapplicable sections while
  retaining rules for available tools, possible combat introduction, passive
  interactions and saved abilities. Do not remove secrecy, locale, action-budget
  or mechanical authority constraints to achieve a byte target.
- Let independent game tool requests share a model response. Execute independent
  calls through the current safe ordering; do not parallelize draft mutations.
  A dependent call still waits for its prerequisite receipt.

Acceptance: compare equivalent fixture turns before/after for input/output size,
request count and accepted results. The two-arrival fixture must show a material
payload reduction without losing either scene, its map evidence or any actor's
outcomes. No-tool/no-correction turns still use three requests; batching independent
tools does not add a planning request or repeat a saved tool.

### 7. Show elapsed time and useful processing stages

Add a small additive progress projection to turn snapshots using the existing
draft/campaign event and SSE mechanisms. Record stage transitions with a start
time; expose current stage and elapsed time, not prompts, private facts or
unaccepted story text. Refresh/reconnect/restart should recover the projection
from the persisted draft/checkpoint and existing events.

Use simple labels: “Resolving actions”, “Writing the story”, “Checking the story”
and “Finishing turn”. Include world preparation at opening when applicable. The
narration provider must report writer/reviewer transitions inside its current
stage; neither needs a new model request. Reuse the existing browser event
connection rather than add polling or a telemetry service. Do not emit a snapshot
for every token.

Initially keep the story's normal atomic publication. Early finalized dice/outcome
display is a later optional presentation improvement, only if players can clearly
see that narration is pending. Stage feedback is sufficient for this delivery.

Acceptance: phone/player and shared screens display elapsed time and correct
stages, including partial recovery and restart; historical browsing stays fixed.
No private facts leak through progress. State still publishes once.

### 8. Verify improvement and document the new contract

Extend existing focused suites rather than introduce a new test framework:
`providers`, `turn-resolution`, `turn-resolution-contracts`, `world-progression`,
`playtest-followup`, `position-recovery`, `location-continuity`, `rules` and
`turn-recovery`, plus the encounter provider/flow/durability suites. Use focused
browser cases in the existing playtest/recovery/map
suites for pickup and progress. Add tests with behavioral assertions, especially
negative authority cases and interrupted checkpoints; avoid mirroring helper code.

Run relevant focused tests per change. At integration completion run:

```sh
npm run check
npm test
npm run build
npm exec playwright test tests/browser/playtest-improvements.spec.ts tests/browser/turn-recovery.spec.ts tests/browser/world-map.spec.ts
```

Update `GAMEPLAYLOOPPROMPT.md`, `README.md` and the relevant existing resolution/
progression notes to describe interpretation defaults, explicit pickup, partial
outcomes, compact outputs and progress labels. Include touched modules in the
gameplay build fingerprint. Keep old accepted checkpoints readable; add no SQLite
migration unless implementation exposes a concrete need beyond additive JSON.

Prepare an isolated live playtest using a temporary database and the connected
provider after automated checks. Preserve the live campaign and completed history.
Compare ordinary acts, vague references, departure without a ship, pickup before
travel, a compound request, split arrivals and failed prerequisites. Report model
calls, corrections by cause, input/output tokens, completion time, semantic outcome
and any lost progress. A mock verifies control flow, not real latency or language
quality; distinguish those results clearly.

Retain existing duration/token diagnostics and add only small bounded reason
counts for local normalization, partial recovery and pickup outcomes where useful.
Do not record extra full prompts or private world facts in player-visible data.

Acceptance for delivery:

- Recorded harmless label/journal failures require zero model corrections.
- Supported ambiguous inputs complete without a clarification turn or a separate
  interpretation call; partial results preserve actual progress and receipts.
- Explicit pickup is real inventory state and survives interrupted publication.
- All actors, locations, action budgets, numerical results and secrecy rules stay
  consistent across resolution, narration, journal and UI.
- Equivalent live scenarios show fewer correction calls and smaller structured
  output; report actual timings instead of promising the estimated 41% saving.
- Players can see what is processing and what their characters actually achieved.

After these changes, benchmark alternative models/settings per existing stage
only if end-to-end latency remains unacceptable. Measure accepted results and
correction frequency together. Keep fidelity review in the initial delivery;
changing model choice or removing review is not a prerequisite for this plan.

## Delivery order and state handling

Deliver steps 1–2a first for the directly measured delays and blocked encounter
continuation, steps 3–5 together for
fluent interpretation with working pickup and recovery, then steps 6–8 for lower
baseline latency, progress feedback and final acceptance. Each increment should
leave the existing pipeline runnable and tested; this is one implementation
sequence rather than a new parallel-agent project.

Do not automatically reconcile the saved spacepirates campaign. The ampoules and
positions may have subsequent legitimate changes. Any later requested correction
must inspect the then-current state at a stable turn boundary and preserve all
intervening history, receipts and quantities. Ordinary implementation requires
neither replaying completed turns nor editing the live SQLite database.
