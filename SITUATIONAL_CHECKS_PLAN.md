# Situational advantage and disadvantage

Status: implemented, 9 October 2026. Adjudication and tool guidance now evaluate
favorable/adverse circumstances and record observable causes. Checks now retain
both contextual flags so the server combines them with ability/helper advantage
without relying on the model to pre-cancel. New roll reasons are checked for hidden
faction names/IDs before dice or charges are spent. Narrator/reviewer guidance
accepts contextual reactions grounded in finalized event facts. The server also
freezes each public roll reason in `checkReasons`, keyed by its check event, so
narration retains observable help/hindrance even when the outcome abbreviates it.
These reasons explain pre-roll circumstances; new NPC reactions and outcomes
still require resolved event facts.

## Intended behavior

Before an uncertain action is rolled, the adjudicator considers circumstances
that meaningfully help or hinder that particular attempt. NPC motives and
allegiances, the acting character's recognized relationships or visible symbols,
weather, hazards, witnesses and nearby party members can justify advantage or
disadvantage. Neither direction is automatic: relevance, awareness and actual
presence matter.

The decision and its observable fictional consequences belong to the existing
adjudication request. The server rolls once, freezes the result, and narration
describes the recorded response. Add no LLM stage, prerequisite assessment call,
or additional check just to evaluate circumstances.

For the postmoth example, a visible banner bearing Flo's emblem might encourage
a sympathetic moth to speak. A moth with an established positive connection to
Flo's captors might instead become guarded. The emblem influences willingness;
it does not grant the moth knowledge it lacks or guarantee cooperation.

## Existing support and first implementation scope

- `roll_check` and `checkSchema` accept DC 5/10/15/20 and separate
  `circumstances:{favorable:boolean,adverse:boolean}` for new checks. Legacy
  checks retain `mode: normal | advantage | disadvantage` without circumstances.
- `turnContext()` supplies character details, actual equipment, individual
  faction relationships, the private faction registry, public journal, local
  scene and factual history.
- `Game.roll()` derives the final mode from context, utility abilities and
  successful checked assistance, then applies saved bonuses. Retries reuse
  immutable checks.
- Action/component `reason`, event `fact`, journal updates and narration
  passages already provide the storage needed for public explanations and
  reactions. The UI already shows the roll's explanation and final mode.

The first implementation covers noncombat `roll_check`, including relevant
utility checks and uncertain assistance. Keep the existing combat rules:
`CombatInput` has no general situational roll-mode field. Extending ordinary
combat attacks would require a separate mechanical change. A current combat
check's supported DC can still reflect its fiction.

Reuse existing persistence with the optional circumstances field. No database
migration, modifier registry, numeric situational bonus or new UI is needed.

## Rules for choosing circumstances

1. **Ground the cause.** Use established NPC characterization, campaign lore,
   journal/history, faction context and actual scene/character state. For a new
   NPC, establish a coherent observable characterization during introduction
   and preserve it when it continues to matter. Do not invent a secret allegiance,
   a storm, a witness or an obstacle solely to justify changing this roll.
2. **Check relevance and awareness.** Explain how the circumstance affects this
   action. A banner can matter when visible and recognized; carried equipment
   does not imply active presentation or magical credentials. An NPC's faction
   connection does not mean it recognizes every member, emblem or private deed.
   Reputation is individual; do not average the party's scores or treat every
   NPC as sharing a faction's position.
3. **Use local circumstances.** Check the actor's actual place and feasible
   proximity. Another room's hazard or a separated companion cannot affect the
   attempt without an established way to do so. A nearby character's presence
   can affect trust, privacy or intimidation without inventing their speech,
   assistance, decisions or feelings. Mere party membership grants no benefit.
4. **Allow both directions and neutrality.** Helpful circumstances can grant
   advantage, adverse circumstances can impose disadvantage, and irrelevant or
   insufficient evidence leaves the mode normal. Do not force a modifier into
   every turn. Weather that hinders one task might help another.
5. **Keep the action and capabilities intact.** Advantage does not supply new
   powers, information, access or extra actions. Disadvantage does not create
   arbitrary blockers, damage or automatic failure. Supported routine acts still
   need no roll; impossible acts cannot be made possible by rolling well.
6. **Avoid counting a cause twice.** Choose the base DC for the underlying task;
   use mode for situational help or hindrance. Do not raise DC and impose
   disadvantage for the same hostile allegiance, or lower DC and grant advantage
   for the same banner. An independently guarded secret can have a harder base
   DC as well as an independently adverse circumstance. Preserve saved equipment,
   condition and ability effects without recreating them as contextual modifiers.

Favor situational mode when the task remains the same. A DC change is appropriate
when the circumstances actually change the task's underlying difficulty; record
that distinction and use only the existing DC values.

Ordinary uncertainty, such as persuading someone to disclose confidential postal
records, belongs to the base DC. It does not automatically add disadvantage.
An established hostile allegiance or an additional listening guard can hinder
that attempt independently.

## Combining circumstances with saved mechanics

