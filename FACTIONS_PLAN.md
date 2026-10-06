# Factions and individual reputation

Status: proposed; gameplay implementation has not started.

## Intended behavior

Every new campaign has at least three distinct factions before its opening scene
is resolved. Each faction has an agenda, a source of influence, and a concrete
connection to the campaign's central conflict. They can affect events before the
party learns their identities. Discovery follows the story rather than a turn
schedule; the opening does not need to introduce all three.

Each character can have an optional connection to a faction. Affiliation and
reputation are separate: an unaffiliated character can be trusted, and a member
can become an enemy. Reputation represents **the faction's attitude toward that
individual character**, never a single score for the whole party.

## Existing integration points

- `shared/schema.ts` already accepts journal entries with `kind: 'faction'`, but
  these are public prose, without stable identities or relationship mechanics.
- `server/game.ts` creates campaigns synchronously, starts an opening turn
  numbered **0**, freezes turn context, finalizes changes in a saved draft, and
  publishes the result atomically. Use this lifecycle for generation and changes.
- `shared/turn-resolution.ts`, `server/turn-resolution.ts`, and
  `server/turn-recovery.ts` separate adjudication, saved facts, narration, and
  recovery. Faction consequences belong to adjudication and finalization.
- `server/providers.ts` generates characters and resolves the story. Campaign
  character generation currently receives campaign configuration, not a faction
  registry; library characters can exist before a world starts.
- `src/main.tsx` renders the public world journal; `src/CharacterSheet.tsx`
  renders individual characters. Extend these views rather than add a separate
  faction management application.

## First-version rules

### World generation and story involvement

Generate three factions initially; enforce a minimum of three in the validated
world schema. Permit a small bounded list, such as three to six, so established
factions in an existing campaign can be retained. Generate original factions
from the setting, premise, tone, instructions, language, and party backgrounds.
Honor explicit existing setting lore and avoid a fixed faction catalog.

For each faction, save a stable server-assigned ID, name, identity, goal, methods,
resources, private agenda, and one concrete story hook. Include a small set of
relationships between faction IDs: at least one conflict and one competing or
overlapping interest across the initial factions. Their roles should differ;
three differently named versions of the same organization do not satisfy the
design goal.

Keep a current activity fact and the turn when it last changed. When the story
reaches a relevant NPC, location, objective, or consequence, adjudication can
advance that activity or introduce its hook. Use existing world events for
these developments. Consider relevant factions each turn, but do not force a
faction cameo or advance every agenda on every turn. These activities influence
offers, obstacles, information, and reactions; they are not a separate simulation.

### Gradual discovery

Keep the full registry server-side. Each faction has `discoveredTurn: number |
null` and an accumulated `knownDescription` containing only established public
facts. Revealing the name does not reveal its private agenda, allies, or motives.

Discovery needs a resolved story event, such as a meeting, an identified emblem,
a credible rumor, or a character's established connection. Before discovery,
describe only observable consequences or unnamed actors. Allow zero, one, or
several discoveries in the opening when the premise warrants them; there is no
mandatory introduction count or deadline. Treat discovery as party-shared in
this version, matching the existing shared journal and story screen.

### Optional character connections

Store connections in campaign character state, not reusable character templates.
Initialize them once for the opening roster and once for each later arrival.
Use an explicit faction connection in the player's concept/background when it
matches the world. Otherwise, propose a default **25% chance of one connection**,
rolled by the server and saved before the model writes its explanation. The
model selects a plausible faction and describes a past connection; it does not
decide whether the chance succeeded. These are starting playtest values.

Support a simple lobby preference: **allow a generated connection** (default)
or **remain unaffiliated**. Remaining unaffiliated prevents generated ties, but
does not remove explicit enemies or allies from a player's supplied backstory.
Never replace the player's core background, assign an incompatible allegiance,
or invent a connection when none fits. A generated tie can be a former member,
contact, patron, or debtor; it need not be current membership.

