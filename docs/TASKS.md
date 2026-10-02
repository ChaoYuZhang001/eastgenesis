# EastGenesis 品牌资产拆分 · 任务进度

> 规则：每完成一步即更新本文件。原图 `assets/brand/brand-board.png` 只读，不执行 rm / git push。

| # | 步骤 | 状态 | 备注 |
|---|------|------|------|
| 1 | 探查项目结构与工具链，记录原图指纹 | 完成 | 项目目前只有 brand-board.png，没有 CLAUDE.md、package.json 和 src-tauri。原图 SHA-256 改由提取脚本在运行前后各算一次，写入 manifest.json |
| 2 | 编写识别与裁剪脚本（Pillow） | 完成 | 三个脚本：`extract_brand_assets.py`（识别、裁剪、抠图、icon-1024、取色）、`gen_platform_icons.py`（tauri icon，含 Pillow 兜底）、`verify_brand_assets.py`（自检与目检拼图）。已通过 py_compile |
| 3 | 运行脚本：导出资产、icon-1024、品牌色 HEX | 完成 | 首轮导出 39 个文件，原图 SHA-256 前后一致（`a4f8dbf3…`），BRAND.md 4.4 节已回填。目检发现的抠图缺陷在步骤 5 修正后重新生成 |
| 4 | tauri icon 生成各平台图标 | 完成 | `npx @tauri-apps/cli@2.5.0` 执行成功，生成 50 个文件（桌面端，以及 CLI 附带的 android/、ios/） |
| 5 | 自检裁剪结果并迭代修正 | 完成 | 修正三处：白字抠图保留金色 i 点；深色底抠图改为逐行估计夜空底色并去除孤立星点，主视觉包围盒不再被星点撑大；icon-1024 底色改为对板上彩色图标做平面拟合。自检新增金色 i 点、孤立噪点、icon-1024 与板上图标一致性三类检查。最终自检：通过 61、警告 1（logo-dark 外圈含地平线辉光，属预期）、失败 0 |
| 6 | 编写 docs/BRAND.md | 完成 | 11 节全部写完，4.4 节已由脚本回填。按实测值校正 4.2 节：图标底色方向、产品界面主区与侧栏的明暗，原估计都与品牌板相反，已改正。4.3 节补充深色表面对比度（东方红在主区底上不足 3:1）；第 10 节补充母版底色做法和 android/、ios/ 附带产物的说明 |
| 7 | 更新 CLAUDE.md（品牌规范纪律） | 完成 | 原文件不存在，已新建：项目说明、品牌规范纪律 10 条、工作纪律 |
| 8 | 最终验证与报告 | 完成 | 三个脚本按顺序重跑：自检失败 0，品牌板 SHA-256 不变。89 个输出文件中 88 个与上一轮逐字节一致；icon.icns 只是块的写出顺序不同（tauri CLI 每次顺序不固定），12 个块的内容一致。放大目检拼图、icon-1024 和平台图标，没有噪点或截断 |

## 里程碑

| 里程碑 | 状态 | 备注 |
|---|---|---|
| M1 脚手架 + 品牌落地 | 完成 | Vitest 10/10、cargo test（eg-core）8/8、tsc、vite build 均通过。Tauri 外壳在 VM 中无法编译（缺 webkit2gtk），需要在 Mac 上运行 `pnpm tauri dev` 验证 |
| M2 LLMProvider + CLI | 完成 | 接口 + OpenAI、Anthropic 适配器 + openai-compatible 自定义端点 + `pnpm eg` CLI。Vitest 38/38（全部用假 fetch，未调用真实 API） |
| M3 路由规则引擎 + Jev 决策层 + 三级降级 | 完成 | 能力矩阵 22 条；规则分类器盲测路由准确率 86.0%；多因子评分与降级链；Jev 客户端（官方 SDK）；三级降级与 6 个决策接口。Jev 和模型 API 全部 mock，未调用真实服务 |
| M4 Agent 运行时 | 完成 | 运行时（规划、执行、反思、错误恢复、预算、取消）、权限闸门与用户确认、MCP 客户端（stdio、白名单、信任策略）。新增 30 条测试，含真实子进程的 MCP 端到端测试；模型全部 mock |
| M5 桌面 UI | 完成 | 启动页；三区主界面：侧栏、任务画布与卡片工作空间、执行时间线、路由面板、手动干预；设置页：路由策略、能力矩阵、自定义 Provider、API Key，MCP 与记忆先留结构；浏览器 mock 模式 `pnpm dev:web`；密钥与 MCP 进程迁到 Rust。Vitest 211/211、tsc、vite build、eg-core cargo test 21/21 均通过。Tauri 外壳需要在 Mac 上按 `docs/M5_MAC_HANDOFF.md` 验证 |
| M6 适配器、记忆、技能、多 Agent | 完成 | 已完成：其余 5 家官方适配器（Gemini、DeepSeek、通义千问、Kimi、Ollama）、地域选择、Ollama 开关；自定义 Provider 完整支持（OpenAI / Anthropic 协议、多模型、模型发现、能力参照）；MCP 服务器登记（mcp.json 只读登记表、钥匙串引用、Rust 侧消息白名单）；记忆系统（SQLite memories 表、用户确认才保存、按目标挑选、时间线可见）；技能库（SQLite skills 表、从完成的任务保存、规划时参考、时间线可见）；多 Agent 协同（拆成 2–4 个子任务、最多 2 个并行、确认排队、合并成果、子 Agent 面板）；本地决策模型 LocalJevBackend（第 2 级，只限本机服务，默认不用）。Vitest 308/308、eg-core cargo test 46/46 |
| M7 端到端测试与交付 | 完成 | 端到端测试（jsdom 渲染完整 App，3 条用户路径）、智能行为验收（9 项）、对标基准表 `docs/BENCHMARK.md`（5 款竞品 14 个维度，只用官方来源；内部基准：智能路由对比固定模型）、README、`DELIVERY.md`。Vitest 331/331、tsc、vite build 均通过。桌面外壳和未签名打包（.app、.dmg）已在 Mac 上通过；真实 API 和真实服务需要在 Mac 上按 `docs/M5_MAC_HANDOFF.md` 验证。验收标准和清单见 `DELIVERY.md` |
| 界面重构 + 真实 API 测试 | 完成 | 对话式首屏（会话列表 + 输入框，首屏交互元素 ≤ 12）、权限三档、输入框锁定模型、可折叠路由行、渐进式执行；旧三区面板收进专家模式。中转站兼容。真实 API 测试 19/19，报告 `docs/REAL_API_TEST_REPORT.md`（脱敏）。之后按用户决策：默认超时 90 秒、/models 探测隐藏 404 模型、思考过程折叠展示、降级标明「因超时」 |
| 杀手场景：整理下载文件夹 PDF | 完成 | 第 1–7 步全部完成。工具：内置文件与 PDF 工具服务器（Rust，JSON-RPC + stdio，9 个工具），写操作确认、删除二次确认、服务器白名单、子进程不继承 Key、输出按不可信数据包裹。场景：`tools/killer-scenario-test.sh --real` 9 项全过，报告 `docs/KILLER_SCENARIO_REPORT.md`（没有凭据，模拟模型 + 真实工具）。简单问答只调一次模型；思考过程默认不显示，只给摘要；路由面板只留人话。记忆：「我偏好简洁输出」提出偏好记忆，下一次回答的系统提示带上它。技能：保存时只读步骤带参数，「再整理一次」直接执行，测试里用时为第一次的 26%。真实模型的耗时和偏好遵循没有验证 |
| Jev 集成 | 完成 | 2026-10-02 两轮真实 Key 验证：choice 冒烟 30/30；54 条独立盲写 hold-out 降级 11.1%、整条链 96.3%（规则引擎单独 81.5%），50 条训练集 100%；tool_use 问句改成 v2（附件已提供、读它不算动作）后误报 27 → 0。按 TypeSafe 官方 skill 复盘：保留一个请求并行问三问（fan-out），置信度只计入会改变结果的判断。**P50 328ms 未达 300ms**（VM 裸往返 P50 250ms），待 Mac 复测。剩余 2 条错是能力标签粒度问题（单标签装不下 code+reasoning），已如实记录。报告 `docs/JEV_SMOKE_TEST_REPORT.md` |
| 发布阶段（后期） | 未开始 | 签名、公证、自动更新、分发 |

