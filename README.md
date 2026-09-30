# Gather

A locally hosted multiplayer RPG with a ChatGPT dungeon master, a shared story screen, individual player action chats, and persistent campaigns.

`GAMEPLAYLOOPPROMPT.md` is the gameplay reference. Your explicit requirements take precedence: characters can be created from reusable templates or generated from a concept, and all player and world content belongs to individual saved instances. There is no fixed species, character, enemy, item-name, or campaign catalog.

## Run

Requires Node.js 20.19+ and npm.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:3000**. For players on your local network:

```sh
HOST=0.0.0.0 npm run dev
```

The leader can keep using `127.0.0.1` for ChatGPT sign-in. When listening on all interfaces, invitation and shared-screen links use a detected network address. Set `GATHER_PUBLIC_URL=http://YOUR-REACHABLE-HOST:3000` to override it, especially for WSL, multiple network adapters, or port forwarding. WSL may require Windows networking/firewall configuration before other devices can reach the server.

```sh
npm run build
npm start
```

`PORT` defaults to 3000. `GATHER_DATA_DIR` defaults to `./data`. Variables are supplied by the shell; `.env` files are not loaded automatically.

## Play

1. Open **Settings → Continue with ChatGPT** on the host computer. Complete authorization and return to the original tab.
2. Create a campaign with your own name, setting, premise, tone, language, instructions, and custom key/value fields.
3. Invite one or more players. Each player uses a separate browser profile or device. Multiple tabs in one browser share a player identity.
4. Choose a saved character, create a custom template, or ask ChatGPT to generate one from a concept. Generation from a session invitation uses the leader's connection. Generation shows elapsed time and can be cancelled. Errors appear beside Generate; requests time out after two minutes without replacing your draft. Review and save the result.
5. Each player chooses one of their three custom starting weapons. The leader selects **Begin the story** and opens **Shared screen** on the communal display.
6. Players describe their actions or pass. Submissions appear immediately on the display. Once everyone in the turn's roster has submitted, the dungeon master resolves the group turn.
7. Reopen the campaign to continue later. **New run from this world** copies its parameters into an editable new campaign.

The separately labelled **Practice table** is an offline rules rehearsal. It uses your supplied setting, character templates, and actual local dice, with a simple scripted check resolver. It does not generate characters or invent an adaptive world. It is never a fallback for a failed ChatGPT request.

## Characters and game rules

The application implements the reference's core loop with these explicit multiplayer/software adaptations:

- STR, DEX, INT start at 5 plus custom traits. Modifier: `floor((stat - 5) / 2)`. Traits have validated balance limits, equipment restrictions, immunities, and supported mechanical effects. Species and trait names/descriptions are freely customizable.
- Saved templates remain reusable. Joining makes an independent campaign character with its own HP, XP, level, gold, inventory, equipment, and conditions. A death is permanent within that run; reusing the template in a new campaign creates a fresh life.
- Starting HP is `20 + 2 × STR modifier`, plus trait adjustments. Every 100 XP grants a level, five player-allocated stat points, and five maximum/current HP. Players must allocate points before acting again.
- Equipment has left/right hand, body, head, and boots slots. Two-handed weapons occupy both hands. Backpack capacity is eight slots; consumables stack three per slot, and equipped gear uses no backpack slots.
- Attacks use d20 plus weapon scaling against defense. Damage uses actual dice plus scaling, minimum one. Hybrid equipment averages its two modifiers, rounded down. Natural 20 doubles damage dice; natural 1 causes a catastrophic setback. The narrator provides contextual consequences within the engine's state.
- Combat resolves in rolled initiative order. Each player gets a main action and a minor action. Attack, defend, flee, environmental damage, stun, and influence are supported. Influence can make an enemy withdraw alive. Minor actions include healing, switching equipment, and an off-hand attack with two light weapons; off-hand damage omits the stat modifier.
- Defending adds two defense until the character's next action. The GM chooses a bounded difficulty for fleeing and creative actions. Healing types and anatomy restrictions are enforced by the server.
- Every combat victory offers a physical item. Its name, kind, appearance, and stat identity come from the instance; the tool rolls rarity and derives bounded power. Exploration can also offer custom loot. Players explicitly take, equip, stow, use, or drop items.
- Minor/normal/elite/boss enemies award 15/30/50/100 XP. Noncombat rewards are bounded at 40 XP per turn. About five encounters and a boss is a narrative pacing target, not a displayed countdown. A significant successful DC 15+ noncombat challenge can clear a floor instead of a boss fight.
- New floors have new generated biomes. Safe rest restores 25% maximum HP, rounded up, once per character per floor when the GM makes it available. Combat conditions have tracked durations.
- Zero HP means death. Dead players spectate while survivors continue. An entirely dead party ends the run. Lethal noncombat checks require a previously displayed warning and that player's explicit acceptance.

