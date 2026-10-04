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
4. Choose a saved character or describe a concept for ChatGPT. Enter an optional **Character name** to preserve your chosen name through generation and regeneration; it can also be edited before saving. In the character library, optionally select **Campaign context** from campaigns you lead or have joined. Generation uses that campaign’s setting, premise, tone, language, and custom world details to shape the character and equipment, using its selected model. Characters created from an invite or campaign already use that campaign’s context. The result is a read-only character sheet with two traits, two in-combat ability offers, and two out-of-combat ability offers. Select one ability of each kind and exactly two starting pieces from five dice-rolled, equippable offers, then save. Combat offers have different effects; server dice favor the concept’s combat affinity and vary ability power. The final scaling attribute is chosen after each effect is rolled, matching the concept and how the ability works. Cards show the actual damage/healing range and average using the character’s attribute, plus how steady or swingy the dice are. Generating a new draft clears its selections; failed generation preserves the previous draft. Types may repeat; spare pieces that share a slot go in the backpack. Generation uses the leader's connection, shows elapsed time, and can be cancelled. Errors and usage-settings links appear beside Generate; failures preserve the previous result and selections. Generation times out after two minutes.
5. Each player opens their **player view** under **Prepare your character**. Saved equipment picks are applied on joining; older templates without picks require two selections. **Review my character** shows the sheet and allows regenerating from a concept before the story starts. The readiness list names players who still need to choose. The leader selects **Begin the story**. **Shared screen** includes read-aloud controls and links back to player/leader controls for game actions.
6. Players describe their actions or pass. The GM accounts for relevant effects in the current turn and describes their impact and cause in the story's tone. After resolving consequences, an optional brief open-ended question may invite the normal next-turn action without suggesting actions or giving a menu. Consequences and turn completion never wait for extra confirmations or submissions; players decide freely, and the GM fills unspecified details in their submitted actions. Submissions appear immediately on the display. While the turn is collecting, **Cancel action** removes your submission and ready status, preserves your draft, and lets you rewrite; the group waits until you submit again. Cancellation closes once processing starts. Once everyone in the turn's roster has submitted, the dungeon master resolves the group turn.
7. Reopen the campaign to continue later. **New run from this world** copies its parameters into an editable new campaign.

The host chooses **GM output language** when creating a campaign and can change it between turns on the leader's campaign page. Choose **Nederlands** for Dutch narration, dialogue, summaries, journal entries, and generated descriptions, or **English** for English output. Core mechanics terms such as STR, DEX, INT, HP, XP, attack, strike, damage, defense, and advantage stay in English in either language. Existing character/item names and saved turns keep their original text. Character and level-up generation use the campaign language too.

The story shows one completed turn at a time. **Previous turn** and **Next turn** browse earlier scenes; **Current turn** returns to the latest scene and live actions. The current view follows new turns automatically, while browsing an older scene keeps it selected. Combat runs in three steps: the GM interprets the submitted actions, the server resolves the entire round, and the GM narrates the saved results. Vague prompts can resolve through reasonable details within the player's intended action. Ordinary attacks use equipped weapons when possible; unspecified enemy targets are chosen randomly from living enemies still fighting when the action executes. Explicit unarmed attacks and named targets are preserved. Normal attacks, strike abilities, and off-hand attacks redirect if their target falls or withdraws earlier in the same round: an explicitly named backup comes first, then the first living enemy still fighting. Explicit target restrictions such as "attack only the captain" prevent redirection. If no enemies remain, unused attacks are skipped without spending unused strike charges; submitted healing still resolves. Creative maneuvers and ally support keep their original targets. Movement and roleplay have their own resolution and never default to weapon attacks. Narration covers every recorded combat event and each player's noncombat action, including misses, failed checks, and interrupted actions. Each event uses one immersive account of its attempt and result. A separate model review checks generated event prose against the saved facts; rejected, missing or incomplete details use the factual paragraph alone. This adds one review request when event prose is present; model review is not a deterministic semantic guarantee. Longer narration gives action details priority over atmosphere and reserves room for later actors. If interpretation remains malformed, the server uses supported defaults; if narration remains malformed, the saved combat log completes the turn. Connection failures preserve the turn for retry. Selected utility checks are still validated before narration is accepted.

Use **Copy image prompt** on the scene you are viewing to copy JSON with an image request, campaign setting and tone, saved narration, and player actions. Paste it into ChatGPT to create an illustration of that scene. This also works for the opening and earlier turns. If the browser blocks clipboard access, a selected JSON field appears for manual copying.

The separately labelled **Practice table** is an offline rules rehearsal. It uses your supplied setting, character templates, and actual local dice, with a simple scripted check resolver. It provides a labelled practice character and scripted level-up rewards; it does not invent an adaptive world. It is never a fallback for a failed ChatGPT request.

