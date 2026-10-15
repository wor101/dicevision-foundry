#!/usr/bin/env node
// End-to-end check of chat mode against a real Foundry and the live bridge,
// with scripts-dev/fake-dashboard.mjs standing in for the camera.
//
//   node scripts-dev/e2e/continuous.mjs SESSION_CODE
//
// Use a session code nobody is rolling real dice on, and keep the real
// dashboard closed on it.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser, ensureWorld, joinAs, errors } from './foundry.mjs';

const code = process.argv[2];
if (!code) {
  console.error('usage: continuous.mjs SESSION_CODE');
  process.exit(2);
}
const DASHBOARD = fileURLToPath(new URL('../fake-dashboard.mjs', import.meta.url));

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!cond) failures++;
};

const children = new Set();

function dashboard(args) {
  const proc = spawn('node', [DASHBOARD, code, ...args]);
  children.add(proc);
  const events = [];
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        events.push(JSON.parse(line));
      } catch {
        console.error(`fake dashboard: ${line}`);
      }
    }
  });
  proc.stderr.on('data', d => process.stderr.write(`fake dashboard: ${d}`));
  const exitCode = new Promise(r => proc.on('exit', (status) => { children.delete(proc); r(status); }));
  // A dashboard that's never asked for a roll never exits: fail instead of hanging
  const exited = (ms = 30000) => Promise.race([
    exitCode,
    new Promise((_, reject) => setTimeout(() => {
      proc.kill();
      reject(new Error(`fake dashboard still running after ${ms}ms (module never asked for a roll?)`));
    }, ms).unref())
  ]);
  const until = async (name, ms = 15000) => {
    const start = Date.now();
    while (!events.some(e => e.event === name)) {
      if (Date.now() - start > ms) throw new Error(`timed out waiting for dashboard "${name}"`);
      await new Promise(r => setTimeout(r, 100));
    }
  };
  const count = name => events.filter(e => e.event === name).length;
  const done = () => events.find(e => e.event === 'done');
  return { exited, until, count, done };
}

const browser = await launchBrowser();
try {
  await ensureWorld(browser);
  const page = await joinAs(browser, 'Gamemaster');
  await page.evaluate(async (code) => {
    await game.settings.set('dicevision', 'continuous', false);
    await game.settings.set('dicevision', 'sessionCode', code);
    await game.settings.set('dicevision', 'mode', 'chat');
  }, code);
  await page.waitForFunction(() => game.modules.get('dicevision').api.isConnected(), null, { timeout: 15000 });
  await page.waitForTimeout(500);
  const start = await page.evaluate(() => game.messages.size);
  const newMessages = () => page.evaluate(n => game.messages.contents.slice(n).length, start);

  // Continuous off: idle until asked, then exactly one roll
  let dash = dashboard(['--max', '1', '--dice', '1d20', '--watch', '4']);
  await dash.until('connected');
  await page.waitForTimeout(3000);
  check(dash.count('roll_sent') === 0, 'continuous off: no roll requested while idle');
  await page.click('.dicevision-controls [data-dv="request"]');
  await dash.exited();
  check(dash.count('roll_sent') === 1 && (await newMessages()) === 1, 'dice button: one roll posted to chat');
  check(dash.done()?.requests_after_last_roll === 0, 'dice button: no request after the roll');
  check(dash.count('cancelled') === 1, 'dice button: bridge released after the roll');

  // Continuous on: every roll posted, and the dashboard is re-armed
  dash = dashboard(['--max', '2', '--dice', '2d6', '--watch', '3']);
  await dash.until('connected');
  await page.click('.dicevision-controls [data-dv="continuous"]');
  await dash.exited();
  check((await newMessages()) === 3, 'continuous on: both rolls posted');
  check(dash.done()?.requests_after_last_roll === 1, 'continuous on: re-armed after the last roll');

  // Chat commands
  dash = dashboard(['--max', '1', '--dice', '1d8', '--watch', '3']);
  await dash.until('connected');
  for (const line of ['/dv continuous off', '/dv roll']) {
    await page.evaluate(line => ui.chat.processMessage(line), line);
    await page.waitForTimeout(300);
  }
  await dash.exited();
  check(dash.count('roll_sent') === 1 && dash.done()?.requests_after_last_roll === 0, '/dv roll: one roll, no request after it');
  // One cancel from "continuous off", one releasing the bridge after the roll
  check(dash.count('cancelled') === 2, `/dv roll: bridge released after the roll (cancelled x${dash.count('cancelled')})`);

  // Shared code: the Player's release cancel must not stop the GM's continuous mode
  const player = await joinAs(browser, 'Player');
  await player.evaluate(async (code) => {
    await game.settings.set('dicevision', 'continuous', false);
    await game.settings.set('dicevision', 'sessionCode', code);
    await game.settings.set('dicevision', 'mode', 'chat');
  }, code);
  await player.waitForFunction(() => game.modules.get('dicevision').api.isConnected(), null, { timeout: 15000 });
  // Both register before the first roll (--delay), so roll 1 makes the GM
  // re-send "waiting" while the Player sends its release "cancel"
  dash = dashboard(['--max', '3', '--dice', '1d4', '--delay', '1500', '--watch', '3']);
  await dash.until('connected');
  await player.click('.dicevision-controls [data-dv="request"]');
  await page.evaluate(() => game.settings.set('dicevision', 'continuous', true));
  await dash.exited();
  check(dash.count('roll_sent') === 3, `shared code: GM keeps getting rolls after the Player's cancel (${dash.count('roll_sent')}/3)`);
  check(await player.evaluate(() => !game.modules.get('dicevision').api.getState().waiting), 'shared code: Player back to idle');

  for (const p of [page, player]) {
    await p.evaluate(() => game.settings.set('dicevision', 'mode', 'off'));
  }
  await page.waitForTimeout(300);
  check(errors(page).length === 0 && errors(player).length === 0,
    `no console errors ${[...errors(page), ...errors(player)].join('; ')}`);
} finally {
  for (const child of children) child.kill();
  await browser.close();
}
process.exitCode = failures ? 1 : 0;