## 日志

- 2026-09-29 M1：初始化 Tauri 2 + React 18 + TS + Vite + Zustand + Tailwind + shadcn/ui + tauri-plugin-sql + Vitest。品牌主题由 BRAND.md 生成，启动页按第 6 节实现。关键决策记在根目录 MEMORY.md。测试挂载目录时误留了 `.symtest`、`.fstest2` 和 `.dirtest/`（挂载目录不允许删除），已加入 .gitignore，需要用户手动删除。
- 2026-09-29 M2：LLMProvider 接口、OpenAI / Anthropic 适配器（chat + SSE 流式）、openai-compatible 自定义端点、密钥引用（env / keychain 命名空间）、错误映射与脱敏、`pnpm eg` CLI。修正 redact 把 `Bearer` 方案名一并遮掉的问题。真实 API 调用未验证（VM 中没有 Key）。
- 2026-09-29 M3：能力矩阵 `config/model_profiles.json`（22 条）及校验；第 3 级规则分类器；50 条独立盲写的路由测试集。盲测路由准确率 86.0%，达到 70% 的目标。
- 2026-09-29 M3 完成：
  - 路由：多因子评分、降级链执行与熔断。
  - Jev：客户端封装官方 SDK `@typesafe-ai/sdk@0.6.0`；三级降级（云端 Jev → 本地占位 → 规则）。
  - 决策层：routeTask、chooseTool、checkDone、gateAction、evaluateResult、replan。
  - CLI：新增 `pnpm eg route` 和 `pnpm eg eval-routing`。
  - 待校准：quality_tier 和 latency_tier 是估计值，因为 benchmark 页面读不出数据。
- 2026-09-29 M4 完成：
  - 运行时：路由 → 规划 → 逐步执行（权限闸门、确认、超时）→ 反思 → 错误恢复（retry / modify_step / new_plan / ask_user / abort）→ 汇总，受步数、重试、重规划、模型调用预算约束。
  - MCP：自己实现的最小客户端和 stdio 传输；工具白名单；默认不信任服务器标注；子进程不继承 API Key。
  - 未做：CLI `eg agent` 命令；UI 接入留到 M5。
- 2026-09-29 M5 完成：
  - 提交：7fa15df（密钥与 MCP 进程迁到 Rust）、2ade56a（Tauri / mock 双模式后端）、fc4be00（引擎组装）、7421720（主题生成）、5a8f202（设置与任务 store、时间线）、d1804e0（设置页）、0a70f96（三区主界面）、f4f63d8（补齐 pnpm 锁文件）。
  - 未验证：src-tauri 在 VM 里编译不了（缺 webkit2gtk）。keyring 的 feature 名、钥匙串弹窗、WKWebView 里的拖拽都要在 Mac 上确认。VM 连不上 crates.io，Cargo.lock 由 Mac 首次编译生成。
  - 已知限制：
    - mock 没有 SSE 流式；Rust 代理整体缓冲响应。
    - 取消任务不会中断正在进行的 Rust 请求。
    - `mcp_start` 仍然可以启动任意命令，M6 改为只能启动登记过的服务器（M6 已完成）。
    - 窗口最小宽度下展开面板，画布只剩约 400px。
  - 修正：M3 新增的 `@typesafe-ai/sdk`、`tsx` 一直没写进 pnpm 锁文件。原因是同步单向，/tmp 里更新过的锁文件被挂载目录的旧版本覆盖。已补齐，并用 `--frozen-lockfile` 校验。
- 2026-09-29 M6 官方适配器：
  - Google Gemini、DeepSeek、通义千问、Kimi、Ollama 接入。除 Anthropic 外都走 OpenAI 兼容端点，各家差异（参数名、采样参数、流式用量）集中在 `src/core/llm/official.ts`。
  - Rust 白名单按同一张表放行，通义千问和 Kimi 各放行中国站、国际站两个地址。新增测试直接读 providers.rs，比对两边的地址。
  - 设置页：通义千问、Kimi 可以选地域；Ollama 不需要 Key，默认不参与路由，打开开关后才会被选中。CLI 用 `EG_OLLAMA=1`。
  - 验证：Vitest 228/228（act 警告 0）、tsc、vite build、eg-core cargo test 23/23。
  - 未验证：真实 API 调用（VM 中没有 Key）；百炼兼容模式是否提供 `/models`（「测试连接」遇到 404 时会说明可能的原因，不当成 Key 错误）；src-tauri 仍需在 Mac 上编译。
- 2026-09-29 M6 自定义 Provider 完整支持：
  - 协议：可选 OpenAI 兼容或 Anthropic 兼容。Rust 按协议决定鉴权头和放行路径，旧配置默认按 OpenAI 处理。
  - 多模型：每个模型都参与路由（上限 32 个）。和内置型号同名的沿用内置能力档位，并在列表和能力矩阵里标出参照来源。
  - 模型发现：经代理读取 `/models`，结果作为输入候选。CLI 新增 `--protocol`。
  - 验证：Vitest 235/235（act 警告 0）、tsc、vite build、eg-core cargo test 24/24。真实中转站未验证。
