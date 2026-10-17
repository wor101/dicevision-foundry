# DiceVision — Foundry VTT Module

A Foundry VTT module that connects to [DiceVision](https://github.com/wor101/dice-vision), an AI-powered physical dice recognition system. Roll real dice in front of a camera and Foundry uses them: for `/roll` and character sheet rolls (Replace mode), or as chat messages (Chat mode).

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
5. Set **Operating Mode** to **Replace** (or **Chat**, below)
6. Roll in Foundry as usual, e.g. `/roll 1d20+5` or an attack from a character sheet. A dialog opens and waits; roll the physical dice in front of your camera and Foundry uses them.

## Replace mode

Every Foundry roll waits for your physical dice while DiceVision is connected. That includes `/roll` and system rolls, such as dnd5e rolls with advantage.

- **Roll all the dice at once, in any order.** They're matched by type, so for `2d20kh + 1d6` roll two d20s and a d6 together.
- **Missing dice:** the dialog fills what it can and waits for the rest. You can roll just the missing dice and leave the others where they are: dice still showing the same value as last time are recognised as already used.
- **Wrong or extra dice** are ignored, with a warning in the dialog. Roll again.
- **No dice detected:** the dialog says so and keeps waiting. Roll again in view of the camera.
- **A die the camera couldn't read** fills nothing: the dialog names it and keeps waiting. Roll it again.
- **Percentile:** roll two d10s (a tens die and a units die) for a d100. 00 + 0 is 100. A d10 showing 0 counts as 10, and a d10 printed 1–10 works as is.
- **Exploding dice and rerolls** ask for another die.
- **Camera trouble?** Click **Submit** in the dialog to roll whatever is still missing digitally. For an extra die from an explosion or reroll, click the arrow next to it.
- Dice the camera can't read (d2, d3, coins) are rolled digitally, and a notice says so.
- **Connection drops:** while DiceVision reconnects, the dialog still opens and says DiceVision isn't connected. Click Submit to roll digitally. After `/dv disconnect`, an invalid session code, or once reconnecting gives up, Foundry rolls digitally as usual, and a warning says so.
- Blind `/roll`s are rolled digitally by Foundry.

To use physical dice only for some die types (say, d20s), set Operating Mode to **Off** and choose **DiceVision** for those dice in **Core › Dice Configuration**. DiceVision still connects (with Auto-Connect on). Those dice open the dialog even while DiceVision is disconnected; click Submit to roll them digitally. A **Default** method set in Dice Configuration overrides Replace mode for every die.

## Chat mode

Chat mode posts physical rolls to chat, outside of any Foundry roll, as standard Foundry roll cards (with the usual dice tooltip). A d10 showing 0 counts as 10, so the card's total can differ from the dashboard's. A tens die (00, 10–90) plus a units die (0–9) is posted as a d100, so 00 + 0 is 100. A lone 10 or 00 is posted as a d10 of 10. A d10 printed 1–10 showing 10, rolled with a 0–9 d10, looks exactly like a percentile pair, so it posts as a d100 too; use Replace mode, which knows what the roll wants. If the camera couldn't read a die, nothing is posted: a warning names the die and the request keeps waiting for the reroll. If any die can't be part of a Foundry roll (such as a d3, or a tens die from 20 to 90 with no units die), the whole roll is posted as a plain DiceVision card instead. With **Chat Visibility** set to GM Only or Only Me, the card is a private roll: other players see that you rolled, not the result (the plain card stays hidden from them). Replace-mode rolls don't use this setting: they follow Foundry's roll mode (Public, Private GM, Blind, Self), chosen under the chat box. Two buttons appear next to the chat message-mode buttons, in Chat and Replace mode. A Foundry roll dialog waiting for dice takes a roll first; a dice-button request then waits for the next one.

| Button | What it does |
|--------|--------------|
| **Dice** | Asks DiceVision for your next physical roll. It pulses while waiting; click it again to cancel. Disabled while continuous mode is on. |
| **Repeat** | Turns **continuous mode** on or off. |

By default the module asks for **one roll at a time**. While Foundry is waiting, the DiceVision dashboard switches to continuous capture (if its **Send automatically** option is on, the default); once the roll arrives it goes back to normal.

With **continuous mode** on, every roll is posted to chat and the dashboard stays in continuous capture until you turn it off.

If the camera sees no dice for a one-off request, a "no dice detected" warning appears (not in continuous mode, where any empty capture would trigger it).

### Chat commands

| Command | Description |
|---------|-------------|
| `/dv roll` | Post your next physical roll |
| `/dv cancel` | Cancel a pending roll |
| `/dv continuous [on\|off]` | Toggle continuous mode, or set it |
| `/dv mode off\|chat\|replace` | Set the operating mode |
| `/dv connect <code>` | Save a session code and connect (or reconnect) |
| `/dv disconnect` | Disconnect |
| `/dv status` | Show connection status, and whether a chat roll or a roll dialog is waiting |

Command replies are only visible to you.

Each user who rolls physical dice needs their **own** session code. If two Foundry users share a code, a roll is posted once for each user who is waiting for it, and one user cancelling (or finishing) a roll request can cancel the other's.

## 3D dice (Dice So Nice!)

With [Dice So Nice!](https://foundryvtt.com/packages/dice-so-nice) active, physical rolls show up as 3D dice for everyone, landing on the faces you rolled. This covers Replace-mode rolls and Chat-mode cards.

- Replace-mode rolls animate even with Dice So Nice's **Disabled for manually entered rolls** setting on (its default). That setting still applies to Foundry's own Manual Input rolls, unless they share a roll with DiceVision dice.
- Dice So Nice's own options still apply: hidden NPC rolls, ghost dice for private and blind rolls, the chat message waiting for the dice to land.
- Physical dice are never handed back for an interactive (mouse) throw.
- The GM can turn this off with **Show 3D Dice (Dice So Nice!)** in DiceVision's settings. Replace-mode rolls then follow Dice So Nice's Disabled for manually entered rolls setting, and Chat-mode cards don't animate.
- On Foundry v13 and later, the camera icon in a roll's tooltip marks dice with at least one die from the camera (in Foundry's tooltip and dnd5e's roll breakdown).

## Settings

| Setting | Description |
|---------|-------------|
| **Session Code** | 8-character code from DiceVision Settings |
| **Operating Mode** | `Off`, `Chat` (post physical rolls to chat) or `Replace` (physical dice for Foundry's rolls) |
| **Continuous Mode** | Chat and Replace mode: post every roll to chat (a roll a Foundry roll dialog is waiting for goes to the dialog) and keep the dashboard capturing (default off: one roll per request) |
| **Auto-Connect** | Connect automatically when the world loads |
| **Chat Visibility** | Chat mode only: who sees a roll's result: Everyone, GM Only, or Only Me (others see that you rolled). Replace-mode rolls follow Foundry's roll mode, chosen under the chat box |
| **Roll Label** | Label shown on roll messages (default: "DiceVision") |
| **Show 3D Dice (Dice So Nice!)** | GM, for the whole world: show DiceVision rolls as Dice So Nice 3D dice (default on; no effect without Dice So Nice) |

## How It Works

1. DiceVision's camera detects physical dice using a YOLO + CNN/Embedding AI pipeline
2. Results are sent to the DiceVision backend
3. When Foundry needs dice (a roll dialog) or you request a roll (dice button, continuous mode), this module tells the backend it is waiting; DiceVision only forwards a roll when an app is waiting
4. The backend sends the roll over WebSocket. Replace mode enters the dice in Foundry's roll dialog through Foundry's dice fulfillment API; Chat mode posts them to chat as a Foundry roll. The module then tells the backend it's done, or keeps waiting if dice are still missing or continuous mode is on

## API

The module exposes a public API for macros and console use:

```javascript
const api = game.modules.get("dicevision").api;

api.connect("XKRM-4N7B");  // Connect to a session
api.disconnect();       // Disconnect
api.isConnected();      // Check connection status
api.requestRoll();      // Post the next physical roll to chat (Chat or Replace mode)
api.cancelRequest();    // Cancel a pending request
api.setContinuous(true);
api.getState();         // { connected, sessionActive, sessionCode, mode, continuous, waiting, dialogWaiting }
                        // waiting: a chat roll is requested; dialogWaiting: a roll dialog waits for dice
```

## License

MIT
