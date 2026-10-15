// Run scripts-dev/fake-dashboard.mjs as a child process and follow its events.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DASHBOARD = fileURLToPath(new URL('../fake-dashboard.mjs', import.meta.url));
const children = new Set();

/**
 * Start a fake dashboard on `code` with fake-dashboard.mjs `args`.
 * @returns {{exited, until, count, events, done}}
 *   exited(ms): resolves to the exit status; kills it and rejects after ms
 *   until(name, ms): resolves once an event of that name has been seen
 */
export function startDashboard(code, args) {
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
  return { exited, until, count, events, done, kill: () => proc.kill() };
}

/** Kill any fake dashboards still running. */
export function killDashboards() {
  for (const child of children) child.kill();
}
