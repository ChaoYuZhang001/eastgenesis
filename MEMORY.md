# MEMORY · 关键决策

只记录决策和原因，细节以代码为准。

## M1 脚手架（2026-09-29）

- 目录结构：`src/`（React 前端）、`src-tauri/`（Tauri 外壳，只注册插件和命令）、`crates/eg-core/`（Rust 业务逻辑，不依赖 Tauri）。原因：执行环境没有 webkit2gtk，Tauri 编不了；把逻辑放进纯 Rust crate，就能在任何环境用 cargo test 验证。
- 品牌主题：`scripts/brand/sync_theme.mjs` 读取 `docs/BRAND.md` 中的 `--eg-*` 变量，生成 `src/styles/brand-tokens.css`。`pnpm build` 会先运行这个脚本；测试检查两者是否一致，并禁止 `src/` 其他文件出现 HEX 颜色。shadcn 的语义变量在 `globals.css` 中映射到 `--eg-*`。
- 启动页：做成应用内全屏覆盖层，不单独开 splashscreen 窗口。只覆盖真实的初始化过程（打开 SQLite），完成后 250ms 淡出；失败时显示图标、文字和重试按钮。
- SQLite：迁移定义在 `eg_core::MIGRATIONS`，由 Rust 侧注册到 tauri-plugin-sql；前端只负责打开和查询。非 Tauri 环境退回内存后端，并在 UI 上标出。
- IPC：错误结构统一为 `eg_core::AppError { code, message, detail }`，`detail` 一律经过 `redact()` 脱敏。TS 侧对应 `src/lib/ipc.ts`，两边暂时手工对齐。tauri-specta 仍是 rc 版本，而且这里无法编译 Tauri 验证，所以 M1 先不引入，等可以编译 Tauri 时再评估。
- 版本（固定）：Tauri 2.12.0 / tauri-build 2.7.0 / tauri-plugin-sql 2.5.0 / @tauri-apps/cli 2.12.0（2026-09-30 从 2.5.1 / 2.2.0 / 2.2.0 / 2.5.0 升级，原因见「Mac 首次编译修复」）；Vite 6.0.7 + Vitest 3.0.5（Vitest 2.x 自带 vite 5，和 vite 6 类型冲突）；Tailwind 3.4.17（shadcn 的 v3 配置方式）。
- 字体：Inter、Montserrat、JetBrains Mono 用 @fontsource 本地打包。Noto Sans SC 体积太大，暂不打包，中文走系统字体栈（苹方 / 微软雅黑）。
## M2 LLMProvider（2026-09-29）

- Provider 层放在 `src/core/llm/`（纯 TS，不依赖 DOM/Tauri），桌面端和 CLI 共用。不引入厂商 SDK，直接用 fetch，fetch 可注入，便于测试和走代理。
- 自定义 Provider 统一按 openai-compatible 处理，复用 OpenAIProvider。baseUrl 必须是 https（本机地址除外），不能带账号密码或查询参数；附加头不能覆盖鉴权头。
- 密钥只保存引用：`env:NAME`、`keychain:provider/<id>`、`keychain:jev`，Jev 和 Provider 的 Key 分属不同命名空间。M2 只实现 env 来源，钥匙串在 M5 接入 Rust 侧。
- ProviderError 带 `retryable`（rate_limit/timeout/network/server），供 M3 三级降级使用。错误细节会逐字抹掉当前 Key，再按规则脱敏。
- 每次响应都带 providerId、model、latencyMs、usage，满足「透明度优先」和路由面板的展示需要。

## M3 能力矩阵（2026-09-29）

- `config/model_profiles.json` 共 22 条：7 家官方 Provider 和 1 个自定义占位。型号、上下文长度、价格，以及是否支持视觉、工具和思考模式，都在 2026-09-29 从官方页面抓取：
  - OpenAI：developers.openai.com/api/docs/models、/api/docs/pricing
  - Anthropic：platform.claude.com/docs/en/models/overview、/about-claude/pricing
  - Google：ai.google.dev/gemini-api/docs/models、/gemini-api/docs/pricing
  - DeepSeek：api-docs.deepseek.com/quick_start/pricing（高峰价）
  - Qwen：alibabacloud.com/help/en/model-studio/model-pricing、/models（新加坡区 USD）
  - Kimi：platform.kimi.ai/docs/pricing/chat
  - Ollama：ollama.com/library、docs.ollama.com/context-length
- cost_tier 按混合单价分档，混合单价 =（3 × 输入价 + 输出价）/ 4，单位 USD / 1M token，取缓存未命中的标准档价格。分档：< 0.3 为 1，0.3–1 为 2，1–3 为 3，3–7 为 4，≥ 7 为 5。Ollama 本地模型为 1，自定义占位为 3。
- quality_tier 和 latency_tier 都是估计值。Artificial Analysis 和 LMArena 的页面读不出数据（单行过大或被截断），所以没有拿到 benchmark。暂按各家官方定位估：旗舰 5、均衡 4、轻量 3、本地 7–20B 为 2；延迟按 flash/lite 快、旗舰和常开思考的模型慢来估。拿到 benchmark 后再校准。
- 取舍：
  - claude-haiku-4-5 最早 2026-10-15 退役，所以设为 `enabled: false`。
  - gemini-3.1-pro-preview 是 Preview 版，下线只提前 2 周通知。
  - gpt-6-sol 和 gpt-6-luna 在 Chat Completions 中只有 reasoning_effort=none 时才能调用函数，而我们的适配器走 Chat Completions，所以暂不收录。
  - Ollama 的 context_window 记为 32768，因为实际上下文取决于显存和 OLLAMA_CONTEXT_LENGTH（默认可能只有 4k）。
  - qwen3.8-flash 的视觉能力没能核实，所以不标 vision。
- 标签规则：long_context 当且仅当 context_window ≥ 200k，加载时校验。zh 只标给以中文为主要训练语言的国产模型，只作软性加分，不排除其他模型。
- Provider 就绪：M3 只有 openai 和 anthropic 有适配器，其余 5 家的条目会被路由器过滤掉（原因「适配器未实现」），M6 补齐。

## M3 路由测试集与规则分类器（2026-09-29）

- 测试集 `tests/fixtures/routing_cases.json` 共 50 条，由独立子代理按统一规范盲写。我写 `src/decision/rules.ts` 时没有打开过这个文件。
  - 规范要点：6 种主类型，能力标签共 6 个（code、long_context、reasoning、tool_use、vision、zh）。主类型取所含能力中优先级最高的一个：vision > long_context > tool_use > code > reasoning，都没有时为 qa。附件与正文合计超过 100k 字符判为 long_context；zh 当且仅当语言为 zh 或 mixed。
  - 以后新增样例也按这套规范标注。
- 评估口径：
  - 路由准确率（主要指标）：主类型正确，且硬性能力（vision、long_context、tool_use）完全一致，因为这两项决定能否选到有资格的模型。
  - 另外报告主类型准确率、严格准确率（全部标签一致）和各标签的 P/R。
- 盲测结果（第一次运行，没有调参）：路由准确率 86.0%，主类型 86.0%，严格 74.0%。reasoning 召回 0.42，是最弱的一项。已经达到 M3 目标 70%，所以没有对照样例调规则。
- 需要说明的一点：子代理的汇报里提到过几道推理题的主题（密码锁、排班、AA、两个 offer 对比、跨时区），我在写规则前看到了。规则里没有针对这些题目的专用词，但 SOLVE 规则里的 "offer" 可能受了影响。

## M3 路由评分与降级（2026-09-29）

