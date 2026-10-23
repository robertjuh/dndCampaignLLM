# Scene GM implementation

Status: implemented and verified, 20 October 2026; extended to combat on
21 October 2026 and gathering on 22 October 2026. Applies to new ChatGPT
exploration, conversation, opening, combat and gathering turns. Already-started
compatibility checkpoints retain their saved model interface.

## Outcome

Exploration, conversation and executed combat use one creative GM response with small domain
operations. The server compiles those operations into the existing authoritative
turn format. A valid action must not depend on the model supplying matching IDs,
dependency lists, arrival evidence, map edges and action aggregates. The current
rules engine, immutable dice, saves and publication transaction remain in use.

## Work

1. Add a scene-response contract and compiler. Operations describe movement,
   interactions/investigations and local world developments, with their prose.
   Generate identities, action outcomes, dependencies, journal evidence, arrivals,
   map connections and narration coverage in code. Explicitly describe a new
   place and its danger; never infer safety from missing enemies. Existing
   movement, resource, locality, NPC and mechanical validators still apply.
2. Route new noncombat turns through the smaller interface. Resolve mechanical
   uncertainty through existing tools, then return the scene once. Publish its
   prose from the saved accepted response without a separate writer/critic pair.
   Keep legacy checkpoints and gathering compatible. Random encounters
   still use their saved checks and existing introduction protocol.
3. Store bounded private GM notes independently from public scene/journal data.
   Each important hook has a stable cause, discoverable answers, relevant actors
   and a possible next development. Include due activities in the next GM context.
   Existing notes update by ID and changed fields; immutable causes need not be
   copied through each response. Persist notes atomically with the turn; keep
   them out of snapshots, separate narrator input and ordinary diagnostics.
   The leader's spoiler-marked export includes them. No real-time scheduler.
4. Treat exhausted or invalid model responses as processing failures. Keep the
   same submitted turn and dice/resources for retry. Preserve ordinary movement
   when a destination investigation fails. Never publish a formatting failure as
   a character's inability or consume an unresolved action.
5. Verify with the recorded tower context in an isolated database, plus focused
   checks for failed investigations after movement, blocked routes, player agency,
   private memory/restart/atomicity, and one-response narration. Run the existing
   suite, type checks and production build; document measured results and limits.

## Boundaries

The GM determines fictional answers and NPC decisions within established facts;
the server determines dice, costs, damage, inventory, legal movement and durable
state. Prose is generated alongside its facts by the same creative response;
there is no claim that deterministic code can prove arbitrary prose faithful.
Mechanical/state validation and public/private data boundaries remain strict.
Any validation correction addresses the small domain proposal, not a second
author's interpretation of the prose. Live saves and completed play history are
not rewritten or advanced during verification.

## Acceptance

- The saved “I take the stairs down” context accepts a simple scene response,
  creates its chamber/map/arrival records, and publishes descent without repairs.
- A failed checked search after ordinary travel leaves the actor arrived.
- No model-generated event IDs or receipt copies are required by the new wire
  format; internal canonical evidence remains available for existing validators.
- The common noncombat path needs no separate narration or fidelity-review call.
- Technical failures stay retryable with original receipts and no fictional block.
- Private hook causes persist across turns and cannot be silently rewritten;
  public knowledge is revealed only through the GM's declared scene events.
- Due world activities are supplied during turns, including passes, with local
  opportunities and NPC decisions remaining subject to existing continuity rules.
- Existing saves/checkpoints and gathering continue to work.

## Combat follow-up

New combat turns use the same scene compiler after the existing combat planner
and engine execute the round. A combat beat contains only its location and
prose; the server attaches that location's saved events in execution order and
derives each actor's main/minor outcomes from their own receipts. Enemy attacks
and condition damage remain unowned events. Simultaneous locations stay separate.
Victory requires a world aftermath and refreshed local place, while XP, loot,
recovery, dice and resource use remain owned by the existing engine. Combat
prose has no separate writer/fidelity-review requests. Direct false death or
victory claims still use the existing deterministic combat-state validation.

