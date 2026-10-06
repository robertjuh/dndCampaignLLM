# Seaworld playtest analysis — 5 October 2026

The new resolution pipeline preserved mechanical outcomes in this session, but the player experience suffers from repeated narration, weak recognition of cooperation, and slow resolution. The most useful next change is to tell each action once while retaining its authoritative receipts.

## Evidence and scope

Read-only audit of `data/gather.sqlite`, campaign `863e7386-780c-4d9c-aca1-d1c35ccad391` (Seaworld), using `gpt-5.6-sol` with Dutch output. Reviewed the opening and completed player turns 1–4, published approximately 21:30–21:56 Europe/Amsterdam. Turn 5 was collecting at the final database check. This is a snapshot of an ongoing playtest.

Compared submissions, all 12 noncombat check receipts, accepted v2 adjudications, finalized resolutions, published narration, character state, journal updates, and stage telemetry. Reviewed the relevant implementation to distinguish product behavior from likely causes. No gameplay writes, retries, provider requests, or code changes were made. Tests were not run: this audit concerns observed live behavior.

## Turn overview

Processing time sums recorded stage durations, excluding player thinking/submission time. Requests count model calls, including narration review and correction; they do not measure tokens or monetary cost.

| Turn | Observed outcome | XP per player | Processing | Model requests |
| --- | --- | ---: | ---: | ---: |
| 0 | Establish Kraakwater, approaching warship, and underwater glow | 0 | 1m 42s | 6 |
| 1 | Identify warship and its gun preparations; alarm fails to organize residents | 15 | 2m 59s | 5 |
| 2 | Find cannon and ammunition; looting and scent search fail | 10 | 2m 46s | 5 |
| 3 | Clear cannon area; stabilization and loading/aiming fail | 0 | 1m 49s | 4 |
| 4 | Panther stabilizes cannon; mechanical locking and loading fail | 0 | 3m 14s | 7 |

Four player rounds averaged **2m 42s** processing. Including the opening, the session used **27 model requests** and **12m 30s** recorded processing. Five of twelve checks succeeded; all used DC 10. This small sample does not establish a balance or randomness problem.

## Findings, in priority order

### 1. Repeated narration is built into the new contract — confirmed

Every player round first narrates three check outcomes, then tells the same three actions again as fictional consequences. World paragraphs and the closing repeat the resulting situation further. Turn 1 spends 406 words on three submissions; subsequent turns use 306–317 words with the same structure.

For example, turn 3 first says Roberto's INT check fails and loading cannot be completed, then describes him abandoning the loading again, then repeats the unloaded cannon state in both the world paragraph and closing. Turn 4 follows the same pattern for all three players.

