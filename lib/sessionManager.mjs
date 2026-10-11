// 手机驱动的 claude 子进程池：长驻 stream-json 双工进程 + 状态机 + 权限路由。
// 权限请求（control_request）经 SSE 转发到手机，手机审批后回 control_response——全部人工审核，无自动放行。
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { normalizeBlocks } from './transcript.mjs';

const RESTART_DELAYS = [2000, 4000, 8000];
const MAX_RESTARTS = 3;
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000; // 手机 5 分钟不答复 → 自动拒绝（安全默认）
const LIVE_THROTTLE_MS = 120;
const INIT_TIMEOUT_MS = 20000;

export function createSessionManager({ cfg, bin, env, hub, activity, index }) {
  const children = new Map(); // sessionId -> ClaudeChild

  function isAttached(sessionId) { return children.has(sessionId); }

  function getState(sessionId) {
    const c = children.get(sessionId);
    if (!c) return null;
    return {
      procState: c.procState,
      degraded: c.degraded,
      model: c.model,
      pendingPermission: c.pendingPermission
        ? { requestId: c.pendingPermission.requestId, toolName: c.pendingPermission.toolName }
        : null,
    };
  }

  async function attach(sessionId, { fork = false } = {}) {
    const existing = children.get(sessionId);
    if (existing) return existing;
    const loc = index.findSession(sessionId);
    if (!loc) {
      const e = new Error('会话不存在'); e.status = 404; throw e;
    }
    const c = new ClaudeChild({
      sessionId, projectPath: loc.projectPath, fork,
      ctx: { cfg, bin, env, hub, activity, rekey, onGone },
    });
    children.set(sessionId, c);
    await c.start();
    return c;
  }

  async function newConversation(projectPath) {
    const c = new ClaudeChild({
      sessionId: null, projectPath, fork: false,
      ctx: { cfg, bin, env, hub, activity, rekey, onGone },
    });
    children.set(c.tempId, c);
    c.start(); // 懒启动：不发消息就没有 init，真实 sessionId 在用户发第一条消息后经 rekey 获得
    return c;
  }

  function rekey(oldId, newId) {
    const c = children.get(oldId);
    if (!c) return;
    children.delete(oldId);
    children.set(newId, c);
    hub.publish(`session:${oldId}`, 'session_moved', { sessionId: oldId, newSessionId: newId });
  }

  function onGone(sessionId, c) {
    if (children.get(sessionId) === c) children.delete(sessionId);
  }

  async function shutdownAll() {
    await Promise.allSettled([...children.values()].map(c => c.stop('shutdown')));
  }

  return {
    attach, newConversation, isAttached, getState, rekey, shutdownAll,
    get: (sessionId) => children.get(sessionId) ?? null,
  };
}

class ClaudeChild {
  constructor({ sessionId, projectPath, fork, ctx }) {
    this.ctx = ctx;
    this.sessionId = sessionId; // null = 新会话（init 后拿到真实 id）
    this.tempId = randomUUID();
    this.projectPath = projectPath;
    this.fork = fork;
    this.procState = 'new';
    this.degraded = false;
    this.usePermissionStdio = true;
    this.fallbackAttempted = false;
    this.initReceived = false;
    this.proc = null;
    this.stderrBuf = '';
    this.stdoutBuf = '';
    this.live = null; // 当前 partial 消息
    this.pendingPermission = null;
    this.restartCount = 0;
    this.stopping = false;
    this.model = null;
    this.cwd = null;
    this.timers = new Set();
    this.initResolvers = [];
  }

  _publish(event, data) {
    this.ctx.hub.publish(`session:${this._id()}`, event, { sessionId: this._id(), ...data });
  }
  _id() { return this.sessionId ?? this.tempId; }
  _setState(s) {
    this.procState = s;
    this._publish('proc_state', { state: s, degraded: this.degraded, model: this.model });
  }

  start() {
    if (this.stopping) return;
    const { bin, cfg } = this.ctx;
    if (!bin) { this._setState('exited'); this._publish('exited', { reason: 'no-claude-binary' }); return; }
    this._setState('starting');
    // stream-json 需要 --verbose；--debug-to-stderr 保证 stdout 只有纯 JSON 事件流
    const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json',
      '--include-partial-messages', '--verbose', '--debug', '--debug-to-stderr'];
    if (this.sessionId) {
      args.push('--resume', this.sessionId);
      if (this.fork) args.push('--fork-session');
    }
    if (this.usePermissionStdio) {
      args.push('--permission-prompt-tool', 'stdio', '--permission-mode', 'manual');
    } else {
      args.push('--permission-mode', 'acceptEdits'); // 降级：工具自动批准（UI 有横幅提示）
    }
    const proc = spawn(bin.path, args, { cwd: this.projectPath, env: this.ctx.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.ctx.activity.registerOwnPid(proc.pid);
    proc.stdout.on('data', d => this._onStdout(d));
    proc.stderr.on('data', d => { this.stderrBuf = (this.stderrBuf + d.toString()).slice(-4000); });
    proc.on('error', e => console.warn(`[sessionManager] ${this._id()} spawn error:`, e.message));
    proc.on('exit', (code, signal) => this._onExit(code, signal));
  }

  _onStdout(d) {
    this.stdoutBuf += d.toString();
    let i;
    while ((i = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, i);
      this.stdoutBuf = this.stdoutBuf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this._handle(msg);
    }
  }

  _handle(msg) {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') this._onInit(msg);
        break;
      case 'stream_event': this._onStreamEvent(msg); break;
      case 'assistant': this._onAssistant(msg); break;
      case 'control_request': this._onControlRequest(msg); break;
      case 'control_response': break; // 我方 interrupt 的应答
      case 'result': this._onResult(msg); break;
      case 'rate_limit_event':
        this._publish('system_note', { text: '⚠️ 触发速率限制' });
        break;
      default: break;
    }
  }

