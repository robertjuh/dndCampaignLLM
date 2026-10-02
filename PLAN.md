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

React/TypeScript client, Fastify server, SQLite storage, server-sent live updates, and a dedicated read-only shared screen. The server supports local-network listening and an explicit `GATHER_PUBLIC_URL` for reachable invitation links. Leader sign-in remains on loopback while player links use the network address. Windows-to-WSL forwarding is configured for the local setup, and the user confirmed Gather opens on a phone over Wi-Fi.

Campaigns, templates, memberships, roster snapshots, turns, actions, rolls, mechanic drafts, journal entries, and events are persistent. Character instances are isolated from reusable templates and from other campaigns. JSON export omits provider credentials and access secrets. A campaign can be revisited or its configuration copied into a new run.

### Multiplayer turn lifecycle

1. The leader configures a campaign and shares its invitation.
2. Players choose or create saved templates, then select two of five equippable starting items.
3. The leader begins. The LLM introduces a setting consistent with the campaign parameters.
4. The server freezes the active, living roster for each turn.
5. Players submit actions or pass. They can revise submissions while the turn is still collecting.
6. The final required submission claims exactly one resolution worker.
7. The LLM requests checks/encounters/combat/loot/challenge tools and narrates their returned facts.
8. A validated completed response commits the state atomically and opens the next turn.
9. A failure preserves actions, dice, and mechanic receipts for a deliberate retry.

Late joins enter the next roster. Disconnects require an explicit sit-out decision. Pausing holds automatic advancement. Dead players spectate; all-dead ends the run. Level-up point allocation blocks the affected player's next action.

### Character and world customization

Templates are generated from a concept and displayed as read-only sheets with identity, species/form, appearance, backstory, motivation, weaknesses, two traits, one combat ability, and one utility ability. The server rolls five equippable starting items independently; the player selects two. Saved picks apply when joining, with spare gear in the backpack. Regenerating a library template does not modify active campaigns. Lobby review can regenerate the template and that lobby instance before starting. Each level grants one of five player-chosen generated rewards: a new ability of either kind, a random upgrade of either kind, or two randomly allocated attribute points. Rewards persist in the campaign character; provider failures leave the choice available.

Traits carry validated stat modifiers, HP/defense adjustments, healing compatibility, anatomy restrictions, immunities, regeneration, and natural-attack properties. The balance budget limits total starting advantages. Story capabilities outside these mechanical fields remain subject to the GM's contextual checks.

Campaign fields, character data, enemy definitions, loot blueprints, floor descriptions, and public lore are supplied to the LLM as instance context. The full gameplay reference is included in its instructions. There are no fixed adventure presets or forced protagonist pools.

### Roguelike mechanics

Implemented core rules include STR/DEX/INT modifiers, level-one starts, derived HP, XP thresholds, player-chosen generated level-up rewards, five equipment slots, eight-slot backpacks, consumable stacking, equipment requirements, hybrid scaling, initiative, main/minor actions, attacks and damage dice, defending, fleeing, light dual wielding, healing, combat conditions, critical results, loot rarity, safe rest, changing floors, and permadeath.

Creative combat supports environmental damage, stun, and influence without killing. Noncombat challenges can replace a floor boss after a successful difficult check. Physical loot is offered for player selection rather than automatically equipped or taken.

Software interpretations that make the reference deterministic: critical attacks double damage dice; natural-one attack backlash rolls d4; improvisation/flee catastrophes inflict four damage; enemy XP is 15/30/50/100 by tier; noncombat XP is bounded at 40 per round; safe rest is limited to once per floor per character. The reference remains the narrative/pacing authority where no explicit implementation rule supersedes it.

### Subscription provider

Implemented the documented open-source local-app ChatGPT OAuth flow and streamed Responses tool calls. Tokens are isolated from game data, refresh is serialized, and plan-access errors leave recoverable turns. The app neither accepts API keys nor reads credentials belonging to another tool. Players without a separate connection use the host’s account, including standalone character generation. Shared settings hide host credentials and account controls. The UI labels authentication as sign-in rather than proof of available inference; generation usage errors link to ChatGPT usage settings and preserve the generated sheet and equipment selections.

**Live verification:** real sign-in, model discovery, streamed character text, and usage-limit handling have been observed. Fixed a stream assembly bug: successful terminal envelopes may have empty output, requiring collection of finished output-item events. Character generation now shows elapsed time, supports cancellation, and has bounded timeouts with inline errors. The post-fix smoke request received `subscription_sharing_usage_limit_exceeded` even though the user’s dashboard shows remaining usage and Gather enabled; the exact upstream restriction is unconfirmed; the user has since confirmed successful character generation on the host and two phones. A live tool-using group turn and token refresh remain acceptance gates.

### Verification

Automated tests cover the rules engine, group readiness, solo play, pauses, late arrivals, retries, persistence, independent character instances, death, loot ownership, access control, and provider errors. Browser coverage uses separate leader/player/display contexts and checks the mobile layout. An integration check also exercises generated templates, two-player readiness, streamed tool calls with empty terminal output, quota failure after both rolls, and an explicit retry that preserves dice and applies XP once. Those provider responses are mocked; this does not establish live subscription availability. Browser tests cover preserving and saving a generated result after quota rejection and shared-host sign-in status. Offline practice deliberately remains a labelled scripted rehearsal using the user's supplied setting and templates.

## Next milestones

1. Complete a live multiplayer game turn and configure/verify Google player sign-in with a real OAuth client and HTTPS callback domain.
2. Extend the validated mechanic vocabulary for bespoke consumables, equipment effects, elemental interactions, and more elaborate enemy abilities while preserving player agency.
3. Improve long-campaign context retrieval beyond recent summaries and a public journal; separate discovered facts from private GM knowledge.
4. Add user-facing backup restoration, and invite revocation. Google cross-device profile recovery is implemented; live setup remains pending.
5. Add leader corrections with an auditable undo strategy; do not rewrite completed rolls silently.
6. Keep local garage play as the current deployment: laptop server, TV shared screen, phone player views, and ngrok only for Google callbacks. Preserve configurable URLs/storage and the separate authentication module. If hosted later, first target one persistent Node server with HTTPS and a persistent data volume; review host authorization and AI authentication before public access. Defer distributed storage/workers until a concrete hosting target needs them. See README's hosting approach.

## Deliberate first-version limits

This is a local web application, not a native packaged installer. Live ChatGPT connectivity is verified; the user has confirmed character generation on the host and phones; a full live group turn remains unverified. Google sign-in can bind existing local profiles and recover them on other devices. Its signed-token, browser-binding, ownership, and persistence tests use mocked Google responses; a configured OAuth client and HTTPS callback tunnel are still needed for live acceptance. Browser sessions use HttpOnly cookies. Narrative item/creature abilities cannot automatically add arbitrary new engine behavior. Import/restore and long-term memory retrieval are not yet implemented. Public internet deployment is not part of the tested setup.
