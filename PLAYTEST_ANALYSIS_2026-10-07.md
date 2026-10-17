# Lava planet playthrough analysis — 7 October 2026

The turn pipeline is completing reliably and the prose gives clearer observable routes, but the adventure is spending too long on incremental travel. More seriously, the new location system does not represent the separation that the story establishes: both characters remain mechanically in one place throughout. This undermines local loot access and split-party presentation despite the new helpers working as designed.

## Evidence and scope

Read-only review of `data/gather.sqlite`, backed up through SQLite into `/tmp/gather-latest-session-audit.sqlite` for a consistent snapshot. Campaign **Lava planet**, ID `3a28cd6a-8bd6-43f7-a0da-477c9c2293e7`, was the latest campaign with recorded gameplay activity. It uses `gpt-5.6-sol`, Dutch output, a dying-sun/lava-world setting, and the premise “We are escaped prisoners.” There is no chosen party goal or instruction requiring combat.

Reviewed opening **0**, player turns **1–11**, all **22 submissions and structured outcomes**, **six check receipts**, stage diagnostics, published narration, public journal, faction initialization, equipment events and saved state. Published scenes span **01:40:25–02:26:57 Europe/Amsterdam on 7 October**. Turn 12 was collecting with no submissions in the snapshot; this is an ongoing session.

The source references describe the current working tree, which contains substantial existing uncommitted changes. No recorded build identifier proves exact correspondence with the running server. Rejected model responses are not saved in full; diagnostic feedback establishes rejection reasons, not every detail of the rejected candidate.

No live campaign state, source code, credential or provider connection was changed. No provider request or gameplay retry was made. A read-only Node check loaded the snapshot and called the existing `memberScene` helper to verify which ground loot each character receives. A follow-up check called `takeItem` on independent clones of turn 7's character and scene state to distinguish item restrictions from UI/action locks. No test suite was run. This report is the only repository file added by the audit.

## Session record

Processing sums recorded stage durations and excludes time spent thinking, submitting actions and using equipment controls. Requests include tool continuations and review, rather than counting only prose generations.

| Turn | Result | XP each | Processing | Requests |
| --- | --- | ---: | ---: | ---: |
| 0 | Faction ties introduced; Breukschacht offers a basalt path, lava tube and maintenance hatch | 0 | 2m 03s | 6 |
| 1 | Characters follow different routes, remaining within sight and hearing | 0 | 1m 10s | 3 |
| 2 | Both reach the cool-air junction and identify an upward route | 10 | 1m 08s | 3 |
| 3 | Routes separate beyond sight/hearing: upper cool cave and downstream basalt arch | 10 | 1m 09s | 3 |
| 4 | More travel to an upper landing and downstream gallery | 0 | 59s | 3 |
| 5 | Ferrum-9 reaches another plateau; Lava man's backflip fails and his intended movement is lost | 0 | 2m 42s | 5 |
| 6 | Lava man reaches the pipe chamber; Ferrum-9 reaches a river fork | 0 | 50s | 3 |
| 7 | Lava man finds the wrench and pipe markings; Ferrum-9 reaches the lava basin | 15 | 1m 31s | 5 |
| 8 | Further search fails; Ferrum-9 approaches the drain grille | 0 | 59s | 4 |
| 9 | Grille bends but remains closed; Lava man's request for help receives no answer | 0 | 1m 06s | 4 |
| 10 | Both leave the exposed lava area through separate branches of the maintenance network | 0 | 1m 26s | 4 |
| 11 | Lava man finds a route plan; Ferrum-9 reaches the external cooling chamber | 15 | 1m 42s | 5 |

Both characters finish at **level 1, 50 XP**, full HP (**24/24** and **26/26**), with no conditions. No combat started, no ability charge was spent, and no encounter completed. The six checks split evenly between success and failure. Aggregate action outcomes are **18 successes, three failures and one blocked action**; 15 successes are routine acts without dice.

## Findings

### 1. Story separation never becomes mechanical separation — confirmed, highest priority

Starting in turn 3, the story explicitly states that Lava man and Ferrum-9 cannot see or hear each other. By turn 11, Lava man is in the upper maintenance passage and Ferrum-9 is in an external cooling chamber, with different surroundings and accessible objects.

Every completed turn nevertheless retains the same location ID, `ef82e492-01e7-442d-a30b-cfef9915176a`, named Breukschacht. The final `scene.places` is `{}`, both entries in `scene.memberLocations` point to that ID, and every resolution's `knownLocations` contains only Breukschacht.