A benign generated connection starts at +2; an explicit hostile history can
start at -2; everybody else starts at 0. Record the reason. Introduce any starting
tie and the faction facts the character knows in the opening/arrival, so the
shared story explains their discovery. Explicit membership changes later require
a resolved decision or event, not an automatic reputation threshold.

### Reputation

Use one bounded integer per faction and character, with missing values equal to 0. Keep one shared helper for deriving attitude:

| Score         | Attitude |
| ------------- | -------- |
| -5 through -2 | Hostile  |
| -1 through +1 | Neutral  |
| +2 through +5 | Friendly |

Ordinary consequential help or harm changes reputation by +1 or -1; major aid,
betrayal, or completion of a faction objective changes it by +2 or -2. Clamp to
[-5, +5] and cap the total change for a faction/character pair at two points per
turn. Record the actual applied change, including saturation at the bounds.

Changes require a resolved event, a reason, and a plausible way for the faction
to learn who was responsible. A secret action has no immediate reputation effect
without witnesses, evidence, or a later report. A failed check alone is not a
reason to punish reputation; assess the actual consequence. Repeating the same
favor, promise, or already completed objective earns no additional reputation.
Use the existing event history/journal to track consequential achievements.

Attribute consequences to the characters responsible. Shared deeds may affect
several named participants, but never silently affect every party member. Do
not automatically change rival-faction reputation; a separate justified reaction
is required. Membership never forces a friendly attitude.

### Gameplay consequences

Include individual scores and affiliations in the GM's private context. Friendly
factions can offer cooperation, information, access, or fitting objectives.
Hostile factions can distrust, refuse cooperation, demand concessions, or oppose
the responsible character. Neutral factions judge the current situation.

When party attitudes differ, NPCs respond to the characters they recognize and
the person speaking; do not average party reputation. For example, a faction
might welcome its trusted courier while refusing their wanted companion entry.
Attitude is context for adjudication, not guaranteed success or forced combat.
Any checks, enemies, rewards, or items still use the existing implemented rules.
This version adds no universal reputation bonus to dice or automatic price table.

## Data and persistence

Use the project's existing JSON persistence pattern:

- Add a nullable `campaigns.factions` JSON column with a schema version and the
  private registry. Keep it separate from public `CampaignConfig` and `Scene`.
- Extend `CharacterState` with optional `factionAffiliation`,
  `factionReputation: Record<factionId, number>`, and an initialization marker.
  Persist the initialization result even when no connection is assigned.
- Add the private registry to `GMContext` and the frozen `Draft`. Save initialization
  rolls and generated data as checkpoint receipts. Do not rebuild internal GM
  context from a filtered public snapshot.
- Add bounded faction effects to current adjudication: discoveries/public facts,
  activity updates, and reputation deltas. Each effect references existing faction
  IDs, the appropriate character incarnation, and its supporting resolved event.
  Validate references, duplicates, values, and event dependencies server-side.
- Finalization applies effects to draft state once and saves before/after receipts.
  Publication writes campaign and character state in the existing transaction.
  Narration cannot write faction state or change an attitude independently.
- Retain legacy adjudication/resolution versions; absent new fields mean no effects.
  Extend conversions such as `adjudicationOutcome` deliberately so new fields are
  not silently stripped by strict schemas.

Member IDs survive character replacement today. Reset faction scores and ties
when `activateReplacements` creates a new character state, and initialize that
arrival independently. Preserve the former character's relationships in saved
history. Temporary inactivity or rejoining the same seat does not reset scores.
Starting another campaign from the same template starts independent relationships.

## Implementation sequence

1. **Schemas and persistence.** Define the private registry, public faction view,
   character relationship fields, attitude helper, and bounded faction effects.
   Add the next database migration (currently version 11). Keep old saves readable
   with empty/default relationship state; run no model calls inside migrations.
2. **Initialize before opening adjudication.** Add a bounded world-generation
   method to `GameMaster` and implement it in `ChatGPTGM`. Run it inside the
   asynchronous opening workflow, before its first adjudication. Preserve the
   existing roster/configuration freeze before the first await; generate from
   that frozen input, then checkpoint the enriched faction context. Late joins
   during generation still belong to the next turn. Save the accepted registry
   and connection rolls before proceeding. A retry
   reuses them; generation failure leaves the opening recoverable instead of
   starting a world with fewer than three factions. Account for initialization
   separately from the existing eight-request adjudication budget.