- 2026-09-29 M6 MCP 服务器登记：
  - 服务器登记在应用配置目录的 `mcp.json`，只由用户编辑。`mcp_start` 只接受服务器 ID，webview 启动不了登记表以外的命令。
  - 密钥写成 `${keychain:NAME}` 或 `${env:NAME}`，明文密钥拒绝登记。钥匙串账户 `mcp/<服务器>/<NAME>`，与 Provider 和 Jev 的 Key 分开；模型 Provider 和 Jev 的 Key 不提供给 MCP 服务器。
  - Rust 侧按启动时的 allowTools 再查一遍发出的消息。
  - 设置页「MCP 服务器」：查看登记表和出错条目、启停、保存密钥、列出注册与未注册的工具、查看 stderr。已连接服务器的白名单工具进入任务。
  - 验证：Vitest 243/243（act 警告 0）、tsc、vite build、eg-core cargo test 45/45，其中包括真实子进程测试：密钥只传给子进程、Provider Key 不泄露、白名单拦截。
  - 未验证：src-tauri 的新命令要在 Mac 上编译；真实 MCP 服务器（npx 等）在 macOS 应用环境下的 PATH 行为。
- 2026-09-29 M6 记忆系统：
  - 存储：迁移 2 新建 memories 表（偏好 / 事实），前端经 tauri-plugin-sql 读写，浏览器模式存内存。最多 200 条，每条最多 500 字，像密钥的内容拒绝保存。
  - 写入只有两条路径：设置页手动添加；任务目标里说「记住……」「以后都……」时，在卡片上确认。工具和 MCP 的输出不会写进记忆。
  - 使用：任务开始时带上全部偏好（最多 8 条）和与目标有词重叠的事实（最多 5 条），放进规划、回答、总结的系统提示。时间线显示「参考了 N 条记忆」，设置页显示每条用过几次。
  - 验证：Vitest 261/261（act 警告 0）、tsc、vite build、eg-core cargo test 46/46。迁移和 7 条记忆 SQL 用 Python sqlite3 3.37.2 实际执行过，含 CHECK 约束。
  - 未验证：tauri-plugin-sql 在 Mac 上执行迁移 2 和这些语句。
- 2026-09-29 M6 技能库：
  - 存储：迁移 3 新建 skills 表，步骤存 JSON。只保存子目标和工具名，不保存参数。最多 100 个，每个 1–12 步。
  - 保存：完成的任务卡片上「保存为技能」，预填实际做完的步骤（跨重新规划累计，失败、被拒绝的步骤不算），保存前可以修改。设置页也能添加、编辑、两步删除。
  - 使用：规划时挑出与目标至少两个词重叠的技能，最多两个，只放进规划提示，并注明「不适用就忽略」。时间线显示「参考了 N 个技能」，设置页显示被参考过几次。
  - 验证：Vitest 275/275（act 警告 0）、tsc、vite build、eg-core cargo test 46/46。迁移 3 和 7 条技能 SQL 用 Python sqlite3 实际执行过，含 CHECK 约束。
  - 未验证：tauri-plugin-sql 在 Mac 上执行迁移 3。
- 2026-09-29 M6 多 Agent 协同：
  - 协调器：用户勾选「多 Agent 协同」后，先把目标拆成 2–4 个互不依赖的子任务，每个交给一个子 Agent（完整的 AgentRuntime，独立路由、规划和纠错），最多同时 2 个，最后由模型合并成果。拆分结果无法解析时改为单个智能体执行。
  - 安全与透明：确认排队，一次只请用户处理一个，并标明来自哪个子 Agent；子 Agent 的成果作为不可信数据交给合并模型。时间线的子 Agent 条目带角色前缀，任务卡片每个子 Agent 一行，右侧「子 Agent」面板显示状态、模型和当前步骤。
  - 容错：合并失败时拼接已完成的成果，并列出没完成的子任务；全部没完成时不合并，逐个说明状态；取消后排队中的确认视为不同意。
  - 验证：Vitest 290/290（act 警告 0；新增协调器 9 项、展示数据 5 项、界面 1 项）、tsc、vite build、eg-core cargo test 46/46。
  - 未验证：真实模型的拆分质量；Mac 上两个子 Agent 同时经 Rust provider_request 发请求的表现。
- 2026-09-29 M6 本地决策模型（LocalJevBackend，第 2 级）：
  - 设置：「系统与工具 → API Key」下新增「本地决策模型」，默认不使用。只能选本机服务的模型（Ollama，或地址在本机的自定义 Provider），任务内容不离开本机；和「让路由使用本机 Ollama」互不影响。
  - 判断：分类、选工具、是否完成、风险、结果评分、纠错策略都要求固定格式的 JSON。解析失败或取值不合法算失败，自报置信度最多记 0.8，低于阈值 0.6 也交给规则引擎，路由面板写明原因。
  - 安全：任务内容和工具输出放进标注不可信的 <data>，发送前脱敏、截断，去掉伪造的标签；权限闸门仍以白名单和规则为先，本地模型只能把只读操作收紧为需要确认。单次 8 秒超时，连续失败 3 次熔断；用户取消不算失败。
  - 修复：健康记录全应用共用，但停用记录从来没有被清除过。Key 填错一次，改对以后这个 Provider 仍然显示「已停用」，要重启应用才恢复。现在保存 Key、切换地域、保存自定义 Provider、重新选择本地决策模型成功后，会清掉对应的停用和熔断记录（stores/health.ts、HealthTracker.resetProvider）。
  - 验证：Vitest 308/308（act 警告 0；新增 18 项：本地决策模型单元 8、降级链与组装 6、界面 2、健康记录 2）、tsc、vite build、eg-core cargo test 46/46（Rust 未改动）。反向验证 7 项，改坏后都有测试失败：去掉标签中和、置信度上限、脱敏、本机限制；健康记录的 Provider 名边界、自定义 Provider 与本地模型的对应、保存 Key 后清记录。
  - 未验证：真实 Ollama 模型的延迟和 JSON 遵从度（首次加载模型可能超过 8 秒）；Mac 上经 Rust provider_request 请求本机服务的表现。
- 2026-09-29 M7 端到端测试与智能行为验收：
  - 端到端（tests/e2e-journeys.test.tsx）：VM 里没有浏览器和 webkit，改在 jsdom 里渲染完整 App，接模拟后端。三条路径：配置 Key → 提交 → 确认写入 → 成果、路由理由、时间线 → 保存为技能；偏好、能力矩阵、本地决策模型、记忆、技能在重启后读回；所有模型不可用时如实标为失败。每条都检查 Key 不出现在页面和设置里、控制台没有输出。
  - 验收（tests/acceptance.test.ts，用 createEngine 组装完整引擎）：按能力选模型、偏好生效、首选出错换模型、先检索后写入、拒绝写入、超时重试、注入指令不执行、工具输出里的密钥脱敏且请求不带 Key。
  - 验收发现并修复三处：① 全部模型失败时卡片只写「4 个模型都没有成功」，现在逐个写明模型和中文原因；② 换模型后时间线只显示实际用的模型，看不出首选失败过，现在标成提醒并写明先试了谁、为什么没用上；③ 路由在任务开始时算好，同一任务后面的调用仍会先等已熔断的模型失败，现在调用前先看健康记录，已熔断或停用的直接跳过（链上最后一个照试）。
  - 记录在案、没有改：规则引擎（第 3 级）评估只读操作时只看文字，参数里有「保存」「删除」之类的词就改为需要确认，例如检索「整理本周会议纪要并保存」也要确认。这是放宽权限的改动，留给用户决定；验收测试固定了现状。
  - 验证：Vitest 322/322（act 警告 0；新增 14 项：验收 9、端到端 3、降级链 2）、tsc、vite build（lookbehind 0、Object.hasOwn 0）。Rust 未改动。反向验证 10 项，改坏后都有测试失败：不看健康记录、最后一个也跳过、原因显示错误码、用 in 判断错误码、降级记录没传到回复或事件、时间线不标提醒、不改伪造标签、工具输出不脱敏、失败信息不列模型。
  - 未验证：真实浏览器和 Tauri webview 里的表现（Mac 上按 docs/M5_MAC_HANDOFF.md 验证）；真实模型下的拆分、规划和注入抵抗。
