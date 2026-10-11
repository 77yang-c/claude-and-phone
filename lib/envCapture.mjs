import { execFileSync } from 'node:child_process';

// ANTHROPIC_* 等接入变量写在 ~/.zshrc 里，非登录 shell 拿不到。
// 启动时经 login shell 捕获一次环境，过滤后注入 claude 子进程（避免每次 spawn 走 login shell 污染 stdout）。
const KEEP_RE = /^(ANTHROPIC_|CLAUDE_CODE_|PATH$|HOME$|SHELL$|LANG|LC_|TERM$|TMPDIR$|USER$|LOGNAME$|SSH_AUTH_SOCK$|GIT_)/;

export function captureEnv() {
  const env = {};
  try {
    // macOS 的 printenv 不支持 -0，按行解析（这些变量值均不含换行）
    const raw = execFileSync('zsh', ['-lc', 'printenv'], { encoding: 'utf8', timeout: 10000 });
    for (const line of raw.split('\n')) {
      const i = line.indexOf('=');
      if (i <= 0) continue;
      const k = line.slice(0, i);
      if (KEEP_RE.test(k)) env[k] = line.slice(i + 1);
    }
  } catch (e) {
    console.warn('[envCapture] zsh 环境捕获失败，回退 process.env:', e.message);
    for (const [k, v] of Object.entries(process.env)) {
      if (KEEP_RE.test(k)) env[k] = v;
    }
  }
  return env;
}
