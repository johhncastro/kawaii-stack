// TUI-side IPC client: request/response with ids, event fanout, heartbeat
// watchdog (daemon snapshots every 2s; >5s of silence = daemon gone), and
// a 1s auto-reconnect loop.

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { PIPE_PATH, writeMsg, makeLineParser } from '../protocol.js';

export class IpcClient extends EventEmitter {
  constructor() {
    super();
    this.sock = null;
    this.nextId = 1;
    this.pending = new Map();
    this.connected = false;
    this.lastBeat = 0;
    this._reconnectTimer = null;
    this._beatTimer = null;
  }

  start() {
    this._connect();
    this._beatTimer = setInterval(() => {
      if (this.connected && Date.now() - this.lastBeat > 5000) this._drop();
    }, 1000);
  }

  stop() {
    clearInterval(this._beatTimer);
    clearTimeout(this._reconnectTimer);
    if (this.sock) { try { this.sock.destroy(); } catch { /* gone */ } }
  }

  _connect() {
    const sock = net.connect(PIPE_PATH);
    sock.setEncoding('utf8');
    this.sock = sock;
    sock.on('connect', () => {
      this.connected = true;
      this.lastBeat = Date.now();
      this.emit('online');
      this.request('subscribe').catch(() => {});
    });
    sock.on('data', makeLineParser(msg => {
      if (msg.ev === 'snapshot') this.lastBeat = Date.now();
      if (msg.id && this.pending.has(msg.id)) {
        const res = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        res(msg);
      } else if (msg.ev) {
        this.emit(msg.ev, msg);
      }
    }));
    sock.on('error', () => {});
    sock.on('close', () => this._drop());
  }

  _drop() {
    if (this.sock) { try { this.sock.destroy(); } catch { /* gone */ } this.sock = null; }
    for (const res of this.pending.values()) res({ ok: false, error: 'disconnected' });
    this.pending.clear();
    if (this.connected) {
      this.connected = false;
      this.emit('offline');
    }
    if (!this._reconnectTimer) {
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        this._connect();
      }, 1000);
    }
  }

  request(cmd, extra = {}, timeoutMs = 120000) {
    return new Promise(resolve => {
      if (!this.sock) { resolve({ ok: false, error: 'not connected' }); return; }
      const id = this.nextId++;
      this.pending.set(id, resolve);
      writeMsg(this.sock, { id, cmd, ...extra });
      if (timeoutMs) {
        const t = setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            resolve({ ok: false, error: 'request timed out' });
          }
        }, timeoutMs);
        if (t.unref) t.unref();
      }
    });
  }
}
