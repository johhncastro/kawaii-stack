// Raw ANSI rendering helpers for the dashboard. No dependencies.

export const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  inverse: '\x1b[7m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

// Glyphs chosen to exist in the stock Windows console fonts (Consolas /
// Lucida Console). ● ◆ □ ★ are NOT in them and render as boxes.
export const STATE_STYLE = {
  healthy: { color: C.green, dot: '♥' },
  starting: { color: C.yellow, dot: '♥' },
  building: { color: C.yellow, dot: '♥' },
  degraded: { color: C.magenta, dot: '♥' },
  backoff: { color: C.magenta, dot: '♥' },
  stopping: { color: C.yellow, dot: '♥' },
  failed: { color: C.red, dot: '♥' },
  stopped: { color: C.gray, dot: '○' },
  external: { color: C.blue, dot: '►' },
};

export function enterScreen() {
  process.stdout.write('\x1b[?1049h\x1b[?25l'); // alt screen + hide cursor
}

export function exitScreen() {
  process.stdout.write('\x1b[?1049l\x1b[?25h'); // restore screen + cursor
}

export function drawFrame(lines) {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const out = ['\x1b[H']; // home; we overwrite every cell we use
  for (let i = 0; i < rows; i++) {
    out.push('\x1b[2K'); // clear line
    if (i < lines.length) out.push(truncate(lines[i], cols));
    if (i < rows - 1) out.push('\n');
  }
  process.stdout.write(out.join(''));
}

// Truncate by *visible* width (ignores ANSI escapes when counting).
export function truncate(line, width) {
  let visible = 0;
  let i = 0;
  let out = '';
  while (i < line.length) {
    if (line[i] === '\x1b') {
      const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(line.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    if (visible >= width) break;
    out += line[i];
    visible++;
    i++;
  }
  return out + C.reset;
}

export function fmtUptime(startedAt) {
  if (!startedAt) return '-';
  let s = Math.floor((Date.now() - startedAt) / 1000);
  if (s < 0) s = 0;
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); s %= 60;
  if (d) return `${d}d${h}h`;
  if (h) return `${h}h${m}m`;
  if (m) return `${m}m${s}s`;
  return `${s}s`;
}

export function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}