- 评分 = 可用性系数 ×（能力 × w1 + 质量 × w2 + 成本 × w3 + 延迟 × w4）。各项归一到 0–1：
  - 能力：任务所需软性能力（code、reasoning、zh）被模型覆盖的比例
  - 质量：(quality_tier − 1) / 4
  - 成本：(5 − cost_tier) / 4
  - 延迟：(5 − latency_tier) / 4
  - 可用性系数：0.5 + 0.5 × 健康度
- 基础权重（能力 / 质量 / 成本 / 延迟）：
  - 省钱：0.25 / 0.20 / 0.40 / 0.15
  - 平衡：0.30 / 0.35 / 0.20 / 0.15
  - 最强：0.30 / 0.55 / 0.05 / 0.10
  - 调整：质量权重按任务类型乘系数（qa 0.6、code 1.2、reasoning 1.3、其余 1.0），延迟权重按偏好乘系数（要快 2、正常 1、不赶时间 0.4），调整后重新归一化。
  - 同分时依次比较：质量高、成本低、id 字母序。
- 硬过滤（不参与评分，只记录原因）：已停用、本次已尝试、缺视觉或工具调用能力、上下文窗口不足（估算 token + 8192 输出预留）、超出成本上限、Provider 未就绪或熔断中。成本上限在降级时也不突破。
- 降级链：主模型 → 备选 1 → 备选 2 → 规则兜底。备选优先换一家 Provider；规则兜底优先本地 Ollama，其次选成本、延迟最低的。
- 模型降级的触发条件（executeWithFallback）：
  - aborted：立即停止。
  - auth、config：整个 Provider 下线，跳过它在链上的其他模型。
  - bad_request：换下一个；连续两个模型都报请求错误时停止。
  - rate_limit、timeout、network、server、not_found：记一次失败，换下一个。
  - 熔断：60s 内连续失败 3 次，熔断 60s。冷却后半开（健康度 0.5），试探失败立即重新熔断。
- 决策后端的三级降级（FallbackChain）：
  - 第 1 级 CloudJevBackend：没有 TYPESAFE_API_KEY 或端点不是 https 时跳过；auth、config 错误会在本次会话中停用它；超时、限流、529、5xx、网络错误按上面的规则熔断；置信度低于 0.6 时交给下一级（Jev 官方说明其中文准确率低于英文）。
  - 第 2 级 LocalJevBackend：M6 实现，目前总是跳过。
  - 第 3 级 RuleBasedBackend：总是可用，结果总是采用。
  - 每个决策都返回 meta：由哪一级做出、是否降级、置信度、跳过了哪些及原因、耗时。
- Jev 接入：
  - SDK：官方 `@typesafe-ai/sdk@0.6.0`，零依赖，维护者邮箱为 typesafe.ai 域名。只认 docs.typesafe.ai 和 api.typesafe.ai；搜索结果里有几个第三方转售站，不使用。
  - 超时与重试：单次 2.5s，总时限 6s，重试 1 次。
  - 隐私：关闭 SDK 日志，因为它在 debug 级会打印请求体。state 先脱敏，再截断到 2 万字符。
  - 分类方式：一次请求问完 code、reasoning、tool_use（有图片时加 vision）；long_context 和 zh 由代码判定。
- gateAction：
  - 白名单外的工具：拒绝。
  - 破坏性命令（rm -rf /、mkfs、curl | sh 等）：拒绝。
  - 有副作用的工具，以及删除、提权、强推、支付、访问敏感路径：需要确认。
  - 只读操作：再请决策层评估。决策层只能收紧，不能放宽。
- M5 注意：Jev 和模型 Provider 的 Key 都不能进 webview，要由 Rust 侧读钥匙串并代理请求。SDK 在浏览器环境会拒绝运行（没有设置 dangerouslyAllowBrowser）。
- CLI 内置 Provider 的默认模型改为 gpt-5.6-luna、claude-sonnet-5-5。M2 写的 gpt-4o-mini、claude-3-5-haiku-latest 已过时。

## M4 Agent 运行时（2026-09-29）

- 流程：routeTask 选模型 → Planner 让模型输出 JSON 计划 → 逐步执行 → 汇总后整体反思。
  - 规划：最多 maxSteps 步。引用了不存在的工具时交给 chooseTool 重新选；无法解析时退回单步计划。
  - 执行每一步：gateAction →（需要确认时）用户确认 → executeTool → 反思。executeTool 负责超时、把异常转为失败结果、输出先脱敏再截断到 8000 字符。
  - 反思：checkDone 加 evaluateResult。未完成且评分低于 0.15 视为失败。
- 错误恢复：由决策层 replan 选策略。
  - retry 或 modify_step 超过每步尝试上限时升级为 new_plan；new_plan 超过重规划上限时升级为 ask_user。
  - 被权限规则拒绝：replan 规则映射为 ask_user。
  - 用户拒绝确认：整个任务 aborted。
  - 没有确认渠道：needs_user，默认视为拒绝。
- 预算默认值：12 步、每步 3 次、重规划 2 次、模型调用 30 次。超出时状态为 budget_exceeded。
- 不可信内容：工具输出和错误信息都用 `<tool_output untrusted="true">` 包裹，系统提示声明其中的内容不是指令；伪造的结束标签会被转义。事件、确认请求和运行结果里的参数和输出都已脱敏。
- MCP 客户端是自己实现的最小版本：JSON-RPC 2.0；支持 initialize、tools/list（分页）、tools/call、ping；服务器发来的其他请求一律返回 -32601。
  - 没有用官方 SDK：M5 起桌面端由 Rust 侧管理 MCP 进程，TS 侧只需要换一个 Transport。
  - 协议版本只接受 2025-06-18、2025-03-26、2024-11-05。这个列表是凭记忆写的，没有联网核对最新版本。
- MCP 安全：
  - 白名单：工具必须在服务器策略的 allowTools 里；"*" 表示全部，但需要显式写出。
  - 命名与描述：工具名加前缀 `mcp__<服务器>__`；描述截断到 300 字符。
  - 标注：destructiveHint 总是采纳；readOnlyHint 只在 trustAnnotations 时采纳。默认按「访问外部服务」处理，执行前需要确认。
  - stdio：不经过 shell。子进程只继承最小环境变量加显式配置，我们的 API Key 不会传给 MCP 服务器。
- `src/agent/mcp/stdio.ts` 依赖 node:child_process，只在 CLI 里用，不从 `@/agent` 导出。
- 未做：CLI `eg agent` 命令（接真实 Provider 和终端确认）；UI 接入留到 M5。

## M5 密钥与进程迁移到 Rust（2026-09-29）

- 钥匙串：选 keyring-rs 3.6.3，不选 tauri-plugin-stronghold。
  - keyring 直接用系统钥匙串：macOS Keychain、Windows Credential Manager、Linux Secret Service。这正好符合红线「密钥只从系统钥匙串或环境变量读取」。
  - stronghold 是应用自己管理的加密库，需要一个主密码。这个主密码本身又得放进钥匙串，多了一层，没有增加安全性。
  - 版本固定为 3.x：4.x 要求 Rust 1.88，API 也变了，我不熟。
- 服务名 `com.eastgenesis.desktop`。账户名 `provider/<id>` 和 `jev` 分开，Jev 的 Key 与模型 Provider 的 Key 各自管理。`set_provider_key` 不接受 `jev`。
- 查找顺序：先钥匙串，再环境变量。前端只拿到 `{configured, source, needs_key}`，任何命令都不返回 Key 本身。进程内只缓存「是否存在」，不缓存 Key，这样能减少 macOS 的钥匙串授权弹窗。
- 模型和 Jev 的 HTTP 请求走 Rust 的 `provider_request` 代理（ureq 2.12.1，rustls）：
  - 端点固定：只允许 base URL 加白名单路径。
  - 请求头：丢弃前端传来的请求头，由 Rust 注入认证。
  - 响应：去掉其中的 Key，不跟随重定向。
  - 自定义 Provider：base URL 来自 Rust 侧的配置文件 `providers.json`（只存非敏感字段）。base URL 变了却没有提供新 Key 时，删除旧 Key，防止 Key 被发到新地址。名字像凭据的自定义请求头直接拒绝，因为请求头是明文存储的。
