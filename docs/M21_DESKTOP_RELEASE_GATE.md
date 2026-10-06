# M21 桌面端发布闸门

M20.1 已完成桌面流式代理的本机集成验证，但项目还不能把它描述成 ChatGPT Desktop 级别的可发布产品。下一阶段的目标是把“能编译、能在回环服务中工作”推进到“真实桌面外壳可操作、跨平台可安装、真实供应商失败可恢复、证据可复盘”。

## 证据边界

| 证据层 | 当前状态 | 可以声称 | 不能声称 |
|---|---|---|---|
| Rust 回环测试 | 通过，桌面 7 条、`eg-core` 84 条、stdio 2 条 | 状态码、分块、部分响应、超时、取消闸门在本机 Rust 层工作 | 真实 Provider SLA、webview 行为 |
| 前端与 Channel 测试 | 通过，最新全量 Vitest 79/732 | 队列、结构化错误、取消时序和真实本机 SSE 适配器语义稳定 | Tauri webview 的实际渲染和窗口切换行为 |
| 本地 HTTP 夹具 | `pnpm desktop:fixture:smoke` 通过 | OpenAI-compatible 五种场景 + Anthropic 正常/截断两种场景可重复触发；`--json` 可保存脱敏时序和断言 | Tauri 命令是否在真实包中被用户操作触发 |
| Mac QA 包 | x86_64 打包和启动烟测通过，最新 `.app` 约 12.15 MiB、`.dmg` 约 6.90 MiB；当前重新生成的包未签名 | 二进制和 QA 命令接线存在，进程可启动/受控终止；原生目录选择器插件已编入包 | 早先的本机 Developer ID 临时签名只做过链路预检；当前 QA 构建仍不是发行构建，DMG 签名、时间戳、notarization、Gatekeeper 分发和 Apple Silicon 仍未完成 |
| 真实供应商 | 未完成 | — | 多 Provider 限流、断流、鉴权恢复和成本/延迟表现 |
| Windows/Linux | 未完成 | — | 安装、更新、WebView、系统密钥链和文件权限对等 |

2026-10-05 当前主机的目标检查补充：`cargo check -p eg-core --locked --target x86_64-pc-windows-msvc`、`aarch64-pc-windows-msvc` 和 `x86_64-unknown-linux-gnu` 均通过，说明跨平台核心路由、账本和 Provider 逻辑可以编译。全工作区 Windows 检查在 `ring` 的 C 构建阶段停止，原因是 macOS 主机没有 Windows MSVC/C 交叉工具链和目标头文件；Linux 桌面检查在 `libdbus-sys` 停止，原因是没有 Linux sysroot、pkg-config 交叉配置和 GTK/DBus 开发库。这两条是构建环境阻塞，不是安装包或 WebView 通过证据，必须在原生 CI/目标机器上复测。

带 `qa-faults` feature 的 Mac 包的非 UI 烟测可以重复运行（Tauri 仍将 bundle 命名为 `EastGenesis Desktop.app`）：

```bash
pnpm tauri:build:mac:qa
pnpm desktop:package:smoke
```

如果本机有 Developer ID 身份，可以单独做签名链预检；这只修改本地 QA `.app`，不上传、不替代发行包签名或 notarization：

```bash
codesign --force --deep --options runtime --timestamp=none \
  --sign "Developer ID Application: <本机身份>" \
  "target/release/bundle/macos/EastGenesis Desktop.app"
codesign --verify --deep --strict \
  "target/release/bundle/macos/EastGenesis Desktop.app"
spctl --assess --type execute --verbose=4 \
  "target/release/bundle/macos/EastGenesis Desktop.app"
```

它检查打包二进制含有 `provider_stream` 和 QA 故障入口，连续两轮启动后各保持 4 秒、发送 `SIGTERM` 并确认退出，用于发现一次退出后无法再次启动的进程生命周期问题。该命令不点击界面、不提交任务，也不证明 Tauri webview、SQLite 会话恢复或真实 Provider 已通过。

仓库新增 `.github/workflows/desktop.yml`，在 Ubuntu、Windows 和 macOS runner 上统一执行前端测试、普通与 `qa-faults` Rust workspace 测试、无凭据夹具烟测、脱敏路由质量门禁和 `pnpm tauri:build:qa`，并上传未签名桌面包以及 `provider-recovery-matrix.json`、`routing-quality.json`。工作流同时支持 GitHub Actions 的手动 `workflow_dispatch`，方便在不制造无关提交的情况下复测目标 runner。WebDriver 步骤失败时仍会阻断 job，但会先为每个场景写入失败边界 JSON 和 `webdriver-quality-*.log`；上传步骤使用 `always()`，避免失败本身抹掉诊断证据。该工作流只提供可重复的构建和确定性测试证据；签名、notarization、真实 Provider 账号和人工 WebView 验收仍需单独配置。

