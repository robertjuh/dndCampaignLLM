# Gather

A locally hosted multiplayer RPG with a ChatGPT dungeon master, a shared story screen, individual player action chats, and persistent campaigns.

`GAMEPLAYLOOPPROMPT.md` is the gameplay reference. Your explicit requirements take precedence: characters can be created from reusable templates or generated from a concept, and all player and world content belongs to individual saved instances. There is no fixed species, character, enemy, item-name, or campaign catalog.

## Run

Requires Node.js 20.19+ and npm.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:3000** on the laptop. Gather listens on the local network by default. Open a campaign and use **Invite players** to copy its session link; players open that link in their phone browser on the same Wi-Fi. Keep the laptop running for the game. Phones do not need their own server or ChatGPT account.

The leader keeps using `127.0.0.1` for ChatGPT sign-in and the same saved player identity. Phones use the laptop's LAN address, never `localhost`. The startup output shows the party address. If several adapters are present, set `GATHER_PUBLIC_URL=http://YOUR-LAPTOP-LAN-IP:3000` in `.env` to select the reachable address. `.env.example` shows the available settings. Use `HOST=127.0.0.1` to restrict Gather to the laptop again.

### Windows with WSL 2

WSL's default NAT network needs Windows to forward the game port. Find the Windows laptop's IPv4 address with `ipconfig` and WSL's address with `hostname -I` inside WSL (use its main interface, not Docker). On your trusted home network, run `scripts/enable-wsl-lan.ps1` in **Administrator PowerShell**, substituting those two addresses:

```powershell
.\scripts\enable-wsl-lan.ps1 -ListenAddress <WINDOWS-LAN-IP> -WslAddress <WSL-IP>
```

This creates a port-3000 forwarding rule on that Windows address and a firewall exception restricted to the local subnet on Private networks. Set `GATHER_PUBLIC_URL=http://<WINDOWS-LAN-IP>:3000` in Gather's `.env` and restart the server. If either address changes after a reboot, rerun the script with the new addresses and update `.env`. No router port forwarding is needed. Guest Wi-Fi with device isolation may prevent phones from reaching the laptop.

To remove the Windows rules later, run in Administrator PowerShell with the same laptop address:

```powershell
netsh interface portproxy delete v4tov4 listenaddress=<WINDOWS-LAN-IP> listenport=3000
Remove-NetFirewallRule -Name GatherRPG-LAN-3000
```

```sh
npm run build
npm start
```

`PORT` defaults to 3000. `GATHER_DATA_DIR` defaults to `./data`. Settings load from `.env` in the project directory; existing shell environment variables take precedence. Restart Gather after changing `.env`.

## Play

1. Open **Settings → Continue with ChatGPT** on the host computer. Complete authorization and return to the original tab.
2. Create a campaign with your own name, setting, premise, tone, language, instructions, and custom key/value fields.
3. Invite one or more players. Each player uses a separate browser profile or device. Multiple tabs in one browser share a player identity.
4. Choose a saved character or describe a concept for ChatGPT. The result is a read-only character sheet with two traits, one in-combat ability, and one out-of-combat ability. Select exactly two starting pieces from five dice-rolled, equippable offers, then save. Types may repeat; spare pieces that share a slot go in the backpack. Generation uses the leader's connection, shows elapsed time, and can be cancelled. Errors and usage-settings links appear beside Generate; failures preserve the previous result and selections. Generation times out after two minutes.
5. Each player opens their **player view** under **Prepare your character**. Saved equipment picks are applied on joining; older templates without picks require two selections. **Review my character** shows the sheet and allows regenerating from a concept before the story starts. The readiness list names players who still need to choose. The leader selects **Begin the story**. **Shared screen** is viewing only and links back to player/leader controls.
6. Players describe their actions or pass. Submissions appear immediately on the display. Once everyone in the turn's roster has submitted, the dungeon master resolves the group turn.
7. Reopen the campaign to continue later. **New run from this world** copies its parameters into an editable new campaign.

The separately labelled **Practice table** is an offline rules rehearsal. It uses your supplied setting, character templates, and actual local dice, with a simple scripted check resolver. It provides a labelled practice character and scripted level-up rewards; it does not invent an adaptive world. It is never a fallback for a failed ChatGPT request.

For cheaper AI playtests, use the **ChatGPT model** picker when creating a campaign or generating a standalone library character. Choose GPT-6 Luna if your connected account offers it; smaller models may be less reliable. Campaign character generation, game turns, and level-up generation use the campaign's selected model. **Automatic** preserves the first available model and does not compare prices. Existing campaigns keep their model; use **New run from this world** to choose another model. Reuse saved characters to avoid repeated generation, or use **Practice table** for rules/UI testing with no AI usage. Gather and Codex can consume the same connected plan allowance.