This has concrete consequences:

- `WorldStatus` detects a party split by comparing location IDs, so its new split label and individual position display cannot activate for this save. See `src/main.tsx:1360`.
- The route plan is described as lying behind a panel in Lava man's upper passage. The read-only `memberScene` check returns that plan in the ground-loot projection for **both characters**, including Ferrum-9 in the cooling chamber. Equipment handling uses this same projection before taking an item. This alone does not establish that either player's pickup button was enabled. See `shared/locations.ts:30` and `server/game.ts:2457`.
- The new locality guard therefore cannot distinguish remote objects in these narratively separated areas. No actual remote pickup is recorded; the confirmed issue is that the saved state exposes the same ground objects to both location projections. Independent action/UI locks can still prevent pickup.
- A single rest permission and hazard description cover both branches, even when one character is far from the other's threat.

The helpers faithfully use IDs. The failure is earlier: adjudication keeps treating all these rooms as descriptive subareas of one mechanically shared place.

**Follow-up from the players:** Ferrum-9 saw the Drukregelaarssleutel as unavailable, while Lava man could collect it. The initial chat summary overstated projection access as pickup access. The UI disables `Take item` when either the item's `takeReason` or the player's general `lockReason` is set. A player who has already submitted an action is locked independently of another player who has not submitted; processing also locks equipment. See `src/EquipmentPanel.tsx:250`, `src/main.tsx:1709` and `server/game.ts:2455`. On clones of the saved turn-7 state, `takeItem` permits the wrench pickup for both characters, each with one of eight backpack slots occupied. Thus capacity and saved item restrictions do not explain the difference in that checkpoint. An individual submission lock is a plausible explanation, but submission timestamps, disabled-button state and rejected pickup attempts are not recorded, so the exact cause observed by Ferrum-9 cannot be established from this save. The player's observation confirms an unavailable control, not which guard caused it.

There is also a contract limitation: adjudication has one `location` update and position entries referring to current, destination or already established IDs. It cannot describe two independently new destinations in the same turn. This is relevant when two players take different unexplored branches. See `shared/turn-resolution.ts:53` and `server/turn-resolution.ts:304`.

**Recommended change:** make the place boundary explicit where shared access stops being plausible, and support registering the distinct destinations required by a split turn. Keep the existing place registry and projection helpers. Require narration, member positions and loot ownership to agree; retaining a broad regional name must not imply every object in that region is reachable.

### 2. Exploration supplies orientation but progresses in very small steps — observed design concern

The new clarity instructions are visible in play. The opening establishes three concrete features, and arrivals usually name routes, obstacles and surroundings. Turn 11 finally gives a map showing where the branches meet and a service exit. Players have more actionable information than a generic atmospheric paragraph.

However, most movement turns replace one passage with another passage: cool cave, landing, dry tunnel, pipe chamber, maintenance passage; or arch, gallery, plateau, fork, basin, grille, drain shaft. Eleven player turns occupy roughly **46½ minutes of elapsed time** from the opening publication, while the escape remains unfinished. Progress exists, but many transitions feel interchangeable rather than like distinct developments.

The party chose to split and continue exploring; this is not evidence that exploration itself is wrong. Nor does the campaign demand a fight. The concern is how little each resolved travel turn advances understanding, the escape or contact with the wider world.

**Recommended change:** let straightforward travel cover a meaningful stretch of an established route. Spend turns where a consequential obstacle, discovery, encounter or decision actually occurs. Recognize arriving somewhere significant instead of extending the route by another similar corridor. Avoid enforcing a fixed combat quota or guaranteeing a safe endpoint.

### 3. “What should I do?” becomes a dead turn — confirmed behavior, intent ambiguity

In turn 9, Lava man submits **“Wat moet ik doen?”** The engine records a blocked action: he asks aloud in the empty pipe chamber, nobody is within hearing range, and no information or main action results. The narrator faithfully describes the question echoing without an answer.

The submission could be in-character speech, but it could also be the player asking the GM for orientation. The saved response chooses the former without addressing the latter. After numerous travel turns, this is a useful signal that visible routes alone have not given the player enough purpose or context. It does not prove the player's subjective experience, but it is the clearest recorded request for help.

The player already knows about the pipe system and central pressure distributor. Those facts could be restated without inventing a listener, revealing secrets or choosing an action for the player.

**Recommended change:** distinguish requests to the GM from attempted dialogue. Answer orientation questions with established surroundings, known progress and unresolved uncertainty. Preserve player choice; factual help does not require an action recommendation or a blocked roleplay turn.

