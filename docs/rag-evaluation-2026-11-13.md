# Campaign memory and turn recovery evaluation

Implemented on 13 November 2026. The pre-change baseline passed 1,391 tests.

Memory now retrieves established public facts from completed turns using local
SQLite search and saved entity identities. Each fresh turn freezes its selected
facts before model work; recovery reuses them. The packet is capped at eight
complete facts and 8,000 serialized characters. Missing search results or an
unavailable index do not add model calls or block a turn. Existing saves catch up
in batches of at most 64 completed turns per fresh turn; diagnostics report the
remaining backlog. Private preparation stays outside the archive.

The archive preserves dependencies and original source identities, excludes
reopened turns, deduplicates current knowledge, and distributes recall across
acting characters. Current saved NPC, quest, ownership and route state retains
authority over historical prose. `GATHER_CAMPAIGN_MEMORY=0` disables retrieval for
fresh turns. Rebuilding the disposable index leaves completed turns unchanged.

Scene recovery stops on a repeated identical error or three invalid responses.
Identical tool requests reuse their output; two consecutive tool-only rounds
without a fresh result stop the loop. Recovery keeps independently valid progress
and saved mechanics, then supplies a varied local observation without another
model request. It does not invent success of an unfinished goal. Complete recent
journal facts now roll forward locally, removing a journal-overflow repair round
from the recorded departure regression.

Failed searches retain their failed goal and useful lesser information. A
separate saved 5% roll can award an incidental Common healing item on the ground.
That opportunity is shared across searchers and cannot be rerolled through
recovery. Its separate cache marker leaves the original target available for a
later approach. Damage continues to use the existing combat/environment mechanics.

Live checks used the existing ChatGPT connection with `gpt-6.1-sol`. Every scenario
ran in its own in-memory campaign; no saved campaign was rewritten. The recall
scenarios contained 25 intervening turns, with the original agreement absent from
the current journal and last 12 recaps.

| Scenario | Retrieval | Correct old agreement | Requests | Correction rounds | Elapsed |
| --- | --- | --- | --- | --- | --- |
| English orbital workshop | Off | No | 1 | 0 | 24.710 s |
| English orbital workshop | On | Yes | 1 | 0 | 8.848 s |
| Dutch harbour office | Off | No | 1 | 0 | 30.119 s |
| Dutch harbour office | On | Yes | 1 | 0 | 9.841 s |
| Failed footprint search | On | Not applicable | 3 | 1 | 37.910 s |
| Failed footprint search, repeat | On | Not applicable | 2 | 0 | 23.798 s |

Both recall cases retrieved only the relevant turn-1 fact, rather than padding
the prompt with unrelated old turns. The historical packet was 468/478 UTF-8
bytes; retrieval and incremental indexing took 4.01/3.11 ms in these runs. The
baseline invented different shelter locations. With retrieval, the GM preserved
the original locations and the repair condition without granting money or gear.

Both footprint runs kept the main outcome failed and introduced a different,
usable environmental lead. The scenario deliberately supplied a failed check
and a winning incidental-item die to exercise the item branch; it is not an
estimate of item frequency. Both left a Common healing potion available for
normal pickup. The repeat had no correction feedback. Variation between the two
runs is retained here rather than presenting only the cleaner result.

These small samples demonstrate recall and the exercised recovery behavior.
They cannot establish campaign-wide contradiction rates, multiplayer pacing or
tail latency, and the elapsed times are not a general speed claim. No embeddings,
new model reviewer, citation validator or additional model stage was introduced.

Reproduce the isolated live scenarios with:

```sh
node --import tsx scripts/evaluate-campaign-memory.ts --live --model gpt-6.1-sol --output /tmp/campaign-memory.json
```

Omit `--live` to preview without a model request. Add `--case failed-search` to
repeat only the setback case. The script also records correction feedback,
selected sources, completion/fallback status and memory diagnostics.

Regression coverage includes journal eviction, aliases in both languages,
current NPC/quest state, dependencies, legacy rows, campaign isolation, reopened
turns, split scenes, packet limits, incremental indexing/rebuilding, unavailable
search, interrupted publication/restart, duplicate tool calls, retained movement,
failed-check preservation, incidental-item boundaries and source availability.

Final verification: **1,414 tests passed across 61 files**, including the isolated
loopback tunnel check. TypeScript checking, the production build, script preview
and whitespace checks passed. Existing unrelated workspace changes were retained.
No browser UI was changed.

## Goal-completion follow-up

The subsequent approved change ties recovery to the submitted target. Inspection
prefers the named feature, persuasion retains the actual NPC's recorded objection,
and investigation uses its saved lead. Current public facts and relevant memory
remain the sources; sparse scenes can still offer only a general local opening.

A clear successful check can now finish an existing simple unlock, opening or
repair through the existing validator. Known ordinary travel and a single clearly
requested nearby pickup can also finish locally. Failure, negation, ambiguous
targets, unestablished prerequisites, transport-only/blocked routes and carrying
limits remain authoritative. Failed travel receives an explicit failed movement
event from its saved roll, rather than entering another correction loop. Recovery
does not add requests, rerolls, loot chances, costs or a general intent parser.

New private `turn_playability` events record structural goal status, useful
consequences, recovery use and repeated inputs from the same actor's previous
completed turn. Diagnostics store input fingerprints instead of duplicating
submission text. They do not infer paraphrased retries or prove narrative quality;
an ordinary accepted outcome is assessed from its declared status. The isolated
live script now includes this payload for subsequent comparison.

Regression tests force repeated malformed model responses and verify target-related
clues, English/Dutch successful unlocks, repairs, known travel, failed traversal,
explicit pickups, inventory refusal and consent/ambiguity boundaries. A file-backed
publication interruption and restart verifies that the successful unlock, saved
die and goal diagnostic commit once without another interpretation request.

Two additional isolated failed-search smoke tests used `gpt-6.1-sol`:

| Run | Requests | Correction rounds | Elapsed | Outcome |
| --- | --- | --- | --- | --- |
| First follow-up | 2 | 0 | 25.000 s | Failed goal; sheltered readable tracks; incidental potion |
| Final diagnostic check | 3 | 1 | 50.672 s | Failed goal; sheltered readable tracks; incidental potion |

The second run corrected a lead source that did not reference a saved entity.
The first run exposed a diagnostic undercount of useful findings on ordinary
accepted failed searches. That metric was fixed and covered by a regression
test; the final run records `kind:search`, `goalState:failed`, one unfinished goal
and `usefulConsequence:true`. Both runs deliberately use the existing winning
incidental-item die; neither measures natural item frequency. These live turns
did not require content fallback. Forced-invalid integration tests exercise that
path separately, including clear successful-goal completion and restart.

Final follow-up verification: **1,459 tests passed across 64 files**, TypeScript
and production build passed, evaluation preview and whitespace checks passed.
No new dependencies, additional model stage or browser UI changes were required.
