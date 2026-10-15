#!/usr/bin/env node
// Stand-in for the DiceVision dashboard: joins a bridge session and answers
// "waiting" requests with scripted rolls, so the module can be tested without
// a camera or physical dice.
//
//   node scripts-dev/fake-dashboard.mjs XKRM-4N7B --dice 1d20,2d6 --max 3
//
// Options:
//   --dice SPEC   Dice to "roll", e.g. 1d20 or 1d20,2d6 (default 1d20)
//   --max N       Stop after sending N rolls (default 1; 0 = unlimited)
//   --delay MS    Wait before answering a request (default 500)
//   --watch S     After the last roll, keep listening S seconds to see whether
//                 the app asks again (default 3). Repeated requests are what
//                 lock the real dashboard into continuous capture.
//   --url URL     Bridge base URL (default wss://dicevision.dirtyowlbear.com/api/bridge)
//
// Like the real dashboard, it only sends a roll while some app is waiting.
// Prints one JSON line per event and exits non-zero on an invalid session.

const args = process.argv.slice(2);
const code = args.find(a => !a.startsWith('--') && !isOptionValue(a));
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
function isOptionValue(a) {
  const i = args.indexOf(a);
  return i > 0 && args[i - 1].startsWith('--');
}

if (!code) {
  console.error('usage: fake-dashboard.mjs SESSION_CODE [--dice 1d20,2d6] [--max N] [--delay MS] [--watch S] [--url URL]');
  process.exit(2);
}

const base = opt('url', 'wss://dicevision.dirtyowlbear.com/api/bridge');
const diceSpec = opt('dice', '1d20');
const maxRolls = Number(opt('max', '1'));
const delayMs = Number(opt('delay', '500'));
const watchS = Number(opt('watch', '3'));

const log = (event, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...extra }));

function rollDice(spec) {
  const dice = [];
  for (const part of spec.split(',')) {
    const m = /^(\d*)d(\d+|%)$/i.exec(part.trim());
    if (!m) throw new Error(`bad dice spec: ${part}`);
    const count = Number(m[1] || 1);
    const sides = m[2] === '%' ? 100 : Number(m[2]);
    for (let i = 0; i < count; i++) {
      dice.push({ type: sides === 100 ? 'd100' : `d${sides}`, value: 1 + Math.floor(Math.random() * sides) });
    }
  }
  return dice;
}

const normalized = code.toUpperCase().replace(/-/g, '');
const ws = new WebSocket(`${base}/${normalized}`);
let waitingApps = new Set();
let sent = 0;
let pending = null;
let requestsAfterLast = 0;
let watchTimer = null;

function maybeRoll(reason) {
  if (pending || waitingApps.size === 0) return;
  if (maxRolls > 0 && sent >= maxRolls) {
    requestsAfterLast++;
    log('request_ignored', { reason, apps: [...waitingApps], note: 'max rolls reached' });
    return;
  }
  pending = setTimeout(() => {
    pending = null;
    if (waitingApps.size === 0) return;
    const dice = rollDice(diceSpec);
    const total = dice.reduce((s, d) => s + d.value, 0);
    const roll_id = crypto.randomUUID();
    ws.send(JSON.stringify({ type: 'roll', data: { dice, total, roll_id } }));
    sent++;
    log('roll_sent', { n: sent, dice, total, roll_id, to: [...waitingApps] });
    // The real dashboard drops its local "waiting" flag after each roll and
    // only re-arms on the next "waiting" broadcast.
    waitingApps = new Set();
    if (maxRolls > 0 && sent >= maxRolls) {
      watchTimer = setTimeout(() => {
        log('done', { rolls: sent, requests_after_last_roll: requestsAfterLast });
        ws.close(1000);
      }, watchS * 1000);
    }
  }, delayMs);
}

ws.onopen = () => log('open', { session: normalized });
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case 'connected':
      waitingApps = new Set(msg.waiting_apps ?? []);
      log('connected', { waiting_apps: [...waitingApps] });
      maybeRoll('already waiting');
      break;
    case 'waiting':
      waitingApps.add(msg.app);
      log('waiting', { app: msg.app });
      maybeRoll('waiting');
      break;
    case 'cancelled':
      waitingApps = new Set();
      if (pending) { clearTimeout(pending); pending = null; }
      log('cancelled');
      break;
    case 'roll':
      break; // our own roll echoed back to session members
    default:
      log(msg.type, msg);
  }
};
ws.onclose = (event) => {
  clearTimeout(watchTimer);
  log('closed', { code: event.code, reason: event.reason });
  process.exit(event.code === 4001 ? 1 : 0);
};
ws.onerror = () => log('socket_error');

setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'ping' })), 30000).unref();
