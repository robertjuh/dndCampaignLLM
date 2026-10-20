# Spacepirates playtest analysis — 18 October 2026

The largest avoidable delay is repeated model generation after small validation
failures. Across the three played turns, correction calls consumed **235.8 seconds
of 570.1 seconds: 41.4%**. Large structured responses explain much of the remaining
wait. Improving local persistence and response contracts should come before
changing models or removing narration checks.

This is an analysis of saved evidence; no game code, campaign state or model
settings were changed, and no live model requests were made.

## Scope and measurements

Latest campaign: **spacepirates**, `930ecbcd-ea90-4968-8ab8-1fce9838107a`.
Three characters; Dutch output; model recorded as `gpt-6-sol`; gameplay build
`a43536ccddbde3de`. Opening generation began at **01:00:14**, and turn 3 finished
at **01:21:54**, on 18 October in Europe/Amsterdam. Log timestamps are UTC on
17 October. Turn 4 is collecting submissions, with no processing failure.

Sources: read-only queries of `data/gather.sqlite`, stage diagnostics in its
`events` table, `data/logs/chatgpt.jsonl`, and the retained full request/response
files under `data/logs/chatgpt-calls/`. Current source code was inspected to explain
the recorded behavior. This is a small sample: an opening and three played turns.

Times below sum recorded processing stages. They exclude player thinking and
submission time, and do not measure browser rendering or network delivery to
players.

| Turn | What happened | Adjudication | Narration + review | Other stages | Total | Model calls |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Opening | Establish Salsaria and faction connections | 67.3 s | 13.7 s | 44.5 s | **2:05** | 7 |
| 1 | Read freight notice, inspect containers, attempted departure | 109.3 s | 19.3 s | <0.02 s | **2:09** | 5 |
| 2 | Open crate, arrange containers, look for food/ship | 112.0 s | 15.1 s | <0.02 s | **2:07** | 4 |
| 3 | Split between dock/market, investigate ship, handle ampoules | 268.2 s | 46.2 s | <0.02 s | **5:14** | 7 |

Played-turn mean: **3:10**; median: **2:09**. Adjudication accounts for **85.9%**
of played-turn processing time. The opening additionally needed 44.5 seconds for
faction generation/connections, which was not repeated on subsequent turns.

All 23 model calls returned HTTP 200. There were no recorded stage failures,
timeouts, automatic retries or fallbacks in this campaign. Model-request durations
sum to 695.201 seconds versus 695.584 seconds across all recorded stages: **99.94%**
of measured processing time was inside the model requests. Finalization and
publication together took only 43 milliseconds across all four completed turns.
These measurements do not point to SQLite or local rules execution as the cause.

## Why turns were slow

### 1. Journal wording triggered unnecessary generation

The validator in `server/world-progression.ts:126` requires the normalized event
fact to occur as a contiguous substring of the referenced journal detail. It
normalizes case, punctuation and spacing, but does not accept paraphrases.

This failed in the opening, turn 1 and turn 3. In turn 1, both texts described a
double-sealed crate and an old serial number matching Rustbeard's smuggling mark,
but used different sentences. The correction was about the persistence contract,
not malformed JSON or an established contradiction in that pair of descriptions.

Additional repair requests took **22.5, 46.5 and 53.6 seconds**, respectively:
**122.6 seconds** in total. The prompt already tells the model to preserve exact
wording in `server/providers.ts:1235`, so another reminder alone is unlikely to be
a dependable fix.

Recommendation: after validating a progress event's public grounding, location,
dependencies and thread, let the server persist its canonical fact into the cited
journal entry. Preserve previous facts and retain length/contradiction checks.
Do not replace grounding validation with a fuzzy text match. A simple append of
the event sentence to the existing journal text would fit within 1,500 characters
for every recorded offending pair here; that demonstrates size feasibility,
not that an unimplemented change has passed the complete validator.

### 2. Optional event metadata caused full-turn rewrites

Turn 2 and turn 3 returned `effect:"interact"`. The event schema in
`shared/turn-resolution.ts:84` permits only `movement` or `search`; ordinary
interaction events can omit `effect`. Combat instructions elsewhere use
`main:"interact"`, which is a different field and may contribute to confusion.
That possible source of confusion is an inference, not a recorded model rationale.

The correction calls took **46.3 and 89.4 seconds**, respectively. In turn 3,
comparison of the two complete parsed responses shows exactly one change:
removing `effect:"interact"` from one event. Every other top-level value was
unchanged. The app spent 89 seconds regenerating the same turn to remove an
optional label.

The opening also omitted one world's event `receiptRefs` array, causing a
20.2-second correction.

