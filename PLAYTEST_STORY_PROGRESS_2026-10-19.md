# Live story-progress checks — 19 October 2026

All three isolated scenarios completed with the intended behavior: a successful
investigation delivered an answer and changed an NPC's circumstances, a failed
investigation left a usable different opening, and a creative proposal received
an actual NPC commitment. These results support the revised storytelling guidance.

Used the connected `gpt-6-sol` provider with explicit user approval and gameplay
build `cf3478c0e718240b`. Each scenario used a new in-memory campaign, two template
characters and constructed starting facts. Opening setup was local practice;
adjudication, narration and fidelity review used the real provider. The actual
campaign database was never opened or advanced by the test script. The familiar
names below belong to synthetic test situations, not newly established facts in
the saved cyberworld campaign.

| Scenario | Controlled mechanics | Observed result | Requests | Stage time |
| --- | --- | --- | ---: | ---: |
| Successful investigation | Both investigators roll natural 20s. | Bandit identifies a false infection alert caused by a gate diagnostic pulse attributed to Sera's session. Tern removes her flag and marks the fault for repair. | 7 | 129.2 s |
| Failed investigation | Investigator rolls 2; companion passes. | The trigger remains unidentified. Tern starts the pending diagnostic and opens an accessible live sensor display, creating a different approach. | 6 | 113.8 s |
| Creative NPC proposal | Routine offer; companion passes. | Pip accepts Bandit for a trial demonstration beside the cabinet and commits to introductions and a later discussion of paid shifts. | 4 | 64.7 s |

**Successful investigation.** The submitted actions were to check Sera for
infection and help with that inspection. The output explained a concrete cause,
then showed Tern acting on the finding. Its ending was:

> The false quarantine flag comes off Sera’s session, and Tern marks the session-attribution fault for repair. Sera is free to leave the quarantine queue.

Both NPCs' saved current facts and journal entries retained that change. The
result therefore went beyond an affirmative sentence in otherwise unchanged state.

**Failed investigation.** The submitted action sought the alert trigger in the
available gate log. Its saved main outcome remained `failure`. Tern responded by
starting the pending diagnostic and making its live channels available at the
console. The group gained a concrete thing to examine without being granted the
answer to the failed check. The response was retained in Tern's state and journal.
The prose still briefly qualified that the cause was unresolved; here that
qualification described a real failure alongside a new opportunity.

**Creative proposal.** Bandit offered to work for Pip as a mobile slot machine.
Pip accepted a trial beside the cabinet rather than merely acknowledging the offer
or repeating why paid gambling was unavailable. The commitment was saved in Pip's
current fact and journal. No payment or completed demonstration was invented.
The prose still ended with an unnecessary sentence about the passing companion
taking no action, so presentation is improved rather than completely polished.

**Remaining friction.** All three scenarios needed a correction because structured
adjudication included an unsupported `narration` field. The investigation cases
also needed scene-state validation corrections. Those corrections preserved the
validation boundaries but consumed additional requests and time. These checks do
not establish a latency improvement.

This is a small synthetic sample with controlled dice, not a controlled replay of
the earlier campaign or a long-session consistency test. It demonstrates that the
current provider and pipeline can produce useful answers, persistent consequences
and substantive NPC decisions under the revised guidance. Longer natural play is
still needed to judge how consistently it does so.

Raw local results were written to `/tmp/gather-story-progress-live-results.json`;
the temporary driver was `/tmp/gather-story-progress-playtest.mts`. No gameplay
source changes or save corrections were made during this verification.