- 模块划分：逻辑放在 `crates/eg-core`（secrets、providers、mcp_host），可以在 VM 里 cargo test。`src-tauri` 只做薄封装（keychain.rs、net.rs、命令），VM 里编译不了，要在 Mac 上验证。
- MCP 进程：由 Rust 的 McpHost 管理。
  - 进程环境：清空环境变量，只传 PASS_ENV 白名单和显式配置，不经过 shell。
  - 消息转发：按行转发，事件是 `mcp-message` 和 `mcp-exit`。协议仍由 TS 的 McpClient 处理，CLI 继续用 Node 的 stdio。
  - 残余风险：`mcp_start` 允许 webview 请求启动任意命令，目前靠 CSP 和「不加载远程内容」兜底。M6 已改为只能按 ID 启动 mcp.json 登记过的服务器，见「M6 MCP 服务器登记」。

## M5 浏览器 / Tauri 双模式与 UI（2026-09-29）

- 前端只通过 `Backend` 接口（`src/platform/types.ts`）访问后端，有两套实现：
  - `createTauriBackend`：走 invoke。
  - `createMockBackend`：在内存里实现。
  - `getBackend()` 在不在 Tauri 环境、或 `MODE=web` 时选 mock。`pnpm dev:web`（端口 1421）不启动 Tauri，这样 UI 能在 VM 和 Vitest（jsdom）里完整跑通。
- mock 照搬 Rust 侧的校验（`mock-rules.ts`：Provider ID、Base URL、Key 格式、URL 变更时清除 Key），两种模式下前端看到的错误和状态一致。
- mock 可用 `?mock=fail-init,fail-requests,slow,jev` 组合出各种状态。`failInit` 是次数，方便测试「失败后重试」。
- 适配器拿到的 Key 是占位符 `proxied-by-rust`，请求经 `proxiedFetch` 转给 Rust 的 `provider_request`，由 Rust 注入真实 Key。
- 演示工具 `DEMO_TOOLS` 只在 mock 模式注册。Tauri 模式在 M6 接入 MCP 之前不注册工具。
- UI 决策：
  - 焦点环：红色在 `--eg-surface` 上不到 3:1，所以在 BRAND.md 的 `--eg-focus-ring` 里加了浅色外圈（标注「建议」）。
  - `dragDropEnabled: false`：Tauri 的原生文件拖放会拦截 HTML5 拖拽，卡片就排不了序。代价是暂时不能把文件拖进窗口，以后需要时改用 Tauri 的拖放事件。
  - 拖拽都配有「上移 / 下移」按钮作为替代（WCAG 2.5.7）。表单关闭、删除之后，焦点回到触发的按钮。状态一律用图标加文字表示，不单靠颜色。
  - 能力矩阵调整只保存和内置值不同的字段，改回默认值时该字段自动消失，「恢复默认」按钮也随之隐藏。
  - 卡片关闭后，运行收尾时的事件直接丢弃，避免无意义的重新渲染和测试里的 act 警告。
  - `tests/ui-lint.test.ts` 拦截不合规的写法：间距只能用整数档（4px 的倍数），圆角只能是 sm/md/lg/full/none，任意值必须在白名单里。
- 验证边界：UI 只在 jsdom 里测过。真实 WKWebView 里的拖拽、钥匙串弹窗和 SQLite 路径，要在 Mac 上按 `docs/M5_MAC_HANDOFF.md` 确认。

## M6 官方适配器（2026-09-29）

- 端点表只有一份：`src/core/llm/official.ts`。Rust 侧 `OFFICIAL_BASES` 是它的白名单副本，`tests/official-endpoints.test.ts` 直接读 providers.rs 比对两边。
- 除 Anthropic 外都走 OpenAI 兼容的 Chat Completions，复用 OpenAIProvider，差异放在 `RequestQuirks`：
  - OpenAI、Kimi 用 `max_completion_tokens`。
  - Kimi 和 Gemini 3 不发 temperature。
  - Gemini 兼容层不发 `stream_options`。
  - 运行时目前两个参数都不传，这些差异是给以后用的。
- Gemini 用兼容端点加 Bearer，没有接原生 API：一套适配器就够，原生 API 留作兼容层出问题时的备选。
- DeepSeek 的 base 不带 `/v1`，按官方文档当前写法。Rust 只放行这个形式。
- 地域：通义千问、Kimi 的 Key 按地域签发，每个 Provider 列出 cn / intl 两个 base，Rust 两个都放行。
  - 用户的选择存在 SQLite 设置 `provider_prefs`，缺省是第一个（中国站）。
  - 未知的地域直接忽略，不会拼出白名单以外的地址。
  - 改地域从下一个任务起生效，因为适配器在创建引擎时就构造好了。
  - 阿里云百炼的业务空间专属域名不放进官方表，用自定义 Provider。
- Ollama：
  - 固定 `http://127.0.0.1:11434/v1`，不用 localhost，因为 localhost 可能先解析到 `::1`，而 Ollama 默认只监听 IPv4。
  - Rust 用 `Auth::None`：不读钥匙串（避免 macOS 弹授权框），不加鉴权头。
  - 默认不参与路由：它的成本档是 1，本机没在运行时也会被选中。桌面端在设置页打开，CLI 用 `EG_OLLAMA=1`。
  - 其他地址或端口用自定义 Provider。`createProvider` 只有本机地址才允许不配 Key。
- 未验证（VM 里没有 Key，全部 mock）：
  - 真实请求。
  - 百炼兼容模式是否提供 `/models`。「测试连接」遇到 404 时说明「地址有误或不提供模型列表」，不当成 Key 错误。
  - Gemini 兼容层的 `[DONE]` 和 `max_tokens`。
  - `deepseek-v4-pro` 在后端对应哪个型号。

## M6 自定义 Provider 完整支持（2026-09-29）

- 协议字段 `protocol`：`openai` 或 `anthropic`，缺省 `openai`。旧的 providers.json 不用迁移，serde default 兜底。
  - `anthropic` 协议：`x-api-key` 加 `anthropic-version`，只放行 `/messages` 和 `/models`，与 one-api / new-api 一类中转站的约定一致。
  - 只接受 Bearer 的 Anthropic 兼容端点暂不支持。遇到时再加一个鉴权方式选项。
- 多模型字段 `models`：保存时规整为「默认模型在第一个、去重」，上限 32 个，Rust 与 TS 两边都校验。每个模型在能力矩阵里是一条独立的路由条目。
- 能力参照，按型号名自动匹配，不让用户手选：
  - 去掉 `vendor/` 前缀后不分大小写，和内置条目同名就沿用它的能力和档位；否则 3 档、不声明能力。
  - 不参照 Ollama：本机模型的成本、延迟档位不适用于远端。
  - 参照来源在自定义 Provider 列表和能力矩阵里都会标出来（透明度优先）。用户调整照常叠加。
- 模型发现：
  - 经 Rust 代理请求 `/models`，用的是已保存的地址、协议和 Key。表单里改过地址或协议，就要先保存，按钮会说明原因。
  - 结果最多 500 个，只作为输入框的候选，不自动加入路由，否则大型中转站会一下塞进几百条。
  - 404 提示手动填写。
