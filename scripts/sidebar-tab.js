/**
 * DiceVision sidebar tab (Foundry v13+).
 *
 * A camera icon in the sidebar's tab bar, like Dice So Nice's d20, opens a
 * panel. Not connected: a session code field and Connect. With a session
 * active (connected, connecting, or reconnecting): the connection status,
 * Roll / Continuous / Disconnect buttons, and the module's settings. Changes
 * save through game.settings, so the settings' onChange hooks still drive
 * the client, and Game Settings shows the same values.
 *
 * Right-clicking the tab pops the panel out as a window (core behaviour for
 * every sidebar tab). On v12 none of Sidebar.TABS, AbstractSidebarTab or
 * HandlebarsApplicationMixin exist, so nothing is added and the Game Settings
 * route remains.
 */

import { connectWithCode, toggleRollRequest } from "./chat-controls.js";

const MODULE_ID = "dicevision";
export const TAB_NAME = "dicevision";
const TAB_ICON = "fa-solid fa-camera";
const TEMPLATE = `modules/${MODULE_ID}/templates/sidebar-tab.hbs`;

/** Settings the panel edits in place, in display order. */
const PANEL_SETTINGS = ["mode", "chatVisibility", "rollLabel", "autoConnect"];

/**
 * "XKRM4N7B" → "XKRM-4N7B", the display format.
 * @param {string|null} code
 */
export function formatCode(code) {
  if (!code) return "";
  const plain = String(code).toUpperCase().replace(/-/g, "");
  return plain.length === 8 ? `${plain.slice(0, 4)}-${plain.slice(4)}` : plain;
}

/**
 * The status line for a client state (pure, for tests).
 * @param {{connected: boolean, sessionActive: boolean, sessionCode: string|null,
 *   reconnectAttempt?: number, reconnectMax?: number}} state
 * @returns {{key: string, css: string, icon: string, data: object}}
 */
export function panelStatus(state) {
  const code = formatCode(state.sessionCode);
  if (state.connected) {
    return { key: "DICEVISION.Sidebar.Status.Connected", css: "connected", icon: "fa-circle-check", data: { code } };
  }
  if (state.sessionActive && state.reconnectAttempt > 0) {
    return {
      key: "DICEVISION.Sidebar.Status.Reconnecting", css: "reconnecting", icon: "fa-rotate",
      data: { code, attempt: state.reconnectAttempt, max: state.reconnectMax }
    };
  }
  if (state.sessionActive) {
    return { key: "DICEVISION.Sidebar.Status.Connecting", css: "connecting", icon: "fa-spinner", data: { code } };
  }
  return { key: "DICEVISION.Sidebar.Status.Disconnected", css: "disconnected", icon: "fa-circle-xmark", data: {} };
}

/**
 * Register the sidebar tab. Call during "init", before the sidebar renders.
 * @param {import("./dicevision-client.js").DiceVisionClient} client
 * @returns {boolean} Whether the tab was registered (false on v12)
 */
