# DiceVision Foundry VTT Module - Development Guide

## Overview

This repository contains a Foundry VTT module that connects to DiceVision's WebSocket bridge and posts physical dice roll results to Foundry's chat.

**Status:** Phase 1 (Chat Mode) works on Foundry v14 (tested locally against the live bridge; see Local End-to-End Testing). It was originally PR #107 in `wor101/dice-vision` and moved here on 2026-10-14.

## Architecture

```
DiceVision Camera → Backend → WebSocket Bridge → This Module → ChatMessage.create()
                              /api/bridge/{code}
```

The module:
1. Connects to `wss://dicevision.dirtyowlbear.com/api/bridge/{session_code}`
2. Receives `roll` messages with dice data
3. Groups dice by type and renders `templates/chat-message.hbs`
4. Creates a `ChatMessage` (public, GM-whisper, or self-whisper per settings)

## Phases

| Phase | Mode | Description |
|-------|------|-------------|
| 1 | Chat | Rolls appear as chat messages |
| 2 | Replace (planned) | Foundry's Dice Fulfillment API waits for a physical die on `/roll` — `waitForResult()` in `dicevision-client.js` is scaffolded for this but unused |

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
│   ├── dicevision-client.js  # WebSocket client singleton, reconnect, roll callbacks
│   ├── dice-bridge.js        # Roll data → ChatMessage
│   ├── chat-controls.js      # Chat sidebar buttons + /dv commands
│   └── settings.js           # game.settings registration (all client-scoped)
├── templates/
│   └── chat-message.hbs      # Chat card template
├── styles/dicevision.css     # Chat card styling
├── lang/en.json              # Localization strings (DICEVISION.*)
├── tests/client.test.mjs     # Client tests: node tests/client.test.mjs
├── scripts-dev/              # Release helpers, fake-dashboard.mjs, e2e/ (Playwright)
├── .github/workflows/        # release.yml — tag → GitHub release
├── README.md                 # User documentation
├── CLAUDE.md                 # This file
├── LICENSE                   # MIT License
└── .gitignore
```

No build step — Foundry loads `scripts/module.js` directly as an ES module.

Run the client tests with `node tests/client.test.mjs` (mocked Foundry globals, no install). Leave `tests/` out of release zips.

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
{ "type": "cancelled", "session_code": "..." }
{ "type": "pong" }
{ "type": "error", "message": "..." }
```

- `timestamp` is set by the bridge on the outer `roll` message. The dashboard's `data` has none, and `roll_id` may be missing.
- **Treat the session as live only after `connected`.** Once dice-vision#407 is deployed, the server accepts the socket and *then* closes invalid sessions with `4001`, so `onopen` fires for bad codes too. Before #407, invalid sessions are rejected with HTTP 403, which browsers report as close code `1006`. Don't reconnect on `4001`.

### Messages Sent (Client → Server)

```javascript
{ "type": "waiting", "app_id": "foundry" }   // A roll is wanted: requestRoll(), continuous mode, or waitForResult()
{ "type": "cancel", "app_id": "foundry" }    // No roll wanted any more — only if we sent "waiting"
{ "type": "ping" }                            // Keep-alive, every 30s
```

**The dashboard only forwards a roll while it believes an app is waiting**, and it drops that local flag after each roll it sends. The bridge itself keeps the app in `waiting_apps`.

**While an app is waiting, the dashboard switches to continuous capture** (`bridgeTriggeredMode` in the dashboard's `useVTTIntegration`, on by default via its "Send automatically" toggle). So the module only registers when it actually wants a roll (`_shouldWait()`):
- **Continuous mode off (default):** `requestRoll()` (dice button, `/dv roll`) sends one `waiting`. After that roll is posted, the module sends `cancel` so the bridge forgets it too; otherwise a reloaded dashboard would see `waiting_apps: ["foundry"]` and re-arm.
- **Continuous mode on:** re-sends `waiting` after every roll, which keeps the dashboard capturing.
- Rolls nobody in Foundry asked for (another app on the same session was waiting) are ignored.

**Only send `cancel` if we registered (`registered`).** The dashboard treats any `cancelled` broadcast as "nobody is waiting", whatever its `app`, so a stray cancel would clear Talespire's or Codex's request on a shared session. The same applies to the cancel sent before disconnecting, which older backends needed because their disconnect cleanup never removed `"foundry"` from `waiting_apps` (fixed in dice-vision#408).

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

- **Foundry** (Node.js build, licensed): v14 needs Node 24. Start it with `--noupnp`, since UPnP is on by default and asks the router to expose the port. Symlink this repo to `<dataPath>/Data/modules/dicevision`, so edits apply on a page reload. A world can be created with `POST /create {action: "createWorld", id, title, system}` (admin session), then launched with `POST /setup {action: "launchWorld", world}`.
- **`scripts-dev/fake-dashboard.mjs CODE`**: joins a bridge session as the dashboard. It answers `waiting` with scripted dice (`--dice 1d20,2d6`) and stops after `--max N` rolls. It also reports `requests_after_last_roll`, the number of extra requests that would keep the real dashboard in continuous capture. The session code must exist, because the bridge validates it. Keep the real dashboard closed on that code.
- **`scripts-dev/e2e/continuous.mjs CODE`**: Playwright run against the local world (users `Gamemaster` and `Player`, no passwords). It checks the dice button, continuous mode and `/dv` commands. `scripts-dev/e2e/foundry.mjs` documents its env vars; `PLAYWRIGHT_MODULE` can point at an existing Playwright install, e.g. dice-vision's `frontend/node_modules/playwright/index.mjs`.

## Testing Checklist

- [ ] Module loads with no console errors (v12, v13, v14)
- [ ] Continuous off: no `waiting` until the dice button / `/dv roll`; one roll posted, then `cancel`
- [ ] Continuous on: every roll posted, `waiting` re-sent after each
- [ ] Connect with valid session code (with and without dash)
- [ ] Connect with invalid session code → "invalid session" error with dice-vision#407 deployed; before that, "Connection lost" after 5 retries. No "Connected" toast, no loop
- [ ] Mode `off` → rolls ignored; mode `chat` → rolls appear in chat
- [ ] Chat visibility: Everyone / GM Only / Only Me
- [ ] Changing session code in settings reconnects
- [ ] Auto-reconnect after connection drop
- [ ] Single die, multiple same type (3d6), mixed types (1d20 + 2d6)
- [ ] All die types: d4, d6, d8, d10, d12, d20, percentile

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