工作流还运行 `pnpm --silent provider:matrix -- --json`：当前本地夹具覆盖 15 个 OpenAI-compatible / Anthropic 适配器场景和 4 个任务级恢复场景，并上传脱敏的 `provider-recovery-matrix.json`。这证明本地恢复契约在三种 runner 上可重复执行（待 GitHub runner 首次运行），不能替代真实 Provider 故障矩阵。真实 `--real` 模式现在支持一组必需的 primary 配置和一组可选但必须完整的 fallback 配置，可分别验证两个协议/供应商的流式连通性；该 smoke 仍不等于真实故障切换、SLA 或成本/延迟结论。

工作流在 Linux / Windows runner 上还安装固定版本的 `tauri-driver`，运行 `pnpm desktop:webdriver:smoke -- --stream --scenario <name>`：启动带 `qa-faults` 的 Tauri 二进制，建立原生 WebDriver session，读取 `EastGenesis Desktop` 文档标题，找到任务输入框，确认本地路由预判和提交按钮状态，然后把任务提交给只监听 `127.0.0.1` 的 `desktop-stream-fixture`。CI 当前分别执行 `staged`、`slow-first-token`、`truncated` 和 `idle-cancel` 四个场景，验证成功流首段/成果、首 token 延迟、截断后的部分输出与可见失败、以及 idle 流的取消控件。随后 `desktop:webdriver:summary` 对四个场景做固定字段校验并输出套件级 `webdriver-quality.json`；CI 同时保存 runner、tauri-driver 和 WebKitWebDriver/msedgedriver 的版本探针。QA 构建通过受限环境变量注入短生命周期的 `custom:qa`，Provider 配置只存在于进程内，不读取 Key、不访问真实 Provider。每个场景单独保存 JSON 和日志，任一场景失败仍阻断 job，但不再丢失其它场景的诊断文件。该 smoke 证明真实 WebView DOM、任务提交、流式 UI、部分输出和取消控件链路可以被目标平台的自动化驱动操作，不证明真实 Provider、目录选择器或账本恢复。macOS 的 `tauri-driver 2.1.0` 明确不支持该平台，仍需人工或其他 macOS 自动化通道验收。

为了让一次回归的证据边界清楚，新增统一命令：

```bash
pnpm desktop:gate
pnpm desktop:gate -- --json > desktop-gate.json
pnpm desktop:gate -- --json --include-bundle --include-package
```

它按顺序执行本地双协议夹具、15 个 Provider 适配器场景、4 个任务级恢复场景、脱敏路由质量门禁、TypeScript 类型检查、全量 Vitest 和前端构建。`--include-bundle` 要求当前平台已有可交付 bundle，`--include-package` 在 macOS 上要求 QA 包启动烟测通过；没有显式加入的桌面阶段会标记为 `not_run`，不会伪装成通过。JSON 只保存阶段名称、退出码、耗时、场景计数和固定的证据边界，不保存正文、路径、模型名、URL 或凭据。该命令仍然只证明本地确定性回归，不能替代真实 WebView、真实 Provider、签名/公证和跨平台安装验收。

默认闸门不会触网。拿到临时测试账号或受控故障代理后，才显式加入真实双 Provider 连通性 smoke；两组环境变量的格式见 [M22_PROVIDER_MATRIX.md](./M22_PROVIDER_MATRIX.md)：

```bash
pnpm --silent desktop:gate -- --json --include-real
```

`provider-real` 是必需阶段，缺少 primary 或 fallback 配置会 fail-closed；它只证明两组适配器能完成流式协议终态，不把成功连通性写成真实故障切换、SLA 或桌面 WebView 通过。

构建后还会运行 `pnpm desktop:bundle:smoke`：macOS 要求 `.app` 和 `.dmg`，Windows 要求 MSI/NSIS 安装包，Linux 要求 AppImage/deb/rpm 中至少一种非空产物。它只检查包文件存在且有大小，不执行安装、签名、WebView 或升级验证。

会话持久化现已把运行中的回合写成脱敏 checkpoint：任务事件变化时会把 `running` 回合写回 `sessions.turns`；启动读回时，如果没有落盘的 `run_end`，就补成明确的 `aborted`，保留计划和步骤，让任务卡显示“从未完成步骤继续”。如果 `run_end` 已经先落盘，则优先使用真实终态，避免把已完成任务误报成崩溃。该行为由 `tests/session-recovery.test.ts` 和 `tests/ui-history.test.tsx` 覆盖，仍属于 TypeScript/内存后端证据；只有在真实 Tauri 进程中杀进程、重启窗口并完成恢复，才算 M21 P0 的桌面验收。

目标模式的运行中轮次同样先写入 `goals.rounds`；启动时如果目标仍为 `running` 且最后一轮没有终态，会把目标转为 `paused`、轮次转为 `interrupted`，并显示可解释的中断原因。正常的 `uncertain` 等用户确认状态不会被当作崩溃。该恢复只重建安全的状态边界，不自动重放步骤；用户继续时仍需重新走账本探测和权限闸门。当前证据覆盖状态机、mock/SQLite 存储和目标 UI，真实 Tauri 进程退出、目标任务卡事件恢复及工具副作用仍待 P0。

## P0：Mac 真机关键路径

