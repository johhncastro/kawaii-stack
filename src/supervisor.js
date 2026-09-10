// Core engine: Service (one supervised child) + Supervisor (the set of them).
//
// Service states:
//   stopped | building | starting | healthy | degraded | backoff | failed | stopping | external
//
// Hard rule: processes are only ever killed by tracked PID via treeKill —
// never by name, never a blanket node kill.

import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { httpProbe } from './health.js';
import { treeKill } from './treekill.js';
import { isStale, requiresExist, runBuild } from './build.js';
import { SvcLogger } from './logger.js';
import { lineSplit } from './protocol.js';

const RESTART_DEFAULTS = {
  backoffBaseMs: 1000,
  backoffMaxMs: 60000,
  maxConsecutive: 8,
  resetAfterHealthyMs: 600000,
};

export class Service extends EventEmitter {
  constructor(cfg, logDir) {
    super();
    this.cfg = cfg;
    this.restartCfg = { ...RESTART_DEFAULTS, ...(cfg.restart || {}) };
    this.log = new SvcLogger(cfg.id, logDir);
    this.state = 'stopped';
    this.child = null;
    this.pid = null;
    this.startedAt = null;
    this.restarts = 0;        // lifetime restart count (shown in UI)
    this.consecFails = 0;     // consecutive failures driving backoff
    this.probeFails = 0;
    this.lastExit = null;
    this.buildState = null;   // null | building | built | build-failed
    this.note = cfg.enabled === false ? 'disabled' : '';
    this.manualStop = cfg.enabled === false;
    this.generation = 0;      // invalidates stale exit handlers / probe loops
    this.timers = {};
  }

  status() {
    const c = this.cfg;
    return {
      id: c.id,
      name: c.name || c.id,
      type: c.type || 'web',
      port: c.port || null,
      state: this.state,
      pid: this.pid,
      startedAt: this.startedAt,
      restarts: this.restarts,
      lastExit: this.lastExit,
      buildState: this.buildState,
      note: this.note,
      enabled: c.enabled !== false,
      hasBuild: !!(c.build && c.build.mode !== 'none'),
    };
  }

  setState(state, note) {
    this.state = state;
    if (note !== undefined) this.note = note;
    this.emit('change');
  }

  // ---- public actions -------------------------------------------------

  async start({ force = false } = {}) {
    if (this.child || ['building', 'starting', 'stopping'].includes(this.state)) {
      return 'already ' + this.state;
    }
    this.manualStop = false;
    this._clearTimer('backoff');

    // Adopt-as-external: if something already answers on our port, don't spawn.
    const h = this.cfg.health || {};
    if (h.mode === 'http' && this.cfg.port) {
      if (await httpProbe(this.cfg.port, 1500)) {
        this.setState('external', `unmanaged process on port ${this.cfg.port} — stop it, then restart`);
        return 'external';
      }
    }

    const b = this.cfg.build;
    if (b && b.mode !== 'none' && (force || isStale(b))) {
      this.setState('building', 'building (stale sources)');
      const ok = await this._runBuild();
      if (!ok) {
        if (!requiresExist(b)) {
          this.setState('failed', 'build failed and no previous build exists');
          return 'build failed';
        }
        this.note = 'stale (build failed) — serving previous build';
        this.log.write('WARNING: starting previous build; sources are newer but the build failed');
      }
    }
    if (this.manualStop) { this.setState('stopped'); return 'stopped during build'; }
    this._spawn();
    return 'starting';
  }

  async stop() {
    this.manualStop = true;
    this._clearTimer('backoff');
    if (this.child) await this._kill();
    if (this.state !== 'failed') this.setState('stopped', '');
    return 'stopped';
  }

  async restart() {
    this._clearTimer('backoff');
    if (this.child) await this._kill();
    this.consecFails = 0;
    this.setState('stopped');
    return this.start();
  }

