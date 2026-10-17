# Lava planet improvements: implementation and verification

Implemented 7 October 2026, following the [approved plan](PLAYTEST_IMPROVEMENT_PLAN_2026-10-07.md) and [session audit](PLAYTEST_ANALYSIS_2026-10-07.md). All eight workstreams are implemented. Existing completed turns remain historical evidence.

## Behavior delivered

| Workstream | Result |
| --- | --- |
| GM orientation | “Wat moet ik doen?” receives useful observable surroundings and vague hints grounded in known facts. It reveals no secrets or solution, recommends no command, moves nobody and spends no roll, charge or reward. It uses the ordinary group-turn flow. Explicit NPC dialogue and mixed physical acts remain distinct. During combat the round and enemy actions still proceed. |
| Meaningful travel | Routine travel reaches the next meaningful arrival or choice. Adjudication can establish visible features, known tool uses and developments before narration freezes them. It acknowledges actual progress without adding an endless series of equivalent passages. |
| Separate places | A turn can register several destinations, move each character independently and place discovered loot at the discovering actor's destination. Saved reference mappings keep UUIDs stable across retries and restarts. Each occupied place has its own description and hazards. Opening placement requires no nonexistent submission. |
| Movement before a failed stunt | An optional routine movement component records completed preparation before the checked main act. The original failed check, receipt and consequence remain failed; the actor can nevertheless be at the reached destination. A failed traversal check or unrelated successful action cannot authorize movement. |
| Current item facts | Linked journal entries retain discovery/purpose prose and project the current holder or ground place from the exact item ID. UI, GM context and frozen narration use this projection. Disabled pickup controls explain the applicable player lock beside the button. |
| Concise summaries | Narration and review receive the previous situation and occupied-place state, allowing unchanged warnings to be omitted. Relevant changes and directly requested safety information remain explicit. Cosmetic repetition alone does not trigger a correction request. |
| Relevant world response | Existing character concerns, contacts, factions and campaign premises can cause observable developments. Lava man's established pursuit supports mounting pressure after lingering or drawing attention. A quiet campaign does not acquire a pursuit. Reputation still requires attribution and a consequential deed; secret or repeated deeds do not automatically earn it. |
| Waiting and audit evidence | No new model stage, model change or retry-budget increase. Ordinary no-tool turns retain three requests. Narration/review omit the duplicate factual recap while durable history retains it. Stage diagnostics record a source build identifier; submissions record their timestamp. |

The implementation reuses SQLite, the existing place helpers and adjudication → finalization → narration → review pipeline. It introduces no dependency, background pursuit simulator, command menu or separate help endpoint.

## Verification

- TypeScript check and production build passed.
- Full regression suite: **607 tests in 22 files passed**.
- Affected browser checks: **10 passed**, covering language, local loot/travel, pickup lock wording and linked journal status. These ran against an isolated server/database.
- Saved-game correction test passed after the final script change. It checks dry-run/apply/idempotence, state preservation and refusal once a player has submitted.
- Location/turn tests exercise two new arrivals, off-focus discovery, different safety decisions, restart-stable IDs, local pickup, take/drop/take, opening placement, movement provenance, a failed stunt with one saved roll, and combat orientation without ability activation.

Real connected-provider validation used fresh isolated campaigns and the selected `gpt-5.6-sol`, with deterministic dice. The active campaign was not used as a model mutation fixture. The final run recorded build `f6f5691d33cb6ad6`; the later availability-priority wording and orientation combat-metadata guard were checked locally.

| Final live scenario | Requests | Seconds | Observed result |
| --- | ---: | ---: | --- |
| GM orientation with a carried tool | 3 | 52.0 | Useful surroundings and known tool connection; no roll, XP, movement or selected ability charge. Distant search signals fit the supplied pursuit premise. |
| Two independently new arrivals | 4 | 94.3 | Two actual place IDs, separate occupied-place state and discovery at the destination outside shared focus. |
| Travel followed by a failed stunt | 4 | 50.3 | Movement precedes the failed main event; one failed check is retained and the actor stays at the arrival. |
| Combat victory | 4 | 47.8 | Victory and aftermath publish using the current-place refresh contract. |
| Explicit NPC dialogue | 3 | 49.6 | Present mechanic answers in character and exposes an optional task. Quiet premise introduces no pursuit. |
| Physical act plus surroundings question | 4 | 73.3 | Failed drawer check stays failed while observable context is explained. |
| Opening placement | 3 | 56.9 | Two starting places without submitted actions, rolls or rewards. |
| Newly public faction | 3 | 28.9 | Readable badge and dialogue reveal public identity/work, with no private agenda in the published story. |

All eight final scenarios completed using **28 model requests, zero validation corrections and zero fallbacks**. The fourth request where present was a required mechanics/planning continuation. Median turn time was **51.2 seconds**; the slowest was **94.3 seconds**. Opening time is the sum of its measured stages. These are small scenario samples, not a controlled latency benchmark or a guaranteed response time.

An earlier retained validation run also exercised ordinary travel with pursuit signs and faction attribution: an attributable deed awarded the responsible character +1 once, repeating it awarded 0, and an unseen secret deed awarded 0. Live probes exposed and resolved three contract problems before the final run: arrival field names needed an explicit example, unowned loot availability events needed distinct action/narration coverage, and victory validation still required the legacy location field despite accepting the new place-update contract. Cosmetic warning repetition also caused avoidable review requests until the review rule was made explicit.

The duplicate recap removal was measured on serialized narration/review payloads before adoption; structured event facts remain available and the three-request baseline is tested. Byte reduction does not establish a corresponding latency reduction.

## Existing playtest save

The proven wrench journal entry was corrected at fresh collecting turn 16 with no saved draft or submissions, after dry-run and application to a SQLite backup. The obsolete “nog niet meegenomen” sentence became timeless discovery/purpose prose, linked to item `dfbf8f40-f9a0-4eb8-b22f-d2c0d89a96c5`. Its current status now follows inventory/ground state.

The live correction wrote one `playtest_state_correction` event. Members, positions, inventories, completed turns, rolls, actions and scene state were preserved. The current party is reunited; historical room descriptions do not justify reconstructing earlier positions. The map's existing journal entry already records its successful route use and was left intact.

The protected pre-correction backup is `data/gather.sqlite.before-lava-correction-2026-10-07` (ignored by Git). The narrowly scoped [correction script](scripts/reconcile-lava-playtest.ts) defaults to dry-run, verifies the audited text and exact ownership, requires a fresh turn, backs up before CLI application and is idempotent.

## Practical limits

Prompts and validators can support coherent progress and natural world reactions, but do not guarantee every future scene will be satisfying. Longer natural play remains the evidence for sustained pacing. Model latency is still material. Old unlinked journal prose is not automatically rewritten, and completed stories are not retroactively regenerated. No ambiguous historical location or private fact was guessed to repair the save.