Regression coverage includes the recorded darknessworld turns 24, 25 and 27,
mixed main/minor results, simultaneous fights, passes, victory and interrupted
publication/restart without repeated execution. Verification uses fixtures and
isolated databases; completed play history is not rewritten.

## Results

- Added `server/scene-turn.ts`: version-3 model responses contain movement,
  interaction/investigation and local world beats with prose. The compiler builds
  the existing canonical version-2 records and runs the existing validators.
  The public save/turn format and combat engine remain compatible.
- The accepted scene carries its prose through finalization and publication.
  Server-added encounter introductions and finalization facts are appended
  locally; denied inventory operations receive factual local corrections.
  Routine scene processing has no separate writer or fidelity critic.
- Added additive, idempotent schema migration 21 and bounded private GM memory.
  Notes retain causes, answers, actors and due activities across turns/restarts.
  Public snapshots omit notes and uncommitted resolutions. Publication commits
  private notes and public state together; failed publication rolls both back.
- Technical fallback components carry an internal processing-failure marker.
  The engine refuses to publish them as character outcomes. Independently
  validated components are saved separately and resumed by a compact patch;
  retry cannot replace completed components or reroll saved checks/resources.
- The recorded darknessworld turn-6 geography, public journal and submissions
  were replayed through finalization/publication in an isolated database using a
  constructed scene response: **one mocked request, zero repairs, zero narrator
  or review requests**. A forced random encounter used a second request for the
  existing combat-start tool while retaining the original scene and arrival.
- All **1,016 unit/integration tests** passed. The full sandbox run passed 1,015;
  its remaining existing tunnel-listener test passed when rerun with local socket
  permissions. All **9 focused browser checks** passed against a temporary test
  server/database. TypeScript checking, the production build and whitespace
  checks passed. Baseline before implementation: 1,003 tests passed.
- Thirteen focused scene tests cover the recorded descent, failed destination
  investigation, source investigation before departure, blocked-route/agency
  validation, pending technical failures, private cause stability and partial
  note updates, shared NPC conversations, denied pickups, due activity during
  passes, atomic memory/restart behavior, and saved random encounters.

Verification used recorded public context and mocked model responses; no live
provider requests or playtest advancement were performed. These checks establish
the new protocol, persistence and request-count behavior, not a measured live
latency improvement or a guarantee of narrative quality. The GM still judges
fictional significance and prose fidelity within the server's hard state rules.
Private preparation currently has a bounded 40-note working set.

## Bookkeeping follow-up, 22 October 2026

New gathering turns now use the scene compiler. A `gather` beat contains an actor
and prose; the server derives the fixed meeting point, permitted route prefix,
actual destination, main-action cost, result, movement evidence and references.
It reuses the same route calculation as validation, including earlier observed
route and danger changes in the scene. Travel and waiting cannot award discovery
XP or perform another action. Existing failed legacy turns remain resumable.

The GM can introduce a concrete local interruption with `stop:{at,fact,text}`
within the permitted route prefix. The compiler preserves completed travel and
persists the interruption with generated public evidence and a journal entry.
World beats, features and private notes still carry creative consequences and
future developments; technical format errors never become fictional obstacles.

Scene requests use short `actor:N` references alongside existing `place:N`
references. The server restores canonical identities in beats, faction member
references and tool arguments, including healing targets and assistance. Saved
identities, item IDs and prose remain authoritative.

Regression checks cover one-response gathering, existing movement spelling,
danger, combat, directionality, same-scene route/risk changes, new interruptions,
extra-action rejection, tool reference transport and publication/restart. An
isolated game replay saves a speaking stone marker, its demand and private cause
without moving another player, rerolling or requesting a separate narrator.

## Consequences and collection follow-up

- Travelling NPCs save `followingMemberId`. A move/gather can establish this
  relationship with `with:[npcIdOrName]` at departure; later successful travel
  carries registered companions and saves their actual positions automatically.
  NPC changes retain their event order, allowing introductions, departure and
  destination dialogue in one turn. Dead, remote or actively fighting people
  cannot be moved as companions; individual movement and gathering still use
  validated routes. Injuries, identities and allegiance persist.
