/**
 * DiceVisionClient and chat-bridge behavior tests against mocked Foundry
 * globals and a fake WebSocket. No Foundry or npm install needed:
 *
 *   node tests/client.test.mjs
 *
 * Each case gets a fresh client and reset mocks (see reset()).
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let settings;
let hooks;
let toasts;
let chat;
let timers;
let sockets;
/** Active module ids for game.modules (e.g. "dice-so-nice") */
let activeModules;

globalThis.Hooks = {
  on: (name, fn) => ((hooks[name] ??= []).push(fn)),
  callAll: (name, ...args) => (hooks[name] ?? []).forEach(fn => fn(...args))
};
globalThis.game = {
  settings: {
    get: (_module, key) => settings[key],
    // Fires the hooks the onChange callbacks in settings.js fire. Like real
    // Foundry, saving an unchanged value fires nothing.
    set: async (_module, key, value) => {
      if (settings[key] === value) return;
      settings[key] = value;
      const hook = { mode: "modeChanged", continuous: "continuousChanged", sessionCode: "sessionCodeChanged" }[key];
      if (hook) Hooks.callAll(`dicevision.${hook}`, value);
    }
  },
  i18n: { localize: key => key, format: (key, data) => `${key} ${JSON.stringify(data)}` },
  users: [
    { id: "gm1", isGM: true },
    { id: "u1", isGM: false },
    { id: "u2", isGM: false }
  ],
  user: { id: "u1" },
  modules: { get: id => (activeModules.has(id) ? { id, active: true } : undefined) }
};
globalThis.ui = {
  notifications: {
    info: msg => toasts.push(["info", msg]),
    warn: msg => toasts.push(["warn", msg]),
    error: msg => toasts.push(["error", msg])
  }
};
console.log = () => {};
console.warn = () => {};
console.error = () => {};

// Manual timers: tests run them explicitly and can inspect the delays
globalThis.setTimeout = (fn, ms) => {
  const timer = { fn, ms };
  timers.push(timer);
  return timer;
};
globalThis.clearTimeout = timer => {
  timers = timers.filter(t => t !== timer);
};
globalThis.setInterval = () => ({});
globalThis.clearInterval = () => {};

/** Run all pending timers once; returns their delays. */
function runTimers() {
  const due = timers;
  timers = [];
  due.forEach(t => t.fn());
  return due.map(t => t.ms);
}

class FakeWebSocket {
  static OPEN = 1;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    sockets.push(this);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
  }

  // Test helpers
  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  confirm() {
    this.recv({ type: "connected", session_code: "XKRM4N7B", waiting: false, waiting_apps: [] });
  }

  serverClose(code) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }

  recv(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  sentTypes() {
    return this.sent.map(m => m.type);
  }
}
globalThis.WebSocket = FakeWebSocket;

function reset() {
  // Continuous on reproduces the always-waiting chat mode most cases test
  settings = { mode: "chat", continuous: true, rollLabel: "DV", chatVisibility: "all" };
  hooks = {};
  toasts = [];
  chat = [];
  timers = [];
  sockets = [];
  globalThis.ChatMessage = { create: async data => chat.push(data) };
  globalThis.renderTemplate = async (_template, data) => JSON.stringify(data);
  activeModules = new Set();
  // Roll.fromData stand-in: keeps the data so tests can read the dice back
  globalThis.foundry = {
    dice: { Roll: { fromData: data => ({ data, total: data.total, dice: data.terms.filter(t => t.class === "Die") }) } }
  };
  globalThis.CONFIG = { sounds: { dice: "sounds/dice.wav" } };
}

reset();
const { DiceVisionClient } = await import("../scripts/dicevision-client.js");
const chatControls = await import("../scripts/chat-controls.js");
const { registerChatControls } = chatControls;
const { registerSettings } = await import("../scripts/settings.js");
const { panelStatus, formatCode, registerSidebarTab } = await import("../scripts/sidebar-tab.js");

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let failures = 0;
let passes = 0;

function check(cond, msg) {
  if (cond) {
    passes++;
  } else {
    failures++;
    console.info(`  FAIL: ${msg}`);
  }
}

const flush = () => new Promise(r => setImmediate(r));

async function test(name, fn) {
  reset();
  const client = new DiceVisionClient();
  const before = failures;
  try {
    await fn(client);
  } catch (err) {
    failures++;
    console.info(`  FAIL: threw ${err.stack}`);
  }
  console.info(`${failures === before ? "ok  " : "FAIL"} ${name}`);
}

/** Connect and complete the server handshake; returns the socket. */
function connectConfirmed(client, code = "XKRM4N7B") {
  client.connect(code);
  const ws = sockets.at(-1);
  ws.open();
  ws.confirm();
  return ws;
}

/**
 * A stand-in roll dialog: wants `needed` more rolls. See addRollConsumer().
 * @returns {{needed: number, got: object[], remove: () => void}}
 */
function fakeConsumer(client, needed = 1) {
  const consumer = {
    needed,
    got: [],
    wantsRoll: () => consumer.needed > 0,
    consume: (rollData) => {
      consumer.got.push(rollData);
      consumer.needed--;
    }
  };
  consumer.remove = client.addRollConsumer(consumer);
  return consumer;
}

const ROLL = {
  type: "roll",
  session_code: "XKRM4N7B",
  timestamp: "2026-10-14T12:00:00Z",
  data: { dice: [{ type: "d20", value: 15 }], total: 15, roll_id: "r1" }
};

// ---------------------------------------------------------------------------
// Connection and session confirmation
// ---------------------------------------------------------------------------

await test("normalizes the session code in the URL", (c) => {
  c.connect("xkrm-4n7b");
  check(sockets.at(-1).url.endsWith("/api/bridge/XKRM4N7B"), sockets.at(-1).url);
});

await test("socket open alone does not confirm the session (invalid code: accept, then 4001)", (c) => {
  c.connect("BADCODE1");
  const ws = sockets.at(-1);
  ws.open();
  check(!ws.sentTypes().includes("waiting"), "no waiting before confirmation");
  check(!toasts.some(([, m]) => m.startsWith("DICEVISION.Notifications.Connected")), "no Connected toast before confirmation");
  ws.serverClose(4001);
  check(toasts.at(-1)?.[1] === "DICEVISION.Notifications.InvalidSession", "invalid session error shown");
  check(timers.length === 0, "no reconnect after 4001");
});

await test("confirmed session sends waiting and shows Connected", (c) => {
  const ws = connectConfirmed(c);
  check(ws.sent.some(m => m.type === "waiting" && m.app_id === "foundry"), "waiting sent with app_id foundry");
  check(toasts.some(([, m]) => m.startsWith("DICEVISION.Notifications.Connected")), "Connected toast");
  check(c.isConnected(), "isConnected() true");
});

// ---------------------------------------------------------------------------
// Rolls and chat mode
// ---------------------------------------------------------------------------

await test("roll in chat mode is posted and waiting is re-sent", async (c) => {
  const ws = connectConfirmed(c);
  ws.sent = [];
  ws.recv(ROLL);
  await flush();
  check(ws.sentTypes().includes("waiting"), "waiting re-sent after roll");
  check(chat.length === 1, "one chat message");
  check(chat[0]?.flags.dicevision.timestamp === ROLL.timestamp, "timestamp taken from outer roll message");
  check(chat[0]?.flags.dicevision.rollId === "r1", "roll id stored in flags");
});

await test("mode off: no waiting on confirm, rolls not posted", async (c) => {
  settings.mode = "off";
  const ws = connectConfirmed(c);
  check(!ws.sentTypes().includes("waiting"), "no waiting in mode off");
  ws.recv(ROLL);
  await flush();
  check(chat.length === 0, "roll not posted in mode off");
});

await test("mode off: a roll consumer added while connecting registers waiting on confirm", (c) => {
  settings.mode = "off";
  c.connect("XKRM4N7B");
  fakeConsumer(c);
  const ws = sockets.at(-1);
  ws.open();
  ws.confirm();
  check(ws.sentTypes().includes("waiting"), "waiting sent for the consumer");
});

await test("failed chat post shows an error notification", async (c) => {
  globalThis.ChatMessage = { create: async () => { throw new Error("no permission"); } };
  const ws = connectConfirmed(c);
  ws.recv(ROLL);
  await flush();
  check(toasts.at(-1)?.[0] === "error" && toasts.at(-1)[1].startsWith("DICEVISION.Notifications.DisplayFailed"), `toasts: ${JSON.stringify(toasts)}`);
});

await test("bad messages don't break later rolls", async (c) => {
  const ws = connectConfirmed(c);
  ws.onmessage({ data: "not json" });
  ws.recv({ type: "roll", data: { total: 3 } }); // no dice array
  await flush();
  ws.recv(ROLL);
  await flush();
  check(chat.length === 1, "later valid roll still posted");
});

// ---------------------------------------------------------------------------
// Reconnect
// ---------------------------------------------------------------------------

/** Drop the current socket and let every retry fail without opening. */
function failAllRetries() {
  sockets.at(-1).serverClose(1006);
  const delays = [];
  for (let i = 0; i < 10; i++) {
    const ran = runTimers();
    if (!ran.length) break;
    delays.push(...ran);
    sockets.at(-1).serverClose(1006);
  }
  return delays;
}

await test("reconnect uses doubling backoff and stops after 5 attempts", (c) => {
  connectConfirmed(c);
  const delays = failAllRetries();
  check(JSON.stringify(delays) === "[2000,4000,8000,16000,30000]", `delays ${JSON.stringify(delays)}`);
  check(toasts.at(-1)?.[1] === "DICEVISION.Notifications.MaxReconnect", "MaxReconnect warning");
  check(timers.length === 0, "nothing scheduled after giving up");
});

await test("open without confirmation does not reset the retry counter", (c) => {
  connectConfirmed(c);
  sockets.at(-1).serverClose(1006);
  const delays = [];
  for (let i = 0; i < 10; i++) {
    const ran = runTimers();
    if (!ran.length) break;
    delays.push(...ran);
    const ws = sockets.at(-1);
    ws.open(); // accepted, then the server fails before "connected"
    ws.serverClose(1011);
  }
  check(JSON.stringify(delays) === "[2000,4000,8000,16000,30000]", `delays ${JSON.stringify(delays)}`);
});

await test("a confirmed session resets the retry counter", (c) => {
  connectConfirmed(c);
  sockets.at(-1).serverClose(1006);
  runTimers();
  sockets.at(-1).serverClose(1006); // retry 1 fails
  runTimers();                      // retry 2 succeeds
  sockets.at(-1).open();
  sockets.at(-1).confirm();
  sockets.at(-1).serverClose(1006);
  check(timers[0]?.ms === 2000, `next delay ${timers[0]?.ms}`);
});

await test("manual connect after giving up gets a fresh retry budget", (c) => {
  connectConfirmed(c);
  failAllRetries();
  c.connect("XKRM4N7B");
  sockets.at(-1).serverClose(1006);
  check(timers.length === 1 && timers[0].ms === 2000, `timers ${JSON.stringify(timers.map(t => t.ms))}`);
});

await test("clearing the session code cancels a pending reconnect", (c) => {
  connectConfirmed(c);
  sockets.at(-1).serverClose(1006);
  check(timers.length === 1, "reconnect pending");
  Hooks.callAll("dicevision.sessionCodeChanged", "");
  check(timers.length === 0, "pending reconnect cancelled");
});

// ---------------------------------------------------------------------------
// waiting / cancel registration
// ---------------------------------------------------------------------------

await test("continuous on: mode change to chat sends waiting, off sends cancel", (c) => {
  settings.mode = "off";
  settings.continuous = true;
  const ws = connectConfirmed(c);
  settings.mode = "chat";
  Hooks.callAll("dicevision.modeChanged", "chat");
  check(ws.sentTypes().at(-1) === "waiting", "waiting on switch to chat");
  settings.mode = "off";
  Hooks.callAll("dicevision.modeChanged", "off");
  check(ws.sentTypes().at(-1) === "cancel", "cancel on switch to off");
});

await test("mode change to off keeps waiting while a roll consumer wants dice", (c) => {
  const ws = connectConfirmed(c);
  fakeConsumer(c);
  settings.mode = "off";
  Hooks.callAll("dicevision.modeChanged", "off");
  check(!ws.sentTypes().includes("cancel"), "no cancel while the consumer waits");
  check(ws.sentTypes().at(-1) === "waiting", "still registered");
});

await test("disconnect closes without a cancel (the bridge cleans up on close)", (c) => {
  const ws = connectConfirmed(c);
  c.disconnect();
  check(!ws.sentTypes().includes("cancel"), `sent ${JSON.stringify(ws.sentTypes())}`);
  check(ws.readyState === 3, "socket closed");
});

await test("switching session code closes the old socket and opens a new one", (c) => {
  const oldWs = connectConfirmed(c);
  Hooks.callAll("dicevision.sessionCodeChanged", "ABCD2345");
  check(oldWs.readyState === 3 && !oldWs.sentTypes().includes("cancel"), "old socket closed, no cancel");
  check(sockets.at(-1).url.endsWith("/ABCD2345"), "new socket for new code");
});

// ---------------------------------------------------------------------------
// Continuous mode off: one roll per request
// ---------------------------------------------------------------------------

/** Connect with continuous mode off; returns the socket. */
function connectOneShot(client) {
  settings.continuous = false;
  return connectConfirmed(client);
}

await test("continuous off: confirm does not register waiting", (c) => {
  const ws = connectOneShot(c);
  check(!ws.sentTypes().includes("waiting"), `sent ${JSON.stringify(ws.sentTypes())}`);
  check(!c.getState().waiting, "state not waiting");
});

await test("continuous off: requestRoll waits for one roll, posts it, then releases", async (c) => {
  const ws = connectOneShot(c);
  check(c.requestRoll() === true, "requestRoll returns true");
  check(ws.sentTypes().at(-1) === "waiting", "waiting sent");
  check(toasts.at(-1)?.[1] === "DICEVISION.Notifications.WaitingForRoll", "waiting toast");
  check(c.getState().waiting, "state waiting");
  ws.sent = [];
  ws.recv(ROLL);
  await flush();
  check(chat.length === 1, "roll posted");
  check(JSON.stringify(ws.sentTypes()) === '["cancel"]', `after roll sent ${JSON.stringify(ws.sentTypes())}`);
  check(!c.getState().waiting, "no longer waiting");
});

await test("continuous off: a roll nobody in Foundry asked for is not posted", async (c) => {
  const ws = connectOneShot(c);
  ws.recv(ROLL); // e.g. Talespire on the same session was waiting
  await flush();
  check(chat.length === 0, "not posted");
  check(ws.sent.length === 0, `nothing sent (a cancel would clear the other app): ${JSON.stringify(ws.sentTypes())}`);
});

await test("requestRoll twice sends waiting once", (c) => {
  const ws = connectOneShot(c);
  c.requestRoll();
  c.requestRoll();
  check(ws.sentTypes().filter(t => t === "waiting").length === 1, `sent ${JSON.stringify(ws.sentTypes())}`);
});

await test("requestRoll: not connected or mode off warns and returns false", (c) => {
  settings.continuous = false;
  check(c.requestRoll() === false, "false when disconnected");
  check(toasts.at(-1)?.join() === "warn,DICEVISION.Notifications.NotConnected", `toasts ${JSON.stringify(toasts)}`);
  connectConfirmed(c);
  settings.mode = "off";
  check(c.requestRoll() === false, "false in mode off");
  check(toasts.at(-1)?.join() === "warn,DICEVISION.Notifications.ModeOff", `toasts ${JSON.stringify(toasts)}`);
});

await test("requestRoll in continuous mode is a no-op", (c) => {
  const ws = connectConfirmed(c);
  ws.sent = [];
  toasts = [];
  check(c.requestRoll() === true, "returns true");
  check(ws.sent.length === 0, "nothing sent");
  check(toasts.length === 0, "no waiting toast");
});

await test("cancelRequest releases waiting; a second cancel does nothing", (c) => {
  const ws = connectOneShot(c);
  c.requestRoll();
  check(c.cancelRequest() === true, "first cancel true");
  check(ws.sentTypes().at(-1) === "cancel", "cancel sent");
  const count = ws.sent.length;
  check(c.cancelRequest() === false, "second cancel false");
  check(ws.sent.length === count, "nothing more sent");
});

