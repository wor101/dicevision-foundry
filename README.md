# DiceVision — Foundry VTT Module

A Foundry VTT module that connects to [DiceVision](https://github.com/wor101/dice-vision), an AI-powered physical dice recognition system. Roll real dice in front of a camera and see the results appear in Foundry's chat.

## Requirements

- **Foundry VTT v12** or later
- A DiceVision account at [dicevision.dirtyowlbear.com](https://dicevision.dirtyowlbear.com)

## Installation

> **Beta:** 0.x releases are early test builds and haven't been widely tested yet.

1. In Foundry VTT, go to **Add-on Modules** → **Install Module**
2. Paste the manifest URL:
   ```
   https://github.com/wor101/dicevision-foundry/releases/latest/download/module.json
   ```
3. Click **Install**

**The Forge:** in the Bazaar, choose **Install From Manifest** and paste the same URL.

To install a specific pre-release, use its tag's URL instead, e.g. `https://github.com/wor101/dicevision-foundry/releases/download/v0.2.0-rc.1/module.json`.

## Setup

1. Go to [dicevision.dirtyowlbear.com](https://dicevision.dirtyowlbear.com) and create a session in **Settings**
2. Copy the 8-character session code (e.g., `XKRM-4N7B` — the dash is optional)
3. In Foundry, go to **Settings** → **Module Settings** → **DiceVision**
4. Paste the session code
5. Set **Operating Mode** to **Chat**
6. Roll physical dice in front of your camera — results appear in Foundry's chat log

Each user who rolls physical dice needs their **own** session code. If two Foundry users enter the same code, every roll is posted to chat once per user.

## Settings

| Setting | Description |
|---------|-------------|
| **Session Code** | 8-character code from DiceVision Settings |
| **Operating Mode** | `Off` (disabled) or `Chat` (display rolls in chat) |
| **Auto-Connect** | Connect automatically when the world loads |
| **Chat Visibility** | Who sees roll messages: Everyone, GM Only, or Only Me |
| **Roll Label** | Label shown on roll messages (default: "DiceVision") |
| **Roll Timeout** | Seconds to wait for a physical roll (reserved for the planned Replace mode) |

## How It Works

1. DiceVision's camera detects physical dice using a YOLO + CNN/Embedding AI pipeline
2. Results are sent to the DiceVision backend
3. In Chat mode, this module tells the backend it is waiting for rolls; DiceVision only forwards a roll when an app is waiting
4. The backend sends the roll over WebSocket, and the module posts it to chat and registers as waiting again

## API

The module exposes a public API for macros and console use:

```javascript
const api = game.modules.get("dicevision").api;

api.connect("XKRM-4N7B");  // Connect to a session
api.disconnect();       // Disconnect
api.isConnected();      // Check connection status
```

## License

MIT
