// Phase 0 协议探针：验证 stream-json 双工 + --permission-prompt-tool stdio 权限协议
// 验证点：
//  1. 286 二进制接受 --permission-prompt-tool stdio（未知 flag 会立即报错退出）
//  2. can_use_tool 权限请求以 control_request 出现在 stdout
//  3. control_response allow 后工具执行、assistant、result 序列
//  4. 发送 interrupt 能中断当前轮
//  5. 关闭 stdin 后进程优雅退出
// 用法：node scripts/probe.mjs [claudeBin] [cwd]
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, appendFileSync, writeFileSync } from 'node:fs';

const BIN = process.argv[2] || '/Users/mac/.vscode/extensions/anthropic.claude-code-2.1.286-darwin-arm64/resources/native-binary/claude';
const CWD = process.argv[3] || '/tmp/cc-phone-probe';
const LOG = '/tmp/cc-phone-probe.log';

if (!existsSync(BIN)) { console.error('FAIL: 二进制不存在: ' + BIN); process.exit(1); }
mkdirSync(CWD, { recursive: true });
writeFileSync(LOG, '');

const log = (...a) => {
  const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
  appendFileSync(LOG, s + '\n');
  console.log(s);
};

// 1. 捕获 login shell 环境（ANTHROPIC_* 在 ~/.zshrc 里）
let env;
try {
  const raw = execFileSync('zsh', ['-lc', 'printenv -0'], { encoding: 'utf8', timeout: 10000 });
  env = {};
  for (const pair of raw.split('\0')) {
    const i = pair.indexOf('=');
    if (i > 0) env[pair.slice(0, i)] = pair.slice(i + 1);
  }
  log('env captured:', Object.keys(env).filter(k => /ANTHROPIC|CLAUDE/.test(k)).join(','));
} catch (e) { log('FAIL env 捕获:', e.message); process.exit(1); }

const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json',
  '--include-partial-messages', '--permission-prompt-tool', 'stdio'];
log('spawn:', BIN, args.join(' '));
const child = spawn(BIN, args, { cwd: CWD, env, stdio: ['pipe', 'pipe', 'pipe'] });

const send = (obj) => {
  const line = JSON.stringify(obj);
  child.stdin.write(line + '\n');
  log('>> stdin:', line.slice(0, 200));
};

let state = 'waiting_init';
let exitSeen = false;
let streamEventCount = 0;
const watchdog = setTimeout(() => { log('FAIL: watchdog 超时, state=' + state); cleanup(1); }, 150000);

function cleanup(code) {
  clearTimeout(watchdog);
  try { child.kill('SIGKILL'); } catch {}
  setTimeout(() => process.exit(code), 300);
}

let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log('!! stdout 非 JSON 行:', line.slice(0, 200)); continue; }
    handle(msg);
  }
});
child.stderr.on('data', (d) => log('stderr:', d.toString().trim().slice(0, 500)));
child.on('error', (e) => { log('FAIL spawn error:', e.message); cleanup(1); });
child.on('exit', (code, sig) => {
  exitSeen = true;
  log('EXIT code=' + code + ' signal=' + sig + ' state=' + state);
  const ok = code === 0 && (state === 'waiting_exit' || state === 'done');
  log(ok ? 'PASS: 优雅退出' : 'FAIL: 异常退出');
  cleanup(ok ? 0 : 1);
});

function handle(msg) {
  if (msg.type === 'stream_event') { streamEventCount++; return; } // 太啰嗦，只统计
  const tag = msg.type + (msg.subtype ? '/' + msg.subtype : '') + (msg.request?.subtype ? '/req:' + msg.request.subtype : '');
  log('<< stdout:', tag);

  if (tag === 'system/init') {
    log('PASS: init, session_id=' + msg.session_id + ' model=' + msg.model + ' cwd=' + msg.cwd);
    state = 'idle';
    send({ type: 'user', session_id: '', message: { role: 'user', content: [{ type: 'text', text: '请执行 echo cc-phone-probe-ok，然后把输出结果告诉我' }] }, parent_tool_use_id: null });
    state = 'waiting_permission';
    return;
  }

  if (msg.type === 'control_request') {
    if (msg.request?.subtype === 'can_use_tool') {
      log('PASS: control_request/can_use_tool, tool=' + msg.request.tool_name + ' input=' + JSON.stringify(msg.request.input ?? {}).slice(0, 150));
      if (state === 'waiting_permission') state = 'waiting_result';
      send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { behavior: 'allow' } } });
      return;
    }
    log('control_request 其他类型:', msg.request?.subtype);
    return;
  }

  if (msg.type === 'control_response') {
    log('<< control_response:', JSON.stringify(msg).slice(0, 200));
    return;
  }

  if (msg.type === 'assistant') {
    log('assistant stop_reason=' + msg.message?.stop_reason + ' blocks=' + (msg.message?.content ?? []).map(b => b.type).join(',') + ' streamEvents=' + streamEventCount);
    return;
  }

  if (msg.type === 'result') {
    log('PASS: result subtype=' + msg.subtype + ' is_error=' + msg.is_error + ' cost=' + msg.total_cost_usd + ' text=' + String(msg.result).slice(0, 120).replace(/\n/g, ' '));
    if (state === 'waiting_result') {
      // 第二问：纯文本，不触发工具
      send({ type: 'user', session_id: '', message: { role: 'user', content: [{ type: 'text', text: '第二问：只回复"收到"两个字，不要使用任何工具' }] }, parent_tool_use_id: null });
      state = 'waiting_result2';
    } else if (state === 'waiting_result2') {
      // 第三问 + interrupt 测试
      send({ type: 'user', session_id: '', message: { role: 'user', content: [{ type: 'text', text: '第三问：请从1数到100，一行一个数' }] }, parent_tool_use_id: null });
      setTimeout(() => {
        log('>> interrupt 发送');
        send({ type: 'control_request', request_id: 'probe-interrupt-1', request: { subtype: 'interrupt' } });
      }, 2500);
      state = 'waiting_cancel';
    } else if (state === 'waiting_cancel') {
      log('PASS: 中断后 result 到达');
      log('closing stdin…');
      child.stdin.end();
      state = 'waiting_exit';
      setTimeout(() => {
        if (!exitSeen) { log('FAIL: 关 stdin 后 10s 未退出'); cleanup(1); }
      }, 10000);
    }
    return;
  }
}
