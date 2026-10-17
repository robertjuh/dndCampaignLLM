# Underwaterworld session audit — 13 October 2026

Audited on 16 October 2026. Campaign `3e387500-0b0c-4b68-9a85-dd52456554f9`.
Read-only inspection of the live SQLite database, saved stage diagnostics and
retained model request/response files. No gameplay request, save correction or
runtime code change was made.

This is the latest campaign with played turns in the local database. The newer
Warhammer campaign was still in preparation at inspection time. Underwaterworld
has an opening, five completed player turns and a collecting turn 6 with one
submission. The campaign used `gpt-6-sol`.

## What actually fell back

| Turn | Processing time | Result |
| --- | --- | --- |
| 1 | 2m 36s | Normal story; no adjudication corrections. |
| 2 | 4m 00s | Adjudication fallback after three rejected structured outputs; narration deliberately skipped. |
| 3 | 2m 41s | Normal story after one adjudication correction. |
| 4 | 4m 25s | Normal story after two adjudication corrections. |
| 5 | 1m 59s | Normal story; no adjudication corrections. |

Times sum the recorded stage durations and exclude time waiting for player
submissions. There was **one actual fallback turn**, rather than three. Turns 3
and 4 recovered from similar output-contract problems. All returned requests in
these five turns completed with HTTP 200; no timeout or automatic retry was
recorded. Narration fidelity review did not cause the turn-2 fallback.

Turn 2 had these submissions:

- Vesperveil: inspect the hatch.
- Anglerfish man: find a way to the lower hull.
- Neris: go to the wreck.

The saved dice established Vesperveil's successful INT inspection and Anglerfish
man's failed WIS search. The model's first complete proposal also established
ordinary arrival at the wreck for both travellers, a loose hatch hinge and thaw
channel from the successful inspection, and a lesser observation beneath the
stern from the failed search. The hatch remained closed; failure did not become
entry into the hull.

Three structural errors exhausted the correction budget:

1. `beforeEventId` was attached to `components.movement` instead of its movement
   event. The movement prompt says to set the field without explicitly naming
   its object, making this an avoidable contract ambiguity.
2. Search information depended on the fictional search outcome, which itself
   depended on the correct check. `validateExploration` requires a **direct**
   check dependency and rejected this otherwise grounded two-link chain.
3. A correction removed the misplaced ordering field without moving it onto the
   event. The server then rejected movement ordered after its destination check.

The fallback retained dice receipts but discarded the proposed arrivals and
discoveries. It published bare check announcements and “Neris cannot carry out
the submitted action.” Neris's ordinary journey had not failed in the fiction;
its unresolved output was converted into a blocked action by the fallback.
Players consequently resubmitted travel and inspection in turn 3. Vesperveil's
new inspection failed, so the useful turn-2 success never became a saved clue.

The same direct-search-dependency rejection recurred in turns 3 and 4. Turn 4's
second rejected proposal additionally listed unowned world events in actors'
`eventIds`, despite those events correctly retaining null ownership. These were
reference-list errors rather than evidence that the story needed to be discarded.

## Offline check of the smallest repair

Replayed all three retained turn-2 proposals against the current
`validateAdjudication` function and the turn's frozen context and saved receipts.
Each reproduced its recorded rejection. In isolated JavaScript objects:

- Relocated the misplaced ordering field onto the unique successful movement
  event and supplied the actor's first main mechanics event as its ordering target.
- Added direct search-to-check dependencies only where the proposal already
  established the matching dependency through that same actor's search event.
  Successful checks retained `success`; failed checks retained `occurrence`.

**All three repaired proposals passed the current adjudication validator.**
Assertions confirmed unchanged event facts, event results, receipt references,
aggregate statuses, proposed positions and rewards. No new clue or success was
invented by this check. The first proposal preserved both arrivals, the inspection
discovery and failure with lesser information.

The two subsequent turn-2 rewrite requests consumed 70.007s and 71.804s. That is
142 seconds spent after the first complete proposal on corrections that this
offline repair could handle. This is not a measured live speedup: narration,
finalization and publication of the repaired proposal were not executed.

## Recommended changes, in order

### 1. Repair obvious structure before requesting another full response

Extend the existing local adjudication normalization path, then run the full
validator as usual. Limit repairs to unambiguous already-declared evidence:

- Move misplaced movement ordering metadata and infer ordering for a unique
  ordinary movement event before its actor's destination check or resource use.
- Recognize equivalent search dependency chains, or add their provable direct
  edge. Preserve ownership, locality and success-versus-occurrence semantics.
- Remove redundant unowned world-event IDs from actor/component reference lists
  when those world events remain present and each component retains valid owned
  evidence. Do not transfer another actor's event or receipt.
- Explicitly document `events[].beforeEventId` in the prompt with a complete mixed
  travel/search example and an example of search information dependencies.

