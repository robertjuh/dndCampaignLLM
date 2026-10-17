# Playthrough clarity and location continuity

Status: implemented, 7 October 2026. Verification results are recorded below.

Safe rest has since been removed. The rest permissions, controls, limits and
narration checks below describe the earlier implementation. Recovery continues
through successful encounters, healing items and saved abilities.

## Intended result

Players can understand what changed, what their characters know, and which
concerns remain unresolved, while choosing their own objectives and actions.
The current scene shows enemies and reachable loot belonging to that place.
Completed encounters, unclaimed items and discoveries remain persistent when
the party leaves and returns.

The combat-heavy opening in mechaplanet was explicitly requested and appropriate.
This work does not reduce combat frequency or impose an exploration/combat ratio.
Campaign instructions continue to determine encounter emphasis.

## Evidence and causes before implementation

The reviewed mechaplanet save has completed turns 0–20, with turn 21 collecting.
The party destroyed two enemy groups, entered the Bunkeronderbouw and altered
the loyalty dossier in Kernarchief 3. Those are meaningful achievements.

- `WorldStatus` in `src/main.tsx` renders any `scene.encounter`, including won or
  escaped encounters. Fallen enemies and initiative remain prominent after combat.
- `Scene` in `shared/schema.ts` has one encounter and one ground-loot array,
  without location ownership. Both current finalization and legacy publication
  update `scene.location` without moving the old encounter or loot out of the
  new scene. Pickup looks at that same array, so this is also a state/access bug.
- The GM prohibits action recommendations, but does not sufficiently require
  ordinary surroundings, meaningful progress and remaining uncertainty to be
  understandable. The narrator cannot add facts missing from adjudication.
- Turn 16 finds no usable passage; turn 17's direct movement finds a maintenance
  hatch. Alternate routes are valid, but their discoverability is poorly explained.
- Turn 20 resolves a significant challenge but ends on another unsafe-rest warning.
  `completeChallenge` sets `scene.safeRest = true`; adjudication and narration
  say rest is unsafe. The saved resolution allows rest. Review accepted the conflict.
- The premise establishes investigation, without an explicitly chosen party goal.

Source references describe the audited implementation before these changes. Existing uncommitted work
must be preserved. Completed narration, rolls and rewards are historical evidence,
not material to rewrite when implementing these changes.

## 1. Bind encounters, ground loot and rest to their locations

Implement the state fix before changing the presentation.

- Give saved places stable server-owned IDs. A description/atmosphere refresh
  retains the same ID; travelling to another place is an explicit transition.
  Reuse an existing ID on return. Do not infer travel from a changed display name.
- Keep a small map of saved place state in the existing scene JSON. Each place
  retains its description, ground loot, relevant encounter, search exhaustion,
  environmental sources and rest permission. Reuse the existing item and encounter
  structures; no separate world service, map engine or dependency is needed.
- Preserve the existing current-scene fields as a projection of the active place
  where practical, so existing combat and equipment code needs limited changes.
  One shared location-transition helper owns saving the old place and restoring
  or initializing the destination. Use it in both resolution finalization and the
  retained legacy route. Audit other scene mutations and restart/retry paths.
- Attribute drops and discoveries to the place where their authoritative action
  occurred. Freeze that attribution in receipts before publication. A turn that
  both discovers loot and travels cannot transfer that loot to its destination.
- Taking an item removes it from its recorded ground location and puts it in the
  character's inventory. Dropping places it at the character's actual location.
  Preserve quantities, item IDs and existing backpack limits.
- Server pickup checks must require presence at the item's place. Hiding cards
  is insufficient: submitting an old item ID cannot collect remote loot.
- Preserve split-party facts. Turn 17 placed Kraak downstairs and Jeff upstairs;
  changing the shared scene focus cannot silently move Jeff. Record member place
  IDs for established movements, default older unambiguous saves to their known
  common place, and expose positions when the party is split. Personal pickup
  uses the member's place. The shared screen clearly labels its scene focus.
  This is place-level presence, without grids, distances or movement points.
