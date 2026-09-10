// kawaii-stack daemon: single instance (named-pipe lock), supervises all
// services, serves the IPC API. This is the Scheduled Task target.
//
// Usage: node daemon.js [path\to\services.json]   (config override is for tests)

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PIPE_PATH } from './protocol.js';
import { Supervisor } from './supervisor.js';
import { SvcLogger } from './logger.js';
import { attach } from './ipc-server.js';
import { isAlive, treeKill } from './treekill.js';
import { printBanner, setTitle, colorEnabled } from './banner.js';

setTitle();                                   // console window / Task Manager name
if (process.stdout.isTTY) printBanner(process.stdout, { color: colorEnabled() });

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logDir = path.join(root, 'logs');
const runDir = path.join(root, 'run');
fs.mkdirSync(logDir, { recursive: true });
fs.mkdirSync(runDir, { recursive: true });

const dlog = new SvcLogger('daemon', logDir);
const say = m => { dlog.write(m); try { console.log(m); } catch { /* no console */ } };

const configPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'services.json');

const childrenPath = path.join(runDir, 'children.json');

let supervisor;
try {
  supervisor = new Supervisor(configPath, logDir, { childrenPath });
} catch (e) {
  say('FATAL: failed to load ' + configPath + ': ' + e.message);
  if (e.code === 'ENOENT') say('hint: copy services.example.json to services.json and edit it for this machine');
  process.exit(1);
}

// ---- orphan sweep -----------------------------------------------------
// If a previous daemon was hard-killed (Task Scheduler "End", crash), its
// children survive. Kill exactly the PIDs the old daemon recorded — after
// confirming the PID still runs the same executable (guards PID reuse).

function queryProcess(pid) {
  return new Promise(resolve => {
    execFile('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" | Select-Object Name | ConvertTo-Json`],
    { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      if (err || !stdout || !stdout.trim()) { resolve(null); return; }
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

async function sweepOrphans() {
  let rec;
  try { rec = JSON.parse(fs.readFileSync(childrenPath, 'utf8')); } catch { return; }
  for (const [svcId, pid] of Object.entries(rec)) {
    if (!pid || !isAlive(pid)) continue;
    let svc;
    try { svc = supervisor.get(svcId); } catch { continue; }
    const expectExe = path.basename(svc.cfg.command === 'node' ? process.execPath : svc.cfg.command).toLowerCase();
    const info = await queryProcess(pid);
    if (!info || String(info.Name || '').toLowerCase() !== expectExe) continue;
    say(`orphan sweep: killing leftover ${svcId} child from a previous daemon (pid ${pid})`);
    await treeKill(pid);
  }
  try { fs.unlinkSync(childrenPath); } catch { /* fine */ }
}

let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  say('shutting down: ' + reason);
  try { await supervisor.shutdownAll(); } catch { /* best effort */ }
  say('all services stopped — daemon exiting');
  process.exit(0);
}

const server = net.createServer();
server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    say('daemon already running (pipe in use) — exiting');
    process.exit(2);
  }
  say('FATAL pipe error: ' + e.message);
  process.exit(1);
});
server.listen(PIPE_PATH, () => {
  say(`kawaii-stack daemon started (pid ${process.pid}, config ${configPath})`);
  try { fs.writeFileSync(path.join(runDir, 'daemon.pid'), String(process.pid)); } catch { /* informational */ }
  attach(server, supervisor, { onShutdown: () => shutdown('shutdown-all via IPC') });
  sweepOrphans()
    .catch(e => say('orphan sweep error: ' + e.message))
    .then(() => supervisor.startAll())
    .then(() => say('startAll complete'));
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', e => { say('uncaughtException: ' + ((e && e.stack) || e)); shutdown('uncaughtException'); });
process.on('unhandledRejection', e => say('unhandledRejection: ' + ((e && e.stack) || e)));
