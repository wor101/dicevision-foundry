/**
 * Dice So Nice! support: show physical dice as 3D dice landing on their faces.
 *
 * Dice So Nice animates a roll from the results saved in its chat message, so
 * the 3D dice already land on the physical values. Two things would stop it:
 *
 * - Replace mode: Dice So Nice skips rolls where every die used an
 *   interactive fulfillment method ("Disabled for manually entered rolls",
 *   on by default). Before the message is saved, the roller's client takes
 *   the DiceVision method off its rolls (stripMethod), so every client's
 *   Dice So Nice animates them, with its own visibility rules still applying.
 * - Chat mode: cards need a real roll attached (dice-bridge.js).
 *
 * Removing the method also drops Foundry's camera icon from the roll
 * tooltip, so it's added back for terms marked `options.dicevision`.
 */

import { METHOD_ID } from "./roll-intercept.js";
import { stripMethod } from "./roll-data.js";

const MODULE_ID = "dicevision";
const DSN_ID = "dice-so-nice";

/**
 * Whether DiceVision rolls should animate: Dice So Nice is active and the
 * GM's world setting allows it.
 */
export function show3dDice() {
  return !!game.modules.get(DSN_ID)?.active && game.settings.get(MODULE_ID, "diceSoNice") !== false;
}

export function registerDiceSoNice() {
  Hooks.on("preCreateChatMessage", (message, _data, _options, userId) => {
    if (userId !== game.user.id || !show3dDice()) return;
    try {
      const { rolls, changed, physical } = stripMethod(message._source.rolls, METHOD_ID);
      if (!changed) return;
      const update = { rolls };
      if (physical) {
        // Dice So Nice's interactive throws would ask for physical dice to be
        // thrown again with the mouse. false is its "never interactive" flag;
        // a pending stamp is cleared in case its hook ran before this one.
        update[`flags.${DSN_ID}.interactive`] = false;
        if (message.getFlag?.(DSN_ID, "interactiveThrow")) update[`flags.${DSN_ID}.interactiveThrow`] = null;
      }
      message.updateSource(update);
    } catch (err) {
      // The roll still posts, just without 3D dice
      console.error("[DiceVision] Couldn't prepare the roll for Dice So Nice:", err);
    }
  });

  Hooks.on("renderChatMessageHTML", (message, html) => {
    try {
      addCameraIcons(message, html);
    } catch (err) {
      console.warn("[DiceVision] Couldn't mark physical dice in the roll tooltip:", err);
    }
  });
}

/**
 * Put the camera icon back on tooltip parts for dice from the camera.
 * Foundry renders one tooltip part per die term, in roll.dice order; when the
 * counts don't line up (a system's own card layout), leave the tooltip alone.
 */
export function addCameraIcons(message, html) {
  const dice = (message.rolls ?? []).flatMap(roll => roll.dice ?? []);
  if (!dice.some(term => term.options?.dicevision)) return;
  const parts = [...(html?.querySelectorAll?.(".dice-tooltip .tooltip-part") ?? [])];
  if (parts.length !== dice.length) return;
  const label = game.i18n.localize("DICEVISION.Fulfillment.Label");
  parts.forEach((part, i) => {
    if (!dice[i].options?.dicevision?.physical) return;
    const header = part.querySelector(".part-header");
    if (!header || header.querySelector(".part-method")) return;
    const icon = document.createElement("span");
    icon.className = "part-method";
    icon.dataset.tooltip = "";
    icon.setAttribute("aria-label", label);
    icon.innerHTML = CONFIG.Dice.fulfillment.methods[METHOD_ID]?.icon ?? "";
    header.prepend(icon);
  });
}