export function registerSidebarTab(client) {
  const tabs = globalThis.CONFIG?.ui?.sidebar?.TABS;
  const AbstractSidebarTab = globalThis.foundry?.applications?.sidebar?.AbstractSidebarTab;
  const HandlebarsApplicationMixin = globalThis.foundry?.applications?.api?.HandlebarsApplicationMixin;
  if (!tabs || !AbstractSidebarTab || !HandlebarsApplicationMixin) {
    const missing = [tabs || "CONFIG.ui.sidebar.TABS", AbstractSidebarTab || "AbstractSidebarTab",
      HandlebarsApplicationMixin || "HandlebarsApplicationMixin"].filter(m => typeof m === "string");
    console.log(`[DiceVision] No sidebar tab on Foundry ${globalThis.game?.version ?? "?"} (missing ${missing.join(", ")}; needs v13+). Use Game Settings or /dv connect.`);
    return false;
  }

  class DiceVisionSidebarTab extends HandlebarsApplicationMixin(AbstractSidebarTab) {
    static tabName = TAB_NAME;

    static DEFAULT_OPTIONS = {
      classes: ["dicevision-sidebar-tab"],
      window: { title: "DICEVISION.Sidebar.Title", icon: TAB_ICON },
      position: { width: 320, height: "auto" },
      actions: {
        requestRoll: DiceVisionSidebarTab.#onRequestRoll,
        toggleContinuous: DiceVisionSidebarTab.#onToggleContinuous,
        disconnect: DiceVisionSidebarTab.#onDisconnect
      }
    };

    static PARTS = {
      panel: { template: TEMPLATE, root: true }
    };

    /** @override */
    async _prepareContext(options) {
      const context = await super._prepareContext(options);
      const state = client.getState();
      const status = panelStatus(state);
      const modeOff = state.mode === "off";
      const rollKey = modeOff ? "DICEVISION.Sidebar.Roll.ModeOff"
        : !state.connected ? "DICEVISION.Controls.Disconnected"
        : state.continuous ? "DICEVISION.Controls.ContinuousActive"
        : state.waiting ? "DICEVISION.Controls.CancelRequest"
        : "DICEVISION.Controls.RequestRoll";

      // Keep a half-typed code through a re-render (every state change re-renders)
      const input = this.element?.querySelector('input[name="sessionCode"]');
      const sessionCodeInput = input ? input.value : formatCode(game.settings.get(MODULE_ID, "sessionCode"));

      const settings = Object.fromEntries(
        [...PANEL_SETTINGS, "continuous", "diceSoNice"].map(key => [key, game.settings.get(MODULE_ID, key)])
      );
      // A text setting being typed (saved on blur) keeps its unsaved text too
      const active = globalThis.document?.activeElement;
      if (active?.type === "text" && active.name in settings && this.element?.contains(active)) {
        settings[active.name] = active.value;
      }
      const choices = key => game.settings.settings.get(`${MODULE_ID}.${key}`)?.choices ?? {};

      return Object.assign(context, {
        idPrefix: this.id,
        status: { ...status, text: game.i18n.format(status.key, status.data) },
        sessionActive: state.sessionActive,
        connected: state.connected,
        waiting: state.waiting,
        rollDisabled: modeOff || !state.connected || state.continuous,
        rollTooltip: game.i18n.localize(rollKey),
        continuousDisabled: modeOff,
        settings,
        modeChoices: choices("mode"),
        chatVisibilityChoices: choices("chatVisibility"),
        sessionCodeInput,
        isGM: game.user.isGM
      });
    }

    /** @override */
    async _onRender(context, options) {
      await super._onRender(context, options);
      const connect = this.element.querySelector("form.dicevision-panel-connect");
      connect?.addEventListener("submit", event => {
        event.preventDefault();
        this.#connect(connect);
      });
      this.element.querySelector("form.dicevision-panel-settings")
        ?.addEventListener("change", event => this.#onSettingChange(event));
      // Core restores focus by element id across a re-render, so a field being typed in keeps it
    }

    /**
     * A render failure (e.g. the template didn't load) is toasted once, so
     * the user knows to fall back to Game Settings or /dv connect; the
     * error still reaches Foundry's own logging.
     * @override
     */
    async render(...args) {
      try {
        return await super.render(...args);
      } catch (err) {
        if (!renderFailed) {
          renderFailed = true;
          reportFailure("panel", err);
        }
        throw err;
      }
    }

    /** @param {HTMLFormElement} form */
    async #connect(form) {
      const input = form.elements.sessionCode;
      const code = input.value.trim();
      try {
        if (!(await connectWithCode(client, code))) {
          input.classList.add("dicevision-invalid");
          input.focus();
          ui.notifications.warn(game.i18n.format("DICEVISION.Commands.InvalidCode", { code }));
        }
      } catch (err) {
        reportFailure("connect", err);
      }
    }

    /** @param {Event} event */
    async #onSettingChange(event) {
      const field = event.target;
      const key = field?.name;
      if (!key) return;
      const value = field.type === "checkbox" ? field.checked : field.value;
      try {
        await game.settings.set(MODULE_ID, key, value);
      } catch (err) {
        reportFailure(key, err);
      }
      // Settings without an onChange hook don't trigger a state change, so
      // re-render unconditionally. Through the sidebar instance: it renders
      // the popout too, while a popout render doesn't reach the sidebar.
      renderPanel();
    }

    /** @this {DiceVisionSidebarTab} */
    static #onRequestRoll() {
      try {
        toggleRollRequest(client);
      } catch (err) {
        reportFailure("roll", err);
      }
    }

    /** @this {DiceVisionSidebarTab} */
    static async #onToggleContinuous() {
      try {
        await game.settings.set(MODULE_ID, "continuous", !game.settings.get(MODULE_ID, "continuous"));
      } catch (err) {
        reportFailure("continuous", err);
      }
    }

    /** @this {DiceVisionSidebarTab} */
    static #onDisconnect() {
      try {
        client.disconnect();
        ui.notifications.info(game.i18n.localize("DICEVISION.Notifications.Disconnected"));
      } catch (err) {
        reportFailure("disconnect", err);
      }
    }
  }

  CONFIG.ui[TAB_NAME] = DiceVisionSidebarTab;

  // Insert the tab before Settings, where Dice So Nice puts its own
  const entry = { icon: TAB_ICON, tooltip: "DICEVISION.Sidebar.Title" };
  const settings = tabs.settings;
  if (settings) {
    delete tabs.settings;
    tabs[TAB_NAME] = entry;
    tabs.settings = settings;
  } else {
    tabs[TAB_NAME] = entry;
  }

  const refresh = () => {
    renderPanel();
    updateTabButton(client.getState());
  };
  Hooks.on("dicevision.stateChanged", refresh);
  Hooks.on("closeSettingsConfig", refresh); // Game Settings may have changed panel values
  Hooks.on("renderSidebar", () => updateTabButton(client.getState()));
  return true;
}