- CLI：`--protocol anthropic`。

## M6 MCP 服务器登记（2026-09-29）

- 登记方式：应用配置目录下的 `mcp.json`，只由用户编辑。界面只读展示、启停、保存引用的密钥，不能添加或修改服务器。
  - 理由：用界面表单写配置，等于让 webview 决定启动什么命令，被注入脚本时就能执行任意程序。原生确认框要新增插件，VM 里无法验证编译。
  - 格式沿用常见的 `mcpServers`（command / args / env / cwd），可以直接从服务器 README 复制。新增 `allowTools`（不写则一个都不注册，`"*"` 为全部）和 `trustAnnotations`（默认否），也接受 snake_case。
  - 只支持本机 stdio。`url`、`type: sse/http` 的条目报错、不登记；单个条目出错不影响其他条目。
  - 列表和启动每次都重新读文件，改完点「重新读取」即可。
- 密钥：写成 `${keychain:NAME}`（钥匙串账户 `mcp/<服务器>/<NAME>`，与 `provider/<id>`、`jev` 分开）或 `${env:NAME}`。
  - 明文密钥拒绝登记，按以下启发式判断，尽力而为，不保证拦住所有情况：
    - 字面部分会被 redact 改写；
    - 带密码的 URL；
    - `--token xxx`、`--api-key=xxx`；
    - 名字像密钥的 env 变量（纯数字和短于 8 个字符的值放行，例如 `TOKEN_LIMIT=4096`）。
  - 不能引用模型 Provider 和 Jev 的 Key 变量，环境变量快照里也先剔除它们。
  - 界面只看到引用原文和「是否已提供」。`set_mcp_secret` 只能写这个服务器在 mcp.json 里引用了的钥匙串名。
- Rust 侧纵深防御：`mcp_send` 只放行 initialize、ping、tools/list、白名单内工具的 tools/call、通知和应答。
  - 拒绝批量消息和非 JSON；转发重新序列化后的文本，避免重复键之类的解析差异。
  - 白名单在启动时冻结：运行期间改 mcp.json，要重启服务器才生效，界面会提示。
- 前端：`useMcp` store 管理本次会话的连接。任务开始时，取已连接服务器的白名单工具；浏览器模式另加演示工具。
  - 界面重新加载后，Rust 侧可能留着进程。这时启动会先停掉它、等退出事件，再重新连接。
  - 停止时也等退出事件，避免它落到紧接着启动的新连接上。
- 模块：eg-core 新增 mcp_template（引用与明文检测）、mcp_registry / mcp_fields（登记表解析）、mcp_guard、mcp_secrets、mcp_resolve、mcp_service。McpServerConfig 不再从 IPC 反序列化，Debug 不输出 env 值。
- 未做：
  - 服务器自动启动：每次打开应用要手动启动。
  - CLI 读取 mcp.json。
  - 已删除服务器的钥匙串条目不会自动清理。

## M6 记忆系统（2026-09-29）

- 写入只有两条路径：
  - 设置页手动添加；
  - 任务目标里明确说「记住……」「以后都 / 今后请 / 从现在起……」「remember that …」时，卡片上给出提议，用户点「记住」才保存。
- 为什么这样写入：
  - 工具和 MCP 的输出可能带注入的指令，自动写进记忆就会变成长期指令。
  - 提议规则是保守的启发式：「记住了」「remember to」不算，只取要记住的那一句。误报的代价只是点一次「不用」。
  - 不用模型抽取记忆：要多一次调用，抽取结果同样要用户确认。
- 存储：eg-core 迁移 2 新建 memories 表，前端经 tauri-plugin-sql 读写（src/lib/db-memory.ts）。浏览器模式用 mock-memory.ts，校验规则共用 src/lib/memory.ts。
  - 上限：最多 200 条，每条最多 500 字。redact 会改写的内容拒绝保存。
  - SQL 占位符：每条语句里的 `$1`、`$2`… 按出现顺序递增。SQLite 按首次出现的顺序给参数编号，sqlx 再按编号绑定。
- 使用：任务开始时由 selectMemories 按目标挑选，不用向量检索。
  - 偏好全部带上，最多 8 条，最近更新的优先。
  - 事实按词重叠挑选，最多 5 条：英文按词，中文按相邻两字，去掉常见虚词。
  - 挑出的记忆放进规划、回答、总结的系统提示，注明「与当前目标冲突时以当前目标为准」。生成参数的提示不带记忆。
  - 透明度：时间线显示「参考了 N 条记忆」并列出每条；设置页显示来源、创建日期和被用过几次。
- 未做：
  - CLI 不读记忆。
  - 记忆不按项目分组。
  - 没有导入导出。

## M6 技能库（2026-09-29）

- 技能是用户保存的可复用流程：名称、说明、步骤（子目标加工具名）。
  - 不保存参数：参数可能带路径或个人信息，换个任务也不适用。
- 保存：
  - 完成的任务卡片上「保存为技能」，预填 stepsFromEvents 取出的实际做完的步骤，用户保存前可以修改。
    - 跨重新规划，按首次开始的顺序累计。
    - 失败、被拒绝、没做完的步骤不算；重试成功只算一次。
  - 设置页手动添加、编辑、两步删除。步骤每行一个，写成「子目标 | 工具名」，按最后一个 | 分开。
  - 校验与记忆相同：redact 会改写的内容拒绝保存；工具名要符合 TOOL_NAME；最多 100 个，每个 1–12 步。
- 使用：selectSkills 按目标挑选。
  - 至少两个词重叠才算相关，一个常见词不够；最多两个。重叠多的优先，其次用得多的。
  - 只放进规划提示，回答和总结不带。提示里注明「可以参考；不适用就忽略，工具只能从可用工具里选」。规划器引用了不存在的工具时，照旧由决策层重新选择。
  - 透明度：时间线显示「参考了 N 个技能」；设置页显示来源和被参考过几次。
- 存储：eg-core 迁移 3 新建 skills 表，steps 列存 JSON。steps 损坏的行不返回，不拖垮整个列表。db.ts 新增 withDb，记忆和技能共用。
- 未做：
  - 技能不能导入导出。
  - CLI 不读技能库。

## M6 多 Agent 协同（2026-09-29）

- 触发：任务输入框下的「多 Agent 协同」复选框，由用户勾选，不自动判断。拆分要多花模型调用和配额，值不值得由用户决定。
- 协调器 Coordinator（src/agent/coordinator.ts）：
  - 先路由一次，用首选模型把目标拆成 2–4 个互不依赖的子任务，每个配一个角色。拆分结果无法解析时改为单个「通用智能体」执行原目标，时间线说明原因。
  - 每个子 Agent 是完整的 AgentRuntime：独立路由、规划、工具调用、反思、纠错。预算比单 Agent 小（6 步、重新规划 1 次、模型调用 15 次）。
  - 默认最多同时 2 个，避免同一 Provider 并发限流；CoordinatorDeps.concurrency 可调。
  - 确认排队：一次只把一个确认交给用户，请求里带子 Agent 的角色名；取消后排队中的确认直接视为不同意。
  - 合并：子 Agent 的成果用 wrapUntrusted 包起来（每个最多 4000 字）交给模型合并。合并失败时拼接已完成的成果，并列出没完成的子任务。全部没完成时不合并，状态按 needs_user、budget_exceeded、failed 的顺序取。
  - 记忆交给子 Agent，也进拆分和合并的提示。技能不交给子 Agent：技能描述的是整个任务的流程，放进子任务的规划会误导。
