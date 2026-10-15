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
    // Mirrors the onChange hooks in settings.js
    set: async (_module, key, value) => {
      settings[key] = value;
      const hook = { mode: "modeChanged", continuous: "continuousChanged", sessionCode: "sessionCodeChanged" }[key];
      if (hook) Hooks.callAll(`dicevision.${hook}`, value);
    }
  },
  i18n: { localize: key => key, format: key => key },
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
  settings = { mode: "chat", continuous: true, timeout: 15, rollLabel: "DV", chatVisibility: "all" };
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
  check(!toasts.some(([, m]) => m === "DICEVISION.Notifications.Connected"), "no Connected toast before confirmation");
  ws.serverClose(4001);
  check(toasts.at(-1)?.[1] === "DICEVISION.Notifications.InvalidSession", "invalid session error shown");
  check(timers.length === 0, "no reconnect after 4001");
});

await test("confirmed session sends waiting and shows Connected", (c) => {
  const ws = connectConfirmed(c);
  check(ws.sent.some(m => m.type === "waiting" && m.app_id === "foundry"), "waiting sent with app_id foundry");
  check(toasts.some(([, m]) => m === "DICEVISION.Notifications.Connected"), "Connected toast");
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

await test("mode off: a waitForResult made while connecting registers waiting on confirm", (c) => {
  settings.mode = "off";
  c.connect("XKRM4N7B");
  c.waitForResult("d20", 99999);
  const ws = sockets.at(-1);
  ws.open();
  ws.confirm();
  check(ws.sentTypes().includes("waiting"), "waiting sent for pending callback");
});

await test("failed chat post shows an error notification", async (c) => {
  globalThis.ChatMessage = { create: async () => { throw new Error("no permission"); } };
  const ws = connectConfirmed(c);
  ws.recv(ROLL);
  await flush();
  check(toasts.at(-1)?.join() === "error,DICEVISION.Notifications.DisplayFailed", `toasts: ${JSON.stringify(toasts)}`);
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

await test("mode change: chat sends waiting, off sends cancel", (c) => {
  settings.mode = "off";
  const ws = connectConfirmed(c);
  settings.mode = "chat";
  Hooks.callAll("dicevision.modeChanged", "chat");
  check(ws.sentTypes().at(-1) === "waiting", "waiting on switch to chat");
  settings.mode = "off";
  Hooks.callAll("dicevision.modeChanged", "off");
  check(ws.sentTypes().at(-1) === "cancel", "cancel on switch to off");
});

await test("mode change to off keeps waiting while a waitForResult is pending", (c) => {
  const ws = connectConfirmed(c);
  c.waitForResult("d20", 99999);
  settings.mode = "off";
  Hooks.callAll("dicevision.modeChanged", "off");
  check(!ws.sentTypes().includes("cancel"), "no cancel with pending callback");
});

await test("disconnect cancels waiting before closing", (c) => {
  const ws = connectConfirmed(c);
  c.disconnect();
  check(ws.sentTypes().at(-1) === "cancel", `sent ${JSON.stringify(ws.sentTypes())}`);
  check(ws.readyState === 3, "socket closed");
});

await test("switching session code cancels waiting on the old session", (c) => {
  const oldWs = connectConfirmed(c);
  Hooks.callAll("dicevision.sessionCodeChanged", "ABCD2345");
  check(oldWs.sentTypes().at(-1) === "cancel", "cancel sent on old socket");
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
  check(!ws.sentTypes().includes("cancel"), "no cancel: we never registered, and a cancel would clear the other app");
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
  check(c.requestRoll() === true, "returns true");
  check(ws.sent.length === 0, "nothing sent");
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

await test("cancelRequest keeps waiting for a pending waitForResult", (c) => {
  const ws = connectOneShot(c);
  c.waitForResult("d20", 99999);
  c.requestRoll();
  c.cancelRequest();
  check(!ws.sentTypes().includes("cancel"), `sent ${JSON.stringify(ws.sentTypes())}`);
});

await test("toggling continuous registers and releases waiting", async (c) => {
  const ws = connectOneShot(c);
  await game.settings.set("dicevision", "continuous", true);
  check(ws.sentTypes().at(-1) === "waiting", "waiting on continuous on");
  await game.settings.set("dicevision", "continuous", false);
  check(ws.sentTypes().at(-1) === "cancel", "cancel on continuous off");
});

await test("continuous off while a request is pending keeps waiting", async (c) => {
  const ws = connectConfirmed(c);
  settings.continuous = false;
  c.pendingChatRoll = true; // requested before continuous was switched off
  Hooks.callAll("dicevision.continuousChanged", false);
  check(!ws.sentTypes().includes("cancel"), `sent ${JSON.stringify(ws.sentTypes())}`);
});

await test("mode change to chat with continuous off does not register waiting", (c) => {
  settings.mode = "off";
  const ws = connectOneShot(c);
  settings.mode = "chat";
  Hooks.callAll("dicevision.modeChanged", "chat");
  check(!ws.sentTypes().includes("waiting"), `sent ${JSON.stringify(ws.sentTypes())}`);
});

await test("mode change to off drops a pending request", (c) => {
  const ws = connectOneShot(c);
  c.requestRoll();
  settings.mode = "off";
  Hooks.callAll("dicevision.modeChanged", "off");
  check(ws.sentTypes().at(-1) === "cancel", "cancel sent");
  check(c.pendingChatRoll === false, "request dropped");
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

await test("disconnect drops a pending request", (c) => {
  connectOneShot(c);
  c.requestRoll();
  c.disconnect();
  check(c.pendingChatRoll === false, "request dropped");
});

await test("disconnect without a registration sends no cancel", (c) => {
  const ws = connectOneShot(c);
  c.disconnect();
  check(!ws.sentTypes().includes("cancel"), `sent ${JSON.stringify(ws.sentTypes())}`);
});

await test("waitForResult timeout releases waiting", (c) => {
  const ws = connectOneShot(c);
  c.waitForResult("d20", 5000);
  check(ws.sentTypes().at(-1) === "waiting", "waiting sent");
  runTimers();
  check(ws.sentTypes().at(-1) === "cancel", `sent ${JSON.stringify(ws.sentTypes())}`);
});

await test("state changes are announced for the chat controls", (c) => {
  const states = [];
  Hooks.on("dicevision.stateChanged", s => states.push(s));
  connectOneShot(c);
  c.requestRoll();
  check(states.at(-1)?.connected && states.at(-1)?.waiting, `last ${JSON.stringify(states.at(-1))}`);
  c.cancelRequest();
  check(states.at(-1)?.waiting === false, "not waiting after cancel");
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

await test("/dv status and unknown commands reply privately", async (c) => {
  registerChatControls(c);
  connectOneShot(c);
  chatLine("/dv status");
  chatLine("/dv nonsense");
  await flush();
  check(chat.length === 2 && chat.every(m => JSON.stringify(m.whisper) === '["u1"]'), `chat ${JSON.stringify(chat)}`);
  check(chat[1]?.content === "DICEVISION.Commands.Help", "help shown for unknown command");
});

// ---------------------------------------------------------------------------
// waitForResult (Phase 2)
// ---------------------------------------------------------------------------

await test("waitForResult matches dice by type, in order", async (c) => {
  const ws = connectConfirmed(c);
  const first = c.waitForResult("d20", 99999);
  const d6 = c.waitForResult("d6", 99999);
  const second = c.waitForResult("d20", 99999);
  ws.recv({ ...ROLL, data: { dice: [{ type: "d6", value: 3 }, { type: "d20", value: 15 }], total: 18 } });
  check((await settled(first)) === 15, "first d20 gets 15");
  check((await settled(d6)) === 3, "d6 gets 3");
  check((await settled(second)) === PENDING, "second d20 still pending");
});

await test("waitForResult timeout resolves null", async (c) => {
  connectConfirmed(c);
  const result = c.waitForResult("d20", 5000);
  check(runTimers().includes(5000), "timeout scheduled with given ms");
  check((await settled(result)) === null, "resolved null");
});

await test("waitForResult resolves null on disconnect", async (c) => {
  connectConfirmed(c);
  const result = c.waitForResult("d20", 99999);
  c.disconnect();
  check((await settled(result)) === null, "resolved null");
});

await test("waitForResult resolves null on invalid session (4001)", async (c) => {
  c.connect("BADCODE1");
  const result = c.waitForResult("d20", 99999);
  sockets.at(-1).open();
  sockets.at(-1).serverClose(4001);
  check((await settled(result)) === null, "resolved null");
});

await test("waitForResult resolves null when reconnects are exhausted", async (c) => {
  connectConfirmed(c);
  const result = c.waitForResult("d20", 99999);
  // Keep the callback's own timeout out of failAllRetries' timer runs
  const callbackTimer = timers.find(t => t.ms === 99999);
  timers = timers.filter(t => t !== callbackTimer);
  failAllRetries();
  check((await settled(result)) === null, "resolved null");
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
