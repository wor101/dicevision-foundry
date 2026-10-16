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
 * Either way, physical dice opt out of Dice So Nice's interactive throws,
 * which would otherwise ask for them to be thrown again with the mouse.
 *
 * Removing the method also drops Foundry's camera icon from the roll
 * tooltip, so it's added (back) for terms with `options.dicevision.physical`.
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

/** Dice So Nice's "never an interactive throw" flag on a message. */
export const NO_INTERACTIVE_THROW = { [`flags.${DSN_ID}.interactive`]: false };

export function registerDiceSoNice() {
  Hooks.on("preCreateChatMessage", (message, _data, _options, userId) => {
    if (userId !== game.user.id) return;
    try {
      // Every message this user creates passes through here: only touch
      // ones with DiceVision dice
      if (!show3dDice() || !hasDiceVisionDice(message)) return;
      const { rolls, changed, physical } = stripMethod(message._source.rolls, METHOD_ID);
      if (!changed) return;
      const update = { rolls };
      if (physical) {
        // Dice So Nice's interactive throws would ask for physical dice to be
        // thrown again with the mouse. false is its "never interactive" flag;
        // a pending stamp is cleared in case its hook ran before this one.
        Object.assign(update, NO_INTERACTIVE_THROW);
        if (message.getFlag?.(DSN_ID, "interactiveThrow")) update[`flags.${DSN_ID}.interactiveThrow`] = null;
      }
      message.updateSource(update);
    } catch (err) {
      // The roll still posts; Dice So Nice treats it as a manually entered roll
      console.error(`[DiceVision] Couldn't prepare roll message "${message.flavor ?? ""}" for Dice So Nice:`, err);
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

/** Whether a message's rolls have dice filled through the DiceVision method. */
function hasDiceVisionDice(message) {
  return (message.rolls ?? []).some(roll => (roll.dice ?? []).some(term => term.method === METHOD_ID));
}

/**
 * Put the camera icon on tooltip parts for dice from the camera, where
 * Foundry would show a method icon. One tooltip part per die term, in
 * roll.dice order:
 * - core's tooltip: the icon goes in the part's `.part-header`
 * - dnd5e's roll breakdown: first in the part's `.dice`; its modifier parts
 *   (`.constant-term`) aren't dice
 * When the parts don't line up with the dice (some other layout), the
 * tooltip is left alone.
 */
export function addCameraIcons(message, html) {
  const dice = (message.rolls ?? []).flatMap(roll => roll.dice ?? []);
  if (!dice.some(term => term.options?.dicevision?.physical)) return;
  const iconHTML = CONFIG.Dice.fulfillment.methods[METHOD_ID]?.icon;
  if (!iconHTML) return;
  const parts = [...(html?.querySelectorAll?.(".dice-tooltip .tooltip-part:not(.constant-term)") ?? [])];
  if (parts.length !== dice.length) {
    console.debug(`[DiceVision] Roll tooltip has ${parts.length} parts for ${dice.length} dice terms; no camera icons`);
    return;
  }
  const label = game.i18n.localize("DICEVISION.Fulfillment.Label");
  parts.forEach((part, i) => {
    if (!dice[i].options?.dicevision?.physical) return;
    const container = part.querySelector(".part-header") ?? part.querySelector(".dice");
    if (!container || container.querySelector(".part-method")) return;
    const icon = document.createElement("span");
    icon.className = "part-method";
    icon.dataset.tooltip = "";
    icon.setAttribute("aria-label", label);
    icon.innerHTML = iconHTML;
    container.prepend(icon);
  });
}
