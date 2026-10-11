# claudecode-phone 开发进度

手机实时查看/控制电脑上 Claude Code 的自托管 Web 应用（局域网，token 鉴权）。
用户第三方中转接入（~/.zshrc 的 ANTHROPIC_* 环境变量），不能依赖官方 API，一切经由本地 claude 进程。

## 当前状态（2026-10-09）

### ✅ 已完成

**Phase 1 只读查看**（已 curl 验证通过）：
- `server.mjs` — HTTP 路由、token 鉴权、SSE、优雅退出
- `lib/` — config / claudeBin（探测 VS Code 扩展 2.1.286） / envCapture（zsh login shell 捕获） / transcript（JSONL 解析） / projectIndex / activityTracker / tailWatcher（700ms 轮询 tail） / sse（环形缓冲+重放） / sessionManager（子进程状态机）
- `public/index.html` — 单文件移动 UI：会话列表、聊天视图、流式渲染、thinking 折叠、工具卡片、权限弹窗、新建会话、冲突弹窗
- `scripts/probe.mjs` — 协议探针（注：早期自动允许权限的版本被权限分类器拒绝，已弃用自动允许）

**关键修复**：
- macOS printenv 不支持 `-0` → 按行解析
- normalizeBlocks 忘导出 → 已补
- cwd 提取：尾部 64KB、任意行类型（目录名 '-' 转义不可逆）
- state 路由正则写错 → 已修
- `--output-format=stream-json` 必须加 `--verbose --debug --debug-to-stderr` → 已加
- sendText 需 await waitInit 解决 attach 竞态 → 已改 async

### ⚠️ 卡点：Phase 2 子进程 init 超时

发消息后 claude 子进程 20s 内没收到 `system/init` 事件，procState 停在 starting。
sessionManager 已加退出时打印 stderr 摘要，下次复现看日志。

**排查方向**：
1. 手动 spawn 2.1.286 二进制看 stderr（`--resume <sid> --output-format stream-json --input-format stream-json --include-partial-messages --verbose --debug --debug-to-stderr --permission-prompt-tool stdio`）
2. env 注入是否正确（zsh -lc printenv 捕获的 ANTHROPIC_*）
3. stdin 保持打开、init 事件的 JSON 格式

### 关键设计决策

- 权限：`--permission-prompt-tool stdio` → control_request 经 SSE 转手机 → 人工审批 → control_response；**5 分钟超时自动拒绝**
- 会话冲突：活跃会话发消息 → 409 + 前端弹「分叉继续（--fork-session）/ 强行继续 / 取消」
- 二进制探测：glob `~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude` 取最新 → 回退 `~/.local/bin/claude`
- 降级链：无 `--permission-prompt-tool` → `--permission-mode acceptEdits`；无二进制 → 纯查看模式

## 下一步

1. 排查 claude 子进程 init 超时
2. 权限审批端到端验证（手机点允许/拒绝）
3. README + fork 冲突流验证
4. 完成计划里的 8 步验证清单

## 使用方式

```bash
node server.mjs   # 端口 3456，终端打印配对 URL（含 token）
```

配置：`config.example.json` → `config.json`，或 `CC_PHONE_*` 环境变量。