  _onInit(msg) {
    this.initReceived = true;
    this.model = msg.model ?? null;
    this.cwd = msg.cwd ?? null;
    if (msg.session_id && msg.session_id !== this.sessionId) {
      const oldId = this._id();
      this.sessionId = msg.session_id;
      this.ctx.rekey(oldId, msg.session_id);
      this._publish(this.fork ? 'forked' : 'created', { newSessionId: msg.session_id, projectPath: this.projectPath, cwd: msg.cwd });
    }
    this.restartCount = 0;
    if (this.procState === 'starting' || this.procState === 'new') this._setState('idle');
    // 若已发过消息（starting→streaming），init 晚到不覆盖 streaming 状态
    this._resetIdleTimer();
    const resolvers = this.initResolvers; this.initResolvers = [];
    for (const r of resolvers) r(this.sessionId);
  }

  _onStreamEvent(msg) {
    const ev = msg.event;
    if (!ev) return;
    if (ev.type === 'message_start') {
      this.live = { uuid: msg.uuid || ev.message?.id, blocks: [], done: false, stopReason: null };
      this._publish('live_partial', { uuid: this.live.uuid, blocks: [], done: false });
      return;
    }
    if (!this.live) return;
    const b = this.live.blocks;
    if (ev.type === 'content_block_start') {
      const cb = ev.content_block ?? {};
      b[ev.index] = { index: ev.index, type: cb.type ?? 'text', id: cb.id, name: cb.name, input: cb.input, text: '', partialJson: '', done: false };
    } else if (ev.type === 'content_block_delta') {
      const block = b[ev.index];
      if (!block) return;
      const d = ev.delta ?? {};
      if (d.text != null) block.text += d.text;
      if (d.partial_json != null) block.partialJson += d.partial_json;
    } else if (ev.type === 'content_block_stop') {
      const block = b[ev.index];
      if (block) {
        block.done = true;
        if (block.type === 'tool_use' && block.partialJson) {
          try { block.input = JSON.parse(block.partialJson); } catch {}
        }
      }
    } else if (ev.type === 'message_delta') {
      this.live.stopReason = ev.delta?.stop_reason ?? null;
    } else if (ev.type === 'message_stop') {
      this.live.done = true;
    }
    this._flushPartial(false);
  }

  _flushPartial(force) {
    if (!this.live) return;
    const now = Date.now();
    if (!force && now - (this.live.lastPublish ?? 0) < LIVE_THROTTLE_MS) return;
    this.live.lastPublish = now;
    const blocks = this.live.blocks.filter(Boolean).map(b => ({
      index: b.index, type: b.type, id: b.id, name: b.name,
      text: b.text, input: b.input, done: b.done,
    }));
    this._publish('live_partial', { uuid: this.live.uuid, blocks, done: this.live.done, stopReason: this.live.stopReason });
  }

  _onAssistant(msg) {
    this._publish('live_message', {
      uuid: msg.uuid,
      model: msg.message?.model ?? null,
      blocks: normalizeBlocks(msg.message?.content),
      stopReason: msg.message?.stop_reason ?? null,
    });
    this.live = null;
  }

