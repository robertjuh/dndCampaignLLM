# Gather implementation plan

## Current direction

The authoritative gameplay reference is [GAMEPLAYLOOPPROMPT.md](GAMEPLAYLOOPPROMPT.md). The user's latest hard criteria override conflicting parts of that document, especially mandatory random characters: players may create reusable custom templates, ask the LLM to interpret a concept, or request a random protagonist.

The previous six-stat narrative rules are replaced by STR/DEX/INT and the roguelike loop. No production character, species, world, enemy, or item-name catalog is seeded or hardcoded. Rule formulas and validation limits are code; player/world content is instance-owned data.

The user's final dice instruction is local-only with no external dependencies. The app uses Node's built-in cryptographic random integer source and explicitly distinguishes this from hardware-measured physical true randomness.

## Non-negotiable product requirements

- One or more players, including solo play.
- A leader creates a persistent campaign with custom setting/theme, premise, tone, language, instructions, and arbitrary key/value parameters.
- One communal story/overview screen; each player joins on their own device and uses an action chat.
- All submitted actions appear on the communal screen. The GM processes the next turn only after every required player submits or passes.
- The LLM is the dungeon master. It handles interpretation, narrative, world generation, encounter design, and suggested checks through validated tools.
- Character creation from custom templates and concept-based LLM generation, with balanced stats and persistent reuse.
- Per-campaign player state, conditions, equipment, inventory, and progression in a database.
- Simple expandable player cards showing profile, stats, conditions, equipment, and backpack.
- ChatGPT subscription access, with no API-key billing fallback. Open source is acceptable.
- Local dice tools whose results are saved and cannot be rerolled by a retry.

## Implemented first version

### Application and persistence

React/TypeScript client, Fastify server, SQLite storage, server-sent live updates, and a dedicated read-only shared screen. The server supports local-network listening and an explicit `GATHER_PUBLIC_URL` for reachable invitation links. Leader sign-in can remain on loopback while player links use the network address.

Campaigns, templates, memberships, roster snapshots, turns, actions, rolls, mechanic drafts, journal entries, and events are persistent. Character instances are isolated from reusable templates and from other campaigns. JSON export omits provider credentials and access secrets. A campaign can be revisited or its configuration copied into a new run.

### Multiplayer turn lifecycle

1. The leader configures a campaign and shares its invitation.
2. Players choose or create saved templates, then select their starting weapons.
3. The leader begins. The LLM introduces a setting consistent with the campaign parameters.
4. The server freezes the active, living roster for each turn.
5. Players submit actions or pass. They can revise submissions while the turn is still collecting.
6. The final required submission claims exactly one resolution worker.
7. The LLM requests checks/encounters/combat/loot/challenge tools and narrates their returned facts.
8. A validated completed response commits the state atomically and opens the next turn.
9. A failure preserves actions, dice, and mechanic receipts for a deliberate retry.

Late joins enter the next roster. Disconnects require an explicit sit-out decision. Pausing holds automatic advancement. Dead players spectate; all-dead ends the run. Level-up point allocation blocks the affected player's next action.

### Character and world customization

Templates have custom identity, species/form, appearance, backstory, motivation, weaknesses, traits, three themed starter weapon choices, and a healing item. A concept can be drafted by ChatGPT and reviewed before saving. Existing templates can be copied and edited without modifying active campaigns.

Traits carry validated stat modifiers, HP/defense adjustments, healing compatibility, anatomy restrictions, immunities, regeneration, and natural-attack properties. The balance budget limits total starting advantages. Story capabilities outside these mechanical fields remain subject to the GM's contextual checks.

Campaign fields, character data, enemy definitions, loot blueprints, floor descriptions, and public lore are supplied to the LLM as instance context. The full gameplay reference is included in its instructions. There are no fixed adventure presets or forced protagonist pools.

### Roguelike mechanics

Implemented core rules include STR/DEX/INT modifiers, level-one starts, derived HP, XP thresholds, player-allocated level-ups, five equipment slots, eight-slot backpacks, consumable stacking, equipment requirements, hybrid scaling, initiative, main/minor actions, attacks and damage dice, defending, fleeing, light dual wielding, healing, combat conditions, critical results, loot rarity, safe rest, changing floors, and permadeath.

Creative combat supports environmental damage, stun, and influence without killing. Noncombat challenges can replace a floor boss after a successful difficult check. Physical loot is offered for player selection rather than automatically equipped or taken.

Software interpretations that make the reference deterministic: critical attacks double damage dice; natural-one attack backlash rolls d4; improvisation/flee catastrophes inflict four damage; enemy XP is 15/30/50/100 by tier; noncombat XP is bounded at 40 per round; safe rest is limited to once per floor per character. The reference remains the narrative/pacing authority where no explicit implementation rule supersedes it.

### Subscription provider

Implemented the documented open-source local-app ChatGPT OAuth flow and streamed Responses tool calls. Tokens are isolated from game data, refresh is serialized, and plan-access errors leave recoverable turns. The app neither accepts API keys nor reads credentials belonging to another tool.

**Live verification:** real sign-in, model discovery, streamed character text, and usage-limit handling have been observed. Fixed a stream assembly bug: successful terminal envelopes may have empty output, requiring collection of finished output-item events. Character generation now shows elapsed time, supports cancellation, and has bounded timeouts with inline errors. The post-fix smoke request received `subscription_sharing_usage_limit_exceeded` even though the user’s dashboard shows remaining usage and Gather enabled; the exact upstream restriction is unconfirmed; successful endpoint generation, a live tool-using group turn, and token refresh remain acceptance gates.

### Verification

Automated tests cover the rules engine, group readiness, solo play, pauses, late arrivals, retries, persistence, independent character instances, death, loot ownership, access control, and provider errors. Browser coverage uses separate leader/player/display contexts and checks the mobile layout. Offline practice deliberately remains a labelled scripted rehearsal using the user's supplied setting and templates.

## Next milestones

1. Complete the real-account subscription smoke test and a small multiplayer playtest.
2. Extend the validated mechanic vocabulary for bespoke consumables, equipment effects, elemental interactions, and more elaborate enemy abilities while preserving player agency.
3. Improve long-campaign context retrieval beyond recent summaries and a public journal; separate discovered facts from private GM knowledge.
4. Add user-facing backup restoration, invite revocation, and cross-device player recovery.
5. Add leader corrections with an auditable undo strategy; do not rewrite completed rolls silently.
6. Decide on packaging and remote access after the local-network workflow has been exercised by the group.

## Deliberate first-version limits

This is a local web application, not a native packaged installer. Live ChatGPT connectivity is verified; full generation and group-turn acceptance remain pending account usage availability. Browser cookies are the identity mechanism. Narrative item/creature abilities cannot automatically add arbitrary new engine behavior. Import/restore and long-term memory retrieval are not yet implemented. Public internet deployment is not part of the tested setup.
