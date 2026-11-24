**Bellweather playtest review — 14 November 2026**

Reviewed the latest local campaign, `normal dnd world`
(`b6bef445-c277-48d7-b3ac-ef102b898f34`), with Brunna Flinttusk,
Sagarius and Aldren Vey. Evidence comes from the opening and seven completed
action turns in `data/gather.sqlite`, stage diagnostics and the corresponding
`data/logs/chatgpt-calls/` records. Turn 8 was collecting when inspected; its
submissions do not establish an outcome. No gameplay source or campaign state
was changed, and this review made no live model requests.

**Aldren's soup: the system already supports alternative approaches.**

There is no fixed soup acquisition recipe. Ordinary social attempts can use
`roll_check` with CHA and no named ability. The saved dice confirm that this
already happened twice:

| Turn | Submitted approach | What actually happened |
| --- | --- | --- |
| 2 | Listen for rumors and order soup | Rumors delivered; innkeeper quoted two copper pennies. Soup was not served. |
| 3 | Offer a blessing instead of money, invoking his fame | CHA DC 10; natural 1 + 2 = 3. Innkeeper refused. |
| 4 | Offer service in exchange | No check. Innkeeper expressed interest but asked Aldren to specify practical work. |
| 5 | Offer to summon a succubus | No check. Innkeeper declined; no creature appeared. |
| 6 | Threaten the innkeeper for soup | CHA DC 15; 2 + 2 = 4. The check failed; recovery supplied no proper NPC response. |
| 7 | Attack the innkeeper | A local encounter started. No attack damage was resolved on this introduction turn, as the current encounter protocol requires. |

This sample does not show a successful persuasion check being ignored. Both
checked soup attempts failed. The weaker behavior is the unproductive bargaining
and the lack of a dependable connection between an action's success label and
the player's actual goal. Turns 4 and 5 are recorded as successful routine
conversations even though Aldren receives no soup. That label describes executing
the interaction, not achieving the broader objective.

The succubus offer does not establish that Aldren can summon one. His saved
abilities are Oathfire Blow and Warden's Vigil. A social check may persuade the
innkeeper to accept an offer or extend goodwill; it cannot grant an unowned
summoning power. An NPC can also simply dislike an offer. Rolls are appropriate
where a feasible outcome is meaningfully uncertain, not for every spoken line.

Three implementation possibilities, in increasing scope:

1. Strengthen the existing GM instructions: recognize attempts to change an
   NPC's decision, choose a fitting check, and honor the checked goal on success.
   This is the smallest change, but compliance remains largely in model prose.
2. Bind a short goal and success condition to the existing check before dice,
   then carry it into resolution and the existing saved scene/NPC/item state.
   For example: goal = obtain one bowl; approach = offer a blessing; success =
   the innkeeper accepts and serves it. A success must realize those agreed
   stakes, rather than substitute another unrelated hint or prerequisite.
   This is the recommended bounded extension. It needs no separate persuasion
   engine or new skill statistic. The current creative-resolution instruction
   also permits "concrete progress" after success; that should not silently
   replace an explicitly attainable promised result.
3. Add a general social subsystem with attitudes, leverage and multiple stages.
   This may help long negotiations later, but this playtest does not justify it.

For turn 4, an independently useful pacing improvement is for the innkeeper to
name a concrete service he would accept. The player still chooses whether to
accept; the GM should not invent a commitment or perform the work for Aldren.
Any outcome promise must remain within established capabilities and scope.

**Turn 6 was a tool-recovery failure, not a provider outage.**

The adjudication stage took 16.0 seconds and three successful HTTP/model responses.
It stopped before producing any complete scene response. The saved diagnostic is:

> Scene recovery after 0 invalid responses; saved outcomes and local observations published without further correction requests.

"0 invalid responses" counts rejected final scenes, not invalid tool calls.
There were three rejected healing calls:

1. The model requested Sagarius's saved Anatomist's Mercy on `new:tavin-reed`
   using the correct `actor:2` alias. The engine rejected it with
   `Use a saved healing ability requested in the player's action.` Aldren's
   independent intimidation check in the same response succeeded as a tool
   operation and saved its failed dice result.