Recommendation: make the allowed event fields explicit in examples and extend
the existing local normalization path for proven harmless cases. Omit a redundant
`interact` label only when it asserts no movement/search effect and the remaining
event passes semantic validation. Default a missing empty receipt list only where
the event genuinely needs no receipt. Preserve strict validation of actual
mechanical evidence, movement and outcomes. Replay the saved offending responses
through any proposed fix, including cases that must still be rejected.

### 3. Turn 3 generated a large result multiple times

The slowest turn had a real increase in work: three actors, two new destinations,
separate arrivals, map links, a search check, physical loot and party separation.
Its accepted resolution contains 13 events. However, the extra work was multiplied
by corrections:

| Step | Duration |
| --- | ---: |
| Request a search check | 11.8 s |
| Request ampoule loot | 6.9 s |
| Generate the structured turn, rejected for `interact` | 106.3 s |
| Regenerate it with that label removed, then fail journal validation | 89.4 s |
| Repair unresolved consequences | 53.6 s |
| Write narration | 29.6 s |
| Review narration | 16.6 s |

The two full structured outputs were approximately **14.5 KB each**; the repair
added another **7.9 KB**. The first two full outputs used 5,799 and 4,750 output
tokens, respectively. The 89-second correction contained only 57 reasoning tokens:
most of its output was the repeated JSON. Reducing reasoning alone would not
remove that delay.

Recommendation: shorten adjudication facts/reasons and reduce repeated text in
event facts, component summaries, action aggregates and journal entries. Keep
immersive detail in narration. Reuse existing aggregation helpers where the
server can derive summaries from components rather than asking the model to
repeat them. Preserve separately meaningful outcomes and evidence. The current
prompt already requests compact JSON; reducing the required output shape is more
reliable than adding another brevity instruction.

### 4. Every request carries substantial context

The adjudication instructions were **39,523 characters**, before user context and
tool definitions. Played-turn adjudication calls carried approximately
**20,800–30,100 input tokens**. Turn 3's largest request was **140 KB**.

Examples of duplicated input: journal text and recent history are sent directly,
then repeated inside `worldProgression.threads`; member data is about 15.7 KB;
the turn 3 progression context is about 9.2 KB. Broad ailment, equipment and combat
instructions also travel through this noncombat adjudication path. Some calls
reported cached input tokens, but the three long turn-3 result/repair requests
reported zero cached input tokens. The logs do not isolate the latency attributable
to input size, so a precise saving cannot be claimed.

Recommendation: send thread IDs plus references to already supplied journal and
history facts, and use task-appropriate instruction sections while keeping rules
needed for the current actors and available tools. Preserve lore and authoritative
state. Optimize repeated data before removing useful campaign memory.

### 5. Tool round trips and narration add a baseline

The pipeline serializes adjudication, local finalization, narration and fidelity
review. Even a turn without tools or corrections normally needs three model
requests. Turn 3 used separate model round trips for Ragman's check and Rustbeard's
loot. The supplied instructions already request batching independent tool calls;
these two acts appear independent, so enforcing that behavior is a smaller
secondary opportunity, rather than another prompt addition.

Narration plus review cost **15–46 seconds** on played turns. All four narration
reviews approved on their first pass. That does not prove the review can safely be
removed: the immediately preceding Verdant Engine opening needed a narration
correction for an invented faction responsibility.

Median authentication time was **3 ms**; median time to first response byte was
**1.48 seconds**. One authentication refresh took 3.71 seconds. A fast first byte
is not first story text: it can be stream metadata. These measurements point
primarily to model generation, with upstream/network time included, rather than
repeated sign-in problems.

Recommendation: keep fidelity review initially and tackle the much larger
adjudication costs. Expose elapsed time and understandable stages such as
“Resolving actions”, “Writing the story” and “Checking the story”. The current UI
at `src/main.tsx:2565` displays a generic spinner. Publish finalized dice/outcomes
early only if clearly distinguished from the pending story; do not present
unreviewed draft prose as accepted history. This improves perceived responsiveness
without claiming to reduce completion time.

## Gameplay observations

The session preserved several important boundaries: a declared departure did not
invent an owned spaceship, the container investigation produced a character-linked
lead, and the split party reached separate saved places. There was no combat or
fallback, yet routine play still had long waits.

Two issues deserve attention alongside speed:

- **The starting scene did not support the party's immediate fantasy.** The first
  two played turns repeatedly asked to fly, load a ship or obtain one, while the
  scene had no ship available. The eventual dock scene supplied a concrete target,
  De Scheve Lepel. Seed an actionable connection to smuggling and space travel at
  the opening without automatically granting ownership or choosing an action for
  the players. A two-minute wait ending in another prerequisite feels especially
  slow.
