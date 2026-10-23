# Playtest reliability: plan and execution

Scope: the akoedabar playtest's dropped destination search, unregistered people,
unsaved retrieval agreement, circular investigation leads, repetitive prose,
and avoidable correction requests. Preserve creative world development and use
the existing scene, NPC, investigation, quest and checkpoint systems.

1. **Preserve complete submissions.** Identify clearly explicit secondary acts
   in English/Dutch submissions and require their actual operation at the right
   place/order. Ordinary arrival cannot stand in for a destination search or
   conversation, even when no dice were rolled. Concrete obstacles and refusals
   remain valid outcomes; navigation idioms, passes, gathering and saved combat
   keep their existing rules. Report independent omissions together.
2. **Persist people and agreements.** Require identity-bearing operations for
   explicit NPC conversations; support stable public role labels for unnamed
   people and bind investigations to the actual person. Reuse existing NPC IDs
   across turns. Use the existing quest ledger for offered/accepted requests,
   recipients, fixed objectives and completion consequences. Permit concrete
   social consequences without inventing currency or equipment.
3. **Advance investigations honestly.** Reuse already-known answers across
   sources, hooks and simultaneous characters without additional dice/XP.
   Preserve genuine new details and failed results. Validate a named lead's
   actual location and expose known answers/previous leads to the GM so another
   approach can develop them rather than repeatedly refer the party backward.
4. **Tell each outcome once.** Keep durable findings/lead facts in state while
   rendering complete narrative prose once. Preserve mixed-party summaries and
   avoid an extra loot-ledger paragraph when the discovery already narrates it.
5. **Verify complete play, including recovery.** Replay recorded examples and
   test success/failure, arrival/source ordering, NPC reuse, request completion,
   repeated discoveries, publication interruption and restart. Run type checking,
   the complete unit suite and a production build. Test model output is mocked;
   the next live playtest remains necessary to measure model behavior/latency.

No extra model reviewer or speculative framework is needed. Natural-language
meaning remains a GM judgment; deterministic checks protect explicit supported
obligations and saved facts without pretending to prove arbitrary prose.

Execution status: complete (2026-10-23).

- Explicit action obligations now reach the scene validator with their original
  evidence and destination order. Missing actions and route declarations produce
  combined, concrete corrections. Empty reward objects mean no award, avoiding a
  pointless format retry.
- NPC interviews support new stable role identities before publication and
  share those identities across simultaneous actors. Public conversation memory
  does not invalidate an unchanged witness's evidence and allow another roll.
- Requests can promise a saved social consequence or refer to a privately
  prepared future collectible. First-meeting offers see the introduced giver
  before validation. Returning a real requested item can accept and complete an
  offered delivery; travel, carrying, missing/absent holders and closed requests
  cannot do so.
- Successful known answers reuse state across sources/hooks without additional
  dice or XP. Declared lead sources use their actual saved location. Ordinary
  travel alongside a repeated answer does not make it rewardable.
- New investigation receipts carry complete narrative prose; legacy receipts
  retain any missing lead. Facts remain in durable records. Split-party summaries
  retain every actor, and already narrated loot has no extra ledger paragraph.
- Actual Game lifecycle tests cover successful/failed interviews, simultaneous
  witnesses, repeated and new answers, shared XP and publication restart.

Validation: 1,292 tests passed (1,291 across 57 files plus the loopback tunnel
test), TypeScript and production build passed, and `git diff --check` passed.
Model responses in regression tests are mocked. New live turns remain necessary
to assess the GM's semantic choices and actual request count/latency.

The audited akoedabar reconciliation was applied: four established public NPC
roles and the mechanic's **offered** case-return request were restored. All turn,
action, roll, member and journal rows compare identically with the backup; other
scene facts and the pending collecting turn 8 are preserved. Reapplication is a
no-op. The dropped historical search was not invented or rolled retroactively.

Backup: `data/gather.sqlite.before-akoedabar-public-bookkeeping-1792714076282.sqlite`
(mode `0600`). The preview/apply tool is
`scripts/reconcile-akoedabar-playtest.ts` and refuses a changed checkpoint.

## Fresh-campaign foundations (2026-10-23)

Implemented the follow-up for campaigns with different premises:

- **Opening declarations.** Scene openings explicitly inventory introduced
  interactable NPCs, features, offered requests and mysteries. Each declared ID
  must have its corresponding saved state or private preparation before the
  opening is accepted. Missing declarations and records are reported together.
  Empty categories are valid; solitary/peaceful openings require no people,
  mission or mystery. Actual NPC/feature/request validation remains shared with
  ordinary turns. The live scene provider cannot bypass this with a legacy
  opening response.
- **Journeys and continuing goals.** Private notes can hold an accepted journey's
  actor, destination, arrival condition and finite remaining stages. The engine
  counts successful route segments (including compressed gathering), preserves
  progress across locations/restarts, and closes the journey at its destination.
  Known mapped distance supplies a minimum initial budget. Additional stages need
  a new witnessed nearby route closure, including a route-controlling feature
  becoming impassable; duplicate excuses and counter resets are rejected.
  Failed movement and unrelated detours preserve progress. Explicit abandonment
  is recorded separately from arrival. Existing world-progress threads also retain
  their own stalled counts and recent facts across places; unrelated developments
  do not reset another thread.
- **Action coverage.** Recognized compound requests have stable intent IDs and
  separate target-specific outcomes. Related parts may share one main action,
  but each needs its own result, concrete refusal or explained turn-limit deferral.
  Duplicate claims/results cannot cover different requests. These outcomes are
  saved with their evidence; an engine inventory refusal corrects both the prose
  and the saved outcome. Existing dice and action limits remain authoritative.
- **Verification.** New lifecycle coverage starts peaceful wilderness, inverted
  ocean/nonhuman, fortress and no-shared-quest campaigns from their opening,
  changes established state, restarts, and verifies subsequent use of that state.
  Journey coverage includes final publication interruption/retry, immutable
  counters, real detours, cancellation, mapped distance and compressed travel.

Boundaries: the GM still identifies which prose introduces an interactable entity
and interprets ambiguous intent. Opening declarations validate that authored
inventory rather than claiming to understand arbitrary prose. Action recognition
and explicit abandonment guards cover common English/Dutch wording. Continuing
thread counters inform pacing; they never impose objectives or override dice.
Journey delays currently require a represented route closure, not a free-text
excuse. These regression providers are mocked, so varied live model behavior and
latency remain empirical questions. This follow-up changes no live campaign save.

Final verification: 1,306 tests across 58 files plus the isolated loopback tunnel
test passed (1,307 total). TypeScript, production build and `git diff --check`
passed. No live model requests were made for these checks.
