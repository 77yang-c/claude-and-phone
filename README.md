# Claude Code Phone 📱

在手机上实时查看并控制电脑上的 Claude Code。局域网内自托管，零依赖纯 Node.js，一条命令启动。

## 功能

- **实时查看**：手机浏览器实时查看电脑上所有 Claude Code 会话（包括 VS Code / 终端正在使用的），工具调用卡片、思考过程折叠展示
- **远程控制**：手机发消息，直接驱动电脑上的 Claude Code 工作（本地 claude 进程执行，文件/环境都在电脑上）
- **权限实时审批**：Claude 要执行命令/改文件时，弹窗推到手机点允许/拒绝（5 分钟不答复自动拒绝）
- **流式回复**：打字机式实时显示回复内容
- **会话冲突保护**：会话正被电脑上其他客户端使用时，可选「分叉继续 / 强行继续 / 取消」
- **Token 鉴权**：每次启动随机生成访问令牌，仅局域网可访问

## 快速开始

```bash
node server.mjs
```

终端会打印手机配对地址（含 token），手机连同一 WiFi 打开即可：

```
📱 手机配对地址: http://192.168.10.203:3456/?token=xxx
```

## 工作原理

```
手机浏览器 ──HTTP/SSE──▶ node server.mjs
                            │ 轮询 tail
                            ▼
        ~/.claude/projects/**/*.jsonl   ←─ 实时查看所有会话（含 VS Code 的）
                            │
                            │ spawn 长驻子进程（stream-json 双工管道）
                            ▼
        claude -p --resume <会话> --permission-prompt-tool stdio
                            │
                权限请求 control_request ──▶ 手机弹窗审批 ──▶ control_response
```

- **查看通道**：700ms 轮询 tail 会话 JSONL 文件，解析后经 SSE 推送手机（与接入方式无关，第三方中转也能用）
- **控制通道**：spawn 长驻 `claude -p --output-format stream-json --input-format stream-json` 双工管道，手机消息写 stdin，事件流解析推 SSE
- **权限通道**：`--permission-prompt-tool stdio`（Claude Code ≥ 2.1.286），权限请求以 `control_request` 出现在 stdout，审批后回 `control_response`

## 配置

复制 `config.example.json` 为 `config.json`，或使用环境变量：

| 配置 | 环境变量 | 默认值 | 说明 |
|---|---|---|---|
| `port` | `CC_PHONE_PORT` | `3456` | 服务端口 |
| `token` | `CC_PHONE_TOKEN` | 随机生成 | 访问令牌 |
| `tailIntervalMs` | `CC_PHONE_TAIL_INTERVAL_MS` | `700` | 会话文件轮询间隔 |
| `idleTimeoutMs` | `CC_PHONE_IDLE_TIMEOUT_MS` | `1800000` | 子进程空闲回收（30 分钟） |
| `bindAddr` | `CC_PHONE_BIND_ADDR` | `0.0.0.0` | 监听地址 |

## 环境要求

- **macOS/Linux**，Node.js ≥ 18
- **Claude Code**：自动探测 VS Code 扩展自带二进制（取最新版，需 ≥ 2.1.286 支持手机审批权限），回退 `~/.local/bin/claude`
- **接入方式**：任意（官方订阅 / API Key / 第三方中转均可）——本项目不碰 API，一切经由本地 claude 进程，环境变量自动从 login shell 继承

## 降级行为

| 情况 | 行为 |
|---|---|
| 无 `--permission-prompt-tool`（< 2.1.286） | 自动降级 `--permission-mode acceptEdits`，UI 显示提示 |
| 找不到 claude 二进制 | 纯查看模式，手机不能发消息 |
| 子进程崩溃 | 指数退避自动重启 3 次（2s/4s/8s），超限可发消息重试 |
| 权限 5 分钟无人答复 | 自动拒绝（安全默认） |

## 项目结构

```
server.mjs          # HTTP 路由、SSE、鉴权、优雅退出
lib/
  config.mjs        # 配置加载、token 生成
  claudeBin.mjs     # claude 二进制探测
  envCapture.mjs    # login shell 环境变量捕获
  transcript.mjs    # JSONL 行解析/归一化
  projectIndex.mjs  # 会话索引（标题/路径/大小）
  activityTracker.mjs # 活跃会话检测（pid 存活校验）
  tailWatcher.mjs   # JSONL 轮询 tail
  sse.mjs           # SSE 广播（环形缓冲+断线重放）
  sessionManager.mjs # 子进程池状态机/权限路由
public/index.html   # 单文件移动端 UI
scripts/probe.mjs   # 协议探针（诊断用）
```

## 已知限制

- 仅局域网访问（未做 HTTPS；外网访问需自行搭配 Tailscale/Cloudflare Tunnel 等）
- 手机驱动的会话为独立进程；与电脑上正在使用的同一会话并发写入需分叉或小心
- 依赖未公开的 stream-json 协议，Claude Code 升级可能需适配

## 开发进度

见 [PROGRESS.md](PROGRESS.md)
