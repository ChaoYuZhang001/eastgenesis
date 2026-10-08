# M20 桌面流式验收

这份清单把桌面流式链路的人工验收固定成不依赖外网和真实凭据的夹具。它验证的是 Tauri `.app`、Rust 代理、Channel、前端 `ReadableStream` 和 Agent Runtime 的连接，不代表任何真实供应商的 SLA。

## 夹具

在仓库根目录启动本地 OpenAI-compatible / Anthropic 双协议服务：

```bash
pnpm desktop:fixture
```

默认监听 `127.0.0.1:17891`。自定义 Provider 的 base URL 使用同一个端口，加上下面的场景路径；OpenAI-compatible 协议选择 `openai`，Anthropic Messages 协议选择 `anthropic`，模型填写 `fixture-model`，本机 HTTP 不需要 API Key：

只验证夹具 HTTP 场景时可直接运行：

```bash
pnpm desktop:fixture:smoke
```

需要把自动证据交给 CI 或验收记录时使用 JSON 输出；结果只包含状态、耗时、正文字节数和断言布尔值，不保存固定正文：

```bash
pnpm --silent desktop:fixture:smoke -- --json > /tmp/eastgenesis-desktop-fixture.json
```

该命令会随机选择本机端口，覆盖 OpenAI-compatible 的分块、慢首字节、截断正文、503 和 idle 取消，以及 Anthropic 的正常 `message_stop` 和截断流；它不启动 Tauri，也不替代下面的 `.app` 人工验收。JSON 中的 `headersMs` 和 `durationMs` 是本机夹具时序，不是供应商延迟承诺。

| 协议 / 场景 | base URL | 目的 |
|---|---|---|
| OpenAI 分块流 | `http://127.0.0.1:17891/staged/v1`（`/chat/completions`） | 两段正文和 `[DONE]` 按块到达 |
| OpenAI 慢首字节 | `http://127.0.0.1:17891/slow-first-token/v1`（`/chat/completions`） | headers 先到，首个正文约 300ms 后到 |
| OpenAI 截断正文 | `http://127.0.0.1:17891/truncated/v1`（`/chat/completions`） | 已收到部分正文后连接关闭，Content-Length 故意不完整 |
| OpenAI 503 | `http://127.0.0.1:17891/error/v1`（`/chat/completions`） | HTTP 503 和错误正文交给失败策略 |
| OpenAI 空闲流 | `http://127.0.0.1:17891/idle/v1`（`/chat/completions`） | headers 到达后保持无正文，用于取消时序 |
| Anthropic 正常流 | `http://127.0.0.1:17891/staged/v1`（`/messages`） | `message_start`、增量、`message_delta` 和 `message_stop` 按块到达 |
| Anthropic 截断流 | `http://127.0.0.1:17891/truncated/v1`（`/messages`） | 已收到部分正文后缺少 `message_stop` |

夹具只返回固定文本，不读取环境变量中的 Key，也不访问外网。退出服务：

```text
Ctrl-C
```

## `.app` 验收步骤

先用 QA 构建（普通构建没有故障终止入口）：

```bash
pnpm tauri:build:mac:qa
```

直接运行包内二进制可以保证环境变量和日志属于 Tauri 进程：

```bash
"target/release/bundle/macos/EastGenesis Desktop.app/Contents/MacOS/eastgenesis-desktop"
```

在设置页添加一个自定义 Provider，然后分别使用上表的场景提交一个需要模型回答的任务；Anthropic 场景要把协议切换为 `anthropic`。每次记录：任务 ID、Provider、模型、路由主模型、headers 到达时间、首个正文 chunk 时间、总耗时、是否发生降级、回答区状态和时间线事件。

### 1. 分块和首字节

使用 OpenAI 的 `staged` / `slow-first-token`，再使用 Anthropic 的 `staged`：

- 回答区应在完整正文结束前显示第一段内容；
- 路由行应仍然只显示一次最终模型，不把每个 chunk 当成独立调用；
- OpenAI 的 `[DONE]` 或 Anthropic 的 `message_stop` 后流正常结束，临时 `streamingText` 被清空；
- `slow-first-token` 中 headers 已到达但正文未到达时，任务不能被误判成完成。

### 2. 部分输出和断流

分别使用 OpenAI 和 Anthropic 的 `truncated`：

- 已收到的正文保留在回答区；
- 状态显示生成中断或失败原因；
- 不得静默拼接另一个 Provider 的正文；
- 路由时间线要能看出这是已有部分输出后的停止，而不是普通的“换模型重试”。
- Anthropic 缺少 `message_stop` 时必须走同一条截断恢复语义，不能因为协议不同而当作成功。
- 生产适配器把传输层半截记录为 `network + partialOutput`，把正常 EOF 但缺少协议终态记录为 `invalid_response + partialOutput`；两者都不能触发静默拼接。

