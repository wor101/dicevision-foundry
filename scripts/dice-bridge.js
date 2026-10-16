/**
 * Dice Bridge — Roll Conversion and Chat Display
 *
 * Posts DiceVision rolls to Foundry's chat as standard roll cards: a real
 * Foundry roll, so the card gets Foundry's tooltip and Dice So Nice! can
 * animate it. If any die can't be part of a Foundry roll (see buildRollData),
 * the whole roll falls back to the plain DiceVision card. Handles chat visibility (whisper targets)
 * based on module settings.
 */

import { buildRollData } from "./roll-data.js";
import { show3dDice } from "./dice-so-nice.js";

const MODULE_ID = "dicevision";

/**
 * Display a DiceVision roll result in Foundry's chat.
 * @param {object} rollData - { dice, total, roll_id?, timestamp? }
 */
export async function displayRollInChat(rollData) {
  const label = game.settings.get(MODULE_ID, "rollLabel");
  const visibility = game.settings.get(MODULE_ID, "chatVisibility");

  const messageData = {
    speaker: { alias: label },
    // A whispered roll card is a private roll: other players see that you
    // rolled, not the result. The fallback card stays hidden from them.
    whisper: getWhisperTargets(visibility),
    flags: {
      dicevision: {
        rollId: rollData.roll_id,
        dice: rollData.dice,
        total: rollData.total,
        timestamp: rollData.timestamp
      }
    }
  };

  const roll = buildRoll(rollData.dice);
  if (roll) {
    Object.assign(messageData, {
      flavor: label,
      content: String(roll.total),
      rolls: [roll],
      sound: CONFIG.sounds.dice
    });
    if (game.modules.get("dice-so-nice")?.active) {
      // Animate, but never ask for the physical dice to be thrown again with
      // the mouse; or skip it if the GM turned 3D dice off
      messageData.flags["dice-so-nice"] = show3dDice() ? { interactive: false } : { skip: true };
    }
  } else {
    messageData.content = await formatDiceForChat(rollData, label);
  }

  await ChatMessage.create(messageData);
}

/**
 * A Foundry roll of the dice, or null to post the plain card instead (no
 * roll tooltip or 3D dice): a die Foundry can't roll, or Foundry rejecting
 * the roll data. Never throws, so the roll always reaches chat.
 */
function buildRoll(dice) {
  const data = buildRollData(dice);
  if (!data) {
    console.info("[DiceVision] Posting the plain card: these dice can't be a Foundry roll (no 3D dice):", dice);
    return null;
  }
  try {
    return foundry.dice.Roll.fromData(data);
  } catch (err) {
    console.warn("[DiceVision] Foundry rejected the roll data; posting the plain card (no 3D dice):", err, data);
    return null;
  }
}

/**
 * Format dice results as HTML for chat display.
 * Groups dice by type (e.g., "2d6", "1d20") and renders via Handlebars template.
 *
 * @param {object} rollData - { dice, total }
 * @param {string} label - Roll label from settings
 * @returns {Promise<string>} Rendered HTML content
 */
async function formatDiceForChat(rollData, label) {
  const groups = {};
  for (const die of rollData.dice) {
    if (!groups[die.type]) {
      groups[die.type] = [];
    }
    groups[die.type].push(die.value);
  }

  const templateData = {
    label,
    groups: Object.entries(groups).map(([type, values]) => ({
      type: type.toUpperCase(),
      count: values.length,
      values,
      subtotal: values.reduce((sum, v) => sum + (Number(v) || 0), 0)
    })),
    total: rollData.total,
    diceCount: rollData.dice.length
  };

  const template = `modules/${MODULE_ID}/templates/chat-message.hbs`;
  // v13+ namespaces renderTemplate; the global is deprecated there
  const render = foundry.applications?.handlebars?.renderTemplate ?? renderTemplate;
  return render(template, templateData);
}

/**
 * Determine whisper targets based on chatVisibility setting.
 *
 * @param {string} visibility - "all", "gm", or "self"
 * @returns {string[]} Array of user IDs to whisper to, or empty for public
 */
function getWhisperTargets(visibility) {
  switch (visibility) {
    case "gm":
      return game.users.filter(u => u.isGM).map(u => u.id);
    case "self":
      return [game.user.id];
    case "all":
    default:
      return [];
  }
}
