# Warhammer opening recovery — 16 October 2026

Newest run: `1699c37e-5648-415c-a0b1-52389f69b581`, opening turn
`077e9752-b397-4a66-8cce-0e111decff96`.

## Cause

The campaign explicitly requests six local factions. The initialization seed
supplied three stable faction identities, while the world schema already allowed
three to six factions. The model preserved the three seeds and appended three
additional factions matching the campaign. All three completed responses for this
run were valid JSON and valid faction-world objects, with six factions each.

`validateGeneratedWorld` nevertheless required exactly the seed's faction count.
Its plain Error (“Preserve supplied faction IDs and order.”) was then incorrectly
reported by the shared generation helper as “Return one valid JSON object, without
markdown.” Three requests consumed 125.9 seconds without giving the model actionable
feedback. The same problem affected the earlier run and its manual retries.

## Fix

Initial generation may append factions up to the existing six-faction limit.
Every supplied seed must remain first in its original order. Existing discovery
state, public lore and established names remain protected. Additional initial
factions must be undiscovered, have no public description and use the supplied
activity turn. Duplicated identities, missing/reordered seeds, invalid relationships
and oversized worlds remain rejected. Ordinary play still cannot add factions.

The generation prompt explicitly describes these bounds and respects established
campaign lore. The shared generation helper now reports actual Error messages,
rather than treating semantic validation failures as JSON syntax problems. The
gameplay build fingerprint includes faction validation code.

Verification: 736 unit tests in 25 files passed; TypeScript and production build
passed. Added regressions cover six-faction initialization, private appended
factions, checkpoint reuse after interrupted opening narration and accurate
correction feedback. All 20 retained faction-generation responses for the two
affected runs pass the corrected validator against their supplied seeds.

## Saved checkpoint recovery

The latest run's final retained response (`5afcef66-ff24-4dc1-8323-815362c3f221`)
was validated against its exact persisted seed before recovery. A guarded read-only
preview confirmed the run was still the newest campaign, its opening remained
failed in faction initialization, and no actions, dice or accepted story resolution
existed. An online SQLite backup was saved as
`data/gather.sqlite.before-faction-recovery-1792186719420.sqlite` with owner-only
permissions.

The validated response was restored into the opening's private faction checkpoint
and frozen context, with an audit event. Existing seed receipts and party identities
were preserved. Normal retry then resumed faction connections and opening
adjudication through the connected provider, skipping faction-world regeneration.
The earlier run was left untouched.

Live recovery completed successfully: the opening now contains 1,749 characters
of accepted story, all six recovered faction identities are saved, and turn 1 is
collecting submissions. Faction connections used one request, opening adjudication
one request, and narration four requests including one factual correction. No
stage fell back. Comparison with the backup confirmed all four character identities,
sheets, HP, XP, gold, equipment, inventory and ability uses were preserved.