- Do not restore an active combat or regenerate enemies merely by revisiting a
  won encounter. Keep discovered caches exhausted and spent environmental sources
  spent. Rewards and recovery cannot run again on return.

Migration must preserve active checkpoints and completed history. Where older
loot ownership is provable from saved drop/discovery receipts, attach it to that
place. Do not assign every legacy item to the current place. Preserve ambiguous
items in an unavailable legacy collection for an explicit correction rather
than deleting them or making them remotely collectible. Repair the mechaplanet
current state using its saved receipts without replaying turns or awarding loot.

## 2. Show the current situation, with history available separately

- Show enemy cards and initiative as a combat panel only during active combat
  at the displayed location. Fallen participants can remain within an ongoing
  fight, but completed/escaped encounters no longer occupy the current panel.
- Keep victory text in its saved turn and the existing mechanics/history views.
  Do not delete the encounter record to hide it.
- Outside combat, show only local ground loot, with a location label. Personal
  controls must make accessibility clear when a party is split. Loot remains
  available after victory until taken, and remains at the old place after travel.
- Keep carried equipment and inventory available across travel. They belong to
  the character, not the location.
- Avoid live-state enemy/loot panels that appear to belong to an older turn while
  browsing history. Either use its frozen location state where available or
  clearly separate current controls from the historical story.

Primary files: `shared/schema.ts`, `shared/rules.ts`, `server/game.ts`,
`server/db.ts`, `server/turn-recovery.ts`, `src/main.tsx`, `src/EquipmentPanel.tsx`.

## 3. Make rest permission consistent with the established scene

- Separate successful-encounter recovery from permission to take a voluntary
  rest. Winning or completing a challenge still restores the existing HP/charges;
  it does not by itself make a hazardous location safe.
- Remove the unconditional rest grant in `completeChallenge`. Finalize the
  current place's rest permission from accepted adjudication, subject to active
  combat rules. A false decision must revoke permission as well as a true
  decision granting it. Travel cannot inherit permission from another place.
- Freeze that decision and its established explanation in the resolution. The
  current scene, Rest control, narrative situation and factual fallback all
  describe the same result.
- Check narrative rest claims against the authoritative permission and reconcile
  contradictory world-event facts before narration. The fidelity reviewer must
  reject the turn-20 contradiction, rather than explicitly endorsing it.
- Preserve the existing once-per-character-between-encounters rest limit.
  Entering or revisiting a place does not reset that allowance.
- Correct current mechaplanet permission to agree with its established damaged
  installation hazard, with an auditable compatibility correction. Keep completed
  history and the encounter's already-applied recovery unchanged.

## 4. Establish usable information during adjudication

Update the actual adjudication prompt and the gameplay reference together.

- At openings, meaningful arrivals and changed situations, establish concrete
  observable surroundings: recognizable routes, reachable features, identifiable
  obstacles and relevant threats. Give enough detail to support free-form intent,
  without action buttons, recommended approaches or a prescribed route.
- Distinguish what characters can see, what they reasonably know, and what remains
  hidden or uncertain. Do not require a check for basic orientation or invent
  secret knowledge to improve pacing.
- NPC requests, motives and expectations may be explicit in-world. Players remain
  free to refuse them or pursue a different concern; an NPC request is not a
  mandatory campaign objective.
- For movement, distinguish routine access from a risky maneuver. A failed route
  search does not prove every possible route impossible. Persist what was actually
  learned so a later alternative is understandable and consistent.
- On failure, keep the attempted effect failed. Where the scene supports it,
  establish observable information, changed conditions or a different opportunity.
  Do not guarantee discoveries, manufacture penalties, or gate all orientation
  behind another roll. Preserve completed preparation.
- Store new public information and ongoing changes in the existing journal and
  authoritative world events. Narration remains tools-disabled and cannot invent
  the facts needed to make the next turn playable.

