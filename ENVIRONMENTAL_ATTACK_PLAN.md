# Environmental combat actions

The GM may fill missing mechanics for a submitted action that uses an established
part of the scene. The server validates the proposal, saves it before any rolls,
and owns execution and lasting source state.

1. Add an optional, bounded environmental profile to combat actions. It cites a
   supplied public world fact, chooses an attack against defense or a difficulty
   check, and specifies damage dice, a small damage bonus, and whether the source
   is reusable, needs reloading, or is used up. Existing actions remain compatible.
2. Normalize environmental actions independently of equipped weapons. Preserve
   player intent, selected abilities and target choices. Invalid or unsupported
   proposals become an explicitly blocked action with an explanation.
3. Execute these profiles through the creative combat path. Save source profiles
   and readiness in scene state. Consume a shot or one-use opportunity on an
   attempted attack, including a miss; preserve it when the actor or target is
   unavailable. Reloading spends a main action and requires a cited, unspent
   resource. Earlier preparation and spent resources survive retries and reloads.
4. Supply world-fact references and source state to the planner. Explain the
   contract in prompts and narration so an offensive action cannot silently become
   a successful harmless interaction. Receipts describe hits, misses, blocked
   attempts and consumption before narration starts.
5. Test cannon targeting, damage, ordinary attacks and peaceful intent, grounding,
   bounds, critical rolls, shared sources, reloads, and retry/restart persistence.
   Verify against the saved playtest input without modifying the campaign.

Initial scope: one enemy target per environmental attack, damage dice whose
maximum total is at most 24 plus a bonus of 0–3. Reuse existing critical,
initiative, ailment, downing and reward rules. One source is identified by its
stable world-fact reference; new facts may be recorded during normal adjudication.
No new dependency, database migration or extra model review request is needed.

Status: complete.

Validation: production build passed, all 508 unit/integration tests passed, and
the five recovery/navigation browser checks passed. Tests cover the model-facing
contract with mocked responses and prove that combat plans are saved before dice,
with identical dice, damage and source readiness after a SQLite restart/retry.
A read-only simulation used Roberto's saved turn-9 submission and established
cannon preparation. With a proposed `2d6 + 1` profile and controlled rolls, it
produced one attack roll, two damage rolls, 7 damage to the named harpooner and
a spent load. The live campaign and its saved rolls were not modified.
