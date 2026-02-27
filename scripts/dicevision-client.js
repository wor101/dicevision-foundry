/**
 * DiceVision WebSocket Client
 *
 * Singleton that manages the WebSocket connection to the DiceVision
 * backend bridge at wss://dicevision.dirtyowlbear.com/api/bridge/{code}.
 *
 * Protocol reference: backend/app/routers/bridge.py
 */

import { displayRollInChat } from "./dice-bridge.js";

const MODULE_ID = "dicevision";
const WS_BASE_URL = "wss://dicevision.dirtyowlbear.com/api/bridge";
const PING_INTERVAL_MS = 30000;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAYS = [2000, 4000, 6000, 8000, 10000];

export class DiceVisionClient {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.sessionCode = null;
    this.pingInterval = null;
    this.reconnectTimeout = null;
    this.reconnectAttempts = 0;
    this.rollCallbacks = [];
    this._setupHooks();
  }

  /** Listen for setting changes to auto-reconnect/disconnect. */
  _setupHooks() {
    Hooks.on("dicevision.sessionCodeChanged", (newCode) => {
      if (this.connected) {
        this.disconnect();
      }
      if (newCode) {
        this.connect(newCode);
      }
    });

    Hooks.on("dicevision.modeChanged", (newMode) => {
      console.log(`[DiceVision] Mode changed to: ${newMode}`);
    });
  }

  /**
   * Connect to the DiceVision bridge WebSocket.
   * @param {string} sessionCode - 6-character session code
   */
  connect(sessionCode) {
    if (this.ws) {
      this.disconnect();
    }

    const code = sessionCode.toUpperCase().replace(/-/g, "");
    this.sessionCode = code;
    const url = `${WS_BASE_URL}/${code}`;

    console.log(`[DiceVision] Connecting to ${url}`);

    try {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        console.log("[DiceVision] Connected");
        this.connected = true;
        this.reconnectAttempts = 0;
        this._startPing();

        ui.notifications.info(
          game.i18n.format("DICEVISION.Notifications.Connected", { code })
        );
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this._onMessage(message);
        } catch (err) {
          console.error("[DiceVision] Failed to parse message:", err);
        }
      };

      this.ws.onclose = (event) => {
        console.log(`[DiceVision] Disconnected: ${event.code} ${event.reason}`);
        this.connected = false;
        this._stopPing();

        if (event.code === 4001) {
          ui.notifications.error(
            game.i18n.localize("DICEVISION.Notifications.InvalidSession")
          );
          this.sessionCode = null;
          return;
        }

        this._attemptReconnect();
      };

      this.ws.onerror = (error) => {
        console.error("[DiceVision] WebSocket error:", error);
      };
    } catch (err) {
      console.error("[DiceVision] Failed to create WebSocket:", err);
    }
  }

  /** Disconnect and clean up all state. */
  disconnect() {
    this._stopPing();

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }

    this.connected = false;
    this.reconnectAttempts = 0;
    this.rollCallbacks = [];
  }

  /** @returns {boolean} Whether the client is currently connected. */
  isConnected() {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Handle incoming WebSocket messages. */
  _onMessage(message) {
    switch (message.type) {
      case "connected":
        console.log("[DiceVision] Session info:", message);
        break;

      case "roll":
        this._onRollReceived(message.data);
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
   * Handle received roll data.
   * @param {object} rollData - { dice, total, roll_id, timestamp, metadata }
   */
  _onRollReceived(rollData) {
    if (!rollData) return;

    console.log("[DiceVision] Roll received:", rollData);

    // Resolve any pending waitForResult callbacks (Phase 2)
    this._resolveRollCallbacks(rollData);

    const mode = game.settings.get(MODULE_ID, "mode");
    if (mode === "off") {
      console.log("[DiceVision] Mode is off, ignoring roll");
      return;
    }

    if (mode === "chat") {
      displayRollInChat(rollData);
    }
  }

  /** Send "waiting" message to backend. */
  sendWaiting() {
    this._send({ type: "waiting", app_id: "foundry" });
  }

  /** Send "cancel" message to backend. */
  sendCancel() {
    this._send({ type: "cancel", app_id: "foundry" });
  }

  /**
   * Wait for a specific die result (Phase 2 — Dice Fulfillment API).
   * @param {string} denomination - Die type to match (e.g., "d20")
   * @param {number} [timeoutMs] - Timeout in milliseconds
   * @returns {Promise<number|null>} The die value, or null on timeout
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

  /** Attempt reconnection with exponential backoff. */
  _attemptReconnect() {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.log("[DiceVision] Max reconnection attempts reached");
      ui.notifications.warn(
        game.i18n.localize("DICEVISION.Notifications.MaxReconnect")
      );
      return;
    }

    const delay = RECONNECT_DELAYS[this.reconnectAttempts] || 10000;
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
      if (this.sessionCode) {
        this.connect(this.sessionCode);
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
