# Provider 失败与恢复矩阵

这份矩阵是 EastGenesis 的运行契约：模型和 Provider 可以替换，但一次调用失败后的处置必须保持可解释、可恢复、可测试。执行实现位于 `src/decision/router.ts` 的 `failurePolicy()` 与 `executeWithFallback()`；它不保存 API Key，也不把 Provider 响应正文写入任务事件。

## 用户可见的行为

| 失败类型 | 同一模型 | 同一 Provider 的其他模型 | 其他 Provider | 健康度 | 用户看到的结果 |
|---|---|---|---|---|---|
| 超时，第一次 | 等待 2 秒后重试 1 次 | 暂不切换 | 暂不切换 | 不记失败 | “请求超时，2 秒后重试” |
| 超时，重试仍失败 | 不再重试 | 按链继续 | 按链继续 | 记 1 次失败 | “请求超时（已重试 1 次）”，然后显示降级到的模型 |
| 限流（429） | 不重试 | 按链继续 | 优先换 Provider | 记 1 次失败 | “请求过于频繁或额度不足” |
| 网络失败 | 不重试 | 按链继续 | 优先换 Provider | 记 1 次失败 | “网络连接失败” |
| 服务端错误（5xx） | 不重试 | 按链继续 | 优先换 Provider | 记 1 次失败 | “服务端错误” |
| 鉴权失败（401/403） | 不重试 | 跳过该 Provider | 继续其他 Provider | Provider 下线，直到配置被修改 | “鉴权失败，请检查 API Key”；同源模型显示“已跳过” |
| 额度或计费错误（billing） | 不重试 | 跳过该 Provider | 继续其他 Provider | Provider 下线，直到额度/计费恢复或配置被修改 | “Provider 额度或计费状态不可用” |
| 配置错误 | 不重试 | 跳过该 Provider | 继续其他 Provider | Provider 下线，直到配置被修改 | “Provider 配置有误” |
| 模型/接口不存在（404） | 不重试 | 按链继续 | 优先换 Provider | 记 1 次失败 | “接口或模型不存在” |
| 请求参数错误（400）第一次 | 不重试 | 按链继续 | 继续下一项 | 记 1 次失败 | “请求参数有误” |
| 请求参数错误（400）第二次 | 停止 | 不再调用 | 不再调用 | 不继续记 Provider 健康失败 | 直接结束为降级链失败，列出已尝试模型 |
| 流式正文已经开始后中断 | 停止 | 不拼接其他模型 | 不拼接其他 Provider | 不把已输出的模型记为健康失败 | 保留已收到的正文，并明确标记“生成中断” |
| 用户取消 | 停止 | 不调用 | 不调用 | 不记失败 | 保留“请求已取消”，不包装成模型故障 |
| 响应格式异常或未知异常 | 不重试 | 按链继续 | 优先换 Provider | 记 1 次失败 | 显示安全的通用失败原因，不透出原始响应 |

“优先换 Provider”是候选链的排序约束，不代表一定存在可用的第二家 Provider。没有其他候选时，路由会使用同一 Provider 的次优模型；链上的最后一个模型即使健康度较低也会尝试一次，避免把所有模型都提前跳过。

## 健康度与恢复

- 同一模型在默认 60 秒窗口内连续失败 3 次后熔断 60 秒。
- 熔断结束后进入半开状态，以 0.5 健康度参与评分；试探成功恢复到 1，失败重新熔断。
- 鉴权和配置错误按 Provider 维度下线，用户修改 Key、地域、地址或模型配置后由 `resetProvider()` 清除记录。
- 任务开始时计算候选链；每次实际调用前仍检查健康度，因此同一任务后续步骤不会再次等待已经熔断的模型。
- 工具副作用的恢复由调用账本、恢复前探测和租约负责；本矩阵只描述模型请求失败，不能替代工具副作用的幂等与冲突处理。

## 透明度与证据边界

路由决策面板展示任务类型、工作能力面、候选链、排除原因和决策来源；回答下方的路由行展示实际使用的模型、降级次数和失败原因；执行时间线展示超时重试及模型切换。事件只保存模型 ID、错误码、状态码和脱敏后的短原因，不保存 API Key 或完整 Provider 响应。

当前自动化证据覆盖：纯策略矩阵、超时重试、跨 Provider 降级、鉴权导致的同源跳过、熔断与半开恢复、用户取消、中文失败文案。真实 Provider 的网络抖动、服务端限流和跨平台桌面 UI 仍需在各平台使用测试账号或本地回环服务复测；单元测试不能证明供应商的生产 SLA。

流式回答目前只覆盖 `answer` / `summary` 两类面向用户的正文；规划、工具参数和反思仍走完整响应，避免把结构化中间结果拆成不可恢复的半成品。OpenAI Chat Completions 要求流以 `[DONE]` 结束（见 [OpenAI Chat Completions 流式文档](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)），Anthropic Messages 流要求最终 `message_stop` 事件（见 [Anthropic Streaming Messages 文档](https://platform.claude.com/docs/en/build-with-claude/streaming)）；适配器缺少对应结束标记时会按截断处理。增量只存在于当前任务卡的运行态，成功的完整 `llm` 事件会清空它；一旦已经收到正文后连接中断，路由链停止切换模型，任务会保留部分输出并进入失败/恢复路径，防止把两个模型的回答静默拼接在一起。

## 适配器准入契约

自动路由的 Provider 不是只要“能发一个请求”就算可用。`src/core/llm/official.ts` 为每个内置适配器登记恢复契约：请求必须接收 `AbortSignal`，流必须有可验证的终态（OpenAI `[DONE]` 或 Anthropic `message_stop`），已经输出正文后必须能标记部分输出，HTTP 与流内错误必须归一为 `ProviderErrorCode`。`providerReadiness()` 和桌面端 `statusAvailability()` 在候选链生成前检查该契约；缺少契约的未来适配器会显示“适配器缺少可恢复执行契约”，不会等到半截回答后才暴露能力缺口。

当前 7 个内置 Provider 使用两种生产适配器：OpenAI、Google、DeepSeek、Qwen、Kimi、Ollama 走 OpenAI 兼容实现，Anthropic 走 Messages 实现；两类实例都把恢复能力挂在 `LLMProvider.capabilities.recovery` 上。第三方自定义端点仍复用这两种实现，因此协议边界由适配器统一承担；真实端点是否遵守协议仍需回环夹具和供应商测试账号复测。