- 事件：子 Agent 的事件原样包在 { type: "subagent", agent } 里。
  - 时间线给子 Agent 的条目加「角色」前缀；子 Agent 的开始、记忆、技能不重复列出；子 Agent 结束归到「反思」阶段，不和整个任务的完成混淆。
  - 用量统计包含子 Agent 的模型调用。
  - 卡片事件上限 500 条，超出时保留前 12 条（开始、记忆、路由、拆分），其余只留最新的，子 Agent 面板始终能还原。
- UI：任务卡片的步骤列表改为每个子 Agent 一行（角色：子任务，模型）；右侧「子 Agent」面板显示状态、模型和当前步骤；确认卡片显示是哪个子 Agent 发起的。
- 未做：
  - 子 Agent 之间不传递中间结果；有先后依赖的任务仍由单 Agent 的多步规划处理。
  - CLI 不支持多 Agent 协同。

## M6 本地决策模型 LocalJevBackend（2026-09-29）

- 定位：三级降级的第 2 级（src/decision/local-jev.ts）。没有 Jev Key、Jev 不可用或把握不够时先问它，它也失败或不确定时交给规则引擎。默认不用（provider_prefs.localJev 为 null）。
- 候选只限本机服务：Ollama，或 base_url 在本机的自定义 Provider（src/lib/local-decision.ts）。决策提示里有任务原文和工具输出，第 2 级的意义就是这些内容不离开本机；远端模型已经能经路由使用。和 Ollama 路由开关、能力矩阵的启用状态互不影响：一个管任务由谁执行，一个管决策由谁判断。
- 输出：每类判断只要一个固定格式的 JSON。先去掉 <think> 段（含没写完的），取第一个 { 到最后一个 }；概率、等级、策略、工具名任何一项不合法都抛 invalid_response，交给下一级。错误信息只带错误码，不带模型输出。
- 置信度：小模型自报偏高，最多记 0.8，没给按 0.5；按概率判断的用 |2p−1|，同样封顶 0.8。分类和云端 Jev 共用 classificationFromProbs（long_context、zh 由代码判定）。工具超过 64 个时置信度记 0，直接交给规则，不算失败。
- 安全：任务内容和工具输出放进 <data untrusted="true">，脱敏、每项截断到 4000 字，内容里伪造的 data 标签改掉。权限闸门仍是白名单、禁止规则、需确认规则优先，本地模型只在只读操作上被询问，而且只能收紧。
- 超时与错误：单次 8 秒；用户取消是 aborted，不记失败。not_found（模型没拉取）按 config 处理，停用到用户在设置页重新选择为止；network 等临时错误走熔断（60 秒内 3 次）。Qwen3 在提示末尾加 /no_think。
- 健康记录（stores/health.ts）：整个应用共用一个 HealthTracker，熔断和停用状态跨任务保留。此前停用记录从来没有被清除（markProviderUp 没有调用方），Key 改对后仍显示已停用，要重启才恢复。现在由设置 store 在保存 Key、切换地域、保存自定义 Provider、重新选择本地决策模型成功后调 resetProvider，清掉这个 Provider 的停用记录和它名下模型（id 等于名字或以「名字/」开头）的熔断记录；保存失败不清。删除 Key 不清，因为没有 Key 时它本来就不可用。
- 请求：和路由共用 providerFactory 的适配器缓存，经 proxiedFetch 交给 Rust。Rust 侧 provider_request 本来就允许 Ollama 和本机自定义 Provider，这次没有改 Rust。
- 浏览器模式：mock-decision.ts 让「是否完成」「结果评分」有把握，分类、风险、选工具、纠错策略没把握，演示第 2 级生效和继续降级两种情况。
- 限制：内置候选只有 model_profiles.json 里的 3 个 Ollama 模型。想用更小的模型，把 Ollama 登记为自定义 Provider（http://127.0.0.1:11434/v1）再填模型名。CLI 不接第 2 级（DecisionLayer.fromEnv 没传 local）。

## M7 端到端测试与验收（2026-09-29）

- 端到端测试在 jsdom 里跑：VM 没有浏览器、没有 webkit2gtk，Playwright 装不了。tests/e2e-journeys.test.tsx 渲染完整 `<App />`，接模拟后端，按用户路径点击；同一个 backend 重新渲染即模拟重启。真实 webview 的表现只能在 Mac 上验证。
- 验收测试（tests/acceptance.test.ts）用 createEngine 组装和桌面端相同的引擎，只把 providerRequest 包一层记录请求、按 target 注入 503。已有覆盖的项（路由准确率、三级降级、多 Agent、预算与取消）不重复写。
- 降级透明：executeWithFallback 的失败和跳过记录经 routedLlm 放进 LlmReply.fallbacks，再由 llmEvent（runtime 和 coordinator 共用）写进 llm 事件；时间线把这次调用标成提醒，写明先试了谁、原因。没有降级时不带这个字段，旧事件和持久化数据不受影响。
- 失败原因给中文：attemptText 把错误码换成 PROVIDER_ERROR_TEXT 里的说明（原来 errors.ts 私有的 MESSAGES），RouteExhaustedError 的消息逐个列出模型和原因。toAppError 的 detail 仍是 `模型:错误码`，给日志和程序用。
- 同一任务内尊重熔断：路由在任务开始时算好，之后每次调用走同一条链。executeWithFallback 调用前先查 health.status，已熔断或 Provider 已停用的直接跳过，原因记在 Attempt.reason；链上最后一个不跳过，保证至少试一次、报出真实错误。
- 规则引擎评估只读操作从严（没改）：assessRisk 只看文字，参数里有「保存」「删除」等词就是 medium 以上，只读工具也会要确认。放宽属于权限改动，要用户决定；验收测试固定了现状。
- HealthTracker.reset() 只给 UI 测试在用例之间复位；tests/ui-helpers.ts 的 resetStores 会调用。

## M7 对标基准表（2026-09-30）

- 竞品只用官方来源（官网、文档、帮助中心、GitHub 仓库），不用第三方评测。「未查到」表示查阅的官方页面没提到，不等于不支持；版本号写查询当天的。
- 内部基准口径：同一批 50 条样例，只跑分类和路由，不调模型，结果可复现。能力是否满足以人工标注为准，分类器错了如实扣分。成本档、质量档取 model_profiles.json 的 1–5 档（估），不是价格和评测分数。
- 「首选 Provider 故障后仍可完成」：降级链上有别家 Provider、且具备标注硬性能力的模型。固定一个模型按定义记 0%，用户手动换模型不计入。
- 固定旗舰：质量最高 → 能力最多 → 成本最低 → id；固定最便宜：成本最低 → 质量最高 → 能力最多 → id。两者都只从已启用、已配置的模型里选。
- 场景 A 的「全部能力满足」偏低，是能力矩阵只给国内厂商的模型标了 zh；不为了基准数字去改能力矩阵。
- 文档表格由 `pnpm eg bench` 生成，tests/bench.test.ts 逐字比对；改了路由、能力矩阵或样例就重新生成。

## Mac 首次编译修复（2026-09-30）