- 2026-09-29 M7 对标调研 Cherry Studio：
  - 来源：只用官方资料，共 12 页（GitHub 3 页：README、releases/latest、Releases 列表；官方文档 9 页，docs.cherry-ai.com 跳转到 docs.cherryai.com.cn），没有用第三方评测。
  - 结论：多模型、自定义端点、本地模型、MCP、工具调用确认、记忆、技能与模板、多 Agent 都是「支持」。智能路由、自动降级、路由可视化在官方资料里「未查到」（能查到的是多 Key 轮询，以及流中断时显示可重试错误）。API Key 默认存在本机、不做云端同步，是否用系统钥匙串未查到。社区版 AGPL-3.0。桌面端最新 v2.1.3（2026-09-24）。
  - 注意：releases/latest 指向仓库里的子包 remote-transport@0.1.1，不是桌面端版本。
  - 结果目前只以表格形式写在对话里，还没有写进仓库文件，之后汇总进对标基准表。
- 2026-09-29 M7 对标调研 ChatGPT 桌面端：
  - 来源：只用官方资料，共 12 页（help.openai.com 10 页、chatgpt.com 下载页 1 页、learn.chatgpt.com 的 Codex 配置文档 1 页；帮助中心的 Codex 更新日志文章跳转到 learn.chatgpt.com），没有用第三方评测。
  - 背景：7 月 9 日起（页面未写年份），新桌面端把 Chat、Work、Codex 合成一个应用，macOS 和 Windows 都有；旧 macOS 应用改名 ChatGPT Classic，继续维护。
  - 结论：MCP、工具调用确认、记忆、技能与模板是「支持」，其中记忆、技能与模板、应用权限是账户通用。多模型、自定义端点、本地模型、多 Agent 是「部分支持」，只能在 Codex 的本地 config.toml 里配置（model_providers、openai_base_url、`--oss` 接 Ollama / LM Studio、`[agents]` 子 Agent）；Chat / Work 的模型选项里只有 OpenAI 自家模型。智能路由是「部分支持」：选 Instant 时会自动加推理，但只在 OpenAI 自家模型之间。自动降级、路由可视化「未查到」，能查到的只有同一 Provider 的重试次数。以账户登录为主，Codex 可以选用自己的 API Key。许可证未查到。版本：macOS 26.924.20706（2026-09-25 安全更新），Windows 版本号未查到，Codex CLI 0.158.0（2026-09-28）。
  - 注意：`--oss` 的说明是按 CLI 写的；config.toml 里的自定义 Provider 能不能在桌面端 Codex 界面里选，文档没写明。Windows 帮助文章还是早期版本的说明。
  - 结果目前只以表格形式写在对话里，还没有写进仓库文件，之后汇总进对标基准表。
- 2026-09-30 M7 对标基准表：
  - `docs/BENCHMARK.md` 第 1 节：Cherry Studio、LobeChat、Chatbox、Claude Desktop、ChatGPT 桌面端 14 个维度的功能对标，只用官方来源（列在节末）。上面两条调研日志里只写在对话中的结果已汇总进来。
  - 第 2 节内部基准（`src/decision/bench.ts`，`pnpm eg bench`）：50 条标注样例，两个场景（A：OpenAI + Anthropic；B：6 家云端官方 Provider），比较智能路由（平衡、省钱）和固定旗舰、固定最便宜。只跑分类和路由，不调用模型；能力是否满足以人工标注为准。场景 B：平衡的平均成本档 1.98，固定旗舰 4.00；全部能力满足 98% 对 100%；首选 Provider 故障后仍可完成 100% 对 0%。
  - 测试：tests/bench.test.ts 8 项（文档表格与命令输出逐字一致、只配一家 Provider 时如实记 0%、分类器漏判时按标注扣分、停用模型不参加等），cli.test.ts 新增 bench 命令 1 项。修正了上一轮 bench.test.ts 的类型错误（未使用的导入、非 async 函数里用 await），测试名改为中文。
  - tsconfig.json 去掉 baseUrl，paths 改为 `./` 开头：TS 5.7.3 下行为不变，也兼容移除 baseUrl 的新版 TypeScript。
  - 验证：Vitest 331/331（act 警告 0）、tsc、vite build（lookbehind 0、Object.hasOwn 0）；`pnpm eg bench` 输出与文档一致，`pnpm eg eval-routing` 仍是 86.0%。反向验证 12 项，改坏后都有测试失败：能力判断用 some、硬性能力不筛选、接手不要求换 Provider、接手不要求满足硬性能力、固定模型算有备选、旗舰排序反向、最便宜排序反向、可用性不看场景、省钱行跑平衡偏好、成本档取质量档、池子不排除停用模型、成本档少一位小数。第一轮有 2 项没抓到（当前数据下等价），补了漏判视觉、停用模型两条合成用例后都能抓到。
  - 未验证：Rust 没有改动，这次没有重跑 cargo test（VM 的 /tmp 重置后没有 Rust 工具链，crates.io 连不上）。
- 2026-09-30 M7 完成：
  - README：项目简介、开发命令、密钥环境变量、目录。DELIVERY.md：各里程碑交付内容、VM 已验证项、Mac 待验证项、已知限制、发布阶段（全部未开始）。
  - 补 `docs/BRAND.md` 第 12 节「界面设计原则」：透明度优先、成果驱动、路由可视化。这是 M1 就要求的内容，之前漏写了；每条都对应到已有组件，没有改界面代码。`pnpm brand:theme` 重跑后生成文件不变。
  - `docs/M5_MAC_HANDOFF.md` 加上未签名打包 `pnpm tauri build`。
  - 验证：Vitest 331/331（act 警告 0）、tsc、vite build，品牌自检通过 61、警告 1、失败 0。README 里的命令行示例在没有 Key 时实际跑过。
