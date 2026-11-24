**Cyberworld playtest — Neon Veil, 13 November 2026**

Completed the revised request: five group turns with three simulated players, for 15 submitted player actions. The opening is turn 0 and is excluded from that count. Turn 6 is collecting with no submitted actions; play stopped there.

The game produced a coherent investigation, meaningful witnesses and a useful split-party situation. Reliability and pacing were the main problems: two rounds published through fallback, ordinary travel was lost during one recovery, and another round needed a manual retry. The central mystery remains unresolved after five turns.

**How the test ran**

The playtest used the current workspace's actual `Game` engine and live `ChatGPTGM`, with `gpt-6.1-sol` from the connected account. Character generation, factions, starting stories, checks, scene validation, recovery, rewards and publication ran through the existing application code. Dice used the normal local OS cryptographic randomness, with no fixed outcomes or substituted practice responses.

The campaign ran in a new, separate SQLite database at `data/playtests/cyberworld-2026-11-13/gather.sqlite`. Existing campaigns and gameplay source files were not changed. I controlled all three players, choosing their next actions from the published scenes and their own starting rumors. This was an engine-level playtest; it did not exercise the browser, phones, invite UI or three independent human decision-makers.

The source commit was `a5bbf87`, with the existing uncommitted workspace changes present. Recorded turn-stage build ID: `47cbf01f0b5b3a26`.

**The world and party**

Neon Veil is a rain-soaked cyberpunk city where Meridian Ledger Services controls the credentials needed for shelter and medicine. At Lantern Market, courier Nessa Vale arrived with a damaged R-17 data shard. She said a dawn reconciliation batch would classify living residents as duplicates and revoke their permissions. Porter Ivo Sen had two contradictory gate receipts. The clinic and corporate service gate were visible, reachable leads.

| Character | Role and strengths | Selected abilities | Starting equipment |
| --- | --- | --- | --- |
| Patch | Former corporate diagnostic technician; INT 11, DEX 9, physically weak | Trauma Reset; Circuit Trace | Inspection Lance, Sightline Calibration Lens, Rainline Padded Coat |
| Rook | Protective former security escort; STR 9, DEX 8 | Escort Cover; Read the Approach | Ballast-Head Security Club, Checkpoint Disc Shield, Watchline Protective Cap |
| Switch | Fixer and clinic volunteer; CHA 10, INT 9 | Rapid Wound Stabilization; Find the Human Angle | Market Watch Spear, Carved Clinic Token, Rainwalk Work Boots |

Each also started with one healing consumable. These were normally generated characters with server-rolled offers, followed by explicit legal ability and equipment selections.

The private starting rumors disagreed: Patch heard that the purge was a corporate deletion order; Rook heard that market identity fraud had caused it; Switch heard that a clinic relocation batch was being misclassified. None was established as the truth. Equipment markings linked all three characters to the opening mystery without granting the answer.

**What happened, turn by turn**

**Turn 1 — Examine the evidence and hear the witnesses.** Patch asked to examine the shard with Nessa's permission and used Circuit Trace without connecting it to a network. The INT check rolled 2, with +7, for 9 against DC 10: failure. Patch could not establish a safe connection; the shard stayed unpowered and unread. A useful lesser finding pointed toward the clinic's isolated equipment.

Rook inspected Ivo's receipts and questioned him. The same card and reader produced ACCEPTED at 01:12 and REJECTED — PENDING RECONCILIATION / DUPLICATE at 01:18. Reader maintenance began afterward. Switch interviewed Nessa, who described the preview she had seen and requested a safe offline examination rather than public distribution of patients' names. She permitted examination at the clinic with her present and retaining custody. Everyone remained at the market. No XP was recorded.

The round needed five model requests and four correction events, then published retained outcomes through fallback. Corrections included an out-of-range investigation answer index, an unsupported `features` field, too many actions for one actor, and intent/NPC grounding errors. Saved action facts also duplicated investigation results.

