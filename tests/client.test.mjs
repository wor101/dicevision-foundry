/**
 * DiceVisionClient behavior tests against mocked Foundry globals and a fake
 * WebSocket. No Foundry or npm install needed:
 *
 *   node tests/client.test.mjs
 */
const settings = { mode: "chat", timeout: 15, rollLabel: "DV", chatVisibility: "all" };
const hooks = {};
const toasts = [];
const chat = [];
globalThis.Hooks = { on: (n, f) => ((hooks[n] ??= []).push(f)), callAll: (n, ...a) => (hooks[n] ?? []).forEach(f => f(...a)) };
globalThis.game = { settings: { get: (_m, k) => settings[k] }, i18n: { localize: k => k, format: k => k }, users: [], user: { id: "u1" } };
globalThis.ui = { notifications: { info: m => toasts.push(["info", m]), warn: m => toasts.push(["warn", m]), error: m => toasts.push(["error", m]) } };
globalThis.ChatMessage = { create: async d => chat.push(d) };
globalThis.renderTemplate = async (_t, d) => JSON.stringify(d);
globalThis.foundry = {};
console.log = () => {}; console.warn = () => {}; console.error = () => {};

// Manual timers
let timers = [];
globalThis.setTimeout = (f, ms) => { const t = { f, ms }; timers.push(t); return t; };
globalThis.clearTimeout = t => { timers = timers.filter(x => x !== t); };
globalThis.setInterval = () => ({}); globalThis.clearInterval = () => {};
const runTimers = () => { const ts = timers; timers = []; ts.forEach(t => t.f()); return ts.map(t => t.ms); };

const sockets = [];
class FakeWS {
  static OPEN = 1;
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
  send(d) { this.sent.push(JSON.parse(d)); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  serverClose(code) { this.readyState = 3; this.onclose?.({ code, reason: "" }); }
  recv(m) { this.onmessage?.({ data: JSON.stringify(m) }); }
}
globalThis.WebSocket = FakeWS;

const { diceVisionClient: c } = await import("../scripts/dicevision-client.js");
const assert = (cond, msg) => { if (!cond) { console.info("FAIL:", msg); process.exitCode = 1; } else console.info("ok:", msg); };

// 1. Chat mode registers waiting on open and again after each roll
c.connect("xkrm-4n7b");
let ws = sockets.at(-1);
assert(ws.url.endsWith("/XKRM4N7B"), "session code normalized");
ws.open();
assert(ws.sent.some(m => m.type === "waiting" && m.app_id === "foundry"), "sends waiting on open in chat mode");
ws.sent = [];
ws.recv({ type: "roll", data: { dice: [{ type: "d20", value: 15 }], total: 15, roll_id: "r1" } });
await new Promise(r => setImmediate(r));
assert(ws.sent.some(m => m.type === "waiting"), "re-sends waiting after roll");
assert(chat.length === 1, "roll posted to chat");

// 2. Reconnect gives up after 5 attempts (never opening)
toasts.length = 0;
ws.serverClose(1006);
const delays = [];
for (let i = 0; i < 10; i++) {
  const ran = runTimers();
  if (!ran.length) break;
  delays.push(...ran);
  sockets.at(-1).serverClose(1006);
}
assert(JSON.stringify(delays) === "[2000,4000,8000,16000,30000]", `backoff delays ${JSON.stringify(delays)}`);
assert(toasts.at(-1)?.[1] === "DICEVISION.Notifications.MaxReconnect", "stops with MaxReconnect warning");
assert(timers.length === 0, "no further reconnect scheduled");

// 3. 4001 stops immediately
c.connect("XKRM4N7B"); sockets.at(-1).serverClose(4001);
assert(timers.length === 0 && toasts.at(-1)?.[0] === "error", "4001 -> error, no reconnect");

// 4. Clearing session code cancels a pending reconnect
c.connect("XKRM4N7B"); sockets.at(-1).serverClose(1006);
assert(timers.length === 1, "reconnect pending");
Hooks.callAll("dicevision.sessionCodeChanged", "");
assert(timers.length === 0, "clearing code cancels pending reconnect");

// 5. Mode off -> no waiting on open
settings.mode = "off";
c.connect("XKRM4N7B"); ws = sockets.at(-1); ws.open();
assert(!ws.sent.some(m => m.type === "waiting"), "mode off does not send waiting");
Hooks.callAll("dicevision.modeChanged", "chat"); settings.mode = "chat";
assert(ws.sent.some(m => m.type === "waiting"), "switching to chat sends waiting");

// 6. Pending waitForResult resolves null on disconnect
const p = c.waitForResult("d20", 99999);
c.disconnect();
assert((await p) === null, "waitForResult resolves null on disconnect");
