# DiceVision Foundry VTT Module - Development Guide

## Overview

This repository contains a Foundry VTT module that connects to DiceVision's WebSocket bridge and posts physical dice roll results to Foundry's chat.

**Status:** Phase 1 (Chat Mode) code exists but has not been reviewed or tested in Foundry. It was originally PR #107 in `wor101/dice-vision` and moved here on 2026-10-14.

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
│   └── settings.js           # game.settings registration (all client-scoped)
├── templates/
│   └── chat-message.hbs      # Chat card template
├── styles/dicevision.css     # Chat card styling
├── lang/en.json              # Localization strings (DICEVISION.*)
├── README.md                 # User documentation
├── CLAUDE.md                 # This file
├── LICENSE                   # MIT License
└── .gitignore
```

No build step — Foundry loads `scripts/module.js` directly as an ES module.

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
{ "type": "roll", "session_code": "XKRM4N7B",
  "data": { "dice": [{"type": "d20", "value": 15}], "total": 15, "roll_id": "uuid", "timestamp": "..." } }
{ "type": "waiting", "session_code": "...", "app": "codex" }
{ "type": "cancelled", "session_code": "..." }
{ "type": "pong" }
{ "type": "error", "message": "..." }
```

The server closes with code `4001` for an invalid session — don't reconnect on that.

### Messages Sent (Client → Server)

```javascript
{ "type": "waiting", "app_id": "foundry" }   // Phase 2: waiting for a roll
{ "type": "cancel", "app_id": "foundry" }    // Phase 2: cancel waiting
{ "type": "ping" }                            // Keep-alive, every 30s
```

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

## Testing Checklist

- [ ] Module loads with no console errors (v12 and v13)
- [ ] Connect with valid session code (with and without dash)
- [ ] Connect with invalid session code → error notification, no reconnect loop
- [ ] Mode `off` → rolls ignored; mode `chat` → rolls appear in chat
- [ ] Chat visibility: Everyone / GM Only / Only Me
- [ ] Changing session code in settings reconnects
- [ ] Auto-reconnect after connection drop
- [ ] Single die, multiple same type (3d6), mixed types (1d20 + 2d6)
- [ ] All die types: d4, d6, d8, d10, d12, d20, percentile

## Deployment

1. Update `version` in `module.json`
2. Make the repo public (required for the manifest URL to work)
3. Zip the module contents (`module.json` at the zip root) as `module.zip`
4. Create a GitHub release and attach both `module.json` and `module.zip`
5. (Optional) Submit to the Foundry package listing
