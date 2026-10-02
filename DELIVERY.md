# EastGenesis Desktop 0.1.0 交付清单

> 2026-09-30。开发在 Linux VM 里进行，VM 里没有 webkit2gtk 和 macOS SDK，桌面外壳（`src-tauri/`）在 Mac 上编译和打包。Mac 上前后跑了三次：第一次编译失败，原因是 Tauri 各 crate 版本不配套，修法是整组升级到 2.12 并提交 `Cargo.lock`；第二次编译、.app 通过，.dmg 在 Finder 排版那一步失败，改用 `pnpm tauri:build:mac` 跳过这一步；第三次 .dmg 生成成功，从 .dmg 安装后的三项检查也通过。「已验证」分成 VM 和 Mac 两张表，都是实际跑过的；需要真实 Key 和真实服务的项目列在「待在 Mac 上验证」，步骤见 `docs/M5_MAC_HANDOFF.md`。验收标准见下文「验收标准」一节。各步骤的细节见 `docs/TASKS.md`。

## 各里程碑交付内容

| 里程碑 | 交付内容 |
|---|---|
| M1 脚手架与品牌 | Tauri 2 + React 18 + TS + Vite 工程；品牌素材由脚本从品牌板拆分，主题由 `docs/BRAND.md` 生成；启动页 |
| M2 LLMProvider | 统一接口，OpenAI、Anthropic 适配器（含 SSE 流式），兼容端点，密钥引用与脱敏，`pnpm eg` 命令行 |
| M3 路由与决策层 | 能力矩阵（22 个模型），规则分类器，多因子评分与降级链，Jev 客户端，三级降级（云端 Jev → 本地决策模型 → 规则引擎） |
| M4 Agent 运行时 | 规划、执行、反思、错误恢复、预算与取消；权限闸门和用户确认；MCP 客户端（stdio、工具白名单） |
| M5 桌面界面 | 侧栏、任务画布、执行时间线、路由面板、手动干预；设置页；Key 和 MCP 进程由 Rust 管理；浏览器模拟模式 |
| M6 扩展 | 其余 5 家官方适配器；自定义 Provider（两种协议、多模型、模型发现）；MCP 服务器登记；记忆；技能库；多 Agent 协同；本地决策模型 |
| M7 测试与交付 | 端到端测试 3 条路径，智能行为验收 9 项，对标基准表 `docs/BENCHMARK.md`，README，本文件 |

## 验收标准

仓库里从来没有 `docs/SPEC.md`，下表是验收标准的唯一出处。条目摘自项目说明里的安全红线和 UI 要求，以及 M3、M5 两次任务说明里的量化要求，原文没有改写意思。界面设计原则不在这里重复，以 `docs/BRAND.md` 第 12 节为准。「对应检查」写的是测试文件或验证记录；「待 Mac」表示要真实 Key 或真实服务，见下文「待在 Mac 上验证」。

