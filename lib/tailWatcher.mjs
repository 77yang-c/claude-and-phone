import { EventEmitter } from 'node:events';
import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename } from 'node:path';

const MAX_CHUNK = 1024 * 1024; // 单文件单轮最多读 1MB
const MAX_PARTIAL = 1024 * 1024; // 半行缓冲上限，超限丢弃（防超大行卡死）

// 轮询 tail：每 tailIntervalMs 对比文件 size，增量读取新行并 emit。
// 只增量、不全量重放（历史由 /transcript 接口负责）。
export function createTailWatcher(cfg, transcript) {
  const em = new EventEmitter();
  const files = new Map(); // filePath -> {offset, partial}
  let timer = null;
  let stopped = false;

  function scanFiles() {
    let dirs = [];
    try { dirs = readdirSync(cfg.projectsDir); } catch { return; }
    for (const d of dirs) {
      const dp = join(cfg.projectsDir, d);
      let list = [];
      try { list = readdirSync(dp).filter(f => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of list) {
        const p = join(dp, f);
        if (files.has(p)) continue;
        let size = 0;
        try { size = statSync(p).size; } catch { continue; }
        files.set(p, { offset: size, partial: '' });
        em.emit('newFile', p);
      }
    }
  }

  function tick() {
    if (stopped) return;
    scanFiles();
    for (const [p, st] of [...files.entries()]) {
      let cur;
      try { cur = statSync(p); } catch { files.delete(p); continue; }
      if (cur.size < st.offset) { st.offset = 0; st.partial = ''; } // 截断/轮转
      if (cur.size === st.offset) continue;

      let consumed = 0;
      while (consumed < MAX_CHUNK) {
        const remaining = cur.size - st.offset;
        if (remaining <= 0) break;
        const want = Math.min(remaining, MAX_CHUNK - consumed);
        const chunk = readChunk(p, st.offset, want);
        if (chunk == null) break;
        consumed += chunk.length;
        st.offset += chunk.length;

        const lines = (st.partial + chunk).split('\n');
        st.partial = lines.pop() ?? '';
        if (st.partial.length > MAX_PARTIAL) st.partial = ''; // 超大行丢弃
        const out = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = transcript.parseLine(line);
          if (ev) out.push(ev);
        }
        if (out.length) {
          const sessionId = out.find(e => e.sessionId)?.sessionId ?? basename(p).replace(/\.jsonl$/, '');
          em.emit('lines', { file: p, sessionId, events: out });
        }
      }
    }
  }

  function readChunk(p, start, len) {
    let fd;
    try { fd = openSync(p, 'r'); } catch { return null; }
    try {
      const buf = Buffer.alloc(len);
      const n = readSync(fd, buf, 0, len, start);
      return buf.toString('utf8', 0, n);
    } catch {
      return null;
    } finally {
      closeSync(fd);
    }
  }

  return {
    start() {
      tick();
      timer = setInterval(tick, cfg.tailIntervalMs);
      timer.unref();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    on: em.on.bind(em),
  };
}