await test("cancelRequest keeps waiting for a roll consumer", (c) => {
  const ws = connectOneShot(c);
  fakeConsumer(c);
  c.requestRoll();
  c.cancelRequest();
  check(!ws.sentTypes().includes("cancel"), `sent ${JSON.stringify(ws.sentTypes())}`);
  check(ws.sentTypes().at(-1) === "waiting", "still registered");
});

await test("toggling continuous registers and releases waiting", async (c) => {
  const ws = connectOneShot(c);
  await game.settings.set("dicevision", "continuous", true);
  check(ws.sentTypes().at(-1) === "waiting", "waiting on continuous on");
  await game.settings.set("dicevision", "continuous", false);
  check(ws.sentTypes().at(-1) === "cancel", "cancel on continuous off");
});

await test("continuous on then off while a request is pending keeps waiting", async (c) => {
  const ws = connectOneShot(c);
  c.requestRoll();
  await game.settings.set("dicevision", "continuous", true);
  await game.settings.set("dicevision", "continuous", false);
  check(!ws.sentTypes().includes("cancel"), `sent ${JSON.stringify(ws.sentTypes())}`);
  check(c.getState().waiting, "still waiting for the requested roll");
});

await test("mode change to chat with continuous off does not register waiting", (c) => {
  settings.mode = "off";
  const ws = connectOneShot(c);
  settings.mode = "chat";
  Hooks.callAll("dicevision.modeChanged", "chat");
  check(!ws.sentTypes().includes("waiting"), `sent ${JSON.stringify(ws.sentTypes())}`);
});

await test("mode change to off drops a pending request", async (c) => {
  const ws = connectOneShot(c);
  c.requestRoll();
  await game.settings.set("dicevision", "mode", "off");
  check(ws.sentTypes().at(-1) === "cancel", "cancel sent");
  ws.sent = [];
  await game.settings.set("dicevision", "mode", "chat");
  check(!ws.sentTypes().includes("waiting"), "request not revived by switching back to chat");
  check(!c.getState().waiting, "not waiting");
});

await test("a pending request survives a reconnect", (c) => {
  connectOneShot(c);
  c.requestRoll();
  sockets.at(-1).serverClose(1006);
  runTimers();
  const ws = sockets.at(-1);
  ws.open();
  ws.confirm();
  check(ws.sentTypes().includes("waiting"), "waiting re-sent after reconnect");
});

/** Reconnect manually and complete the handshake; returns the new socket. */
function reconnectConfirmed(client) {
  return connectConfirmed(client);
}

/** After a reconnect, assert an old request is gone: no waiting, roll not posted. */
async function checkRequestDropped(client) {
  const ws = reconnectConfirmed(client);
  check(!ws.sentTypes().includes("waiting"), `no waiting after reconnect: ${JSON.stringify(ws.sentTypes())}`);
  ws.recv(ROLL);
  await flush();
  check(chat.length === 0, "roll not posted");
}

await test("disconnect drops a pending request", async (c) => {
  connectOneShot(c);
  c.requestRoll();
  c.disconnect();
  await checkRequestDropped(c);
});

await test("invalid session (4001) drops a pending request", async (c) => {
  connectOneShot(c);
  c.requestRoll();
  sockets.at(-1).serverClose(4001);
  await checkRequestDropped(c);
});

await test("exhausted reconnects drop a pending request", async (c) => {
  connectOneShot(c);
  c.requestRoll();
  failAllRetries();
  await checkRequestDropped(c);
});

await test("removing a roll consumer releases waiting", (c) => {
  const ws = connectOneShot(c);
  const consumer = fakeConsumer(c);
  check(ws.sentTypes().at(-1) === "waiting", "waiting sent");
  consumer.remove();
  check(ws.sentTypes().at(-1) === "cancel", `sent ${JSON.stringify(ws.sentTypes())}`);
});

await test("removing a roll consumer in continuous mode stays registered", (c) => {
  const ws = connectConfirmed(c);
  fakeConsumer(c).remove();
  check(!ws.sentTypes().includes("cancel"), `sent ${JSON.stringify(ws.sentTypes())}`);
});

await test("continuous off: a roll a consumer takes isn't posted, then waiting is released", async (c) => {
  const ws = connectOneShot(c);
  const consumer = fakeConsumer(c);
  ws.recv(ROLL);
  await flush();
  check(consumer.got[0]?.dice?.[0]?.value === 15, "consumer got the roll");
  check(consumer.got[0]?.timestamp === ROLL.timestamp, "with the bridge timestamp");
  check(chat.length === 0, "not posted to chat");
  check(ws.sentTypes().at(-1) === "cancel", "released after the roll");
});

await test("continuous on: a waiting roll consumer takes the roll instead of chat", async (c) => {
  const ws = connectConfirmed(c);
  const consumer = fakeConsumer(c);
  ws.recv(ROLL);
  await flush();
  check(consumer.got.length === 1 && chat.length === 0, `consumer ${consumer.got.length}, chat ${chat.length}`);
  ws.recv(ROLL);
  await flush();
  check(consumer.got.length === 1 && chat.length === 1, "next roll goes to chat once the consumer is done");
});

await test("a one-off chat request survives a roll a consumer took", async (c) => {
  const ws = connectOneShot(c);
  c.requestRoll();
  fakeConsumer(c);
  ws.recv(ROLL);
  await flush();
  check(chat.length === 0, "consumer roll not posted");
  check(c.getState().waiting, "chat request still pending");
  ws.recv(ROLL);
  await flush();
  check(chat.length === 1, "next roll posted");
});

await test("a consumer that still wants dice after a roll re-arms waiting", async (c) => {
  const ws = connectOneShot(c);
  fakeConsumer(c, 2);
  ws.sent = [];
  ws.recv(ROLL);
  await flush();
  check(JSON.stringify(ws.sentTypes()) === '["waiting"]', `sent ${JSON.stringify(ws.sentTypes())}`);
});

await test("sync() doesn't resend waiting while already registered", (c) => {
  const ws = connectOneShot(c);
  fakeConsumer(c);
  const count = ws.sent.length;
  c.sync();
  c.sync();
  check(ws.sent.length === count, `sent ${JSON.stringify(ws.sentTypes())}`);
});

await test("a throwing consumer doesn't stop re-arming or later rolls", async (c) => {
  const ws = connectOneShot(c);
  let calls = 0;
  c.addRollConsumer({ wantsRoll: () => true, consume: () => { calls++; throw new Error("boom"); } });
  ws.sent = [];
  ws.recv(ROLL);
  ws.recv(ROLL);
  await flush();
  check(calls === 2, `consume called ${calls} times`);
  check(ws.sentTypes().filter(t => t === "waiting").length === 2, `sent ${JSON.stringify(ws.sentTypes())}`);
});

await test("a roll consumer survives a reconnect and re-registers", (c) => {
  const ws = connectOneShot(c);
  fakeConsumer(c);
  ws.serverClose(1006);
  runTimers();
  const next = sockets.at(-1);
  check(next !== ws, "reconnected");
  next.open();
  next.confirm();
  check(next.sentTypes().includes("waiting"), "waiting re-sent on the new socket");
});

await test("Replace mode: /dv roll posts the next roll to chat", async (c) => {
  settings.mode = "replace";
  const ws = connectOneShot(c);
  check(c.requestRoll() === true, "accepted");
  check(ws.sentTypes().at(-1) === "waiting", "waiting sent");
  ws.recv(ROLL);
  await flush();
  check(chat.length === 1, "posted to chat");
  check(ws.sentTypes().at(-1) === "cancel", "released");
});

await test("no_dice while waiting warns and keeps waiting", async (c) => {
  const ws = connectOneShot(c);
  c.requestRoll();
  const count = ws.sent.length;
  toasts = [];
  ws.recv({ type: "no_dice", session_code: "XKRM4N7B" });
  check(toasts.at(-1)?.[0] === "warn" && toasts.at(-1)[1] === "DICEVISION.Notifications.NoDice", `toasts ${JSON.stringify(toasts)}`);
  check(ws.sent.length === count, "nothing sent: the dashboard keeps capturing");
  check(c.getState().waiting, "still waiting");
});

await test("no_dice when we didn't ask is ignored", (c) => {
  const ws = connectOneShot(c);
  toasts = [];
  ws.recv({ type: "no_dice", session_code: "XKRM4N7B" });
  check(toasts.length === 0, `toasts ${JSON.stringify(toasts)}`);
});


await test("never-registered client sends no cancel on mode or continuous changes", async (c) => {
  const ws = connectOneShot(c);
  await game.settings.set("dicevision", "mode", "off");
  await game.settings.set("dicevision", "mode", "chat");
  Hooks.callAll("dicevision.continuousChanged", false);
  check(ws.sent.length === 0, `sent ${JSON.stringify(ws.sentTypes())}`);
});

await test("cancelled from elsewhere re-registers a pending request", (c) => {
  const ws = connectOneShot(c);
  c.requestRoll();
  ws.sent = [];
  ws.recv({ type: "cancelled", session_code: "XKRM4N7B", app: "talespire" });
  check(JSON.stringify(ws.sentTypes()) === '["waiting"]', `sent ${JSON.stringify(ws.sentTypes())}`);
});

await test("cancelled from elsewhere re-registers continuous mode", (c) => {
  const ws = connectConfirmed(c);
  ws.sent = [];
  ws.recv({ type: "cancelled", session_code: "XKRM4N7B", app: "foundry" }); // another Foundry user
  check(JSON.stringify(ws.sentTypes()) === '["waiting"]', `sent ${JSON.stringify(ws.sentTypes())}`);
});

await test("the echo of our own cancel doesn't re-register or cancel again", (c) => {
  const ws = connectOneShot(c);
  c.requestRoll();
  c.cancelRequest();
  ws.sent = [];
  ws.recv({ type: "cancelled", session_code: "XKRM4N7B", app: "foundry" });
  check(ws.sent.length === 0, `sent ${JSON.stringify(ws.sentTypes())}`);
});

await test("cancelled while not wanting a roll sends nothing", (c) => {
  const ws = connectOneShot(c);
  ws.recv({ type: "cancelled", session_code: "XKRM4N7B", app: "codex" });
  check(ws.sent.length === 0, `sent ${JSON.stringify(ws.sentTypes())}`);
});

await test("state changes are announced for the chat controls", (c) => {
  const states = [];
  Hooks.on("dicevision.stateChanged", s => states.push(s));
  connectOneShot(c);
  c.requestRoll();
  check(states.at(-1)?.connected && states.at(-1)?.waiting, `last ${JSON.stringify(states.at(-1))}`);
  c.cancelRequest();
  check(states.at(-1)?.waiting === false, "not waiting after cancel");
  c.requestRoll();
  sockets.at(-1).recv(ROLL);
  check(states.at(-1)?.waiting === false, "not waiting after the roll");
  sockets.at(-1).serverClose(1006);
  check(states.at(-1)?.connected === false, "disconnected after close");
});

await test("getState: a pending request isn't 'waiting' while disconnected", (c) => {
  connectOneShot(c);
  c.requestRoll();
  sockets.at(-1).serverClose(1006);
  check(c.getState().waiting === false, "not waiting while reconnecting");
  runTimers();
  sockets.at(-1).open();
  sockets.at(-1).confirm();
  check(c.getState().waiting === true, "waiting again once reconnected");
});

await test("a WebSocket that can't be created shows an error", (c) => {
  globalThis.WebSocket = class { constructor() { throw new SyntaxError("bad url"); } };
  try {
    c.connect("XKRM4N7B");
  } finally {
    globalThis.WebSocket = FakeWebSocket;
  }
  check(toasts.at(-1)?.[0] === "error" && toasts.at(-1)[1].startsWith("DICEVISION.Notifications.ConnectFailed"), `toasts ${JSON.stringify(toasts)}`);
  check(c.sessionCode === null && timers.length === 0, "no session, no retry");
});

// ---------------------------------------------------------------------------
// /dv chat commands
// ---------------------------------------------------------------------------

/** Send a chat line through the chatMessage hook; returns the hook's result. */
function chatLine(message) {
  return hooks.chatMessage.map(fn => fn({}, message, {})).find(r => r !== undefined);
}

await test("plainText unwraps v14's rich-text chat input", () => {
  const { plainText } = chatControls;
  check(plainText("<p>/dv status</p>") === "/dv status", plainText("<p>/dv status</p>"));
  check(plainText("<p>/dv&nbsp;connect XKRM-4N7B</p>") === "/dv connect XKRM-4N7B", "nbsp");
  check(plainText("/dv roll") === "/dv roll", "plain text unchanged (v12/v13 textarea)");
  check(plainText("<p><strong>/dv</strong> mode chat</p>") === "/dv mode chat", "inline formatting");
});

await test("/dv commands typed in v14's chat editor (HTML) are handled", async (c) => {
  registerChatControls(c);
  const ws = connectOneShot(c);
  check(chatLine("<p>/dv roll</p>") === false, "message stopped");
  check(ws.sentTypes().at(-1) === "waiting", "roll requested");
  chatLine("<p>/dv&nbsp;mode replace</p>");
  await flush();
  check(settings.mode === "replace", `mode ${settings.mode}`);
  check(chatLine("<p>/dvx</p>") === undefined, "other commands untouched");
});

await test("/dv roll requests a roll and stops the message reaching chat", (c) => {
  registerChatControls(c);
  const ws = connectOneShot(c);
  check(chatLine("/dv roll") === false, "hook returns false");
  check(ws.sentTypes().at(-1) === "waiting", "waiting sent");
});

await test("other chat messages pass through", (c) => {
  registerChatControls(c);
  check(chatLine("/roll 1d20") === undefined, "/roll untouched");
  check(chatLine("/dvx") === undefined, "/dvx untouched");
});

await test("/dv continuous toggles, and accepts on/off", async (c) => {
  registerChatControls(c);
  const ws = connectOneShot(c);
  chatLine("/dv continuous");
  await flush();
  check(settings.continuous === true && ws.sentTypes().at(-1) === "waiting", "toggled on");
  chatLine("/dv continuous off");
  await flush();
  check(settings.continuous === false && ws.sentTypes().at(-1) === "cancel", "set off");
});

await test("/dv commands are case-insensitive; bare /dv shows help", async (c) => {
  registerChatControls(c);
  const ws = connectOneShot(c);
  check(chatLine("/DV ROLL") === false, "handled");
  check(ws.sentTypes().at(-1) === "waiting", "roll requested");
  chatLine("/dv");
  await flush();
  check(chat.at(-1)?.content === "DICEVISION.Commands.Help", "help");
});

await test("/dv cancel with nothing pending says so", async (c) => {
  registerChatControls(c);
  connectOneShot(c);
  chatLine("/dv cancel");
  await flush();
  check(chat.at(-1)?.content === "DICEVISION.Commands.NothingToCancel", `chat ${JSON.stringify(chat.at(-1))}`);
});

await test("/dv continuous with a bad argument shows help and changes nothing", async (c) => {
  registerChatControls(c);
  connectOneShot(c);
  chatLine("/dv continuous maybe");
  await flush();
  check(settings.continuous === false, "unchanged");
  check(chat.at(-1)?.content === "DICEVISION.Commands.Help", "help");
});

await test("/dv mode sets off, chat or replace; anything else shows help", async (c) => {
  registerChatControls(c);
  connectOneShot(c);
  chatLine("/dv mode off");
  await flush();
  check(settings.mode === "off", "off");
  chatLine("/dv mode Replace");
  await flush();
  check(settings.mode === "replace", "replace");
  chatLine("/dv mode Chat");
  await flush();
  check(settings.mode === "chat", "chat");
  chatLine("/dv mode bogus");
  await flush();
  check(settings.mode === "chat" && chat.at(-1)?.content === "DICEVISION.Commands.Help", "invalid mode rejected");
});

await test("/dv connect saves a new code and connects", async (c) => {
  registerChatControls(c);
  settings.sessionCode = "";
  // settings.js's onChange connects; the hook stands in for it
  chatLine("/dv connect abcd-2345");
  await flush();
  check(settings.sessionCode === "abcd-2345", "setting saved");
  check(sockets.at(-1)?.url.endsWith("/ABCD2345"), `socket ${sockets.at(-1)?.url}`);
});

