// The live dashboard. Modes: dashboard | logs | confirm.
// Quitting the TUI never touches the services — it only detaches.

import readline from 'node:readline';
import { IpcClient } from './ipc-client.js';
import { C, STATE_STYLE, enterScreen, exitScreen, drawFrame, fmtUptime, pad } from './render.js';
import { smallLogo, brandLine, cat, setTitle, SMALL_WIDTH, CAT_WIDTH, PRODUCT } from '../banner.js';

export function runTui() {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error('the dashboard needs an interactive terminal — try `stack status` instead');
    process.exit(1);
  }

  const client = new IpcClient();

  let services = [];        // latest ServiceStatus[]
  let sel = 0;
  let mode = 'dashboard';   // dashboard | logs | confirm
  let offline = true;
  let everConnected = false;
  let flash = '';
  let flashTimer = null;
  let logSvc = null;
  let logLines = [];
  const LOG_MAX = 2000;
  let confirm = null;       // { text, onYes }
  let startedTuiAt = Date.now();

  // ---- terminal lifecycle ----
  const restore = () => {
    try { exitScreen(); } catch { /* tty gone */ }
    try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch { /* ignore */ }
  };
  process.on('exit', restore);
  const quit = () => {
    client.stop();
    restore();
    process.exit(0);
  };

  enterScreen();
  setTitle('dashboard');
  process.stdout.on('resize', () => render());
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  // ---- ipc wiring ----
  client.on('online', () => {
    offline = false;
    everConnected = true;
    if (mode === 'logs' && logSvc) {
      client.request('logs.tail', { svc: logSvc, lines: 200 }).then(r => {
        if (r.ok && mode === 'logs') { logLines = r.data.lines; render(); }
      });
      client.request('logs.follow', { svc: logSvc });
    }
    render();
  });
  client.on('offline', () => { offline = true; render(); });
  client.on('snapshot', m => { services = m.services; clampSel(); render(); });
  client.on('svc', m => {
    const i = services.findIndex(s => s.id === m.service.id);
    if (i >= 0) services[i] = m.service; else services.push(m.service);
    render();
  });
  client.on('log', m => {
    if (mode === 'logs' && m.svc === logSvc) {
      logLines.push(m.line);
      if (logLines.length > LOG_MAX) logLines.splice(0, logLines.length - LOG_MAX);
      render();
    }
  });
  client.start();

  let catTick = 0;                 // animation frame for the header cat
  const uptimeTick = setInterval(() => { catTick++; if (mode === 'dashboard') render(); }, 500);
  if (uptimeTick.unref) uptimeTick.unref();

  function clampSel() {
    if (sel >= services.length) sel = Math.max(0, services.length - 1);
  }

  function setFlash(msg, ms = 4000) {
    flash = msg;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flash = ''; render(); }, ms);
    if (flashTimer.unref) flashTimer.unref();
    render();
  }

  // ---- actions ----
  function doAction(cmd, svc, label) {
    setFlash(`${label} ${svc}...`, 60000);
    client.request(cmd, { svc }, 30 * 60 * 1000).then(r => {
      setFlash(r.ok ? `${label} ${svc}: ok` : `${label} ${svc} failed: ${r.error}`);
    });
  }

  function openLogs(svc) {
    mode = 'logs';
    logSvc = svc;
    logLines = [];
    client.request('logs.tail', { svc, lines: 200 }).then(r => {
      if (r.ok && mode === 'logs' && logSvc === svc) { logLines = r.data.lines.concat(logLines); render(); }
    });
    client.request('logs.follow', { svc });
    render();
  }

  function closeLogs() {
    if (logSvc) client.request('logs.unfollow', { svc: logSvc });
    mode = 'dashboard';
    logSvc = null;
    logLines = [];
    render();
  }

  // ---- keys ----
  process.stdin.on('keypress', (str, key) => {
    if (!key) return;
    if (key.ctrl && key.name === 'c') return quit();

    if (mode === 'confirm') {
      if (key.name === 'y') { const c = confirm; confirm = null; mode = 'dashboard'; c.onYes(); }
      else if (key.name === 'n' || key.name === 'escape' || key.name === 'q') { confirm = null; mode = 'dashboard'; render(); }
      return;
    }

    if (mode === 'logs') {
      if (key.name === 'q' || key.name === 'escape') closeLogs();
      return;
    }

    // dashboard
    const svc = services[sel];
    switch (key.name) {
      case 'q': return quit();
      case 'up': case 'k': sel = Math.max(0, sel - 1); return render();
      case 'down': case 'j': sel = Math.min(services.length - 1, sel + 1); return render();
      case 'r':
        if (!svc) return;
        if (svc.type === 'tunnel' && ['healthy', 'starting'].includes(svc.state)) {
          mode = 'confirm';
          confirm = { text: `Restart ${svc.name}? The tunnel drops for a few seconds (all sites briefly unreachable). [y/n]`, onYes: () => doAction('restart', svc.id, 'restart') };
          return render();
        }
        return doAction('restart', svc.id, 'restart');
      case 's':
        if (!svc) return;
        if (['stopped', 'failed', 'external'].includes(svc.state)) return doAction('start', svc.id, 'start');
        mode = 'confirm';
        confirm = {
          text: svc.type === 'tunnel'
            ? `Stop ${svc.name}? ALL public sites behind this tunnel go offline. [y/n]`
            : `Stop ${svc.name}? It will stay stopped until started again. [y/n]`,
          onYes: () => doAction('stop', svc.id, 'stop'),
        };
        return render();
      case 'b':
        if (!svc) return;
        if (!svc.hasBuild) return setFlash(`${svc.name} has no build step`);
        return doAction('build', svc.id, 'build');
      case 'l':
        if (!svc) return;
        return openLogs(svc.id);
      default:
        return;
    }
  });

  // ---- rendering ----
  function render() {
    const cols = process.stdout.columns || 80;
    const lines = [];

    if (mode === 'logs') {
      const rows = process.stdout.rows || 24;
      const svc = services.find(s => s.id === logSvc);
      lines.push(` ${brandLine(true)} ${C.dim}logs: ${C.reset}${C.bold}${logSvc}${C.reset}${C.dim}  ${svc ? svc.state : ''}  (following live)${C.reset}`);
      const body = logLines.slice(-(rows - 2));
      for (const l of body) lines.push(' ' + l);
      while (lines.length < rows - 1) lines.push('');
      lines.push(`${C.inverse} [Esc/q] back to dashboard ${C.reset}`);
      drawFrame(lines);
      return;
    }

    const rows = process.stdout.rows || 24;
    const conn = offline
      ? `${C.red}${C.bold}${everConnected ? 'DAEMON OFFLINE — reconnecting...' : 'connecting to daemon...'}${C.reset}`
      : `${C.green}♥ daemon online${C.reset}${C.dim} · tui up ${fmtUptime(startedTuiAt)}${C.reset}`;
    // Big header: mascot + two-row logo, status on the right. Falls back to a
    // one-liner when the terminal is short or too narrow for the art.
    const roomy = rows >= services.length + 10 && cols >= SMALL_WIDTH + CAT_WIDTH + 24;
    if (roomy) {
      lines.push(''); // breathing room under the title bar
      const [l1, l2] = smallLogo(true);
      const [c0, c1, c2] = cat(catTick, true);
      lines.push(` ${c0} ${l1}   ${conn}`);
      lines.push(` ${c1} ${l2}   ${C.dim}${PRODUCT} · ${services.length} services${C.reset}`);
      lines.push(` ${c2} ${C.gray}${'─'.repeat(Math.max(0, cols - CAT_WIDTH - 3))}${C.reset}`);
    } else {
      lines.push(` ${brandLine(true)}  ${conn}`);
      lines.push('');
    }
    lines.push(`   ${C.dim}${pad('', 2)}${pad('NAME', 17)}${pad('TYPE', 8)}${pad('PORT', 7)}${pad('STATE', 11)}${pad('UPTIME', 9)}${pad('RS', 4)}NOTE${C.reset}`);

    if (offline && !everConnected) {
      lines.push('');
      lines.push(`   ${C.dim}no daemon — start it with \`stack daemon\` or via the KawaiiStack scheduled task${C.reset}`);
    }

    services.forEach((s, i) => {
      const st = STATE_STYLE[s.state] || { color: C.gray, dot: '?' };
      const cur = i === sel;
      const dot = `${st.color}${st.dot}${C.reset}`;
      const stateTxt = `${st.color}${pad(s.state, 11)}${C.reset}`;
      const up = ['healthy', 'starting', 'degraded'].includes(s.state) ? fmtUptime(s.startedAt) : '-';
      const note = s.buildState === 'building' ? 'building...' : (s.note || '');
      const row = `${pad(dot, 2 + st.color.length + C.reset.length)}${pad(s.name, 17)}${pad(s.type, 8)}${pad(s.port || '-', 7)}${stateTxt}${pad(up, 9)}${pad(s.restarts, 4)}${C.dim}${note}${C.reset}`;
      lines.push((cur ? `${C.bold} >${C.reset} ` : '   ') + row);
    });

    lines.push('');
    if (mode === 'confirm' && confirm) {
      lines.push(` ${C.yellow}${C.bold}${confirm.text}${C.reset}`);
    } else {
      lines.push(` ${C.inverse} ↑↓ select · [r]estart · [s]top/start · [b]uild · [l]ogs · [q] quit dashboard (services keep running) ${C.reset}`);
    }
    if (flash) lines.push(` ${C.cyan}${flash}${C.reset}`);
    drawFrame(lines);
  }

  render();
}
