/**
 * Dice Bridge — Roll Conversion and Chat Display
 *
 * Posts DiceVision rolls to Foundry's chat as standard roll cards: a real
 * Foundry roll, made with the game system's roll class, so the card gets the
 * system's roll layout and tooltip and Dice So Nice! can animate it. If any
 * die can't be part of a Foundry roll (see buildRollData), the whole roll
 * falls back to the plain DiceVision card. Handles chat visibility (whisper
 * targets) based on module settings.
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

  const roll = await buildRoll(rollData.dice);
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
 *
 * The roll is made with the game system's own roll class
 * (CONFIG.Dice.rolls[0]), so the card is drawn the way the system draws its
 * rolls (dnd5e: BasicRoll, Shadowdark: RollSD). Shadowdark's RollSD has its
 * own card template; a core Roll card there gets Shadowdark's styling with
 * core's layout, which pushes the total out of view. The system's roll is
 * checked first (see trySystemRoll); if it fails, core's Roll is used.
 */
async function buildRoll(dice) {
  const data = buildRollData(dice);
  if (!data) {
    console.info("[DiceVision] Posting the plain card: these dice can't be a Foundry roll (no 3D dice):", dice);
    return null;
  }
  const CoreRoll = foundry.dice.Roll;
  const SystemRoll = CONFIG.Dice?.rolls?.[0];
  if (SystemRoll && SystemRoll !== CoreRoll) {
    try {
      return await trySystemRoll(SystemRoll, data);
    } catch (err) {
      console.warn(`[DiceVision] The system's roll class (${SystemRoll.name}) can't take these dice; `
        + "using core Roll, whose card may not display correctly in this system:", err, data);
    }
  }
  try {
    return CoreRoll.fromData(data);
  } catch (err) {
    console.warn("[DiceVision] Foundry rejected the roll data; posting the plain card (no 3D dice):", err, data);
    return null;
  }
}

/**
 * The roll made with the system's roll class, once it has shown it works:
 * failures past this point (drawing the card, every client reloading the
 * roll) happen after the message is saved, where nothing can fall back, and
 * leave a card that never appears.
 * - fromData redirects to the CONFIG.Dice.rolls class named by data.class
 *   (and throws if there's none), so the data is given this class's name.
 * - The total must be the camera's (a class may compute its own).
 * - Every client rebuilds the roll from its saved data, finding the class by
 *   name, so that must give this class back.
 * - It must draw, as the roller sees it and as others see a private roll.
 * @throws when any of these fails
 */
async function trySystemRoll(SystemRoll, data) {
  const roll = SystemRoll.fromData({ ...data, class: SystemRoll.name });
  if (!roll._evaluated) throw new Error("the roll isn't evaluated");
  if (roll.total !== data.total) throw new Error(`its total is ${roll.total}, not ${data.total}`);
  const reloaded = foundry.dice.Roll.fromData(JSON.parse(JSON.stringify(roll)));
  if (reloaded?.constructor !== SystemRoll) throw new Error(`it reloads as ${reloaded?.constructor?.name}`);
  await roll.render();
  await roll.render({ isPrivate: true });
  return roll;
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
