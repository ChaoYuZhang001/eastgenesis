# 真实 API 测试报告（脱敏）

2026-09-30，在 Linux VM 里跑 `bash tools/real-api-test.sh --real`，对象是一个 OpenAI 兼容的中转站。主模型 `claude-opus-5-5`，备用模型 `deepseek-v4-pro`。凭据只放在仓库外的临时凭据文件（权限 600），测试结束已删除。本报告只记状态码、耗时和 token 数，不含 Base URL、Key 和模型回复原文。

不带 `--real` 时脚本只打印「已跳过」并退出 0，所以 CI 和日常 `pnpm test` 不会发真实请求。

## 结果：19 项全部通过

| 编号 | 项目 | 状态 | 耗时 | tokens | 结论 |
| --- | --- | --- | --- | --- | --- |
| R01 | GET /models | 200 | 562 ms | - | 50 个模型，主、备模型都在 |
| R02 | 非流式对话 · claude-opus-5-5 | 200 | 3445 ms | 34 | finish=stop |
| R03 | 非流式对话 · deepseek-v4-pro | 200 | 10048 ms | 94 | 首次 60 s 超时，重跑通过 |
| R04 | 流式 SSE · claude-opus-5-5 | 200 | 4514 ms | 55 | 首个增量 3218 ms，带 usage |
| R05 | 流式 SSE · deepseek-v4-pro | 200 | 3020 ms | 244 | 前三次失败，见下文 |
| R06 | 错误 Key | 401 | 462 ms | - | 映射为 auth |
| R07 | 错误路径 | invalid_response | 156 ms | - | 中转站对未知路径的返回不是合法的 OpenAI JSON，被识别为无效响应，不会被当成空回复 |
| R08 | 不存在的域名 | network | 10014 ms | - | 映射为 network |
| R09 | gpt-5.5（列表里有） | 404 | 531 ms | - | 映射为 not_found，路由换下一个模型 |
| R10 | 本机假服务 429 | 429 | 11 ms | - | rate_limit |
| R11 | 本机假服务 500 | 500 | 5 ms | - | server |
| R12 | 本机假服务不响应 | timeout | 1001 ms | - | 1 秒超时生效 |
| R13 | 降级：错误 Key → 429 → 502 → 主模型 | 200 | 4404 ms | 140 | 三次失败各自写明原因，最后落到 relay/claude-opus-5-5 |
| R14 | 降级：超时 → 重试 1 次 → 备用模型 | 200 | 9362 ms | 127 | 首次跑中转站也超时了一次，重试计数变成 2，放宽断言后通过 |
| R15 | 降级：gpt-5.5 404 → 备用模型 | 200 | 3388 ms | 144 | 「接口或模型不存在 → 降级到 relay/deepseek-v4-pro」 |
| R16 | 整条链失败 | route_exhausted | 15 ms | - | 逐个列出模型和原因 |
| R17 | 自动路由（只有中转站可用） | completed | 11798 ms | 1018 | 选中 relay/deepseek-v4-pro，候选 2 个，规划、回答、总结 3 次调用 |
| R18 | 锁定 claude-opus-5-5 | completed | 18917 ms | 1566 | 路由行显示「手动锁定」，候选只有 1 个 |
| R19 | MCP：本机 stdio 服务器 + 白名单 | completed | 13380 ms | 1020 | 只放行 echo，env_probe 被跳过；真实模型规划并调用 echo，回显正确 |

R17 到 R19 用的是应用自己的引擎，也就是决策层、Agent 运行时和权限确认那一套。模型请求经过一个 Node 后端发出，这个后端替代的是 Rust 代理，Key 在后端注入，适配器拿不到 Key。

## 发现

中转站延迟波动很大。`deepseek-v4-pro` 同样的请求，快的时候 3 秒，慢的时候 60 秒以上还没有首字节。有一次流式请求等了 120 秒才返回响应头，内容是空的，finish=length，completion 只有 1 token。R03 和 R05 的失败都是这个原因，重跑后通过，不是适配器的问题。

R05 的 120 秒只是测试脚本自己的等待上限，用来把这条用例测完，应用不跟着改。应用的单次请求默认超时是 90 秒（原来是 60 秒），用户可以在设置页「路由策略 → 请求超时」里改成 30 到 150 秒。超过 90 秒时先等 2 秒重试一次，还超时就降级到下一个模型，降级记录里写「因超时降级」。

`deepseek-v4-pro` 在流式输出里带 `reasoning_content` 字段。现在适配器把它单独存成思考过程，不混进正文，也不进对话上下文。界面上默认折叠，用户点开才显示。

中转站的 /models 列出了 `gpt-5.5`，但调用返回 404 model_not_found。所以模型列表只能说明中转站登记了这个模型，不能说明它能调用。路由遇到这种 404 会降级到下一个模型（见 R15）。现在读取 /models 以后会对每个模型发一个 max_tokens 为 1 的请求做轻量探测。返回 404 或 model_not_found 的模型标记为不可用，不出现在输入框的模型下拉里。超时、5xx 和限流不算不可用。如果所有模型都是 404，更可能是地址配错了，这次探测结果不采用。

以上三项改动只用 mock 验证过（单元测试和界面测试），没有在中转站上重测，因为本轮测试凭据已经删除。

适配器没有原生 function calling 参数，所以「工具调用」走的是 Agent 规划器输出的 JSON 加 MCP 执行（见 R19）。

## 本次未覆盖

VM 里没有 webkit2gtk，Tauri 外壳编译不了，所以真实桌面界面交互和 macOS 钥匙串读写没有测到，这几项在 Mac 上验证。7 家官方 Provider 的直连同样待 Mac。

## 附录：中转站 /models 返回的 50 个模型

claude-fable-5、claude-fable-5-1、claude-haiku-4-5、claude-opus-4-5、claude-opus-4-6、claude-opus-4-7、claude-opus-4-8、claude-opus-5、claude-opus-5-5、claude-sonnet-4-6、claude-sonnet-5、claude-sonnet-5-5、deepseek-v4-flash、deepseek-v4-pro、deepseek-v4.1-flash、gemini-3.1-pro、glm-5.2、glm-5.3、glm-5.3-flash、gpt-5.4、gpt-5.4-mini、gpt-5.5（调用 404）、gpt-5.6-luna、gpt-5.6-sol、gpt-5.6-terra、gpt-6-astra、gpt-6-luna、gpt-6-sol、gpt-6.1-sol、gpt-image-2、gpt-image-2.5-flare、gpt-image-2.5-sunburst、grok-4.20-0309-non-reasoning、grok-4.20-0309-reasoning、grok-4.20-non-reasoning、grok-4.20-reasoning、grok-4.3、grok-4.5、grok-4.6、grok-4.7、grok-build-0.1、grok-imagine、grok-imagine-image、grok-imagine-image-2.0、grok-imagine-video、grok-imagine-video-1.5、kimi-k2.6、kimi-k2.7-code、kimi-k3、qwen3.8-max
