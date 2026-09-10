// Branding for kawaii-stack: terminal art, colours, window title.
// No dependencies. Everything degrades to plain text when stdout is not a
// TTY or NO_COLOR is set, so piping `stack status | findstr` stays clean.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const NAME = 'kawaii-stack';
export const PRODUCT = 'kawaii-stack daemon';
// Pure ASCII so it renders in any console font (fancy glyphs like ◕ show up as
// "?" in legacy conhost fonts).
export const FACE = '=^.^=';

// ---- the cat ------------------------------------------------------------
// 3-row ASCII cat. Frames cycle for the tail wag; eyes blink now and then.
export const CAT_WIDTH = 10;
const CAT_EARS = ' /\\_/\\';
const CAT_TAIL = ['~  ', ' ~ ', '  ~', ' ~ '];
const CAT_EYES = ['o.o', 'o.o', 'o.o', 'o.o', 'o.o', 'o.o', '-.-', 'o.o', 'o.o', 'o.o', 'o.o', 'o.o', 'o.o', '^.^', '^.^', 'o.o'];
export const CAT_FRAMES = CAT_EYES.length;

/** Plain 3-line cat for animation frame `n`, each line padded to CAT_WIDTH. */
export function catFrame(n = 0) {
  const eyes = CAT_EYES[((n % CAT_EYES.length) + CAT_EYES.length) % CAT_EYES.length];
  const tail = CAT_TAIL[((n % CAT_TAIL.length) + CAT_TAIL.length) % CAT_TAIL.length];
  return [CAT_EARS, `( ${eyes} )`, ` > ^ <${tail}`].map(l => l.padEnd(CAT_WIDTH));
}

/** Coloured cat: pink body, brighter eyes/nose. */
export function cat(n = 0, color = true) {
  const rows = catFrame(n);
  if (!color) return rows;
  return rows.map((row, i) => {
    let out = '';
    for (const ch of row) {
      if (ch === ' ') { out += ch; continue; }
      const hot = (i === 1 && 'o-^.'.includes(ch)) || (i === 2 && ch === '^');
      out += (hot ? `${fg(213)}${BOLD}` : fg(218)) + ch + RESET;
    }
    return out;
  });
}
export const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
})();
export const HOST = os.hostname();

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GRAY = '\x1b[90m';
const fg = n => `\x1b[38;5;${n}m`;

// Pastel "kawaii" ramp: pink → lavender → sky → mint (xterm-256 indices).
export const PALETTE = [218, 213, 177, 141, 111, 81, 86, 121];

export function colorEnabled(stream = process.stdout) {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return !!stream.isTTY;
}

// ---- fonts --------------------------------------------------------------

// "ANSI Shadow" style block letters. ╗╔╚╝═║ are the shadow, █ is the face.
const BIG_KAWAII = [
  '██╗  ██╗ █████╗ ██╗    ██╗ █████╗ ██╗██╗',
  '██║ ██╔╝██╔══██╗██║    ██║██╔══██╗██║██║',
  '█████╔╝ ███████║██║ █╗ ██║███████║██║██║',
  '██╔═██╗ ██╔══██║██║███╗██║██╔══██║██║██║',
  '██║  ██╗██║  ██║╚███╔███╔╝██║  ██║██║██║',
  '╚═╝  ╚═╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝╚═╝',
];
const BIG_STACK = [
  '███████╗████████╗ █████╗  ██████╗██╗  ██╗',
  '██╔════╝╚══██╔══╝██╔══██╗██╔════╝██║ ██╔╝',
  '███████╗   ██║   ███████║██║     █████╔╝ ',
  '╚════██║   ██║   ██╔══██║██║     ██╔═██╗ ',
  '███████║   ██║   ██║  ██║╚██████╗██║  ██╗',
  '╚══════╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝',
];

// Two-row half-block font, used in the dashboard header.
const SMALL = [
  '█▄▀ ▄▀█ █ █ █ ▄▀█ █ █ ▄▄ ▄▀▀ ▀█▀ ▄▀█ ▄▀▀ █▄▀',
  '█ █ █▀█ ▀▄▀▄▀ █▀█ █ █    ▄██  █  █▀█ ▀▄▄ █ █',
];
export const SMALL_WIDTH = SMALL[0].length;

