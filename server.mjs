// Claude Code Phone —— 手机实时查看/控制电脑上 Claude Code 的轻量服务器
// 用法：node server.mjs（配置见 config.example.json / CC_PHONE_* 环境变量）
import http from 'node:http';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadConfig, pairUrl } from './lib/config.mjs';
import { detectBin, getVersion } from './lib/claudeBin.mjs';
import { captureEnv } from './lib/envCapture.mjs';
import * as transcript from './lib/transcript.mjs';
import { createProjectIndex } from './lib/projectIndex.mjs';
import { createActivityTracker } from './lib/activityTracker.mjs';
import { createTailWatcher } from './lib/tailWatcher.mjs';
import { createSseHub } from './lib/sse.mjs';
import { createSessionManager } from './lib/sessionManager.mjs';

const cfg = loadConfig();
const bin = detectBin(cfg.claudeBin);
const env = captureEnv();
const index = createProjectIndex(cfg, transcript);
const activity = createActivityTracker(cfg);
const hub = createSseHub();
const tail = createTailWatcher(cfg, transcript);
const manager = createSessionManager({ cfg, bin, env, hub, activity, index });

// ---------- transcript 缓存（键=file:size:mtime） ----------
const transcriptCache = new Map();
function getTranscript(sessionId) {
  const loc = index.findSession(sessionId);
  if (!loc) return null;
  let st;
  try { st = statSync(loc.file); } catch { return null; }
  const c = transcriptCache.get(loc.file);
  if (!c || c.size !== st.size || c.mtimeMs !== st.mtimeMs) {
    let raw = '';
    try { raw = readFileSync(loc.file, 'utf8'); } catch { return null; }
    const events = [];
    for (const line of raw.split('\n')) {
      const ev = transcript.parseLine(line);
      if (ev && (ev.kind === 'user' || ev.kind === 'assistant' || ev.kind === 'context_note')) events.push(ev);
    }
    if (transcriptCache.size > 8) transcriptCache.delete(transcriptCache.keys().next().value);
    transcriptCache.set(loc.file, { size: st.size, mtimeMs: st.mtimeMs, events });
  }
  return transcriptCache.get(loc.file).events;
}

// ---------- 项目列表负载 ----------
function projectsPayload() {
  return {
    generatedAt: Date.now(),
    projects: index.getProjects(true).map(p => ({
      projectPath: p.projectPath,
      name: p.projectPath.split('/').filter(Boolean).pop() || p.projectPath,
      sessionCount: p.sessionCount,
      sessions: p.sessions.map(s => ({
        sessionId: s.sessionId,
        aiTitle: s.aiTitle,
        lastPrompt: s.lastPrompt,
        mtimeMs: s.mtimeMs,
        sizeBytes: s.sizeBytes,
        active: activity.getActive(s.sessionId),
        attached: manager.isAttached(s.sessionId),
        procState: manager.getState(s.sessionId),
      })),
    })),
  };
}

