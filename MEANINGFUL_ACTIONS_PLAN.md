# Meaningful action resolution

Status: proposed for review, 23 October 2026. Implementation has not started.

## Intended behavior

Meaningful player attempts should change what the characters know, can do, or
face, with consequences that persist into later turns. The LLM supplies fitting
details, obstacles, outcomes and reactions within the established world. The
server owns dice, action limits, resources, legal movement and saved state.

This applies across technical, social, investigative and physical interactions.
Hacking cameras is one example. A repair, negotiation, diversion or unfamiliar
creative approach should use the same general process without registering a
new action verb or writing a separate mechanic for that activity.

Routine actions, real failures and quiet moments remain valid. Progress does not
mean guaranteed success, a clue after every failure, automatic rewards, or a new
quest or fight every turn.

## What already exists

The scene GM already supports actions, meetings, investigations, movement and
world developments. Existing validators and publication save object properties,
NPC facts, discoveries, routes, quests and private preparation. Investigations
already prepare outcomes before dice and preserve their results across retries.

The reliability gap is in adjudication. A general action can currently default
to routine success when no mechanical receipt or explicit blocker exists. The
recent security guard addresses certain recognized words, but does not provide
a general decision contract.

## Proposed work

### 1. Make the GM's decision explicit

Add a compact structured decision for each submitted meaningful main intent:
the intended goal, approach, achievable scope, classification and reason.
Use three classifications:

- **Routine:** feasible with no meaningful uncertainty; resolve directly.
- **Uncertain:** feasible, with meaningful resistance or risk; use a fitting
  attribute and difficulty through the existing check engine.
- **Blocked:** an actual established obstacle or capability limit prevents the
  attempt; identify that cause and resolve any feasible part of the submission.

Ordinary observation, willing conversation and already-authorized operations
remain lightweight. They do not need citations proving that ordinary activity
is possible. Missing database preparation or a processing error cannot become
a fictional blocker. The model may fill ordinary missing details consistently;
it may not invent an impossibility to avoid resolving a plausible attempt.

For compound submissions, preserve distinct goals and their order within the
existing action allowance. Related substeps can share one fitting action/check;
independent extra actions receive an explicit turn-limit deferral.

### 2. Bind uncertain attempts to their stakes before dice

Record what the character is attempting and what success can accomplish before
the roll. Describe a fitting failure consequence or the possibility of no
material change, without deciding the result in advance. Freeze this preparation
with the attempt so the final response cannot narrow success or redefine the
task after seeing the dice.

Reuse the existing investigation path for information gathering. For other
interactions, attach the small preparation payload to the existing check/tool
flow and checkpoint it alongside the receipt. Keep one immutable check per actor
and the current action/resource rules. This does not introduce a mandatory
separate planning or critique request.

On success, deliver the scoped result: an actual repair, usable information,
access, cooperation or changed circumstances. On failure, preserve the failed
goal. A setback, lesser finding or different opening is allowed when it fits;
failure never silently grants the denied goal.

### 3. Save consequences through the existing operations

Use current scene features, NPC updates, journal entries, routes, quests and
private notes. The LLM authors their appropriate contents; the compiler creates
canonical identities, event references and dependencies.

Material claims must identify their matching state changes. A repaired device
must be saved as repaired; an agreement or discovery must be remembered through
the appropriate existing record. Temporary atmosphere and harmless gestures
need no artificial object or progress record.

Later actions receive and use the saved consequences. Acquired camera access
allows subsequent authorized viewing or shutdown without repeating the same
intrusion uncertainty. Repaired machinery works until an established change
affects it. Neither success nor a newly available option commits another player
to an action. Dependent submissions require their actual prerequisite: camera
access alone does not satisfy a condition requiring cameras to be offline.

### 4. Validate the general contract and preserve compatibility

