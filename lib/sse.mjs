// SSE 广播中心：channel 级环形缓冲 + Last-Event-ID 重放 + 心跳。
const MAX_RING_BYTES = 256 * 1024;
const HEARTBEAT_MS = 15000;

export function createSseHub() {
  const channels = new Map(); // channel -> {ring, bytes, clients:Set}
  const clients = new Set();
  let nextId = 1;

  function getChannel(name) {
    let ch = channels.get(name);
    if (!ch) {
      ch = { ring: [], bytes: 0, clients: new Set() };
      channels.set(name, ch);
    }
    return ch;
  }

  function subscribe(req, res, channel) {
    const ch = getChannel(channel);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const client = { req, res, closed: false };

    // Last-Event-ID 重放
    const lastId = Number(req.headers['last-event-id'] || 0);
    if (lastId > 0) {
      const ring = ch.ring;
      if (ring.length && ring[0].id > lastId + 1) {
        // 环形缓冲已被挤出，客户端需全量刷新
        const e = { id: nextId++, event: 'reset', data: {} };
        ch.ring.push(e);
        write(client, e);
      } else {
        for (const e of ring) if (e.id > lastId) write(client, e);
      }
    }

    ch.clients.add(client);
    clients.add(client);
    req.on('close', () => {
      client.closed = true;
      ch.clients.delete(client);
      clients.delete(client);
    });
  }

  function write(client, e) {
    if (client.closed) return;
    client.res.write(`id: ${e.id}\nevent: ${e.event}\ndata: ${JSON.stringify(e.data ?? {})}\n\n`);
  }

  function publish(channel, event, data) {
    const ch = channels.get(channel);
    if (!ch || !ch.clients.size) return; // 无人订阅则跳过（但 ring 仍需推进? 见下）
    const e = { id: nextId++, event, data };
    ch.ring.push(e);
    ch.bytes += estimate(e);
    while (ch.bytes > MAX_RING_BYTES && ch.ring.length > 1) {
      ch.bytes -= estimate(ch.ring.shift());
    }
    for (const c of ch.clients) write(c, e);
  }

  function estimate(e) {
    return e.event.length + JSON.stringify(e.data ?? {}).length + 16;
  }

  const hb = setInterval(() => {
    for (const c of clients) {
      if (!c.closed) {
        try { c.res.write(':hb\n\n'); } catch { c.closed = true; }
      }
    }
  }, HEARTBEAT_MS);
  hb.unref();

  function closeAll() {
    for (const c of clients) {
      try { c.res.end(); } catch {}
    }
    clients.clear();
    channels.clear();
  }

  return { subscribe, publish, closeAll };
}