  _onControlRequest(msg) {
    const req = msg.request ?? {};
    const requestId = msg.request_id ?? req.request_id;
    if (!requestId) return;
    this.pendingPermission = {
      requestId,
      subtype: req.subtype,
      toolName: req.tool_name ?? null,
      input: req.input ?? {},
      suggestions: req.permission_suggestions ?? [],
      defaultToNo: !!req.default_to_no,
      toolUseId: req.tool_use_id ?? null,
      title: req.title ?? null,
      displayName: req.display_name ?? null,
      description: req.description ?? null,
      answered: false,
    };
    this._setState('awaiting_permission');
    this._publish('permission', { ...this.pendingPermission });
    // 同时推全局频道：用户在浏览其他会话时也能看到审批弹窗
    this.ctx.hub.publish('global', 'permission', { sessionId: this._id(), ...this.pendingPermission });
    // 手机超时不答复 → 自动拒绝（安全默认）
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.pendingPermission && !this.pendingPermission.answered) {
        this.answerPermission(requestId, { decision: 'deny', auto: true });
      }
    }, PERMISSION_TIMEOUT_MS);
    this.timers.add(t);
  }

  answerPermission(requestId, { decision, always = false, auto = false } = {}) {
    const p = this.pendingPermission;
    if (!p || p.requestId !== requestId || p.answered) {
      const e = new Error('无此待处理的权限请求'); e.status = 409; throw e;
    }
    p.answered = true;
    const response = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: { behavior: decision === 'allow' ? 'allow' : 'deny' },
      },
    };
    if (always && decision === 'allow' && p.toolName) {
      response.response.response.updatedPermissions = [{ type: 'allow', toolName: p.toolName }];
    }
    this._write(response);
    this.pendingPermission = null;
    this._setState('streaming');
    this._publish('permission', { requestId, answered: true, decision, auto });
    this.ctx.hub.publish('global', 'permission', { sessionId: this._id(), requestId, answered: true, decision, auto });
  }

  async sendText(text) {
    // claude 是懒启动：spawn 后静默，收到 stdin 第一条消息才发 init。
    // 所以 starting 状态可直接写 stdin（写即触发启动），不能等 init。
    if (this.procState === 'streaming' || this.procState === 'awaiting_permission') {
      const e = new Error('会话忙碌中'); e.status = 409; throw e;
    }
    if (this.procState !== 'idle' && this.procState !== 'starting' && this.procState !== 'new') {
      const e = new Error('子进程不可用: ' + this.procState); e.status = 409; throw e;
    }
    this._write({
      type: 'user',
      session_id: '',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
    });
    this._setState('streaming');
    this._resetIdleTimer();
  }

  interrupt() {
    this._write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
  }

  _onResult(msg) {
    this.restartCount = 0;
    this._setState('idle');
    this._publish('result', {
      isError: !!msg.is_error,
      subtype: msg.subtype ?? null,
      resultText: clip(String(msg.result ?? ''), 4000),
      costUsd: msg.total_cost_usd ?? null,
      numTurns: msg.num_turns ?? null,
    });
    this._resetIdleTimer();
  }

  _onExit(code, signal) {
    if (this.proc) this.ctx.activity.unregisterOwnPid(this.proc.pid);
    this.proc = null;
    const reason = this.stopping ? 'stopped' : `exit(${code ?? '?'}/${signal ?? 'none'})`;
    if (!this.stopping && this.stderrBuf) {
      console.warn(`[sessionManager] ${this._id()} 退出 stderr 摘要: ${this.stderrBuf.slice(-300).replace(/\n/g, ' ')}`);
    }

    // 特征探测：--permission-prompt-tool 不被接受（未知 flag 快速失败）→ 降级重试一次
    if (!this.initReceived && !this.stopping && this.usePermissionStdio && !this.fallbackAttempted &&
        code !== 0 && /permission-prompt-tool/i.test(this.stderrBuf)) {
      this.fallbackAttempted = true;
      this.usePermissionStdio = false;
      this.degraded = true;
      console.warn(`[sessionManager] ${this._id()}: --permission-prompt-tool 不被接受，降级 acceptEdits 模式`);
      this.start();
      return;
    }

    if (this.stopping) {
      this._setState('exited');
      this.ctx.onGone(this._id(), this);
      return;
    }

    // 崩溃 → 指数退避重启（同一 --resume 重放）
    if (this.restartCount < MAX_RESTARTS) {
      const delay = RESTART_DELAYS[this.restartCount];
      this.restartCount++;
      this._setState('exited');
      this._publish('exited', { reason, willRetry: true, delayMs: delay, attempts: this.restartCount });
      const t = setTimeout(() => { this.timers.delete(t); this.start(); }, delay);
      this.timers.add(t);
    } else {
      this._setState('exited');
      this._publish('exited', { reason, willRetry: false });
      this.ctx.onGone(this._id(), this);
    }
  }

  _write(obj) {
    if (!this.proc || this.proc.killed || !this.proc.stdin.writable) return false;
    try { this.proc.stdin.write(JSON.stringify(obj) + '\n'); return true; }
    catch { return false; }
  }

  _resetIdleTimer() {
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.stop('idle');
    }, this.ctx.cfg.idleTimeoutMs);
    this.timers.add(t);
  }

  waitInit(ms) {
    if (this.initReceived) return Promise.resolve(this.sessionId);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        reject(Object.assign(new Error('claude 启动超时'), { status: 504 }));
      }, ms);
      this.initResolvers.push((id) => { clearTimeout(t); resolve(id); });
    });
  }

  async stop(reason = 'user') {
    this.stopping = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.proc && !this.proc.killed) {
      if (this.procState === 'streaming' || this.procState === 'awaiting_permission') this.interrupt();
      try { this.proc.stdin.end(); } catch {}
      const proc = this.proc;
      await new Promise((resolve) => {
        const t1 = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, 3000);
        const t2 = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
        proc.once('exit', () => { clearTimeout(t1); clearTimeout(t2); resolve(); });
        proc.once('error', () => resolve());
      });
    }
    this.ctx.onGone(this._id(), this);
  }
}

function clip(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}