- 2026-09-30 修复 Mac 首次编译失败：
  - 现象：Mac（Intel，rustc 1.98.1，清华镜像）上 `pnpm tauri dev` 和 `pnpm tauri build` 都在编译 tauri-build 2.2.0 时报同样两个 E0061：acl.rs:440 调 `generate_allowed_commands` 少了 capabilities 参数，lib.rs:531 调 `external_binaries` 少了 Target 参数。
  - 原因：Cargo.toml 里的 `=` 只固定了顶层 crate。tauri-build 2.2.0 对 tauri-utils 写的是 `2.4.0`（即 `^2.4.0`），仓库里又没有 Cargo.lock，Mac 解析到了 tauri-utils 2.10.0，这两个函数的参数已经变了。VM 里用同样的版本组合复现出同样两处报错。
  - 修复：Tauri 整组升级到同一次发布：tauri 2.12.0、tauri-build 2.7.0、tauri-plugin-sql 2.5.0；npm 侧 @tauri-apps/api、@tauri-apps/cli 2.12.0，@tauri-apps/plugin-sql 2.5.0（CLI 会检查 Rust 包和 npm 包是否配套）。tauri 2.12.0、tauri-build 2.7.0 对内部 crate 用 `~`，只在补丁版本内浮动。rust-version 改为 1.90（tauri、tauri-build、tauri-utils 的要求）。工作区的 serde、serde_json 也要升级，因为新依赖要求 serde ≥ 1.0.228（cargo_toml 1.0.1）、serde_json ≥ 1.0.151（serde_with 3.24.0）；thiserror 顺带升到 2.0.21。新增 Cargo.lock，在 VM 里对照 crates.io 官方索引生成，每个 tauri crate 只有一个版本。pnpm-lock.yaml 只改了 @tauri-apps 相关条目。
  - 验证：`cargo check --locked --target x86_64-apple-darwin -p eastgenesis-desktop` 0 错误、0 警告（VM 没有 macOS SDK，编译 C 代码的依赖用空桩代替，不链接）；`cargo fetch --locked` 走清华镜像，校验和与 Cargo.lock 一致；`cargo test --locked -p eg-core` 46/46；`tauri.conf.json`、`capabilities/default.json` 通过 JSON Schema 校验；`pnpm tauri info` 显示版本配套；Vitest 331/331、tsc、vite build。
  - 未验证：macOS 上的链接和运行、WKWebView、钥匙串、运行时的 SQLite 迁移，要在 Mac 上按 `docs/M5_MAC_HANDOFF.md` 验证。Mac 副本里第一次编译留下的未跟踪 Cargo.lock 要先删掉再拉取，步骤写在交付清单第二节。
  - 没有改：`scripts/brand/gen_platform_icons.py` 仍用 `@tauri-apps/cli@2.5.0` 生成图标。图标已经生成并提交，换版本重跑会无故改动品牌产物。
- 2026-09-30 Mac 第二次编译（副本在 8c4307d）：
  - `pnpm tauri dev`：编译 59.6 秒，0 警告，链接出 x86_64 Mach-O（target/debug），启动后没有 panic 或非零退出。窗口内容日志里看不到，待用户目测。
  - `pnpm tauri build`：release 4 分 05 秒，0 警告；.app 完整（可执行文件、icon.icns、Info.plist，标识 com.eastgenesis.desktop，0.1.0）。.dmg 失败，日志只有「error running bundle_dmg.sh」。
  - 定位：bundle/macos 里留下了 create-dmg 的临时镜像 `rw.<pid>.*.dmg`，按 HFS+ 目录记录还原出时间线。14:35:38 开始写镜像；14:35:41 建「应用程序」链接和卷图标（SetFile 成功）；14:35:44 Finder 写出 .DS_Store，但里面只有版本记录，没有窗口大小和图标位置；14:37:44 卷干净卸载，脚本退出。说明 AppleScript 让 Finder 排版窗口时卡住约两分钟后失败，脚本卸载卷后以 64 退出。具体卡在哪条 Finder 命令，日志里看不出来。
  - `git status --short` 没有输出（在 VM 里通过共享文件夹读取，不刷新 index）；Cargo.lock 与提交逐字节一致，日志里没有 Updating/Locking，cargo 直接用了提交的锁文件。
- 2026-09-30 修复 DMG 打包：
  - 新增 `pnpm tauri:build:mac`（`CI=true tauri build`）。依据 tauri-bundler 2.10.0 源码（tauri-cli 2.12.0 固定依赖它）：`CI` 等于 `true` 时给 bundle_dmg.sh 加 `--skip-jenkins`，不再调用 Finder。镜像本来就用 `-nobrowse` 挂载，跳过后 create-dmg 其余步骤都不需要图形界面。
  - 副作用：tauri-cli 2.12.0 里 `CI` 另外只用于跳过交互提示，以及更新包签名时的默认密码；本项目没开 createUpdaterArtifacts。依赖 crate 的源码（VM 里为 macOS 目标下载的那批）和本仓库都不读 `CI`。
  - 取舍：DMG 窗口改为 Finder 默认排列，没有自定义图标位置和隐藏扩展名；内容不变。安装窗口排版留到发布阶段，已写进 DELIVERY.md「已知限制」。
  - 验证（VM）：临时把 beforeBuildCommand 换成打印 `$CI` 后退出，`pnpm tauri:build:mac` 下子进程看到 `CI=true`，直接 `pnpm tauri build` 时为空；`CI=1`、`CI=TRUE` 会被 CLI 当作非法值拒绝，所以脚本写 `true`。Vitest、tsc 重跑通过。
  - 未验证：Mac 上 `pnpm tauri:build:mac` 能否生成 .dmg、打包版能否启动。交付清单第二、四节已改用新命令。
- 2026-09-30 Mac 第三次打包（副本在 f221a44）：
  - `pnpm tauri:build:mac`：release 2 分 46 秒，0 警告；日志显示「Finished 2 bundles」，生成 .app（10.74 MiB）和 `EastGenesis Desktop_0.1.0_x64.dmg`（6.21 MiB，6,507,147 字节，zlib 压缩）。日志里没有报错和警告。
  - 用户目测：`tauri dev` 窗口正常出现；从 .dmg 安装后启动，启动页正常淡出，侧栏底部显示「SQLite · 结构版本 3」，没有「模拟后端」标记。`git status --short` 没有输出。
  - DELIVERY.md 的 Mac 表全部改为通过，「待在 Mac 上验证」只保留需要真实 Key 和真实服务的项目。
  - SPEC.md：查了 git 全部历史（32 个提交里没有任何路径含 SPEC）、项目目录、上传目录和会话记录，仓库和会话里都没有这个文件。M5 的任务说明引用过「SPEC 第 11.3 节」，当时已说明找不到，按任务说明里的数值实现。验收标准并入 DELIVERY.md 的「验收标准」一节，不单独建 SPEC.md。品牌规范和 BRAND.md 第 12 节界面设计原则没有改动。