On the leader's campaign page or **Shared screen**, select **Read latest turn**, or replay an older turn with its **Read turn** button. **Stop reading** ends playback. **Narrator voice** uses the campaign language by default and offers the browser's available voices. Narration reads only the completed story text and plays through the device where you select Read, including a TV browser opened with a shared display link. Playback does not start audio on other devices. No extra account or API key is needed. Some browser voices use an online service, so offline availability and voice quality depend on the chosen voice. Browser speech is isolated in `src/useNarration.ts` so a future narration service can replace playback without changing turn generation.

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

- STR, DEX, INT, CHA, CON, WIS start at 5 plus custom trait deltas from -5 to +8, with final starting scores from 0 to 13, including compensation. The server rolls a budget of zero to two mechanical drawbacks: each distinct blocked slot, reduced attribute, heavy-equipment restriction, special healing mode, or negative HP adjustment counts once. Each minor drawback receives one compensation unit; major drawbacks (body armour or hand restrictions, attribute penalties of at least 3, or HP penalties of at least 3) receive two. Each unit gives a full modifier increase through one or two random attribute points, or +1 power on both combat offers. Attribute compensation respects the score cap and keeps reduced attributes below baseline; if no useful increase fits, it boosts both combat offers instead. The sheet shows severity, points, and modifier gains. Earlier saved compensation remains unchanged. Compensation appears on the sheet, persists across campaigns, and stays within stat/power limits. Generation favors concept-fitting strengths and, when the budget allows, weaknesses, without a fixed stat total. Modifier: `floor((stat - 5) / 2)`. Traits retain limits on HP, defense and regeneration, equipment restrictions, healing compatibility, immunities, and supported mechanical effects. Gear, traits and abilities can compensate for weaknesses. Species, traits, and ability descriptions are generated from the player’s concept.
- Saved templates remain reusable. Joining makes an independent campaign character with its own HP, XP, level, gold, inventory, equipment, and conditions. Each character's death is permanent. While survivors continue, a dead player can queue a saved character with two chosen starting items or create a new one for the next turn after a successful encounter.
- Starting HP is `20 + 2 × CON modifier`, plus trait adjustments. Every 100 XP grants a level, five maximum/current HP, and one reward choice: a new combat ability, a new utility ability, an upgrade to a random combat ability, an upgrade to a random utility ability, or two random attribute points. The server rolls upgrade targets and attributes; ChatGPT generates the chosen reward and saves it to that campaign character. Failed generation does not spend the reward. Players must resolve pending rewards before acting again.
- Equipment has left/right hand, body, head, and boots slots. Two-handed weapons occupy both hands. Backpack capacity is eight slots; consumables stack three per slot, and equipped gear uses no backpack slots. Equipment controls show all slots, item comparisons, replacement/backpack previews, and explanations for unavailable actions. Players can take and equip loot together and select stacks to drop when space is needed. Gear changes are free and allowed only outside combat, before submitting an action; changes made during a turn are saved and included in its summary, including after retries. Selected starting equipment previews its equipped and backpack destinations.
- Equipped focuses grant +1 to matching attribute attack rolls; relics grant +1 to matching out-of-combat checks. Loot rarity can raise these bonuses to +3. Cards show the exact bonus and attribute; backpack items grant no bonus.
- Select **Use ability** on a card or request it in your action text, such as “use Cross Slash” or “use my ability to investigate the platform.” The GM matches the request to a saved ability; an explicit card selection takes precedence. Combat abilities cost the main action and have one tracked charge. Starting strike variants are `2d4 + 2` (steady), `2d6` (balanced), or `1d12` (swingy), with base averages of 7, 7, and 6.5. Mend variants are `1d4 + 2`, `1d6 + 1`, or `1d8`, all averaging 4.5 before attribute modifiers and compensation. Both effects add the saved attribute modifier and any compensation bonus. Card ranges and averages include these modifiers and the minimum-one rule; strike averages describe normal hits, excluding miss/critical chance, and healing averages precede the target’s HP cap. Guard grants +3 defense against the next enemy attack plus its rolled bonus; assist grants advantage and its rolled bonus on the next attack. Guard, assist, and utility offers can roll a base bonus of 0 or 1. Each upgrade preserves the original dice and base bonus while adding two damage/healing or one defense/attack/check bonus. Utility abilities grant advantage on a relevant check plus their saved bonus. Existing characters retain their original power (default strike 2d6 and mend 1d6). Every ability has a tracked charge; each successful encounter restores one spent charge to each ability up to its limit. Starting another encounter, resting or changing location does not reset uses. The server tracks uses, rolls effects, and saves results across reloads and retries.
- Attacks use d20 plus weapon scaling against defense. Damage uses actual dice plus scaling, minimum one. Hybrid equipment averages its two modifiers, rounded down. Natural 20 doubles damage dice; natural 1 causes a catastrophic setback. The narrator provides contextual consequences within the engine's state.
- Describe an attack without requesting an ability to make a normal weapon attack. The GM may choose a real equipped weapon; characters without usable weapons can attack unarmed. Abilities are consumed only when requested and executed. Unusable minor or support actions spend the action without stopping the round; the combat log explains the consequence, and unused items and ability charges are preserved.
- Item requests in chat, such as drinking a potion or healing an ally, consume one owned consumable and apply its saved healing. Mend requests spend the saved ability use. Healing and consumption stay together across reloads and retries, and narration cannot grant extra healing.
- Combat resolves in rolled initiative order. Each conscious player gets a main action and a minor action. Attack, defend, flee, movement, interaction, environmental damage, stun, and influence are supported. Movement and interaction preserve the submitted attempt, use a check only when the situation makes success uncertain, and leave enemies able to respond. Routine acts require no roll. Movement within the scene keeps the player in subsequent turns; explicitly fleeing can remove them from combat. Influence can make an enemy withdraw alive. Minor actions include self-healing and an explicitly requested off-hand attack with two light weapons; off-hand damage omits the stat modifier. **Help up** on a Downed member's card spends the helper's main action, restores exactly 1 HP and locks their prompt to the support action. Using a healing item on another member also spends the main action and uses the healer's inventory. Self-healing through the item controls applies immediately and keeps the normal prompt available.
- Defending adds two defense until the character's next action. The GM chooses a bounded difficulty for fleeing and creative actions. Healing types and anatomy restrictions are enforced by the server.
- Creative actions spend the main action and target one living enemy. The engine supports exactly three effects: improvised damage (`1d6 + chosen attribute modifier`, minimum one; natural 20 doubles the dice), stun (skip the enemy's next attack, then clear), and influence (the enemy withdraws alive). The GM chooses an attribute and DC 5/10/15/20; influence has a minimum DC of 15. Ordinary failure applies no effect; natural 1 causes 4 backlash damage before applicable condition effects. Creative actions do not currently grant temporary attribute changes, ally bonuses, enemy attack/defense penalties, or arbitrary ailments. Routine movement and interaction do not grant these effects either.
- On combat victory, each defeated enemy offers its saved loot. Minor enemies get one Common item with a 50% upgrade to Uncommon. Normal enemies get one Uncommon item with a 50% upgrade to Rare, plus a 50% chance of another item (Common/Uncommon/Rare: 60%/30%/10%). Elite enemies get one Rare item and two extras; bosses get one Legendary or Cursed item (50% each) and three extras. Elite/boss extras roll Common/Uncommon/Rare/Legendary at 50%/30%/15%/5%. Every enemy independently has a 50% chance of an additional Common healing item. Loot is rolled and saved when combat starts, with bounded power; item mechanics stay the same when dropped. Enemies that withdraw alive keep their items. Exploration can also offer custom loot. Players explicitly take, equip, stow, use, or drop items.
- Minor/normal/elite/boss enemies award 15/30/50/100 XP. Noncombat rewards are bounded at 40 XP per turn. Encounters and locations follow the ongoing story, with no numbered floors, fixed room counts or required bosses. Significant successful noncombat encounters use the same recovery and replacement timing as combat victories; a major DC 15+ achievement can grant boss-equivalent XP.
- Noncombat XP rewards meaningful discoveries, challenges, social successes and completed objectives once per achievement. Roll receipts appear before the GM narration. Narration omits XP and DCs; actual XP gains per character appear in **The situation** at the end of the turn.
- After each successful encounter, living members, including Downed members, recover `max(1, CON) + trait regeneration` HP up to maximum, and spent abilities regain one charge. Safe rest restores 25% maximum HP, rounded up, once per character between successful encounters when the GM makes it available. Combat conditions have tracked durations.
- The first reduction to zero HP in an encounter means **Downed**, including critical damage. A second downing in the same encounter permanently kills the character. Downed players cannot act or heal themselves; a conscious ally can spend their main action to help them up for exactly 1 HP without an item, or use compatible healing. A helped character may act from the next collecting turn, including self-healing and taking their normal action. During an encounter, rest, passive regeneration, level-ups and narration cannot help them up; server encounter recovery can. Healing cannot revive the dead.
- Dead players spectate until a queued replacement joins for the next turn after a successful encounter. The replacement starts at level 1 with full HP, level-1 abilities, fresh starting equipment, and no inherited XP, gold, loot, or conditions. Players can change or cancel their queue before activation; the queued sheet is saved independently of later library edits. The old character and their actions remain in campaign history. Sitting out remains an explicit leader decision. A party with no conscious survivor ends the run even if replacements are waiting; a Downed character remains alive. Dangerous noncombat actions resolve in the submitted turn without warning or acceptance prompts. Dangerous failures follow the same first-downing/second-downing rules.

On the host computer at `127.0.0.1`, **Settings → Ability choice statistics** shows offers, selections and pick rates grouped by kind, effect, scaling attribute, dice and saved base bonus. Counts come from current saved character templates: each template counts once, edits replace its choices, and campaign reuse adds no votes. Older templates without offers are excluded. The report contains no names, concepts or player identifiers and uses the existing local database, with no external telemetry. It measures saved preferences rather than combat performance. Attribute strengths and distinct utility scopes also influence these rates. Refresh the report after saving new choices. The read-only JSON endpoint is `/api/characters/ability-stats`, restricted to loopback requests.

The LLM receives the full reference plus the multiplayer contract, campaign parameters, character states, recent summaries, and public journal. It interprets natural-language actions and generates the world. Server tools own dice and mechanical mutations; unsupported bespoke abilities remain narrative until implemented as validated mechanics. Editing the reference requires a server restart, and changing numeric engine rules requires a corresponding code change.

At the opening and when characters, proximity, abilities, gear, or surroundings change, the GM considers interactions between character traits and the campaign's setting lore. Explicit campaign instructions and established facts override default lore. Established interactions have meaningful consequences in the current turn under supported rules, explained through sensory changes and their cause in the story's tone. Effects fit the actual scene and lore without arbitrary obstacles, penalties, or invented mechanics for drama. The GM preserves player decisions and saves public ongoing interactions and their circumstances in the world journal. Unclear lore or proximity does not justify invented certainty, ranges, or mechanical restrictions. An optional open question after resolving consequences invites the normal next-turn response; extra consent, confirmations, or reaction stages never gate consequences, submitted actions, or turn completion.

## Local dice and retry integrity

`server/random.ts` uses Node's built-in `crypto.randomInt`. There is no external randomness service, dice package, network dependency, model-chosen seed, or `Math.random` roll. Draws use the host's cryptographic entropy source and unbiased integer sampling.

This is **cryptographic randomness**, not a claim of directly measured physical true randomness. A hardware entropy source would be needed for that stronger guarantee.

Checks, initiative, attacks, damage, and loot rarity have saved receipts. The model cannot substitute its own result. Noncombat checks are limited to one immutable check per acting character per turn. Combat interpretations are saved before dice are rolled. Combat drafts and receipts survive provider failures and host restarts; retries reuse the chosen actions and completed mechanics instead of duplicating damage, rewards, or items. Completed state changes commit atomically.

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

Tests cover group readiness, duplicate submissions, solo turns, late joins, pause/sit-out, persistence, saved-roll retries, atomic failure recovery, custom trait balance, equipment, stacking, progression, permanent character death, replacement characters after successful encounters, nonviolent combat, loot ownership, access control, and provider stream failures. Browser tests cover character generation progress, cancellation, and errors. The multiplayer browser test uses a leader, two independent players, and an independent display, then checks the mobile layout.

This is a playable first version. Remaining work includes the live ChatGPT smoke test, wider group playtesting, richer bespoke item/enemy mechanics, long-campaign memory retrieval, invite revocation, player recovery, and in-app backup restoration. See [PLAN.md](PLAN.md). Source is available under [MIT](LICENSE).


Ailments now tick once per completed party turn in combat and exploration, including passes (the opening scene and failed retries do not count). The application turn counts, reapplication refreshes the counter, and saved durations stay valid. The HUD shows turns remaining plus each ailment's effect and main-action remedy. Bleeding/Burning/Shocked start at 3 turns, Poisoned at 4, and Chilled/Frozen/Electrocuted/Stunned/Weakened at 2. Downed and Escaped remain special states. See the status-effect table in [the gameplay rules](GAMEPLAYLOOPPROMPT.md#54-status-effects) for damage, penalties and remedies.

Reasonable environmental treatment can use a nearby blanket to smother fire, for example; a risky treatment needs a successful check. Generated combat strikes can inflict ailments, support abilities can cure them, and Mend can heal and cure together (or cure at full HP). Cleanse targets self or one living ally in or outside combat. Starting combat abilities have a 50% chance of an ailment effect, with Cleanse always receiving a cure; utility abilities remain check assists. Enemies also suffer inflicted ailments. These are turn-based adaptations inspired by [Path of Exile 2's ailments](https://www.pathofexile.com/forum/view-thread/3826682), with no stacking or real-time buildup.