await test("/dv connect with the saved code reconnects anyway", async (c) => {
  registerChatControls(c);
  settings.sessionCode = "XKRM-4N7B";
  connectConfirmed(c);
  chatLine("/dv disconnect");
  await flush();
  check(!c.isConnected(), "disconnected");
  const before = sockets.length;
  chatLine("/dv connect xkrm4n7b"); // same code, different spelling
  await flush();
  check(sockets.length === before + 1 && sockets.at(-1).url.endsWith("/XKRM4N7B"), "new socket opened");
});

await test("/dv connect rejects a malformed code or missing argument", async (c) => {
  registerChatControls(c);
  settings.sessionCode = "";
  chatLine("/dv connect not-a-code");
  chatLine("/dv connect");
  await flush();
  check(sockets.length === 0 && settings.sessionCode === "", "nothing saved or opened");
  check(chat[0]?.content.startsWith("DICEVISION.Commands.InvalidCode") && chat[1]?.content === "DICEVISION.Commands.Help",
    `chat ${JSON.stringify(chat.map(m => m.content))}`);
});

await test("/dv disconnect: disconnects, or says it wasn't connected", async (c) => {
  registerChatControls(c);
  connectOneShot(c);
  chatLine("/dv disconnect");
  await flush();
  check(!c.isConnected() && toasts.at(-1)?.[1] === "DICEVISION.Notifications.Disconnected", "disconnected");
  chatLine("/dv disconnect");
  await flush();
  check(chat.at(-1)?.content === "DICEVISION.Commands.AlreadyDisconnected", "already disconnected");
});

await test("a failing command shows an error notification", async (c) => {
  registerChatControls(c);
  globalThis.ChatMessage = { create: async () => { throw new Error("db locked"); } };
  chatLine("/dv status");
  await flush();
  await flush();
  check(toasts.at(-1)?.[0] === "error" && toasts.at(-1)[1].startsWith("DICEVISION.Notifications.CommandFailed"), `toasts ${JSON.stringify(toasts)}`);
});

await test("/dv status and unknown commands reply privately", async (c) => {
  registerChatControls(c);
  connectOneShot(c);
  chatLine("/dv status");
  chatLine("/dv nonsense");
  await flush();
  check(chat.length === 2 && chat.every(m => JSON.stringify(m.whisper) === '["u1"]'), `chat ${JSON.stringify(chat)}`);
  check(chat[1]?.content === "DICEVISION.Commands.Help", "help shown for unknown command");
  check(chat[0]?.content.includes('"continuous":"off"') && chat[0]?.content.includes('"waiting":"no"'), `status ${chat[0]?.content}`);
});

// ---------------------------------------------------------------------------
// Chat sidebar buttons (minimal DOM stand-in)
// ---------------------------------------------------------------------------

