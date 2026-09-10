// Health probes. Any HTTP response (even 404/500) means the server is up;
// only connect-refused / timeout counts as failure.

import http from 'node:http';

export function httpProbe(port, timeoutMs = 3000) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, res => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}