- 2026-09-30 界面重构（844fbef、d3dede7、7e2249c、5b15763）：
  - 依据实测反馈，对照竞品布局写了 `docs/UI_LAYOUT_SPEC.md`。首屏改成对话式，只保留会话列表和输入框；画布、时间线、路由面板收进专家模式。
  - 输入框新增三项：权限三档（完全访问、变更前确认、只读），模型选择（官方模型来自能力矩阵，中转站模型来自 /models 缓存），锁定模型后跳过路由。
  - 路由行默认折叠，不显示评分和成本档位；降级时写出具体模型名。执行过程逐步显示，完成后折叠成「已完成 · N 步 · 耗时」。
  - 中转站兼容：超时可以配置；「测试连接」显示模型数量和实测延迟；模型列表可以手动刷新。
  - DELIVERY.md 第 33 行「三区布局」改为「专家模式下满足」，验收标准文字没有改动。
- 2026-09-30 真实 API 测试：
  - 新增 `tools/real-api-test.sh` 和 `tools/real-api-test.ts`。默认跳过，带 `--real` 才运行；可以用 `EG_REAL_ONLY` 只跑其中几项。
  - 结果 19/19，覆盖三部分：
    - 适配器：对话、SSE、401、404、429、5xx、超时、错误地址。
    - 降级：各种失败原因都能写明，最后落到具体模型。
    - 引擎：自动路由、锁定、MCP 白名单。
  - 发现两点：
    - 中转站延迟波动大。deepseek-v4-pro 有时 60 秒以上没有首字节，R03 和 R05 都是先超时后重跑通过。
    - gpt-5.5 出现在 /models 列表里，但调用返回 404。
  - 凭据只放在仓库外的临时文件里，测试后已删除，项目里 grep 不到。
  - 未覆盖：Tauri 编译、真实桌面交互、钥匙串。
- 2026-09-30 首屏五项已由用户确认。按用户的三项决策和两项遗留修改：
  - 默认超时从 60 秒改为 90 秒，设置页可调（30 到 150 秒）。R05 的 120 秒只用在测试脚本里，应用不跟着放宽。
  - /models 读取后做轻量探测：每个模型发一个 max_tokens 1 的请求。返回 404 或 model_not_found 的模型不出现在下拉里；超时、5xx 不算。全部 404 时判为地址可疑，不隐藏。设置页写明隐藏了哪几个模型。
  - 推理模型的 reasoning_content 单独保存成「思考过程」，回答区默认折叠，点开才看，不进上下文。
  - 超时引起的降级在路由行、降级记录、专家时间线里都写「因超时降级」。
  - 只用 mock 验证（新增 tests/ui-assistant-turn.test.tsx 和探测、思考过程、超时降级的单测）；凭据已删，没有在中转站上重测。
- 2026-10-01 杀手场景第 1 步：挂真实 MCP 工具。
  - eg-core 新增 PDF 文本提取（自写解析器，只依赖 miniz_oxide）和内置文件服务器 `files`：list_directory、read_file、write_file、create_directory、move_file、delete_file、get_file_info、read_pdf、get_pdf_metadata。
  - 桌面应用用 `--mcp-files --allow ~/Downloads` 自启动为子进程；独立二进制 `eg-mcp-files` 给 CLI、测试和脚本用。
  - 只能访问 ~/Downloads：路径规范化，拒绝 `..` 和符号链接逃逸；移动不覆盖，删除只删文件。
  - 确认：读不确认；建目录确认一次；写、移动、删除每次严格确认；删除再确认一次。内置服务器优先于 mcp.json 同名项；Node 侧 `assertServerAllowed` 拒绝白名单外的服务器。
  - 测试：eg-core 73 + 2（stdio 集成），Vitest 42 个文件 388 条（新增 tests/mcp-files.test.ts，起真实子进程），tsc、vite build、品牌自检、macOS 目标 cargo check 均通过。Tauri 里的实际启动和 macOS 首次访问「下载」文件夹的授权弹窗没有在 Mac 上验证。
- 2026-10-01 杀手场景第 2 步：跑通「把下载文件夹里最近 30 天的 PDF 按主题分类」。
  - 运行时支持续写规划：计划标 `more` 时，这批步骤做完把结果交回规划器继续规划（最多 10 轮，总步数上限 60）。规划提示要求不反问用户，移动类步骤在 goal 里写主题和理由。
  - 工具返回结构化结果并报告成功时，反思不再因为正文里有「失败」「无法」等字样判为步骤失败。
  - 夹具：`tests/fixtures/gen-downloads.mjs` 生成 8 个真实可解析的 PDF（其中 1 个超过 30 天、1 个扫描件）和 1 个 txt 干扰文件。
  - `tools/killer-scenario-test.sh --real`：真实 eg-mcp-files 子进程，在临时目录的夹具副本上执行。没有凭据文件，所以用的是确定性模拟模型。9 项验收全部通过，用时 0.14 秒，报告在 `docs/KILLER_SCENARIO_REPORT.md`。
  - Vitest 43 个文件 394 条全过（新增杀手场景 5 条、续写规划 1 条）。
- 2026-10-01 杀手场景第 3 步：任务分级（`src/agent/tier.ts`）。
  - 判断只用规则，不额外调模型。路由分类有 tool_use、目标有多步特征（整理、汇总、审查、调研、保存、先…再…、文件或目录）、或者匹配上某个可用工具，就走完整规划。
  - 其余情况只有明确是问答类（自我介绍、翻译、解释概念、闲聊）才走快速路径：跳过规划、反思和总结，只调一次模型（plan.source 为 direct）。其他默认走规划。
  - 原因：之前「简单介绍一下你自己」要调 规划 + 回答 + 总结 共 3 次模型，还有 2 次反思，用了 2 分 19 秒。现在只调 1 次。
  - 测试里单次调用设成 1 秒，总耗时 1.01 秒。真实耗时取决于模型首字节延迟，没有用真实模型测。
  - 改了 4 条旧测试：它们原来用「解释一下量子纠缠」「你好」测规划路径，现在换成多步目标，另加一条简单路径下的第一次对话测试。
- 2026-10-01 杀手场景第 4 步：思考过程不泄露系统提示。
  - 设置「路由策略」页加「显示模型思考过程」开关，默认关闭，存为 show_reasoning。关闭时回答下方不出现思考过程行。
  - 打开后折叠行写「思考过程 · N 字」，N 是摘要字数。展开只有摘要（`digestReasoning`）：只取回答和总结两类调用，规划、改步骤、生成参数不展示；按行去掉系统提示原文、tool_output、JSON 和输出格式指令、步骤编号和以英文为主的行；最多 600 字。整理后没剩内容就不展示。
  - Vitest 45 个文件 408 条全过（新增 4 条，改 1 条旧断言：标签不再带模型名）。
- 2026-10-01 杀手场景第 6、7 步：路由面板清理与界面细节。
  - 回答下方的路由行展开后不再显示判断来源和停用模型数；候选原因改成人话（`CANDIDATE_WHY`），路由器自己的原因字符串只在专家模式面板里出现。
  - 成果文本：系统提示改为不写路由记录段落；`stripRouteRecord` 在交给用户前去掉模型自己写的「路由记录」段。
  - 输入框下方小字删除，权限说明放到权限下拉的悬停提示；「本地后端」改成「离线可用」；「+」改成「新任务」按钮。
  - Vitest 45 个文件 404 条全过；改了 ui-home 的 3 条旧断言（按钮名、提示位置）。
  - 说明：执行环境 /tmp 被清空，未导出的 3 个提交丢失。按挂载目录的工作区重建了提交，第 1、2 步的拆分合并成了两个提交；工具链重建后完整复测通过（tsc、eg-core 73 + 2 条、Vitest）。
