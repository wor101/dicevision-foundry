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
  user: { id: "u1" }
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
  globalThis.foundry = {};
}

reset();
const { DiceVisionClient } = await import("../scripts/dicevision-client.js");
const { registerChatControls } = await import("../scripts/chat-controls.js");
const { registerSettings } = await import("../scripts/settings.js");

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const PENDING = Symbol("pending");
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

/** Resolve to the promise's value if already settled, else PENDING. */
async function settled(promise) {
  return Promise.race([promise, new Promise(r => setImmediate(() => r(PENDING)))]);
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

await test("/dv roll in Replace mode explains rolling in Foundry instead", (c) => {
  settings.mode = "replace";
  const ws = connectOneShot(c);
  check(c.requestRoll() === false, "requestRoll refused");
  check(toasts.at(-1)?.[1] === "DICEVISION.Notifications.ReplaceMode", `toasts ${JSON.stringify(toasts)}`);
  check(!ws.sentTypes().includes("waiting"), "no waiting sent");
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

await controlsTest("buttons appear in chat mode and go away in mode off", async (c) => {
  const button = withChatControls(c);
  connectOneShot(c);
  check(button("request") && button("continuous"), "both buttons rendered");
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
  check(unused.length === 3 && unused.every(d => d.reason === "out-of-range"), JSON.stringify(unused));
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
    globalThis.CONFIG = { Dice: { fulfillment: { methods: {}, defaultMethod: "" } } };
    globalThis.document = { createElement: tag => new FakeNode(tag) };
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

await test("chat groups dice by type with subtotals", async (c) => {
  const msg = await postRoll(c, {
    dice: [{ type: "d6", value: 3 }, { type: "d20", value: 15 }, { type: "d6", value: 4 }],
    total: 22
  });
  const content = JSON.parse(msg.content);
  const d6 = content.groups.find(g => g.type === "D6");
  check(d6?.count === 2 && d6.subtotal === 7, `d6 group ${JSON.stringify(d6)}`);
  check(content.total === 22 && content.diceCount === 3, "total and dice count");
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
  await postRoll(c, ROLL.data);
  check(namespacedCalls === 1 && chat.length === 1, "namespaced renderTemplate used");
});

console.info(`\n${passes} checks passed, ${failures} failed`);
process.exitCode = failures ? 1 : 0;