## Google sign-in for players

Google identifies a player; the host's separate ChatGPT connection continues to power the game. First sign in **on the browser where your characters already exist** to attach that local profile to Google. Then use the same Google account on another device to recover its library and campaign seat. Characters remain in this host's SQLite database. Existing Google profiles are reopened without merging unrelated browser libraries. Sign out affects only the current browser and does not disconnect the host's ChatGPT account.

In **Character library**, use **Edit saved character** to update a template for future games or **Create from this template** to save a separate copy. Existing campaign characters remain independent. Use **Edit my character** in the lobby to update that run before it starts.

### Host setup: laptop + HTTPS callback tunnel

No VPS or change to an existing website is needed. Google's web OAuth callback must use HTTPS and a domain (localhost is the development exception); a phone's raw LAN IP is not accepted. Gather has a separate loopback listener on port **3001** that exposes only `/auth/google/callback`. Tunnel that port; keep gameplay, database, and ChatGPT controls on the usual LAN port **3000**.

1. Create an ngrok account and install its CLI **inside WSL alongside Gather** (this workspace has a local copy at `data/tools/ngrok`). Use the assigned development domain shown in your ngrok account. Add your account's auth token to `.env` as `NGROK_AUTHTOKEN`; keep it out of source control.
2. In Google Cloud, select your `dndCampaign` project. Under **Google Auth Platform → Branding**, configure Gather's name, support email, and contact email. Choose **External** under Audience for personal Google accounts. While in Testing, add the party's Google accounts as test users if required by the console. Only `openid` and `email` are requested; no Drive or other Google API access is needed.
3. Under **Clients → Create client**, select **Web application**. Add this exact **Authorized redirect URI**, replacing the example with your ngrok domain:

   ```text
   https://YOUR-ASSIGNED-DOMAIN.ngrok-free.app/auth/google/callback
   ```

   This is a server-side redirect flow; it does not use a JavaScript-origin sign-in SDK. Do not register the phone's LAN address as the Google redirect.

4. Add the issued values to the ignored `.env` file:

   ```dotenv
   GOOGLE_CLIENT_ID=YOUR-CLIENT-ID.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=YOUR-CLIENT-SECRET
   GOOGLE_REDIRECT_URI=https://YOUR-ASSIGNED-DOMAIN.ngrok-free.app/auth/google/callback
   GOOGLE_CALLBACK_PORT=3001
   NGROK_AUTHTOKEN=YOUR-NGROK-AUTHTOKEN
   ```

   Keep your existing `GATHER_PUBLIC_URL` set to the laptop's LAN game address. Do not put the secret in a frontend build, chat, or Git.

5. Restart Gather. Its startup output should report the Google callback listener. In another WSL terminal run:

   ```sh
   npm run tunnel
   ```

   The command reads `.env`, verifies the callback-only listener, and starts ngrok with request inspection disabled. Use your actual assigned domain in `.env`; its suffix may differ. If ngrok shows its free-plan browser notice, continue through it. A visit to the tunnel root or `/api/me` should return 404: only the callback is exposed.

6. Open Gather **Settings → Continue with Google** in the original phone/browser holding your characters. Google returns through the HTTPS callback and then back to that browser's original LAN/localhost address. A separate HttpOnly browser cookie must match before the server links or switches a profile. Signing in on a fresh device should recover the same characters and campaign seat. Each player uses their own Google account.
7. Keep the callback tunnel running whenever a player needs to sign in. Existing sessions and LAN gameplay continue without it. Changing the tunnel domain requires updating both the Google client redirect URI and `.env`, then restarting Gather. Restarting during sign-in cancels that attempt; restart sign-in from Settings.

Google sign-in remains unavailable until these settings exist. Automated tests use signed test tokens and mocked Google responses; live Google authorization still needs validation with the configured client/domain.