- 2026-10-01 杀手场景第 5 步：验证记忆和技能。
  - 记忆：句首直接陈述偏好（「我偏好…」「我喜欢…」「I prefer…」）也会提出一条偏好记忆，由用户点「记住」保存；这类话走快速路径。偏好会进入快速路径的系统提示。测试用模拟模型，它看到「简洁」偏好就只回一句人设，第二次自我介绍明显短于第一次。真实模型是否遵循没有验证。
  - 技能：「再…一次」「照上次」这类话没有词重叠时，取最近用过或保存的技能。保存技能时，只读步骤带上脱敏后的参数；同一工具连续多步合成「逐项」步骤（goal 里的 {名称} 换成每项名称）；写入类步骤不保存参数。
  - 重放（`src/agent/replay.ts`）：明确要求重复时，技能开头带参数的只读步骤直接执行，不调规划器；判断主题、建目录、移动交给规划器续写一轮，照常逐个确认；报告由执行记录生成，不调模型总结。
  - 测试里每次模型调用等待 300ms，工具是真实子进程：第一次 1241ms（模型 4 次），第二次 318ms（1 次），比例 0.26。
  - 全量复测：tsc、Vitest 46 个文件 416 条、eg-core 73 + 2 条、macOS 目标 cargo check、品牌自检（失败 0）、vite build、杀手场景脚本 9 项，全部通过。
- 2026-10-01 Jev 集成准备：配置凭据、修正测试断言。
  - /tmp/eg-test.env 写入 TYPESAFE_API_KEY（600 权限），.gitignore 已包含 .env、.env.local、/tmp/eg-test.env（之前已有）。SDK `@typesafe-ai/sdk@0.6.0` 已安装，CloudJevBackend 测试 8/8 全过（mock 响应）。修正两条断言：classifyTask 检查 type 和 capabilities，chooseTool 允许返回 null（真实调用时的边界情况）。Vitest 47 个文件 424 条全过，tsc、eg-core cargo test（73 + 2）、macOS check、品牌自检（0 失败）、vite build 全过。
- 2026-10-01 Jev 集成完成：决策层构造与路由面板显示。
  - DecisionLayer.fromEnv 从环境变量读取 TYPESAFE_API_KEY；有 Key 时构造 CloudJevBackend（第 1 级），无 Key 时第 1 级跳过并记原因；第 2 级 LocalJevBackend 未配置时也跳过，第 3 级 RuleBasedBackend 永远可用。FallbackChain 按顺序尝试可用的后端，置信度低于阈值（默认 0.6）或调用失败时降级到下一级；meta 记录后端名称、级别、是否降级、置信度、跳过列表和耗时。
  - 路由面板（TaskRoutePanel）按 meta.backend 显示决策来源：「cloud-jev」→「Jev 云端」，「local-jev」→「本地决策模型」，「rules」→「规则引擎」；标明第几级、是否降级、置信度、跳过原因。describeMeta 生成一句话总结，显示在回答下方的折叠行里。
  - 全量复测：Vitest 47 个文件 424 条、tsc、eg-core cargo test（73 + 2）、macOS check、品牌自检（0 失败）、vite build 全过。测试里 CloudJevBackend 全部 mock 响应，未调用真实 Jev API。真实调用的耗时（P50 < 300ms）和准确率未验证（后来在 2026-10-02 夜间补验，见下）。
- 2026-10-02 Jev 真实 API 验证（报告 `docs/JEV_SMOKE_TEST_REPORT.md`）：
  - choice 冒烟 3 用例 × 10 轮，30/30 正确，置信度 0.920–1.000；P50 328ms（三次采样 317 / 328 / 340ms），**未达 300ms 目标**。VM 到服务端的空请求往返约 247ms，Mac 上要重测。
  - routeTask：3 条里 2 条是 cloud-jev（第 1 级）。「帮我写一个快速排序」Jev 判 code，但 reasoning 约 0.55，置信度 0.08–0.12，低于 0.6，交给规则引擎，被判成 qa（规则引擎缺中文算法词，没改）。无 Key、假 Key（服务端 401）都降级到 rules，不抛异常。
  - 置信度公式保持 min。中途我曾改成 max，被 50 条标注样例否决（整条链 76–80%，低于规则引擎 86.0%；min 为 96.0%），已回退，理由记在 MEMORY.md。后来按官方 skill 改为只计入会改变结果的判断，见下面的条目。
  - 新增 `tools/jev-smoke-test.mjs`、`jev-route-test.mjs`、`jev-eval.ts`、`jev-key.mjs`（Key 读环境变量或 `.env.local`，不打印）。`tests/jev-backend.test.ts` 去掉死分支，新增 3 条置信度回归测试（换成 max 会失败）。
  - 过程中在挂载目录里执行 `pnpm install` 失败，项目根目录留下 86 个 0 字节的 `_tmp_*` 临时文件（VM 内不能删除），已加入 .gitignore，需要用户在 Mac 上删除。
  - 复测：tsc、Vitest 47 个文件 427 条（417 通过、10 跳过）全过。eg-core 与品牌脚本没有改动，未重跑。
- 2026-10-02 夜间（新 Key）：hold-out 真实采样、阈值决策、tool_use 措辞实验。
  - hold-out：54 条独立盲写样例（`tests/fixtures/routing_cases_holdout.json`）每轮 54 次真实调用，两轮。v1 旧 tool_use 措辞：降级 29.6%、链 85.2% / 83.3%；v2 新措辞：降级 11.1%、链 96.3% / 96.3%（Jev 单独 108/108）。规则引擎单独 81.5%。没有过拟合迹象。
  - 阈值：hold-out 上 0.6 最好（96.3%）；0.7 反而 94.4%；0.5 两轮 96.3% / 98.1%；0.8 掉到 92.6%。留 0.6。
  - tool_use 措辞 v2：把「附件已提供、读它不算动作」写明，同时保留「对附件本身改名、移动、保存、发送仍算动作」。采用条件先定后看（误报下降、漏报不增、链准确率不降），三条都达成：误报 27 → 0，漏报 0，链 83.3–85.2% → 96.3%。
  - 存档：`tests/fixtures/jev_recorded_2026-10-02.json`（50 条，v2）、`jev_recorded_holdout_2026-10-02.json`（54 条，v2）、`jev_recorded_holdout_v1_2026-10-02.json`（54 条，v1 对照）。每个文件自带 questions 原文和指纹，措辞一变测试会失败。
  - 测试：`tests/jev-recorded.test.ts` 重写（指纹一致性、50 条降级 <10%/链 ≥95%、hold-out 降级 <20%/链 ≥90%、v2 误报 0 且不劣于 v1）。
  - 剩余 2 条错（`ho-code-en-02`、`ho-reasoning-en-02`，两轮相同）是能力标签粒度问题：单标签装不下「code + reasoning」这类组合，不是置信度或措辞问题。
  - Key：跑完删除 `.env.local`（用户可再确认）。复测：tsc、Vitest 50 个文件 449 条（439 通过、10 跳过）全过。
