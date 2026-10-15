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
6. Click the **dice button** next to the chat box (or type `/dv roll`), then roll physical dice in front of your camera. The result appears in Foundry's chat log.

## Rolling

In Chat mode, two buttons appear above the chat message-mode buttons:

| Button | What it does |
|--------|--------------|
| **Dice** | Asks DiceVision for your next physical roll. It pulses while waiting; click it again to cancel. Disabled while continuous mode is on. |
| **Repeat** | Turns **continuous mode** on or off. |

By default the module asks for **one roll at a time**. While Foundry is waiting, the DiceVision dashboard switches to continuous capture (if its **Send automatically** option is on, the default); once the roll arrives it goes back to normal.

With **continuous mode** on, every roll is posted to chat and the dashboard stays in continuous capture until you turn it off.

### Chat commands

| Command | Description |
|---------|-------------|
| `/dv roll` | Post your next physical roll |
| `/dv cancel` | Cancel a pending roll |
| `/dv continuous [on\|off]` | Toggle continuous mode, or set it |
| `/dv mode off\|chat` | Set the operating mode |
| `/dv connect <code>` | Save a session code and connect (or reconnect) |
| `/dv disconnect` | Disconnect |
| `/dv status` | Show connection and waiting status |

Command replies are only visible to you.

Each user who rolls physical dice needs their **own** session code. If two Foundry users share a code, a roll is posted once for each user who is waiting for it, and one user cancelling (or finishing) a roll request can cancel the other's.

## Settings

| Setting | Description |
|---------|-------------|
| **Session Code** | 8-character code from DiceVision Settings |
| **Operating Mode** | `Off` (disabled) or `Chat` (display rolls in chat) |
| **Continuous Mode** | Post every roll and keep the dashboard capturing (default off: one roll per request) |
| **Auto-Connect** | Connect automatically when the world loads |
| **Chat Visibility** | Who sees roll messages: Everyone, GM Only, or Only Me |
| **Roll Label** | Label shown on roll messages (default: "DiceVision") |
| **Roll Timeout** | Seconds to wait for a physical roll (reserved for the planned Replace mode) |

## How It Works

1. DiceVision's camera detects physical dice using a YOLO + CNN/Embedding AI pipeline
2. Results are sent to the DiceVision backend
3. When you request a roll (or continuous mode is on), this module tells the backend it is waiting; DiceVision only forwards a roll when an app is waiting
4. The backend sends the roll over WebSocket and the module posts it to chat. It then registers as waiting again in continuous mode, or tells the backend it's done

## API

The module exposes a public API for macros and console use:

```javascript
const api = game.modules.get("dicevision").api;

api.connect("XKRM-4N7B");  // Connect to a session
api.disconnect();       // Disconnect
api.isConnected();      // Check connection status
api.requestRoll();      // Post the next physical roll (Chat mode)
api.cancelRequest();    // Cancel a pending request
api.setContinuous(true);
api.getState();         // { connected, sessionCode, mode, continuous, waiting }
```

## License

MIT
