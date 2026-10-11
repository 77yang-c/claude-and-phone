import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';

// 探测可用的 claude 二进制：优先 VS Code 扩展里版本最新的，回退 ~/.local/bin/claude。
// 返回 { path, source, version: [major,minor,patch] | null } 或 null（纯查看模式）。
export function detectBin(override = null) {
  if (override && existsSync(override)) return { path: override, source: 'override', version: null };
  const home = os.homedir();
  const extDir = join(home, '.vscode', 'extensions');
  let best = null;
  if (existsSync(extDir)) {
    for (const name of readdirSync(extDir)) {
      const m = name.match(/^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)-darwin/);
      if (!m) continue;
      const p = join(extDir, name, 'resources', 'native-binary', 'claude');
      if (!existsSync(p)) continue;
      const ver = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (!best || compareVersions(ver, best.version) > 0) best = { path: p, source: 'vscode-ext', version: ver };
    }
  }
  if (!best) {
    const local = join(home, '.local', 'bin', 'claude');
    if (existsSync(local)) best = { path: local, source: 'local', version: null };
  }
  return best;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  }
  return 0;
}

// 运行 `claude --version` 拿真实版本号（快，不发 API 请求），带缓存。
const versionCache = new Map();
export async function getVersion(binPath) {
  if (versionCache.has(binPath)) return versionCache.get(binPath);
  const p = new Promise((resolve) => {
    execFile(binPath, ['--version'], { timeout: 8000 }, (err, stdout) => {
      const v = err ? null : String(stdout).trim().split('\n')[0];
      versionCache.set(binPath, v);
      resolve(v);
    });
  });
  versionCache.set(binPath, p);
  return p;
}
