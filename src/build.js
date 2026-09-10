// Build-staleness detection and build execution (with post-build asset copies).

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { lineSplit } from './protocol.js';

const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.git']);

function newestMtime(p) {
  let st;
  try { st = fs.statSync(p); } catch { return 0; }
  if (st.isFile()) return st.mtimeMs;
  if (!st.isDirectory()) return 0;
  let newest = 0;
  let entries;
  try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
    newest = Math.max(newest, newestMtime(path.join(p, e.name)));
  }
  return newest;
}

export function requiresExist(b) {
  return (b.requires || []).every(r => fs.existsSync(path.join(b.projectDir, r)));
}

// Stale = required artifacts missing, marker missing, or any source newer than the marker.
export function isStale(b) {
  if (!requiresExist(b)) return true;
  const marker = path.join(b.projectDir, b.marker);
  let markerMt;
  try { markerMt = fs.statSync(marker).mtimeMs; } catch { return true; }
  let newest = 0;
  for (const sp of b.srcPaths || []) {
    newest = Math.max(newest, newestMtime(path.join(b.projectDir, sp)));
  }
  return newest > markerMt;
}

// Runs buildCmd via cmd.exe in projectDir; on success performs postBuildCopies.
// Resolves { ok, code }; never rejects. Output lines go to onLine.
export function runBuild(b, onLine) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn('cmd.exe', ['/d', '/s', '/c', b.buildCmd], {
        cwd: b.projectDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      onLine('build spawn failed: ' + e.message);
      resolve({ ok: false, code: -1 });
      return;
    }
    lineSplit(child.stdout, onLine);
    lineSplit(child.stderr, onLine);
    child.on('error', e => onLine('build process error: ' + e.message));
    child.on('exit', code => {
      if (code !== 0) { resolve({ ok: false, code }); return; }
      try {
        for (const [src, dst] of b.postBuildCopies || []) {
          fs.cpSync(path.join(b.projectDir, src), path.join(b.projectDir, dst), { recursive: true, force: true });
          onLine(`copied ${src} -> ${dst}`);
        }
      } catch (e) {
        onLine('post-build copy failed: ' + e.message);
        resolve({ ok: false, code: -2 });
        return;
      }
      resolve({ ok: true, code: 0 });
    });
  });
}
