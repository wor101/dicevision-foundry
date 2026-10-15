/**
 * Chat sidebar controls and /dv chat commands.
 *
 * In Chat mode two buttons sit with the chat message-mode buttons:
 * - Dice: request the next physical roll (click again to cancel)
 * - Repeat: toggle continuous mode (post every roll)
 */

const MODULE_ID = "dicevision";
const CONTROLS_CLASS = "dicevision-controls";

/**
 * @param {import("./dicevision-client.js").DiceVisionClient} client
 */
export function registerChatControls(client) {
  Hooks.on("chatMessage", (_chatLog, message) => {
    if (!/^\/dv(\s|$)/i.test(message)) return;
    handleCommand(client, message.trim().split(/\s+/).slice(1)).catch((err) => {
      console.error("[DiceVision] Command failed:", err);
    });
    return false;
  });

  const render = () => renderControls(client);
  Hooks.on("renderChatInput", render); // v13+: chat input moves between sidebar and notifications
  Hooks.on("renderChatLog", render);
  Hooks.on("dicevision.stateChanged", render);
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
  if (state.mode !== "chat") {
    controls?.remove();
    return;
  }

  if (!controls) {
    controls = document.createElement("div");
    controls.className = CONTROLS_CLASS;
    controls.append(
      makeButton("request", "fa-dice-d20", () => {
        if (client.getState().waiting && !client.getState().continuous) client.cancelRequest();
        else client.requestRoll();
      }),
      makeButton("continuous", "fa-repeat", () => {
        game.settings.set(MODULE_ID, "continuous", !game.settings.get(MODULE_ID, "continuous"));
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
      if (!client.cancelRequest()) reply("DICEVISION.Commands.NothingToCancel");
      break;

    case "continuous": {
      const current = game.settings.get(MODULE_ID, "continuous");
      const next = arg ? arg.toLowerCase() === "on" : !current;
      if (arg && !["on", "off"].includes(arg.toLowerCase())) return reply("DICEVISION.Commands.Help");
      await game.settings.set(MODULE_ID, "continuous", next);
      reply(next ? "DICEVISION.Controls.ContinuousOn" : "DICEVISION.Controls.ContinuousOff");
      break;
    }

    case "mode":
      if (!["off", "chat"].includes(arg?.toLowerCase())) return reply("DICEVISION.Commands.Help");
      await game.settings.set(MODULE_ID, "mode", arg.toLowerCase());
      reply("DICEVISION.Commands.ModeSet", { mode: arg.toLowerCase() });
      break;

    case "connect":
      if (!arg) return reply("DICEVISION.Commands.Help");
      // Saving the setting triggers the connection
      await game.settings.set(MODULE_ID, "sessionCode", arg);
      break;

    case "disconnect":
      client.disconnect();
      ui.notifications.info(game.i18n.localize("DICEVISION.Notifications.Disconnected"));
      break;

    case "status": {
      const s = client.getState();
      reply("DICEVISION.Commands.Status", {
        connection: game.i18n.localize(s.connected ? "DICEVISION.Commands.Connected" : "DICEVISION.Commands.NotConnected"),
        session: s.sessionCode ?? "-",
        mode: s.mode,
        continuous: s.continuous ? "on" : "off",
        waiting: s.waiting ? "yes" : "no"
      });
      break;
    }

    default:
      reply("DICEVISION.Commands.Help");
  }
}

/** Post a message only the current user can see. */
function reply(key, data) {
  ChatMessage.create({
    content: data ? game.i18n.format(key, data) : game.i18n.localize(key),
    speaker: { alias: "DiceVision" },
    whisper: [game.user.id]
  });
}