- Mac 环境：Intel（x86_64-apple-darwin），rustc 1.98.1，crate 走清华镜像。
- 原因：Cargo.toml 里的 `=` 只固定直接依赖。tauri-build 2.2.0 对 tauri-utils 写的是 `2.4.0`（即 `^2.4.0`），仓库又没有 Cargo.lock，Mac 解析到 tauri-utils 2.10.0，其中两个函数多了参数，报 E0061。
- 决定：Tauri 的 Rust 包和 npm 包整组升级到同一次发布：tauri 2.12.0、tauri-build 2.7.0、tauri-plugin-sql 2.5.0，@tauri-apps/api、@tauri-apps/cli 2.12.0，@tauri-apps/plugin-sql 2.5.0。CLI 会检查两边是否配套，以后升级也整组改。
- 决定：提交 Cargo.lock。新版本对内部 crate 用 `~`，但 wry、tao、tauri-plugin 等传递依赖仍按 `^` 浮动，只有锁文件能固定整棵依赖树。
- rust-version 1.90：tauri、tauri-build、tauri-utils 的要求。serde、serde_json 跟着升级（cargo_toml 1.0.1 要求 serde ≥ 1.0.228，serde_with 3.24.0 要求 serde_json ≥ 1.0.151），thiserror 顺带升到 2.0.21。
- 没改：`gen_platform_icons.py` 仍用 CLI 2.5.0 生成图标。图标已提交，换版本重跑会无故改动品牌产物。
- VM 里检查 macOS 目标（不链接、不运行）：
  - rustup 走中科大镜像，版本固定为和 Mac 相同的 1.98.1。镜像的 stable 别名清单和官方不一致，所以按版本号安装，并核对 sha256。
  - Cargo.lock 对照 crates.io 官方索引生成。卡住时设 `CARGO_HTTP_MULTIPLEXING=false` 重跑，已下载的索引会缓存，重跑几次就能完成。
  - 用假的 cc、ar 让 libsqlite3-sys、ring 的构建脚本产出空文件，再 `cargo check --locked --target x86_64-apple-darwin -p eastgenesis-desktop`。能查出 Rust 代码的编译错误，tauri-build 的构建脚本和 generate_context! 也会执行；链接、运行和 C 代码要在 Mac 上验证。
  - 检查时 crate 从清华镜像（sparse 索引）下载，校验和与 Cargo.lock 一致。Mac 本机 registry 目录的哈希和 VM 不同，镜像地址的写法可能不一样；Mac 编译后 Cargo.lock 如果被改动，先查镜像是否滞后。
  - 结果：Mac 第二次编译 `tauri dev`、`tauri build` 都链接成功，Cargo.lock 没被改写。

## Mac 打包 DMG（2026-09-30）

- Mac 上打包用 `pnpm tauri:build:mac`（`CI=true tauri build`），不直接用 `pnpm tauri build`。
- 原因：create-dmg 默认用 AppleScript 让 Finder 排版 DMG 窗口。这台 Mac 上这一步卡住约两分钟后失败，没有生成 .dmg。tauri-bundler 在 `CI=true` 时传 `--skip-jenkins`，跳过 Finder；DMG 内容不变，窗口是默认排列。
- 必须写 `true`：tauri-cli 把 `CI` 当作 `--ci` 的布尔值，`1`、`TRUE` 会报非法值。`CI` 在 CLI 里另外只影响交互提示和更新包签名的默认密码，本项目没开 createUpdaterArtifacts。
- 发布阶段要带排版的安装窗口时再改回：配置 bundle.macOS.dmg 的窗口和图标位置，并在有图形会话、已允许终端控制 Finder 的环境里打包。
- 结果：Mac 第三次用 `pnpm tauri:build:mac` 生成了 .dmg，安装版启动正常，走真实后端（结构版本 3，没有模拟后端标记）。
- 验收标准只写在 DELIVERY.md「验收标准」一节。仓库里从没有 SPEC.md，不要新建。
- 以后打包失败先加 `--verbose`：不加时 Tauri 只报「error running bundle_dmg.sh」，不显示脚本输出。临时镜像 `rw.<pid>.*.dmg` 会留在 bundle/macos，里面的 HFS+ 目录记录（创建、修改时间）和 .DS_Store 能还原脚本停在哪一步。

## 对话式界面重构与真实 API 测试（2026-09-30）

- 产品形态：首屏只放会话列表和输入框，交互元素不超过 12 个。旧的三区面板（画布、时间线、路由面板）收进「专家模式」，功能没有删。DELIVERY.md 三区布局一项的状态改为「专家模式下满足」，验收标准文字没动。
- 模型下拉框分两路：官方 Provider 用能力矩阵，中转站和自定义端点用 /models 缓存。启动时如果没有缓存就自动读一次，保存 Provider 后也会读一次，另外可以手动刷新。
- 锁定模型等于 `route.lock`：只锁这一个模型，跳过路由评分，也不走降级链。路由行显示「手动锁定」。
- 权限三档是完全访问、变更前确认（默认）、只读，对应权限闸门的三种模式。
- 适配器没有原生 function calling，工具调用走 Agent 规划器输出的 JSON 加 MCP 执行。以后要接原生 tools 参数，需要扩展 ChatRequest。
- 真实 API 测试：
  - 入口是 `tools/real-api-test.sh --real`，不带参数时跳过。凭据只放在仓库外的 600 权限临时文件里，用完删除。脚本输出经过 perl 兜底脱敏。
  - Node 后端（`realBackend`）替代 Rust 代理，Key 在后端注入。
  - VM 里单次调用约 180 秒会被杀，所以用 `EG_REAL_ONLY=R01,R02` 分批跑，结果按 id 合并。
  - perl 要加 `$|=1`，否则被杀时日志是空的。
- 中转站实测：
  - 延迟波动很大。deepseek-v4-pro 快的时候 3 秒，慢的时候 60 到 120 秒没有首字节，也出现过空回复（finish=length）。
  - /models 里有 gpt-5.5，但调用返回 404，所以模型在列表里不代表能调用。
  - deepseek 的流式输出带 reasoning_content。
- 用户决策（2026-09-30，首屏五项已确认）：
  - 单次请求默认超时 90 秒（DEFAULT_REQUEST_TIMEOUT_S，适配器 DEFAULT_LLM_TIMEOUT_MS 同为 90 秒），设置页可在 30 到 150 秒之间调。真实测试 R05 的 120 秒只在测试脚本里用，应用不跟着放宽。
  - /models 读取后做轻量探测（stores/settings.ts probeModels、lib/discover.ts）：每个模型发一个 max_tokens 为 1 的请求，并发 4 个，单个 20 秒，最多探测 100 个。
    - 只有 404 或 model_not_found 才标记为 unavailable，不在下拉里展示。超时、5xx、429 算「不确定」，照常展示。
    - 所有模型都是 404 时判为地址可疑（probeSuspicious），不隐藏任何模型。
    - 列表没变且探测过时，测试连接不重复探测；手动「刷新模型列表」总是重新探测。
  - 思考过程：OpenAI 兼容适配器把 reasoning_content 或 reasoning 放进 ChatResponse.reasoning，最多 2 万字符，不进正文和上下文。回答区默认折叠「思考过程」，点开才显示。
  - 因超时降级：LlmFallback 带错误码 code，code 为 timeout 时，路由行写「因超时降级 N 次」，降级记录写「因超时降级到 X」，专家时间线写「因超时降级：…」。其他原因的文案不变。
- 未覆盖（VM 条件不够）：Tauri 编译（没有 webkit2gtk）、真实桌面界面交互、钥匙串读写。

## 杀手场景（2026-10-01）

- 文件和 PDF 工具用 Rust 写在 eg-core 里（`mcp_files`、`pdf` 模块），不接现成的 Node MCP server：Mac 上的应用不依赖 Node，整个服务器只有一个可执行文件。
  - 桌面应用把自己当 MCP 服务器启动（`--mcp-files --allow ~/Downloads`，main.rs 分流，不创建窗口）。独立二进制 `eg-mcp-files` 给 CLI、测试和脚本用。
  - PDF 解析器是自写的，依赖只多一个 miniz_oxide（固定 0.8.9）。支持 FlateDecode / ASCIIHex / ASCII85、对象流、xref 流、ToUnicode CMap、Type0 字体、Form XObject（最多 4 层）。加密 PDF 直接报错，扫描件返回空文本加说明。