- **Explicit taking became leaving behind.** Rustbeard submitted “Ik neem een paar
  ampullen uit het krat” and then set the crate apart. The saved resolution instead
  left the ampoules loose in the loading niche, and Rustbeard moved to the dock.
  The loot receipt confirms that an item was created at the original location;
  it was not placed in inventory. The adjudication prompt forbids automatic item
  pickup, and `offerLoot` creates available loot rather than collecting it. This
  exposes a mismatch between explicit free-text taking and the pickup-control
  flow. Either implement explicit pickup through a validated server operation or
  make the required collection step clear before travel leaves the item behind.
  Do not solve this by merely claiming inventory ownership in narration.

## Suggested order and realistic impact

1. **Fix deterministic journal persistence and redundant event metadata.** These
   have direct evidence and require no new model stage. Keep grounding checks.
2. **Reduce duplicated structured output and repeated context.** This addresses
   the still-slow initial generation, especially split arrivals.
3. **Batch independent tools and show elapsed time/stages.** Smaller latency
   savings plus clearer feedback while a turn runs.
4. **Resolve the explicit-pickup mismatch and improve opening opportunities.**
   Reduce stalled play and avoid extra turns spent repairing player expectations.
5. **Only then benchmark stage-specific model/settings changes or review policy.**
   Compare accepted outcomes and total time including corrections; a faster
   individual response can lose its advantage if it triggers more repairs. This
   analysis does not establish another model's current capability or latency.

Removing only the observed extra correction calls, while holding all other call
durations fixed, gives the following counterfactual:

| Played turn | Recorded | Without observed correction calls |
| --- | ---: | ---: |
| 1 | 2:09 | 1:22 |
| 2 | 2:07 | 1:21 |
| 3 | 5:14 | 2:51 |

That would move the played-turn average from **3:10 to 1:51**, a **41%** reduction.
This is an opportunity estimate, not a measured implementation result; accepted
first responses and other request timings may change after a fix. It also shows
why retry cleanup alone will not deliver consistently sub-minute turns.

Validation for this analysis: checked all four completed turns against stage
events and full model logs, compared the two turn-3 structured responses, inspected
the rejected event/journal pairs and their length limits, and checked the saved
ampoule receipt and final action. Application tests were not rerun because no
application behavior changed.

## Follow-up: turn 14 blocks during encounter continuation

Later play reached turn 14, `7132012e-9765-46f1-a867-3a6eb79fb86d`.
At inspection it is failed in adjudication, with three recorded attempts,
11 successful upstream model responses and **348.2 seconds of model-request
time**. Its first request began at 02:00:09 and its last failure was at 02:07:00
on 18 October, Europe/Amsterdam. The elapsed interval includes time between
attempts. There is no accepted adjudication, finalized resolution or narration
for this turn.

Rustbeard submitted “Ik ga achter de kapitein aan”; Ragman submitted that he walks
aboard with bravado and will punch anyone blocking him. The model interpreted both
as successful boarding without a punch because nobody blocked the route. It
established a new deck location and the captain withdrawing toward the bridge.
The first proposal hit the already known exact-journal-wording requirement.
Its repair established a valid exploration proposal; the dangerous-place d6 then
rolled **1**, requiring an encounter. The server saved that proposal and generated
the captain encounter once, including enemies, equipment and initiative.

The new blocker is what happens next. Encounter continuation requires the saved
exploration proposal to remain exact. The provider nevertheless requests another
full-turn response. The first such response preserved the action objects and
event prefix, but changed the reason for an unchanged zero reward, among other
fields. `assertEncounterProposal` rejected it with:

> Saved encounter exploration preserves rewards; append only its local encounter introduction.

Subsequent attempts also rephrased frozen action facts/reasons, producing the same
error for `actions`. The encounter introduction itself still needed normalization:
one response used `phase:null` instead of the required `aftermath`. Generic
recovery sent a retained value with **zero locked components and no saved deck
declaration**, so an introduction-only patch could not resolve
`new:scheve-lepel-dek`. Other repair responses repeated the journal failure.

The current saved error is:

> adjudication: Saved encounter exploration preserves actions; append only its local encounter introduction. Retry resumes from the last saved checkpoint.

This is an additional checkpoint-continuation defect, not a failure to understand
the players' actions. The original plan's journal fixes and partial recovery help,
but it needs a specific encounter resume path. Step 2a of the implementation plan
now requires rebuilding from the exact saved proposal, retaining its new-place
declarations, and appending a server-assembled introduction from the saved combat
receipt. A continuation must not regenerate frozen actions or ask the model to
copy unchanged rewards exactly.

The captain encounter remains saved at round 1; no attack from that new encounter
has executed. Boarding has not been published: the persistent scene still shows
the characters on the dock until the turn can finalize. Repeated retry currently
re-enters the same defective continuation, so retry alone is not a dependable
remedy. The saved proposal and combat receipts provide the ingredients for a
normal checkpoint resume after the code fix; they should not be rerolled or
replaced. This inspection and documentation update did not change campaign state
or make model requests.