2. The model retried the heal using `Sagarius` for `memberId`. This failed UUID
   validation. The scene prompt says exact unique saved names work, but the
   tool argument adapter only resolves actor aliases here; this wording and
   behavior disagree.
3. The model returned to `actor:2` and retried the original heal. The original
   intent error recurred. After two consecutive tool rounds without a new
   successful operation, the loop stopped and invoked deterministic recovery.

The actual healing submission was:

> I help healing Tavin using Blood magic, with my newly learned skills

`requestsAbility` recognizes a narrow English/Dutch pattern or an exact saved
ability name. This wording matches neither: "using Blood magic" is absent from
its recognized forms, and "with my newly learned skills" contains intervening
adjectives and a plural. `requestedAbility` therefore rejects the model's
otherwise fitting saved spell. The study in earlier turns did not grant a new
spell, but Anatomist's Mercy already existed and is the relevant healing ability.

Recovery then published Aldren's bare failed-check fact, marked Sagarius and
Brunna blocked, and appended local observations. It removed the internal
`processingFailure` markers, turning unresolved technical processing into
apparently final fictional outcomes. The narration stage used that text directly
without another model request.

Sagarius's repeated paragraph has a separate identifiable cause: the consumable
heuristic inferred his Ruby Temple Tonic from the word "healing" and constructed
an additional unresolved minor action. He had requested healing Tavin through
magic, not a self potion. No tonic was actually consumed, and no successful heal
receipt was saved.

Brunna's "Go to the gate folk and confront them" did not match a saved location
name in `submittedTravel`. With no complete model scene or arrival assessment,
the conservative recovery could not establish her first visit and left her at
Watchtower Approach. Merely describing the open stairs did not fulfill her move.

Relevant code:

- [Ability and consumable recognition](../../server/action-resources.ts)
- [Resource authorization](../../server/game.ts) (`useResource`, around line 2381)
- [Scene tool loop](../../server/providers.ts) (around lines 2150–2265)
- [Fallback rewriting](../../server/turn-fallback.ts) (around line 723)
- [Known-route travel recognition](../../server/world-map.ts) (around line 119)

Exact turn 6 model records:

- [First heal and intimidation calls](../../data/logs/chatgpt-calls/cc00fbc9-66bc-4a1c-aadf-3756fdaf2e38.json)
- [Name-based healing retry](../../data/logs/chatgpt-calls/5e5e7692-67a9-4598-83d3-25de8064f6e5.json)
- [Repeated original heal](../../data/logs/chatgpt-calls/b5c0e648-d411-48b6-b266-77118aacd5dc.json)

Recommended prevention, in priority order:

1. Reconcile explicit natural-language use of an owned power with server
   authorization. Preserve the rule against spending charges for ordinary
   actions, but support a fitting explicit request such as this one. Using the
   exact spell name or selecting its card is a current workaround.
2. Resolve unique names consistently with the advertised tool contract, or
   narrow that contract. Preserve meaningful tool errors across retries so a
   UUID correction does not hide the underlying authorization rejection.
3. When a tool loop stalls, stop repeating that invalid operation and give the
   model a bounded opportunity to finish independently resolvable actions using
   saved receipts. If actions remain technically unresolved, retain a retryable
   checkpoint rather than publish them as fictional blocks. Preserve Aldren's
   existing roll and all already-applied costs across that retry.
4. Prevent NPC-directed magical healing from implying a self-consumable minor
   action. Keep unresolved processing distinct from actual refusal, failed dice
   or an established physical obstacle in both saved state and player feedback.

Increasing the request limit alone does not address the authorization mismatch.
Focused regression coverage should use the actual wording, actor-name retry,
another actor's travel, immutable dice and the absence of an invented potion use.
The existing repeated-tool-loop test verifies that the loop stops; it does not
establish that all players' original goals were resolved when it stopped.

**Other findings.**