  // Manual build: builds; if the service was running, restart onto the new build.
  // If it was stopped, it stays stopped (buildState says what happened).
  async build() {
    const b = this.cfg.build;
    if (!b || b.mode === 'none') throw new Error(`no build configured for ${this.cfg.id}`);
    if (this.buildState === 'building') throw new Error('build already in progress');
    const wasRunning = !!this.child;
    if (!wasRunning) this.setState('building');
    const ok = await this._runBuild();
    if (!wasRunning && this.state === 'building') this.setState('stopped');
    if (ok && wasRunning) await this.restart();
    return ok;
  }

  // ---- internals ------------------------------------------------------

  async _runBuild() {
    this.buildState = 'building';
    this.emit('change');
    this.log.write('[build] running: ' + this.cfg.build.buildCmd);
    const res = await runBuild(this.cfg.build, line => this.log.write('[build] ' + line));
    if (res.ok) {
      this.buildState = 'built';
      this.log.write('[build] success');
    } else {
      this.buildState = 'build-failed';
      this.note = 'build failed — old build untouched';
      this.log.write(`[build] FAILED (exit ${res.code})`);
    }
    this.emit('change');
    return res.ok;
  }

  _spawn() {
    const cfg = this.cfg;
    const cmd = cfg.command === 'node' ? process.execPath : cfg.command;
    const gen = ++this.generation;
    let child;
    try {
      child = spawn(cmd, cfg.args || [], {
        cwd: cfg.cwd,
        env: { ...process.env, ...(cfg.env || {}) },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      this.log.write('spawn failed: ' + e.message);
      this._scheduleRestart();
      return;
    }
    this.child = child;
    this.pid = child.pid;
    this.startedAt = Date.now();
    this.probeFails = 0;
    this.setState('starting', '');
    this.log.write(`started pid ${child.pid}: ${cmd} ${(cfg.args || []).join(' ')}`);

    const rp = cfg.health && cfg.health.readyPattern ? new RegExp(cfg.health.readyPattern) : null;
    const onLine = line => {
      this.log.write(line);
      if (rp && gen === this.generation && this.state === 'starting' && rp.test(line)) {
        this._markHealthy(gen);
      }
    };
    lineSplit(child.stdout, onLine);
    lineSplit(child.stderr, onLine);
    child.on('error', e => this.log.write('child error: ' + e.message));
    child.on('exit', (code, signal) => {
      if (gen !== this.generation) return; // superseded by _kill/newer spawn
      this.child = null;
      this.pid = null;
      this.lastExit = code === null ? String(signal) : code;
      this._stopHealth();
      this.log.write(`process exited unexpectedly (code=${code}, signal=${signal})`);
      if (this.manualStop) { this.setState('stopped'); return; }
      this._scheduleRestart();
    });

    this._startReadiness(gen);
  }

  // Kill our child tree by PID. Bumps generation so the exit handler is inert.
  async _kill() {
    const pid = this.pid;
    this.generation++;
    this._stopHealth();
    this.setState('stopping');
    this.child = null;
    this.pid = null;
    if (pid) {
      const dead = await treeKill(pid);
      this.log.write(dead ? `killed pid ${pid} (tree)` : `WARNING: pid ${pid} did not die`);
    }
  }

  _startReadiness(gen) {
    const h = this.cfg.health || { mode: 'process' };
    if (h.mode === 'http') {
      const deadline = Date.now() + (h.startupTimeoutMs || 60000);
      const tick = async () => {
        if (gen !== this.generation || !this.child) return;
        if (await httpProbe(this.cfg.port, h.timeoutMs || 3000)) {
          if (gen === this.generation && this.state === 'starting') this._markHealthy(gen);
          return;
        }
        if (Date.now() > deadline) {
          this.log.write(`startup timeout after ${h.startupTimeoutMs || 60000}ms — killing and backing off`);
          await this._kill();
          this._scheduleRestart();
          return;
        }
        this.timers.ready = setTimeout(tick, 2000);
      };
      this.timers.ready = setTimeout(tick, 2000);
    } else {
      // process mode: readyPattern match marks healthy early; otherwise healthy
      // after surviving healthyAfterMs.
      this.timers.ready = setTimeout(() => {
        if (gen === this.generation && this.child && this.state === 'starting') this._markHealthy(gen);
      }, h.healthyAfterMs || 10000);
    }
  }

  _markHealthy(gen) {
    this._clearTimer('ready');
    this.setState('healthy', this.note.startsWith('stale') ? this.note : '');
    this.timers.healthyReset = setTimeout(() => { this.consecFails = 0; }, this.restartCfg.resetAfterHealthyMs);
    const h = this.cfg.health || {};
    if (h.mode === 'http') {
      this.timers.healthLoop = setInterval(async () => {
        if (gen !== this.generation || !this.child) return;
        const ok = await httpProbe(this.cfg.port, h.timeoutMs || 3000);
        if (gen !== this.generation) return;
        if (ok) {
          this.probeFails = 0;
          if (this.state === 'degraded') this.setState('healthy');
          return;
        }
        this.probeFails++;
        this.log.write(`health probe failed (${this.probeFails}/${h.failsBeforeRestart || 3})`);
        this.setState('degraded', 'health probes failing');
        if (this.probeFails >= (h.failsBeforeRestart || 3)) {
          this.log.write('unhealthy — restarting');
          await this._kill();
          this._scheduleRestart();
        }
      }, h.intervalMs || 10000);
    }
  }

  _scheduleRestart() {
    this._stopHealth();
    this.consecFails++;
    if (this.consecFails > this.restartCfg.maxConsecutive) {
      this.setState('failed', `gave up after ${this.restartCfg.maxConsecutive} restarts — press r to retry`);
      return;
    }
    const delay = Math.min(
      this.restartCfg.backoffBaseMs * 2 ** (this.consecFails - 1),
      this.restartCfg.backoffMaxMs,
    );
    this.restarts++;
    this.setState('backoff', `restarting in ${Math.round(delay / 1000)}s (attempt ${this.consecFails})`);
    this.timers.backoff = setTimeout(() => {
      if (!this.manualStop) this.start().catch(e => this.log.write('restart error: ' + e.message));
    }, delay);
  }

  _stopHealth() {
    this._clearTimer('ready');
    this._clearTimer('healthLoop');
    this._clearTimer('healthyReset');
  }

  _clearTimer(k) {
    if (this.timers[k]) {
      clearTimeout(this.timers[k]);
      clearInterval(this.timers[k]);
      delete this.timers[k];
    }
  }
}

export class Supervisor extends EventEmitter {
  constructor(configPath, logDir, { childrenPath = null } = {}) {
    super();
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!cfg || !Array.isArray(cfg.services) || cfg.services.length === 0) {
      throw new Error('services.json: missing or empty "services" array');
    }
    this.childrenPath = childrenPath;
    this.services = new Map();
    for (const s of cfg.services) {
      if (!s.id || !s.command || !s.cwd) throw new Error('services.json: entry missing id/command/cwd');
      if (this.services.has(s.id)) throw new Error('services.json: duplicate id ' + s.id);
      const svc = new Service(s, logDir);
      svc.on('change', () => { this._saveChildren(); this.emit('change', svc); });
      this.services.set(s.id, svc);
    }
  }

  // Persist {svcId: pid} so a restarted daemon can sweep orphans left by a
  // hard-killed predecessor (see daemon.js sweepOrphans).
  _saveChildren() {
    if (!this.childrenPath) return;
    const rec = {};
    for (const s of this.services.values()) if (s.pid) rec[s.cfg.id] = s.pid;
    try { fs.writeFileSync(this.childrenPath, JSON.stringify(rec)); } catch { /* informational */ }
  }

  list() { return [...this.services.values()]; }

  get(id) {
    const s = this.services.get(id);
    if (!s) throw new Error('unknown service: ' + id);
    return s;
  }

  async startAll() {
    await Promise.all(
      this.list()
        .filter(s => s.cfg.enabled !== false)
        .map(s => s.start().catch(e => s.log.write('start error: ' + e.message))),
    );
  }

  async shutdownAll() {
    const all = Promise.all(this.list().map(s => s.stop().catch(() => {})));
    await Promise.race([all, new Promise(r => setTimeout(r, 10000))]);
  }
}
