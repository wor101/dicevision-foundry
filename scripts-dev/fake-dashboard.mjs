#!/usr/bin/env node
// Stand-in for the DiceVision dashboard: joins a bridge session and answers
// "waiting" requests with scripted rolls, so the module can be tested without
// a camera or physical dice.
//
//   node scripts-dev/fake-dashboard.mjs XKRM-4N7B --dice 1d20,2d6 --max 3
//
// Options:
//   --dice SPEC   Dice to "roll", e.g. 1d20 or 1d20,2d6 (default 1d20).
//                 Fix a value with =: d20=17 or 2d6=3. Separate rolls with ;
//                 to send different dice each time (the last spec repeats):
//                 "d20=12;d6=2" sends a d20 of 12, then a d6 of 2.
//   --max N       Stop after sending N rolls (default 1; 0 = unlimited)
//   --delay MS    Wait before answering a request (default 500)
//   --no-dice N   First answer N times with "no_dice" (recognition found
//                 nothing), as the real dashboard does while an app waits
//   --watch S     After the last roll, keep listening S seconds to see whether
//                 the app asks again (default 3). A request after the last
//                 roll would keep the real dashboard in continuous capture.
//   --url URL     Bridge base URL (default wss://dicevision.dirtyowlbear.com/api/bridge)
//
// Like the real dashboard, it only sends a roll while some app is waiting.
// Prints one JSON line per event. Exits 0 after a clean finish, 1 on an
// invalid session (close code 4001, dice-vision#407+) or any other abnormal
// close, and 2 on bad arguments.

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
  console.error('usage: fake-dashboard.mjs SESSION_CODE [--dice 1d20,2d6] [--max N] [--delay MS] [--no-dice N] [--watch S] [--url URL]');
  process.exit(2);
}

function usageError(message) {
  console.error(`fake-dashboard: ${message}`);
  process.exit(2);
}

function numberOpt(name, fallback) {
  const value = Number(opt(name, fallback));
  if (!Number.isFinite(value) || value < 0) usageError(`--${name} must be a non-negative number`);
  return value;
}

const base = opt('url', 'wss://dicevision.dirtyowlbear.com/api/bridge');
const diceSpec = opt('dice', '1d20');
const maxRolls = numberOpt('max', '1');
const delayMs = numberOpt('delay', '500');
const watchS = numberOpt('watch', '3');
let noDiceLeft = numberOpt('no-dice', '0');

const log = (event, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...extra }));

const rollSpecs = diceSpec.split(';');

function rollDice(spec) {
  const dice = [];
  for (const part of spec.split(',')) {
    const m = /^(\d*)d(\d+|%)(?:=(\d+))?$/i.exec(part.trim());
    if (!m) throw new Error(`bad dice spec: ${part}`);
    const count = Number(m[1] || 1);
    const sides = m[2] === '%' ? 100 : Number(m[2]);
    for (let i = 0; i < count; i++) {
      const value = m[3] !== undefined ? Number(m[3]) : 1 + Math.floor(Math.random() * sides);
      dice.push({ type: sides === 100 ? 'd100' : `d${sides}`, value });
    }
  }
  return dice;
}

try {
  rollSpecs.forEach(rollDice); // fail on a bad spec now, not mid-test
} catch (err) {
  usageError(err.message);
}

const normalized = code.toUpperCase().replace(/-/g, '');
let finished = false;
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
    if (noDiceLeft > 0) {
      // Waiting state is unchanged by no_dice: keep "capturing"
      noDiceLeft--;
      ws.send(JSON.stringify({ type: 'no_dice' }));
      log('no_dice_sent', { to: [...waitingApps] });
      maybeRoll('still waiting');
      return;
    }
    const dice = rollDice(rollSpecs[Math.min(sent, rollSpecs.length - 1)]);
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
        finished = true;
        ws.close(1000);
      }, watchS * 1000);
    }
  }, delayMs);
}

ws.onopen = () => log('open', { session: normalized });
ws.onmessage = (event) => {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch {
    log('bad_message', { data: String(event.data).slice(0, 200) });
    return;
  }
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
    case 'no_dice':
      break; // our own messages echoed back to session members
    default:
      log(msg.type, msg);
  }
};
ws.onclose = (event) => {
  clearTimeout(watchTimer);
  log('closed', { code: event.code, reason: event.reason });
  process.exit(finished && event.code === 1000 ? 0 : 1);
};
ws.onerror = (event) => log('socket_error', { message: event.message ?? event.error?.message ?? null });

setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'ping' })), 30000).unref();
