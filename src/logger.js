// Per-service rotating file logger + in-memory ring buffer + follower fanout.

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export class SvcLogger extends EventEmitter {
  // keep = number of rotated archives (x.log + x.log.1 + x.log.2)
  constructor(id, dir, { maxBytes = 5 * 1024 * 1024, keep = 2 } = {}) {
    super();
    this.setMaxListeners(50);
    this.file = path.join(dir, id + '.log');
    this.maxBytes = maxBytes;
    this.keep = keep;
    this.ring = [];
    this.ringMax = 400;
    fs.mkdirSync(dir, { recursive: true });
    try { this.size = fs.statSync(this.file).size; } catch { this.size = 0; }
  }

  write(line) {
    const out = `[${new Date().toISOString()}] ${line}`;
    this.ring.push(out);
    if (this.ring.length > this.ringMax) this.ring.shift();
    const data = out + '\n';
    try {
      if (this.size + data.length > this.maxBytes) this._rotate();
      fs.appendFileSync(this.file, data);
      this.size += Buffer.byteLength(data);
    } catch { /* keep running even if the disk write fails */ }
    this.emit('line', out);
  }

  _rotate() {
    try {
      for (let i = this.keep - 1; i >= 1; i--) {
        const from = `${this.file}.${i}`;
        if (fs.existsSync(from)) fs.renameSync(from, `${this.file}.${i + 1}`);
      }
      if (fs.existsSync(this.file)) fs.renameSync(this.file, this.file + '.1');
      this.size = 0;
    } catch { /* rename race: keep appending to the current file */ }
  }

  tail(n = 200) {
    try {
      const txt = fs.readFileSync(this.file, 'utf8');
      const lines = txt.split(/\r?\n/).filter(Boolean);
      if (lines.length >= n) return lines.slice(-n);
      return lines;
    } catch {
      return this.ring.slice(-n);
    }
  }
}