Use nonstacking advantage/disadvantage: multiple favorable causes do not grant
extra dice; multiple adverse causes do not grant extra dice. At least one cause
on each side cancels to normal. Do not count causes or let several advantages
outvote one disadvantage.

For a new check the adjudicator reports favorable/adverse context independently
and sends `mode:normal`. The server combines those flags with advantage from an
executed utility assist ability or earlier successful checked assistance:

| Contextual flags | Server-granted advantage | Final mode |
| --- | --- | --- |
| Neither | No | normal |
| Favorable only | No | advantage |
| Adverse only | No | disadvantage |
| Favorable and adverse | No | normal |
| Neither or favorable only | Yes | advantage |
| Any adverse flag, including alongside favorable | Yes | normal |

Never pre-cancel contextual flags or include engine-granted advantage in them.
Mixed context therefore stays normal with any amount of extra advantage.
Resolve uncertain helpers before the dependent check, as already required;
anticipated help is not a successful receipt. Routine help belongs to favorable
context. Saved legacy checks use `circumstances:null` and their original input
mode. Both flags are immutable alongside all other saved check parameters.

Keep the input parameters and returned final mode distinct in explanations.
After rolling, the returned receipt is authoritative, even when it reports
normal after cancelling an adverse circumstance.

## Recording causes, narration and secrecy

Before rolling, `roll_check.reason` briefly describes the feasible attempt and
its relevant observable circumstances, without predicting success. After the
receipt, record the NPC's actual reaction and the resulting action/world fact.
Both matter: current engine check events are generic success/failure facts, so a
roll explanation alone is insufficient grounding for the narrator to establish
a particular response.

For example, a successful favorable interaction could record that the moth
recognizes Flo's emblem, softens its tone and shares the established postal
trail. An adverse interaction could record that it grows guarded at the emblem;
a successful disadvantaged roll can still yield the information despite that
resistance. A failure preserves the failed main action and records only its
actual established consequences.

Preserve continuing public NPC attitudes or scene conditions in existing NPC,
fact or location journal entries, using stable names. Reuse those facts on later
turns instead of changing motives to match the dice. Retry and narration must
reuse the saved check's DC, input mode, dice, result and public reason. Before
adjudication is accepted, a retry may still complete unresolved fictional
consequences, grounded in that saved explanation. Once adjudication/resolution
is accepted, its recorded reactions and causes are frozen too.

Private world context may explain an NPC's behavior without revealing its
secret. Roll reasons, action reasons, event facts, journal and debug information
that reaches players must contain only public knowledge or observable behavior.
For example, write "the moth becomes guarded at the emblem," rather than
disclosing an unrevealed allegiance to Flo's captors. The narrator and reviewer
continue receiving only public frozen resolution facts.

There is currently no separate private NPC motive store. Reuse existing private
faction context and established NPC lore; a faction's agenda alone does not prove
that a particular moth belongs to it. Persisting newly authored secret motives
for individual NPCs is a separate feature, rather than concealing them in public
journal or roll fields.

Keep narration fidelity strict. Explicitly allow a recorded contextual reaction
and cause; continue rejecting a banner-induced response invented only in prose.
Narration cannot add a modifier, change a locked DC/mode or turn failure into
success.

## Implementation sequence

1. **Add a compact situational-check contract in `server/providers.ts`.** Apply
   it to separated adjudication and update `roll_check`'s mode/reason descriptions.
   Reconcile the existing setting/faction rules: circumstances can select an
   existing DC/mode, while lore still cannot invent numeric bonuses or effects.
   Include pre-roll grounding, favorable/adverse evaluation, locality,
   nonstacking cancellation, public explanations and post-roll reaction facts.
   Keep the contract concise and reuse existing context instead of duplicating it.
2. **Close the roll-reason secrecy gap in `server/game.ts`.** Reuse
   `assertPublicFactionText` for a new roll reason before drawing dice or spending
   an ability charge; current adjudication
   guards run after tools and do not prevent an undiscovered faction name from
   appearing directly in a player-visible receipt. Use unnamed observable
   reactions until a faction discovery is finalized. This guard catches names
   and IDs; semantic secrecy still depends on the provider contract.
3. **Clarify narrator/reviewer grounding in `server/providers.ts`.** Recorded
   contextual reactions and causes may be narrated. Equipment flavor alone is
   insufficient. Preserve current tools-disabled review and request budgets.
4. **Add focused checks and update the gameplay documentation.** Extend existing
   engine/provider/faction tests rather than introducing a new subsystem. Record
   the rule in `GAMEPLAYLOOPPROMPT.md` and the relevant faction gameplay guidance.
   Leave existing completed and in-progress locked rolls unchanged.

## Validation and acceptance

