# Fairy-forest map playtest and repeated timeout audit — 8 October 2026

Campaign: Het feeenboss (`5c859eb3-3b66-4690-827a-d757589ee726`). Audited completed turns 11–14 and failed turn 15 using an online, read-only SQLite snapshot. No live GM request or save correction was triggered by this audit.

## Completed gameplay and map

- Turn 11: the spider genuinely died. It began at 5/38 HP; the knight hit for 11 damage. The engine recorded 0 HP, victory, recovery, restored charges, XP and three actual loot drops. This is consistent with the story, unlike the corrected turn-9 false death.
- Turn 12: Natalia healed the knight through the saved resource receipt. The violin's strings were restored; its NPC and quest journal entries were refreshed and its faction discovery was recorded. Character equipment changes appear in the bookkeeping summary. The party remained in the gallery.
- Turn 13: each character crossed the Webbenpassage from the gallery to Het Zingende Wortelgewelf. The longer requested destination was correctly bounded to one adjacent location. The knight's backflip and Natalia's song were treated as routine embellishments without a new mechanical benefit.
- Turn 14: each character crossed the Wortelnotenpad to De Verdwaalde Letterweide. Known routes were preserved; the old lava hazard remained present without obstructing those routes. A narration review corrected which musical voice answered the other before publication.

The hill uses its original UUID and remains unvisited. No duplicated locations or invented shortcuts were saved. All four adjudications validate against their frozen receipts; all four resolutions parse and narrations pass event coverage and final combat-state checks. Every recorded position change follows one open, correctly directed map connection. The live scene matches the completed turn-14 scene.

## Turn 15 timeout

Turn 15 (`7567c776-a9b2-4362-8886-fc570cf114ad`) contains three submitted actions: continue to the hill, with the knight also asking his companions about Het Akkoord van Wortel en Schaduw. It failed four model requests: the initial request, one automatic retry, and two manual retries. All four failed in adjudication at approximately 90 seconds, with identical 109,291-byte request bodies. There were no returned tool calls, saved rolls, accepted adjudication or finalization. Its saved receipts are empty; positions, HP and inventory were not advanced by these attempts.

These are app-generated per-request deadlines, rather than recorded map-validation failures, HTTP rate-limit responses or proof that the provider was unavailable. Diagnostics do not retain partial streaming progress, so they cannot establish whether the upstream model was still generating or stalled. Successful adjudications immediately before this turn took approximately 83 seconds (turn 13) and 60 seconds (turn 14), close enough to the 90-second cap to make premature cancellation plausible. The new turn would enter an unvisited scene and may require additional generation; this is an inference, not a completed outcome.

## Correction and checks

Raised the shared model-request allowance from 90 to 180 seconds and updated its error message. Existing overall stage deadlines, user cancellation, request-count budgets and the durable one-automatic-retry limit remain enforced. No model or gameplay rules were changed. A new test completes a request after 120 seconds, beyond the former cap. Existing tests still verify streamed request expiry, stage expiry and cancellation, plus checkpoint reuse across retries.

This gives slow responses more time; it cannot guarantee success during an upstream stall. Failed turn 15 remains available for a normal host retry with its saved actions intact.

Verification: **651 unit tests in 23 files passed**, including the provider, turn-resolution and map regressions. TypeScript and production build passed. The four saved completed turns passed the separate read-only receipt, narration and movement audit.

The app already reads streaming Responses until successful completion. The [official OpenAI streaming guide](https://developers.openai.com/api/docs/guides/streaming-responses) documents incremental server-sent events; partial output alone does not establish a finalized game result. This audit retained that completion requirement.


## Follow-up: investigate the underlying latency

Raising the deadline prevents premature cancellation but does not explain the slow response. A read-only replay of the request builder (a capturing fetch stub, with no provider request) measured the turn-15 request at about 109 KB before cleanup: approximately 34 KB of fixed instructions, 22 KB of history, 17 KB of current character/capability data, 6 KB of duplicated starting state, 5 KB of faction context, plus tools/schema/scene/journal data. The map itself is a small part of the scene payload. There is no logged adjudication correction loop in any of the four failed attempts: each times out during its first request. Successful server finalization/publication runs take milliseconds.

The history repeats snapshots of journal facts and unchanged location descriptions. Provider input now omits historical journal snapshots whose kind/name already has a canonical current journal entry, and exact unchanged location snapshots. Historical action/event facts and unmatched clues remain. Legacy prose summaries are retained unchanged. Starting state is omitted only when its complete projected state equals the current state; otherwise the full starting state is sent. Input documents this omission explicitly. Durable history, current lore, actual capabilities, mechanical receipts and game saves are unchanged.

Replaying the same turn-15 builder after cleanup measures approximately **92 KB**, about **16% less request data**. The JSON contract also asks for compact formatting, brief fact/reason strings and no unchanged journal/place updates. This is intended to reduce generation work; no live response-speed improvement has yet been measured. The [official OpenAI latency guide](https://developers.openai.com/api/docs/guides/latency-optimization) explains that output generation commonly dominates latency and that input reduction alone may yield only a modest improvement. Request byte savings must not be presented as equivalent time savings.

The existing `outputBytes` counter measures the entire completed output envelope, potentially including non-visible response items. It does not establish how many visible answer tokens were generated. Old timeout logs also omit partial stream progress, so they cannot distinguish waiting for response headers, model reasoning, output streaming or a stalled provider.

New request diagnostics retain numeric authentication duration, response-header latency, first byte, first visible text/tool output, streaming byte count, visible completed output bytes, and input/output/reasoning token counts when the provider supplies usage. Partial progress remains recorded on failure. No tokens, private reasoning content or transcript chunks are logged by these metrics. These observations can identify the next slow request's actual bottleneck without changing the model or weakening game validation.

Regression checks verify that context projection does not mutate saved data, changed starting HP remains available, historical events and unmatched clues survive, and both completed and aborted streams preserve the correct diagnostics. The previous timeout/cancellation and checkpoint safety tests remain in place.


### Evidence from the subsequent live retry

The host's retry with the 180-second limit returned its first response after **103,223 ms**. Validation rejected it with “A position change requires an explicit movement effect, not an unrelated success.” Its main-phase movement evidence lacked the required `effect:"movement"` classification. The original rejected output is not retained; this diagnosis follows the validator's exact rejection path. A second model request returned a corrected outcome after **65,729 ms**, and adjudication finished in **168,973 ms**. Thus there is now direct evidence of a costly output-contract correction in addition to the first response's generation/wait latency. The corrected adjudication and final resolution are saved; the development server reloaded during the presentation stage while this investigation was editing code. No dice or accepted gameplay should be repeated on retry.

The provider input now gives an explicit main-phase `movementProof` shape with `effect:"movement"` and `result:"success"`. The shared validation error identifies the offending event and explains how to correct all movement proofs, retaining the prohibition on unrelated successes moving characters. This targets the observed correction without weakening map validation. Compact output guidance and context deduplication target avoidable model work; the earlier attempts still lack first-byte and reasoning metrics, so the entire 103-second first response cannot be attributed to one proven cause.

After the context/diagnostics changes, **654 tests in 23 files passed** and the production build passed. Final focused checks also cover the explicit movement example and the actionable validation feedback.
