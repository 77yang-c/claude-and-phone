import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 配置优先级：env > config.json > 默认值
export function loadConfig() {
  let fileCfg = {};
  const cfgPath = join(ROOT, 'config.json');
  if (existsSync(cfgPath)) {
    try { fileCfg = JSON.parse(readFileSync(cfgPath, 'utf8')); }
    catch (e) { console.warn('[config] config.json 解析失败，忽略:', e.message); }
  }
  const env = process.env;
  const token = env.CC_PHONE_TOKEN || fileCfg.token || randomBytes(32).toString('hex');
  return {
    port: Number(env.CC_PHONE_PORT || fileCfg.port || 3456),
    bindAddr: env.CC_PHONE_BIND_ADDR || fileCfg.bindAddr || '0.0.0.0',
    token,
    // null = 自动探测（VS Code 扩展最新版 → ~/.local/bin/claude）
    claudeBin: env.CC_PHONE_CLAUDE_BIN || fileCfg.claudeBin || null,
    projectsDir: env.CC_PHONE_PROJECTS_DIR || fileCfg.projectsDir || join(os.homedir(), '.claude', 'projects'),
    sessionsDir: env.CC_PHONE_SESSIONS_DIR || fileCfg.sessionsDir || join(os.homedir(), '.claude', 'sessions'),
    tailIntervalMs: Number(env.CC_PHONE_TAIL_INTERVAL_MS || fileCfg.tailIntervalMs || 700),
    idleTimeoutMs: Number(env.CC_PHONE_IDLE_TIMEOUT_MS || fileCfg.idleTimeoutMs || 30 * 60 * 1000),
    lanIp: findLanIp(),
  };
}

export function pairUrl(cfg, token = cfg.token) {
  return `http://${cfg.lanIp}:${cfg.port}/?token=${token}`;
}

function findLanIp() {
  const ifs = os.networkInterfaces();
  for (const name of ['en0', 'en1']) {
    const v4 = ifs[name]?.find(a => a.family === 'IPv4' && !a.internal);
    if (v4) return v4.address;
  }
  for (const addrs of Object.values(ifs)) {
    const v4 = addrs?.find(a => a.family === 'IPv4' && !a.internal);
    if (v4) return v4.address;
  }
  return '127.0.0.1';
}
