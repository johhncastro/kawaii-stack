// Shared IPC constants and framing helpers (newline-delimited JSON over a named pipe).

export const PIPE_PATH = '\\\\.\\pipe\\kawaii-stack';

export function writeMsg(socket, obj) {
  try { socket.write(JSON.stringify(obj) + '\n'); } catch { /* socket gone */ }
}

// Returns a (chunk) => void handler that buffers partial lines and calls onMsg
// with each parsed JSON object. Malformed lines are silently dropped.
export function makeLineParser(onMsg) {
  let buf = '';
  return chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      onMsg(msg);
    }
  };
}

// Split a readable stream into lines (handles \r\n), calling onLine per line.
export function lineSplit(stream, onLine) {
  if (!stream) return;
  stream.setEncoding('utf8');
  let buf = '';
  stream.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  });
  stream.on('end', () => { if (buf.trim()) onLine(buf.trim()); });
}