References: [Google OAuth redirect rules](https://developers.google.com/identity/protocols/oauth2/web-server#redirect-uri-validation-rules), [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect), [ngrok setup](https://ngrok.com/docs/start). The free ngrok plan has service limits and a browser notice; see [current plan details](https://ngrok.com/pricing).

### Hosting approach: local now, a server later

The current target is a garage game: the laptop runs Gather, the TV shows **Shared screen**, and each phone opens its own player view over Wi-Fi. The leader keeps a separate tab with campaign controls. Internet access is used for ChatGPT and Google sign-in; ngrok carries only Google's callback.

ngrok is an external transport, not an application dependency. `GOOGLE_REDIRECT_URI` accepts an HTTPS domain independently of the tunnel provider. The main server also implements `/auth/google/callback`, so a future HTTPS deployment can handle the same flow directly. `GATHER_PUBLIC_URL`, `HOST`, `PORT`, and `GATHER_DATA_DIR` already keep addresses and storage location out of gameplay logic. Google identities map to stable database player IDs rather than a device or hostname.

The smallest future hosting move is one persistent Node process behind HTTPS, with a persistent volume for SQLite and protected credentials. Keep the browser and API on the same origin, preserve the existing database/player IDs, update the public URL and Google redirect registration, and verify sign-in and live event streams on the new domain. Browser sessions do not transfer across domains; Google sign-in restores the saved profile.

Before public hosting, replace reliance on loopback access for host administration with explicit authorization, decide whether the server serves one trusted group or multiple isolated groups, and review the AI connection's supported deployment/authentication flow. Configure secure cookies and proxy handling for the actual HTTPS setup. These are deployment changes still to implement and test, not a claim that the current LAN server is ready for the public internet.

Multiple server processes or serverless hosting would additionally require moving OAuth attempts, live-event fan-out, and turn-worker coordination out of process memory, plus replacing local SQLite where persistent shared storage is unavailable. Keep those changes deferred until the chosen hosting target requires them; the rules engine and player screens can remain intact.

## Characters and game rules

The application implements the reference's core loop with these explicit multiplayer/software adaptations:

- STR, DEX, INT start at 5 plus custom traits. Modifier: `floor((stat - 5) / 2)`. Traits have validated balance limits, equipment restrictions, immunities, and supported mechanical effects. Species, traits, and ability descriptions are generated from the player’s concept.
- Saved templates remain reusable. Joining makes an independent campaign character with its own HP, XP, level, gold, inventory, equipment, and conditions. A death is permanent within that run; reusing the template in a new campaign creates a fresh life.
- Starting HP is `20 + 2 × STR modifier`, plus trait adjustments. Every 100 XP grants a level, five maximum/current HP, and one reward choice: a new combat ability, a new utility ability, an upgrade to a random combat ability, an upgrade to a random utility ability, or two random attribute points. The server rolls upgrade targets and attributes; ChatGPT generates the chosen reward and saves it to that campaign character. Failed generation does not spend the reward. Players must resolve pending rewards before acting again.
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

There is no API-key billing path, and the app does not read Codex credentials or browser session tokens. The Settings badge confirms sign-in only; it does not guarantee generation is available. Account eligibility and subscription limits still apply. A provider failure saves the turn for retry.

**Live verification:** sign-in, model discovery, streamed character text, and a real usage-limit response have been observed with the connected account. This exposed an empty terminal output envelope; the adapter now assembles completed output-item events and accepts them only after successful completion. Regression tests cover that stream format. A fresh successful generation endpoint request and live group turn remain pending because OpenAI returned `subscription_sharing_usage_limit_exceeded`. The user’s usage screen still shows remaining allowance and Gather enabled at 100%; the applicable upstream limit is unconfirmed. This code must not be interpreted as proof that the entire subscription is exhausted. Token refresh remains unverified live. The host's connected account supplies character generation and game turns for players without their own connection, including the standalone character library. Player settings show that shared connection without exposing the host's email or credentials. Only the connected host can disconnect it. An existing single account is adopted automatically; new host sign-ins set the shared connection.

## Persistence

SQLite stores player profiles, character templates, campaign configuration, per-run character state, turns, actions, rolls, items, public journal, and event receipts. Provider credentials are stored separately under `data/credentials/` with owner-only file permissions. The data directory is ignored by Git.

Browser cookies identify local players. There is no password recovery or cross-device identity transfer yet. Use the same host URL consistently; `localhost`, `127.0.0.1`, and LAN addresses have distinct cookies.

Stop the server before copying the data directory for backup, or use SQLite's online backup facilities. JSON export excludes credentials and invitation/display secrets. In-app import/restore is not implemented. Recent context uses the last 12 summaries and the public journal; long-campaign retrieval remains future work.

## Development skill

[Ponytail](.agents/skills/ponytail/SKILL.md) is installed for this repository in `.agents/skills/ponytail`, which [Codex discovers automatically](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills). Invoke it with `$ponytail` in Codex; use `$ponytail lite`, `$ponytail full` (default), or `$ponytail ultra` to choose the intensity. Say `stop ponytail` or `normal mode` to turn it off for the session.

The skill is copied unchanged from [DietrichGebert/ponytail at `e3ba2aa`](https://github.com/DietrichGebert/ponytail/tree/e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156/skills/ponytail), with its [MIT license](.agents/skills/ponytail/LICENSE).

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