### 4. Compound intent is reordered and collapsed — confirmed

Turn 5's submission is: **“Volg de droge tunnel verder de duisternis in, doe daarna een backflip en kill elke enemy.”** It orders movement before the backflip. No enemy is established, so the last part cannot produce an automatic kill.

The server records a DEX check, **7 + 2 = 9 against DC 10**, for travel/stunt uncertainty. Accepted adjudication then puts the backflip at the tunnel entrance and keeps Lava man on his original landing. Narration says he does not reach the tunnel. The ordinary travel that succeeded in adjacent turns has become conditional on the failed stunt, and the submitted sequence is reversed.

The location validation rejected a prior candidate with **“A location change requires that character’s successful submitted movement.”** The accepted main component is a failure, with no separately represented completed movement. Rejected text is unavailable, so the audit cannot establish exactly how the first candidate ordered its events.

**Recommended change:** preserve feasible execution order and distinguish routine movement, a risky embellishment and an unavailable target within the action economy. A failed stunt should not automatically erase earlier routine movement. If the check truly governs traversing the route, establish that causal dependency explicitly rather than moving the stunt to the beginning after failure.

### 5. Opening placement conflicts with location validation — confirmed code mismatch

The prompt says opening placement includes the party. `validateAdjudication`, however, requires every `memberLocations` entry to have a matching action with a successful or partial main component, without an opening-turn exception. Turn 0 has no submitted actions. See `server/providers.ts:922` and `server/turn-resolution.ts:336`.

The opening records that exact location-validation rejection and uses a second adjudication request. Its accepted output has `memberLocations:[]`; server initialization ultimately supplies the shared starting location. The completed opening is coherent, but the model is being told to return data the validator cannot accept.

**Recommended change:** reconcile the opening contract and validator. Initial placement should not require a player action; later movement should preserve the intended checks.

### 6. Journal ownership facts lag behind equipment controls — confirmed

After turn 7 discovers the wrench, Lava man takes it, drops it, then takes it again between **02:12:58 and 02:13:30**. All three equipment events are recorded and appended to turn 8's situation. His final inventory contains the wrench.

The public journal still says it lies in the old pipe chamber's maintenance cabinet and **“de sleutel is nog niet meegenomen.”** By turn 11 Lava man has moved onward, so that entry is materially wrong. No duplicate wrench or failed inventory update is evident; the contradiction is in public memory.

Equipment actions save inventory, ground loot and equipment events; journal publication separately upserts only entries supplied by adjudication. See `server/game.ts:2577`, `server/game.ts:2628` and `server/game.ts:2234`.

**Recommended change:** present current ownership from authoritative item state, or explicitly reconcile mutable item-location claims after equipment controls. Historical discovery facts can remain, but “still uncollected” must not remain a current fact after pickup.

### 7. Safety warnings repeat despite the new summary instruction — confirmed presentation issue

Every one of the 12 situation summaries repeats that safe rest is unavailable. From turn 3 onward they also repeatedly state that the characters cannot see or hear each other. These are useful facts initially, but repeated unchanged warnings dominate the closing even after discoveries and successful movement.

The current `situationClarity` prompt explicitly says to omit repeated safety warnings (`server/providers.ts:924`). The summaries do not follow that instruction. The rest boolean itself is consistently false, and the saved prose agrees with it; this session does **not** reproduce the earlier permission/narration contradiction.

There is no recorded HP loss, condition or urgent interruption from the many described heat shocks and pressure pulses. Both characters are Burning-immune, which does not establish immunity to every environmental danger. This supports a pacing observation, not a claim that damage should have been applied: hazards remain mostly background description in this sample.

**Recommended change:** prioritize changed facts and achievements in the summary. Keep persistent safety in the current-location display; mention it in prose when relevant or changed. Make any developing threat concrete through supported world events, without adding arbitrary penalties.

### 8. Faction initialization works; faction gameplay remains untested

Three distinct factions are generated, and the opening reveals two through established connections. Lava man's explicit former membership produces hostile reputation **−2**. Ferrum-9 receives a generated contact with friendly reputation **+2**. Affiliation and reputation are separately saved, and the public journal contains the known descriptions rather than private agendas. The placeholder `Practice faction` names in `factionSeed` are generation scaffolding; the saved world contains generated final names, so this is not evidence of a practice fallback.

No later turn records a faction effect or reputation change. All three faction activity timestamps remain at turn 0. No faction-linked NPC, report or observable pursuit enters the subsequent reviewed scenes, despite the opening establishing relevant ties.