## Follow-up: turn 16 blocks after a completed combat round

Turn 14 subsequently completed on the new build, and turn 15 completed in 32.9
seconds. Turn 16 (`7d3d816d-4cb5-4b71-af0a-4f2b337349c6`) then failed twice on
build `76cd744d8033fbb0`: six model requests and 99.7 seconds of adjudication.
Ragman attacked the captain. The engine saved a missed attack with self-damage,
the captain's death from existing Burning, victory, recovery, XP and dropped loot.
Those mechanical results were already durable; the turn stalled before publication.

Three incidental requirements formed a correction chain: a public world event
omitted nullable `memberId`, the first aftermath omitted its place refresh, and
the response copied `sceneFocus: "current"` from the example even though the only
active character was on the deck while the screen still focused on the dock.
The corrected refresh changed the hazard description without `encounterRisks`.
Recovery validated retained projections with the action/world validator, which
did not include the encounter planner's validation. It therefore retained a
projection that still failed when actually accepted. That exception escaped the
recovery path and repeated on retry.

The generic fix derives omitted public-world ownership and an empty default screen
focus locally, supplies an occupied focus in examples, and validates encounter
plans as part of ordinary adjudication validation without drawing or saving dice.
Partial recovery consequently retains only outcomes that can actually be accepted;
invalid optional consequences can fall back to the completed engine round. Victory
feedback also asks for the hazard assessment alongside the refresh. No new model
stage, relaxed movement rule, automatic safety declaration or database migration
was added.

An isolated SQLite snapshot replayed the two recorded retry responses followed
by an empty repair response. It completed turn 16 and opened the next turn using
three simulated requests, zero new rolls and identical combat receipts. Assertions
verified unchanged earned XP, one copy of the dropped weapon, the same character
position, and focus on the occupied deck. Regression tests cover both a fully
grounded aftermath accepted in one request without corrections and the missing
assessment reaching a valid mechanical fallback. The live campaign was not changed.
The full suite passed **831 tests in 36 files**, and the production build passed.

## Follow-up: turn 22 exposes the blocking pacing policy

Turn 22 (`37e8535b-72d4-4234-836b-3748dda7e09d`) failed on build
`58c3091ee4733735` after four requests and 122.9 seconds. Ragman's submission was
“We varen naar ijzerkeel”. The saved DEX check rolled 18, total 20, and succeeded.
The generated outcome departed Salsaria toward IJzerkeel without claiming arrival
or choosing another player's action.

The first structured response omitted an action event's receiptRefs, although its
owning checked component supplied the saved roll reference. Later responses fixed
that but were rejected for closing the existing dock/deck gangway. Neither endpoint
had an active character: Ragman operated the ship from its wheelhouse, and Rustbeard
on deck was inactive. The map validator applied its local-discovery restriction to
a known route changed by an action elsewhere. The final response dropped its new
exit preview but retained the gangway closure, so the rejection repeated.

Recovery then failed to construct its base. It kept the successful check without
sailing consequences; the wheelhouse already had one unadvanced turn. The hard
second-turn pacing gate rejected this base and the terminal fallback. Thus the
screenshot's “World progression is due” was a secondary failure, hiding the earlier
map rejection. The previous fixes did not separate pacing from publication legality.

The system now gives due pacing one bounded repair. If development remains
unresolved, legal actions publish, ordinary narration remains enabled, and pacing
debt stays due on later turns. No discovery, action outcome or XP is invented to
clear the counter. Grounding, failed-check dependencies, first-arrival evidence,
movement, inventory and encounter receipts remain validated.

Known routes may change through a public endpoint world event causally dependent
on a local submitted action; new remote discoveries remain forbidden. Missing
fictional action receiptRefs derive from the owning component and are validated
normally. Hazard prose edits retain their saved danger classification until a
grounded encounterRisks entry changes it. Unknown explored places still require
an assessment; text edits no longer force a mechanical reassessment.

The ship journal was nearly full (1,389 characters). Its existing bounded
consolidation repair is now reachable. A focused public-state fixture retains the
recorded departure, saved check and map. Tests cover consolidated and malformed
repairs, empty/corrected pacing repairs, causal route updates, forbidden remote
discoveries, and retained danger state.

An isolated full-pipeline SQLite replay used the recorded departure response plus
one supplied compact consolidation patch. It completed turn 22 and opened the
next, closed the gangway, published departure, awarded 20 XP once, retained the
passenger's deck position and cleared pacing through validated progress. There
were zero new rolls and the saved roll row was identical. The live campaign was
not changed, and the replay made no network model requests.

Final verification passed: **838 tests in 37 files**, TypeScript checking through
the production build, and the isolated full-pipeline departure replay.
