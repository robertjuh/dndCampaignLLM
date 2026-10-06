# Focus equipment effects

Status: proposed; gameplay implementation has not started.

## Goal

Give newly generated focuses distinct, saved mechanical effects while keeping
rarity responsible for power. Keep the existing matching-attribute attack bonus:
Common/Uncommon +1, Rare/Cursed +2, Legendary +3. Add at most one extra effect per
focus. Existing items without an effect continue to work as they do today.

Initial scope is focus equipment. Weapons, armour, relics, consumables and
abilities keep their existing mechanics.

## Proposed effects and initial balance

These values are starting playtest settings, not a claim that balance is proven.
An eligible successful main attack triggers the effect automatically.

| Effect | Common | Uncommon | Rare / Cursed | Legendary |
| --- | --- | --- | --- | --- |
| Elemental damage | +1 damage | +1d4 damage | +1d6 damage | +1d8 damage |
| Life siphon | Restore up to 1 HP | Restore up to 1 HP | Restore up to 2 HP | Restore up to 3 HP |
| Ward | Unavailable | +1 defense against the next enemy attack | +2 defense against the next enemy attack | +3 defense against the next enemy attack |
| Affliction | Unavailable | Unavailable | Apply one saved ailment on a natural 20 | Apply one saved ailment on a successful hit |

- **Elemental damage:** fire, frost or lightning, chosen when the item is created.
  The element describes the damage; this version adds no resistance system,
  vulnerability multiplier or automatic Burning/Chilled/Shocked. Add this amount
  to the attack's damage before applying damage-taken modifiers once. Critical
  hits do not double the extra focus dice.
- **Life siphon:** heal the wielder from damage actually removed from the enemy,
  capped by the table and missing HP. This transfers part of existing damage; it
  does not add another damage event. Use the same standard healing rules as
  other healing. A siphon can recover HP from a killing hit, but cannot revive a Downed wielder.
- **Ward:** protect the wielder against the next enemy attack, using the existing
  temporary guard behavior. Keep the larger value if another guard is active;
  do not add the two values. Consume the ward on that attack, even if it misses,
  and clear it when the encounter ends.
- **Affliction:** save one of Chilled, Weakened or Poisoned and reuse its existing
  duration, refresh and end-of-turn rules. Apply only if the enemy survives the
  hit. Existing immunities remain authoritative wherever supported. Exclude
  Stunned, Frozen and Electrocuted from this first version to avoid repeated
  action denial. Do not silently reroll the ailment after acquisition.

Cursed focuses use Rare effect power and retain their existing -3 initiative.

Example: an Uncommon Ember Lens adds +1 to matching attack rolls and +1d4 fire
damage on its first eligible hit each turn. A Rare Hunger Vessel adds +2 to
matching attack rolls and siphons up to 2 HP on its first eligible hit.

## Activation and stacking

1. The focus must be equipped, and at least one of its scaling attributes must
   match the attack's scaling attributes. Inventory-only items grant no effects.
2. Eligible attacks are main-action weapon attacks, innate attacks and Strike
   abilities. Ordinary checks, influence, stun maneuvers, healing, support,
   environmental attacks and off-hand minor attacks do not trigger these effects.
   Existing focus accuracy bonuses continue to apply under their current rules.
3. Allow one extra focus activation per character per resolved party turn. A miss
   or blocked action spends no activation. No additional action or ability charge
   is required. This first version needs no persistent cooldown state.
4. Deduplicate an item occupying both hands. If several matching focuses have
   effects, activate the highest-rarity one; break equal-rarity ties by saved item
   ID. Retain the existing stacking of attack bonuses. Explain the chosen effect
   in equipment inspection so the player can predict which focus will activate.
5. Existing innate lifesteal remains independent, with both heals respecting HP
   caps and their own eligibility. Report only HP actually restored.
6. Record extra dice, damage, restored HP, guards and ailments in authoritative
   combat receipts. Narration describes those results and cannot invent effects.

## Implementation steps

1. **Save and validate effects.** Add an optional, small discriminated effect
   field to `itemSchema` in `shared/schema.ts`. Bound effect values and validate
   effect eligibility against item kind and rarity at item creation/import
   boundaries. Missing effects mean no extra mechanic. Avoid a generic effect
   scripting system or new dependency.
2. **Generate within rarity limits.** Extend `rollStartingEquipment` and
   `randomLoot` in `shared/rules.ts` to assign one allowed effect using existing
   audited dice. New Common focuses roll elemental damage or life siphon;
   higher rarities expand the pool. Update starting-equipment validation, which
   currently enforces Common power. Use a bounded optional affinity on loot
   blueprints when helpful for item identity; the server chooses allowed effect
   power after rarity is known. Unsupported affinities fall back to the allowed
   pool. Supply final rolled mechanics to the existing naming pass and update
   provider schemas/prompts together. Never derive mechanics from description text.
3. **Resolve once in combat.** Apply effects in the shared main attack resolver
   after a hit is confirmed, preserving current weapon/innate/ability damage
   formulas, critical rules and outcome metadata. Reuse healing,
   guard and ailment helpers. Keep effect activation state local to the round
   execution, and use the existing mechanical dice/recovery path so saved retries
   reproduce the same rolls and state.
4. **Expose exact mechanics.** Add one shared effect-summary helper for item
   inspection, character creation and equipment previews. Show trigger, matching
   attribute, power, frequency and any critical-only
   requirement. Include effects in generated descriptions and model context.
5. **Preserve saves.** Load old items without inventing or rerolling effects.
   Check inventory, equipped slots, starter options, ground loot and saved turn
   drafts. Introduce no database migration unless serialization checks prove one
   is needed. Completed historical turns retain their original receipts.

## Verification and acceptance

- Exercise every effect with controlled dice at its rarity boundaries, including
  Common starter generation and rejected invalid/overpowered imported items.
- Verify matching attributes, equipped versus stowed items, two-hand
  deduplication, multiple-focus selection, misses, off-hand exclusions and Strike
  eligibility. Include innate attacks and excluded environmental attacks.
- Verify critical bonus dice do not double, damage-taken modifiers apply once,
  killing-hit siphons use actual enemy HP lost, and full-HP healing reports zero.
  Verify innate lifesteal remains bounded.
- Verify ward consumption/cleanup and larger-guard behavior; verify ailment
  eligibility, refresh, duration and no application to a dead enemy.
- Verify new-effect dice and receipts survive interrupted-turn retry/restart,
  while legacy saves without effects keep their behavior.
- Add a browser check for exact effect text and equipment preview; run affected
  unit/integration tests and the production build.
- Playtest synthetic Common, Uncommon and Rare encounters first. Compare actual
  damage, healing and turns to victory before enabling Legendary balancing
  changes. Do not alter existing live campaign equipment for the test.

Defer area damage, resistance systems, activated item charges, arbitrary triggers
and multiple extra effects per item until this small set has been playtested.
