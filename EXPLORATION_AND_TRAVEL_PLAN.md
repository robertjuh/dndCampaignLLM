# Exploration, arrivals and travel

Status: implemented and locally verified, 9 October 2026. Completed playtest
history was preserved; the new contracts apply to fresh adjudications.

## Findings from Kraterwereld

- Turn 7 blocked travel from the Ribbenmeer toward the Rotsrichel. The saved map
  provides an open route through Bunker 67; the next leg could have succeeded.
- Turn 9 described arrivals at the Jungle-afdaling and Rotsrichel mostly through
  rain, foliage and restricted visibility. Players received little local detail
  or orientation beyond their arrival.
- Turn 10 left Roberto's failed search with no useful information beyond the
  washed-out tracks. Kras reached a new local feature, but adjudication added no
  world events or map connections to develop the discovery.
- Current prompts already request scene clarity and consequences of failure,
  but these are loosely enforced. Exploration loot mostly uses story tools;
  `offer_loot` generates an item when invoked, without a discovery-chance roll.

## 1. Make meaningful failed searches informative

Basic visible surroundings, obvious objects and recognizable exits are available
without a check. Roll only for a specific uncertain discovery or interpretation.

Every meaningful failed environmental search should establish a useful lesser
observation while preserving failure of its main goal. Examples include a broad
direction, a visible feature worth investigating, the boundary of the searched
area, or a concrete limitation that distinguishes another approach. An explanation
such as "rain obscures everything" alone is insufficient. The observation must
help the player understand the place or make a more informed next decision.

The observation need not reveal the sought secret, exact destination, requested
item or solution. Do not claim that a failed search proves something absent.
For illustration, a failed attempt to read meteorite tracks could still expose a
mud channel continuing downhill, without identifying it as a meteorite trail.
This is a proposed example, not a correction to the saved turn.

Identify searches explicitly in the existing adjudication output, with a stable
local source and referenced information event. Use a public world event with an
`occurrence` dependency on the failed check; preserve the checked main action's
failure. Validate referenced events, locality and receipt ownership. Persist the
observation in the journal when it will matter later. Narration and review receive
the failure, its circumstances and the lesser observation together.

An unchanged repeat search uses the established information and normally needs
no new roll. New approaches or changed conditions can justify another check.
No automatic XP for failure or repetition; retain rewards for genuinely useful
new discoveries under existing rules.

## 2. Give successful searches a small bonus-loot chance

Implemented starting rate: **15% per fresh, eligible successful search source**.
This applies to meaningful environmental exploration/search checks, rather than
every social, combat or information-only check. The normal successful discovery
still happens when the bonus-loot roll misses.

The existing adjudication response supplies eligibility, source, actual location
and an optional scene-appropriate reward blueprint (defaulting to a usable healing
potion). A missing blueprint does not reject the primary discovery. The server validates the successful
check and runs the chance during finalization, before freezing narration facts.
No extra model assessment, tool round trip or gameplay stage is required.

- Reuse authoritative local randomness and `randomLoot` for rarity, power and
  consumable mechanics. The reward is equippable gear suited to the discoverer's
  anatomy/slots, or a usable potion. Existing story tools remain available through
  their current discovery path and do not replace this bonus. If rolled equipment
  requirements exceed the discoverer's stats, the find becomes a healing potion
  of the same rarity.
- Record the chance and generated item in keyed durable receipts. A single global
  `receipts.loot` slot cannot represent independent searches by several players;
  distinct sources need distinct keys.
- Record attempted bonus rolls per place/source, including misses. Retries,
  returns and renaming the same cache must not reroll or replenish it. Several
  characters searching the same physical source share one bonus opportunity;
  independent sources may each qualify.
- Keep found items as local ground loot until explicitly taken. Preserve split
  locations, inventory capacity, existing pickup controls and player choices.
- Freeze any actual discovery as a server event before narration. Do not put a
  hypothetical bonus item into the journal or describe it when the chance misses.

Use optional fields in existing JSON checkpoints/place state. Existing completed
turns and already exhausted sources retain their meaning.

## 3. Establish and narrate playable arrivals

Detect arrivals from each character's previous and resulting location, including
arrivals outside shared scene focus. At first visits, adjudication establishes:

- A recognizable setting and a few concrete visible features or inhabitants.
- Relevant observable hazards, shelter and immediate circumstances.
- Visible routes, their destination or direction, and whether they are open,
  blocked or one-way. Save adjacent previews/connections with evidence events.
- A meaningful observable lead connected to the place, campaign or characters
  when appropriate: evidence, activity, a usable feature or an NPC concern.

A genuinely enclosed place can have no new exit; make its boundaries and existing
return route clear. Avoid encounter or object quotas. Do not pre-generate unseen
rooms, reveal secrets or manufacture mandatory puzzles and blockers. Broad inward
movement within a scene may reveal local features without creating another tile.

Require an arrival's public scene/route evidence during adjudication validation.
Missing arrival facts use the existing bounded correction path. Existing saves
remain readable; enforce the new contract on fresh adjudications. A text field's
mere non-emptiness does not establish that the scene is useful: inspect the final
story in playtests too.

Freeze the arrival context for the narrator. Give significant first arrivals
their own substantial story beat, usually one or two paragraphs, with atmosphere,
spatial orientation and concrete observable possibilities. Length is a guide,
not a padding quota. Describe routes and features naturally, without telling the
players which action to choose. Keep the short situation summary concise.