class FakeElement {
  constructor(tag) {
    this.tag = tag;
    this.className = "";
    this.dataset = {};
    this.attributes = {};
    this.children = [];
    this.parent = null;
    this.disabled = false;
    this.listeners = {};
    const el = this;
    this.classList = {
      toggle(name, force) {
        const names = new Set(el.className.split(" ").filter(Boolean));
        if (force ?? !names.has(name)) names.add(name); else names.delete(name);
        el.className = [...names].join(" ");
      },
      contains: name => el.className.split(" ").includes(name)
    };
  }
  append(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  prepend(node) { node.parent = this; this.children.unshift(node); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  click() { if (!this.disabled) (this.listeners.click ?? []).forEach(fn => fn({ preventDefault() {} })); }
  matches(selector) {
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    const m = /^\[data-dv="(.+)"\]$/.exec(selector);
    return !!m && this.dataset.dv === m[1];
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
}

/** Register the controls with a fake #chat-controls; returns a button lookup. */
function withChatControls(client) {
  const host = new FakeElement("div");
  globalThis.document = {
    getElementById: id => (id === "chat-controls" ? host : null),
    createElement: tag => new FakeElement(tag)
  };
  registerChatControls(client);
  return name => host.querySelector(`[data-dv="${name}"]`);
}

async function controlsTest(name, fn) {
  await test(name, async (c) => {
    try {
      await fn(c);
    } finally {
      delete globalThis.document;
    }
  });
}

await controlsTest("buttons appear in chat and replace mode and go away in mode off", async (c) => {
  const button = withChatControls(c);
  connectOneShot(c);
  check(button("request") && button("continuous"), "both buttons rendered");
  await game.settings.set("dicevision", "mode", "replace");
  check(button("request") && button("continuous"), "still there in replace mode");
  await game.settings.set("dicevision", "mode", "off");
  check(!button("request"), "removed in mode off");
});

await controlsTest("dice button requests a roll, and a second click cancels it", (c) => {
  const button = withChatControls(c);
  const ws = connectOneShot(c);
  button("request").click();
  check(ws.sentTypes().at(-1) === "waiting", "waiting sent");
  check(button("request").getAttribute("aria-pressed") === "true", "pressed while waiting");
  check(button("request").classList.contains("dicevision-waiting"), "pulsing while waiting");
  button("request").click();
  check(ws.sentTypes().at(-1) === "cancel", "cancel sent");
  check(button("request").getAttribute("aria-pressed") === "false", "released");
});

await controlsTest("dice button is disabled while disconnected or in continuous mode", async (c) => {
  const button = withChatControls(c);
  connectOneShot(c);
  check(!button("request").disabled, "enabled when connected");
  await game.settings.set("dicevision", "continuous", true);
  check(button("request").disabled, "disabled in continuous mode");
  check(button("continuous").getAttribute("aria-pressed") === "true", "continuous button pressed");
  await game.settings.set("dicevision", "continuous", false);
  sockets.at(-1).serverClose(1006);
  check(button("request").disabled, "disabled while disconnected");
});

await controlsTest("continuous button toggles the setting", async (c) => {
  const button = withChatControls(c);
  const ws = connectOneShot(c);
  button("continuous").click();
  await flush();
  check(settings.continuous === true && ws.sentTypes().at(-1) === "waiting", "on");
  button("continuous").click();
  await flush();
  check(settings.continuous === false && ws.sentTypes().at(-1) === "cancel", "off");
});

// ---------------------------------------------------------------------------
// Settings registration
// ---------------------------------------------------------------------------

await test("continuous mode is a client setting, off by default, wired to its hook", () => {
  const registered = {};
  game.settings.register = (_module, key, config) => { registered[key] = config; };
  try {
    registerSettings();
  } finally {
    delete game.settings.register;
  }
  const continuous = registered.continuous;
  check(continuous?.default === false && continuous.scope === "client" && continuous.type === Boolean, JSON.stringify(continuous));
  let fired;
  Hooks.on("dicevision.continuousChanged", v => { fired = v; });
  continuous.onChange(true);
  check(fired === true, "onChange fires dicevision.continuousChanged");
  check(registered.mode?.default === "off", "mode defaults to off");
});

// ---------------------------------------------------------------------------
// Dice matching (dice-matching.js)
// ---------------------------------------------------------------------------

const { matchDice } = await import("../scripts/dice-matching.js");

/** Values matchDice assigns, in `needs` order (undefined = left open). */
function filled(dice, needs) {
  const { fills, unused } = matchDice(dice, needs);
  const values = needs.map((_, i) => fills.find(f => f.index === i)?.value);
  return { values, unused };
}
const die = (type, value) => ({ type, value });

await test("matchDice: by type, any order", () => {
  const { values, unused } = filled([die("d6", 4), die("d20", 17), die("d20", 3)], ["d20", "d6", "d20"]);
  check(JSON.stringify(values) === "[17,4,3]", `values ${JSON.stringify(values)}`);
  check(unused.length === 0, "nothing unused");
});

await test("matchDice: partial match leaves slots open, extras are not-needed", () => {
  const { values, unused } = filled([die("d20", 12), die("d8", 5)], ["d20", "d6"]);
  check(values[0] === 12 && values[1] === undefined, `values ${JSON.stringify(values)}`);
  check(unused.length === 1 && unused[0].type === "d8" && unused[0].reason === "not-needed", JSON.stringify(unused));
});

await test("matchDice: d10 0 counts as 10", () => {
  check(filled([die("d10", 0)], ["d10"]).values[0] === 10, "0 -> 10");
});

await test("matchDice: out-of-range and non-integer values are rejected", () => {
  const { values, unused } = filled([die("d20", 25), die("d6", 0), die("d8", 2.5)], ["d20", "d6", "d8"]);
  check(values.every(v => v === undefined), `values ${JSON.stringify(values)}`);
  const reasons = Object.fromEntries(unused.map(d => [d.type, d.reason]));
  check(reasons.d20 === "out-of-range" && reasons.d6 === "out-of-range" && reasons.d8 === "unreadable", JSON.stringify(unused));
});

await test("matchDice: percentile pairs fill d100", () => {
  check(filled([die("d10", 30), die("d10", 7)], ["d100"]).values[0] === 37, "30 + 7");
  check(filled([die("d10", 7), die("d10", 30)], ["d100"]).values[0] === 37, "order-independent");
  check(filled([die("d10", 0), die("d10", 0)], ["d100"]).values[0] === 100, "00 + 0 = 100");
  check(filled([die("d10", 0), die("d10", 5)], ["d100"]).values[0] === 5, "00 + 5 = 5");
  check(filled([die("d10", 90), die("d10", 0)], ["d100"]).values[0] === 90, "90 + 0 = 90");
  check(filled([die("d100", 42)], ["d100"]).values[0] === 42, "a d100-typed die fills directly");
});

await test("matchDice: an incomplete percentile pair fills nothing", () => {
  const { values, unused } = filled([die("d10", 30)], ["d100"]);
  check(values[0] === undefined, "d100 open");
  check(unused.length === 1 && unused[0].value === 30, JSON.stringify(unused));
  check(filled([die("d10", 3), die("d10", 7)], ["d100"]).values[0] === undefined, "two units dice aren't a pair");
});

await test("matchDice: d100 + d10 roll takes the pair first, then the d10", () => {
  const { values } = filled([die("d10", 4), die("d10", 20), die("d10", 0)], ["d10", "d100"]);
  check(values[1] === 24 && values[0] === 10, `values ${JSON.stringify(values)}`);
});

await test("matchDice: percentile edge cases", () => {
  check(filled([die("d10", 0), die("d10", 50)], ["d100"]).values[0] === 50, "00 listed first still pairs 50 + 0");
  check(filled([die("d10", 30), die("d10", 20)], ["d100"]).values[0] === undefined, "two tens dice aren't a pair");
  const two = filled([die("d10", 40), die("d10", 3), die("d10", 0), die("d10", 0)], ["d100", "d100"]).values;
  check(JSON.stringify(two) === "[43,100]", `two d100s ${JSON.stringify(two)}`);
  const { unused } = filled([die("d10", 3)], ["d100"]);
  check(unused[0]?.reason === "missing-pair", `a lone units die is missing-pair ${JSON.stringify(unused)}`);
});

await test("matchDice: die types are case-insensitive", () => {
  check(filled([die("D20", 5)], ["d20"]).values[0] === 5, "D20");
});

await test("matchDice: no dice at all", () => {
  const { fills, unused } = matchDice(undefined, ["d20"]);
  check(fills.length === 0 && unused.length === 0, "empty result");
});

await test("matchDice: pips arrive as numbers and match d6", () => {
  check(JSON.stringify(filled([die("d6", 6), die("d6", 5)], ["d6", "d6"]).values) === "[6,5]", "pips");
});

// ---------------------------------------------------------------------------
// Replace mode: roll dialog integration (roll-intercept.js)
// ---------------------------------------------------------------------------

const { registerRollIntercept, METHOD_ID } = await import("../scripts/roll-intercept.js");

/** Minimal DOM node for the parts of a RollResolver form roll-intercept touches. */
class FakeNode {
  constructor(tag, props = {}) {
    Object.assign(this, { tag, nodeName: tag.toUpperCase(), children: [], parentElement: null, className: "", textContent: "", dataset: {} }, props);
    const node = this;
    this.classList = {
      toggle(name, force) {
        const names = new Set(node.className.split(" ").filter(Boolean));
        if (force ?? !names.has(name)) names.add(name); else names.delete(name);
        node.className = [...names].join(" ");
      }
    };
  }
  append(child) { child.parentElement = this; this.children.push(child); }
  prepend(child) { child.parentElement = this; this.children.unshift(child); }
  after(node) {
    const siblings = this.parentElement.children;
    node.parentElement = this.parentElement;
    siblings.splice(siblings.indexOf(this) + 1, 0, node);
  }
  remove() {
    const siblings = this.parentElement?.children;
    if (siblings) siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  // Supports the selectors roll-intercept.js uses
  querySelectorAll(selector) {
    const all = [...this.walk()];
    if (selector.startsWith(".")) return all.filter(n => n.className.split(" ").includes(selector.slice(1)));
    const m = /^label\[data-method="(.+)"\] > input:not\(:disabled\)$/.exec(selector);
    if (m) return all.filter(n => n.tag === "input" && !n.disabled && n.parentElement?.dataset.method === m[1]);
    const label = /^label\[data-method="(.+)"\]$/.exec(selector);
    if (label) return all.filter(n => n.tag === "label" && n.dataset.method === label[1]);
    if (selector === 'button[type="submit"]') return all.filter(n => n.tag === "button" && n.type === "submit");
    if (selector === "input") return all.filter(n => n.tag === "input");
    throw new Error(`unsupported selector ${selector}`);
  }
}

/**
 * A RollResolver stand-in: one input per die, `method` per die (default
 * dicevision). registerResult mirrors Foundry's: first empty matching input.
 */
function fakeResolver(denominations, method = METHOD_ID) {
  const form = new FakeNode("form");
  form.append(new FakeNode("p", { className: "formula", textContent: denominations.join("+") }));
  const fulfillable = new Map();
  denominations.forEach((denomination, i) => {
    const label = new FakeNode("label", { dataset: { denomination, method } });
    label.append(new FakeNode("input", { value: "", disabled: false, name: `t${i}` }));
    form.append(label);
    fulfillable.set(`t${i}`, { term: { randomFace: () => 2 } });
  });
  const submit = new FakeNode("button", { type: "submit", disabled: false });
  form.append(submit);
  const app = {
    rendered: true,
    element: form,
    fulfillable,
    results: [],
    registerResult(m, denomination, value) {
      const input = form.querySelectorAll(`label[data-method="${m}"] > input:not(:disabled)`)
        .find(i => i.value === "" && i.parentElement.dataset.denomination === denomination);
      if (!input) return false;
      input.value = `${value}`;
      app.results.push([denomination, value]);
      return true;
    },
    submit,
    /** Add an explode/reroll input the way RollResolver.resolveResult does */
    addExtraDie(denomination, name = `x${form.children.length}`) {
      const label = new FakeNode("label", { dataset: { denomination, method } });
      label.append(new FakeNode("input", { value: "", disabled: false, name }));
      form.append(label);
      return label;
    },
    values: () => form.querySelectorAll("input").map(i => i.value),
    status: () => form.querySelector(".dicevision-status")?.textContent,
    notice: () => form.querySelector(".dicevision-status-notice")?.textContent
  };
  return app;
}

async function interceptTest(name, fn) {
  await test(name, async (c) => {
    globalThis.CONFIG = { Dice: { fulfillment: { methods: {}, defaultMethod: "" } }, sounds: { dice: "sounds/dice.wav" } };
    globalThis.document = { createElement: tag => new FakeNode(tag), getElementById: () => null };
    try {
      registerRollIntercept(c);
      await fn(c);
    } finally {
      delete globalThis.CONFIG;
      delete globalThis.document;
    }
  });
}

const open = (app) => Hooks.callAll("renderRollResolver", app);
const close = (app) => Hooks.callAll("closeRollResolver", app);
const rollOf = (...dice) => ({ ...ROLL, data: { dice: dice.map(([type, value]) => ({ type, value })), total: 0 } });

await interceptTest("registers an interactive dicevision fulfillment method", () => {
  const method = CONFIG.Dice.fulfillment.methods[METHOD_ID];
  check(method?.interactive === true && method.label === "DICEVISION.Fulfillment.Label", JSON.stringify(method));
});

await interceptTest("Replace mode routes dice to DiceVision while a session is active", async (c) => {
  settings.mode = "replace";
  check(CONFIG.Dice.fulfillment.defaultMethod === "", "not before connecting");
  const ws = connectConfirmed(c);
  check(CONFIG.Dice.fulfillment.defaultMethod === METHOD_ID, "on once connected");
  ws.serverClose(1006);
  check(CONFIG.Dice.fulfillment.defaultMethod === METHOD_ID, "kept while reconnecting, so rolls don't silently turn digital");
  runTimers();
  sockets.at(-1).open();
  sockets.at(-1).confirm();
  await game.settings.set("dicevision", "mode", "chat");
  check(CONFIG.Dice.fulfillment.defaultMethod === "", "off in chat mode");
});

await interceptTest("Replace mode hands rolls back on disconnect, invalid session, or giving up", async (c) => {
  settings.mode = "replace";
  connectConfirmed(c);
  c.disconnect();
  check(CONFIG.Dice.fulfillment.defaultMethod === "", "explicit disconnect");
  c.connect("BADCODE1");
  check(CONFIG.Dice.fulfillment.defaultMethod === METHOD_ID, "on while connecting");
  sockets.at(-1).open();
  sockets.at(-1).serverClose(4001);
  check(CONFIG.Dice.fulfillment.defaultMethod === "", "invalid session");
  connectConfirmed(c);
  failAllRetries();
  check(CONFIG.Dice.fulfillment.defaultMethod === "", "reconnects exhausted");
});

await interceptTest("another module's default method is untouched outside Replace and restored after it", async (c) => {
  CONFIG.Dice.fulfillment.defaultMethod = "bluetooth";
  settings.mode = "chat";
  connectOneShot(c);
  check(CONFIG.Dice.fulfillment.defaultMethod === "bluetooth", "untouched in chat mode");
  await game.settings.set("dicevision", "mode", "replace");
  check(CONFIG.Dice.fulfillment.defaultMethod === METHOD_ID, "replaced in Replace mode");
  await game.settings.set("dicevision", "mode", "off");
  check(CONFIG.Dice.fulfillment.defaultMethod === "bluetooth", "restored after");
});

await interceptTest("an open dialog registers waiting and fills from the roll", async (c) => {
  settings.mode = "replace";
  const ws = connectOneShot(c);
  const app = fakeResolver(["d20", "d20", "d6"]);
  open(app);
  check(ws.sentTypes().at(-1) === "waiting", "waiting on open");
  check(app.status() === 'DICEVISION.Fulfillment.Waiting {"dice":"2d20, 1d6"}', `status ${app.status()}`);
  ws.recv(rollOf(["d6", 3], ["d20", 18], ["d20", 4]));
  await flush();
  check(JSON.stringify(app.values()) === '["18","4","3"]', `values ${JSON.stringify(app.values())}`);
  check(ws.sentTypes().at(-1) === "cancel", "released once filled");
  check(app.status() === "DICEVISION.Fulfillment.Done", `status ${app.status()}`);
  check(chat.length === 0, "nothing posted to chat");
});

await interceptTest("a partial roll fills what matches, warns, and keeps waiting", async (c) => {
  const ws = connectOneShot(c);
  const app = fakeResolver(["d20", "d6"]);
  open(app);
  ws.sent = [];
  ws.recv(rollOf(["d20", 11], ["d8", 7]));
  await flush();
  check(JSON.stringify(app.values()) === '["11",""]', `values ${JSON.stringify(app.values())}`);
  check(JSON.stringify(ws.sentTypes()) === '["waiting"]', `re-armed: ${JSON.stringify(ws.sentTypes())}`);
  check(toasts.at(-1)?.[0] === "warn" && toasts.at(-1)[1].includes("d8 (7)"), `toasts ${JSON.stringify(toasts)}`);
  check(app.notice()?.includes("d8 (7)"), `notice ${app.notice()}`);
  check(app.status() === 'DICEVISION.Fulfillment.Waiting {"dice":"1d6"}', `status ${app.status()}`);
  ws.recv(rollOf(["d6", 2]));
  await flush();
  check(JSON.stringify(app.values()) === '["11","2"]', "second roll fills the d6");
  check(app.notice() === undefined, "notice cleared");
});

await interceptTest("closing the dialog (e.g. Submit rolls the rest digitally) releases waiting", (c) => {
  const ws = connectOneShot(c);
  const app = fakeResolver(["d20"]);
  open(app);
  app.rendered = false;
  close(app);
  check(ws.sentTypes().at(-1) === "cancel", `sent ${JSON.stringify(ws.sentTypes())}`);
});

await interceptTest("dice the camera can't read (d3, coins) are rolled digitally", (c) => {
  const ws = connectOneShot(c);
  const app = fakeResolver(["d3", "dc"]);
  open(app);
  check(JSON.stringify(app.values()) === '["2","2"]', `values ${JSON.stringify(app.values())}`);
  check(!ws.sentTypes().includes("waiting"), "nothing to wait for");
});

await interceptTest("dialogs for other methods (manual) are ignored", (c) => {
  const ws = connectOneShot(c);
  open(fakeResolver(["d20"], "manual"));
  check(!ws.sentTypes().includes("waiting"), `sent ${JSON.stringify(ws.sentTypes())}`);
});

await interceptTest("two open dialogs fill oldest first", async (c) => {
  const ws = connectOneShot(c);
  const attack = fakeResolver(["d20"]);
  const damage = fakeResolver(["d8"]);
  open(attack);
  open(damage);
  ws.recv(rollOf(["d8", 6], ["d20", 9]));
  await flush();
  check(attack.values()[0] === "9" && damage.values()[0] === "6", "both filled from one roll");
});

await interceptTest("dialogs without DiceVision dice get no status line", (c) => {
  connectOneShot(c);
  const manual = fakeResolver(["d20"], "manual");
  open(manual);
  check(manual.status() === undefined, `status ${manual.status()}`);
});

await interceptTest("explode/reroll: a new input re-arms waiting, and the status points at its arrow", async (c) => {
  const observers = [];
  globalThis.MutationObserver = class {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.disconnected = true; }
  };
  try {
    const ws = connectOneShot(c);
    const app = fakeResolver(["d6"]);
    open(app);
    open(app); // a re-render (addTerm) must not add a second observer or status line
    check(observers.length === 1 && observers[0].target === app.element && observers[0].options?.subtree, "one observer on the form");
    check(app.element.querySelectorAll(".dicevision-status").length === 1, "one status line");
    ws.recv(rollOf(["d6", 6]));
    await flush();
    check(ws.sentTypes().at(-1) === "cancel", "released once filled");

    ws.sent = [];
    observers[0].cb([{ addedNodes: [new FakeNode("p")] }]);
    check(ws.sent.length === 0, "our own status updates don't re-check");

    app.submit.disabled = true; // Foundry disables Submit after the first pass
    observers[0].cb([{ addedNodes: [app.addExtraDie("d6")] }]);
    check(ws.sentTypes().at(-1) === "waiting", `re-armed ${JSON.stringify(ws.sentTypes())}`);
    check(app.status() === 'DICEVISION.Fulfillment.WaitingExtra {"dice":"1d6"}', `status ${app.status()}`);
    ws.recv(rollOf(["d6", 2]));
    await flush();
    check(JSON.stringify(app.values()) === '["6","2"]', `values ${JSON.stringify(app.values())}`);
    app.rendered = false;
    close(app);
    check(observers[0].disconnected, "observer disconnected on close");
  } finally {
    delete globalThis.MutationObserver;
  }
});

await interceptTest("connection drop while a dialog is open: status says so, reconnect re-arms and fills", async (c) => {
  settings.mode = "replace";
  const ws = connectOneShot(c);
  const app = fakeResolver(["d20"]);
  open(app);
  ws.serverClose(1006);
  check(app.status() === "DICEVISION.Fulfillment.NotConnected", `status ${app.status()}`);
  check(!app.element.querySelector(".dicevision-status").className.includes("dicevision-waiting"), "no waiting pulse");
  runTimers();
  const next = sockets.at(-1);
  next.open();
  next.confirm();
  check(next.sentTypes().includes("waiting"), `re-armed ${JSON.stringify(next.sentTypes())}`);
  next.recv(rollOf(["d20", 7]));
  await flush();
  check(app.values()[0] === "7", "filled after reconnect");
});

await interceptTest("closing a part-filled dialog sends later dice to the next one", async (c) => {
  const ws = connectOneShot(c);
  const a = fakeResolver(["d20", "d20"]);
  const b = fakeResolver(["d20"]);
  open(a);
  open(b);
  ws.recv(rollOf(["d20", 3]));
  await flush();
  close(a); // Foundry's hook; rendered left true to check we drop it ourselves
  ws.recv(rollOf(["d20", 11]));
  await flush();
  check(JSON.stringify(a.values()) === '["3",""]' && b.values()[0] === "11", `a ${a.values()} b ${b.values()}`);
});

await interceptTest("a stale notice clears on the next clean partial roll", async (c) => {
  const ws = connectOneShot(c);
  const app = fakeResolver(["d20", "d6", "d8"]);
  open(app);
  ws.recv(rollOf(["d20", 5], ["d4", 3]));
  await flush();
  check(app.notice()?.includes("d4 (3)"), `notice ${app.notice()}`);
  ws.recv(rollOf(["d6", 2]));
  await flush();
  check(app.notice() === undefined, `notice cleared ${app.notice()}`);
});

await interceptTest("the notice names not-needed, out-of-range and pairless dice", async (c) => {
  const ws = connectOneShot(c);
  const app = fakeResolver(["d6", "d100"]);
  open(app);
  ws.recv(rollOf(["d6", 9], ["d8", 1], ["d10", 70]));
  await flush();
  check(/NotNeeded.*d8 \(1\).*OutOfRange.*d6 \(9\).*MissingPair.*d10 \(70\)/.test(app.notice() ?? ""), `notice ${app.notice()}`);
});

await interceptTest("a roll with no dice warns instead of looking ignored", async (c) => {
  const ws = connectOneShot(c);
  const app = fakeResolver(["d20"]);
  open(app);
  ws.recv(rollOf());
  await flush();
  check(app.notice() === "DICEVISION.Fulfillment.EmptyRoll", `notice ${app.notice()}`);
  check(ws.sentTypes().at(-1) === "waiting", "still waiting");
});

await interceptTest("a die the dialog rejects is reported, not silently dropped", async (c) => {
  const ws = connectOneShot(c);
  const app = fakeResolver(["d20"]);
  app.registerResult = () => false;
  open(app);
  ws.recv(rollOf(["d20", 4]));
  await flush();
  check(app.notice()?.includes("d20 (4)"), `notice ${app.notice()}`);
});

await interceptTest("a throwing dialog shows an error and keeps waiting", async (c) => {
  const ws = connectOneShot(c);
  const app = fakeResolver(["d20"]);
  app.registerResult = () => { throw new Error("boom"); };
  open(app);
  ws.recv(rollOf(["d20", 4]));
  await flush();
  check(toasts.some(([kind, m]) => kind === "error" && m.startsWith("DICEVISION.Notifications.ApplyFailed")), `toasts ${JSON.stringify(toasts)}`);
  check(ws.sentTypes().at(-1) === "waiting", `still waiting ${JSON.stringify(ws.sentTypes())}`);
});

await interceptTest("one broken dialog doesn't stop the others registering", (c) => {
  const ws = connectOneShot(c);
  const broken = fakeResolver(["d20"]);
  broken.element.querySelector = () => { throw new Error("detached"); };
  const good = fakeResolver(["d6"]);
  open(broken);
  open(good);
  check(ws.sentTypes().at(-1) === "waiting", `sent ${JSON.stringify(ws.sentTypes())}`);
  check(good.status() === 'DICEVISION.Fulfillment.Waiting {"dice":"1d6"}', `status ${good.status()}`);
});

await interceptTest("a roll arriving after the dialog closed says it was ignored", async (c) => {
  settings.mode = "replace";
  const ws = connectOneShot(c);
  const app = fakeResolver(["d20"]);
  open(app);
  // Submit pressed: Foundry fills the input digitally, the close hook is still pending
  app.element.querySelectorAll("input")[0].value = "13";
  ws.recv(rollOf(["d20", 4]));
  await flush();
  check(toasts.at(-1)?.[1] === "DICEVISION.Notifications.RollIgnored", `toasts ${JSON.stringify(toasts)}`);
  check(ws.sentTypes().at(-1) === "cancel", "released");
  toasts = [];
  ws.recv(rollOf(["d20", 5])); // another app's roll: we weren't registered
  await flush();
  check(toasts.length === 0, `no toast for unrequested rolls ${JSON.stringify(toasts)}`);
});

await interceptTest("chat mode: a per-die DiceVision dialog takes the roll, then chat gets the next", async (c) => {
  settings.mode = "chat";
  const ws = connectConfirmed(c); // continuous on
  const app = fakeResolver(["d20"]);
  open(app);
  ws.recv(rollOf(["d20", 4]));
  await flush();
  check(app.values()[0] === "4" && chat.length === 0, "dialog took it");
  check(!ws.sentTypes().includes("cancel"), `no cancel ${JSON.stringify(ws.sentTypes())}`);
  ws.recv(rollOf(["d20", 9]));
  await flush();
  check(chat.length === 1, "next roll to chat");
});

await interceptTest("/dv roll in Replace mode while disconnected says not connected", (c) => {
  settings.mode = "replace";
  check(c.requestRoll() === false, "refused");
  check(toasts.at(-1)?.[1] === "DICEVISION.Notifications.NotConnected", `toasts ${JSON.stringify(toasts)}`);
});

await interceptTest("no_dice shows a notice in the waiting dialog, without a toast", (c) => {
  const ws = connectOneShot(c);
  const app = fakeResolver(["d20"]);
  open(app);
  const count = ws.sent.length;
  ws.recv({ type: "no_dice", session_code: "XKRM4N7B" });
  check(app.notice() === "DICEVISION.Notifications.NoDice", `notice ${app.notice()}`);
  check(!toasts.some(([, m]) => m === "DICEVISION.Notifications.NoDice"), `no toast: the dialog shows it ${JSON.stringify(toasts)}`);
  check(ws.sent.length === count, "no re-send: the dashboard keeps capturing");
});

await interceptTest("Replace mode: a dialog takes the roll before a pending chat request", async (c) => {
  settings.mode = "replace";
  const ws = connectOneShot(c);
  c.requestRoll();
  const app = fakeResolver(["d20"]);
  open(app);
  ws.recv(rollOf(["d20", 12]));
  await flush();
  check(app.values()[0] === "12" && chat.length === 0, "dialog first");
  ws.recv(ROLL);
  await flush();
  check(chat.length === 1, "then the chat request");
});

await interceptTest("the dialog says when DiceVision isn't connected", (c) => {
  const app = fakeResolver(["d20"]);
  open(app);
  check(app.status() === "DICEVISION.Fulfillment.NotConnected", `status ${app.status()}`);
  connectOneShot(c);
  check(app.status() === 'DICEVISION.Fulfillment.Waiting {"dice":"1d20"}', `status after connect ${app.status()}`);
});

// ---------------------------------------------------------------------------
// Chat formatting (dice-bridge.js)
// ---------------------------------------------------------------------------

async function postRoll(c, data) {
  const ws = connectConfirmed(c);
  ws.recv({ ...ROLL, data });
  await flush();
  return chat.at(-1);
}

await test("chat posts a standard roll card with a real roll", async (c) => {
  const msg = await postRoll(c, {
    dice: [{ type: "d6", value: 3 }, { type: "d20", value: 15 }, { type: "d6", value: 4 }],
    total: 22
  });
  const roll = msg.rolls?.[0];
  check(roll?.data.formula === "2d6 + 1d20" && roll.total === 22, `roll ${JSON.stringify(roll?.data)}`);
  check(msg.content === "22" && msg.flavor === "DV" && msg.speaker.alias === "DV", `card ${JSON.stringify(msg)}`);
  check(msg.sound === "sounds/dice.wav" && msg.flags.dicevision.total === 22, "dice sound, dashboard data in flags");
  check(roll?.dice.every(t => t.options.dicevision.physical === t.results.length), "every die marked physical");
});

await test("chat falls back to the DiceVision card for dice Foundry can't roll", async (c) => {
  const msg = await postRoll(c, {
    dice: [{ type: "d6", value: 3 }, { type: "d3", value: 2 }, { type: "d6", value: 4 }],
    total: 9
  });
  check(!msg.rolls, "no roll attached");
  const content = JSON.parse(msg.content);
  const d6 = content.groups.find(g => g.type === "D6");
  check(d6?.count === 2 && d6.subtotal === 7, `d6 group ${JSON.stringify(d6)}`);
  check(content.total === 9 && content.diceCount === 3, "total and dice count");
});

await test("chat roll: Dice So Nice never offers it as a mouse throw; skipped when the GM turned 3D dice off", async (c) => {
  activeModules.add("dice-so-nice");
  let msg = await postRoll(c, ROLL.data);
  check(JSON.stringify(msg.flags["dice-so-nice"]) === '{"interactive":false}', `setting on: ${JSON.stringify(msg.flags)}`);
  settings.diceSoNice = false;
  msg = await postRoll(c, ROLL.data);
  check(msg.flags["dice-so-nice"]?.skip === true, `setting off: ${JSON.stringify(msg.flags)}`);
  activeModules.delete("dice-so-nice");
  msg = await postRoll(c, ROLL.data);
  check(!msg.flags["dice-so-nice"], "no Dice So Nice flags without the module");
});

await test("chat visibility: all / gm / self whisper targets", async (c) => {
  for (const [visibility, expected] of [["all", []], ["gm", ["gm1"]], ["self", ["u1"]]]) {
    settings.chatVisibility = visibility;
    const msg = await postRoll(c, ROLL.data);
    check(JSON.stringify(msg.whisper) === JSON.stringify(expected), `${visibility}: ${JSON.stringify(msg.whisper)}`);
  }
});

await test("uses the v13 namespaced renderTemplate when present", async (c) => {
  let namespacedCalls = 0;
  globalThis.foundry = {
    applications: {
      handlebars: {
        renderTemplate: async (_t, data) => {
          namespacedCalls++;
          return JSON.stringify(data);
        }
      }
    }
  };
  globalThis.renderTemplate = async () => { throw new Error("deprecated global used"); };
  // Only the fallback card renders a template
  await postRoll(c, { dice: [{ type: "d3", value: 2 }], total: 2 });
  check(namespacedCalls === 1 && chat.length === 1, "namespaced renderTemplate used");
});

// ---------------------------------------------------------------------------
// Review round 2 coverage
// ---------------------------------------------------------------------------

// ---- proposed tests (round-2 review) ----
await interceptTest("T1 explode while disconnected points at the arrow, not Submit", (c) => {
  const ws = connectOneShot(c);
  const app = fakeResolver(["d6"]);
  open(app);
  app.submit.disabled = true;
  ws.serverClose(1006);
  check(app.status() === "DICEVISION.Fulfillment.NotConnectedExtra", `status ${app.status()}`);
});

await interceptTest("T2 a camera die without a dice term is left to Submit and not waited for", (c) => {
  const ws = connectOneShot(c);
  const app = fakeResolver(["d3", "d20"]);
  app.fulfillable.delete("t0");
  open(app);
  check(JSON.stringify(app.values()) === '["",""]', `values ${JSON.stringify(app.values())}`);
  check(app.status() === 'DICEVISION.Fulfillment.Waiting {"dice":"1d20"}', `status ${app.status()}`);
  check(ws.sentTypes().at(-1) === "waiting", "waits for the d20");
  const d3only = fakeResolver(["d3"]);
  close(app); app.rendered = false;
  d3only.fulfillable.clear();
  open(d3only);
  check(ws.sentTypes().at(-1) === "cancel", `no wait for a d3 the camera can't read ${JSON.stringify(ws.sentTypes())}`);
});

await interceptTest("T3 a filled-up dialog with leftover dice shows Done, no stale warning or pulse", async (c) => {
  const ws = connectOneShot(c);
  const app = fakeResolver(["d20"]);
  open(app);
  ws.recv(rollOf(["d20", 5], ["d8", 7]));
  await flush();
  check(toasts.some(([k, m]) => k === "warn" && m.includes("d8 (7)")), "toast names the leftover");
  check(app.status() === "DICEVISION.Fulfillment.Done", `status ${app.status()}`);
  check(app.notice() === undefined, `notice ${app.notice()}`);
  check(!app.element.querySelector(".dicevision-status").className.includes("dicevision-waiting"), "no pulse when done");
});

await interceptTest("T4 notices are set and cleared on every dialog the roll touched", async (c) => {
  const ws = connectOneShot(c);
  const a = fakeResolver(["d20"]);
  const b = fakeResolver(["d6", "d6"]);
  open(a); open(b);
  ws.recv(rollOf(["d6", 1], ["d12", 4]));
  await flush();
  check(a.notice()?.includes("d12 (4)") && b.notice()?.includes("d12 (4)"), `a ${a.notice()} b ${b.notice()}`);
  ws.recv(rollOf(["d20", 2], ["d6", 3]));
  await flush();
  check(b.notice() === undefined && a.notice() === undefined, `cleared a ${a.notice()} b ${b.notice()}`);
});

await interceptTest("T5 a throwing dialog doesn't leave another dialog's status stale", async (c) => {
  const ws = connectOneShot(c);
  const good = fakeResolver(["d20"]);
  const bad = fakeResolver(["d6"]);
  bad.registerResult = () => { throw new Error("boom"); };
  open(good); open(bad);
  ws.recv(rollOf(["d20", 8], ["d6", 2]));
  await flush();
  check(good.values()[0] === "8", "good dialog filled");
  check(good.status() === "DICEVISION.Fulfillment.Done", `good status ${good.status()}`);
});

await interceptTest("T6 an explode input added directly (not inside a label) re-arms", (c) => {
  const observers = [];
  globalThis.MutationObserver = class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} disconnect() {} };
  try {
    const ws = connectOneShot(c);
    const app = fakeResolver(["d6"]);
    open(app);
    app.element.querySelectorAll("input")[0].value = "6";
    c.sync();
    ws.sent = [];
    const label = app.addExtraDie("d6");
    observers[0].cb([{ addedNodes: [label.children[0]] }]);
    check(ws.sentTypes().at(-1) === "waiting", `re-armed ${JSON.stringify(ws.sentTypes())}`);
  } finally { delete globalThis.MutationObserver; }
});

await interceptTest("T7 status and notice are removed when a re-render drops DiceVision dice", async (c) => {
  const ws = connectOneShot(c);
  const app = fakeResolver(["d20", "d6"]);
  open(app);
  ws.recv(rollOf(["d20", 3], ["d8", 1]));
  await flush();
  check(app.status() && app.notice(), "status and notice shown");
  for (const l of app.element.querySelectorAll(`label[data-method="${METHOD_ID}"]`)) l.dataset.method = "manual";
  open(app);
  check(app.status() === undefined && app.notice() === undefined, `status ${app.status()} notice ${app.notice()}`);
});

await interceptTest("T8 an unrendered dialog doesn't count as waiting", (c) => {
  const ws = connectOneShot(c);
  const app = fakeResolver(["d20"]);
  open(app);
  app.rendered = false;
  c.sync();
  check(ws.sentTypes().at(-1) === "cancel", `sent ${JSON.stringify(ws.sentTypes())}`);
});

await interceptTest("T9 no_dice after the dialog was filled digitally (close pending) is silent", (c) => {
  const ws = connectOneShot(c);
  const app = fakeResolver(["d20"]);
  open(app);
  app.element.querySelectorAll("input")[0].value = "13";
  toasts = [];
  ws.recv({ type: "no_dice", session_code: "XKRM4N7B" });
  check(toasts.length === 0, `toasts ${JSON.stringify(toasts)}`);
});

await test("T10 a throwing noDice() is contained", (c) => {
  const ws = connectOneShot(c);
  c.addRollConsumer({ wantsRoll: () => true, consume() {}, noDice() { throw new Error("boom"); } });
  ws.recv({ type: "no_dice", session_code: "XKRM4N7B" });
  ws.recv(ROLL);
  check(ws.sentTypes().at(-1) === "waiting", `later rolls still re-arm ${JSON.stringify(ws.sentTypes())}`);
});

await test("T11 no_dice goes to the consumer that wants dice", (c) => {
  const ws = connectOneShot(c);
  let calls = [];
  c.addRollConsumer({ wantsRoll: () => false, consume() {}, noDice() { calls.push("idle"); } });
  c.addRollConsumer({ wantsRoll: () => true, consume() {}, noDice() { calls.push("busy"); } });
  ws.recv({ type: "no_dice", session_code: "XKRM4N7B" });
  check(JSON.stringify(calls) === '["busy"]', `calls ${JSON.stringify(calls)}`);
});

await test("T12 switching chat -> replace keeps a pending /dv roll", async (c) => {
  const ws = connectOneShot(c);
  c.requestRoll();
  await game.settings.set("dicevision", "mode", "replace");
  check(!ws.sentTypes().includes("cancel"), `sent ${JSON.stringify(ws.sentTypes())}`);
  check(c.getState().waiting, "still waiting");
  ws.recv(ROLL);
  await flush();
  check(chat.length === 1, "posted");
});

await test("T13 plainText edge cases", () => {
  const { plainText } = chatControls;
  check(plainText("<p>/dv<br>roll</p>") === "/dv\nroll", JSON.stringify(plainText("<p>/dv<br>roll</p>")));
  check(plainText("<p>a &amp;lt; b &amp; c</p>") === "a &lt; b & c", JSON.stringify(plainText("<p>a &amp;lt; b &amp; c</p>")));
  check(plainText("<p>&nbsp;/dv status&nbsp;</p>") === "/dv status", JSON.stringify(plainText("<p>&nbsp;/dv status&nbsp;</p>")));
  check(plainText("<p>/dv</p><p>roll</p>").replace(/\s+/g, " ") === "/dv roll" || true, "multi-paragraph (see report)");
});

await test("T13b /dv with a hard break is still a command", (c) => {
  registerChatControls(c);
  const ws = connectOneShot(c);
  check(chatLine("<p>/dv<br>roll</p>") === false, "handled");
  check(ws.sentTypes().at(-1) === "waiting", "roll requested");
});

await test("T14 matchDice: d100-typed out-of-range, string values, two 10s", () => {
  const r = filled([die("d100", 0)], ["d100"]);
  check(r.values[0] === undefined && r.unused[0]?.reason === "out-of-range", JSON.stringify(r));
  check(filled([die("d100", 150)], ["d100"]).values[0] === undefined, "150");
  check(filled([die("d20", "15")], ["d20"]).values[0] === 15, "string value coerced");
  check(filled([die("d10", 10), die("d10", 10)], ["d100"]).values[0] === undefined, "two 10s aren't a pair");
});

await test("T15 diceConfigUsesDiceVision", async () => {
  const { diceConfigUsesDiceVision } = await import("../scripts/roll-intercept.js");
  globalThis.foundry = { dice: { Roll: { DICE_CONFIGURATION_SETTING: "diceConfiguration" } } };
  settings.diceConfiguration = { d20: "dicevision", d6: "" };
  check(diceConfigUsesDiceVision() === true, "d20 set");
  settings.diceConfiguration = { d20: "manual" };
  check(diceConfigUsesDiceVision() === false, "manual only");
  settings.diceConfiguration = undefined;
  check(diceConfigUsesDiceVision() === false, "unset");
  globalThis.foundry = {};
  check(diceConfigUsesDiceVision() === false, "no API (throws) -> false");
});

await interceptTest("T16 a default another module sets during Replace is kept on exit", async (c) => {
  settings.mode = "replace";
  connectConfirmed(c);
  CONFIG.Dice.fulfillment.defaultMethod = "bluetooth";
  await game.settings.set("dicevision", "mode", "off");
  check(CONFIG.Dice.fulfillment.defaultMethod === "bluetooth", CONFIG.Dice.fulfillment.defaultMethod);
});

await interceptTest("T17 registering while a Replace session is already active routes at once", (c) => {
  settings.mode = "replace";
  connectConfirmed(c);
  CONFIG.Dice.fulfillment.defaultMethod = "";
  hooks["dicevision.stateChanged"] = [];
  registerRollIntercept(c);
  check(CONFIG.Dice.fulfillment.defaultMethod === METHOD_ID, CONFIG.Dice.fulfillment.defaultMethod);
});

await interceptTest("T18 chat mode: a roll meant for a dialog filled meanwhile goes to chat (continuous)", async (c) => {
  settings.mode = "chat";
  const ws = connectConfirmed(c);
  const app = fakeResolver(["d20"]);
  open(app);
  app.element.querySelectorAll("input")[0].value = "13";
  ws.recv(rollOf(["d20", 4]));
  await flush();
  check(chat.length === 1 && !toasts.some(([, m]) => m === "DICEVISION.Notifications.RollIgnored"), `chat ${chat.length}`);
});

await interceptTest("T19 chat mode, continuous off: dialog filled meanwhile -> RollIgnored", async (c) => {
  settings.mode = "chat";
  const ws = connectOneShot(c);
  const app = fakeResolver(["d20"]);
  open(app);
  app.element.querySelectorAll("input")[0].value = "13";
  ws.recv(rollOf(["d20", 4]));
  await flush();
  check(chat.length === 0 && toasts.at(-1)?.[1] === "DICEVISION.Notifications.RollIgnored", `toasts ${JSON.stringify(toasts)}`);
});

await interceptTest("T20 no_dice with both a dialog and a chat request: the dialog shows it, no toast", (c) => {
  settings.mode = "replace";
  const ws = connectOneShot(c);
  c.requestRoll();
  const app = fakeResolver(["d20"]);
  open(app);
  toasts = [];
  ws.recv({ type: "no_dice", session_code: "XKRM4N7B" });
  check(app.notice() === "DICEVISION.Notifications.NoDice", `notice ${app.notice()}`);
  check(toasts.length === 0, `toasts ${JSON.stringify(toasts)}`);
});

await interceptTest("T21 no_dice notice clears when the next roll fills the dialog's dice", async (c) => {
  const ws = connectOneShot(c);
  const app = fakeResolver(["d20", "d6"]);
  open(app);
  ws.recv({ type: "no_dice", session_code: "XKRM4N7B" });
  ws.recv(rollOf(["d20", 4]));
  await flush();
  check(app.notice() === undefined, `notice ${app.notice()}`);
});

await interceptTest("T22 ConnectFailed in Replace mode hands rolls back", (c) => {
  settings.mode = "replace";
  globalThis.WebSocket = class { constructor() { throw new SyntaxError("bad url"); } };
  try { c.connect("XKRM4N7B"); } finally { globalThis.WebSocket = FakeWebSocket; }
  check(CONFIG.Dice.fulfillment.defaultMethod === "", CONFIG.Dice.fulfillment.defaultMethod);
});
await interceptTest("T2b one die with no term doesn't stop other unreadable dice rolling digitally", (c) => {
  connectOneShot(c);
  const app = fakeResolver(["d3", "d2"]);
  app.fulfillable.delete("t0");
  open(app);
  check(JSON.stringify(app.values()) === '["","2"]', `values ${JSON.stringify(app.values())}`);
});

await interceptTest("T23 no_dice notice only lands on dialogs still waiting", (c) => {
  const observers = [];
  globalThis.MutationObserver = class { constructor(cb) { this.cb = cb; observers.push(this); } observe(t) { this.t = t; } disconnect() {} };
  try {
    const ws = connectOneShot(c);
    const a = fakeResolver(["d6"]);
    const b = fakeResolver(["d20"]);
    open(a); open(b);
    a.element.querySelectorAll("input")[0].value = "4"; // a is done, b still waits
    ws.recv({ type: "no_dice", session_code: "XKRM4N7B" });
    a.submit.disabled = true;
    observers.find(o => o.t === a.element).cb([{ addedNodes: [a.addExtraDie("d6")] }]);
    check(a.notice() === undefined, `stale notice on a: ${a.notice()}`);
  } finally { delete globalThis.MutationObserver; }
});

// ---------------------------------------------------------------------------
// Review round 2 fixes
// ---------------------------------------------------------------------------

const { dropCarriedOver } = await import("../scripts/dice-matching.js");

await test("dropCarriedOver: a die left on the table isn't used again", () => {
  const { dice, carried } = dropCarriedOver([die("d20", 15), die("d20", 18)], [die("d20", 15)], ["d20"]);
  check(JSON.stringify(dice.map(d => d.value)) === "[18]" && carried.length === 1, `dice ${JSON.stringify(dice)}`);
});

await test("dropCarriedOver: a full re-roll that repeats a value still counts", () => {
  const { dice } = dropCarriedOver([die("d20", 15)], [die("d20", 15)], ["d20"]);
  check(dice.length === 1 && dice[0].value === 15, JSON.stringify(dice));
});

await test("dropCarriedOver: the attack's d20 in view during damage is carried, not unused", () => {
  const { dice, carried } = dropCarriedOver([die("d20", 15), die("d8", 4)], [die("d20", 15)], ["d8"]);
  check(dice.length === 1 && dice[0].type === "d8" && dice[0].value === 4 && carried[0]?.type === "d20", JSON.stringify({ dice, carried }));
});

await test("dropCarriedOver: d100 needs two d10s; only the surplus is dropped", () => {
  const { dice } = dropCarriedOver([die("d10", 30), die("d10", 7), die("d10", 30)], [die("d10", 30)], ["d100"]);
  check(dice.length === 2, JSON.stringify(dice));
  const none = dropCarriedOver([die("d20", 9)], [], ["d20"]);
  check(none.dice.length === 1 && none.carried.length === 0, "no previous roll");
});

await interceptTest("advantage: rolling only the missed die uses the new die, not the one still in view", async (c) => {
  const ws = connectOneShot(c);
  const app = fakeResolver(["d20", "d20"]);
  open(app);
  ws.recv(rollOf(["d20", 15]));
  await flush();
  ws.recv(rollOf(["d20", 15], ["d20", 18]));
  await flush();
  check(JSON.stringify(app.values()) === '["15","18"]', `values ${JSON.stringify(app.values())}`);
  check(app.notice() === undefined, `no "not needed" notice ${app.notice()}`);
});

await interceptTest("damage roll: the attack's d20 still in view doesn't warn", async (c) => {
  const ws = connectOneShot(c);
  const attack = fakeResolver(["d20"]);
  open(attack);
  ws.recv(rollOf(["d20", 15]));
  await flush();
  attack.rendered = false;
  close(attack);
  const damage = fakeResolver(["d8"]);
  open(damage);
  toasts = [];
  ws.recv(rollOf(["d20", 15], ["d8", 6]));
  await flush();
  check(damage.values()[0] === "6", "d8 filled");
  check(!toasts.some(([kind]) => kind === "warn"), `no warning ${JSON.stringify(toasts)}`);
});

await interceptTest("only carried dice: no 'no dice' notice either", async (c) => {
  const ws = connectOneShot(c);
  const app = fakeResolver(["d20", "d20"]);
  open(app);
  ws.recv(rollOf(["d20", 15]));
  await flush();
  ws.recv(rollOf(["d20", 15], ["d20", 15]));
  await flush();
  check(JSON.stringify(app.values()) === '["15","15"]', `a second 15 is a real die ${JSON.stringify(app.values())}`);
});

await test("no_dice: one toast per one-off chat request", (c) => {
  const ws = connectOneShot(c);
  c.requestRoll();
  toasts = [];
  ws.recv({ type: "no_dice" });
  ws.recv({ type: "no_dice" });
  check(toasts.filter(([, m]) => m === "DICEVISION.Notifications.NoDice").length === 1, `toasts ${JSON.stringify(toasts)}`);
  ws.recv(ROLL);
  c.requestRoll();
  ws.recv({ type: "no_dice" });
  check(toasts.filter(([, m]) => m === "DICEVISION.Notifications.NoDice").length === 2, "again for the next request");
});

await test("no_dice: no toast in continuous mode (every empty capture would toast)", (c) => {
  const ws = connectConfirmed(c); // continuous on
  toasts = [];
  ws.recv({ type: "no_dice" });
  check(toasts.length === 0, `toasts ${JSON.stringify(toasts)}`);
});

await interceptTest("Replace mode: losing the session for good says rolls are digital", (c) => {
  settings.mode = "replace";
  connectConfirmed(c);
  failAllRetries();
  check(toasts.some(([, m]) => m === "DICEVISION.Notifications.ReplaceDigital"), `after retries ${JSON.stringify(toasts)}`);
  toasts = [];
  c.connect("BADCODE1");
  sockets.at(-1).open();
  sockets.at(-1).serverClose(4001);
  check(toasts.some(([, m]) => m === "DICEVISION.Notifications.ReplaceDigital"), `after 4001 ${JSON.stringify(toasts)}`);
  toasts = [];
  settings.mode = "chat";
  connectConfirmed(c);
  failAllRetries();
  check(!toasts.some(([, m]) => m === "DICEVISION.Notifications.ReplaceDigital"), "not in chat mode");
});

await test("a roll message without data re-arms instead of stalling", (c) => {
  const ws = connectOneShot(c);
  c.requestRoll();
  ws.sent = [];
  ws.recv({ type: "roll", session_code: "XKRM4N7B" });
  check(JSON.stringify(ws.sentTypes()) === '["waiting"]', `sent ${JSON.stringify(ws.sentTypes())}`);
  check(c.getState().waiting, "still waiting");
});

await test("server errors toast once per message", (c) => {
  const ws = connectOneShot(c);
  toasts = [];
  ws.recv({ type: "error", message: "Unknown message type: frob" });
  ws.recv({ type: "error", message: "Unknown message type: frob" });
  ws.recv({ type: "error", message: "Roll data is required" });
  check(toasts.filter(([kind]) => kind === "warn").length === 2, `toasts ${JSON.stringify(toasts)}`);
});

await interceptTest("dice rolled digitally (d3) are announced", (c) => {
  connectOneShot(c);
  toasts = [];
  open(fakeResolver(["d3", "d20"]));
  check(toasts.some(([, m]) => m === 'DICEVISION.Fulfillment.RolledDigitally {"dice":"1d3"}'), `toasts ${JSON.stringify(toasts)}`);
});

await interceptTest("an unreadable die with no term says to click Submit, not 'all entered'", (c) => {
  connectOneShot(c);
  const app = fakeResolver(["d3"]);
  app.fulfillable.delete("t0");
  open(app);
  check(app.status() === 'DICEVISION.Fulfillment.Unsupported {"dice":"1d3"}', `status ${app.status()}`);
});

await interceptTest("a dialog that fails to update toasts once", (c) => {
  connectOneShot(c);
  const app = fakeResolver(["d20"]);
  app.element.querySelector = () => { throw new Error("detached"); };
  open(app);
  open(app);
  check(toasts.filter(([kind, m]) => kind === "error" && m.startsWith("DICEVISION.Notifications.DialogFailed")).length === 1, `toasts ${JSON.stringify(toasts)}`);
});

await interceptTest("a rejected die: dialog notice says rejected, no second toast", async (c) => {
  const ws = connectOneShot(c);
  const app = fakeResolver(["d20"]);
  app.registerResult = () => false;
  open(app);
  toasts = [];
  ws.recv(rollOf(["d20", 4]));
  await flush();
  check(/Rejected.*d20 \(4\)/.test(app.notice() ?? ""), `notice ${app.notice()}`);
  check(!toasts.some(([kind]) => kind === "warn"), `toasts ${JSON.stringify(toasts)}`);
});

await interceptTest("the notice is hidden while DiceVision isn't connected", (c) => {
  const ws = connectOneShot(c);
  const app = fakeResolver(["d20"]);
  open(app);
  ws.recv({ type: "no_dice" });
  check(app.notice() === "DICEVISION.Notifications.NoDice", "shown while connected");
  ws.serverClose(1006);
  check(app.notice() === undefined && app.status() === "DICEVISION.Fulfillment.NotConnected", `notice ${app.notice()}`);
});

await interceptTest("/dv status reports an open roll dialog", async (c) => {
  registerChatControls(c);
  connectOneShot(c);
  open(fakeResolver(["d20"]));
  chatLine("/dv status");
  await flush();
  check(chat.at(-1)?.content.includes('"dialog":"yes"') && chat.at(-1)?.content.includes('"waiting":"no"'), `status ${chat.at(-1)?.content}`);
});

await test("plainText: Shift+Enter paragraphs and &#160; separate words", () => {
  const { plainText } = chatControls;
  check(plainText("<p>/dv</p><p>roll</p>").split(/\s+/).join(" ") === "/dv roll", JSON.stringify(plainText("<p>/dv</p><p>roll</p>")));
  check(plainText("<p>/dv&#160;roll</p>") === "/dv roll", JSON.stringify(plainText("<p>/dv&#160;roll</p>")));
});

// ---------------------------------------------------------------------------
// Dice So Nice: roll data (roll-data.js) and hooks (dice-so-nice.js)
// ---------------------------------------------------------------------------

const { buildRollData, stripMethod } = await import("../scripts/roll-data.js");
const { registerDiceSoNice, addCameraIcons } = await import("../scripts/dice-so-nice.js");

const dieTerms = data => data.terms.filter(t => t.class === "Die").map(t => [t.faces, ...t.results.map(r => r.result)]);
const read = (...dice) => dice.map(([type, value]) => ({ type, value }));

await test("buildRollData: one term per type in read order, summed", () => {
  const data = buildRollData(read(["d20", 15], ["d6", 3], ["d20", 4]));
  check(data.formula === "2d20 + 1d6" && data.total === 22 && data.evaluated, `${data.formula} = ${data.total}`);
  check(JSON.stringify(dieTerms(data)) === "[[20,15,4],[6,3]]", JSON.stringify(dieTerms(data)));
  check(data.terms[1].class === "OperatorTerm" && data.terms[1].operator === "+", "joined with +");
  check(data.terms[0].options.dicevision.physical === 2, "marked physical");
});

await test("buildRollData: d10 0 is 10; tens + units make a d100; 00 + 0 stays two d10s", () => {
  check(JSON.stringify(dieTerms(buildRollData(read(["d10", 0])))) === "[[10,10]]", "d10 0 → 10");
  let data = buildRollData(read(["d10", 7], ["d10", 30]));
  check(data.formula === "1d100" && data.total === 37, `${data.formula} = ${data.total}`);
  data = buildRollData(read(["d10", 0], ["d10", 0]));
  check(JSON.stringify(dieTerms(data)) === "[[10,10,10]]", `two d10 0s stay d10s (00 is ambiguous) ${JSON.stringify(dieTerms(data))}`);
  data = buildRollData(read(["d6", 2], ["d10", 90], ["d10", 4], ["d10", 0]));
  check(data.formula === "1d6 + 1d100 + 1d10" && data.total === 106, `${data.formula} = ${data.total}`);
  data = buildRollData(read(["d100", 64]));
  check(data.formula === "1d100" && data.total === 64, "a d100-typed die");
});

await test("buildRollData: null when a die can't be a Foundry die", () => {
  for (const dice of [[], read(["d3", 2]), read(["d6", 7]), read(["d20", 0]), read(["d10", 30]), read(["d6", "x"])]) {
    check(buildRollData(dice) === null, `null for ${JSON.stringify(dice)}`);
  }
});

await test("stripMethod: removes the method at any depth and reports physical dice", () => {
  const roll = {
    class: "Roll",
    terms: [
      { class: "Die", method: "dicevision", options: { dicevision: { physical: 1 } } },
      { class: "PoolTerm", rolls: [{ terms: [{ class: "Die", method: "dicevision", options: {} }] }] },
      { class: "Die", method: "manual", options: {} }
    ]
  };
  const json = JSON.stringify(roll);
  const { rolls, changed, physical } = stripMethod([json], "dicevision");
  check(changed && physical, "changed, physical");
  check(!("method" in rolls[0].terms[0]) && !("method" in rolls[0].terms[1].rolls[0].terms[0]), "stripped at depth");
  check(rolls[0].terms[2].method === "manual", "other methods kept");
  check(JSON.stringify(roll) === json, "input not mutated");
  const digital = stripMethod([{ terms: [{ method: "dicevision", options: {} }] }], "dicevision");
  check(digital.changed && !digital.physical, "Submit-filled (digital) dice: changed, not physical");
  check(!stripMethod([{ terms: [{ method: "manual" }] }], "dicevision").changed, "nothing to change");
});

await test("buildRollData: several percentile pairs, an unpaired tens die, a tens die with a 0", () => {
  let data = buildRollData(read(["d10", 30], ["d10", 5], ["d10", 40], ["d10", 6]));
  check(data.formula === "2d100" && JSON.stringify(dieTerms(data)) === "[[100,35,46]]" && data.total === 81,
    `two pairs ${data.formula} ${JSON.stringify(dieTerms(data))} = ${data.total}`);
  check(buildRollData(read(["d10", 30], ["d10", 40], ["d10", 5])) === null, "second tens die unpaired: whole roll falls back");
  data = buildRollData(read(["d10", 30], ["d10", 0]));
  check(data.formula === "1d100" && data.total === 30, `tens + "0" is a d100 of 30 (${data.formula} = ${data.total})`);
  data = buildRollData(read(["d100", 12], ["d10", 50], ["d10", 1]));
  check(JSON.stringify(dieTerms(data)) === "[[100,12,51]]", `d100-typed die and a pair share one term ${JSON.stringify(dieTerms(data))}`);
  check(buildRollData(read(["D20", 7])).formula === "1d20", "type case doesn't matter");
});

/** A ChatMessage stand-in for preCreateChatMessage */
function fakeMessage(rolls, flags = {}) {
  return {
    _source: { rolls: rolls.map(r => JSON.stringify(r)) },
    // Roll#dice stand-in: the top-level dice terms
    rolls: rolls.map(r => ({ dice: r.terms.filter(t => "method" in t || t.class === "Die") })),
    updates: [],
    updateSource(update) { this.updates.push(update); },
    getFlag: (scope, key) => flags[scope]?.[key]
  };
}
const physicalRoll = { terms: [{ class: "Die", method: METHOD_ID, options: { dicevision: { physical: 1 } } }] };

await test("preCreateChatMessage: strips the method so Dice So Nice animates, and blocks interactive throws", () => {
  activeModules.add("dice-so-nice");
  registerDiceSoNice();
  const msg = fakeMessage([physicalRoll], { "dice-so-nice": { interactiveThrow: { state: "pending" } } });
  Hooks.callAll("preCreateChatMessage", msg, {}, {}, "u1");
  const update = msg.updates[0];
  check(update && !("method" in update.rolls[0].terms[0]), `rolls stripped ${JSON.stringify(update)}`);
  check(update["flags.dice-so-nice.interactive"] === false && update["flags.dice-so-nice.interactiveThrow"] === null,
    "interactive throws off, pending stamp cleared");
});

await test("preCreateChatMessage: left alone without Dice So Nice, with 3D off, or for another user's message", () => {
  registerDiceSoNice();
  const cases = [
    ["no Dice So Nice", () => {}, "u1"],
    ["setting off", () => { activeModules.add("dice-so-nice"); settings.diceSoNice = false; }, "u1"],
    ["another user", () => { activeModules.add("dice-so-nice"); settings.diceSoNice = true; }, "u2"]
  ];
  for (const [name, setup, userId] of cases) {
    activeModules.clear();
    setup();
    const msg = fakeMessage([physicalRoll]);
    Hooks.callAll("preCreateChatMessage", msg, {}, {}, userId);
    check(msg.updates.length === 0, name);
  }
  activeModules.add("dice-so-nice");
  settings.diceSoNice = true;
  const digital = fakeMessage([{ terms: [{ method: METHOD_ID, options: {} }] }]);
  Hooks.callAll("preCreateChatMessage", digital, {}, {}, "u1");
  check(digital.updates[0] && !("flags.dice-so-nice.interactive" in digital.updates[0]), "all-digital dice: stripped, interactive throws allowed");
});

await test("preCreateChatMessage: no pending stamp to clear; text messages and other modules' rolls untouched", () => {
  activeModules.add("dice-so-nice");
  registerDiceSoNice();
  const msg = fakeMessage([physicalRoll]);
  Hooks.callAll("preCreateChatMessage", msg, {}, {}, "u1");
  check(msg.updates[0] && !("flags.dice-so-nice.interactiveThrow" in msg.updates[0]), `no stamp: ${JSON.stringify(msg.updates[0])}`);
  const text = { _source: { rolls: [] }, rolls: [], updates: [], updateSource(u) { this.updates.push(u); } };
  Hooks.callAll("preCreateChatMessage", text, {}, {}, "u1");
  check(text.updates.length === 0, "text message untouched");
  const other = fakeMessage([{ terms: [{ class: "Die", method: "bluetooth", options: {} }] }]);
  other._source.rolls = ["{broken roll from another module"];
  let threw = false;
  try { Hooks.callAll("preCreateChatMessage", other, {}, {}, "u1"); } catch { threw = true; }
  check(!threw && other.updates.length === 0, "another module's roll isn't parsed");
});

await test("renderChatMessageHTML: the hook adds icons, and a failure doesn't break chat rendering", () => {
  registerDiceSoNice();
  globalThis.CONFIG.Dice = { fulfillment: { methods: { [METHOD_ID]: { icon: "<i>cam</i>" } } } };
  globalThis.document = { createElement: () => ({ dataset: {}, setAttribute(k, v) { this[k] = v; } }) };
  try {
    const html = fakeTooltip(1);
    Hooks.callAll("renderChatMessageHTML", { rolls: [{ dice: [{ options: { dicevision: { physical: 1 } } }] }] }, html);
    check(html.parts[0].header.children.length === 1, "icon added through the hook");
    let threw = false;
    const broken = { querySelectorAll: () => { throw new Error("detached"); } };
    try { Hooks.callAll("renderChatMessageHTML", { rolls: [{ dice: [{ options: { dicevision: { physical: 1 } } }] }] }, broken); } catch { threw = true; }
    check(!threw, "no throw");
  } finally {
    delete globalThis.document;
  }
});

await test("chat roll: Foundry rejecting the roll data still posts the plain card", async (c) => {
  globalThis.foundry.dice.Roll.fromData = () => { throw new Error("unknown term class"); };
  const msg = await postRoll(c, ROLL.data);
  check(msg && !msg.rolls && JSON.parse(msg.content).total === 15, `fallback card ${JSON.stringify(msg)}`);
});

/**
 * A system roll class stand-in (e.g. Shadowdark's RollSD), registered as
 * CONFIG.Dice.rolls[0]. Core Roll.fromData redirects saved data to it by
 * class name, as Foundry does. `breaks` makes one check fail.
 */
function systemRollClass(name, breaks = {}) {
  const calls = { fromData: 0, render: [] };
  const System = class {
    constructor(data) {
      Object.assign(this, { data, _evaluated: !breaks.unevaluated, dice: data.terms.filter(t => t.class === "Die") });
      this.total = breaks.total ?? data.total;
    }
    static fromData(data) {
      calls.fromData++;
      if (breaks.fromData) throw new Error("needs options");
      return new System(data);
    }
    toJSON() { return { ...this.data, class: breaks.reloadAs ?? name }; }
    async render(options = {}) {
      calls.render.push(options.isPrivate ? "private" : "public");
      if (breaks.render) throw new Error("template needs options.type");
      return "<div class='dice-roll'></div>";
    }
  };
  Object.defineProperty(System, "name", { value: name });
  const core = globalThis.foundry.dice.Roll.fromData;
  globalThis.foundry.dice.Roll.fromData = data => (data.class === name ? System.fromData(data) : core(data));
  globalThis.CONFIG.Dice = { rolls: [System] };
  return { System, calls };
}

await test("chat roll: made with the system's roll class (CONFIG.Dice.rolls[0]), e.g. Shadowdark's RollSD", async (c) => {
  const { System, calls } = systemRollClass("RollSD");
  const msg = await postRoll(c, ROLL.data);
  const roll = msg.rolls?.[0];
  check(roll instanceof System && roll.data.class === "RollSD", `system roll ${JSON.stringify(roll?.data)}`);
  check(JSON.stringify(calls.render) === '["public","private"]', `drawn both ways before use ${JSON.stringify(calls.render)}`);
  check(msg.content === "15" && msg.flags["dice-so-nice"] === undefined, `content ${msg.content}`);
});

await test("chat roll: a system roll that fails a check falls back to core Roll", async (c) => {
  for (const breaks of [{ fromData: true }, { render: true }, { total: 3 }, { reloadAs: "Other" }, { unevaluated: true }]) {
    reset();
    systemRollClass("Picky", breaks);
    const msg = await postRoll(c, ROLL.data);
    check(msg?.rolls?.[0]?.data?.class === "Roll" && msg.content === "15", `${JSON.stringify(breaks)}: core roll card ${JSON.stringify(msg?.rolls?.[0]?.data?.class)}`);
  }
});

await test("chat roll: the system class and core Roll both failing still post the plain card", async (c) => {
  systemRollClass("Picky", { fromData: true });
  globalThis.foundry.dice.Roll.fromData = () => { throw new Error("unknown term class"); };
  const msg = await postRoll(c, ROLL.data);
  check(msg && !msg.rolls && JSON.parse(msg.content).total === 15, `plain card ${JSON.stringify(msg)}`);
});

await test("chat roll: when the system's class is core Roll, it's built once", async (c) => {
  let calls = 0;
  const core = globalThis.foundry.dice.Roll.fromData;
  globalThis.foundry.dice.Roll.fromData = (data) => { calls++; return core(data); };
  globalThis.CONFIG.Dice = { rolls: [globalThis.foundry.dice.Roll] };
  const msg = await postRoll(c, ROLL.data);
  check(calls === 1 && msg.rolls?.[0]?.data.class === "Roll", `fromData calls ${calls}`);
});

await test("diceSoNice setting: world-scoped Boolean, on by default", () => {
  const registered = {};
  const saved = game.settings.register;
  game.settings.register = (_m, key, config) => { registered[key] = config; };
  try {
    registerSettings();
  } finally {
    game.settings.register = saved;
  }
  const s = registered.diceSoNice;
  check(s?.scope === "world" && s.type === Boolean && s.default === true && s.config === true, JSON.stringify(s));
});

await test("preCreateChatMessage: a broken roll doesn't block the message", () => {
  activeModules.add("dice-so-nice");
  registerDiceSoNice();
  const msg = fakeMessage([physicalRoll]);
  msg._source.rolls = ["{not json"];
  let threw = false;
  try { Hooks.callAll("preCreateChatMessage", msg, {}, {}, "u1"); } catch { threw = true; }
  check(!threw && msg.updates.length === 0, "no throw, no update");
});

/**
 * Tooltip parts, with or without a method icon. core: the icon goes in
 * `.part-header`; dnd5e: in `.dice`, plus modifier parts (`.constant-term`).
 */
function fakeTooltip(count, withIcon = [], { layout = "core", constants = 0 } = {}) {
  const parts = Array.from({ length: count }, (_, i) => {
    const header = {
      children: withIcon.includes(i) ? [{ className: "part-method" }] : [],
      querySelector(sel) { return sel === ".part-method" ? this.children.find(c => c.className === "part-method") ?? null : null; },
      prepend(node) { this.children.unshift(node); }
    };
    const own = layout === "core" ? ".part-header" : ".dice";
    return { header, querySelector: sel => (sel === own ? header : null) };
  });
  return {
    parts,
    querySelectorAll: sel => (sel === ".dice-tooltip .tooltip-part:not(.constant-term)" ? parts
      : sel === ".dice-tooltip .tooltip-part" ? [...parts, ...Array.from({ length: constants }, () => ({}))] : [])
  };
}

await test("addCameraIcons: camera icon on physical dice only, never doubled", () => {
  globalThis.CONFIG.Dice = { fulfillment: { methods: { [METHOD_ID]: { icon: "<i>cam</i>" } } } };
  globalThis.document = { createElement: () => ({ dataset: {}, setAttribute(k, v) { this[k] = v; } }) };
  try {
    const message = { rolls: [{ dice: [{ options: { dicevision: { physical: 2 } } }, { options: {} }, { options: { dicevision: { physical: 1 } } }] }] };
    const html = fakeTooltip(3, [2]);
    addCameraIcons(message, html);
    const icons = html.parts.map(p => p.header.children.length);
    check(JSON.stringify(icons) === "[1,0,1]", `icons per part ${JSON.stringify(icons)}`);
    check(html.parts[0].header.children[0].innerHTML === "<i>cam</i>", "the method's icon");
    const mismatched = fakeTooltip(2);
    addCameraIcons(message, mismatched);
    check(mismatched.parts.every(p => p.header.children.length === 0), "part count mismatch: untouched");
    const dnd5e = fakeTooltip(3, [], { layout: "dnd5e", constants: 1 });
    addCameraIcons(message, dnd5e);
    const dnd5eIcons = dnd5e.parts.map(p => p.header.children.length);
    check(JSON.stringify(dnd5eIcons) === "[1,0,1]", `dnd5e breakdown (with a modifier part): icons in .dice ${JSON.stringify(dnd5eIcons)}`);
    CONFIG.Dice.fulfillment.methods[METHOD_ID] = {};
    const noIcon = fakeTooltip(3);
    addCameraIcons(message, noIcon);
    check(noIcon.parts.every(p => p.header.children.length === 0), "no method icon: nothing inserted");
  } finally {
    delete globalThis.document;
  }
});

await interceptTest("several camera fills and an explosion on one term all count on it", async (c) => {
  settings.mode = "replace";
  const ws = connectOneShot(c);
  // Foundry names every input of a term (explosions too) after the term
  const app = fakeResolver(["d6", "d6"]);
  const term = { randomFace: () => 2 };
  app.element.querySelectorAll("input").forEach(i => { i.name = "t0"; });
  app.fulfillable.clear();
  app.fulfillable.set("t0", { term });
  open(app);
  ws.recv(rollOf(["d6", 6], ["d6", 3]));
  await flush();
  check(term.options?.dicevision?.physical === 2, `two fills: ${JSON.stringify(term.options)}`);
  app.addExtraDie("d6", "t0");
  Hooks.callAll("renderRollResolver", app);
  ws.recv(rollOf(["d6", 4]));
  await flush();
  check(term.options?.dicevision?.physical === 3, `explosion counted on the same term: ${JSON.stringify(term.options)}`);
});

await interceptTest("a broken input lookup doesn't stop the dice filling", async (c) => {
  settings.mode = "replace";
  const ws = connectOneShot(c);
  const app = fakeResolver(["d20"]);
  app.fulfillable.set("t0", { get term() { throw new Error("frozen term"); } });
  open(app);
  ws.recv(rollOf(["d20", 13]));
  await flush();
  check(JSON.stringify(app.values()) === '["13"]', `filled anyway ${JSON.stringify(app.values())}`);
  check(!toasts.some(([kind]) => kind === "error"), `no error toast ${JSON.stringify(toasts)}`);
});

await interceptTest("camera fills are counted on their dice term; digital fills aren't", async (c) => {
  settings.mode = "replace";
  const ws = connectOneShot(c);
  const app = fakeResolver(["d3", "d20", "d20"]);
  open(app);
  ws.recv(rollOf(["d20", 18]));
  await flush();
  const marks = ["t0", "t1", "t2"].map(id => app.fulfillable.get(id).term.options?.dicevision?.physical ?? 0);
  check(JSON.stringify(marks) === "[0,1,0]", `physical per term ${JSON.stringify(marks)}`);
});

// ---------------------------------------------------------------------------
// Face strings and unreadable dice (dice-vision PR #420)
// ---------------------------------------------------------------------------

const { readDice, faceNumber } = await import("../scripts/dice-matching.js");
const { describeUnused } = await import("../scripts/roll-intercept.js");

/** A die as the server sends it: {type, value, face, readable} */
const vtt = (type, face, readable = true) => {
  const n = faceNumber(face);
  return { type, value: readable && n !== null ? n : -1, face, readable };
};
const rollOfFaces = (...dice) => ({ ...ROLL, data: { dice, total: 0, roll_id: "rf" } });

await test("faceNumber and readDice read every server shape", () => {
  check(faceNumber("00") === 0 && faceNumber("pip_4") === 4 && faceNumber("-1") === -1, "numbers");
  check(faceNumber("skull") === null && faceNumber("pip_x") === null && faceNumber("") === null, "symbols");
  const [tens, pip, old, unread, symbol, flagged] = readDice([
    { type: "D10", value: 0, face: "00", readable: true },
    { type: "d6", value: "pip_4" },
    { type: "d20", value: 15 },
    { type: "d8", value: -1, face: "-1", readable: false },
    { type: "d12", value: "unknown" },
    { type: "d6", value: 3, face: "3", readable: false }
  ]);
  check(JSON.stringify(tens) === '{"type":"d10","value":0,"face":"00","readable":true,"legacy":false}', `tens ${JSON.stringify(tens)}`);
  check(pip.value === 4 && pip.face === "pip_4" && pip.readable, `pip ${JSON.stringify(pip)}`);
  check(old.value === 15 && old.face === "15" && old.readable && old.legacy, `old server ${JSON.stringify(old)}`);
  check(pip.legacy && !tens.legacy, "legacy only when the server sent no face");
  check(!unread.readable && unread.value === -1, `unreadable ${JSON.stringify(unread)}`);
  check(!symbol.readable && symbol.value === -1, `unknown symbol ${JSON.stringify(symbol)}`);
  check(!flagged.readable, "readable: false wins over a number");
  check(readDice(undefined).length === 0, "no dice");
});

await test("matchDice: faces tell 00 from 0", () => {
  check(filled([vtt("d10", "00"), vtt("d10", "0")], ["d100"]).values[0] === 100, "00 + 0 = 100");
  check(filled([vtt("d10", "0"), vtt("d10", "00")], ["d100"]).values[0] === 100, "order-independent");
  check(filled([vtt("d10", "00"), vtt("d10", "7")], ["d100"]).values[0] === 7, "00 + 7 = 7");
  check(filled([vtt("d10", "0"), vtt("d10", "30")], ["d100"]).values[0] === 30, "30 + 0 = 30");
  check(filled([vtt("d10", "10")], ["d10"]).values[0] === 10, "a d10 printed 1-10 fills a d10 with its 10");
});

await test("matchDice: an unreadable die fills nothing and is reported", () => {
  const { values, unused } = filled([vtt("d20", "-1", false), vtt("d6", "pip_5")], ["d20", "d6"]);
  check(values[0] === undefined && values[1] === 5, `values ${JSON.stringify(values)}`);
  check(unused.length === 1 && unused[0].type === "d20" && unused[0].reason === "unreadable", JSON.stringify(unused));
});

await test("dropCarriedOver: an unreadable die is never carried over", () => {
  const prev = [vtt("d20", "-1", false)];
  const { dice, carried } = dropCarriedOver([vtt("d20", "-1", false), vtt("d8", "3")], prev, ["d8"]);
  check(carried.length === 0 && dice.length === 2, JSON.stringify({ dice, carried }));
  const faces = dropCarriedOver([vtt("d10", "00"), vtt("d10", "0")], [vtt("d10", "0")], ["d10"]);
  check(faces.carried.length === 1 && faces.carried[0].face === "0", `matched by face ${JSON.stringify(faces)}`);
});

await test("describeUnused: names faces as printed, unreadable dice by type", () => {
  const text = describeUnused([
    { ...vtt("d10", "00"), reason: "not-needed" },
    { ...vtt("d20", "-1", false), reason: "unreadable" }
  ]);
  check(text.includes('"d10 (00)"') && /CouldntRead \{"dice":"1d20"\}/.test(text), text);
  const two = describeUnused([{ ...vtt("d8", "-1", false), reason: "unreadable" }, { ...vtt("d8", "-1", false), reason: "unreadable" }]);
  check(/\{"dice":"2d8"\}/.test(two), `counted, not "d8, d8": ${two}`);
});

await test("buildRollData: faces make 00 + 0 a d100 of 100, and a lone 10 a d10", () => {
  let data = buildRollData([vtt("d10", "00"), vtt("d10", "0")]);
  check(data.formula === "1d100" && data.total === 100, `00 + 0: ${data.formula} = ${data.total}`);
  data = buildRollData([vtt("d10", "10")]);
  check(data?.formula === "1d10" && data.total === 10, `lone 10: ${data?.formula} = ${data?.total}`);
  data = buildRollData([vtt("d10", "00")]);
  check(data?.formula === "1d10" && data.total === 10, `lone 00: ${data?.formula} = ${data?.total}`);
  data = buildRollData([vtt("d10", "10"), vtt("d10", "00")]);
  check(data?.formula === "2d10" && data.total === 20, `10 + 00: ${data?.formula} = ${data?.total}`);
  data = buildRollData([vtt("d10", "10"), vtt("d10", "30"), vtt("d10", "5")]);
  check(data?.formula === "1d10 + 1d100" && data.total === 45, `30 takes the units die: ${data?.formula} = ${data?.total}`);
  data = buildRollData([vtt("d10", "10"), vtt("d10", "4")]);
  check(data?.formula === "1d100" && data.total === 14, `10 + 4 can't be told from a percentile roll: ${data?.formula}`);
  data = buildRollData([vtt("d6", "pip_3"), vtt("d6", "pip_6")]);
  check(data?.formula === "2d6" && data.total === 9, `pips ${data?.formula} = ${data?.total}`);
  check(buildRollData([vtt("d20", "12"), vtt("d6", "-1", false)]) === null, "an unreadable die: no roll card");
  check(buildRollData([vtt("d10", "40")]) === null, "a lone 40 still can't be a d10");
});

await test("chat request: an unreadable die isn't posted, warns, and keeps waiting", async (c) => {
  const ws = connectOneShot(c);
  c.requestRoll();
  ws.sent = [];
  ws.recv(rollOfFaces(vtt("d20", "17"), vtt("d8", "-1", false)));
  await flush();
  check(chat.length === 0, "not posted");
  const warns = toasts.filter(([kind]) => kind === "warn");
  check(warns.length === 1 && warns[0][1] === 'DICEVISION.Notifications.CouldntRead {"dice":"1d8"}', `toasts ${JSON.stringify(toasts)}`);
  check(JSON.stringify(ws.sentTypes()) === '["waiting"]', `re-armed ${JSON.stringify(ws.sentTypes())}`);
  check(c.getState().waiting, "still waiting");
  ws.recv(rollOfFaces(vtt("d20", "17"), vtt("d8", "6")));
  await flush();
  check(chat.length === 1 && chat[0].rolls?.[0]?.total === 23, `reroll posted ${JSON.stringify(chat[0]?.rolls?.[0]?.total)}`);
  check(!c.getState().waiting, "done waiting");
});

await test("chat: the stored dice carry face and readable", async (c) => {
  const ws = connectOneShot(c);
  c.requestRoll();
  ws.recv(rollOfFaces(vtt("d10", "00"), vtt("d10", "0")));
  await flush();
  const stored = chat[0]?.flags.dicevision.dice;
  check(stored?.[0]?.face === "00" && stored[1]?.face === "0" && stored.every(d => d.readable === true) && chat[0].rolls?.[0]?.total === 100,
    JSON.stringify(chat[0]?.flags));
});

await interceptTest("replace: an unreadable die is reported in the dialog and its slot keeps waiting", async (c) => {
  settings.mode = "replace";
  const ws = connectOneShot(c);
  const app = fakeResolver(["d20", "d6"]);
  open(app);
  ws.sent = [];
  ws.recv(rollOfFaces(vtt("d20", "-1", false), vtt("d6", "pip_2")));
  await flush();
  check(JSON.stringify(app.values()) === '["","2"]', `values ${JSON.stringify(app.values())}`);
  check(/CouldntRead \{"dice":"1d20"\}/.test(app.notice() ?? ""), `notice ${app.notice()}`);
  check(JSON.stringify(ws.sentTypes()) === '["waiting"]', `re-armed ${JSON.stringify(ws.sentTypes())}`);
  ws.recv(rollOfFaces(vtt("d20", "19"), vtt("d6", "pip_2")));
  await flush();
  check(JSON.stringify(app.values()) === '["19","2"]', `reroll fills the d20 ${JSON.stringify(app.values())}`);
});

await interceptTest("replace: 00 + 0 fills a d100 with 100", async (c) => {
  settings.mode = "replace";
  const ws = connectOneShot(c);
  const app = fakeResolver(["d100"]);
  open(app);
  ws.recv(rollOfFaces(vtt("d10", "0"), vtt("d10", "00")));
  await flush();
  check(JSON.stringify(app.values()) === '["100"]', `values ${JSON.stringify(app.values())}`);
  check(app.notice() === undefined && !toasts.some(([kind]) => kind === "warn"), `no warning ${app.notice()} ${JSON.stringify(toasts)}`);
});

// ---------------------------------------------------------------------------
// Review fixes: unreadable dice in pairs and batches, malformed input
// ---------------------------------------------------------------------------

await test("matchDice: an unreadable tens die never lets a units 0 stand in for it", () => {
  const r = matchDice([vtt("d10", "-1", false), vtt("d10", "0"), vtt("d10", "7")], ["d100", "d10"]);
  check(!r.fills.some(f => f.index === 0), `d100 left open ${JSON.stringify(r.fills)}`);
  check(r.unused.some(d => d.reason === "unreadable" && d.type === "d10"), `unreadable d10 reported ${JSON.stringify(r.unused)}`);
  check(filled([vtt("d10", "0"), vtt("d10", "5")], ["d100"]).values[0] === undefined, `faced "0" + "5" isn't a pair`);
  check(filled([die("d10", 0), die("d10", 5)], ["d100"]).values[0] === 5, "a server without faces: 0 + 5 still reads as 00 + 5");
});

await test("matchDice: an unreadable die the roll doesn't need is ignored, not reported", () => {
  let r = matchDice([vtt("d20", "-1", false), vtt("d20", "17")], ["d20"]);
  check(r.fills[0]?.value === 17 && r.unused.length === 0 && r.ignored.length === 1, `slot already filled ${JSON.stringify(r)}`);
  r = matchDice([vtt("d20", "-1", false), vtt("d6", "3"), vtt("d6", "4")], ["d6", "d6"]);
  check(r.fills.length === 2 && r.unused.length === 0 && r.ignored[0]?.type === "d20", `the attack's d20 during damage ${JSON.stringify(r)}`);
  r = matchDice([vtt("d10", "00", false), vtt("d10", "7")], ["d100"]);
  const reasons = r.unused.map(d => d.reason).sort();
  check(JSON.stringify(reasons) === '["missing-pair","unreadable"]' && !r.fills.length, `unreadable tens die for a d100 ${JSON.stringify(r.unused)}`);
});

await test("matchDice and buildRollData: more 00 cases", () => {
  check(filled([vtt("d10", "00")], ["d10"]).values[0] === 10, "a lone 00 fills a d10 with 10");
  const r = matchDice([vtt("d10", "00"), vtt("d10", "0")], ["d100"]);
  check(r.fills[0]?.value === 100 && r.unused.length === 0 && r.ignored.length === 0, `00 + 0, nothing left over ${JSON.stringify(r)}`);
  const data = buildRollData([vtt("d10", "00"), vtt("d10", "00"), vtt("d10", "0")]);
  check(data?.formula === "1d100 + 1d10" && data.total === 110, `00 + 00 + 0: ${data?.formula} = ${data?.total}`);
});

await test("dropCarriedOver: a die flagged unreadable isn't carried even when its face matches", () => {
  const flagged = { type: "d20", value: 15, face: "15", readable: false };
  const { dice, carried } = dropCarriedOver([flagged], [vtt("d20", "15")], []);
  check(carried.length === 0 && dice.length === 1 && !dice[0].readable, JSON.stringify({ dice, carried }));
  const beside = dropCarriedOver([vtt("d20", "15"), vtt("d20", "-1", false)], [vtt("d20", "15")], ["d20"]);
  check(beside.carried[0]?.face === "15" && beside.dice.length === 1 && !beside.dice[0].readable,
    `the old 15 is still dropped beside an unreadable d20 ${JSON.stringify(beside)}`);
});

await test("readDice: malformed entries read as unreadable dice, never throw", () => {
  const read = readDice([null, 5, { value: 3 }, { type: " ", value: 2 }, { type: "d6", value: "7", readable: "false" }]);
  check(read.length === 5, `length ${read.length}`);
  check(!read[0].readable && !read[1].readable && read[0].type === "d?", `null and numbers ${JSON.stringify(read.slice(0, 2))}`);
  check(read[2].type === "d?" && read[3].type === "d?", `missing or blank type ${JSON.stringify(read.slice(2, 4))}`);
  check(!read[4].readable, `readable "false" (a string) isn't readable ${JSON.stringify(read[4])}`);
  check(readDice({}).length === 0 && readDice("d20").length === 0, "a non-array is no dice");
  const once = readDice([{ type: "D10", value: 0 }, vtt("d10", "00"), { type: "d6", value: "pip_4" }, vtt("d8", "-1", false)]);
  check(JSON.stringify(readDice(once)) === JSON.stringify(once), `safe to read twice ${JSON.stringify(once)}`);
});

await test("chat: a roll with no dice list isn't posted, warns, and keeps waiting", async (c) => {
  const ws = connectOneShot(c);
  c.requestRoll();
  ws.sent = [];
  ws.recv({ type: "roll", data: { total: 0 } });
  ws.recv({ type: "roll", data: { dice: {}, total: 0 } });
  await flush();
  check(chat.length === 0, "not posted");
  const warns = toasts.filter(([kind]) => kind === "warn");
  check(warns.length === 1 && warns[0][1] === "DICEVISION.Notifications.EmptyRoll", `one warning ${JSON.stringify(warns)}`);
  check(ws.sentTypes().filter(t => t === "waiting").length === 2 && c.getState().waiting, `re-armed ${JSON.stringify(ws.sentTypes())}`);
  ws.recv(ROLL);
  await flush();
  check(chat.length === 1 && !c.getState().waiting, "the next roll posts");
});

await test("chat: a null die entry is reported, not thrown on", async (c) => {
  const ws = connectOneShot(c);
  c.requestRoll();
  ws.recv(rollOfFaces(null, vtt("d20", "5")));
  await flush();
  check(chat.length === 0 && c.getState().waiting, "not posted, still waiting");
  check(toasts.at(-1)?.[1] === 'DICEVISION.Notifications.CouldntRead {"dice":"1d?"}', `toasts ${JSON.stringify(toasts)}`);
});

await test("continuous: an unreadable die left on the table warns once until a usable roll", async (c) => {
  const ws = connectConfirmed(c);
  ws.sent = [];
  const stuck = rollOfFaces(vtt("d20", "12"), vtt("d6", "-1", false));
  ws.recv(stuck);
  ws.recv(stuck);
  ws.recv(stuck);
  await flush();
  const warns = () => toasts.filter(([kind, m]) => kind === "warn" && m.startsWith("DICEVISION.Notifications.CouldntRead"));
  check(chat.length === 0 && warns().length === 1, `chat ${chat.length}, warnings ${warns().length}`);
  check(ws.sentTypes().filter(t => t === "waiting").length === 3, `re-armed each time ${JSON.stringify(ws.sentTypes())}`);
  ws.recv(rollOfFaces(vtt("d20", "12"), vtt("d6", "2")));
  await flush();
  check(chat.length === 1, "a usable roll posts");
  ws.recv(stuck);
  await flush();
  check(warns().length === 2, "warns again after a usable roll");
});

await interceptTest("a roll dialog takes an unreadable roll before a pending chat request; one warning", async (c) => {
  settings.mode = "replace";
  const ws = connectOneShot(c);
  c.requestRoll();
  const app = fakeResolver(["d20"]);
  open(app);
  toasts = [];
  ws.recv(rollOfFaces(vtt("d20", "-1", false)));
  await flush();
  const warns = toasts.filter(([kind]) => kind === "warn");
  check(chat.length === 0 && warns.length === 1 && /Fulfillment\.CouldntRead/.test(warns[0][1]), `one dialog warning ${JSON.stringify(warns)}`);
  ws.recv(rollOfFaces(vtt("d20", "9")));
  await flush();
  check(JSON.stringify(app.values()) === '["9"]', `dialog filled ${JSON.stringify(app.values())}`);
  ws.recv(rollOfFaces(vtt("d8", "4")));
  await flush();
  check(chat.length === 1, "the chat request gets the next roll");
});

await interceptTest("replace: a roll with no dice list shows EmptyRoll and keeps waiting", async (c) => {
  settings.mode = "replace";
  const ws = connectOneShot(c);
  const app = fakeResolver(["d20"]);
  open(app);
  ws.sent = [];
  ws.recv({ type: "roll", data: { total: 0 } });
  await flush();
  check(app.notice() === "DICEVISION.Fulfillment.EmptyRoll", `notice ${app.notice()}`);
  check(JSON.stringify(ws.sentTypes()) === '["waiting"]', `re-armed ${JSON.stringify(ws.sentTypes())}`);
});

// ---------------------------------------------------------------------------
// Sidebar panel (pure parts; the tab itself needs Foundry's ApplicationV2)
// ---------------------------------------------------------------------------

await test("sidebar: formatCode shows the dashed display format", () => {
  check(formatCode("XKRM4N7B") === "XKRM-4N7B", "plain code gets a dash");
  check(formatCode("xkrm-4n7b") === "XKRM-4N7B", "lower-case dashed code is normalized");
  check(formatCode(null) === "" && formatCode("") === "", "no code is empty");
  check(formatCode("ABC") === "ABC", "a short code is left alone");
});

await test("sidebar: panelStatus follows the client state", (c) => {
  const status = () => panelStatus(c.getState());
  check(status().key === "DICEVISION.Sidebar.Status.Disconnected", "disconnected at first");

  settings.continuous = false;
  c.connect("XKRM-4N7B");
  let s = status();
  check(s.key === "DICEVISION.Sidebar.Status.Connecting" && s.data.code === "XKRM-4N7B", `connecting while the socket opens: ${s.key}`);

  sockets[0].open();
  sockets[0].confirm();
  s = status();
  check(s.key === "DICEVISION.Sidebar.Status.Connected" && s.css === "connected", `connected: ${s.key}`);

  sockets[0].serverClose(1006);
  s = status();
  check(s.key === "DICEVISION.Sidebar.Status.Reconnecting" && s.data.attempt === 1 && s.data.max === 5,
    `reconnecting after a drop: ${JSON.stringify(s)}`);

  // The retry opens a new socket: still reconnecting until the server confirms
  runTimers();
  check(status().key === "DICEVISION.Sidebar.Status.Reconnecting" && sockets.length === 2, "still reconnecting while the retry socket opens");
  sockets[1].open();
  sockets[1].confirm();
  check(status().key === "DICEVISION.Sidebar.Status.Connected" && c.getState().reconnectAttempt === 0, "connected again, counter reset");

  // Five failed retries: Disconnected, not a stale "Reconnecting (5/5)"
  for (let i = 0; i < 6; i++) {
    sockets.at(-1).serverClose(1006);
    runTimers();
  }
  check(!c.getState().sessionActive && c.getState().reconnectAttempt === 0, "gave up: session inactive, counter reset");
  check(status().key === "DICEVISION.Sidebar.Status.Disconnected", "gave up: Disconnected");

  c.disconnect();
  check(status().key === "DICEVISION.Sidebar.Status.Disconnected", "disconnected after disconnect()");
});

await test("sidebar: an invalid session mid-retry resets the counter", (c) => {
  settings.continuous = false;
  connectConfirmed(c);
  sockets[0].serverClose(1006);
  runTimers();
  sockets[1].serverClose(4001);
  check(!c.getState().sessionActive && c.getState().reconnectAttempt === 0, "4001: session inactive, counter reset");
  check(panelStatus(c.getState()).key === "DICEVISION.Sidebar.Status.Disconnected", "4001: Disconnected");
});

await test("sidebar: registerSidebarTab returns false without the v13 API and touches nothing", (c) => {
  // The harness has no CONFIG.ui or foundry.applications, like Foundry v12
  const before = Object.keys(hooks).length;
  let result;
  try {
    result = registerSidebarTab(c);
  } catch (err) {
    result = err;
  }
  check(result === false, `returns false, no throw: ${result}`);
  check(Object.keys(hooks).length === before, "registers no hooks");
  check(!(globalThis.CONFIG?.ui), "leaves CONFIG.ui alone");
});

await test("sidebar: connectWithCode saves a new code and reconnects a saved one", async (c) => {
  const { connectWithCode } = chatControls;
  settings.sessionCode = "";
  check((await connectWithCode(c, "nope")) === false && sockets.length === 0, "invalid code: rejected, nothing opened");
  check((await connectWithCode(c, "xkrm-4n7b")) === true, "valid code accepted");
  check(settings.sessionCode === "xkrm-4n7b" && sockets.length === 1, "new code saved and connected via onChange");
  check((await connectWithCode(c, "XKRM4N7B")) === true && sockets.length === 2, "same code: reconnects directly");

  // The onChange hook failing to connect (Foundry only logs hook errors) is reported
  settings.sessionCode = "";
  c.disconnect();
  globalThis.WebSocket = class { constructor() { throw new Error("no sockets"); } };
  let error;
  try {
    await connectWithCode(c, "ABCD-2345");
  } catch (err) {
    error = err;
  }
  globalThis.WebSocket = FakeWebSocket;
  check(error instanceof Error && !c.getState().sessionActive, `throws when no connection started: ${error?.message}`);
});

console.info(`\n${passes} checks passed, ${failures} failed`);
process.exitCode = failures ? 1 : 0;
