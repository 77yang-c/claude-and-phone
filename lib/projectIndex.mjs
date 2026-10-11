import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CACHE_MS = 2000;

// 扫描 ~/.claude/projects/**/*.jsonl，构建项目/会话索引。
// 注意：目录名是路径的 '-' 转义（不可逆），真实项目路径取自 JSONL 行内的 cwd 字段。
export function createProjectIndex(cfg, transcript) {
  let cache = { at: 0, projects: [], bySessionId: new Map() };

  function refresh() {
    if (Date.now() - cache.at < CACHE_MS) return;
    const projects = [];
    const bySessionId = new Map();
    let dirs = [];
    try { dirs = readdirSync(cfg.projectsDir); } catch {}
    for (const dirName of dirs) {
      const dirPath = join(cfg.projectsDir, dirName);
      let files = [];
      try { files = readdirSync(dirPath).filter(f => f.endsWith('.jsonl')); } catch { continue; }
      const sessions = [];
      for (const f of files) {
        const p = join(dirPath, f);
        let st;
        try { st = statSync(p); } catch { continue; }
        if (!st.isFile()) continue;
        const sessionId = f.replace(/\.jsonl$/, '');
        const meta = transcript.extractTailMeta(p);
        sessions.push({
          sessionId,
          file: p,
          projectPath: meta.cwd ?? unescapeDir(dirName),
          sizeBytes: st.size,
          mtimeMs: st.mtimeMs,
          aiTitle: meta.aiTitle,
          lastPrompt: meta.lastPrompt,
        });
        bySessionId.set(sessionId, { sessionId, file: p, projectPath: meta.cwd ?? unescapeDir(dirName) });
      }
      sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (!sessions.length) continue;
      const newest = sessions[0].mtimeMs;
      projects.push({ dirName, projectPath: sessions[0].projectPath, sessionCount: sessions.length, newestMtimeMs: newest, sessions });
    }
    projects.sort((a, b) => b.newestMtimeMs - a.newestMtimeMs);
    cache = { at: Date.now(), projects, bySessionId };
  }

  return {
    getProjects(force = false) {
      if (force) cache.at = 0;
      refresh();
      return cache.projects;
    },
    findSession(sessionId) {
      refresh();
      return cache.bySessionId.get(sessionId) ?? null;
    },
    refresh,
  };
}

// 兜底：目录名反解（含 '-' 的路径段会错，所以只作无 cwd 时的最后手段）
export function unescapeDir(name) {
  return '/' + name.replace(/^-/, '').replace(/-/g, '/');
}