- 沙箱：根目录规范化以后才比较；`..` 一律拒绝；符号链接按真实路径判断。越界统一返回 path_not_allowed，不泄露路径是否存在。根目录不能移动，移动不覆盖已有文件，删除只删文件。
- 内置服务器 ID 是 `files`，排在 mcp.json 前面；mcp.json 里同名的项会被忽略并报错。工具白名单是 9 个固定名字，信任标注（trust_annotations）。
- 确认分级：只读工具不确认；create_directory 算写本地文件，确认一次；write_file、move_file、delete_file 标为破坏性，每次严格确认，「完全访问」也不放行；delete 再加一次确认（`confirmTwice`，确认框写「再次确认：删除后无法恢复」）。
- 子进程环境由 Rust McpHost 的 env_clear 和白名单控制，Node 侧 childEnv 也一样，API Key 不会传给子进程。
- 续写规划（`more`）：先列目录、再逐个处理这类任务，第一次规划时不知道有几个文件。规划器只给出现在能确定的步骤并标 `more`，运行时做完这批后调用 `continuePlan` 继续。没有选「一次规划完 + forEach 模板」，因为 forEach 模板要另造一套模板语言，模型也更容易写错。
  - 预算：续写最多 10 轮；执行步数每续写一轮多给 maxSteps，总数不超过 60。
- 反思：工具返回结构化结果并报告成功时，不按「失败」「无法」等关键词判为失败。PDF 正文里出现这些词很正常，之前会误判。
- 任务分级（`taskTier`）默认偏向走规划：只有明确的问答类目标（自我介绍、翻译、解释概念、闲聊）才走快速路径，只调一次模型。原因：误判成简单任务时，Agent 只会回一段话，不会干活，这比慢更糟。
- 杀手场景测试用确定性模拟模型（`tests/killer-mock-llm.ts`）：它只读提示词里 `<tool_output>` 的真实工具结果，按关键词判断主题。工具是真实子进程。凭据文件存在时，`tools/killer-scenario.ts` 改用真实中转站模型。
- 路由信息只在回答下方的折叠行展示：候选原因用 `CANDIDATE_WHY` 的人话，判断来源和停用模型只在专家模式面板。成果文本经 `stripRouteRecord` 去掉模型自己写的「路由记录」段，系统提示也要求不写。
- 思考过程：默认不显示（show_reasoning 默认 false）。打开后也只给摘要：按行过滤，不做模型改写，避免多一次调用；过滤规则在 `src/lib/reasoning.ts`，宁可多删。
- 技能重放而不是让规划器「参考」技能：参考只能省一点提示词，模型调用次数不变；直接执行只读步骤才能明显变快。只读步骤保存参数（路径已在技能名和子目标里，用户保存前能看到并修改），写入类不保存，重放时仍由模型按新结果决定，并照常确认。只在「再…一次」或目标与技能名相同时重放，相似但不同的任务仍走规划。
- 偏好声明（「我偏好简洁输出」）归入简单问答，回一句即可；记忆仍要用户点「记住」才保存，不自动写入。

## Jev 集成：官方 skill、置信度策略、tool_use 措辞（2026-10-02）

- 采用 TypeSafe 官方 skill（`typesafe-ai`，MIT）指导 Jev 集成：装在 `.claude/skills/typesafe-ai/`（`npx skills@1.7.0 add typesafe-ai/skills --skill typesafe-ai -a claude-code -y --copy`，关遥测），`skills-lock.json` 记来源和哈希。开发工具，进 git，不进应用包（`tests/dev-tools-not-bundled.test.ts` 守着）。「不要放进 bundle 给最终用户」按应用包理解；`eastgenesis.bundle` 是 git 仓库的打包，里面有它。
- 官方指引与我们的做法：
  - 同一状态上的独立问题放进一个请求并行问（fan-out）：三问（code / reasoning / tool_use，有图片加 vision）保留，不拆。用户提的「只问一个 Choice」不采用：能力会同时成立，官方也说这种情况每个标签一个 Noul。
  - 「忽略未用分支的不确定性」：置信度只取会改变主类型或硬性能力的判断的最小 |2p−1|，不再取全部最小。
  - 「取最大 / 不设阈值」不行：hold-out 上只有 74.1%，低于规则引擎单独的 81.5%。
  - 问题和阈值集中在 `src/decision/jev-config.ts`。
- tool_use 措辞 v2（2026-10-02 采用）：v1 把附件当成「要读本地文件」，对长文本/图片附件误报 tool_use。v2 写明「附件已提供、读它不算动作」，同时保留「对附件本身改名、移动、保存、发送仍算动作」。先定采用条件（误报下降、漏报不增、链准确率不降）再看数据，三条都达成：hold-out 上误报 27 → 0（p 0.81–0.92 的假阳性消失），漏报 0 → 0，链准确率 83.3–85.2% → 96.3%，两轮一致。code / reasoning 精确率没变。
- 数据（每轮都是真实调用；录制的回答存在 `tests/fixtures/jev_recorded_*.json`，含当时的 questions 原文和指纹，措辞一变就用 `--collect` 重采）：
  - 50 条标注样例（训练集，2 轮）：降级 8.0%，整条链 100%（50/50）。
  - **54 条独立盲写 hold-out（2 轮）：降级 11.1%，整条链 96.3%（52/54）**，规则引擎单独 81.5%，Jev 单独 108/108。hold-out 只用来检验，不要拿它调规则或措辞。
  - 结论：没有过拟合迹象——hold-out 比 50 条那版的 90% 高，也高于 85% 的验收目标。50 条的 100% 是调参集上的饱和值，汇报以 hold-out 为准。
  - 阈值：0.6 在 hold-out 上最好（96.3% / 降 11.1%）；0.7 反而更低（94.4%）；0.5 两轮波动更大（96.3% / 98.1%）；0.8 掉到 92.6%。留 0.6。
  - 剩下 2 条错（两轮相同，`ho-code-en-02`、`ho-reasoning-en-02`）：Jev 判对了，决定性置信度 0.40–0.56 低于 0.6，交给规则引擎后判错。和标签结构无关（2026-10-03 用 `evaluateChain` 回放核实，之前写的「标签粒度」是错的）。不为这两条下调阈值。
- 延迟：P50 328ms（新 Key 复测 359ms），未达 300ms。VM 到 api.typesafe.ai 的裸往返 P50 250ms（复用连接，24 次；首次建连 1.4s），Jev 自身约 70–100ms（估）。**300ms 在当前 VM 网络下基本不可达，实际取决于客户端网络，以 Mac 复测为准**（`node tools/jev-smoke-test.mjs 10`）。Mac 上也不达标时，用户会回来找我。
- Key 安全：第一轮的 Key 明文进过会话记录（2026-10-02 下午），用户已在 TypeSafe 后台轮换；第二轮用的是新 Key，跑完把 `.env.local` 删掉了。以后读 Key 只用 `set -a; . ./.env.local; set +a` 载入环境变量，不用文件读取工具、不写进命令行。
- 复测命令见 `docs/JEV_SMOKE_TEST_REPORT.md` 末尾。没验证：第 2 级 LocalJev、服务端 429/5xx 的熔断路径、Mac 上的耗时。

## M8 项目与目标基础设施（2026-10-03）

