# Campaign-independent continuity and NPC storytelling

The goal is to prevent classes of failures in new and existing campaigns. NPCs
remain characters: conversation, disagreement, negotiation, warnings, exchanges
between NPCs and deliberate nonintervention are valid responses. Combat is one
possible consequence. Player speech and decisions remain the player's own.

## Implementation

1. Extend existing consistency validation. Reject collisions between NPC,
   scenery and item identities, including entities introduced together. Evaluate
   NPC/scenery movement and witnesses at the supporting event, using the same
   changing routes as player movement. Apply witness timing to route discovery,
   world progress and danger evidence as well. Normalize the canonical boolean
   `passable` property into the existing typed route update; the map remains the
   single authority for access. Keep descriptive properties flexible.
2. Make public NPC interactions durable. Add optional NPC participant IDs to
   resolved events. Remember an established participant's exchange through the
   existing NPC updates even if the model omits redundant persistence metadata.
   Explicit state changes still require validated updates. Preserve failed checks,
   injuries, allegiance, whereabouts and death; ordinary speech needs no roll.
   Unknown NPC participants require an explicit grounded introduction.
3. Account for established affected NPCs during combat planning. Supply a bounded
   checklist of available local/adjacent NPCs sharing a public allegiance with an
   active combatant. Require an actual response or explained nonintervention in
   the existing planning response. Dialogue remains valid with `enemy:null`.
   Exhausted planning uses a conservative unchanged-position observation;
   it cannot invent dialogue, a motive, aggression or extra mechanics. Preserve
   saved reaction receipts exactly on recovery.
4. Extend partial recovery to retain independently grounded public interactions
   and state updates, with their causal prerequisites. Repairs cannot replace
   retained outcomes. Consider standalone effects individually so an invalid
   state update cannot discard an independent exchange. Preserve observations
   made before departure, using the retained movement timeline. Keep the existing finalization/publication transaction and
   factual narration fallback.
5. Add reusable sequences across unrelated settings and names. Verify NPC-to-NPC
   and player dialogue, failed persuasion, durable commitments, changing access,
   identity conflicts, reaction coverage, partial failure, interrupted publication
   and restart. Assert actual state and resource/roll counts, not prose wording.

## Verification and limits

Run focused regressions, TypeScript, the complete unit/integration suite and the
production build. Use isolated databases and mocked provider transport; do not
rewrite live campaigns or send new live model requests for this implementation.
Update the existing gameplay contracts and README.

Structured validation cannot infer every consequence from arbitrary prose. The
model must identify meaningful participants and effects in its existing output.
These changes close concrete authority/persistence gaps and exercise them across
settings; live multi-turn testing still measures language quality and latency.

Status: implemented and verified, 19 October 2026.

Implementation notes: changes reuse the existing adjudicator, combat planner,
NPC registry, journal and transactional publication. The optional `npcIds` event
field keeps older saved turns compatible. The affected-NPC checklist is bounded
to six available identities with explicit public ties; it does not infer secret
affiliations or make all NPCs fight. Full conversations remain saved in completed
events while current NPC journal entries retain bounded public memory. Overlapping
prompt instructions were consolidated to retain the existing 36,000-character
contract check. No model stage, request-budget increase, dependency or database
migration was introduced.

Verification passed: **966 unit/integration tests in 43 files**, TypeScript and
the production build. The new reusable suite contributes **77 cases**, exercising
the same guarantees in a court, laboratory and village, including distinct later
conversations, failed persuasion, combat dialogue, participant introductions and
aliases, timing across validation systems, standalone-effect recovery, interrupted
publication and restart. Mocked provider transport covers repaired and exhausted
reaction coverage. The existing prompt-size limits also pass. No live model
requests, campaign repairs or completed-history changes were made. Real-model
language quality, correction frequency and end-to-end latency remain live-test
measurements.
