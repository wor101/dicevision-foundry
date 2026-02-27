/**
 * Dice Bridge — Roll Conversion and Chat Display
 *
 * Converts DiceVision roll data into Foundry VTT ChatMessage objects.
 * Handles chat visibility (whisper targets) based on module settings.
 */

const MODULE_ID = "dicevision";

/**
 * Display a DiceVision roll result in Foundry's chat.
 * @param {object} rollData - { dice, total, roll_id, timestamp, metadata }
 */
export async function displayRollInChat(rollData) {
  const label = game.settings.get(MODULE_ID, "rollLabel");
  const visibility = game.settings.get(MODULE_ID, "chatVisibility");

  const content = await formatDiceForChat(rollData, label);
  const whisperTargets = getWhisperTargets(visibility);

  const messageData = {
    content,
    speaker: { alias: label },
    whisper: whisperTargets,
    flags: {
      dicevision: {
        rollId: rollData.roll_id,
        dice: rollData.dice,
        total: rollData.total,
        timestamp: rollData.timestamp
      }
    }
  };

  await ChatMessage.create(messageData);
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
  return renderTemplate(template, templateData);
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