- 路由偏好沿用现有 `Preference`（`economy` / `balanced` / `best`），不按设计稿改成 `cheap`：路由评分算法和设置页都用这三个值，约束不许改评分算法。`routing_preference` 为 null 表示「沿用上级」，表单里的空串也按 null 处理。
- 目标比设计稿多 `instructions`、`routing_preference` 两个字段（继承链「任务 > 目标 > 项目 > 全局」要有目标这一层），`project_id` 可为 null（不属于任何项目的目标）。projects、memories 也加了 `deleted_at`：删除项目要连带软删除记忆。
- 完成校验（`src/decision/evidence.ts` + `DecisionLayer.checkDoneWithEvidence`）：规则判「完成」后目标直接收尾，所以规则只在每个可核对的条件（测试命令通过、点名的文件产出、点名的输出出现）都满足时判完成，其余交给 Jev 或用户。AI 自述（`claim`）不发给 Jev，只用来区分「声称完成但无实据」和「什么都没做」。发给 Jev 的是脱敏后的路径和命令输出末尾。
- Jev 的完成校验问句放在 `evidence.ts`，没放 `jev-config.ts`：后者按约束冻结。完成校验的 Jev 失败不计入路由的健康统计（只返回「Jev 调用失败，请你确认」）。
- 状态机在 `src/decision/goal.ts`：设计稿 8 条规则（「任意状态 → deleted」算一条），展开为 13 条合法转换。在这之外，多一个上限 `MAX_ROUNDS = 100`（防止每轮都「拿不准」、用户一直选继续时无限开轮）；运行出错（`failRound`）也计入连续失败；用户裁决的轮次不计入连续失败；预算用完但本轮「拿不准」时仍等用户，不直接判失败。暂停、放弃后迟到的执行记录还能补进被中断的那一轮。
- 存储：所有查询过滤 `deleted_at IS NULL`；删除项目时用同一个时间戳软删除目标和记忆。同一目标的读改写在进程内排队（`db-goal.ts` 的 `serial`），多窗口或多进程同时写不在保护范围内。单条记忆删除仍是硬删除（M8 没改）。
- 目标 store 单条写入后只替换这一条（运行时一轮里会写很多次），不整表重读；项目 store 删除后整表刷新，目标和记忆已加载过的一并刷新。
- 留给 M10：运行时接入 checkDoneWithEvidence（engine.ts 没改）；按项目挑选记忆；删除项目时中止它正在运行的目标；任务卡片的 mode 目前只记录，不影响执行。

## M9 界面 V3（2026-10-03）

- 依据 `docs/UI_LAYOUT_V3.md`，第 10 节 12 条都按「默认」实现（用户 2026-10-03 确认）。BRAND.md 只改了第 12 节「落地约定」里过程信息放哪的那一条（第 10 节第 5 条），其余品牌规范不动；图标栏 60 用 `w-[60px]` 并登记进 `tests/ui-lint.test.ts`，不新增 BRAND 变量（第 10 节第 1 条）。
- 菜单（`src/components/ui/menu.tsx`）和对话框（`ui/dialog.tsx`）自己写，没有装 Radix：依赖不变；键盘按 WAI-ARIA Menu Button 模式（↓ 打开、↓↑ 移动、Home/End、→ 子菜单、← / Esc 返回、关闭后焦点回触发按钮）。V3 第 11 节列的 Radix 包和 tauri-plugin-dialog 都没装。
- 下线：`Sidebar`、`TaskCanvas`、`TaskCard`、`TaskInput`、`RightPanel`、`AgentsPage`、`SettingsShell`、`SettingsPage`、`Placeholders`。专家模式不再切换布局，只决定路由浮层里是否显示内部评分、权重和成本档（设置 › 个人 › 常规）。旧的卡片拖拽排序、上移下移、关闭卡片随 TaskCanvas 一起下线，对应测试删除。
- 路由偏好：任务层只有「自动 / 省钱 / 最强 / 锁定」（V3 原样）。`tasks.submit` 用 M8 的 `preferenceSource` 按 任务 > 目标 > 项目 > 全局 取值，卡片上记下 `preference` 和 `preferenceSource`，浮层写明「平衡（来自全局设置）」。打分算法、`jev-config.ts` 没动。
- 右侧面板不自动打开：回答的成果块列出改动的文件（取自工具调用的 `step.args`，`src/lib/artifacts.ts`），点了才开；窗口 < 1180 时先收起内容栏、关面板后恢复。文件预览只走内置文件服务器已注册的只读工具（`previewFile`），没有修改前内容，所以「改动」只列文件、不显示逐行 diff。
- 目标模式提交只新建目标并打开详情；「开始」只改状态，多轮执行留给 M10。菜单只给状态机允许的转换（`canTransition`）：未开始的目标没有「放弃」。
- 价格表 `config/model-prices.json`（2026-10-03 逐家核对官方价目页：OpenAI、Anthropic、Google、DeepSeek、阿里云国际站、Kimi 国际站；来源和日期写在每一条里）。只取标准档，不含批量、缓存、Fast 模式；有时段价的（DeepSeek）按高峰价、有限时折扣的（qwen3.7-plus）按标价，都偏保守、写在 note 里；长上下文门槛按官方「整次请求」计价。能力矩阵和 cost_tier 不动。
- 「省 $X」口径（`src/lib/savings.ts`）：基准 = 同一分类、同一批可用模型（排除这次决策里被排除的）里按「最强」排第一的模型，本地 `route()` 计算，不多调 Jev；用实际 tokens 计价，所以写「约」；缺单价、缺用量的调用单独计数，不估、不当 0 元；比基准还贵时如实写「多花」。路由记录不完整时基准返回 null，不写金额。
- 没做（如实留空，不硬凑）：调用记录持久化、会话持久化（迁移 5）、系统文件夹对话框、工作目录写进文件服务器的允许列表、计划模式的「先出计划再确认」回调。工作目录目前只作为上下文告诉模型；计划模式只记 `mode: plan`。
- 测试：首屏控件数按区域核对（5 + 4 + 4 + 3 = 16）；10 组变异（偏好不按项目继承、拿不准时自动开下一轮、面板自动弹出、非专家显示内部评分、删除项目不二次确认、首屏多一个控件、搜索框常驻、Ctrl+Enter 不发送、窄窗口不收内容栏、撤掉改动列表）都会让测试失败。

## 通用

- Git（2026-10-02 起）：远端仓库 https://github.com/ChaoYuZhang001/eastgenesis，历史以 GitHub 为准（2026-10-02 首次推送时压成了一个提交 `fa69b1b`）。Mac 上的权威目录是 `EastGenesis-clean`。VM 不能 push（没有 SSH Key），也不需要：VM 从 GitHub clone 到临时目录、提交，再由用户同步到 Mac 后 push。项目目录是 FUSE 挂载，不能删除文件，git 不能直接在里面运行。
  - 旧流程（到 2026-10-02 为止）：每次提交后导出 `eastgenesis.bundle` 到项目根目录，Mac 副本 `EastGenesis-repo/` 从 bundle pull。2026-10-03 用户说「不要导出 bundle，我从 GitHub 拉取」，VM 的提交怎么交给用户，由用户决定。
  - `Cargo.lock` 从 2026-09-30 起在 VM 里生成并提交（VM 已能连上 crates.io），Mac 端不再生成或提交。改了 Rust 依赖就在 VM 里更新它，检查 macOS 目标后和 Cargo.toml 一起提交，方法见「Mac 首次编译修复」。Mac 副本里有未跟踪的同名文件时，pull 会中止（已实测），要先删掉。
- 锁文件：同步是「挂载目录 → /tmp」单向进行的，所以在 /tmp 里改过的 `pnpm-lock.yaml`、`Cargo.lock` 必须复制回挂载目录，否则下次同步会被旧版本覆盖。M3 新增的依赖就是因为这个原因没写进锁文件，到 M5 才补上。
