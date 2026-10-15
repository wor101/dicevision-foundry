#!/usr/bin/env node
// End-to-end check of Replace mode (Foundry's rolls filled with physical
// dice) against a real Foundry and the live bridge, with
// scripts-dev/fake-dashboard.mjs standing in for the camera.
//
//   node scripts-dev/e2e/replace.mjs SESSION_CODE
//
// Joins as FOUNDRY_USER (default Gamemaster; use Player if someone is
// already logged in as the GM).
//
// Use a session code nobody is rolling real dice on, and keep the real
// dashboard closed on it.

import { launchBrowser, ensureWorld, joinAs, errors } from './foundry.mjs';
import { startDashboard, killDashboards } from './dashboard.mjs';

const code = process.argv[2];
if (!code) {
  console.error('usage: replace.mjs SESSION_CODE');
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
  const page = await joinAs(browser, process.env.FOUNDRY_USER ?? 'Gamemaster');
  await page.evaluate(async (code) => {
    await game.settings.set('dicevision', 'sessionCode', code);
    await game.settings.set('dicevision', 'mode', 'replace');
  }, code);
  await page.waitForFunction(() => game.modules.get('dicevision').api.isConnected(), null, { timeout: 15000 });
  await page.waitForTimeout(500);

  /** Start a chat command without waiting for it: /roll blocks until the dice arrive. */
  const chatCommand = line => page.evaluate((line) => {
    globalThis.__dvCount = game.messages.size;
    ui.chat.processMessage(line).catch(err => console.error('chat command failed', err));
  }, line);

  /** The next new chat message's roll: { formula, total, dice: [[denomination, ...results]] }. */
  const nextRoll = () => page.waitForFunction(() => {
    const message = game.messages.contents.slice(globalThis.__dvCount).find(m => m.rolls?.length);
    if (!message) return null;
    const roll = message.rolls[0];
    return {
      formula: roll.formula,
      total: roll.total,
      dice: roll.dice.map(d => [d.denomination, ...d.results.map(r => r.result)])
    };
  }, null, { timeout: 20000 }).then(h => h.jsonValue());

  const resolverOpen = () => page.waitForSelector('.roll-resolver', { timeout: 10000 });

  // All dice in one physical roll, in any order
  let dash = dashboard(['--max', '1', '--dice', 'd6=5,d20=4,d20=17', '--watch', '3']);
  await dash.until('connected');
  await chatCommand('/roll 2d20kh + 1d6 + 3');
  let roll = await nextRoll();
  await dash.exited();
  check(roll.total === 25, `2d20kh+1d6+3 with 17, 4, 5 totals 25 (got ${roll.total}, ${JSON.stringify(roll.dice)})`);
  const sorted = roll.dice.map(([d, ...results]) => [d, ...results.sort((a, b) => b - a)]);
  check(JSON.stringify(sorted) === '[["d20",17,4],["d6",5]]', `dice placed by type ${JSON.stringify(roll.dice)}`);
  check(dash.done()?.requests_after_last_roll === 0 && dash.count('cancelled') === 1, 'bridge released after the roll');

  // Partial: fill the d20, keep waiting for the d6
  dash = dashboard(['--max', '2', '--dice', 'd20=12;d6=2', '--watch', '3']);
  await dash.until('connected');
  await chatCommand('/roll 1d20 + 1d6');
  roll = await nextRoll();
  await dash.exited();
  check(roll.total === 14 && dash.count('roll_sent') === 2, `partial roll waits for the rest (total ${roll.total}, rolls ${dash.count('roll_sent')})`);

  // Wrong dice: warn and keep waiting
  dash = dashboard(['--max', '2', '--dice', 'd8=7;d20=9', '--delay', '1500', '--watch', '3']);
  await dash.until('connected');
  await chatCommand('/roll 1d20');
  await resolverOpen();
  const notice = await page.waitForSelector('.dicevision-status-notice', { timeout: 10000 }).then(h => h.textContent());
  check(notice.includes('d8 (7)'), `dialog names the unused die: "${notice}"`);
  roll = await nextRoll();
  await dash.exited();
  check(roll.total === 9, `the right die fills it afterwards (${roll.total})`);

  // Exploding dice ask for another die
  dash = dashboard(['--max', '2', '--dice', 'd6=6;d6=2', '--watch', '3']);
  await dash.until('connected');
  await chatCommand('/roll 1d6x');
  roll = await nextRoll();
  await dash.exited();
  check(roll.total === 8 && JSON.stringify(roll.dice) === '[["d6",6,2]]', `1d6x explodes into a second physical die ${JSON.stringify(roll.dice)}`);
  check(dash.done()?.requests_after_last_roll === 0, 'released after the explosion is filled');

  // Percentile pair
  dash = dashboard(['--max', '1', '--dice', 'd10=7,d10=30', '--watch', '2']);
  await dash.until('connected');
  await chatCommand('/roll 1d100');
  roll = await nextRoll();
  await dash.exited();
  check(roll.total === 37, `d10 30 + d10 7 fills a d100 with 37 (${roll.total})`);

  // dnd5e advantage roll through the system's own roll class
  const hasD20Roll = await page.evaluate(() => !!CONFIG.Dice.D20Roll);
  if (hasD20Roll) {
    dash = dashboard(['--max', '1', '--dice', 'd20=3,d20=16', '--watch', '2']);
    await dash.until('connected');
    await page.evaluate(() => {
      globalThis.__dvCount = game.messages.size;
      const { D20Roll } = CONFIG.Dice;
      new D20Roll('1d20 + 5', {}, { advantageMode: D20Roll.ADV_MODE.ADVANTAGE }).toMessage()
        .catch(err => console.error('D20Roll failed', err));
    });
    roll = await nextRoll();
    await dash.exited();
    // dnd5e 6 writes advantage as 2d20adv, older versions as 2d20kh
    const d20s = roll.dice.find(([d]) => d === 'd20')?.slice(1) ?? [];
    check(roll.total === 21 && d20s.length === 2, `dnd5e advantage roll keeps the higher die (${roll.formula} = ${roll.total})`);
  } else {
    check(false, 'CONFIG.Dice.D20Roll missing: is the world running dnd5e?');
  }

  // Submit rolls the rest digitally and releases the dashboard
  dash = dashboard(['--max', '1', '--dice', 'd20=20', '--delay', '60000']);
  await dash.until('connected');
  await chatCommand('/roll 1d20');
  await resolverOpen();
  await dash.until('waiting');
  await page.click('.roll-resolver button[type="submit"]');
  roll = await nextRoll();
  await dash.until('cancelled');
  check(roll.total >= 1 && roll.total <= 20 && dash.count('roll_sent') === 0, `Submit rolls digitally (${roll.total}) and cancels the request`);
  dash.kill();

  // Disconnected: rolls are digital, no dialog
  await page.evaluate(() => ui.chat.processMessage('/dv disconnect'));
  await page.waitForTimeout(500);
  await chatCommand('/roll 1d20');
  roll = await nextRoll();
  check(roll.total >= 1 && roll.total <= 20, 'disconnected: /roll rolls digitally');
  check(await page.evaluate(() => !document.querySelector('.roll-resolver')), 'disconnected: no roll dialog');

  await page.evaluate(() => game.settings.set('dicevision', 'mode', 'off'));
  await page.waitForTimeout(300);
  check(errors(page).length === 0, `no console errors ${errors(page).join('; ')}`);
} finally {
  killDashboards();
  await browser.close();
}
process.exitCode = failures ? 1 : 0;