Keep combat chronology, resource-dependent traversal, failed unlocking and
ambiguous references under strict validation. Do not repair arbitrary unknown
fields or fabricate missing evidence. Add regressions using these observed shapes.

### 2. Preserve valid progress when an output still needs recovery

Replace the whole-turn receipt-only fallback for model content failures with a
bounded recovery of the latest candidate. First retain validated independent
components and their dependency-complete world facts. Ask for a compact repair of
only unresolved consequences, using the original intent, current scene and locked
receipts. Let the adjudicator establish modest fictional detail at this stage.

For this turn, the desired recovery is: Neris arrives; Anglerfish man arrives but
fails to find an entrance and notices a lesser lead; Vesperveil's successful
inspection produces a concrete discovery. A search success should resolve into
something useful before narration. Technical failure alone should not establish
that an ordinary action was impossible.

Revalidate the assembled result and save it before narration. Do not reroll dice,
repeat tools, double-spend charges or rewards, or revive a failed success
prerequisite. Dependent consequences cannot survive removal of their prerequisite.
Keep a bounded last-resort factual path for genuinely unrecoverable content; do
not increase the existing full-response retry loop.

### 3. Give creative interpretation a practical scope

Turn 4 already demonstrates a good interpretation: “Communicate through
telekinesis” became a deliberate pattern of physical taps, with answering knocks
from the wreck. It preserved the communication goal without adding a permanent
power. Neris's request to melt ice was interpreted as asking fish to redirect
existing warmer water; its failed check stayed failed but revealed thinner ice.

Turn 5 was less forgiving: “cast a psychic blast at the hull” was blocked because
Violet Mindspike targets a foe. Decide that supported powers may also address
plausible environmental targets when their described nature fits, using the
existing action cost, charge and server check. Preserve the submitted goal and
character theme; allow modest improvisation in execution, incidental obstacles
and NPC reactions. Mind-affecting magic need not damage timber, and adaptation
must not silently grant an unrelated permanent ability or automatic success.

Apply this liberty during adjudication/recovery, where resulting facts can enter
the journal and map. A narrator improvising an opened door after finalization would
leave the visible story inconsistent with the saved world.

### 4. Improve baseline pacing after removing correction waste

Even clean turn 5 took nearly two minutes. Its final adjudication response alone
took 76 seconds, followed by about 23 seconds for narration and review. Requests
supplied roughly 19–23 thousand input tokens in these turns. Reduce repeated
contracts and duplicated output facts, and use a small response shape for routine
travel and interaction where practical. Keep useful arrival detail and player
contributions. Input reduction alone does not establish proportional time savings.

Start with local repairs and concrete prompt examples, then recovery that preserves
progress and permits bounded creative adjudication. Raising timeouts or adding
more full-response retries does not address this session's observed cause.

## Relevant implementation

- `server/providers.ts`: `movementContract`, `ChatGPTGM.adjudicate`,
  `adjudicationExample` and `ChatGPTGM.narrate`.
- `server/world-map.ts`: `normalizeAdjudicationReferences` already provides a
  local repair boundary for unambiguous location and movement references.
- `server/exploration.ts`: `validateExploration` checks direct search evidence.
- `server/turn-resolution.ts`: `orderRoutineMovement` and `validateAdjudication`.
- `shared/turn-resolution.ts`: strict component/event schemas and event ownership.
- `server/game.ts`: `runResolvedTurn` persists the adjudication fallback marker
  and skips model narration when that marker exists.

## Implemented — 16 October 2026

The shared adjudication validator now repairs the observed movement metadata,
grounded two-link search dependencies and redundant unowned world references.
All three original rejected turn-2 responses pass a read-only replay with unchanged
story facts, rolls, outcomes, rewards and proposed positions.

Readable invalid responses use a single compact repair request within the existing
budget. The server first retains independently validated movement/main/minor
components and their supported world evidence. A patch cannot rewrite that progress.
If the patch fails, retained progress is still finalized and narrated normally;
wholly unrecoverable content keeps the last-resort receipt-only fallback. Recovery
uses no additional game tools or dice. Tests cover repaired, malformed and conflicting
patches, preservation of arrival after search failure, and checkpoint reuse after
interrupted narration. Coupled components that cannot be retained independently
remain for the bounded repair rather than being guessed locally.

Creative-resolution instructions now permit modest compatible execution and useful
failure consequences. Explicitly named/selected strike abilities can address fitting
noncombat obstacles through a saved-attribute check plus strike bonus, spending one
main action and charge without automatic advantage, enemy damage or on-hit ailments.
The UI permits that selection and explains its mechanics. Retry tests cover successful
and failed obstacle checks without duplicate dice or charges.

Verification: **733 unit tests in 25 files passed**, **9 equipment/recovery browser
checks passed**, and TypeScript plus the production build passed. Browser checks used
an isolated temporary database and an ephemeral callback port. No live model request
or saved-session correction was performed; live latency improvement remains unmeasured.