/** A render of the panel failed and was toasted; later failures only log. */
let renderFailed = false;
/** Tab button or pip not found after the sidebar rendered; warned once. */
let markupWarned = false;

/**
 * Re-render the in-sidebar panel, which re-renders its popout too. Render
 * failures reject instead of throwing, so they're caught here.
 */
function renderPanel() {
  const app = ui[TAB_NAME];
  if (!app?.rendered) return;
  app.render().catch(err => console.error("[DiceVision] Sidebar panel re-render failed:", err));
}

/**
 * Tint the tab icon by connection state (connecting covers the first
 * connect and reconnects), and light its notification pip while DiceVision
 * waits for dice.
 */
function updateTabButton(state) {
  const button = globalThis.document?.querySelector(`#sidebar-tabs [data-tab="${TAB_NAME}"]`);
  const pip = button?.parentElement?.querySelector(".notification-pip");
  if (!button || !pip) {
    // Expected before the sidebar's first render; afterwards the markup changed
    if (ui.sidebar?.rendered && !markupWarned) {
      markupWarned = true;
      console.warn(`[DiceVision] Sidebar tab ${button ? "pip" : "button"} not found; the tab's connection tint and waiting pip are off`);
    }
    return;
  }
  button.classList.toggle("dicevision-connected", state.connected);
  button.classList.toggle("dicevision-connecting", state.sessionActive && !state.connected);
  pip.classList.toggle("active", state.connected && (state.waiting || state.dialogWaiting));
}

/**
 * Log and toast a failed panel action. `what` is a setting key (shown by
 * its localized name) or an action name.
 */
function reportFailure(what, err) {
  console.error(`[DiceVision] Sidebar: ${what} failed:`, err);
  const name = game.settings.settings.get(`${MODULE_ID}.${what}`)?.name;
  ui.notifications.error(game.i18n.format("DICEVISION.Notifications.CommandFailed", {
    command: name ? game.i18n.localize(name) : what,
    error: err?.message ?? String(err)
  }));
}