Replace the security-specific check policy with shared checks on the structured
decision and its effects. Keep existing inventory-consent and player-agency
guards; do not grow a list of verbs that automatically require dice.

Validate that declared uncertainty has a matching saved roll, results agree
with engine receipts, claimed material changes have corresponding updates,
blocker evidence exists at the relevant place, and no action invents costs,
abilities, rewards or another player's decisions. Invalid output receives
targeted correction within the existing request budget; processing exhaustion
keeps the turn retryable.

Apply the new contract to newly started scene turns. Persist its protocol marker
in the existing checkpoint data so already-started turns retain their accepted
contract. Audit partial-progress and encounter continuations as well as the
common scene path. Retry must reuse prepared stakes, checks and accepted
components; publication remains atomic and cannot duplicate effects or rewards.

Combat, travel and gathering retain their existing mechanical resolution and
action limits. General consequences must respect those receipts rather than
create a second action or roll for an already executed component.

### 5. Verify across different kinds of play

Use small isolated scenarios with both success and failure, plus continuations
that demonstrate the saved result matters. Include an unfamiliar verb or
paraphrase to demonstrate that behavior follows intent rather than a keyword.

| Scenario                           | Required evidence                                                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Hack camera controls               | A real check; success saves scoped access; failure grants none; later authorized commands use that access.                                      |
| Repair a generator                 | Success restores its saved working state and enables relevant machinery; failure leaves it broken.                                              |
| Negotiate cooperation              | A willing ordinary exchange needs no roll; resisted persuasion can use one; the resulting agreement, refusal or reaction is remembered.         |
| Examine tracks                     | Useful scoped information and a justified lead persist; failure cannot reveal the sought answer as though successful.                           |
| Manipulate the environment         | A plausible physical change affects the next submitted action without invented damage, free powers or extra actions.                            |
| Routine or blocked attempt         | Routine acts stay simple; an established impossibility has a concrete reason; invented missing prerequisites cannot replace a feasible attempt. |
| Compound or conditional submission | Goals retain their order and action limits; dependent acts use actual outcomes rather than assumed success.                                     |
| Retry and restart                  | Prepared stakes, dice, permissions, discoveries and effects survive without rerolls or duplication.                                             |

Run focused regressions, the full unit/integration suite, TypeScript checks and
the production build. Preserve the existing prompt-size and request-budget
checks. Measure calls and corrections in the representative scenarios.

Mocked responses can verify the contract, persistence and correction behavior;
they cannot establish that the model makes good judgments. After those checks
pass, validate the same varied scenarios with the configured GM model in an
isolated playtest, within the user's agreed model-usage allowance. Compare
decisions, useful consequences and repeated-action behavior, rather than prose
length. Existing completed play history is not replayed or advanced by tests.

## Validation limits

Code can verify that a declared check happened, that it was successful, that
referenced evidence exists, and that a claimed update was saved legally. It
cannot generally prove from free text that an attempt deserved a roll, that a
cited fact justifies impossibility, or that a consequence is interesting.
Those remain GM judgments, guided by the contract and assessed with varied
model playtests. More mandatory rolls or more generated events are not measures
of better play.

## Expected code areas

- `server/providers.ts`: shared GM instructions, compact decision/check input,
  model context and targeted corrections.
- `server/scene-turn.ts`: decision schema, compilation and consistency checks.
- `server/game.ts` and shared check/turn types where needed: saved preparation,
  protocol compatibility and retry-safe receipt handling.
- Existing investigation, feature, NPC and progression modules: reuse their
  authoritative records and validators; add only integration changes required
  by the new decision contract.
- Focused tests, `README.md` and `GAMEPLAYLOOPPROMPT.md`: acceptance evidence and
  the resulting gameplay rules.

The first implementation step after approval is the compact contract and its
focused tests. Extend existing operations only where those scenarios expose a
real representational gap; do not add a new action catalog, a separate rules
engine, a mandatory extra GM pass or automatic progress quotas.
