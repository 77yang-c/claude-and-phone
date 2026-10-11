import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// 扫描 ~/.claude/sessions/<pid>.json 检测"正在别处活跃"的会话（VS Code/终端）。
// 排除我们自己的子进程 pid。
export function createActivityTracker(cfg) {
  const map = new Map(); // sessionId -> {pid, status, entrypoint, updatedAt}
  let lastScan = 0;
  const myPids = new Set();

  function refresh() {
    if (Date.now() - lastScan < 2000) return;
    lastScan = Date.now();
    const next = new Map();
    let files = [];
    try { files = readdirSync(cfg.sessionsDir).filter(f => f.endsWith('.json')); } catch {}
    for (const f of files) {
      try {
        const o = JSON.parse(readFileSync(join(cfg.sessionsDir, f), 'utf8'));
        if (!o.sessionId || myPids.has(o.pid)) continue;
        try { process.kill(o.pid, 0); } catch { continue; } // pid 已死 = 残留元数据
        next.set(o.sessionId, { pid: o.pid, status: o.status ?? null, entrypoint: o.entrypoint ?? null, updatedAt: o.updatedAt ?? null });
      } catch {}
    }
    map.clear();
    for (const [k, v] of next) map.set(k, v);
  }

  return {
    refresh,
    getActive(sessionId) {
      refresh();
      return map.get(sessionId) ?? null;
    },
    registerOwnPid(pid) { myPids.add(pid); },
    unregisterOwnPid(pid) { myPids.delete(pid); },
  };
}
