# EastGenesis Desktop

汇天下之智 · 开创每一个可能

一个不绑定模型厂商的统一 AI 工作台：用户面对一个 Composer，Chat、Work、Codex 是同一任务在聊天、资料处理和本地开发上的能力面，不是三个割裂的产品。系统按任务需要的能力、质量、成本和延迟自动选择模型，路由过程透明可追踪，调用失败时换一家 Provider 继续执行；选了谁、为什么选、换过谁，以及当前采用哪个工作能力面，都显示在路由面板和执行时间线上。多步骤任务会持久化计划和步骤结果，失败、取消或预算耗尽后可以从第一个未完成步骤继续，并重新生成工具参数。支持 7 家官方 API（OpenAI、Anthropic、Gemini、DeepSeek、通义千问、Kimi、Ollama），也可以接中转站或其他兼容 OpenAI、Anthropic 协议的端点。

当前版本 0.1.0，未发布，没有签名。各里程碑的进度见 `docs/TASKS.md`，交付内容和验证情况见 `DELIVERY.md`。

## 技术栈

Tauri 2（Rust）· React 18 + TypeScript + Vite · Zustand · shadcn/ui + Tailwind CSS · SQLite（tauri-plugin-sql）· Tauri Dialog 原生目录选择 · Vitest + cargo test · pnpm 9.15.4

## 开发

需要 Node 22、pnpm 9.15.4（`corepack enable`）；桌面外壳还需要 Rust 1.90 以上和平台工具链（macOS 装 Xcode 命令行工具）。

```sh
pnpm install --frozen-lockfile
pnpm dev:web            # 只看界面：浏览器 + 模拟后端，http://localhost:1421
pnpm tauri dev          # 桌面应用
pnpm test               # Vitest，全部使用模拟后端，不调用真实 API
pnpm typecheck
pnpm build              # 生成品牌主题、类型检查、打包前端
cargo test -p eg-core   # Rust 核心
```

桌面流式和打包验收不需要真实 API Key：

```sh
pnpm desktop:fixture:smoke    # staged / slow-first-token / truncated / 503 / idle
pnpm tauri:build:qa           # 启用 qa-faults 的未签名桌面包
pnpm desktop:bundle:smoke     # 检查当前平台的可交付 bundle 产物
pnpm desktop:package:smoke    # Mac 包启动、接线和受控退出（不操作 webview）
```

跨平台原生门禁见 `.github/workflows/desktop.yml`；Windows/Linux 的安装包和 WebView 必须在对应 runner 上验证，不能用 Mac 结果替代。

`pnpm dev:web` 的地址后加 `?mock=fail-init`、`?mock=fail-requests`、`?mock=slow`、`?mock=jev`（逗号分隔，可以组合），用来预览失败、慢速和 Jev 决策的状态。

命令行原型不需要编译外壳：

```sh
pnpm eg providers                        # 内置 Provider 及 Key 是否就绪
pnpm eg route "整理这份合同的要点"          # 任务分类、路由决策和降级链，不调用模型
pnpm eg chat -p anthropic --stream "你好"
pnpm eg eval-routing                     # 50 条样例的路由准确率
pnpm eg bench                            # 智能路由对比固定模型，见 docs/BENCHMARK.md
```

## 密钥

Key 不写进代码、配置文件和日志。桌面端把 Key 存在系统钥匙串里，由 Rust 侧读取并代发请求，webview 拿不到 Key。命令行和开发时从环境变量读取：

| 用途 | 环境变量 |
|---|---|
| OpenAI / Anthropic / Gemini | `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` |
| DeepSeek / 通义千问 / Kimi | `DEEPSEEK_API_KEY` / `DASHSCOPE_API_KEY` / `MOONSHOT_API_KEY` |
| Jev 决策层（与模型 Key 分开） | `TYPESAFE_API_KEY`；不配置时自动降级到本地决策模型或规则引擎 |

自定义端点用 `-p custom:<名称> --base-url <地址> --key-env <变量名>`。本机 Ollama 不需要 Key，命令行里要设 `EG_OLLAMA=1` 才会参与路由。

## 目录

```text
src/core/        LLMProvider 接口、各家适配器、错误映射、脱敏
src/decision/    分类、路由评分、降级链、Jev 决策层与三级降级、基准
src/agent/       Agent 运行时：规划、反思、错误恢复、MCP 客户端、记忆、技能、多 Agent 协同
src/components/  界面：启动页、任务画布、执行时间线、路由面板、设置页
src/platform/    Tauri 后端与浏览器模拟后端
src-tauri/       桌面外壳：Tauri 命令、钥匙串、请求代理（业务逻辑在 eg-core）
crates/eg-core/  Rust 核心：Provider 地址白名单、密钥与脱敏、MCP 登记和进程、数据库迁移
config/          模型能力矩阵 model_profiles.json
assets/brand/    品牌素材（由 scripts/brand/ 从品牌板生成，品牌板只读）
tests/           Vitest 测试与路由标注样例
docs/            品牌规范、任务进度、对标基准、Mac 端验证清单
```

品牌规范以 `docs/BRAND.md` 为准，关键技术决策记在 `MEMORY.md`。许可证未定：仓库还没有 LICENSE，Cargo 工作区标记为 UNLICENSED。