That is not a mechanical reputation failure: no witnessed faction-relevant deed in this sample requires one. It does mean this playtest exercises **generation and starting relationships**, but does not yet validate changing reputation, discovery through play, affiliation changes or evolving faction activity. The ties currently give context without materially changing the escape scenes.

**Recommended change:** allow relevant existing faction context to shape observable developments when the fiction supports them. Verify reputation with an actual attributable consequential deed; do not award it for routine travel just to make the panel change. Private and undiscovered faction details are deliberately not reproduced in this report.

## Reliability and timing

All 12 scenes complete on processing attempt 1, with **no recorded stage failures, factual narration fallback or narration correction**. Each narration stage uses exactly two requests: generation and review. Both prior XP-omission and repeated narration-correction symptoms are absent here, including the four exploration reward turns. Combat victory narration has not been exercised, so its previous fault cannot be declared fixed from this session alone.

| Stage | Recorded processing | Requests |
| --- | ---: | ---: |
| Faction initialization | 44.2s | 2 |
| Adjudication | 11m 28.8s | 22 |
| Narration and review | 4m 32.4s | 24 |
| Finalization and publication | 0.123s | 0 |
| **Total** | **16m 45.5s** | **48** |

Player turns average **1m 20.2s**, median **1m 09.1s**. The slowest is turn 5 at **2m 41.9s**, including the location correction. The previous mechaplanet audit reported a **1m 52s** average; this sample is faster, but mostly routine exploration is not a controlled comparison with that combat-heavy session.

Adjudication remains the largest time cost. Even simple travel turns use roughly a minute including narration/review. Request input totals approximately **2.23 MB**, output **0.32 MB**; these are repeated serialized payload bytes, not token counts or prices. The first adjudication request's input grows from approximately **59.7 KB** at opening to **91.2 KB** at turn 11. This does not isolate why the model is slow, but removing contradictory corrections and overly granular travel would reduce observed waiting.

## Recommended priority

1. Make mechanically distinct places match established story separation, including the two-new-destinations case. Recheck split display and remote-loot access using this save.
2. Reconcile opening placement validation and preserve compound-action execution order.
3. Reconcile current journal ownership with equipment state.
4. Improve exploration pacing and answer player orientation questions using established facts; suppress unchanged summary warnings.
5. Continue playtesting through a genuine location transition/return, faction interaction and combat encounter. This session does not yet establish those features' correctness in live play.

## Follow-up: turns 12–14, reviewed after the players continued

Separate read-only snapshot: `/tmp/gather-lava-followup-audit.sqlite`. The new completed turns were published at **02:33:14, 02:44:46 and 02:53:08 Europe/Amsterdam on 7 October**. Turn 15 was collecting with no submissions. The earlier audit sections retain their original turn-11 scope. No live state or source code was changed for this follow-up.

### What the new actions actually accomplished

- **Turn 12:** Lava man explicitly uses the collected Afvoerplan to find the service exit. Ferrum-9 follows. Both succeed routinely, reunite, leave the dangerous pressure/drain network and reach a safe gallery. Each receives 10 XP, reaching 60 XP. The journal now records the map as carried and used. This is real progress, and the map has served a concrete purpose.
- **Turn 13:** Ferrum-9 continues through the cool passage; Lava man follows. Both succeed routinely and arrive in an abandoned condenser hall. The arrival offers another basalt arch and a closed inspection platform, but no person, active threat or consequential discovery.
- **Turn 14:** Both open the inspection platform successfully without a check. The revealed space is a raised workfloor with an unlit control panel and a view of the same hall/routes. Its control function, reason for being unlit and potential significance are not established.

All **six new actions succeed**. There is no recorded failed roll, blocked movement or item-use refusal explaining the stalled feeling. Across player turns 1–14, **24 of 28 actions succeed**, three fail and one is blocked. There is still no combat, no public NPC journal entry and no adjudicated faction effect. The players have followed visible routes and opened the offered feature; this is not evidence that they played incorrectly or needed a special prompt to unlock the adventure.

### Why the items feel inconsequential

The map's use in turn 12 is authoritative: its route information enables routine travel to the service exit and reunion. It is not mechanically useless, although the resulting destination offers little new purpose beyond safety and another passage.

The wrench has a described purpose—operating the old pressure regulators/valves—but no reviewed turn establishes a concrete regulator problem, recognizable compatible mechanism or consequence that would make using it matter. The latest platform reveals an unlit panel, without connecting that panel to the wrench. No wrench use is recorded.