**Turn 2 — Split the party, with travel lost during recovery.** Patch and Switch requested travel east to the open clinic entrance; Patch also invited Nessa. Rook requested ordinary travel north to the service gate, keeping his club lowered.

Rook arrived and met technician Dena Orr and security escort Bram Voss. Patch and Switch did not move: fallback marked both blocked and offered observations of the same open clinic route. There was no travel check or established physical obstacle explaining this. Rook's saved action was only partial, despite his arrival. The narration repeated his arrival and interleaved it with generic statements that characters made no further headway. No XP was recorded.

Both model responses were rejected with the same NPC interaction metadata error. This is the clearest functional defect observed in the test: a scene correction caused legal movement to be lost.

**Turn 3 — Retry the journey and establish the relay lead.** Patch submitted the short instruction “Walk to Second Pulse Clinic.” Switch escorted Nessa there while she kept the shard. Rook questioned Dena about the six-minute reversal and the replacement reader.

The first processing attempt failed after an overlong investigation preparation entry, an invalid lead source, and a recovery error saying an open route should reach the requested destination. I used the normal saved-turn retry. The second attempt completed without changing the submissions.

Patch, Switch and Nessa reached the clinic. Dena confirmed that the card had read successfully both times: the relay's pending batch supplied the new duplicate flag. Replacing the physical reader would not change it. Her discrepancy sheet documented the transition, but the authorization behind the flag required the relay audit record. Each character received 10 XP. There were no checks in this round, so this retry did not test reuse of an already rolled die.

**Turn 4 — A failed repair and successful negotiation.** Patch tried drying and bridging the cracked connector using the clinic's tested spare. With advantage, the dice were 5 and 4; +3 produced 8 against DC 10: failure. The shard remained unrepaired, unread and unpowered.

Rook asked Bram for supervised audit access, citing Dena's documented discrepancy. With advantage, the dice were 13 and 9; the effective CHA modifier was −1, producing 12 against DC 10: success. Bram granted access to the Relay Audit Vestibule and its pending-batch authorization record under supervision. This did not grant permission to remove records, alter systems or enter the inner relay.

Switch established that the clinic reader had a separate battery, no network cable or radio module, and a physical write-blocking adapter. The technician explained a different repair approach: brace the casing and connector separately in the adjustable cradle. Each character received another 10 XP, including Patch; that is the recorded reward, not a claim that the repair succeeded.

The round needed four requests and two corrections: an unsupported `exits` field and an attempted feature change attached to a failed action. The accepted result preserved failure and introduced the technician's distinct advice.

**Turn 5 — Assistance works, but the repair still fails.** Switch steadied the cradle under the technician's direction. The DEX check had advantage, dice 19 and 14, for 19 against DC 5: success. Patch attempted the separate bracing with that support. The INT check had advantage, dice 1 and 4, with +3, for 7 against DC 10: failure. The successful assistance did not turn the repair into a success. A recessed fractured contact became visible, providing a concrete next lead, while Nessa kept the unread shard.

Rook entered the audit vestibule with Dena and Bram. Bram opened the cabinet for the authorized inspection. The pending reconciliation folders were accessible, but Rook had not yet examined their authorization record. No further XP was recorded. This round needed four requests and one correction for feature changes following a failed action. Play stopped after publication.

**Final state**

| Character | Position | HP | XP | Resources used |
| --- | --- | --- | --- | --- |
| Patch | Second Pulse Clinic, with Switch and Nessa | 20/20 | 20 | Circuit Trace used once; healing consumable retained |
| Rook | Relay Audit Vestibule, with Dena and Bram | 22/22 | 20 | No ability or consumable use |
| Switch | Second Pulse Clinic, with Patch and Nessa | 22/22 | 20 | No ability or consumable use |