前端 Channel 的同类回归由 `tests/platform-tauri.test.ts` 固定：如果 Channel 已经送出一段正文，随后才送出结构化 `error`，ReadableStream 必须先交付这段正文，再在下一次读取时报告错误。这样 Runtime 可以把已完成的部分保留下来，并根据失败策略决定是否恢复或换 Provider；错误不能提前调用 `controller.error` 把已排队正文吞掉。

### 3. 取消

使用 `idle`，在 headers 到达而正文尚未到达时点击取消；再重复一次，在 `slow-first-token` 的首个正文到达后立即取消：

- 前端应立即停止等待并显示取消状态；
- 应调用 `provider_stream_cancel`；
- 不应继续向回答区追加后续 chunk；
- 前端 Channel 已有正文后再取消时，已交付的首段正文仍必须可读，下一次读取以 AbortError 结束；
- 流式路径使用 reqwest blocking client：每次连接、读取或写入操作最多等待 60 秒，整条流最多 180 秒；普通 JSON 路径仍使用 ureq。前端取消应立即结束等待并通知 Rust，Rust worker 应在当前读边界或超时后退出，任何平台都不得创建持续增长的后台线程。macOS 的 idle 场景需要记录 timeout 错误和 worker 退出时间。

### 4. HTTP 失败

使用 `error`：

- UI 显示 HTTP 503 对应的可读失败原因；
- 失败策略决定是否换下一个 Provider；
- 路由行记录实际状态码和降级原因；
- 不能把错误 JSON 当成正常助手正文。

## 证据记录模板

```text
日期 / 构建：
平台 / 架构：
包路径：
任务 ID：
场景：
Provider / 模型：
headers 到达：
首个正文 chunk：
完成或中断时间：
已收到正文：
路由和降级：
取消命令：
任务最终状态：
账本 / 产物：
日志或截图：
结论：通过 / 失败 / 待复测
```

自动证据仍在 `src-tauri/src/net.rs` 的 TCP 回环测试、`tests/platform-tauri.test.ts` 的 Channel 测试和 `eg-core` 的跨 chunk 脱敏测试中；人工验收完成前，项目只能声称“桌面流式代理已完成本地集成验证”。

从回答下方点击“复制脱敏证据”后，可以在提交 QA 记录前做结构和泄漏边界校验：

```bash
pnpm desktop:evidence:validate /path/to/desktop-evidence.json
cat /path/to/desktop-evidence.json | pnpm --silent desktop:evidence:validate
```

校验器要求固定的 schema v1、任务/路由/模型/流式/工具/事件时间字段和完整省略清单，并拒绝任务正文、工具参数或输出、文件路径、URL、常见 Authorization/API Key 片段等字段。通过只表示证据文件格式和脱敏边界合格，仍不代表真实 WebView 或 Provider 已通过。

当前 schema v1 证据还会带 `surfaceJourney`，按执行顺序记录 `chat`、`work`、`codex` 能力面并去重；它只用于复盘统一任务是否跨能力面执行，不包含目标、文件或工具内容。旧记录没有该字段时仍可校验，验证器只在字段存在时检查枚举值。

每条脱敏 route 记录还会带 `stepId` 和 `surface`：任务级路由使用 `null`，步骤级路由只保留稳定步骤 ID 和能力面，不导出步骤目标正文。这样验收记录可以把“哪一步走 Work/Codex/Chat、使用哪条模型链”对应起来。

校验器还会检查 task/step 路由与 `stepId` 的对应关系，并确认 route 中出现的能力面是 `surfaceJourney` 的有序前缀，避免手工合并证据时把步骤链拼错。

通过校验后，可以把证据封装成带场景和环境元数据的黄金路径记录。`--build` 使用短的构建标识（例如 `qa-20261006-01`），不要写入路径、URL 或凭据：

```bash
pnpm desktop:evidence:validate evidence.json
pnpm desktop:acceptance:record -- \
  --input evidence.json \
  --scenario truncated \
  --platform macos \
  --arch x86_64 \
  --build qa-20261006-01 \
  --output acceptance-truncated.json
```

封装命令会再次调用同一个脱敏校验器；输入不通过时不会生成记录。输出的 `desktop-acceptance-record` 只增加场景、平台、架构、构建标识和记录时间，仍不能替代真实 WebView、Provider、签名或安装升级验收。

2026-10-05 最终实现记录：普通 JSON 代理继续使用 ureq，流式代理改用 reqwest 0.12.28 blocking + rustls-tls，以绕开 macOS 上 ureq 2.12.1 response reader 的 `EINVAL`；流式请求设置单次连接/读写操作 60 秒和整流 180 秒预算。`cargo test --workspace --locked`、Vitest 76/684、`pnpm typecheck`、`pnpm build` 和 Mac QA 打包均通过。QA 包尚未签名，且没有替代人工 Tauri webview、Windows/Linux 安装包和真实供应商故障切换证据。