Illustrative scene description: “A maintenance hatch is visible beneath the cable
tray; the main passage is filled with collapsed concrete.” This leaves the action
to the players. Such a description must be established by adjudication before
the narrator uses it; it is not a retroactive claim about the reviewed save.

## 5. Let players state a shared goal and recognize achievements

- Add one optional, editable party-goal field at campaign creation and in leader
  controls between turns. The group chooses its wording; the leader records it.
  Show it to everyone and include it in future GM context. Empty is valid and
  never blocks starting, submitting or resolving a turn.
- Keep the premise and goal distinct. The GM cannot manufacture or replace the
  party goal. Explicit actions can establish additional pursuits in the existing
  quest journal, without requiring a quest selection menu.
- Explain meaningful changes in terms of the party's stated concern when relevant.
  Record achieved milestones and their scope in the existing journal; avoid a
  new quest engine or mandatory sequence of tasks.
- Recognize completion when established facts support it. Do not immediately
  negate a successful objective by inventing another required layer or enemy.
  Existing consequences and independent threats may continue, but must not erase
  the achievement or silently redefine what success required.
- For the dossier example, state that the Kernarchief 3 copy now records the
  group as loyal. Do not infer that every government system has changed, or invent
  further copies as mandatory obstacles. Explain any broader uncertainty as
  uncertainty. Players decide whether that achievement is enough for their goal.
- Allow a short aftermath or quiet scene when circumstances permit. Keep requested
  combat emphasis; no enforced pauses, encounter quotas or guaranteed safety.

Primary files: `shared/schema.ts`, `server/app.ts`, `server/game.ts`,
`server/providers.ts`, `src/main.tsx`.

## 6. Make the situation summary answer the players' questions

Keep connected narration and use a short factual summary, usually two to four
sentences, covering relevant parts of:

1. What materially changed or was achieved?
2. Where are the characters, and what do they now know?
3. Which established concern, obstacle or threat remains unresolved?

Do not turn these into mandatory repetitive headings in the story. Omit unchanged
facts that add nothing. State rest permission when relevant; do not finish every
scene with the same safety warning. Distinguish optional nearby opportunities from
remaining requirements. Add no advice, invented clues, automatic character choices
or obligations. Keep XP and bookkeeping in the existing server appendix/log.

Narration and review should use the same clarity and completion requirements.
Place identity, member presence, established progress and rest permission must be
frozen with the resolution so review can check them without consulting mutable
live state. Reuse existing events, journal facts and goal context instead of a
separate model call to generate suggestions. Keep current request/retry budgets.

## Delivery order and verification

1. Implement location ownership, transitions, migration and pickup enforcement;
   then correct the stale combat/loot UI. Add focused integration and browser
   checks for victory at the same place, travel, remote pickup rejection and return
   visits. Include split-party access, same-place description updates and restart.
2. Fix rest finalization and narrative consistency. Verify challenge recovery
   still occurs in an unsafe place, voluntary rest stays unavailable, a genuinely
   safe place permits rest, and travel cannot reset the rest allowance.
3. Add the optional party goal and revise adjudication, narration, review and
   factual summaries. Update `GAMEPLAYLOOPPROMPT.md`, `README.md` and the main
   implementation plan to describe the resulting behavior.
4. Check retries before/after finalization and publication: no duplicate items,
   regenerated enemies, repeated rewards, repeated recovery or lost location
   state. Cover both current and compatibility routes. Preserve saved checkpoint
   versions; migrate only where interpretation is proven safe.
5. Run `npm run check`, relevant Vitest/browser checks, the existing regression
   suite and `npm run build`. Use isolated fixtures and a copy of the campaign for
   migration checks; do not submit actions to the live campaign during testing.
6. Assess generated scenes in an isolated playtest using the existing provider
   workflow. Cases: a visible exit, a failed search, an alternate approach, a
   completed objective, an NPC request declined, and an intentionally combat-heavy
   opening. Mocked output can verify plumbing but cannot establish improved GM
   behavior. Record live usage if a connected-provider playtest is performed.

