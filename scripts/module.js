/**
 * DiceVision — Foundry VTT Module Entry Point
 *
 * Connects to the DiceVision backend via WebSocket. Chat mode posts physical
 * rolls to chat; Replace mode fills Foundry's own rolls with physical dice.
 */

import { registerSettings } from "./settings.js";
import { diceVisionClient } from "./dicevision-client.js";
import { registerChatControls } from "./chat-controls.js";
import { registerRollIntercept, diceConfigUsesDiceVision } from "./roll-intercept.js";
import { registerDiceSoNice } from "./dice-so-nice.js";

const MODULE_ID = "dicevision";

/* -------------------------------------------------- */
/*  Init Hook                                         */
/* -------------------------------------------------- */

Hooks.once("init", () => {
  console.log("[DiceVision] Initializing module");

  registerSettings();
  registerChatControls(diceVisionClient);
  registerRollIntercept(diceVisionClient);
  registerDiceSoNice();

  // Expose public API on the module for macros and console access
  const module = game.modules.get(MODULE_ID);
  if (module) {
    module.api = {
      client: diceVisionClient,
      connect: (code) => diceVisionClient.connect(code),
      disconnect: () => diceVisionClient.disconnect(),
      isConnected: () => diceVisionClient.isConnected(),
      requestRoll: () => diceVisionClient.requestRoll(),
      cancelRequest: () => diceVisionClient.cancelRequest(),
      setContinuous: (on) => game.settings.set(MODULE_ID, "continuous", !!on),
      getState: () => diceVisionClient.getState()
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

  // Replace mode with nothing to connect to: rolls stay digital, say so
  if (mode === "replace" && !(sessionCode && autoConnect)) {
    ui.notifications.warn(game.i18n.localize("DICEVISION.Notifications.ReplaceNotConnected"));
  }

  if (sessionCode && autoConnect) {
    diceVisionClient.connect(sessionCode);

    // Off still fills dice set to DiceVision in Core > Dice Configuration
    if (mode === "off" && !diceConfigUsesDiceVision()) {
      ui.notifications.info(
        game.i18n.localize("DICEVISION.Notifications.ModeOff")
      );
    }
  }
});

/* -------------------------------------------------- */
/*  Cleanup                                           */
/* -------------------------------------------------- */

window.addEventListener("beforeunload", () => {
  diceVisionClient.disconnect();
});
