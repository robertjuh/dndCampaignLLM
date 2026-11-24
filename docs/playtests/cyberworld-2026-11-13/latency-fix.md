**Turn latency and correction fixes — 13 November 2026**

Implemented all five proposed improvements: repair false validation failures, align tool contracts, preserve independent progress, use small repairs with grouped feedback, and reduce repeated request context and prose.

The final live verification completed all five original turn scenarios with **zero corrections, zero fallbacks and zero retries**. Average processing time was **44.8 seconds**, compared with **132.4 seconds** in the original playtest. All **1,537 tests across 68 files** passed, and TypeScript checking and the production build passed.

| Measure | Original playtest | Final verification |
| --- | ---: | ---: |
| Processing time, five turns | 662.001 s | 224.126 s |
| Mean processing time | 132.400 s | 44.825 s |
| Model requests | 19 | 10 |
| Correction events | 11 | 0 |
| Turns published through fallback | 2 | 0 |
| Manual retries | 1 | 0 |
| Reported input tokens | 595,000 | 251,442 |
| Reported output tokens | 26,078 | 7,830 |

This sample measured a 66.1% reduction in processing time, 47.4% fewer model requests and 57.7% fewer input tokens. These are observed results from five cases, not a guarantee for all campaigns or upstream conditions.

| Turn | Original processing | Final processing | Original requests / corrections | Final requests / corrections |
| --- | ---: | ---: | ---: | ---: |
| 1 | 164.554 s | 48.680 s | 5 / 4 | 2 / 0 |
| 2 | 116.317 s | 37.796 s | 2 / 2 | 1 / 0 |
| 3 | 115.271 s | 43.845 s | 4 / 2 | 2 / 0 |
| 4 | 155.329 s | 42.670 s | 4 / 2 | 2 / 0 |
| 5 | 110.530 s | 51.135 s | 4 / 1 | 3 / 0 |

**What changed**

- NPC participants are deduplicated after identity resolution. A public typed NPC declaration supplies its canonical identity label locally. Existing local people explicitly addressed by an unambiguous name can be bound from the exchange without another metadata request; ambiguous names still need a valid identity. A feature investigation can retain an explicitly addressed real custodian as a participant.
- Failed feature interactions store their observed attempt separately from properties. Failed repairs do not change repaired/unlocked state, open routes, create a new feature or complete a state objective. Successful interactions can save witnessed exits directly. A genuine blocked onward exit with an explicit obstacle satisfies arrival geography without inventing an open bypass.
- Investigation tool types and bounds derive from the validation schema, including 500-character discoveries and lead facts. New preparation requires its complete shape. Partial preparation is offered only for existing note IDs. Actor aliases remain valid before server expansion.
- Scene repair accepts indexed patches, additions and removals. Omitted narration and fields remain intact, and the merged result passes the normal full validator. Repair requests omit unchanged prose. Independent operation errors are gathered together; error indexes identify the original model beats even when the compiler inserts saved investigations.
- Outcome metadata binds to the actual owning event. Saved investigations do not require another verbatim answer for every overlapping sub-intent. Resolved metadata can use the canonical event fact instead of failing on a paraphrase; refused/deferred parts still need concrete reasons. Typed feature declarations establish their public identity labels locally. These changes remove redundant text-copy correction loops while retaining actor, source, location, check and effect validation.
- Recovery recognizes directed requests such as “walk east to …” and preserves affirmative travel despite unrelated negative clauses. First-arrival recovery can retain the supplied arrival, visible routes and danger assessment from a rejected response. It does not invent a destination or safety classification. Independent valid movement survives another actor's invalid feature update. An empty default shared focus moves to an occupied location.
- The scene prompt is shorter. Source descriptions and exact public facts already present in owned items, scene records or the journal are not repeated, and pacing state is not sent twice. Pending mechanics use tool calls before final prose. The model and the existing request/tool ceilings are unchanged; no new inference stage, dependency or service was added.

**How verification ran**

The benchmark restored each original turn's starting scene, members, journal, private preparation and faction state in its own disposable database copy. It submitted the same three actions through the real `Game` pipeline and `gpt-6.1-sol`, with fresh live responses and normal OS-random dice. It did not reuse the original turn's checks or selected outcomes. Each final case completed in one attempt with exactly three submissions.

These are five independent starting-state cases, rather than one new continuous five-turn adventure. Different dice and GM choices can change outcomes and workload. Opening/character generation and time spent choosing actions are excluded. The original campaign database remained read-only.

Offline replay also accepted the originally rejected travel response from turn 2 and failed-repair responses from turns 4 and 5 using their saved receipts. Additional replays verified that later rejected permission, NPC identity and authorized-exit responses are accepted without rewriting their results. Unit/integration coverage checks unchanged failure state, route restrictions, independent arrival retention and danger, metadata identity, compact patches, preparation bounds and ambiguous-name rejection.

Two earlier live verification passes exposed additional redundant-outcome and NPC metadata mismatches. They recorded 13 and 7 corrections respectively; those issues were addressed before the final pass. Their logs remain preserved with the final results, rather than being overwritten.

Preview the benchmark without inference:

```sh
node --import tsx scripts/benchmark-turn-latency.ts --source data/playtests/cyberworld-2026-11-13/gather.sqlite
```

Add `--live --output <new-directory>` for live inference in disposable copies. Existing output directories are rejected; an incomplete case sets a failing exit status. Raw final snapshots, SQLite copies and model logs are in `data/playtests/cyberworld-latency-verified-2026-11-13/`. Earlier verification passes are in the corresponding `cyberworld-latency-fixed-2026-11-13/` and `cyberworld-latency-final-2026-11-13/` directories.

See [latency-comparison.json](latency-comparison.json) for all three verification passes and [report.md](report.md) for the original playtest. Existing unrelated workspace changes were preserved.
