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
    this.rollCallbacks = [];
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
          this._cancelRollCallbacks();
          this._notifyState();
          return;
        }

        this._attemptReconnect();
        this._notifyState();
      };

      this.ws.onerror = (error) => {
        console.error("[DiceVision] WebSocket error:", error);
      };
    } catch (err) {
      console.error("[DiceVision] Failed to create WebSocket:", err);
    }
  }

  /** Disconnect, cancel any pending reconnect, and clean up all state. */
  disconnect() {
    // Older backends don't drop an app's waiting registration when its socket
    // closes, which would leave the dashboard armed for an app that's gone.
    if (this.registered && this.isConnected()) {
      this.sendCancel();
    }
    this._closeSocket();

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.reconnectAttempts = 0;
    this.pendingChatRoll = false;
    this._cancelRollCallbacks();
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
    return this._wantsChatRoll() || this.rollCallbacks.length > 0;
  }

  /** Register or release our waiting state to match _shouldWait(). */
  _syncWaiting() {
    if (!this.isConnected()) return;
    if (this._shouldWait()) {
      this.sendWaiting();
    } else if (this.registered) {
      // The dashboard treats any "cancelled" as nobody waiting, so only send
      // one when we registered; otherwise we'd clear another app's request.
      this.sendCancel();
    }
  }

  /**
   * Ask for the next physical roll to be posted to chat. In continuous mode
   * every roll is posted already, so this is a no-op.
   * @returns {boolean} Whether a roll is now being waited for
   */
  requestRoll() {
    if (game.settings.get(MODULE_ID, "mode") !== "chat") {
      ui.notifications.warn(game.i18n.localize("DICEVISION.Notifications.ModeOff"));
      return false;
    }
    if (!this.isConnected()) {
      ui.notifications.warn(game.i18n.localize("DICEVISION.Notifications.NotConnected"));
      return false;
    }
    if (this._wantsChatRoll()) return true;

    this.pendingChatRoll = true;
    this.sendWaiting();
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
   * @returns {{connected: boolean, sessionCode: string|null, mode: string,
   *   continuous: boolean, waiting: boolean}}
   */
  getState() {
    return {
      connected: this.isConnected(),
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
        console.log("[DiceVision] Waiting cancelled");
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
   * The server confirmed a valid session: reset retries and register as waiting.
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

    const postToChat = this._wantsChatRoll();
    this.pendingChatRoll = false;

    // Resolve any pending waitForResult callbacks (Phase 2)
    this._resolveRollCallbacks(rollData);

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
      // Mode off, or another app on this session asked for the roll
      console.log("[DiceVision] No chat roll requested, ignoring roll");
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

  /**
   * Wait for a specific die result (Phase 2 — Dice Fulfillment API).
   * @param {string} denomination - Die type to match (e.g., "d20")
   * @param {number} [timeoutMs] - Timeout in milliseconds
   * @returns {Promise<number|null>} The die value, or null on timeout, disconnect,
   *   invalid session, or exhausted reconnects
   */
  waitForResult(denomination, timeoutMs) {
    const timeout = timeoutMs || game.settings.get(MODULE_ID, "timeout") * 1000;

    return new Promise((resolve) => {
      const callback = {
        denomination,
        resolve,
        timer: setTimeout(() => {
          const idx = this.rollCallbacks.indexOf(callback);
          if (idx > -1) this.rollCallbacks.splice(idx, 1);
          resolve(null);
          this._syncWaiting();
        }, timeout)
      };

      this.rollCallbacks.push(callback);
      this.sendWaiting();
    });
  }

  /**
   * Resolve pending roll callbacks when a roll arrives.
   * @param {object} rollData - The received roll data
   */
  _resolveRollCallbacks(rollData) {
    if (!this.rollCallbacks.length || !rollData?.dice) return;

    const availableDice = [...rollData.dice];
    const toRemove = [];

    for (const cb of this.rollCallbacks) {
      const matchIdx = availableDice.findIndex(d => d.type === cb.denomination);
      if (matchIdx > -1) {
        const die = availableDice.splice(matchIdx, 1)[0];
        clearTimeout(cb.timer);
        cb.resolve(die.value);
        toRemove.push(cb);
      }
    }

    for (const cb of toRemove) {
      const idx = this.rollCallbacks.indexOf(cb);
      if (idx > -1) this.rollCallbacks.splice(idx, 1);
    }
  }

  /** Resolve all pending waitForResult callbacks with null. */
  _cancelRollCallbacks() {
    for (const cb of this.rollCallbacks) {
      clearTimeout(cb.timer);
      cb.resolve(null);
    }
    this.rollCallbacks = [];
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
      this._cancelRollCallbacks();
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
