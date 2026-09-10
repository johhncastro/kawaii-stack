// Kill a tracked child's whole process tree — by PID only, never by name.

import { spawn } from 'node:child_process';

export function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// taskkill exit 0 = killed, 128 = process already gone; both are success.
// Afterwards poll up to 5s to confirm the root PID is actually dead.
export function treeKill(pid) {
  return new Promise(resolve => {
    if (!pid || !isAlive(pid)) { resolve(true); return; }
    const p = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    p.on('error', () => resolve(!isAlive(pid)));
    p.on('exit', async () => {
      const deadline = Date.now() + 5000;
      while (isAlive(pid) && Date.now() < deadline) await sleep(100);
      resolve(!isAlive(pid));
    });
  });
}
