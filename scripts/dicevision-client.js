/**
 * DiceVision WebSocket Client
 *
 * Singleton that manages the WebSocket connection to the DiceVision
 * backend bridge at wss://dicevision.dirtyowlbear.com/api/bridge/{code}.
 *
 * Protocol reference: backend/app/routers/bridge.py in wor101/dice-vision
 */

import { displayRollInChat } from "./dice-bridge.js";

const MODULE_ID = "dicevision";
const APP_ID = "foundry";
const WS_BASE_URL = "wss://dicevision.dirtyowlbear.com/api/bridge";
const PING_INTERVAL_MS = 30000;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAYS = [2000, 4000, 8000, 16000, 30000];
const INVALID_SESSION_CLOSE_CODE = 4001;

export class DiceVisionClient {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.sessionCode = null;
    this.pingInterval = null;
    this.reconnectTimeout = null;
    this.reconnectAttempts = 0;
    // Roll dialogs waiting for physical dice (see roll-intercept.js)
    this.rollConsumers = new Set();
    // A one-off chat roll requested via requestRoll() (continuous mode off)
    this.pendingChatRoll = false;
    // Whether the bridge currently has us registered as waiting
    this.registered = false;
    this._setupHooks();
  }

  /** Listen for setting changes to auto-reconnect/disconnect. */
  _setupHooks() {
    Hooks.on("dicevision.sessionCodeChanged", (newCode) => {
      // disconnect() also cancels a pending reconnect to the old code
      if (newCode) {
        this.connect(newCode);
      } else {
        this.disconnect();
      }
    });

    Hooks.on("dicevision.modeChanged", (newMode) => {
      console.log(`[DiceVision] Mode changed to: ${newMode}`);
      if (newMode !== "chat") this.pendingChatRoll = false;
      this._syncWaiting();
      this._notifyState();
    });

    Hooks.on("dicevision.continuousChanged", (continuous) => {
      console.log(`[DiceVision] Continuous mode ${continuous ? "on" : "off"}`);
      this._syncWaiting();
      this._notifyState();
    });
  }

  /**
   * Connect to the DiceVision bridge WebSocket.
   * @param {string} sessionCode - 8-character session code (dash optional, e.g. "XKRM-4N7B")
   */
  connect(sessionCode) {
    this.disconnect();
    this._openSocket(sessionCode);
  }

  /**
   * Open a socket without resetting reconnect state, so automatic retries
   * keep counting toward MAX_RECONNECT_ATTEMPTS.
   * @param {string} sessionCode
   */
  _openSocket(sessionCode) {
    this._closeSocket();

    const code = sessionCode.toUpperCase().replace(/-/g, "");
    this.sessionCode = code;
    const url = `${WS_BASE_URL}/${code}`;

    console.log(`[DiceVision] Connecting to ${url}`);

    try {
      this.ws = new WebSocket(url);

      // The server accepts invalid sessions before closing them with 4001, so
      // the session only counts as live once it sends "connected".
      this.ws.onopen = () => {
        console.log("[DiceVision] Socket open, waiting for session confirmation");
        this._startPing();
      };

      this.ws.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch (err) {
          console.error("[DiceVision] Failed to parse message:", err);
          return;
        }
        try {
          this._onMessage(message);
        } catch (err) {
          console.error(`[DiceVision] Failed to handle "${message.type}" message:`, err);
        }
      };

      this.ws.onclose = (event) => {
        console.log(`[DiceVision] Disconnected: ${event.code} ${event.reason}`);
        this.ws = null;
        this.connected = false;
        this.registered = false;
        this._stopPing();

        if (event.code === INVALID_SESSION_CLOSE_CODE) {
          ui.notifications.error(
            game.i18n.localize("DICEVISION.Notifications.InvalidSession")
          );
          this.sessionCode = null;
          this.pendingChatRoll = false;
          this._notifyState();
          return;
        }

        this._attemptReconnect();
        this._notifyState();
      };

      this.ws.onerror = (error) => {
        console.error("[DiceVision] WebSocket error:", error);
      };
      this._notifyState();
    } catch (err) {
      console.error("[DiceVision] Failed to create WebSocket:", err);
      ui.notifications.error(
        game.i18n.format("DICEVISION.Notifications.ConnectFailed", { error: err.message })
      );
      this.ws = null;
      this.sessionCode = null;
      this._notifyState();
    }
  }

  /** Disconnect, cancel any pending reconnect, and clean up all state. */
  disconnect() {
    // No "cancel" first: the bridge drops our waiting registration when the
    // socket closes (dice-vision#408), and only tells the dashboard if no other
    // app is still waiting. An explicit cancel would always clear it.
    this._closeSocket();

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.reconnectAttempts = 0;
    this.pendingChatRoll = false;
    this._notifyState();
  }

  /** @returns {boolean} Whether the client is currently connected. */
  isConnected() {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Close the current socket without triggering a reconnect. */
  _closeSocket() {
    this._stopPing();

    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }

    this.connected = false;
    this.registered = false;
  }

  /**
   * Whether chat mode wants the next roll: always in continuous mode,
   * otherwise only after requestRoll().
   */
  _wantsChatRoll() {
    if (game.settings.get(MODULE_ID, "mode") !== "chat") return false;
    return this.pendingChatRoll || game.settings.get(MODULE_ID, "continuous");
  }

  /**
   * The DiceVision dashboard forwards a roll only while it believes an app is
   * waiting, and drops that flag after each roll it sends. While waiting it
   * also switches to continuous capture, so only stay registered when a roll
   * is actually wanted.
   */
  _shouldWait() {
    return this._wantsChatRoll() || this._consumerWantsRoll();
  }

  _consumerWantsRoll() {
    return [...this.rollConsumers].some(consumer => consumer.wantsRoll());
  }

  /**
   * Register a roll consumer: an object with wantsRoll() (whether it needs
   * dice right now) and consume(rollData). While any consumer wants a roll,
   * rolls go to it instead of chat. Call sync() whenever wantsRoll() may
   * have changed.
   * @param {{wantsRoll: () => boolean, consume: (rollData: object) => void}} consumer
   * @returns {() => void} Unregisters the consumer
   */
  addRollConsumer(consumer) {
    this.rollConsumers.add(consumer);
    this.sync();
    return () => {
      this.rollConsumers.delete(consumer);
      this.sync();
    };
  }

  /** Re-check whether we should be waiting and tell the UI. */
  sync() {
    this._syncWaiting();
    this._notifyState();
  }

  /** Register or release our waiting state to match _shouldWait(). */
  _syncWaiting() {
    if (!this.isConnected()) return;
    if (this._shouldWait()) {
      // Already registered means the dashboard is waiting: only a roll
      // (_onRollReceived re-arms) or a "cancelled" clears that.
      if (!this.registered) this.sendWaiting();
    } else if (this.registered) {
      // The dashboard treats any "cancelled" as nobody waiting, whatever its
      // app, so never send one we don't need. Even this one clears the request
      // of another app on the session (see CLAUDE.md, WebSocket Protocol).
      this.sendCancel();
    }
  }

  /**
   * Ask for the next physical roll to be posted to chat. A no-op (returning
   * true) if a roll is already wanted: continuous mode or a pending request.
   * @returns {boolean} Whether a roll is now being waited for
   */
  requestRoll() {
    const mode = game.settings.get(MODULE_ID, "mode");
    if (mode === "replace") {
      if (this.isConnected()) ui.notifications.info(game.i18n.localize("DICEVISION.Notifications.ReplaceMode"));
      else ui.notifications.warn(game.i18n.localize("DICEVISION.Notifications.NotConnected"));
      return false;
    }
    if (mode !== "chat") {
      ui.notifications.warn(game.i18n.localize("DICEVISION.Notifications.ModeOff"));
      return false;
    }
    if (!this.isConnected()) {
      ui.notifications.warn(game.i18n.localize("DICEVISION.Notifications.NotConnected"));
      return false;
    }
    if (this._wantsChatRoll()) return true;

    this.pendingChatRoll = true;
    if (!this.sendWaiting()) {
      this.pendingChatRoll = false;
      ui.notifications.warn(game.i18n.localize("DICEVISION.Notifications.NotConnected"));
      return false;
    }
    ui.notifications.info(game.i18n.localize("DICEVISION.Notifications.WaitingForRoll"));
    this._notifyState();
    return true;
  }

  /**
   * Withdraw a pending requestRoll().
   * @returns {boolean} Whether there was a request to cancel
   */
  cancelRequest() {
    if (!this.pendingChatRoll) return false;
    this.pendingChatRoll = false;
    this._syncWaiting();
    this._notifyState();
    return true;
  }

  /**
   * @returns {{connected: boolean, sessionActive: boolean, sessionCode: string|null,
   *   mode: string, continuous: boolean, waiting: boolean}}
   *   sessionActive: connected, connecting, or waiting to reconnect
   */
  getState() {
    return {
      connected: this.isConnected(),
      sessionActive: !!this.ws || !!this.reconnectTimeout,
      sessionCode: this.sessionCode,
      mode: game.settings.get(MODULE_ID, "mode"),
      continuous: game.settings.get(MODULE_ID, "continuous"),
      waiting: this.isConnected() && this._wantsChatRoll()
    };
  }

  /** Tell the UI (chat controls) that connection or waiting state changed. */
  _notifyState() {
    Hooks.callAll("dicevision.stateChanged", this.getState());
  }

  /** Handle incoming WebSocket messages. */
  _onMessage(message) {
    switch (message.type) {
      case "connected":
        this._onSessionConfirmed(message);
        break;

      case "roll":
        // The bridge stamps the outer message; the dashboard's roll data has no timestamp
        this._onRollReceived(message.data && { timestamp: message.timestamp, ...message.data });
        break;

      case "waiting":
        console.log(`[DiceVision] ${message.app || "App"} is waiting for roll`);
        break;

      case "cancelled":
        // Any app's cancel (or another Foundry user's on a shared code) clears
        // the dashboard's waiting state and may have removed "foundry" from
        // the bridge too. Re-register if we still want a roll.
        console.log(`[DiceVision] Waiting cancelled (${message.app ?? "all apps"})`);
        this.registered = false;
        this._syncWaiting();
        break;

      case "pong":
        break;

      case "error":
        console.warn("[DiceVision] Server error:", message.message);
        break;

      default:
        console.log("[DiceVision] Unknown message type:", message.type);
    }
  }

  /**
   * The server confirmed a valid session: reset retries, and register as
   * waiting if a roll is wanted (_shouldWait()).
   * @param {object} message - { session_code, waiting, waiting_apps }
   */
  _onSessionConfirmed(message) {
    console.log("[DiceVision] Session info:", message);
    this.connected = true;
    this.reconnectAttempts = 0;

    if (this._shouldWait()) {
      this.sendWaiting();
    }

    ui.notifications.info(
      game.i18n.format("DICEVISION.Notifications.Connected", { code: this.sessionCode })
    );
    this._notifyState();
  }

  /**
   * Handle received roll data.
   * @param {object} rollData - { dice, total, roll_id?, timestamp? }
   */
  _onRollReceived(rollData) {
    if (!rollData) return;

    console.log("[DiceVision] Roll received:", rollData);

    const wasRegistered = this.registered;
    // A roll dialog waiting for dice takes the roll; otherwise chat mode may
    const consumer = [...this.rollConsumers].find(c => c.wantsRoll());
    const postToChat = !consumer && this._wantsChatRoll();
    if (postToChat) this.pendingChatRoll = false;

    if (consumer) {
      try {
        consumer.consume(rollData);
      } catch (err) {
        console.error("[DiceVision] Failed to apply roll:", err);
        ui.notifications.error(
          game.i18n.format("DICEVISION.Notifications.ApplyFailed", { error: err.message })
        );
      }
    }

    // The dashboard dropped its waiting flag when it sent this roll. Re-arm it
    // if we want another roll, else release the bridge so a reloaded
    // dashboard doesn't find us still waiting.
    if (this._shouldWait()) {
      this.sendWaiting();
    } else if (this.registered) {
      this.sendCancel();
    }
    this._notifyState();

    if (!postToChat) {
      // Used by a roll dialog, mode off, or another app on this session asked for it
      if (!consumer) {
        console.log("[DiceVision] No roll requested, ignoring roll");
        // We asked for it, but the roll dialog was closed or filled meanwhile
        if (wasRegistered && game.settings.get(MODULE_ID, "mode") === "replace") {
          ui.notifications.info(game.i18n.localize("DICEVISION.Notifications.RollIgnored"));
        }
      }
      return;
    }

    displayRollInChat(rollData).catch((err) => {
      console.error("[DiceVision] Failed to display roll:", err);
      ui.notifications.error(
        game.i18n.format("DICEVISION.Notifications.DisplayFailed", { error: err.message })
      );
    });
  }

  /** Send "waiting" message to backend. */
  sendWaiting() {
    const sent = this._send({ type: "waiting", app_id: APP_ID });
    if (sent) this.registered = true;
    return sent;
  }

  /** Send "cancel" message to backend. */
  sendCancel() {
    const sent = this._send({ type: "cancel", app_id: APP_ID });
    if (sent) this.registered = false;
    return sent;
  }

  /** Start keep-alive ping interval. */
  _startPing() {
    this._stopPing();
    this.pingInterval = setInterval(() => {
      this._send({ type: "ping" });
    }, PING_INTERVAL_MS);
  }

  /** Stop keep-alive ping interval. */
  _stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /** Attempt reconnection with doubling backoff (2s → 30s cap), max 5 attempts. */
  _attemptReconnect() {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.log("[DiceVision] Max reconnection attempts reached");
      ui.notifications.warn(
        game.i18n.localize("DICEVISION.Notifications.MaxReconnect")
      );
      this.pendingChatRoll = false;
      return;
    }

    const delay = RECONNECT_DELAYS[this.reconnectAttempts];
    this.reconnectAttempts++;

    console.log(
      `[DiceVision] Reconnecting in ${delay}ms ` +
      `(attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`
    );

    ui.notifications.info(
      game.i18n.format("DICEVISION.Notifications.Reconnecting", {
        attempt: this.reconnectAttempts,
        max: MAX_RECONNECT_ATTEMPTS
      })
    );

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      if (this.sessionCode) {
        this._openSocket(this.sessionCode);
      }
    }, delay);
  }

  /** Send a JSON message via WebSocket. */
  _send(data) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn("[DiceVision] Cannot send — not connected");
      return false;
    }
    this.ws.send(JSON.stringify(data));
    return true;
  }
}

// Singleton instance
export const diceVisionClient = new DiceVisionClient();
