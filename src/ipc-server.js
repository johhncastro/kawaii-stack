// Named-pipe NDJSON server: request dispatch, snapshot heartbeat, log following.

import { writeMsg, makeLineParser } from './protocol.js';

export function attach(server, supervisor, { onShutdown }) {
  const subscribers = new Set();

  const snapshot = () => supervisor.list().map(s => s.status());
  const broadcast = obj => {
    for (const sock of subscribers) {
      // backpressure: skip slow clients rather than buffering unboundedly
      if (sock.writableLength < 1 << 20) writeMsg(sock, obj);
    }
  };

  supervisor.on('change', svc => broadcast({ ev: 'svc', service: svc.status() }));
  setInterval(() => broadcast({ ev: 'snapshot', services: snapshot() }), 2000);

  server.on('connection', sock => {
    sock.setEncoding('utf8');
    const follows = new Map(); // svcId -> line handler

    const parser = makeLineParser(async msg => {
      const { id, cmd, svc } = msg || {};
      const ok = data => writeMsg(sock, { id, ok: true, data: data || {} });
      const fail = e => writeMsg(sock, { id, ok: false, error: String((e && e.message) || e) });
      try {
        switch (cmd) {
          case 'status':
            ok({ services: snapshot() });
            break;
          case 'subscribe':
            subscribers.add(sock);
            ok({});
            writeMsg(sock, { ev: 'snapshot', services: snapshot() });
            break;
          case 'start':
            ok({ result: await supervisor.get(svc).start() });
            break;
          case 'stop':
            ok({ result: await supervisor.get(svc).stop() });
            break;
          case 'restart':
            ok({ result: await supervisor.get(svc).restart() });
            break;
          case 'build':
            ok({ built: await supervisor.get(svc).build() });
            break;
          case 'logs.tail':
            ok({ lines: supervisor.get(svc).log.tail(msg.lines || 200) });
            break;
          case 'logs.follow': {
            const s = supervisor.get(svc);
            if (!follows.has(svc)) {
              const h = line => {
                if (sock.writableLength < 256 * 1024) writeMsg(sock, { ev: 'log', svc, line });
              };
              follows.set(svc, h);
              s.log.on('line', h);
            }
            ok({});
            break;
          }
          case 'logs.unfollow': {
            const h = follows.get(svc);
            if (h) {
              try { supervisor.get(svc).log.off('line', h); } catch { /* ignore */ }
              follows.delete(svc);
            }
            ok({});
            break;
          }
          case 'shutdown-all':
            ok({});
            setImmediate(onShutdown);
            break;
          default:
            fail('unknown command: ' + cmd);
        }
      } catch (e) {
        fail(e);
      }
    });

    sock.on('data', parser);
    const cleanup = () => {
      subscribers.delete(sock);
      for (const [svcId, h] of follows) {
        try { supervisor.get(svcId).log.off('line', h); } catch { /* ignore */ }
      }
      follows.clear();
    };
    sock.on('close', cleanup);
    sock.on('error', () => {});
  });
}