| Scenario | Required behavior |
| --- | --- |
| Sympathetic postmoth recognizes Flo's visible emblem | Advantage or justified easier task; recorded recognition and response; no guaranteed clue |
| Postmoth has an established tie to Flo's captors | Relevant disadvantage or justified harder task; guarded behavior; no invented allegiance |
| An unrelated emblem or unrecognized reputation | Normal; no automatic credentials or faction response |
| Wind/noise interferes with a local inquiry; darkness aids hiding | Task-specific adverse/favorable mode, using established weather/light |
| An established witness inhibits disclosure | Disadvantage when relevant; no invented witness or unsubmitted party action |
| A trusted recognized companion is present, then is elsewhere | Benefit only when awareness and actual presence support it |
| Favorable and adverse context, with/without ability or checked help | Final normal; no stacking and no accidental restoration of advantage |
| Different party members have different reputations | Evaluate the actual speaker and recognized companions separately |
| Failed adverse roll and successful adverse roll | Preserve failure/success and the recorded resistance in both cases |
| Hidden allegiance explains resistance | Public explanation describes observable behavior; rejected secret faction names create no roll or resource change |
| Retry or narration correction | Same dice/DC/mode/reason; accepted reaction facts stay frozen; no retroactive adjustment |

Use deterministic dice for engine checks, capturing/fake provider responses for
request/receipt/grounding coverage, and existing narration/recovery tests for
frozen outcomes. Verify that favorable/adverse cases use the same ordinary
check/tool continuation and narration/review request counts: no new assessment
request. Mocked responses verify plumbing and contracts, not the live model's
judgment. Ordinary playtesting must assess whether its reasons are plausible,
balanced and consistent; do not add a paid evaluator stage to gameplay.

Run focused game, turn-resolution, provider and faction tests, then TypeScript
and the production build. Inspect the final diff for accidental unrelated
changes. The implementation is accepted when both favorable and adverse context
reach the existing roll mechanics, public reasons and reactions remain faithful,
and request/checkpoint behavior is preserved.

## Implementation verification

The five focused game, turn-resolution, provider, faction and playtest-followup
suites passed: **287 tests**. Added scenarios exercise favorable failures,
adverse successes/failures, normal mode, causal reactions through narration and
the existing four-request flow. Guard checks cover hidden names/IDs, rejection
before dice/charges, public explanations and immutable retries. Existing helper
and utility cancellation checks now also cover nonstacking contextual advantage.
TypeScript, the production build, formatting and diff whitespace checks passed.

The compacted adjudication instructions add approximately 1,100 characters to
the previous fixed prompt; its regression ceiling is now 32,000 characters.
The initial implementation left request budgets, schemas and persistence
unchanged. Provider responses were mocked; plausibility and consistency of live
NPC decisions still need ordinary playtesting.

## Review follow-up

The helper guidance now names member IDs, matching `assistedBy`. New checks
report both contextual flags; the server owns cancellation with ability and
checked-help advantage. Sixteen engine cases cover all four contextual states
with neither source, an ability, a helper and both. Each case verifies immutable
replays and rejects changed/removed flags without drawing more dice. Existing
legacy-mode cases remain covered.

Run the repeatable model playtest with:

```sh
node --import tsx scripts/playtest-situational-checks.ts
node --import tsx scripts/playtest-situational-checks.ts --live --model gpt-6-luna --output /tmp/situational-checks.json
```

The first command previews the cases. `--live` uses the connected account and
the normal adjudication, narration and review pipeline in isolated in-memory
campaigns. Cases cover a sympathetic moth, a hostile moth, opposing circumstances
with an ability, and irrelevant/distant factors. `--case <name>` selects one.
Reports include the model's chosen circumstances, authoritative roll, action
facts, narration and stage diagnostics for manual inspection. No requests are
added to ordinary gameplay, and no current campaign is changed.

Live verification on 9 October 2026 used `gpt-6-luna`. The initial friendly case
mistakenly counted ordinary confidentiality as adverse context; the prompt now
separates base difficulty from additional resistance. The distant case initially
retried an unrequested ability and hit the existing stream limit; the tool
description now distinguishes ordinary actions from requests to use a power.
No ability-selection guard or stream limit was relaxed.

After those corrections, the observed cases were:

| Case | Context flags (favorable / adverse) | Final mode | Outcome |
| --- | --- | --- | --- |
| Friendly moth | true / false | advantage | Failed; sympathy did not guarantee disclosure |
| Hostile moth | false / true | disadvantage | Failed; moth remained guarded |
| Friendly moth, listening guard and ability | true / true | normal | Succeeded despite resistance |
| Unrecognized banner and distant guard/weather | false / false | normal | Failed; irrelevant factors gave no modifier |

All four produced reviewed story narration without the factual fallback. The
existing schema-correction path was used before accepting their adjudications;
these observations validate the selected circumstances, not first-response
formatting reliability or every future model decision. The full automated suite
passed **681 tests**, and TypeScript plus the production build passed. The live
playtest script also passed a separate strict TypeScript check.

Kraterwereld follow-up, 9 October 2026: turn 5 exposed a gap between public roll
reasons and frozen narration facts, plus a discarded story after an empty-ID
ending and a repeated closing. Reasons now travel with the resolution; trailing
scene-setting is reviewed as closing, and closing/style defects do not discard
faithful event passages. The fallback covers the saved outcomes once while
retaining every event ID and partial-action failures. A narration-only test of
the actual saved turn with `gpt-6-luna` produced 205 words, including rain and
visibility affecting failed and successful checks, and passed review within the
existing four-request limit. Gameplay and published history were unchanged.