| 类别 | 标准 | 对应检查 | 状态 |
|---|---|---|---|
| 安全 | 不硬编码、不打印、不提交 API Key；日志、事件、模型请求里的密钥先脱敏 | `tests/llm.test.ts`（redact）、`tests/agent-runtime.test.ts`、`tests/acceptance.test.ts`（工具输出里的密钥） | 通过 |
| 安全 | 密钥只从系统钥匙串或环境变量读取；前端拿不到 Key，只拿到「已配置 / 未配置」 | eg-core `secrets.rs`、`providers.rs` 测试；`tests/acceptance.test.ts`（webview 请求不带 Key） | 通过；钥匙串授权弹窗待 Mac |
| 安全 | Jev 的 Key 与模型 Provider 的 Key 分开管理 | eg-core `jev_key_is_separate`、`provider_and_jev_keys_cannot_be_referenced` | 通过 |
| 安全 | 工具调用白名单；有副作用的操作先请用户确认 | `tests/agent-mcp.test.ts`（只注册白名单工具）、eg-core `mcp_host.rs`；`tests/acceptance.test.ts`（写入先确认、拒绝后不执行） | 通过 |
| IPC | 命令 snake_case，错误统一为 `{ code, message, detail }` | `tests/platform-tauri.test.ts` | 通过 |
| 路由 | 50 条路由测试集，规则引擎准确率 ≥ 70% | `tests/routing-accuracy.test.ts`、`pnpm eg eval-routing` | 通过（86.0%） |
| 路由 | 接入 Jev 后准确率目标 85% | `pnpm exec tsx tools/jev-eval.ts`（回放录制的真实回答，不需要 Key）、`tests/jev-recorded.test.ts`；重新采样加 `--collect`（需要 `TYPESAFE_API_KEY`），详见 `docs/JEV_SMOKE_TEST_REPORT.md` | 通过（2026-10-02 真实采样：54 条独立盲写 hold-out 整条链 52/54 = 96.3%，两轮相同，规则引擎单独 81.5%；50 条训练集 100%）；Mac 复测待做 |
| 路由 | 三级降级：云端 Jev → 本地决策模型 → 规则引擎；没有 Jev Key 时直接走规则引擎，不阻塞 | `tests/decision-jev.test.ts`、`tests/local-jev-chain.test.ts`、`tests/decision-layer.test.ts`、`tools/jev-route-test.mjs` | 通过；有 Key / 无 Key / 假 Key（401）三种情况已在 VM 验证，Ollama 待 Mac |
| Agent | 按能力选模型、偏好生效、首选出错换模型、超时重试、注入指令不执行 | `tests/acceptance.test.ts`（9 项智能行为验收） | 通过 |
| 界面 | 启动页只在打开 SQLite 和初始化 Rust 侧期间显示，完成后 250ms 淡出；失败时显示图标、文字、重试按钮 | `tests/splash.test.tsx`、`tests/ui-shell.test.tsx`；Mac 安装版目测 | 通过 |
| 界面 | 三区布局：侧栏 240px，输入框 80% 宽、56px 高、12px 圆角，右侧面板 320px 可折叠 | `tests/brand-theme.test.ts`（尺寸变量）、`tests/ui-shell.test.tsx`（面板折叠）；80% 宽是 `src/components/TaskInput.tsx` 的 `w-4/5`，没有单独测试 | 专家模式下满足 |
| 界面 | 多卡片拖拽、折叠、关闭 | `tests/ui-tasks.test.tsx`（jsdom） | 通过；WKWebView 里待 Mac |
| 品牌 | 颜色只用 `--eg-*` 变量，不写 HEX；品牌板 SHA-256 不变 | `tests/brand-theme.test.ts`、`tests/ui-lint.test.ts`、`verify_brand_assets.py` | 通过 |
| 桌面 | Tauri 外壳在 Mac 上编译、启动，打出未签名 .app 和 .dmg；安装版走真实后端，SQLite 结构版本 3 | 「已验证（Mac）」一节 | 通过 |
| 真实服务 | 7 家官方 Provider 和中转站对话、流式、测试连接；真实 MCP 服务器；记忆、技能重启后还在 | `docs/M5_MAC_HANDOFF.md` 第三节 | 待 Mac |

## 已验证（VM，2026-09-30）

| 检查 | 命令 | 结果 |
|---|---|---|
| 单元、集成、端到端测试 | `pnpm test` | 38 个文件 331 项全部通过，act 警告 0。全部使用模拟后端，没有调用真实 API |
| 类型检查 | `pnpm typecheck` | 通过（TypeScript 5.7.3） |
| 前端打包 | `pnpm build` | 通过；产物里没有正则 lookbehind 和 `Object.hasOwn`，照顾旧版 macOS 的 WKWebView |
| 路由准确率 | `pnpm eg eval-routing` | 86.0%（主类型 + 硬性能力），严格准确率 74.0%，50 条标注样例 |
| 内部基准 | `pnpm eg bench` | 与 `docs/BENCHMARK.md` 逐字一致（测试会检查） |
| 品牌素材自检 | `python3 scripts/brand/verify_brand_assets.py` | 通过 61、警告 1（预期内）、失败 0；品牌板 SHA-256 不变 |
| Rust 核心 | `cargo test --locked -p eg-core` | 46/46（Rust 1.98.1，与 Mac 相同） |
| 桌面外壳（macOS 目标） | `cargo check --locked --target x86_64-apple-darwin -p eastgenesis-desktop` | 0 错误、0 警告。只做类型检查，不链接；编译 C 代码的依赖（SQLite、ring）用空桩代替，这部分要在 Mac 上验证 |
| 依赖一致性 | `cargo fetch --locked`（清华镜像）、`pnpm tauri info` | 镜像下载的 crate 与 `Cargo.lock` 校验和一致；Tauri 的 Rust 包与 npm 包版本配套 |
| Tauri 配置 | JSON Schema 校验 | `tauri.conf.json` 按 CLI 2.12.0 自带的 schema、`capabilities/default.json` 按构建时生成的 `desktop-schema.json`，都通过 |