3. **Connect arrivals.** Apply the same once-only connection initialization to
   late joins and replacement characters at their next eligible turn boundary.
   Use explicit backstory ties first and the saved chance only for optional ties.
   Keep character library generation free of campaign-specific reputation.
4. **Adjudicate and publish effects.** Extend provider schemas/prompts, validation,
   finalization, publication, and checkpoint recovery together. Validate against
   the frozen roster and actual successful/failed event dependencies. Save private
   faction activity even when it has no public reveal; include only justified
   public consequences in narration. Recover narration/publication without
   replaying deltas or connection rolls. Route legacy-compatible turn commits
   through the same bounded update helper where supported.
5. **Expose discovered factions.** Add faction cards to the existing journal with
   known description and a compact per-character attitude/score display. Show a
   character's known connections on their campaign sheet, keeping affiliation
   distinct from attitude. Show explained changes in the turn's expandable log.
   Use stable IDs to update faction journal entries instead of relying on names;
   the structured registry is authoritative for reputation.
6. **Preserve existing campaigns and document behavior.** At the next fresh turn
   boundary, initialize campaigns without a registry using established journal
   factions first, adding enough to reach three. Preserve names and discovered
   lore; do not retroactively assign optional ties or invent historical scores.
   Never regenerate a started legacy turn's context. Include complete private
   state in the existing host-only campaign export, clearly marked as containing
   spoilers. Update the gameplay reference and README after implementation.

## Discovery boundaries

Filtering must happen on the server, before serializing snapshots or turn data.
Ordinary host, player, and shared-screen views receive only discovered factions,
known descriptions, and relationships to those factions. Hidden faction IDs,
counts, scores, agendas, and activity updates must not leak through character
state, public resolutions, receipts, diagnostics, or journal entries. The host's
normal playing view uses the same discovery rules; full export is the deliberate
exception. Existing image-prompt generation continues to use public story data.

The adjudicator can see private agendas, but the narrator receives only resolved
public facts and consequences. Separate private faction receipts from the public
resolution. Review narration for premature faction names and unsupported private
facts as part of the existing fidelity review. This reduces accidental spoilers;
semantic disclosure by a generative model remains something to playtest.

## Verification and acceptance

- Generate at least three valid, distinct, connected factions; reject too few,
  duplicate identities, invalid references, and malformed provider output.
- Exercise an opening that reveals one faction while two remain hidden, then
  discover another through a later event. Verify meaningful faction involvement
  before and after discovery without dumping the registry into narration.
- Use controlled rolls to cover connection/no-connection outcomes, opt-out,
  explicit ties, incompatible backgrounds, late arrivals, and no reroll on retry.
- Cover neutral defaults, both attitude thresholds, score bounds, per-turn caps,
  attribution to individuals, shared deeds, secret actions, and repeated favors.
- Verify the same faction can be friendly to one character and hostile to another,
  and that the adjudication context preserves those distinct attitudes.
- Interrupt after initialization, finalization, and narration; retry and restart.
  Assert factions, discoveries, affiliation rolls, and deltas apply only once.
- Verify a replacement resets relationships despite keeping its member ID, while
  deactivation/rejoining and independent template copies behave as specified.
- Inspect raw API responses for host, player, and shared display, including turn
  history and resolving turns, to ensure undiscovered/private data is absent.
- Verify old saves and started legacy turns recover unchanged; backfill only at
  a fresh boundary. Verify export retains the full registry and current scores.
- Add focused tests using existing Vitest fixtures and one browser flow for gradual
  discovery and different character attitudes. Run affected tests, `npm run check`,
  `npm run build`, and the relevant Playwright flow. Playtest English and Dutch.

Defer faction ranks, automatic rival penalties, personal secret journals, scheduled
political simulation, faction creation/destruction during play, and reputation
decay until the core system is working and playtested. No new dependency is needed.