There was no combat, damage, death, healing use or loot acquisition. Nessa still owned the shard. The evidence implicated a relay-generated eligibility decision rather than a broken gate reader, but its author, motive and affected population were not established. The purge was not stopped. The two immediate unfinished tasks were examining the audit authorization and resolving the shard's recessed contact.

**Measured pacing and recovery**

Times below sum the recorded engine stages, including a failed attempt where applicable. They exclude time spent choosing actions and the pause before manual retry.

| Played turn | Processing time | Model requests | Correction events | Publication/recovery |
| --- | --- | --- | --- | --- |
| 1 | 2:45 | 5 | 4 | Published through fallback |
| 2 | 1:56 | 2 | 2 | Published through fallback; clinic travel lost |
| 3 | 1:55 | 4 | 2 | Initial attempt failed; one manual retry completed it |
| 4 | 2:35 | 4 | 2 | Accepted after corrections |
| 5 | 1:51 | 4 | 1 | Accepted after correction |
| Total | 11:02 | 19 | 11 | Five completed group rounds |

Mean processing time was 2:12 per played round; median was 1:56. The opening separately took 4:01 and four model requests, with one correction. Character generation used six requests, running the three characters in parallel. Across generation, opening and play there were 29 model requests and 12 correction events. The first-to-last model-log window was approximately 20:52–21:12 CET, including decision time between rounds.

Played rounds reported 595,000 input tokens and 26,078 output tokens, including repeated request context. The entire session reported 666,271 input and 40,647 output tokens. These are recorded usage figures, not a monetary cost estimate. Every played round encountered correction feedback at some point; one manual retry was required.

**What worked and what needs attention**

- The opening supplied distinct witnesses, conflicting rumors, character-linked evidence and reachable leads. Interviews narrowed the mystery rather than revealing an unsupported solution. Split locations and NPC escorts eventually persisted correctly.
- Failed checks remained failed. Patch's three unsuccessful technical checks did not repair or read the shard, including after successful assistance. The failures supplied specific next approaches. Ownership and authorization remained clear throughout.
- Highest priority: preserve ordinary open-route movement through scene recovery. Turn 2 consumed two characters' actions without completing their legal journey. Turn 3 then failed its first publication attempt on the same route before retry succeeded. See the saved [turn 2 snapshot](../../../data/playtests/cyberworld-2026-11-13/snapshot-02.json) and [failed turn 3 attempt](../../../data/playtests/cyberworld-2026-11-13/failed-turn-03-attempt-1.json).
- Reduce the recurring tool/schema correction chain. Invalid answer indexes, overlong preparation text, unsupported fields and failed-action feature changes repeatedly required another model request. Correctness checks caught the errors, but the resulting waits dominated this small session. The recorded payloads provide concrete reproduction cases.
- Improve fallback clarity. Turn 2 duplicated Rook's arrival and mixed actual movement with statements of no progress. Saved investigation action facts also repeat their own results in several rounds. A reader should be able to tell immediately who moved and what failed.
- Update stale state and scene framing. After turn 5, the bench's saved `repairapproach` still said that no bracing had been performed, despite Switch's successful support and the completed bracing attempt. The shared scene focus also remained the market during turns 3–5, when no player was there. The latter is a presentation concern inferred from saved state; the browser display was not inspected. See the [final snapshot](../../../data/playtests/cyberworld-2026-11-13/snapshot-05.json).

This five-round sample covers investigation, social access, split-party travel, NPC escort, technical failure, assistance and recovery. It does not establish combat balance, healing behavior, browser usability or long-term memory quality. No gameplay fixes were made as part of the playtest.

The complete public narration, submissions and dice are in [transcript.md](transcript.md). Per-round diagnostics are summarized in [metrics.json](metrics.json). Raw snapshots, character drafts, submissions, full model logs and the isolated database remain under `data/playtests/cyberworld-2026-11-13/`; `export.json` there also contains private GM preparation.

Final record checks passed: exactly three members, completed played turns 1–5, exactly three submissions per played turn, five saved check receipts, and an empty collecting turn 6.
