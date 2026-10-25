/**
 * Chat sidebar controls and /dv chat commands.
 *
 * In Chat and Replace mode two buttons sit with the chat message-mode buttons
 * (sidebar-tab.js has the same two actions in its panel, alongside the
 * connect form, Disconnect and the settings):
 * - Dice: post the next physical roll to chat (click again to cancel)
 * - Repeat: toggle continuous mode (post every roll)
 * In Replace mode, a Foundry roll dialog waiting for dice takes rolls first.
 */

const MODULE_ID = "dicevision";
const CONTROLS_CLASS = "dicevision-controls";
export const SESSION_CODE_PATTERN = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/i;

/**
 * @param {import("./dicevision-client.js").DiceVisionClient} client
 */
export function registerChatControls(client) {
  Hooks.on("chatMessage", (_chatLog, message) => {
    const text = plainText(message);
    if (!/^\/dv(\s|$)/i.test(text)) return;
    const args = text.split(/\s+/).slice(1);
    handleCommand(client, args).catch((err) => {
      console.error("[DiceVision] Command failed:", err);
      ui.notifications.error(game.i18n.format("DICEVISION.Notifications.CommandFailed", {
        command: `/dv ${args.join(" ")}`.trim(),
        error: err.message
      }));
    });
    return false;
  });

  const render = () => renderControls(client);
  Hooks.on("renderChatInput", render); // v13+: chat input moves between sidebar and notifications
  Hooks.on("renderChatLog", render);
  Hooks.on("dicevision.stateChanged", render);
}

/**
 * The chat box's text. v14's chat input is a rich-text editor, so the
 * chatMessage hook gets HTML such as "<p>/dv status</p>".
 * @param {string} message
 */