使用带 `qa-faults` 的 Mac 包和 `docs/M20_DESKTOP_STREAM_ACCEPTANCE.md` 记录模板，完成以下六条黄金路径：

1. `staged`：headers、首个正文 chunk、第二个 chunk、`[DONE]` 的时间线和回答区顺序一致。
2. `slow-first-token`：headers 已到达但正文未到达时，任务仍显示生成中，不提前结束。
3. `truncated`：部分回答保留，任务进入可解释的中断/失败状态，不静默拼接第二个模型。
4. `idle`：用户在 headers 后取消，前端立刻停止等待，`provider_stream_cancel` 到达 Rust，worker 在读边界或超时后退出。
5. `after_ledger_started` / `after_tool_before_ledger_commit`：真实终止进程，重启应用后任务显示“从未完成步骤继续”；账本、租约和文件探测不重复执行副作用。
6. 原生目录选择：在任务工作目录、项目上下文文件夹和设置里的允许目录分别点击“选择…”，系统对话框返回的路径显示在对应 UI；选择家目录/磁盘根目录时仍被校验拒绝，允许目录变更后内置文件服务器重启并使用新白名单。

每条路径必须保存任务 ID、Provider/模型、headers 时间、首 chunk 时间、最终状态、路由事件、账本状态和应用日志。没有这些字段，只记录“看起来成功”不算通过。

## P1：真实 Provider 故障矩阵

只允许使用临时测试账号或本地代理，凭据通过现有钥匙串/环境变量注入，不写入报告、截图、日志或提交。至少覆盖：

| 场景 | 预期策略 | 必须观察的证据 |
|---|---|---|
| 401/403 | Provider 下线，切换下一个可用 Provider | 原因脱敏、下线范围、没有重复鉴权请求 |
| 404/模型不存在 | 跳过当前模型，尝试同 Provider 的下一个模型或下游 | 尝试顺序和最终模型 |
| 429 | 按策略等待/换模型，保留限流信息 | 重试次数、退避、任务总耗时 |
| 5xx/网络断开 | 可恢复失败，保留部分输出并按策略继续 | partial output、降级理由、是否避免混拼 |
| 用户取消 | 立即结束本轮，不包装成 Provider 失败 | 取消事件、worker 退出、无后台持续请求 |
| 工具副作用未知 | 停在 `needs_user`，探测或二次确认 | ledger 状态、lease、文件指纹和用户选择 |

## P1：跨平台构建矩阵

由 CI 或对应原生机器生成并保留安装包和校验和：

| 平台 | 最低交付 | 重点检查 |
|---|---|---|
| macOS x86_64 | `.app`、`.dmg`、签名、notarization | Keychain、窗口恢复、Apple 安全策略 |
| macOS arm64 | `.app`、`.dmg`、签名、notarization | 原生架构或 universal 包、流式网络栈 |
| Windows x64 | MSIX/安装包 | WebView2、凭据存储、路径/终端权限、更新 |
| Linux x64 | AppImage 或 deb/rpm | WebKitGTK/WebView、XDG 路径、沙箱和更新 |

每个平台重复 `staged`、`slow-first-token`、`truncated` 和 `idle`；若无法在目标平台完成人工操作，必须把状态写成“构建通过、运行待验证”，不能用 macOS 结果代替。

## P2：发布前性能与安全门禁

- 记录冷启动到可输入、首个正文 chunk、完整回答的 p50/p95；分别记录 Web、桌面和每个平台。
- 记录空闲内存、流式峰值内存、CPU 峰值和取消后 10 秒内的线程/连接数。
- 比较 reqwest 流式迁移和 Dialog/RFD 原生目录选择器接入前后的包体积；当前 Mac QA 包约 `.app` 12.15 MiB、`.dmg` 6.90 MiB，后续 Windows/Linux 包必须重新测量。
- 运行密钥扫描、日志扫描、构建产物扫描；确认 Authorization、Provider 正文和本地文件正文不会进入事件、SQLite 账本或崩溃日志。
- 对提示注入、恶意文件、符号链接、路径穿越、MCP 工具声明缺失和跨进程 lease 竞争各保留一条回归证据。

## 退出条件

M21 只有在下面条件全部满足后才能进入公开 Beta 评审：

1. Mac 真机完成 P0 六条黄金路径，且每条都有可复盘记录。
2. 至少两个真实 Provider 完成 P1 故障矩阵；失败策略和部分输出行为与本地回环测试一致。
3. Windows 和 Linux 至少各有一个可安装包，并完成流式四场景和数据库迁移烟测。
4. macOS 发行包完成签名/notarization；当前 QA `.app` 的本机 Developer ID 签名只能作为签名链预检，不能代替发行包和 notarization；Windows/Linux 的签名或分发信任策略有明确记录。
5. 性能、密钥泄漏和副作用恢复门禁有结果；没有把“测试未覆盖”写成“通过”。

在 M21 完成前，产品定位应保持为“模型中立、透明路由、可恢复执行的桌面工作台 Alpha/内部 QA”，而不是已经达到 ChatGPT Desktop 的功能和发布成熟度。