const SHADOW = new Set(['╗', '╔', '╚', '╝', '═', '║']);

// Paint one line with a horizontal gradient. `span` is the total width the
// gradient stretches over (so stacked words share one ramp), `offset` is
// where this line starts inside it.
function paint(line, { span = line.length, offset = 0, palette = PALETTE, shadow = true } = {}) {
  let out = '';
  let cur = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === ' ') { out += ch; continue; }
    let code;
    if (shadow && SHADOW.has(ch)) code = GRAY;
    else code = fg(palette[Math.min(palette.length - 1, Math.floor(((i + offset) / span) * palette.length))]);
    if (code !== cur) { out += code; cur = code; }
    out += ch;
  }
  return out + RESET;
}

// ---- public renderers ---------------------------------------------------

/** Compact two-line logo for the TUI. Returns [row1, row2] (already coloured). */
export function smallLogo(color = true) {
  if (!color) return SMALL.slice();
  return SMALL.map(l => paint(l, { shadow: false }));
}

/** Coloured mascot face. */
export function face(color = true) {
  return color ? `${fg(218)}${BOLD}${FACE}${RESET}` : FACE;
}

/** One-line brand, e.g. for `stack status` and the logs view header. */
export function brandLine(color = true) {
  if (!color) return `${FACE} ${PRODUCT} v${VERSION}`;
  return `${face(true)} ${fg(213)}${BOLD}kawaii${fg(141)}-${fg(111)}stack${RESET} ${DIM}daemon v${VERSION}${RESET}`;
}

/**
 * Full banner as an array of lines. Picks the big block-letter art when the
 * terminal is wide enough, otherwise the compact logo.
 */
export function bannerLines({ color = colorEnabled(), columns = process.stdout.columns || 80, tagline = true } = {}) {
  const lines = [];
  const indent = '  ';
  if (columns >= 56) {
    const shift = 7; // STACK sits under-right of KAWAII
    const span = shift + BIG_STACK[0].length;
    lines.push('');
    for (const l of BIG_KAWAII) lines.push(indent + (color ? paint(l, { span }) : l));
    for (const l of BIG_STACK) lines.push(indent + ' '.repeat(shift) + (color ? paint(l, { span, offset: shift }) : l));
  } else {
    lines.push('');
    for (const l of smallLogo(color)) lines.push(indent + l);
  }
  if (tagline) {
    lines.push('');
    const spaced = 'd a e m o n';
    const sub = 'supervisor for the cloudflare tunnel, web apps & bots';
    const meta = `v${VERSION} · ${HOST} · node ${process.version}`;
    const [c0, c1, c2] = cat(0, color);
    if (color) {
      lines.push(`${indent}${c0} ${fg(213)}${BOLD}${spaced}${RESET}   ${DIM}·  ${sub}${RESET}`);
      lines.push(`${indent}${c1} ${GRAY}${meta}${RESET}`);
      lines.push(`${indent}${c2}`);
    } else {
      lines.push(`${indent}${c0} ${spaced}   ·  ${sub}`);
      lines.push(`${indent}${c1} ${meta}`);
      lines.push(`${indent}${c2}`);
    }
    lines.push('');
  }
  return lines;
}

/** Print the banner to a stream (default stdout). Plain text when piped. */
export function printBanner(stream = process.stdout, opts = {}) {
  const color = opts.color ?? colorEnabled(stream);
  const columns = opts.columns ?? (stream.columns || 80);
  stream.write(bannerLines({ ...opts, color, columns }).join('\n') + '\n');
}

/**
 * Name the process + console window. On Windows `process.title` calls
 * SetConsoleTitle, which is what Task Manager and the title bar show.
 */
export function setTitle(suffix) {
  const t = suffix ? `${PRODUCT} · ${suffix}` : PRODUCT;
  try { process.title = t; } catch { /* not supported */ }
  if (process.stdout.isTTY) {
    try { process.stdout.write(`\x1b]0;${t}\x07`); } catch { /* ignore */ }
  }
}