The LLM receives the full reference plus the multiplayer contract, campaign parameters, character states, recent summaries, and public journal. It interprets natural-language actions and generates the world. Server tools own dice and mechanical mutations; unsupported bespoke abilities remain narrative until implemented as validated mechanics. Editing the reference requires a server restart, and changing numeric engine rules requires a corresponding code change.

## Local dice and retry integrity

`server/random.ts` uses Node's built-in `crypto.randomInt`. There is no external randomness service, dice package, network dependency, model-chosen seed, or `Math.random` roll. Draws use the host's cryptographic entropy source and unbiased integer sampling.

This is **cryptographic randomness**, not a claim of directly measured physical true randomness. A hardware entropy source would be needed for that stronger guarantee.

Checks, initiative, attacks, damage, and loot rarity have saved receipts. The model cannot substitute its own result. Noncombat checks are limited to one immutable check per acting character per turn. Combat drafts and tool receipts survive provider failures and host restarts; retries reuse completed mechanics instead of duplicating damage, rewards, or items. Completed state changes commit atomically.

A turn uses a fixed roster. New players enter the next turn. Disconnecting does not silently remove a player; the leader can explicitly sit someone out, pause advancement, or retry an interrupted turn.

## ChatGPT subscription connection

The integration implements OpenAI's documented [open-source local-app plan usage](https://developers.openai.com/siwc/token-sharing-open-source) route. It uses a stable host registration, OAuth authorization code with PKCE/state/nonce, signed identity validation, model discovery, serialized rotating refresh, and streamed Responses calls with client-executed tools. See the official [sign-in protocol](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [inference contract](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), and [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

There is no API-key billing path, and the app does not read Codex credentials or browser session tokens. Account eligibility and subscription limits still apply. A provider failure saves the turn for retry.

**Live verification:** sign-in, model discovery, streamed character text, and a real usage-limit response have been observed with the connected account. This exposed an empty terminal output envelope; the adapter now assembles completed output-item events and accepts them only after successful completion. Regression tests cover that stream format. A fresh successful generation endpoint request and live group turn remain pending because OpenAI returned `subscription_sharing_usage_limit_exceeded`. The user’s usage screen still shows remaining allowance and Gather enabled at 100%; the applicable upstream limit is unconfirmed. This code must not be interpreted as proof that the entire subscription is exhausted. Token refresh remains unverified live. Standalone character generation from the library uses your own connection; generation while joining a session uses the leader's connection.

## Persistence

SQLite stores player profiles, character templates, campaign configuration, per-run character state, turns, actions, rolls, items, public journal, and event receipts. Provider credentials are stored separately under `data/credentials/` with owner-only file permissions. The data directory is ignored by Git.

Browser cookies identify local players. There is no password recovery or cross-device identity transfer yet. Use the same host URL consistently; `localhost`, `127.0.0.1`, and LAN addresses have distinct cookies.

Stop the server before copying the data directory for backup, or use SQLite's online backup facilities. JSON export excludes credentials and invitation/display secrets. In-app import/restore is not implemented. Recent context uses the last 12 summaries and the public journal; long-campaign retrieval remains future work.

## Verify

```sh
npm run check
npm test
npm run build
npm exec playwright install chromium
npm run test:e2e
```

Tests cover group readiness, duplicate submissions, solo turns, late joins, pause/sit-out, persistence, saved-roll retries, atomic failure recovery, custom trait balance, equipment, stacking, progression, permadeath, nonviolent combat, loot ownership, access control, and provider stream failures. Browser tests cover character generation progress, cancellation, and errors. The multiplayer browser test uses a leader, two independent players, and an independent display, then checks the mobile layout.

This is a playable first version. Remaining work includes the live ChatGPT smoke test, wider group playtesting, richer bespoke item/enemy mechanics, long-campaign memory retrieval, invite revocation, player recovery, and in-app backup restoration. See [PLAN.md](PLAN.md). Source is available under [MIT](LICENSE).