Preserve shared-scene narration: companions arriving together get one arrival
description with their individual contributions woven in. Separated arrivals use
their own surroundings. Retain recorded check reasons and the existing separation
of factual review from style feedback.

## 4. Travel toward a destination through intermediate places

Separate the requested goal from this turn's actual destination. For a known
goal, use a small deterministic graph traversal over saved open connections to
select the next hop from the acting character's actual place. Respect one-way
edges, blocked routes and explicit player route restrictions. Use a stable route
choice when several equally short routes satisfy the request.

Example: `Ribbenmeer → Bunker 67 → Rotsrichel`. A request to travel toward the
Rotsrichel moves the character to Bunker 67 this turn. Narration states that the
character is on the way and describes the intermediate arrival; it must not
claim the Rotsrichel has been reached.

Resolve destination intent within the current adjudication request and supply
the computed next-hop options there. Keep the existing adjacency validator;
the finalized movement event targets the next hop. Record the ultimate goal
as context so narration explains the partial journey accurately. Do not silently
rewrite an already finalized movement or replay an earlier denied turn.

For a goal with no known mapped route, such as a distant meteorite, interpret
"toward" as feasible exploration along an observable route or established
bearing. Adjudication can establish the next local leg and its adjacent arrival,
without inventing an exact route to the final goal. Lack of a map edge alone
must not turn ordinary exploration into an impossible action. An actual barrier,
unknown direction, active combat or a meaningful hazard still affects what can
be achieved; explain it and preserve any feasible progress.

A genuine local obstacle to the requested travel method cites
`travel.obstacleEventId`, a public local world event. This allows a mount's refusal
to block the requested ride without closing the footpath for everyone.

Cross at most one meaningful connection per character this turn. An ordinary move
may be followed by one explicitly submitted main action at the arrival, such as
inspection, searching or conversation. Record these separately in movement and main;
destination consequences depend on successful movement and use the destination's ID.
A failed destination action preserves the arrival and gives a partial overall result.
Risky, ability-assisted or resource-dependent travel uses main itself and grants no
second main action. Stop at an actual travel obstacle. Travel-only submissions add no
unsubmitted destination action, combat act or automatic later-turn journey.
Companions with the same journey share narration, while different origins,
restrictions and outcomes remain explicit.

## Implementation order and verification

1. Add destination/next-hop handling in `shared/locations.ts` or
   `server/world-map.ts`, integrate it with adjudication input/validation and
   preserve existing movement receipts.
2. Add the explicit search-information and arrival-evidence contracts in
   `shared/turn-resolution.ts`, `server/turn-resolution.ts` and
   `server/providers.ts`; update `GAMEPLAYLOOPPROMPT.md` alongside the runtime
   instructions.
3. Add server-owned bonus-loot finalization and durable source/receipt bookkeeping
   in `server/game.ts` and the existing place/checkpoint schemas. Reuse current
   loot rules and controls.
4. Update narration/review to tell the recorded developments as connected scenes
   and verify the final story, not only the structured outcomes.

| Case                                     | Required result                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Failed new environmental search          | Failed main goal plus useful, concrete lesser information; no requested secret/item granted          |
| Repeated unchanged search                | Established information retained; no farming new checks, loot or XP                                  |
| Successful search, bonus miss/hit        | Primary discovery survives both; item appears only on a hit                                          |
| Restart before/after finalization        | Identical chance/item; no duplicate item or reward                                                   |
| Several players, shared/distinct sources | One bonus opportunity per physical source; independent receipts for distinct sources                 |
| New place or split arrival               | Local features, relevant circumstances and visible exits reach the final story and saved map         |
| Return visit                             | Same place identity, loot and source history; refresh only actual changes                            |
| Known goal two or more hops away         | One valid next hop toward that goal; no adjacency denial or false final arrival                      |
| Blocked/one-way/ambiguous route          | Respect actual constraints and player restrictions; explain feasible progress or obstacle            |
| Unmapped distant goal                    | Feasible local exploration when supported; no fabricated complete route or automatic goal completion |
| Shared travel/NPC scenes                 | Connected prose with every participant's distinct result and recorded circumstances preserved        |

Use deterministic dice for probability boundaries and retry checks; extend the
existing world-map, location-continuity, playtest-followup and turn-resolution
tests. Run the full suite and production build after integration. Validate the
Kraterwereld examples from turns 7, 9 and 10 using frozen fixtures and isolated
playtests. Do not alter live submissions or retroactively change completed turns.
Keep the current model stages and request limits, with no new dependencies or UI
settings for the first implementation.

## Verification

- Full local suite: 712 passed; the remaining tunnel safety test initially could
  not bind its loopback socket inside the sandbox and passed when rerun with
  loopback access (713 tests total).
- TypeScript and production build passed.
- Frozen Kraterwereld turns 7, 9 and 10 exercise next-hop travel, split arrival
  evidence and lesser information after failed searches. Illustrative new facts
  exist only in isolated tests; saved turns were not rewritten.
- Deterministic regressions cover the 15% boundary, equipment usability, shared
  and distinct caches, normalized source IDs, story-tool discoveries alongside
  bonus loot, split locations, return visits, directed/blocked/restricted routes,
  unmapped journeys and interruptions before/after finalization.
- Mocked writer/reviewer checks verify that both receive identical arrival and
  search facts, omit hypothetical rewards and use the existing request stages.
  No live model replay or export of these new playtest fixtures was performed;
  prose quality and semantic source classification still need normal playtesting.