This is structural: [engineEvents](server/turn-resolution.ts#L94) creates a check event, adjudication adds its fictional outcome, the [narrator prompt](server/providers.ts#L1006) requires a separate nonempty paragraph for every event and forbids combining IDs, and [assembly](shared/turn-resolution.ts#L295) concatenates all paragraphs. The fidelity reviewer checks factual accuracy but does not explicitly reject this repetition in the new path.

Recommended change: keep individual receipts and event IDs for validation, but let narration cover a causally connected group of events in one passage. Render the check receipt separately and narrate the attempt plus its concrete consequence once. A prompt-only request to be concise cannot fully fix a contract that mandates separate paragraphs.

### 2. Cooperation is acknowledged in prose but has no effect on the loading roll — confirmed observation; design gap

In turn 4, Black panterino explicitly uses his body as ballast and succeeds at STR **23 versus DC 10**. Davyjaws loads the cannon, rolling STR **9 versus DC 10**, with `mode: normal`. Roberto's separate technical stabilization fails at INT **7 versus DC 10**.

The accepted loading outcome says it fails despite the panther's ballast. The journal correctly preserves the panther's temporary stabilization, but the loading check receives neither advantage nor a reduced DC. All three checks use the same difficulty as the previous attempt. Recorded engine event order is Roberto, Davyjaws, then the panther: the loader's roll is locked before the helper's successful result is known. Their action events link to their own checks, with no explicit support prerequisite on loading.

The success does matter to the fiction, and the two failures can legitimately leave the cannon unusable. The concern is that a coordinated approach earns no recorded benefit to the dependent attempt. The check API already supports `mode: advantage`; see [roll execution](server/game.ts#L937). Resolve relevant assistance first and choose the dependent roll's mode/difficulty from its established result. Do not change this session's locked dice after the fact or grant arbitrary numerical bonuses.

### 3. Latency is significant, predominantly in adjudication — confirmed

Player turns spend about **77%** of their recorded processing in adjudication. Narration takes another 31–56 seconds. Local finalization and publication each take only a few milliseconds. Database optimization is unlikely to address the observed delay.

Turns 1, 2 and 4 take 136–144 seconds in adjudication, close to its [180-second timeout](server/providers.ts#L909). The opening and turn 4 each use four narration requests; given the [narration loop](server/providers.ts#L1008), this means a second generation/review cycle. Saved telemetry does not retain the first rejection's reason, so its cause cannot be established from this database.

Recommended next step: record request-level duration and bounded correction feedback using the existing stage telemetry, then use those measurements to target tool sequencing, repeated context, or correction requests. Keep factual review while simplifying the duplicate narration workload. This audit cannot determine whether upstream inference, payload size, or tool/correction sequencing contributes most to model latency.

### 4. Failed cannon attempts leave the scene largely stalled — observed pacing issue

Turns 3 and 4 both end with the cannon unloaded and unaimed, and the single ammunition set intact. Clearing the crowd and maintaining temporary ballast are real gains, but no shot is fired, no alternative is discovered, and no concrete advance of the warship or underwater mystery is established in these two turns.

Preserving failed checks is correct. Repeated failure need not leave everything else unchanged. The [gameplay reference](GAMEPLAYLOOPPROMPT.md#L1282) explicitly permits failures to change the environment or reveal another path. Here the failure loop offers little beyond trying again, with several minutes of processing per attempt.

Recommended change: adjudicate a specific consequence or new opportunity when repeated failure warrants it, without turning the failed main action into success. The adjudicator must establish that consequence before narration. Avoid making basic cannon setup depend on unnecessary serial checks when an earlier success has already removed the relevant uncertainty.

## What worked

- All twelve checks agree with the accepted action statuses; all four published rounds preserve those successes and failures. No player submission is copied verbatim as its narration paragraph.
- Both selected utility abilities grant advantage and consume one use, including the failed scent check. The panther's STR relic contributes its saved +1: turn 4's 19 becomes 23 with the attribute modifier and relic. No resource-use discrepancy was found.
- Failed looting produces no invented inventory, gold or loot. Failed cannon work preserves the ammunition explicitly. Successful crowd clearance and temporary stabilization persist in the journal.
- The +15 XP ship discovery and +10 XP cannon discovery are tied to new information, shared across the party. Repeated cannon attempts grant no duplicate XP. Each character has 25 XP.
- Every reviewed turn uses v2 adjudication and resolution and commits on its first recorded stage attempt, with no persisted stage failure. Internal narration corrections still occurred in the two four-request narration stages.
- Setting, Dutch language, atmosphere and character-specific actions remain coherent. The ocean environment creates plausible uncertainty, and the opening offers two distinct threats without an action menu.

## Acceptance limits and next playtest

This session exercises noncombat checks, utility consumption, rewards, causal consequences and journal continuity. It does **not** exercise the repair plan's main/minor combination, ally healing/Cleanse, downing/death, new-combat routing, restart recovery or an explicit retry. Passing this session cannot establish those fixes as accepted in ordinary player use.

After addressing narration and assistance, replay a coordinated setup with controlled dice in an isolated test: a helper succeeds before a loader's dependent check, the help has an explicit justified effect, each action is narrated once, and repeating a failure changes the situation without erasing its failed result. Separately cover main/minor outcomes, ally support and encounter-introduction recovery. Leave the ongoing campaign's completed turns intact.

## Implemented follow-up

New narration uses grouped v2 passages, retaining exact event coverage, causal/engine order and the existing v1 checkpoint reader. Successful checked assistance now grants advantage through saved, target-specific helper receipts; late, failed, unrelated, duplicate and self assistance is rejected before rolling. Routine help may remove the need for a dependent roll. The adjudicator also receives explicit guidance to preserve prior preparation and establish proportionate consequences or opportunities after repeated failure, while keeping the checked main action failed.

Validation: 479 unit/integration tests passed, the production build passed, and five browser regressions passed for narration playback, shared screens and turn navigation. The 19 new regressions include assisted success/failure, disadvantage cancellation, ability non-stacking, grouped narration coverage/order, file-backed restart without rerolling, and a failure-caused discovery whose journal/reward commit occurs once.

An isolated live `gpt-5.6-sol` acceptance run completed with seven model requests. Helper's successful check explicitly targeted Loader; Loader received advantage, rolled `[7, 12]` and succeeded with total 14. Five finalized events became two Dutch paragraphs, with no separate check announcement or recap-only closing. The live run also exercised an adjudication correction for receipt/event ownership; the cooperation contract now states that helper effects are dependencies rather than the supported actor's own event/receipt list. Repeated-failure pacing is GM guidance, with deterministic coverage of valid consequences; the live acceptance covered assistance and narration. The active campaign and credential store were not modified by these acceptance checks. Adjudication performance work belongs to the other concurrent task.