- 2026-10-02 按 TypeSafe 官方 skill 重审 Jev 集成：
  - 安装：`npx skills@1.7.0 add typesafe-ai/skills --skill typesafe-ai -a claude-code -y --copy`（关遥测）→ `.claude/skills/typesafe-ai/`（SKILL.md、LICENSE），`skills-lock.json` 记录来源和哈希。`.gitignore` 不排除它，进 git；`tests/dev-tools-not-bundled.test.ts` 保证不进应用包（Tauri 没有 bundle.resources，前端产物 `../dist`，vite build 产物里也没有）。
  - 读官方文档（confidence、fan-out、confidence-routing、agent-skill）的结论：同一请求并行问独立问题就是官方的 fan-out，三问保留，不拆；「全部取最小」把不影响结果的分支（主类型已是 code 时的 reasoning）也算进置信度，是过度降级的原因；完全不设阈值（取最大）会比规则引擎还差。用户提的「只问一个 Choice」没有采用，理由见 MEMORY.md。
  - 改动：`classificationFromProbs` 只计入会改变主类型或硬性能力的判断；问题和阈值集中到 `src/decision/jev-config.ts`（措辞一字未改）；`eval.ts` 新增 `evaluateChain`；`tools/jev-eval.ts` 支持回放和 `--collect`；`tests/local-jev.test.ts` 的一条置信度断言从 0.6 改为 0.8（本地模型共用同一函数，上限 0.8）。
  - 回放 2026-10-02 录制的真实回答（`tests/fixtures/jev_recorded_2026-10-02.json`，50 条 × 2 次采样，阈值 0.6）：降级 58% → 28%，整条链 96.0% → 90.0%，两次相同。目标「降级 < 30%、链 ≥ 90%」达到，但余量为 0。少对的 3 条和剩下的 5 个错都是 tool_use 误报（p 0.81–0.90），该改问题措辞，未验证。
  - 盲写 54 条 hold-out（`tests/fixtures/routing_cases_holdout.json`，规则引擎单独 81.5%），标注自洽检查加进 `tests/routing-accuracy.test.ts`；还没有用 Jev 跑。
  - 新 Key 复测被挡住：`.env.local` 已被用户删除，旧 Key 按用户说明已轮换，没有再使用。
  - 复测：tsc、Vitest 50 个文件 443 条（433 通过、10 跳过）全过；vite build 通过。eg-core 与品牌脚本没有改动，未重跑。

- 2026-09-29 读取品牌板，完成视觉区域识别（主视觉、浅色组合、4 款图标、最小尺寸、品牌色、3 张场景图、页脚标语）。
- 2026-09-29 Linux 执行环境启动失败（镜像下载停滞，已重试多次），Python / Node 暂时无法运行。先用文件工具编写脚本和文档，环境恢复后立即执行。
- 2026-09-29 三个脚本全部写完。深色底标志加了 8px 边缘羽化，避免辉光被硬切。执行环境仍无法启动（连接超时，已多次重试），脚本尚未编译运行。开始编写 docs/BRAND.md。
- 2026-09-29 docs/BRAND.md 写完。静态复核脚本时发现图标字形测量有误：原先按亮度判定 G 字形，圆角外的浅色板面和偏亮的底色也会被算进去，导致 icon-1024 的标志偏大。已改为先减去图标自身的底色渐变，再只在圆角内判定。执行环境仍连接超时，脚本还没有编译运行。
- 2026-09-29 新会话继续。执行环境仍停在「启动中」，重试十余次没有就绪，命令没有开始执行。对照品牌板原图目测核对区域坐标表、面板扫描线和取色框，没有发现搜索窗口或外扩上限越过相邻元素、分隔线；准确与否以运行后的自检和目检拼图为准。静态复核又修正两处：`refine()` 外扩次数用完仍贴边时没有记「复核」，已补上；`gen_platform_icons.py` 记录命令输出时只替换了项目根目录和家目录，npm 缓存等其他绝对路径可能写进 JSON，已统一打码。两处修改都还没有编译运行。下一步：重启应用恢复执行环境，然后从编译脚本开始依次执行步骤 3–5。
- 2026-09-29 执行环境恢复（Python 3.10.12、Pillow 12.3.0、Node 22，npx 能连 npm 官方源）。三个脚本编译通过；提取脚本导出 39 个文件，原图 SHA-256 前后一致；tauri icon 2.5.0 生成 50 个平台图标；首轮自检通过 50、警告 1（logo-dark 外圈含地平线辉光，属预期）、失败 0。放大目检发现两处自检没覆盖的缺陷：① 主视觉字标 i 上的点是金色，白字抠图按最小通道算 alpha，导出后变成灰白虚影（wordmark-light、logo-dark-transparent）；② 夜空越往下越亮（标志下方约 57–80，而抠图用的单一底色是 45），标志下方的星点被当成半透明前景，形成一排红色噪点，并随标志放大进 icon-1024 和全部平台图标。另外，实测图标底色上亮下暗（#6E0107 → #400102），与 BRAND.md 4.2 的估计方向相反。
- 2026-09-29 修正缺陷并重新生成。① 白字抠图对金色像素改按绿通道求 alpha，i 点保留为金色。② 深色底抠图的底色改为逐行估计（左右边缘取下四分位，再沿竖直方向平滑）；离实心部分 2px 以外的淡像素做去噪点；主视觉两项包围盒的 min_hits 改为 4，2x2 星点不再撑大裁切框。③ 复查发现 icon-1024 的上缘取样落在金弧辉光上，整条上缘偏亮。底色改为平面拟合：把主视觉标志按同样位置放进板上彩色图标，只取标志 alpha < 5% 的像素，用 Tukey 重加权。背景像素与板上的平均差从 15.4 降到 10.8；金弧外的辉光环和 G 内腔的暗部仍无法还原。④ 兼容 Pillow 14 移除 getdata()。自检新增三类检查，其中金色 i 点、孤立噪点两项拿修复前的素材复测都会失败（wordmark-light 金色像素 0、mark-for-dark-bg 孤立噪点 13）；icon-1024 一致性一项用于发现严重偏差。BRAND.md 按实测值校正 4.2 节，补充 4.3 节深色表面对比度和第 10 节移动端说明。三个脚本按顺序重跑，自检通过 61、警告 1、失败 0，原图 SHA-256 不变。
- 待用户决定：测试时导入脚本，生成了 `scripts/brand/__pycache__/`；`assets/brand/ui/` 是本次任务之前就有的空目录，素材实际写在 `ui-reference/`。按规则两者都没有删除。
