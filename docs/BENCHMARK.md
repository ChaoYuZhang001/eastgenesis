# EastGenesis 对标基准表

> 查询日期 2026-09-29。竞品部分只采用官方网站、文档、帮助中心和 GitHub 仓库的说法。内部基准由 `pnpm eg bench` 生成，`tests/bench.test.ts` 检查本文的表格与命令输出一致。

## 1. 竞品功能对标

EastGenesis 一列是本仓库的实现状态，只在 VM 里用模拟后端验证过；真实 API 和 Tauri 外壳要在 Mac 上验证，见 `DELIVERY.md`。其他列的「未查到」表示查阅的官方页面没有提到，不等于不支持。表中 5 条关键说法另外抓取原文复核过：LobeChat 不保证自动切换、Claude 的安全回退和模型菜单、Chatbox 的 Key 存储、Cherry Studio 的许可。

| 维度 | EastGenesis 0.1.0 | Cherry Studio | LobeChat | Chatbox | Claude Desktop | ChatGPT 桌面端 |
|---|---|---|---|---|---|---|
| 多模型中立 | 支持（7 家官方 Provider） | 支持 | 支持 | 支持 | 不支持（只能选 Claude 模型） | 部分支持 ① |
| 自定义端点、中转站 | 支持（OpenAI、Anthropic 协议） | 支持 | 支持 | 支持 | 未查到 | 部分支持 ① |
| 本地模型 | 支持（Ollama、本机自定义 Provider） | 支持 | 支持 | 支持 | 不支持 | 部分支持 ① |
| 按任务自动选模型 | 支持（能力、质量、成本、延迟多因子评分） | 未查到 | 未查到 | 未查到 | 未查到 | 部分支持 ② |
| 调用失败自动换模型 | 支持（优先换一家 Provider，熔断） | 未查到 ③ | 不支持 ④ | 未查到 | 部分支持 ⑤ | 未查到 |
| 选模型的理由可见 | 支持（评分明细、降级链、排除原因、降级记录） | 未查到 | 未查到 | 未查到 | 部分支持 ⑥ | 未查到 |
| MCP | 支持（stdio，白名单） | 支持 | 支持 | 支持 | 支持 | 支持 ⑦ |
| 工具调用确认 | 支持（白名单，副作用和风险规则） | 支持 | 支持 ⑧ | 部分支持 ⑨ | 支持 | 支持 |
| 跨会话记忆 | 支持（用户确认才保存） | 支持 | 支持 | 支持 | 支持 | 支持 |
| 技能与模板 | 支持（从完成的任务保存） | 支持 | 支持 | 支持 | 支持 | 支持 |
| 多 Agent 协同 | 支持（2–4 个子任务，最多 2 个并行） | 支持 | 支持 | 未查到 | 支持 ⑩ | 部分支持 ① |
| 密钥存储 | 系统钥匙串（Rust 侧） | 本地设备 ⑪ | 未查到 | 本地 ⑫ | 账户登录，不用自备 Key | 账户登录为主 ① |
| 许可 | 未定（仓库没有 LICENSE） | AGPL-3.0（社区版） | 待核实 ⑬ | GPL-3.0（社区版） | 闭源 | 未查到 |
| 最新版本 | 0.1.0（未发布） | v2.1.3（2026-09-24） | v2.2.19-canary.33（预发布） | v1.23.5（2026-09-24） | 未查到 | macOS 26.924.20706（2026-09-25） |

① 只在 Codex 里：本地 config.toml 可以接其他厂商和 OpenAI 兼容地址、用 `--oss` 接 Ollama、配置子 Agent；Chat 的模型选项只有 OpenAI 自家模型。
② 选 Instant 时会自动加推理，只在 OpenAI 自家模型和推理档位之间切换（出自 Business 方案说明）。
③ 只查到多个 Key 轮询（避开限流），没有查到失败后换模型或换 Provider。
④ 官方文档：服务商不可用时由用户选择替代服务商，原文「This does not guarantee automatic failover」。
⑤ Fable 的请求被安全分类器拦截后，在同一对话里改用 Opus 重跑。这是安全回退，不是调用出错时换模型。
⑥ 自动切换后提示模型已切换，回复上标出模型；没有评分和理由。
⑦ Codex 在本地 config.toml 配置 MCP 服务器；账户侧的开发者模式只在 Business、Enterprise 工作区的说明里看到。
⑧ 依据只有预发布版的提交记录（agent-intervention 审批、beforeToolCall），正式文档没有说明。
⑨ 工作模式运行命令、修改文件前要审批，可以切到 Full Access；文档没说 MCP 等其他工具是否要确认。
⑩ Cowork 把任务拆给多个子 Agent 并行执行，限 Pro、Max、Team、Enterprise 付费方案。
⑪ 隐私政策写明 API Key 默认存在本地设备，没说是否用系统钥匙串。
⑫ 官方 FAQ：API Key 只存在本地、不发送到官方服务器，没提系统钥匙串；用官方模型服务时不用自备 Key。
⑬ README 的 License 一节写 LobeHub Community License，顶部徽章显示 Apache 2.0，LICENSE 原文没能读到。