- A consequential clue is recorded but omitted from the spoken scene. Turn 2's
  selected investigation answer and public journal include the challenge
  "Who keeps the road?" and response "The last traveler." The innkeeper's
  narrated rumor mentions food and water only. The engine constructs the
  durable fact from the full prepared answer, while accepting separately authored
  branch prose that covers only part of it. `investigationNarration` trusts
  `narrativeVersion:1` as complete. The journal therefore grants more knowledge
  than the scene communicates. Keep discovered answer content and narration in
  agreement, rather than assuming prose is complete because it has that version.
- Turn 4 narrates Sagarius leaving the infirmary before it narrates the work he
  completed there. Saved state places the work before departure. This is a prose
  ordering defect rather than a second movement or incorrect final position.
- Turn 2 took 118.8 seconds and six model requests, including four correction
  events: attempts to rewrite prepared answers, an incorrectly typed `blocked`
  field, and a second main-action operation. Turn 3 also tried to rewrite a
  prepared answer. Better model-facing examples and reusing immutable preparation
  can reduce these avoidable correction rounds.
- Sagarius's studying produces lore and shared discovery XP, not a new ability.
  That matches the current progression rules, but his later wording suggests a
  possible expectation gap. It would be a separate design choice to make study
  directly unlock or improve abilities; it is not needed to fix the rejected
  request to use his existing healing spell.
- Split-party positions otherwise remain separate. The inn fight begins locally,
  without dragging the other characters into combat or inventing an immediate
  hit. Brunna's question does not make the underground guards undead: Hester and
  Tavin distinguish observations from the player's assumption. Those boundaries
  worked well.

**Verification.**

Read-only assertions against the real saved drafts and current exported helpers
confirmed: the original healing wording is rejected; an exact Anatomist's Mercy
request is accepted; the original text infers Ruby Temple Tonic; Brunna's gate-folk
wording has no deterministic travel target; and the selected password fact is
absent from the investigation narration. This review did not alter the checks or
reroll outcomes. These observations describe the code at the time of the review.

**Implemented follow-up — 14 November 2026.**

Explicit magic/skill requests now recognize fitting owned abilities without their
exact names, while ordinary attacks and recharge wishes remain ordinary actions.
Unique actor/NPC names resolve consistently in both scene and compatibility tools;
ambiguous names require exact IDs or aliases. Magical healing no longer implies
an extra potion action.

Stalled scene tools get one final response with tools disabled to finish independent
work. Technical omissions retain `processingFailure` and save partial adjudication
for retry. Newly executed receipts are merged with retained facts and movement;
they cannot erase earlier accepted outcomes. Fictional refusals and failed rolls
remain distinct from unfinished processing.

Existing investigation preparation uses `appendDiscoveries` for new answers.
Its selected answer indexes the appended list, so batched independent calls bind
their own additions even when another call appends first. Saved answer indexes
remain immutable. Narration inserts `{{finding}}` and `{{lead}}` templates and
supplies the complete selected finding if prose omitted it. Duplicate main actions
for an already resolved investigation receive specific correction guidance;
`blocked:false` is normalized to the absence of a refusal, while a real refusal
still requires an explanation.

Selected public findings and earned stakes are frozen as required spoken facts
in the resolution, so later prose repair or factual fallback cannot silently omit
them. Fallback narration reserves room for this content within the existing limit.

Social checks can bind `goal:{intent,success}` before dice. The saved consequence
is immutable across retries and becomes authoritative narrative evidence on
success. Scene validation requires that consequence in the action and spoken
text, with `{{success}}` supported as an insertion marker. Failure cannot claim it.
Successful consequences persist in the journal; numerical effects and owned
capabilities still follow their existing engine rules.

The turn 11 fix skips combat records with no visible events. Its regression now
uses the normal participation control to reproduce a player leaving a separate
fight. The recovered turn and original dice remain saved from the earlier repair.

Validation: all 1,549 tests across 68 files passed, as did TypeScript checking and
the production build. Regression coverage includes the actual healing wording,
name ambiguity, batched answer appends, spoken passwords, successful and failed
social stakes, player departure, and retry preserving independent travel, failed
dice, and exactly one later healing use. No live model calls were needed.