// ---------- tail → SSE ----------
let projectsTimer = null;
function scheduleProjectsPush(delay = 1500) {
  clearTimeout(projectsTimer);
  projectsTimer = setTimeout(() => {
    hub.publish('global', 'projects', projectsPayload());
  }, delay);
}
tail.on('lines', ({ sessionId, events }) => {
  hub.publish(`session:${sessionId}`, 'transcript', { sessionId, events });
  scheduleProjectsPush();
});
tail.on('newFile', () => scheduleProjectsPush());
setInterval(() => hub.publish('global', 'projects', projectsPayload()), 5000).unref();

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!res.headersSent) send(res, e.status || 500, { error: e.message || '服务器内部错误' });
    else res.end();
  });
});

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // 静态首页无需鉴权（数据接口全部需要）
  if (p === '/favicon.ico') return send(res, 204, null);
  if (req.method === 'GET' && p === '/') {
    const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (!authed(req, url)) return send(res, 401, { error: '未授权：URL 缺少 token' });

  // SSE
  if (req.method === 'GET' && p === '/api/stream') return hub.subscribe(req, res, 'global');
  const sseM = p.match(/^\/api\/sessions\/([^/]+)\/stream$/);
  if (req.method === 'GET' && sseM) return hub.subscribe(req, res, `session:${sseM[1]}`);

  if (req.method === 'GET' && p === '/api/health') {
    const version = bin ? await getVersion(bin.path) : null;
    return send(res, 200, {
      ok: true,
      version,
      bin: bin ? { path: bin.path, source: bin.source } : null,
      degraded: !bin,
      pairUrl: pairUrl(cfg),
    });
  }

  if (req.method === 'GET' && p === '/api/projects') return send(res, 200, projectsPayload());

  const txM = p.match(/^\/api\/sessions\/([^/]+)\/transcript$/);
  if (req.method === 'GET' && txM) {
    const events = getTranscript(txM[1]);
    if (!events) return send(res, 404, { error: '会话不存在' });
    const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 500);
    const before = url.searchParams.get('before');
    let idx = events.length;
    if (before) {
      const i = events.findIndex(e => e.uuid === before);
      if (i >= 0) idx = i;
    }
    const start = Math.max(0, idx - limit);
    return send(res, 200, {
      sessionId: txM[1],
      events: events.slice(start, idx),
      hasMore: start > 0,
    });
  }

  const stM = p.match(/^\/api\/sessions\/([^/]+)\/state$/);
  if (req.method === 'GET' && stM) {
    return send(res, 200, { sessionId: stM[1], state: manager.getState(stM[1]) });
  }

  // 发消息
  const msgM = p.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (req.method === 'POST' && msgM) {
    const sessionId = msgM[1];
    const body = await readBody(req);
    const text = String(body.text ?? '').trim();
    if (!text) return send(res, 400, { error: '消息为空' });
    if (!bin) return send(res, 503, { error: '未找到 claude 二进制，纯查看模式' });

    let child = manager.get(sessionId); // 新会话（tempId）或已接管会话，子进程已在池中
    if (body.fork) {
      if (!index.findSession(sessionId)) return send(res, 404, { error: '会话不存在' });
      child = await manager.attach(sessionId, { fork: true });
      await child.sendText(text);
      return send(res, 200, { sessionId: child._id(), forked: true });
    }
    if (!child) {
      if (!index.findSession(sessionId)) return send(res, 404, { error: '会话不存在' });
      const active = activity.getActive(sessionId);
      if (active && !body.force) {
        return send(res, 409, { error: 'conflict', active, message: '会话正在被其他客户端使用' });
      }
      child = await manager.attach(sessionId);
    }
    await child.sendText(text);
    return send(res, 200, { sessionId: child._id() });
  }

  if (req.method === 'POST' && p === '/api/sessions/:id/attach') {
    const aM = p.match(/^\/api\/sessions\/([^/]+)\/attach$/);
    if (aM) {
      if (!bin) return send(res, 503, { error: '未找到 claude 二进制，纯查看模式' });
      const child = await manager.attach(aM[1]);
      return send(res, 200, { sessionId: child._id(), state: manager.getState(child._id()) });
    }
  }

  if (req.method === 'POST' && p === '/api/sessions/:id/interrupt') {
    const iM = p.match(/^\/api\/sessions\/([^/]+)\/interrupt$/);
    if (iM) {
      const child = manager.get(iM[1]);
      if (!child) return send(res, 409, { error: '子进程未运行' });
      child.interrupt();
      return send(res, 200, { ok: true });
    }
  }

  if (req.method === 'POST' && p === '/api/sessions/:id/stop') {
    const spM = p.match(/^\/api\/sessions\/([^/]+)\/stop$/);
    if (spM) {
      const child = manager.get(spM[1]);
      if (!child) return send(res, 200, { ok: true, note: 'already-stopped' });
      await child.stop('user');
      return send(res, 200, { ok: true });
    }
  }

  const permM = p.match(/^\/api\/sessions\/([^/]+)\/permissions\/([^/]+)$/);
  if (req.method === 'POST' && permM) {
    const child = manager.get(permM[1]);
    if (!child) return send(res, 409, { error: '子进程未运行' });
    const body = await readBody(req);
    try {
      child.answerPermission(permM[2], { decision: body.decision, always: !!body.always });
    } catch (e) {
      return send(res, e.status || 400, { error: e.message });
    }
    return send(res, 200, { ok: true });
  }

  // 新建会话
  if (req.method === 'POST' && p === '/api/conversations') {
    if (!bin) return send(res, 503, { error: '未找到 claude 二进制，纯查看模式' });
    const body = await readBody(req);
    let projectPath = String(body.projectPath ?? '').trim();
    if (!projectPath) {
      projectPath = index.getProjects()[0]?.projectPath ?? process.cwd();
    }
    if (!existsSync(projectPath) || projectPath === '/') {
      return send(res, 400, { error: '项目目录无效: ' + projectPath });
    }
    const child = await manager.newConversation(projectPath);
    scheduleProjectsPush(300);
    // 懒启动：真实 sessionId 要等用户发第一条消息后才产生（init 事件 → rekey）
    return send(res, 200, { sessionId: child.sessionId ?? child.tempId, pending: !child.sessionId, projectPath });
  }

  send(res, 404, { error: 'not found: ' + req.method + ' ' + p });
}

function authed(req, url) {
  const t = url.searchParams.get('token') || req.headers['x-auth-token'];
  return t === cfg.token;
}

function send(res, code, data) {
  if (data == null) { res.writeHead(code); return res.end(); }
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > 1024 * 1024) { reject(Object.assign(new Error('请求体过大'), { status: 413 })); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('JSON 解析失败'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// ---------- 优雅退出 ----------
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[server] 正在关闭…');
  tail.stop();
  await manager.shutdownAll();
  hub.closeAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---------- 启动 ----------
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[server] 端口 ${cfg.port} 被占用，可用 CC_PHONE_PORT 换端口`);
    process.exit(1);
  }
  throw e;
});
server.listen(cfg.port, cfg.bindAddr, async () => {
  const version = bin ? await getVersion(bin.path) : null;
  console.log('');
  console.log('  ✅ Claude Code Phone 已启动');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  📱 手机配对地址: ${pairUrl(cfg)}`);
  console.log(`  💻 本机访问:     http://127.0.0.1:${cfg.port}/?token=${cfg.token}`);
  console.log('  ─────────────────────────────────────────────');
  if (!bin) {
    console.log('  ⚠️  未找到 claude 二进制 → 纯查看模式（手机不能发消息）');
  } else {
    console.log(`  🤖 claude: ${bin.path}`);
    console.log(`      来源: ${bin.source}${version ? ' · v' + version : ''}`);
  }
  console.log('');
  tail.start();
});