Both items are `kind:tool`: portable story objects, without automatic numerical bonuses or an engine-scripted puzzle effect. The model must recognize a relevant use from established scene facts and the submitted intent. See `shared/rules.ts:993` and `server/providers.ts:1203`. This is a legitimate free-form design, but an item description alone does not create a meaningful interaction. The world must establish the matching situation. It should not require the player to invent an unexplained broken regulator merely to make the reward useful.

The stale wrench journal claim remains present despite its actual inventory ownership. That inconsistency adds ambiguity, but it does not establish that the model rejected wrench use; the players have not submitted such use in the reviewed turns.

### Why there is no visible Siege pursuit

The GM still receives the pursuit information. Each new turn's frozen context contains Lava man's background saying his former masters pursue him, his motivation to shake off the Siege-factie, his hostile starting relationship and the full faction registry. `turnContext` includes character context and factions in each adjudication input (`server/providers.ts:958`). This is not evidence of context truncation or the character background being absent.

Faction state stores agendas and activities, but those descriptions do not autonomously create pursuers. Activity changes require model-authored supported effects; the application has no automatic pursuit scheduler. Every reviewed adjudication returns `factionEffects:[]`, and all faction activity timestamps remain at opening turn 0. The GM may establish observable consequences through ordinary world events as well, so an empty effect list alone is not proof of no pursuit. The reviewed world events and prose also establish no subsequent pursuit signs.

The faction contract says to consider factions without forcing introductions or progressing every agenda (`server/providers.ts:1029`). That does not prohibit a coherent pursuit. It also means an established hostile relationship does not mechanically guarantee a patrol appears. There is no later finding that the Siege faction lost the trail, abandoned its search or was definitively evaded. The correct conclusion is **the ongoing pursuit has not been made observable or developed**, not that the characters proved nobody is chasing them.

A quiet, safe room can be coherent during an escape. It does not by itself establish that the larger pursuit ended. Across this many arrivals, however, the absence of pursuit evidence or an explanation leaves an established premise dormant.

### The failure is in world development during adjudication

The observed pattern is locally correct but dramatically thin: the GM resolves movement, establishes another empty industrial space, lists its routes and confirms safety. It can do this indefinitely while each individual action succeeds. The reference already asks for meaningful noncombat situations; its presence in the prompt has not ensured that behavior.

My interpretation is that the model is behaving mainly as a reactive action resolver. The contracts strongly constrain invented mechanics, unsubmitted player choices, extra obstacles and narration fidelity. They permit NPC/world developments, but those positive responsibilities are not adequately demonstrated or enforced in the actual generated turns. This is an inference from instructions and output; the model's internal reasoning is unavailable.

Only adjudication can establish clues, NPC decisions, world consequences and encounters. Narration and review operate on the finalized resolution alone (`server/providers.ts:1204` and `server/providers.ts:1354`). Once adjudication saves an empty room, the narrator cannot repair it by adding a pursuer or significant panel function. Fidelity review can approve a faithful empty scene without establishing that the adventure advances or pays attention to an unresolved background thread.

Turn 12 also reuses the original location ID for the named safe gallery; turn 13 reuses it again for the condenser hall. The earlier location-boundary fault therefore continues. Both turns initially fail schema validation because position IDs are null; accepted outputs use the original ID. Rejected full candidates are unavailable, so these corrections cannot establish why the model ultimately retained that place identity. The location fault matters for persistent state, but it is not sufficient to explain the absence of people or pursuit.

### What this adds to the improvement plan

Orientation and shorter travel remain useful, but more room description alone will not solve this. Adjudication needs to maintain relevant unresolved world threads and turn them into concrete, observable situations when the fiction warrants it. That can be an NPC with an understandable concern, a recognizable mechanism with a visible function, useful evidence, a supported pursuit development or a meaningful consequence of the players' arrival. These are examples of GM behavior, not claims about hidden content in this save or prescribed player actions.

Recognize achieved scope—such as reunion and leaving the pressure network—then provide a legible situation beyond it. Keep player choices free, preserve quiet scenes where appropriate and avoid a quota of compulsory fights or puzzles. An empty party-goal field must not disable the campaign premise or character motivations. Useful tool discoveries should connect to established affordances, and the GM should not wait for a player to explicitly request that the world act.

The written improvement plan has not been implemented; these turns still exercise the existing behavior. Its orientation, pacing, item-purpose and faction workstreams should be assessed together against this specific regression: successful travel/opening actions must not continually yield interchangeable empty spaces while the declared pursuit and useful-tool promises remain undeveloped.
