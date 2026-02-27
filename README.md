# DiceVision — Foundry VTT Module

A Foundry VTT module that connects to [DiceVision](https://github.com/wor101/dice-vision), an AI-powered physical dice recognition system. Roll real dice in front of a camera and see the results appear in Foundry's chat.

## Requirements

- **Foundry VTT v12** or later
- A DiceVision account at [dicevision.dirtyowlbear.com](https://dicevision.dirtyowlbear.com)

## Installation

1. In Foundry VTT, go to **Add-on Modules** → **Install Module**
2. Paste the manifest URL:
   ```
   https://github.com/wor101/dicevision-foundry/releases/latest/download/module.json
   ```
3. Click **Install**

## Setup

1. Go to [dicevision.dirtyowlbear.com](https://dicevision.dirtyowlbear.com) and create a session in **Settings**
2. Copy the 6-character session code (e.g., `ABC123`)
3. In Foundry, go to **Settings** → **Module Settings** → **DiceVision**
4. Paste the session code
5. Set **Operating Mode** to **Chat**
6. Roll physical dice in front of your camera — results appear in Foundry's chat log

## Settings

| Setting | Description |
|---------|-------------|
| **Session Code** | 6-character code from DiceVision Settings |
| **Operating Mode** | `Off` (disabled) or `Chat` (display rolls in chat) |
| **Auto-Connect** | Connect automatically when the world loads |
| **Chat Visibility** | Who sees roll messages: Everyone, GM Only, or Only Me |
| **Roll Label** | Label shown on roll messages (default: "DiceVision") |
| **Roll Timeout** | Seconds to wait for a physical roll (used in future Replace mode) |

## How It Works

1. DiceVision's camera detects physical dice using a YOLO + CNN/Embedding AI pipeline
2. Results are sent to the DiceVision backend
3. The backend broadcasts results via WebSocket to all connected clients
4. This Foundry module receives the results and creates chat messages

## API

The module exposes a public API for macros and console use:

```javascript
const api = game.modules.get("dicevision").api;

api.connect("ABC123");  // Connect to a session
api.disconnect();       // Disconnect
api.isConnected();      // Check connection status
```

## License

MIT
