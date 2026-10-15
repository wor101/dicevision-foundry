// Drive a local Foundry server with Playwright for end-to-end checks.
// See CLAUDE.md "Local end-to-end testing" for the setup these expect.
//
// Env:
//   FOUNDRY_URL             default http://localhost:30000
//   FOUNDRY_WORLD           default dicevision-test
//   FOUNDRY_ADMIN_USER      admin username (only needed to launch the world)
//   FOUNDRY_ADMIN_PASSWORD  admin password (only needed to launch the world)
//   PLAYWRIGHT_MODULE       path to playwright's index.mjs if `playwright`
//                           isn't resolvable from here

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

export const BASE = process.env.FOUNDRY_URL ?? 'http://localhost:30000';
export const WORLD = process.env.FOUNDRY_WORLD ?? 'dicevision-test';

export function launchBrowser() {
  return chromium.launch();
}

/** Make sure the test world is running, logging in as admin only if needed. */
export async function ensureWorld(browser) {
  const page = await browser.newPage();
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    if (/\/(join|game)$/.test(page.url())) return;
    if (page.url().endsWith('/auth')) {
      const { FOUNDRY_ADMIN_USER: user, FOUNDRY_ADMIN_PASSWORD: password } = process.env;
      if (!password) throw new Error('World not running: set FOUNDRY_ADMIN_USER and FOUNDRY_ADMIN_PASSWORD to launch it');
      await page.fill('#auth-username', user ?? '');
      await page.fill('#auth-password', password);
      await page.press('#auth-password', 'Enter');
      await page.waitForURL('**/setup');
    }
    const result = await page.evaluate(async (world) => {
      const r = await fetch('/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'launchWorld', world })
      });
      return r.json();
    }, WORLD);
    if (result.error) throw new Error(result.error);
  } finally {
    await page.close();
  }
}

/**
 * Join the running world as `user` in a fresh context (so client settings
 * start clean). Console output is collected in page.logs.
 */
export async function joinAs(browser, user = 'Gamemaster', password = '') {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  page.logs = [];
  page.on('console', m => page.logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => page.logs.push(`[pageerror] ${e.message}`));
  await page.goto(`${BASE}/join`, { waitUntil: 'networkidle' });
  await page.selectOption('#join-username', { label: user });
  await page.fill('#join-password', password);
  await page.press('#join-password', 'Enter');
  await page.waitForURL('**/game', { timeout: 30000 });
  await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 60000 });
  return page;
}

export function errors(page) {
  return page.logs.filter(l => /^\[(error|pageerror)\]/.test(l));
}
