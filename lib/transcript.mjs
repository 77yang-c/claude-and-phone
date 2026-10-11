// 纯函数：JSONL 行 → 归一化事件。行类型过滤、tool 摘要、超长裁剪。
import { openSync, closeSync, readSync, statSync } from 'node:fs';

const IGNORED_TYPES = new Set(['queue-operation', 'atis-latch', 'file-history-snapshot']);
const MAX_TEXT = 400000;         // 单文本块上限
const MAX_TOOL_CONTENT = 8000;   // tool_result 内容上限
const MAX_CMD = 160;             // Bash 命令展示上限
const MAX_LINE = 1024 * 1024;    // 单行超过 1MB 直接丢弃（prompt_snapshot 可达数百 KB）

export function parseLine(line) {
  if (!line || line.length > MAX_LINE) return null;
  let raw;
  try { raw = JSON.parse(line); } catch { return null; }
  const { type } = raw;
  if (!type || IGNORED_TYPES.has(type)) return null;

  if (type === 'ai-title') return { kind: 'ai_title', uuid: raw.uuid, sessionId: raw.sessionId, aiTitle: raw.aiTitle ?? null };
  if (type === 'last-prompt') return { kind: 'last_prompt', uuid: raw.uuid, sessionId: raw.sessionId, lastPrompt: raw.lastPrompt ?? null };
  if (type === 'attachment') return parseAttachment(raw);

  const msg = raw.message;
  if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) return null;

  const blocks = normalizeBlocks(msg.content);

  return {
    kind: msg.role, // 'user' | 'assistant'
    uuid: raw.uuid,
    sessionId: raw.sessionId,
    timestamp: raw.timestamp ?? null,
    cwd: raw.cwd ?? null,
    blocks,
    model: msg.model ?? null,
    stopReason: msg.stop_reason ?? null,
    costUsd: msg.usage ? null : null, // usage 计费字段不展示，保留位置
  };
}

// 归一化 message.content 块（text/thinking/tool_use/tool_result），JSONL 落盘行与 stream-json live 消息共用
export function normalizeBlocks(content) {
  const arr = Array.isArray(content)
    ? content
    : [{ type: 'text', text: String(content ?? '') }];
  const blocks = [];
  for (const b of arr) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') blocks.push({ type: 'text', text: clip(b.text ?? '', MAX_TEXT) });
    else if (b.type === 'thinking') blocks.push({ type: 'thinking', text: clip(b.text ?? '', MAX_TEXT) });
    else if (b.type === 'tool_use') blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {}, summary: summarizeToolUse(b) });
    else if (b.type === 'tool_result') blocks.push({ type: 'tool_result', toolUseId: b.tool_use_id, content: clip(String(b.content ?? ''), MAX_TOOL_CONTENT), isError: !!b.is_error });
  }
  return blocks;
}

function parseAttachment(raw) {
  // 只保留 total_tokens_reminder 作为上下文警告条；prompt_snapshot 等一律过滤
  if (raw.attachment?.type === 'total_tokens_reminder') {
    return { kind: 'context_note', uuid: raw.uuid, sessionId: raw.sessionId, text: clip(raw.rendered ?? '', 200) };
  }
  return null;
}

export function summarizeToolUse(block) {
  const { name, input } = block;
  if (!input || typeof input !== 'object') return name;
  if (name === 'Bash' && typeof input.command === 'string') {
    return input.command.slice(0, MAX_CMD) + (input.command.length > MAX_CMD ? '…' : '');
  }
  if (typeof input.file_path === 'string') return `${input.file_path}`;
  if (typeof input.path === 'string') return `${input.path}`;
  if (typeof input.pattern === 'string') return `${input.pattern}`;
  const keys = Object.keys(input);
  return keys.length ? `${name}(${keys.join(',')})` : name;
}

// 倒读文件尾部 64KB，提取 ai-title / last-prompt / cwd（cwd 是真实项目路径，
// 目录名的 - 转义不可逆，不能靠反解目录名拿路径）
export function extractTailMeta(p) {
  const meta = { aiTitle: null, lastPrompt: null, cwd: null };
  let fd;
  try { fd = openSync(p, 'r'); } catch { return meta; }
  try {
    const size = statSync(p).size;
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    // 第一条可能是半行（丢弃），最后一条是空串，从倒数第二条往前
    for (let i = lines.length - 2; i >= 1; i--) {
      const line = lines[i];
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (!meta.aiTitle && o.type === 'ai-title' && o.aiTitle) meta.aiTitle = o.aiTitle;
        if (!meta.lastPrompt && o.type === 'last-prompt' && o.lastPrompt) meta.lastPrompt = o.lastPrompt;
        if (!meta.cwd && o.cwd) meta.cwd = o.cwd; // 任意行类型都带 cwd
        if (meta.aiTitle && meta.lastPrompt && meta.cwd) break;
      } catch {}
    }
  } finally { closeSync(fd); }
  return meta;
}

function clip(s, max) {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