Acceptance: after a scene, players can explain what changed, their own purpose,
and what their characters know enough about to act on. They may disagree about
the next action. The screen and server agree about location, reachable loot,
active combat and rest. Completing a goal is recognizable, without a prescribed
solution or an automatically extended chain of obligations.

## Implemented behavior and verification

- Stable place IDs and archived place state now govern encounters, loot, search
  exhaustion, environmental sources, rest permission and individual presence.
  Shared transition helpers cover both resolution and compatibility publication.
  Pickup, drops, assistance, healing and combat enforce the acting character's place.
  Combat interpretation and execution include only present characters; independent
  actions elsewhere retain their own checks and receipts. Leaving an ongoing fight
  still requires a rules-engine escape.
- The combat panel hides completed/escaped encounters. Nearby loot is labelled
  with the character's place; split-party positions and historical/current controls
  are distinguished. Carried equipment persists.
- Encounter recovery no longer grants voluntary rest. Accepted scene safety can
  grant or revoke rest; categorical English/Dutch rest claims are checked against
  finalized permission. Existing rest limits remain intact.
- An optional host-edited party goal is available at creation and between turns,
  visible to everyone and frozen into future resolutions. Adjudication, narration
  and review now require observable surroundings, meaningful progress, optional
  NPC requests and completion at its established scope. Requested combat emphasis
  remains intact. Request limits and tools-disabled narration are unchanged.
- Migration 13 reconstructs ownership from saved snapshots/receipts, preserves
  ambiguous items separately and records its correction. The mechaplanet current
  save has no bunker ground loot or stale encounter; three unclaimed items remain
  at Ruïnecontrolepost. Bunker rest is unavailable. Comparing the live save with
  the pre-change audit backup confirms completed turn data, rolls and character
  state are unchanged.
- Focused integration coverage includes return visits without repeated rewards,
  remote pickup rejection, split-party actions, spent environmental sources,
  same-place renaming, destination discoveries, narration retry/restart, safe and
  unsafe rest, goal ownership/locking, migration preservation/idempotence and the
  compatibility publication route. Targeted browser coverage passed 17 tests
  across playtest improvements, equipment, language and turn recovery.

- Final regression: all **600 Vitest tests** passed; `npm run check` and
  `npm run build` passed. No new dependency or model stage was added.

The connected-provider playtest uses isolated in-memory campaigns, supplied
character templates, deterministic dice and the existing `gpt-5.6-sol` selection.
It does not submit actions to mechaplanet.

| Live case | Requests | Observed result |
| --- | ---: | --- |
| Visible exit | 7 | Routine movement succeeds without dice; arrival and a visible return route are clear. |
| Failed search | 5 | The DC 15 check fails; the key remains undiscovered and the compartment locked. The summary retains previously visible routes without recommending one. |
| Alternate approach | 8 | The visible hatch bypasses the previously searched blocked passage without contradicting its failed search. Reaching the bunker fulfills the stated goal; a deeper corridor stays optional. |
| Completed objective | 4 | The authenticated local dossier edit succeeds routinely. The summary recognizes completion specifically in Kernarchief 3, preserves its unsafe-rest hazard and invents no mandatory extra copies. |
| NPC request declined | 9 | The player refuses Mara's relay job and leaves through the established open exit. The job does not become a departure requirement, and no penalty or forced engagement is introduced. |
| Requested combat opening | 7 | Two armed guards start active combat as requested. The reinforced gate and exposed side passage are observable, enemy equipment and initiative are persisted, and rest is unavailable. The first round waits for player submissions. |

All six cases reached publication without errors and passed manual checks of the
saved world events, action outcomes, narration and situation summary. They used
**40 model requests** in total, including adjudication, narration, review and
corrections; there were no live character-generation or faction-generation calls
in these isolated fixtures. These samples demonstrate the intended behavior;
ongoing creative quality remains dependent on campaign context and model output.