## 已验证（Mac，2026-09-30）

Intel Mac，rustc 1.98.1，副本在提交 f221a44。日志是 `EastGenesis-repo/` 里的 mac-tauri-dev.log、mac-tauri-build.log。「用户目测」一列的结果由用户在 Mac 上确认，日志里看不到。

| 检查 | 命令 | 结果 |
|---|---|---|
| 开发模式 | `pnpm tauri dev` | 通过。编译 59.6 秒，0 警告；链接出 x86_64 Mach-O，启动后没有 panic，也没有非零退出；窗口正常出现（用户目测） |
| 未签名打包：.app | `pnpm tauri:build:mac` | 通过。release 编译 2 分 46 秒，0 警告；生成 `EastGenesis Desktop.app`（10.74 MiB，标识 com.eastgenesis.desktop，版本 0.1.0） |
| 未签名打包：.dmg | `pnpm tauri:build:mac` | 通过。日志显示「Finished 2 bundles」，生成 `EastGenesis Desktop_0.1.0_x64.dmg`（6.21 MiB，6,507,147 字节，zlib 压缩），没有报错和警告。第二次跑时 Finder 排版那一步失败，已在 f221a44 修复 |
| 从 .dmg 安装后启动 | 拖进「应用程序」后从访达启动 | 通过（用户目测）：启动页正常淡出；侧栏底部显示「SQLite · 结构版本 3」，说明迁移 1–3 已执行；没有「模拟后端」标记，说明走的是 Tauri 后端 |
| 锁文件 | `git status --short`（Mac 上运行，VM 里也通过共享文件夹核对过） | 没有输出；Cargo.lock 与提交逐字节一致，cargo 没有改写 |

## 待在 Mac 上验证

以下各项需要真实 Key、真实服务或手动操作，VM 里做不了，目前都没有验证。

- 钥匙串读写和系统授权弹窗；重启后记忆和技能还在。
- 真实 API：7 家官方 Provider 和中转站的对话、流式、「测试连接」；通义千问百炼兼容模式有没有 `/models`。
- 真实 MCP 服务器，包括 npx、uvx 启动时的 PATH；两个子 Agent 同时请求时是否触发限流。
- 真实 Ollama 做本地决策模型时的延迟和 JSON 遵从度（冷启动可能超过 8 秒的超时）。
- WKWebView 里的拖拽排序、折叠、键盘焦点遍历（目前只在 jsdom 里测过）。

## 已知限制

- Rust 代理把响应整体缓冲后再交给前端，桌面端看不到逐字输出；浏览器模拟模式也没有流式。命令行 `--stream` 是真流式。
- 取消任务不会中断正在进行的 Rust 请求。
- 窗口在最小宽度下展开右侧面板时，任务画布只剩约 400px。
- 规则引擎评估只读操作时只看文字：参数里有「保存」「删除」之类的词就要求确认。放宽属于权限改动，留给用户决定。
- 能力矩阵的质量、延迟、成本档是估计值（1–5 档），不是实测价格和评测分数。
- 命令行没有 `eg agent`，也不接第 2 级本地决策模型。
- 许可证未定：仓库没有 LICENSE，Cargo 工作区标为 UNLICENSED。
- 本地打包的 DMG 窗口是 Finder 的默认排列：没有自定义图标位置、窗口大小和背景图。安装窗口的排版留到发布阶段。

## 发布阶段（后期）

| 项目 | 状态 |
|---|---|
| 代码签名与证书 | 未开始 |
| macOS 公证 | 未开始 |
| 自动更新 | 未开始 |
| 应用商店上架 | 未开始 |
| 官网分发 | 未开始 |
| ICP 备案 | 未开始 |
