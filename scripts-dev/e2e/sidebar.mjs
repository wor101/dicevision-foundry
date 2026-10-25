#!/usr/bin/env node
// End-to-end check of the DiceVision sidebar tab (Foundry v13+) against a
// real Foundry and the live bridge, with scripts-dev/fake-dashboard.mjs
// standing in for the camera.
//
//   node scripts-dev/e2e/sidebar.mjs SESSION_CODE
//
// Joins as FOUNDRY_USER (default Gamemaster). Use a session code nobody is
// rolling real dice on, and keep the real dashboard closed on it.

import { launchBrowser, ensureWorld, joinAs, errors } from './foundry.mjs';
import { startDashboard, killDashboards } from './dashboard.mjs';

const code = process.argv[2];
if (!code) {
  console.error('usage: sidebar.mjs SESSION_CODE');
  process.exit(2);
}
let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!cond) failures++;
};

const TAB = '#sidebar-tabs [data-tab="dicevision"]';
const PANEL = '#dicevision.sidebar-tab';
const dashed = `${code.replace(/-/g, '').toUpperCase().slice(0, 4)}-${code.replace(/-/g, '').toUpperCase().slice(4)}`;

const browser = await launchBrowser();
try {
  await ensureWorld(browser);
  const page = await joinAs(browser, process.env.FOUNDRY_USER ?? 'Gamemaster');
  const api = () => page.evaluate(() => game.modules.get('dicevision').api.getState());
  const status = () => page.$eval(`${PANEL} .dicevision-panel-status`, el => ({ css: el.dataset.dvStatus, text: el.textContent.trim() }));

  await page.evaluate(async () => {
    await game.settings.set('dicevision', 'continuous', false);
    await game.settings.set('dicevision', 'mode', 'chat');
    await game.settings.set('dicevision', 'sessionCode', '');
    game.modules.get('dicevision').api.disconnect();
  });
  const start = await page.evaluate(() => game.messages.size);
  const newMessages = () => page.evaluate(n => game.messages.contents.slice(n).length, start);

  // The tab sits before Settings and opens the connect form
  check(await page.$(TAB) !== null, 'camera tab in the sidebar');
  check(await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('#sidebar-tabs [data-tab]')].map(b => b.dataset.tab);
    return tabs.indexOf('dicevision') === tabs.indexOf('settings') - 1;
  }), 'tab is just before Settings');
  await page.click(TAB);
  await page.waitForSelector(`${PANEL}.active form.dicevision-panel-connect`, { timeout: 5000 });
  check((await status()).css === 'disconnected', 'disconnected: status line and connect form');
  check(await page.$(`${PANEL} form.dicevision-panel-settings`) === null, 'disconnected: no settings shown');

  // A malformed code is refused without touching the setting
  await page.fill(`${PANEL} input[name="sessionCode"]`, 'nope');
  await page.click(`${PANEL} [data-dv="connect"]`);
  await page.waitForTimeout(300);
  check(!(await api()).sessionActive && await page.evaluate(() => game.settings.get('dicevision', 'sessionCode')) === '',
    'malformed code: nothing saved or opened');
  check(await page.$(`${PANEL} input.dicevision-invalid`) !== null, 'malformed code: field marked invalid');

  // Connect, and the panel switches to status + settings
  await page.fill(`${PANEL} input[name="sessionCode"]`, code.toLowerCase());
  await page.press(`${PANEL} input[name="sessionCode"]`, 'Enter');
  await page.waitForFunction(() => game.modules.get('dicevision').api.isConnected(), null, { timeout: 15000 });
  await page.waitForSelector(`${PANEL} form.dicevision-panel-settings`, { timeout: 5000 });
  const connected = await status();
  check(connected.css === 'connected' && connected.text.includes(dashed), `connected: status "${connected.text}"`);
  check((await page.evaluate(() => game.settings.get('dicevision', 'sessionCode'))).toLowerCase() === code.toLowerCase(), 'session code saved');
  check(await page.$eval(TAB, el => el.classList.contains('dicevision-connected')), 'tab icon tinted while connected');

  // Settings save through game.settings (mode has an onChange hook, rollLabel doesn't)
  await page.selectOption(`${PANEL} select[name="mode"]`, 'replace');
  await page.waitForFunction(() => game.settings.get('dicevision', 'mode') === 'replace', null, { timeout: 5000 });
  check(true, 'mode select saves the setting');
  await page.selectOption(`${PANEL} select[name="mode"]`, 'chat');
  await page.waitForFunction(() => game.settings.get('dicevision', 'mode') === 'chat', null, { timeout: 5000 });
  await page.fill(`${PANEL} input[name="rollLabel"]`, 'Panel test');
  await page.press(`${PANEL} input[name="rollLabel"]`, 'Tab');
  await page.waitForFunction(() => game.settings.get('dicevision', 'rollLabel') === 'Panel test', null, { timeout: 5000 });
  check(true, 'roll label saves the setting');
  await page.evaluate(() => game.settings.set('dicevision', 'rollLabel', 'DiceVision'));

  // Roll button: one roll posted, the pip lights while waiting, bridge released
  let dash = startDashboard(code, ['--max', '1', '--dice', '1d20', '--watch', '3', '--delay', '1500']);
  await dash.until('connected');
  await page.click(`${PANEL} [data-dv="request"]`);
  await page.waitForSelector(`${PANEL} [data-dv="request"].dicevision-waiting`, { timeout: 5000 });
  check(await page.$eval(TAB, el => el.parentElement.querySelector('.notification-pip').classList.contains('active')), 'tab pip lit while waiting');
  await dash.exited();
  check(dash.count('roll_sent') === 1 && (await newMessages()) === 1, 'Roll button: one roll posted to chat');
  check(dash.count('cancelled') === 1, 'Roll button: bridge released after the roll');
  check(await page.$(`${PANEL} [data-dv="request"].dicevision-waiting`) === null, 'Roll button no longer waiting');

  // Continuous toggle
  await page.click(`${PANEL} [data-dv="continuous"]`);
  await page.waitForFunction(() => game.settings.get('dicevision', 'continuous'), null, { timeout: 5000 });
  check(await page.$eval(`${PANEL} [data-dv="continuous"]`, el => el.getAttribute('aria-pressed') === 'true'), 'continuous button pressed');
  check(await page.$eval(`${PANEL} [data-dv="request"]`, el => el.disabled), 'Roll button disabled in continuous mode');
  await page.click(`${PANEL} [data-dv="continuous"]`);
  await page.waitForFunction(() => !game.settings.get('dicevision', 'continuous'), null, { timeout: 5000 });

  // Right-click pops the panel out as a window with the same content
  await page.click(TAB, { button: 'right' });
  await page.waitForSelector('#dicevision-popout form.dicevision-panel-settings', { timeout: 5000 });
  check(true, 'right-click opens the popout with settings');
  await page.evaluate(() => ui.sidebar.popouts.dicevision?.close());

  // Disconnect returns to the connect form, with the code kept in the field
  await page.click(`${PANEL} [data-dv="disconnect"]`);
  await page.waitForSelector(`${PANEL} form.dicevision-panel-connect`, { timeout: 5000 });
  check(!(await api()).sessionActive, 'Disconnect: session closed');
  check((await page.$eval(`${PANEL} input[name="sessionCode"]`, el => el.value)) === dashed, 'Disconnect: code kept in the field');
  check(!(await page.$eval(TAB, el => el.classList.contains('dicevision-connected'))), 'tab icon no longer tinted');

  const errs = errors(page);
  check(errs.length === 0, `no console errors${errs.length ? `:\n  ${errs.join('\n  ')}` : ''}`);
} finally {
  killDashboards();
  await browser.close();
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
