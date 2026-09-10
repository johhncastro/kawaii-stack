// `stack` entry point.
//   stack                 open the TUI dashboard
//   stack status          one-shot status table
//   stack start|stop|restart|build <svc>
//   stack logs <svc> [-f]
//   stack daemon [config] run the supervisor in the foreground (Scheduled Task target)
//   stack shutdown        stop all services and exit the daemon

import net from 'node:net';
import { PIPE_PATH, writeMsg, makeLineParser } from './protocol.js';
import { printBanner, brandLine, colorEnabled, PRODUCT, VERSION } from './banner.js';

const [, , cmd, ...rest] = process.argv;

function connect() {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PIPE_PATH);
    sock.setEncoding('utf8');
    sock.once('connect', () => resolve(sock));
    sock.once('error', reject);
  });
}

function makeClient(sock) {
  let nextId = 1;
  const pending = new Map();
  const handlers = [];
  sock.on('data', makeLineParser(msg => {
    if (msg.id && pending.has(msg.id)) {
      const res = pending.get(msg.id);
      pending.delete(msg.id);
      res(msg);
    } else if (msg.ev) {
      for (const h of handlers) h(msg);
    }
  }));
  return {
    request(reqCmd, extra = {}, timeoutMs = 15000) {
      return new Promise(resolve => {
        const id = nextId++;
        pending.set(id, resolve);
        writeMsg(sock, { id, cmd: reqCmd, ...extra });
        if (timeoutMs) {
          const t = setTimeout(() => {
            if (pending.has(id)) {
              pending.delete(id);
              resolve({ ok: false, error: 'request timed out' });
            }
          }, timeoutMs);
          if (t.unref) t.unref();
        }
      });
    },
    onEvent(h) { handlers.push(h); },
  };
}

function fmtUptime(startedAt) {
  if (!startedAt) return '-';
  let s = Math.floor((Date.now() - startedAt) / 1000);
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); s %= 60;
  if (d) return `${d}d${h}h`;
  if (h) return `${h}h${m}m`;
  if (m) return `${m}m${s}s`;
  return `${s}s`;
}

function printTable(services) {
  const rows = services.map(s => [
    s.name, s.type, s.port ? String(s.port) : '-', s.state,
    ['starting', 'healthy', 'degraded', 'stopping'].includes(s.state) ? fmtUptime(s.startedAt) : '-',
    String(s.restarts), s.pid ? String(s.pid) : '-', s.note || '',
  ]);
  const head = ['NAME', 'TYPE', 'PORT', 'STATE', 'UPTIME', 'RS', 'PID', 'NOTE'];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const line = r => r.map((c, i) => c.padEnd(w[i])).join('  ');
  console.log(line(head));
  for (const r of rows) console.log(line(r));
}

function printHelp() {
  if (colorEnabled()) printBanner();
  else console.log(`${PRODUCT} v${VERSION}`);
  console.log(`kawaii-stack daemon — supervisor for the cloudflare tunnel, web apps & bots

usage:
  stack                     open the live dashboard (TUI)
  stack status              one-shot status table
  stack start <svc>         start a service
  stack stop <svc>          stop a service (no auto-restart until started again)
  stack restart <svc>       restart a service
  stack build <svc>         force rebuild (kawaii, popbot); restarts it if running
  stack logs <svc> [-f]     show last 200 log lines (-f to follow)
  stack shutdown            stop ALL services and exit the daemon
  stack daemon              run the supervisor in the foreground
  stack help                this text`);
}

function need(v) {
  if (!v) {
    console.error('missing <service> argument — see `stack status` for names (use the id column shown by `stack help`)');
    process.exit(1);
  }
  return v;
}

async function main() {
  if (!cmd) {
    const { runTui } = await import('./tui/index.js');
    return runTui();
  }
  if (cmd === 'daemon') { await import('./daemon.js'); return; }
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { printHelp(); return; }

  let sock;
  try {
    sock = await connect();
  } catch {
    console.error(PRODUCT + ' is not running — start it with `stack daemon`, or via the KawaiiStack scheduled task (it starts automatically at boot)');
    process.exit(1);
  }
  const client = makeClient(sock);
  let keepOpen = false;

  switch (cmd) {
    case 'status': {
      const r = await client.request('status');
      if (!r.ok) { console.error('error: ' + r.error); process.exit(1); }
      if (colorEnabled()) console.log(brandLine(true) + '\n');
      printTable(r.data.services);
      break;
    }
    case 'start':
    case 'stop':
    case 'restart': {
      const svc = need(rest[0]);
      const r = await client.request(cmd, { svc }, 120000);
      if (!r.ok) { console.error('error: ' + r.error); process.exit(1); }
      console.log(`${cmd} ${svc}: ${r.data.result || 'ok'}`);
      break;
    }
    case 'build': {
      const svc = need(rest[0]);
      console.log(`building ${svc}... (this can take a few minutes)`);
      const r = await client.request('build', { svc }, 30 * 60 * 1000);
      if (!r.ok) { console.error('error: ' + r.error); process.exit(1); }
      console.log(r.data.built ? 'build ok' : `build FAILED — see \`stack logs ${svc}\``);
      if (!r.data.built) process.exitCode = 1;
      break;
    }
    case 'logs': {
      const svc = need(rest.filter(a => !a.startsWith('-'))[0]);
      const follow = rest.includes('-f') || rest.includes('--follow');
      const r = await client.request('logs.tail', { svc, lines: 200 });
      if (!r.ok) { console.error('error: ' + r.error); process.exit(1); }
      for (const l of r.data.lines) console.log(l);
      if (follow) {
        client.onEvent(m => { if (m.ev === 'log' && m.svc === svc) console.log(m.line); });
        await client.request('logs.follow', { svc });
        keepOpen = true; // stay attached until Ctrl+C
      }
      break;
    }
    case 'shutdown': {
      const r = await client.request('shutdown-all', {}, 30000);
      console.log(r.ok ? `${PRODUCT} shutting down (all services stopping)` : 'error: ' + r.error);
      break;
    }
    default:
      console.error('unknown command: ' + cmd);
      printHelp();
      process.exitCode = 1;
  }
  if (!keepOpen) sock.end();
}

main().catch(e => { console.error('error: ' + e.message); process.exit(1); });
