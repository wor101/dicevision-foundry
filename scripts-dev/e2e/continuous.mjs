#!/usr/bin/env node
// End-to-end check of chat mode against a real Foundry and the live bridge,
// with scripts-dev/fake-dashboard.mjs standing in for the camera.
//
//   node scripts-dev/e2e/continuous.mjs SESSION_CODE
//
// Use a session code nobody is rolling real dice on, and keep the real
// dashboard closed on it.

import { launchBrowser, ensureWorld, joinAs, errors, typeChat } from './foundry.mjs';
import { startDashboard, killDashboards } from './dashboard.mjs';

const code = process.argv[2];
if (!code) {
  console.error('usage: continuous.mjs SESSION_CODE');
  process.exit(2);
}
let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!cond) failures++;
};

const dashboard = args => startDashboard(code, args);

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

  // Chat commands, typed into the chat box (v14 passes hooks HTML). Typing
  // is slow: turn continuous off before the dashboard connects, or it
  // answers the continuous request first.
  await typeChat(page, '/dv continuous off');
  await page.waitForFunction(() => !game.settings.get('dicevision', 'continuous'), null, { timeout: 5000 });
  dash = dashboard(['--max', '1', '--dice', '1d8', '--watch', '3']);
  await dash.until('connected');
  await typeChat(page, '/dv roll');
  await dash.exited();
  check(dash.count('roll_sent') === 1 && dash.done()?.requests_after_last_roll === 0, '/dv roll (typed): one roll, no request after it');
  check(dash.count('cancelled') === 1, `/dv roll (typed): bridge released after the roll (cancelled x${dash.count('cancelled')})`);

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
  killDashboards();
  await browser.close();
}
process.exitCode = failures ? 1 : 0;
