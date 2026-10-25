# DiceVision Foundry VTT Module - Development Guide

## Overview

This repository contains a Foundry VTT module that connects to DiceVision's WebSocket bridge. It either fills Foundry's own dice rolls with physical dice (Replace mode) or posts physical rolls to chat (Chat mode).

**Status:** Chat mode is released (v0.1.1) and tested on The Forge. Replace mode works on Foundry v14 with dnd5e 6 for `/roll` and dnd5e's `D20Roll` with advantage (tested locally against the live bridge; see Local End-to-End Testing). Rolls from a character sheet are not verified yet. The module was originally PR #107 in `wor101/dice-vision` and moved here on 2026-10-14.

## Architecture

```
DiceVision Camera → Backend → WebSocket Bridge → This Module → RollResolver.registerResult() (roll dialogs)
                                                                  / ChatMessage.create() (chat)
                              /api/bridge/{code}
```

The module:
1. Connects to `wss://dicevision.dirtyowlbear.com/api/bridge/{session_code}`
2. Receives `roll` messages with dice data
3. Fills an open roll dialog if one is waiting (see Replace mode below). Otherwise (Chat or Replace mode, dice button / continuous) builds a real Foundry roll (`buildRollData` → the system's roll class, `CONFIG.Dice.rolls[0]`) and creates a standard roll `ChatMessage` (public, GM-whisper, or self-whisper per settings). If any die can't be part of a Foundry roll (or `Roll.fromData` throws), the whole roll falls back to `templates/chat-message.hbs`

## Modes

| Mode | Description |
|------|-------------|
| Off | Nothing posted to chat; only dice set to DiceVision in Core › Dice Configuration are filled |
| Chat | Physical rolls appear as chat messages (dice button / `/dv roll`, or continuous mode) |
| Replace | Foundry's own rolls (`/roll`, system rolls like dnd5e attacks) wait for physical dice. The dice button and continuous mode still post other rolls to chat; a waiting roll dialog takes a roll first |

### Replace mode (`roll-intercept.js`, `dice-matching.js`)

Built on Foundry's dice fulfillment API (v12+), not a `/roll` patch, so it covers every `Roll.evaluate()`. Modeled on the Codex mod's `buildForcedDice`, with one difference: a partial match is fine here.
- Registers `CONFIG.Dice.fulfillment.methods.dicevision` (`interactive: true`). In Replace mode **while a session is active** (`getState().sessionActive`: connected, connecting, or waiting to reconnect), sets `CONFIG.Dice.fulfillment.defaultMethod = "dicevision"`. Foundry resolves `config[denomination] || config.default || defaultMethod`, so Core › Dice Configuration still wins, per die or through its Default selector.
  - It's kept through a reconnect, so a brief drop doesn't quietly turn rolls digital: the dialog says DiceVision isn't connected.
  - An explicit disconnect, an invalid session (4001), giving up after 5 retries, or leaving Replace mode restores the previous `defaultMethod` (another module's, or `""`). After that, rolls are digital and no dialog opens, except for dice set to DiceVision in Dice Configuration.
- Foundry then opens its own `RollResolver` dialog and pauses the roll. The module tracks open dialogs via the `renderRollResolver`/`closeRollResolver` hooks and is a roll consumer (`client.addRollConsumer`). It wants a roll while any dialog has an empty, enabled `label[data-method="dicevision"] > input` for a die the camera can read. This works in any mode, so per-die Dice Configuration works in Off and Chat mode too.
  - Each roll is matched with `matchDice()` and entered with `app.registerResult()`. Rolls a consumer takes are never posted to chat.
  - `registerResult` → `_checkDone()` auto-submits once every read-only slot is filled, and only if the dialog has no manual-entry dice. Explode/reroll rows submit through their own arrow button instead.
  - A `false` from `registerResult` counts the die as unused. If filling throws, an ApplyFailed toast is shown and the dialog keeps waiting. Each dialog's update is caught separately, and `client.sync()` always runs.
- The status line only goes into dialogs with DiceVision dice. A roll that arrives after the dialog closed (we were registered, nothing wants it) gets a RollIgnored toast.
- Dice arrive as `{type, value, face, readable}` (dice-vision PR #420). `readDice()` in `dice-matching.js` reads them, falling back to `value` for older servers, and the client runs every roll through it on arrival. `face` is the face as printed ("00", "0", "10", "pip_4"); `value` gives "00" and "0" both as 0, so percentile logic reads `face`.
- Matching: by die type, any order. A d10 showing 0 counts as 10. For a d100 slot, a percentile pair is a tens die (face "00", 10..90) plus a units die (face "0".."9"), with 00 + 0 = 100. Only for dice from a server that sent no faces (`legacy`), a d10 "0" stands in for "00" when no tens die is left; with faces it never does, since the "00" may be the unreadable die. Out-of-range or extra dice are not used: a warning toast plus a notice in the dialog, and the dialog keeps waiting. Unreadable dice (`readable: false`) fill nothing and are reported the same way (`Fulfillment.CouldntRead`, counted like "2d8") while the roll still wants their type; otherwise `matchDice` returns them as `ignored`, without a warning. `dropCarriedOver` never takes them as left on the table. `readDice` turns malformed entries (null, no type) into unreadable `d?` dice and a non-array into no dice, so a bad message goes through the normal re-arm path.
- Explode/reroll add inputs without a re-render; a `MutationObserver` (new inputs only, to avoid reacting to our own status text) triggers a re-check.
- Die types DiceVision doesn't support (anything not in `SUPPORTED_DICE`, e.g. d3, coins) are rolled digitally straight away (`Fulfillment.Unsupported`). Don't confuse this with an unreadable die (`Fulfillment.CouldntRead`), which needs a reroll.
- Digital fallback for a camera problem: the dialog's **Submit** rolls whatever is still empty digitally (first pass). `Roll._evaluate` then closes the dialog, which releases the bridge.
  - Explode/reroll dice are added later by `resolveResult()`, after Submit has been disabled by `_toggleSubmission(false)`. Each one has its own arrow button, and the status line says so (the `…Extra` strings).
  - Closing the dialog with X while such a die is pending leaves the roll unresolved. That's core behaviour.
- No dialog when core skips interactive fulfillment: blind `/roll`s, `Roll#toMessage` in blind mode, `allowInteractive: false`, minimize/maximize. Systems that evaluate first still open it for blind rolls; dnd5e's sheet rolls call `roll.evaluate()` without `allowInteractive`.

### Sidebar panel (`sidebar-tab.js`, `templates/sidebar-tab.hbs`)

A camera tab in the sidebar's tab bar, registered the way Dice So Nice registers its d20 tab (Foundry v13+ API; on v12 `registerSidebarTab` logs and returns false, leaving Game Settings and `/dv connect`):
- `CONFIG.ui.dicevision` is a `HandlebarsApplicationMixin(AbstractSidebarTab)` subclass, and `CONFIG.ui.sidebar.TABS.dicevision = { icon, tooltip }` is inserted just before `settings` (delete and re-add `settings` to keep the order). Both in `init`; Foundry instantiates `ui.dicevision` itself. Right-click pops the tab out (core behaviour; the popout is a second instance, so element ids use `this.id`).
- The `icon` is a CSS class string: any Font Awesome 6 Free class Foundry bundles, or a module-defined class that draws its own SVG (e.g. `mask-image`).
- Not connected: session code field + Connect, through `connectWithCode()` (shared with `/dv connect`; a bad code marks the field and toasts `Commands.InvalidCode`). With a session active (`sessionActive`): status line (`panelStatus()`, pure), Roll / Continuous / Disconnect buttons (same client calls as the chat buttons), and the settings as a form that saves each `change` through `game.settings.set`, so the settings' `onChange` hooks still drive the client. `diceSoNice` is world-scoped, GM only.
- `dicevision.stateChanged` re-renders the panel (if rendered) and tints the tab button (`dicevision-connected` / `dicevision-reconnecting`) and lights its `.notification-pip` while waiting for dice. A half-typed session code survives the re-render: `_prepareContext` reads the current input, `_preRender` notes focus. `closeSettingsConfig` re-renders too, in case Game Settings changed a value.
- `getState()` has `reconnectAttempt` and `reconnectMax` for the "Reconnecting (n/5)" status.

### Dice So Nice! (`dice-so-nice.js`, `roll-data.js`)

Dice So Nice animates from the results saved in the chat message, so 3D dice land on the physical values with no forcing (unlike Codex's forcedDice). Two things would stop it, and interactive throws would ask for physical dice again; all handled while the **`diceSoNice`** world setting is on (default) and Dice So Nice is active:
- **Replace mode.** Dice So Nice skips a message when every die's `method` is interactive ("Disabled for manually entered rolls", default on), and `dicevision` has to be interactive for the dialog to open.
  - `DiceTerm#method` is write-once, so it can't be changed on the roll. Instead, a `preCreateChatMessage` hook on the roller's client strips `method: "dicevision"` from the message's saved rolls (`stripMethod`) before the message is saved. Every client then sees ordinary dice.
  - A second, non-interactive method isn't an option: Core › Dice Configuration lists every registered method.
- **Physical mark.** `roll-intercept.js` counts each camera fill on its term as `term.options.dicevision = { physical: n }`. It finds the input `registerResult` will fill (the first empty one of that type) and looks up its term via `app.fulfillable`. Digital fills (Submit, unreadable dice) aren't counted. Term options are saved with the roll.
- **Interactive throws.** Dice So Nice stamps a public roll for a mouse throw without looking at the method. So if any Replace-mode die was physical, the hook also sets `flags.dice-so-nice.interactive = false` (Dice So Nice's "never" flag) and clears a pending `interactiveThrow` stamp (its own `preCreateChatMessage` hook runs first). Chat-mode roll cards get the same flag in `dice-bridge.js`.
- **Hook scope.** The hook runs for every message the user creates, so it returns unless the message's rolls have a `dicevision` die, and catches its own errors (the roll still posts, as a manually entered one).
- **Fill safety.** `nextInput`/`markPhysical` are wrapped in the fill loop, so a marking failure never stops a die being entered; a missing term is logged.
- **Chat mode.** `buildRollData` turns the camera's dice into `Roll` data: one `Die` per type in read order, d10 0 → 10, a tens die (face "00", 10..90) + units die → d100, so 00 + 0 is 100. An unpaired "10" (a d10 printed 1–10) or "00" is a plain d10 of 10; those two pair last. "10" + a units die stays a d100: it can't be told from a percentile roll. 00 + 0 → 100 needs face strings; Chat mode has no "0"-for-"00" fallback. A roll with an unreadable die, or no dice, isn't posted: the client warns (`Notifications.CouldntRead` / `EmptyRoll`, once until a usable roll, so continuous mode doesn't warn on every capture) and keeps the request waiting. The roll is made with the system's own roll class (`CONFIG.Dice.rolls[0]`: dnd5e's `BasicRoll`, Shadowdark's `RollSD`), so the card uses the system's template: a core `Roll` card in Shadowdark had its total pushed out of view. `trySystemRoll` checks that roll first, because later failures happen after the message is saved and leave a card that never appears. The checks: it's evaluated, its total is the camera's, it reloads as the same class from its saved data (`fromData` finds the class by the data's `class` name), and it draws both public and private. If any check fails, core `Roll` is used, with a console warning that the card may not display right in that system. `buildRollData` returns `null` if any die can't be rolled; that, or core `Roll` rejecting the data too, makes the whole roll fall back to the template card, with a console line saying why. With the setting off, the message gets `flags.dice-so-nice.skip`.
- **Tooltip.** Foundry only shows a method icon for interactive methods, so `renderChatMessageHTML` (v13+; no icon on v12) puts the camera icon on tooltip parts whose term is marked physical.
  - Core's tooltip: the icon goes in `.part-header`. dnd5e sets `Roll.TOOLTIP_TEMPLATE` to its roll breakdown, which shows method icons first in each part's `.dice` and adds `.constant-term` parts for modifiers; those are skipped.
  - When the dice parts don't line up with `roll.dice`, the tooltip is left alone (console.debug).
  - `dsn.mjs` checks both core's `templates/dice/tooltip.hbs` and the system's own render.
- Whispered Chat-mode roll cards are private rolls: other players see "rolled privately", and Dice So Nice shows them ghost dice (per its settings). The fallback card stays hidden from them.

## Reference Links

### Foundry VTT Documentation
| Resource | URL |
|----------|-----|
| API Reference (v13) | https://foundryvtt.com/api/ |
| Module Development | https://foundryvtt.com/article/module-development/ |
| Manifest (package.json/module.json) | https://foundryvtt.com/article/manifest/ |
| Settings | https://foundryvtt.com/article/settings/ |
| Dice & Rolls | https://foundryvtt.com/article/dice/ |
| Community Wiki | https://foundryvtt.wiki/en/development |

### DiceVision Backend
| Resource | URL |
|----------|-----|
| WebSocket Bridge Endpoint | `wss://dicevision.dirtyowlbear.com/api/bridge/{session_code}` |

## Project Structure

```
dicevision-foundry/
├── module.json               # Foundry manifest (id: "dicevision")
├── scripts/
│   ├── module.js             # Entry point: init/ready hooks, public API
│   ├── dicevision-client.js  # WebSocket client singleton, reconnect, roll consumers
│   ├── roll-intercept.js     # Replace mode: fulfillment method + RollResolver integration
│   ├── dice-matching.js      # Pure: physical dice → open roll slots
│   ├── dice-bridge.js        # Chat mode: physical dice → roll ChatMessage
│   ├── roll-data.js          # Pure: Chat-mode Roll data, strip the dicevision method
│   ├── dice-so-nice.js       # Dice So Nice: preCreateChatMessage strip, tooltip camera icon
│   ├── chat-controls.js      # Chat sidebar buttons + /dv commands (v14 passes the hook HTML: plainText())
│   ├── sidebar-tab.js        # Sidebar camera tab (v13+): connect form, status, roll buttons, settings
│   └── settings.js           # game.settings registration (client-scoped, except world-scoped diceSoNice)
├── templates/
│   ├── chat-message.hbs      # Fallback chat card (dice Foundry can't roll)
│   └── sidebar-tab.hbs       # Sidebar panel
├── styles/dicevision.css     # Fallback chat card, chat buttons, roll-dialog status, sidebar panel
├── lang/en.json              # Localization strings (DICEVISION.*)
├── tests/client.test.mjs     # Client tests: node tests/client.test.mjs
├── scripts-dev/              # Release helpers, fake-dashboard.mjs, e2e/ (Playwright)
├── .github/workflows/        # tests.yml — lint + test on PRs; release.yml — tag → GitHub release
├── .github/dependabot.yml    # Weekly npm + Actions bumps (7-day cooldown)
├── package.json              # Dev tooling only (ESLint); not shipped
├── eslint.config.js          # Flat config with Foundry globals
├── docs/SYSTEM_COMPATIBILITY.md  # Game system / module checklist
├── README.md                 # User documentation
├── CLAUDE.md                 # This file
├── LICENSE                   # MIT License
└── .gitignore
```

No build step — Foundry loads `scripts/module.js` directly as an ES module.

Run the client tests with `node tests/client.test.mjs` or `npm test` (mocked Foundry globals, no install). Leave `tests/` out of release zips.

Lint with `npm ci` once, then `npm run lint`. The module itself has no npm dependencies; `package.json` only holds ESLint. A Foundry global the module starts using goes in `foundryGlobals` in `eslint.config.js`.

### CI and branch protection

`.github/workflows/tests.yml` runs two jobs on every PR and push to `main`:
- **`lint`**: ESLint, and JSON validity of `module.json` and `lang/*.json`.
- **`test`**: the client tests, and a dry-run release build (stamp + zip) that checks `module.json` is at the zip root and no dev files are packed.

The **Main** ruleset on `main` (same as the Codex repo) blocks deletion and force pushes, and requires a PR with 1 approval, resolved review threads, and passing `lint` and `test` checks on an up-to-date branch. Repository admins can bypass it, which is how a solo maintainer merges their own PRs. Renaming either job breaks the required check, so update the ruleset too.

## WebSocket Protocol

Source of truth: `backend/app/routers/bridge.py` in `wor101/dice-vision`.

### Session Code Format

- **Length**: 8 characters
- **Character set**: `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (excludes ambiguous 0/O/1/I/L)
- **Display format**: `XKRM-4N7B` (dash after 4th character for readability)
- **Normalization**: Uppercase, strip dashes before use (e.g., `xkrm-4n7b` → `XKRM4N7B`)

### Messages Received (Server → Client)

```javascript
{ "type": "connected", "session_code": "XKRM4N7B", "waiting": false, "waiting_apps": [] }
{ "type": "roll", "session_code": "XKRM4N7B", "timestamp": "...",
  "data": { "dice": [{"type": "d20", "value": 15}], "total": 15, "roll_id": "uuid" } }
{ "type": "waiting", "session_code": "...", "app": "codex" }
{ "type": "cancelled", "session_code": "...", "app": "foundry" }   // broadcast to the whole session
{ "type": "no_dice", "session_code": "..." }   // dice-vision#415+: dashboard saw no dice; waiting unchanged
{ "type": "pong" }
{ "type": "error", "message": "..." }
```

- `timestamp` is set by the bridge on the outer `roll` message. The dashboard's `data` has none, and `roll_id` may be missing.
- **Treat the session as live only after `connected`.** Once dice-vision#407 is deployed, the server accepts the socket and *then* closes invalid sessions with `4001`, so `onopen` fires for bad codes too. Before #407, invalid sessions are rejected with HTTP 403, which browsers report as close code `1006`. Don't reconnect on `4001`.

### Messages Sent (Client → Server)

```javascript
{ "type": "waiting", "app_id": "foundry" }   // A roll is wanted: requestRoll(), continuous mode, or an open roll dialog
{ "type": "cancel", "app_id": "foundry" }    // No roll wanted any more (only if we sent "waiting")
{ "type": "ping" }                            // Keep-alive, every 30s
```

**The dashboard only forwards a roll while it believes an app is waiting**, and it drops that local flag after each roll it sends. The bridge itself keeps the app in `waiting_apps`.

**While an app is waiting, the dashboard switches to continuous capture** (`bridgeTriggeredMode` in the dashboard's `useVTTIntegration`, on by default via its "Send automatically" toggle). So the module only registers when it actually wants a roll (`_shouldWait()`), and `_syncWaiting()` doesn't resend `waiting` while `registered`:
- **Roll dialogs (any mode):** a dialog with empty DiceVision slots sends `waiting`. After each roll it re-sends `waiting` if slots are still empty. Once no dialog needs dice (filled, or closed with Submit), it sends `cancel`, unless continuous mode or a pending dice-button request still wants a roll.
- **Continuous mode off (default):** `requestRoll()` (dice button, `/dv roll`) sends one `waiting`. The request is used up by the first roll no roll dialog takes. A roll a dialog fills leaves it pending, and `waiting` is re-sent. Once the chat roll arrives, the module sends `cancel` (unless a roll dialog still wants dice) so the bridge forgets it too; otherwise a reloaded dashboard would see `waiting_apps: ["foundry"]` and re-arm.
- **Continuous mode on:** re-sends `waiting` after every roll, which keeps the dashboard capturing.
- Rolls nobody in Foundry asked for (another app on the same session was waiting) are ignored.
- `no_dice` (the dashboard found no dice while an app waits) is ignored unless we're `registered`. A waiting roll dialog shows it as a notice (no toast). A one-off chat request gets one toast per request. Continuous mode gets nothing, because every empty capture would toast. Nothing is sent back: the dashboard keeps capturing.
- A `roll` with no `data` re-arms (`registered = false`, `_syncWaiting()`): the dashboard dropped its flag when it sent it. A server `error` toasts once per distinct message.

**Any `cancelled` clears the dashboard for every app.** The bridge's `cancel` removes only the sender's `app_id` from `waiting_apps`, but it broadcasts `cancelled` to the whole session, and the dashboard (`useBridgeConnection`) then treats nobody as waiting, whatever the message's `app`. So:
- **Only send `cancel` if we registered (`registered`).** That avoids gratuitous cancels, but a needed one still clears Talespire's or Codex's request if they're waiting on the same session. For example, Talespire re-arms after a shared roll, then Foundry's release `cancel` arrives. The protocol has no per-app cancel, so this is a known limitation; give each app its own session code.
- **On `cancelled`, re-register if we still want a roll** (`registered = false`, then `_syncWaiting()`). Otherwise another app's cancel, or another Foundry user's on a shared code (both use `app_id: "foundry"`), leaves us shown as waiting while the dashboard never forwards a roll. The echo of our own cancel is harmless, because we only cancel when we no longer want a roll.
- **No `cancel` before disconnecting.** Since dice-vision#408, the bridge drops our registration when the socket closes, and only broadcasts `cancelled` if no other app is still waiting. An explicit cancel would always clear the dashboard.

## Development Workflow

### Local Testing

1. Start the DiceVision backend locally:
   ```bash
   cd /path/to/dice-vision/backend
   source ../dice-vision-env/bin/activate
   python -m uvicorn app.main:app --reload
   ```

2. Change `WS_BASE_URL` in `scripts/dicevision-client.js`:
   ```javascript
   const WS_BASE_URL = "ws://localhost:8000/api/bridge";
   ```

3. Symlink or copy this repo into Foundry's data directory as `Data/modules/dicevision/` (the folder name must match `id` in `module.json`)

4. Launch Foundry, enable the module in a world, and set the session code in **Module Settings**

### Debug Logging

All logs use the `[DiceVision]` prefix. Use the browser dev tools (F12) in the Foundry client.

The public API is available from the console:
```javascript
game.modules.get("dicevision").api.connect("XKRM4N7B");
```

### Local End-to-End Testing

A local Foundry server plus a fake dashboard lets you test against the live bridge without a camera:

- **Foundry** (Node.js build, licensed): v14 needs Node 24. Start it with `--noupnp`, since UPnP is on by default and asks the router to expose the port. `--world=dicevision-test` launches the world at startup, so the e2e scripts need no admin password. Symlink this repo to `<dataPath>/Data/modules/dicevision`, so edits apply on a page reload. A world can be created with `POST /create {action: "createWorld", id, title, system}` (admin session), then launched with `POST /setup {action: "launchWorld", world}`.
- **`scripts-dev/fake-dashboard.mjs CODE`**: joins a bridge session as the dashboard. It answers `waiting` with scripted dice (`--dice 1d20,2d6`; fixed faces `d20=17`, `d10=00`, `d6=pip_4`, or `d8=-1` for an unreadable die; a different roll each time `"d20=12;d6=2"`) and stops after `--max N` rolls. `--no-dice N` answers the first N requests with `no_dice`. It also reports `requests_after_last_roll`, the number of extra requests that would keep the real dashboard in continuous capture. The session code must exist, because the bridge validates it. Keep the real dashboard closed on that code.
- **`scripts-dev/e2e/continuous.mjs CODE`**: Playwright run against the local world as `Gamemaster` (the world also has a `Player` user for manual two-user tests; neither has a password). It checks the dice button, continuous mode and `/dv` commands.
- **`scripts-dev/e2e/replace.mjs CODE`**: Replace mode end to end: mixed dice in one roll, partial rolls, wrong dice, the `no_dice` notice (needs a bridge with dice-vision#415), exploding dice, percentile (including 00 + 0), an unreadable die and its reroll, a dnd5e advantage `D20Roll`, Mode Off with per-die Dice Configuration, Submit as digital fallback, and digital rolls while disconnected. Set `FOUNDRY_USER=Player` if someone is logged in as the GM (Foundry allows one session per user).
- **`scripts-dev/e2e/sidebar.mjs CODE`**: the sidebar panel: tab placement, connect form (malformed code refused), connect, settings saved from the form, the Roll button posting one roll and releasing the bridge, the tab pip, the Continuous toggle, the right-click popout, and Disconnect. Joins as `FOUNDRY_USER` (default Gamemaster).
- **`scripts-dev/e2e/dsn.mjs CODE`**: Dice So Nice end to end. Needs Dice So Nice in `Data/modules`; it enables it in the world and leaves it on, with Dice So Nice's "Disabled for manually entered rolls" on and DiceVision's mode Off. Joins as `FOUNDRY_USER` (default Gamemaster), which must be a GM. It records Dice So Nice's own animate decision (`diceSoNiceMessagePreProcess`), so it doesn't depend on WebGL. Checks:
  - a Replace roll (method stripped, marked physical, animates, tooltip icons in core's template and dnd5e's breakdown)
  - a Replace roll filled by Submit (digital: animates, no icon, throws allowed)
  - interactive throws "on", Replace and Chat
  - Chat-mode roll cards (d10 0, repeated types, a percentile pair, 00 + 0, a lone d10 10, an unreadable die and its reroll), public and GM-only
  - the setting off: Chat-mode cards are skipped, and Replace rolls are left to Dice So Nice's manual-roll setting
- Updating or reinstalling the module through Foundry's package manager (from the manifest URL) on the local server replaces the repo symlink with a real folder. Re-link it before testing a branch.
- `scripts-dev/e2e/foundry.mjs` documents the env vars (including `FOUNDRY_USER` for replace.mjs); `PLAYWRIGHT_MODULE` can point at an existing Playwright install, e.g. dice-vision's `frontend/node_modules/playwright/index.mjs`.

## Testing Checklist

- [ ] Module loads with no console errors (v12, v13, v14)
- [ ] Continuous off (no roll dialog open): no `waiting` until the dice button / `/dv roll`; one roll posted, then `cancel`
- [ ] Continuous on: every roll posted, `waiting` re-sent after each
- [ ] Connect with valid session code (with and without dash)
- [ ] Connect with invalid session code → "invalid session" error with dice-vision#407 deployed; before that, "Connection lost" after 5 retries. No "Connected" toast, no loop
- [ ] Mode `off` → no chat posts and no buttons (per-die Dice Configuration dialogs still fill); mode `chat` → requested or continuous rolls appear in chat
- [ ] `/dv` commands typed into the chat box (v14: rich-text editor)
- [ ] Sidebar camera tab (v13+): connect form when disconnected, settings once connected, right-click popout; v12 loads without it
- [ ] Replace: `/roll 2d20kh+1d6+3` opens the dialog, fills from one physical roll, posts the right total, then `cancel`
- [ ] Replace: partial / wrong dice keep the dialog waiting with a notice; Submit rolls the rest digitally (the arrow, for explode/reroll dice)
- [ ] Replace: dnd5e attack, damage and save rolls from a character sheet
- [ ] Replace after `/dv disconnect`: rolls are digital, no dialog. During a reconnect: the dialog opens and says not connected
- [ ] Mode Off with DiceVision for d20 in Core › Dice Configuration: only d20s open the dialog; no Mode Off toast on load
- [ ] Replace: dice button / continuous post to chat when no dialog is open; with a dialog open the dialog takes the roll and the button request stays pending
- [ ] Replace: roll only the missed die of an advantage roll, leaving the other in view: the new die fills the slot
- [ ] `no_dice` (dice-vision#415): dialog notice, or one toast for a dice-button request; nothing in continuous mode
- [ ] Replace mode with no session code / Auto-Connect off: warning on load; after giving up reconnecting: "rolls are digital" warning
- [ ] Chat visibility: Everyone / GM Only / Only Me (Chat mode only; Replace mode follows Foundry's roll mode)
- [ ] Changing session code in settings reconnects
- [ ] Auto-reconnect after connection drop
- [ ] Single die, multiple same type (3d6), mixed types (1d20 + 2d6)
- [ ] All die types: d4, d6, d8, d10, d12, d20, percentile
- [ ] Dice So Nice: Replace and Chat-mode rolls animate for every player and land on the physical faces; private and blind rolls follow Dice So Nice's rules; the setting off stops it

Per-system and per-module results (dnd5e, Shadowdark, Dice So Nice!, …) are tracked in `docs/SYSTEM_COMPATIBILITY.md`.

## Deployment

Releases are built by `.github/workflows/release.yml` when a `v*` tag is pushed:

```bash
git tag v0.1.1 && git push origin v0.1.1
```

The workflow runs the tests, then:
- **Stamps `module.json`** from the tag (`scripts-dev/stamp-manifest.sh`). It sets `version`, sets `download` to the tag's zip, and sets `manifest`.
  - Plain tags point `manifest` at `releases/latest`, so Foundry's **Update** button finds new versions.
  - Hyphenated tags (`v0.2.0-rc.1`) become GitHub pre-releases. `releases/latest` skips those, so their manifest is pinned to the tag.
- **Zips the module** (`scripts-dev/build-zip.sh`) with `module.json` at the root, leaving out `tests/`, `scripts-dev/`, `.github/` and `CLAUDE.md`.
- **Creates the GitHub release** with `module.json` and `module.zip` attached.

The `version` in the committed `module.json` doesn't matter, because the tag wins. Keep it roughly current for local installs.

**Testing on The Forge:** Bazaar → **Install From Manifest** → paste the manifest URL. The Forge world is served over HTTPS, so it can only reach the production backend (`wss://dicevision.dirtyowlbear.com`), not a local one. To test duplicate posting, invite a second user (a free Player account in another browser) into the world.

Optional, later: submit to the Foundry package listing.
