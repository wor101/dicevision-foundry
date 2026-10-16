#!/usr/bin/env node
// End-to-end check of Dice So Nice! support against a real Foundry with
// Dice So Nice installed, the live bridge, and scripts-dev/fake-dashboard.mjs
// standing in for the camera.
//
//   node scripts-dev/e2e/dsn.mjs SESSION_CODE
//
// Needs Dice So Nice in Data/modules (it's enabled in the world if it isn't
// already, and left enabled). Joins as FOUNDRY_USER (default Gamemaster);
// the GM seat is needed to change world settings. Use a session code nobody
// is rolling real dice on, and keep the real dashboard closed on it.
//
// Records Dice So Nice's own animate decision for each message (its
// diceSoNiceMessagePreProcess hook), so it doesn't depend on WebGL drawing
// anything in a headless browser.

import { launchBrowser, ensureWorld, joinAs, errors } from './foundry.mjs';
import { startDashboard, killDashboards } from './dashboard.mjs';

const code = process.argv[2];
if (!code) {
  console.error('usage: dsn.mjs SESSION_CODE');
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

  // Enable Dice So Nice in the world (a reload applies it)
  const enabled = await page.evaluate(async () => {
    if (game.modules.get('dice-so-nice')?.active) return true;
    if (!game.modules.get('dice-so-nice')) return null;
    const config = game.settings.get('core', 'moduleConfiguration');
    await game.settings.set('core', 'moduleConfiguration', { ...config, 'dice-so-nice': true });
    return false;
  });
  if (enabled === null) throw new Error('Dice So Nice is not installed in Data/modules');
  if (!enabled) {
    await page.reload();
    await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 60000 });
  }
  await page.waitForFunction(() => !!game.dice3d, null, { timeout: 30000 })
    .catch(() => {});
  check(await page.evaluate(() => !!game.dice3d), 'Dice So Nice started (game.dice3d)');

  await page.evaluate(async (code) => {
    // Dice So Nice's decision per message id
    globalThis.__dsn = {};
    Hooks.on('diceSoNiceMessagePreProcess', (id, interception) => { globalThis.__dsn[id] = interception.willTrigger3DRoll; });
    await game.settings.set('dice-so-nice', 'disabledForManualRolls', true);
    await game.settings.set('dice-so-nice', 'interactiveThrows', '1');
    await game.settings.set('dicevision', 'diceSoNice', true);
    await game.settings.set('dicevision', 'continuous', false);
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
  const mark = () => page.evaluate(() => { globalThis.__dvCount = game.messages.size; });

  /**
   * The next new roll message: its saved rolls, Dice So Nice's decision
   * (undefined: it never considered animating), and the rendered tooltip.
   */
  const nextRollMessage = async () => {
    const id = await page.waitForFunction(() => {
      const message = game.messages.contents.slice(globalThis.__dvCount).find(m => m.rolls?.length);
      return message?.id ?? null;
    }, null, { timeout: 20000 }).then(h => h.jsonValue());
    await page.waitForTimeout(1500);
    return page.evaluate(async (id) => {
      const message = game.messages.get(id);
      const html = await message.renderHTML();
      const dice = message.rolls.flatMap(r => r.dice);
      return {
        formula: message.rolls[0].formula,
        total: message.rolls[0].total,
        methods: dice.map(d => d.method ?? null),
        physical: dice.map(d => d.options?.dicevision?.physical ?? 0),
        animate: globalThis.__dsn[id],
        icons: html.querySelectorAll('.dice-tooltip .part-method').length,
        flags: message.flags['dice-so-nice'] ?? null,
        whisper: message.whisper.length,
        flavor: message.flavor
      };
    }, id);
  };

  // Replace: the roll animates even with "Disabled for manually entered rolls" on
  let dash = dashboard(['--max', '1', '--dice', 'd6=5,d20=4,d20=17', '--watch', '3']);
  await dash.until('connected');
  await chatCommand('/roll 2d20kh + 1d6 + 3');
  let msg = await nextRollMessage();
  await dash.exited();
  check(msg.total === 25, `replace: physical dice fill the roll (${msg.formula} = ${msg.total})`);
  check(msg.methods.every(m => m === null), `replace: no DiceVision method saved ${JSON.stringify(msg.methods)}`);
  check(JSON.stringify(msg.physical) === '[2,1]', `replace: dice marked physical ${JSON.stringify(msg.physical)}`);
  check(msg.animate === true, `replace: Dice So Nice animates (${msg.animate})`);
  check(msg.icons === 2, `replace: camera icon on both tooltip parts (${msg.icons})`);

  // Interactive throws on: physical dice aren't handed back for a mouse throw
  await page.evaluate(() => game.settings.set('dice-so-nice', 'interactiveThrows', '2'));
  dash = dashboard(['--max', '1', '--dice', 'd20=11', '--watch', '2']);
  await dash.until('connected');
  await chatCommand('/roll 1d20');
  msg = await nextRollMessage();
  await dash.exited();
  check(msg.flags?.interactive === false && msg.flags?.interactiveThrow?.state !== 'pending',
    `interactive throws on: not a pending throw ${JSON.stringify(msg.flags)}`);
  await page.evaluate(() => game.settings.set('dice-so-nice', 'interactiveThrows', '1'));

  // Chat mode: a standard roll card with a real roll
  await page.evaluate(() => game.settings.set('dicevision', 'mode', 'chat'));
  await page.waitForTimeout(300);
  dash = dashboard(['--max', '1', '--dice', 'd20=12,d6=3,d10=30,d10=7', '--watch', '2']);
  await dash.until('connected');
  await mark();
  await page.evaluate(() => game.modules.get('dicevision').api.requestRoll());
  msg = await nextRollMessage();
  await dash.exited();
  check(msg.formula === '1d20 + 1d6 + 1d100' && msg.total === 52, `chat: roll card ${msg.formula} = ${msg.total}`);
  check(msg.flavor === 'DiceVision', `chat: roll label as flavor (${msg.flavor})`);
  check(msg.animate === true, `chat: Dice So Nice animates (${msg.animate})`);
  check(msg.icons === 3, `chat: camera icons in the tooltip (${msg.icons})`);

  // Chat mode, GM Only: a private roll
  await page.evaluate(() => game.settings.set('dicevision', 'chatVisibility', 'gm'));
  dash = dashboard(['--max', '1', '--dice', 'd8=6', '--watch', '2']);
  await dash.until('connected');
  await mark();
  await page.evaluate(() => game.modules.get('dicevision').api.requestRoll());
  msg = await nextRollMessage();
  await dash.exited();
  check(msg.whisper > 0 && msg.animate === true, `chat GM only: whispered (${msg.whisper}) and animated (${msg.animate})`);
  await page.evaluate(() => game.settings.set('dicevision', 'chatVisibility', 'all'));

  // GM turns 3D dice off for DiceVision rolls
  await page.evaluate(() => game.settings.set('dicevision', 'diceSoNice', false));
  dash = dashboard(['--max', '1', '--dice', 'd20=9', '--watch', '2']);
  await dash.until('connected');
  await mark();
  await page.evaluate(() => game.modules.get('dicevision').api.requestRoll());
  msg = await nextRollMessage();
  await dash.exited();
  check(msg.flags?.skip === true && !msg.animate, `setting off, chat: skipped (${JSON.stringify(msg.flags)}, ${msg.animate})`);

  await page.evaluate(() => game.settings.set('dicevision', 'mode', 'replace'));
  await page.waitForTimeout(300);
  dash = dashboard(['--max', '1', '--dice', 'd20=14', '--watch', '2']);
  await dash.until('connected');
  await chatCommand('/roll 1d20');
  msg = await nextRollMessage();
  await dash.exited();
  check(msg.methods[0] === 'dicevision' && msg.animate === false,
    `setting off, replace: method kept, Dice So Nice's own manual-roll setting skips it (${msg.methods}, ${msg.animate})`);

  await page.evaluate(async () => {
    await game.settings.set('dicevision', 'diceSoNice', true);
    await game.settings.set('dicevision', 'mode', 'off');
  });
  await page.waitForTimeout(300);
  check(errors(page).length === 0, `no console errors ${errors(page).join('; ')}`);
} finally {
  killDashboards();
  await browser.close();
}
process.exitCode = failures ? 1 : 0;