export function plainText(message) {
  const entities = { "&nbsp;": " ", "&#160;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
  return String(message)
    // Line and paragraph breaks (Shift+Enter) separate words, as in Foundry's parse()
    .replace(/<br\b[^>]*>|<\/p>\s*<p\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(nbsp|amp|lt|gt|quot|#39|#160);/g, entity => entities[entity])
    .trim();
}

/**
 * Add, update, or remove the DiceVision buttons in #chat-controls.
 * @param {import("./dicevision-client.js").DiceVisionClient} client
 */
function renderControls(client) {
  const host = globalThis.document?.getElementById("chat-controls");
  if (!host) return;

  const state = client.getState();
  let controls = host.querySelector(`.${CONTROLS_CLASS}`);
  if (state.mode === "off") {
    controls?.remove();
    return;
  }

  if (!controls) {
    controls = document.createElement("div");
    controls.className = CONTROLS_CLASS;
    controls.append(
      makeButton("request", "fa-dice-d20", () => toggleRollRequest(client)),
      makeButton("continuous", "fa-repeat", () => {
        game.settings.set(MODULE_ID, "continuous", !game.settings.get(MODULE_ID, "continuous")).catch((err) => {
          console.error("[DiceVision] Failed to toggle continuous mode:", err);
          ui.notifications.error(game.i18n.format("DICEVISION.Notifications.CommandFailed", {
            command: "continuous", error: err.message
          }));
        });
      })
    );
    host.prepend(controls);
  }

  const request = controls.querySelector('[data-dv="request"]');
  const requestLabel = !state.connected ? "DICEVISION.Controls.Disconnected"
    : state.continuous ? "DICEVISION.Controls.ContinuousActive"
    : state.waiting ? "DICEVISION.Controls.CancelRequest"
    : "DICEVISION.Controls.RequestRoll";
  setLabel(request, requestLabel);
  request.disabled = !state.connected || state.continuous;
  request.classList.toggle("dicevision-waiting", state.waiting);
  request.setAttribute("aria-pressed", String(state.waiting));

  const continuous = controls.querySelector('[data-dv="continuous"]');
  setLabel(continuous, state.continuous ? "DICEVISION.Controls.ContinuousOn" : "DICEVISION.Controls.ContinuousOff");
  continuous.setAttribute("aria-pressed", String(state.continuous));
}

function makeButton(name, icon, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `ui-control icon fa-solid ${icon}`;
  button.dataset.dv = name;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    onClick();
  });
  return button;
}

function setLabel(button, key) {
  const label = game.i18n.localize(key);
  button.setAttribute("aria-label", label);
  button.dataset.tooltip = label;
}

/**
 * Handle "/dv <subcommand> [args]".
 * @param {import("./dicevision-client.js").DiceVisionClient} client
 * @param {string[]} args
 */
async function handleCommand(client, [sub = "help", arg]) {
  switch (sub.toLowerCase()) {
    case "roll":
      client.requestRoll();
      break;

    case "cancel":
      if (!client.cancelRequest()) await reply("DICEVISION.Commands.NothingToCancel");
      break;

    case "continuous": {
      if (arg && !["on", "off"].includes(arg.toLowerCase())) return reply("DICEVISION.Commands.Help");
      const next = arg ? arg.toLowerCase() === "on" : !game.settings.get(MODULE_ID, "continuous");
      await game.settings.set(MODULE_ID, "continuous", next);
      await reply(next ? "DICEVISION.Controls.ContinuousOn" : "DICEVISION.Controls.ContinuousOff");
      break;
    }

    case "mode":
      if (!["off", "chat", "replace"].includes(arg?.toLowerCase())) return reply("DICEVISION.Commands.Help");
      await game.settings.set(MODULE_ID, "mode", arg.toLowerCase());
      await reply("DICEVISION.Commands.ModeSet", { mode: arg.toLowerCase() });
      break;

    case "connect":
      if (!arg) return reply("DICEVISION.Commands.Help");
      if (!SESSION_CODE_PATTERN.test(arg)) return reply("DICEVISION.Commands.InvalidCode", { code: arg });
      await connectWithCode(client, arg);
      break;

    case "disconnect":
      if (!client.isConnected() && !client.reconnectTimeout) return reply("DICEVISION.Commands.AlreadyDisconnected");
      client.disconnect();
      ui.notifications.info(game.i18n.localize("DICEVISION.Notifications.Disconnected"));
      break;

    case "status": {
      const s = client.getState();
      await reply("DICEVISION.Commands.Status", {
        connection: game.i18n.localize(s.connected ? "DICEVISION.Commands.Connected" : "DICEVISION.Commands.NotConnected"),
        session: s.sessionCode ?? "-",
        mode: s.mode,
        continuous: s.continuous ? "on" : "off",
        waiting: s.waiting ? "yes" : "no",
        dialog: s.dialogWaiting ? "yes" : "no"
      });
      break;
    }

    default:
      await reply("DICEVISION.Commands.Help");
  }
}

/**
 * The dice button: ask for the next physical roll, or withdraw the request
 * (not in continuous mode, which always wants rolls). Also the sidebar
 * panel's Roll button.
 * @param {import("./dicevision-client.js").DiceVisionClient} client
 */
export function toggleRollRequest(client) {
  const state = client.getState();
  if (state.waiting && !state.continuous) client.cancelRequest();
  else client.requestRoll();
}

/**
 * Save a session code and connect to it (/dv connect, the sidebar panel).
 * The code is saved as DiceVision shows it (upper case, no hyphen), so Game
 * Settings and the panel agree even if the user typed xkrm-4n7b. A code
 * already saved in that form reconnects without saving, because Foundry
 * skips onChange for an unchanged setting.
 * @param {import("./dicevision-client.js").DiceVisionClient} client
 * @param {string} code
 * @returns {Promise<boolean>} false if the code isn't a session code
 * @throws if the saved code didn't start a connection (the onChange hook
 *   failed; Foundry only logs hook errors)
 */
export async function connectWithCode(client, code) {
  if (!SESSION_CODE_PATTERN.test(code)) return false;
  const plain = code.toUpperCase().replace(/-/g, "");
  if (plain === game.settings.get(MODULE_ID, "sessionCode")) {
    client.connect(plain);
  } else {
    // Saving connects via the setting's onChange. Game Settings itself saves
    // the code as typed (settings.js doesn't normalize), so a hyphenated or
    // lower-case saved code lands here too and is rewritten.
    await game.settings.set(MODULE_ID, "sessionCode", plain);
    if (!client.getState().sessionActive) throw new Error("connection was not started (see the console)");
  }
  return true;
}

/** Post a message only the current user can see. */
function reply(key, data) {
  return ChatMessage.create({
    content: data ? game.i18n.format(key, data) : game.i18n.localize(key),
    speaker: { alias: "DiceVision" },
    whisper: [game.user.id]
  });
}