- Explicit object collection must produce a pickup or a concrete refusal;
  movement alone cannot hide a dropped collection intent. Ordinary notices,
  letters and tools can be generated from the local fiction with stable IDs.
  Taking an object before departure saves it at the source, moves it into the
  actual inventory and survives interrupted publication without duplication.
  Movement/observation idioms such as taking the stairs remain distinct.
- The creative contract explicitly permits establishing missing world details
  and useful successful findings, while requiring durable journal/feature/NPC/
  item/preparation changes for material consequences. Concrete NPC conditions
  replace repeated requests for unspecified proof. Accepted journeys prepare a
  destination, completion condition and finite expected stages in private notes.
  This is GM guidance; a separate engine-owned journey counter is not yet added.
- A two-turn integration check makes a successful search invent a concealed
  latch, persists the opened gate and verifies that the next submitted journey
  can cross it. Existing mechanics remain authoritative.
- The audited VAAL reconciliation restores the notice explicitly taken on
  turn 5 and Oren's observed caravan position, with a saved follower relation.
  It previews changes, requires the audited failed checkpoint, backs up before
  application, and preserves original completed turns, dice and retained work.
  Tovek is not reassigned because his later participation is ambiguous.

## Investigation and continuity follow-up

The remaining combat balance follow-up caps fresh random encounters at the server:
groups of 1–4 enemies, a threat ceiling of at least 8 (or 2 per ready local
character for larger parties), tier and level stat ceilings, and one ailment per
ordinary enemy hit. Groups can outmatch a solo explorer; retreat remains a player
choice, supported by visible numbers, threats and actual routes. Innate minor/normal ailments have a 25% hit chance,
guaranteed on criticals. Existing NPC profiles and explicit story fights keep their
saved mechanics. Over-budget requests spend no dice; accepted profiles and loot
remain fixed across retries. A deterministic solo replay covers the recorded
wight setup, missed attacks, healing while Burning/Chilled and lethal outcomes.

- Added a scene-only `investigate` tool. It binds a canonical local source and
  submitted question, persists a private prepared answer and both outcome
  branches, then calls the existing check engine when uncertainty warrants dice.
  Only the selected public finding is returned. Saved preparation and checks
  survive retries; the compiler publishes the selected result directly.
- Canonical sources include places, scene features/documents, ground and carried
  items, and persistent NPCs. Existing names/aliases cannot recreate another
  source; a known named target cannot silently be replaced. Destination checks
  require actual arrival, and carried objects retain their owner's location.
- Prepared answers are append-only and track revealed indices. Attempt history
  records each source state, hook/answer and requested utility ability, so
  alternating questions cannot erase earlier attempts. Repeated results grant no
  dice, charge use or discovery XP. New prepared answers grant 10 XP once, capped
  at 40 per turn. New lesser findings after failure can advance story progress
  without converting the checked goal to success.
- Selected leads name their place; the server requires a local or openly
  adjacent route, including a visible exit for a newly previewed destination.
  Private notes retain causes, answers, actors, next developments and due turns.
- Added `meet` and `take` operations over the existing NPC and pickup validators.
  Introductions save a public journal entry. Ordinary new story objects have
  deterministic IDs, no numerical powers, and exhausted source records. A
  refused pickup corrects its prose and leaves the object available locally.
- Existing raw-check checkpoints remain compatible. Free-form interpretation,
  the relevance of a prepared answer, and the usefulness of a lead remain GM
  judgments; these changes do not add a second model reviewer or a semantic
  parser. No historical playtest turns or live campaign state are rewritten.
- The recorded akoedabar turn-7 stall now reports missing checked actions and
  first-arrival route declarations together, naming character/location aliases
  and the required operations. Compound travel/search keeps ordinary movement
  separate from its checked destination action. Enclosed rooms explicitly use
  `place.deadEnd`; saved loot is supplied on retries. Recorded success/failure
  replays and a restarted failed checkpoint preserve the original check and
  publish one tool case without collecting it automatically.