来源：
- Cherry Studio：https://github.com/CherryHQ/cherry-studio （README、Releases）；https://docs.cherryai.com.cn/pre-basic/providers.md 、/advanced-basic/extensions/mcp.md 、/advanced-basic/agent-workspace/permissions-memory-background.md 、/about/privacypolicy.md
- LobeChat：https://github.com/lobehub/lobe-chat （README）；https://github.com/lobehub/lobehub 的 Releases 和 docs/usage/providers.mdx、docs/usage/feature-status.mdx、docs/self-hosting/environment-variables/basic.mdx
- Chatbox：https://github.com/chatboxai/chatbox （README、Releases）；https://chatboxai.app/en/guide 下的 byok/other-platforms、work-mode/overview、work-mode/configuration、faq/data-storage；https://docs.chatboxai.app/guides/mcp
- Claude Desktop：https://support.claude.com/en/articles/ 下的 8664678、15363606、13345190、11817273、12512176、12622667；https://modelcontextprotocol.io/quickstart/user ；https://www.anthropic.com/legal/consumer-terms
- ChatGPT：https://help.openai.com/en/articles/ 下的 12003714、11487775、8590148、20001256、20001275、20001276、9275200；https://learn.chatgpt.com/docs/config-file/config-advanced ；https://learn.chatgpt.com/docs/changelog

## 2. 内部基准：智能路由对比固定模型

同一批 50 条标注样例（`tests/fixtures/routing_cases.json`），只跑分类和路由，不调用模型。固定策略代表「一直用一个模型」：固定旗舰取质量最高、能力最全、再最便宜的模型，固定最便宜取成本最低、再质量最高的模型。

「硬性能力满足」「全部能力满足」看首选模型是否具备样例人工标注的能力：硬性能力是视觉、长上下文、工具调用，全部能力另含代码、推理、中文。以标注为准，分类器判断错了会如实扣分。平均成本档和平均质量档取能力矩阵 `config/model_profiles.json` 的 1–5 档（估），不是实际价格和评测分数。「首选 Provider 故障后仍可完成」指首选模型所在的 Provider 整体不可用时，降级链上还有别家、满足硬性能力的模型接手；固定一个模型没有备选，按定义是 0%，用户手动换模型不计入。

<!-- bench:start -->
场景 A：已配置 OpenAI、Anthropic，50 条样例

| 策略 | 模型 | 硬性能力满足 | 全部能力满足 | 平均成本档 | 平均质量档 | 首选 Provider 故障后仍可完成 |
|---|---|---|---|---|---|---|
| 智能路由（平衡） | 按任务选择 | 100% | 36% | 2.86 | 3.54 | 100% |
| 智能路由（省钱） | 按任务选择 | 100% | 36% | 2.20 | 3.10 | 100% |
| 固定旗舰 | anthropic/claude-fable-5-1 | 100% | 36% | 5.00 | 5.00 | 0% |
| 固定最便宜 | openai/gpt-5.6-luna | 100% | 26% | 2.00 | 3.00 | 0% |

场景 B：已配置 6 家云端官方 Provider，50 条样例

| 策略 | 模型 | 硬性能力满足 | 全部能力满足 | 平均成本档 | 平均质量档 | 首选 Provider 故障后仍可完成 |
|---|---|---|---|---|---|---|
| 智能路由（平衡） | 按任务选择 | 100% | 100% | 2.02 | 4.02 | 100% |
| 智能路由（省钱） | 按任务选择 | 100% | 98% | 1.40 | 3.34 | 100% |
| 固定旗舰 | kimi/kimi-k3 | 100% | 100% | 4.00 | 5.00 | 0% |
| 固定最便宜 | qwen/qwen3.8-flash | 86% | 60% | 1.00 | 3.00 | 0% |
<!-- bench:end -->

读数：场景 B 下，智能路由（平衡）的平均成本档约为固定旗舰的一半（2.02 对 4.00），全部能力满足率达到 100%，平均质量档接近固定旗舰。智能路由（省钱）把平均成本档降到 1.40，全部能力满足率为 98%。固定最便宜的模型不支持视觉，14% 的样例连硬性能力都不满足。场景 A 的「全部能力满足」普遍偏低，是因为能力矩阵只给国内厂商的模型标了「中文」，而 64% 的样例（32/50）要求中文；这不代表 GPT、Claude 不能处理中文。

复现：`pnpm eg bench` 输出上面的表格，`pnpm eg eval-routing` 输出主样例分类准确率（当前硬路由 100.0%，严格标签 88.0%），`pnpm eg eval-routing --holdout` 输出独立样例（当前硬路由 100.0%，严格标签 90.7%）。机器门禁使用 `pnpm --silent routing:gate -- --json`，它不会调用模型，且会同时检查两套样例与两个 Provider 配置场景下的智能路由硬能力和 fallback 覆盖。
