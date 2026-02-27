/**
 * DiceVision — Foundry VTT Module Entry Point
 *
 * Phase 1: Foundation + Chat Mode
 * Connects to DiceVision backend via WebSocket and displays
 * physical dice roll results in Foundry's chat.
 */

import { registerSettings } from "./settings.js";
import { diceVisionClient } from "./dicevision-client.js";

const MODULE_ID = "dicevision";

/* -------------------------------------------------- */
/*  Init Hook                                         */
/* -------------------------------------------------- */

Hooks.once("init", () => {
  console.log("[DiceVision] Initializing module");

  registerSettings();

  // Expose public API on the module for macros and console access
  const module = game.modules.get(MODULE_ID);
  if (module) {
    module.api = {
      client: diceVisionClient,
      connect: (code) => diceVisionClient.connect(code),
      disconnect: () => diceVisionClient.disconnect(),
      isConnected: () => diceVisionClient.isConnected()
    };
  }
});

/* -------------------------------------------------- */
/*  Ready Hook                                        */
/* -------------------------------------------------- */

Hooks.once("ready", () => {
  console.log("[DiceVision] Module ready");

  const sessionCode = game.settings.get(MODULE_ID, "sessionCode");
  const autoConnect = game.settings.get(MODULE_ID, "autoConnect");
  const mode = game.settings.get(MODULE_ID, "mode");

  if (sessionCode && autoConnect) {
    diceVisionClient.connect(sessionCode);

    if (mode === "off") {
      ui.notifications.info(
        game.i18n.localize("DICEVISION.Notifications.ModeOff")
      );
    }
  }
});

/* -------------------------------------------------- */
/*  Cleanup                                           */
/* -------------------------------------------------- */

Hooks.on("closeWorld", () => {
  diceVisionClient.disconnect();
});

window.addEventListener("beforeunload", () => {
  diceVisionClient.disconnect();
});
