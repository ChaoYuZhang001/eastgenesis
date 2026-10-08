# M22 Provider 恢复矩阵

这份矩阵验证 Provider 适配器的错误归一化、取消、超时、流式终态和部分输出边界。默认运行只使用本地 HTTP 夹具，不访问外网、不需要 Key，也不代表真实供应商 SLA。

## 本地矩阵

运行：

```bash
pnpm provider:matrix
pnpm --silent provider:matrix -- --json > /tmp/eastgenesis-provider-matrix.json
```

默认覆盖 15 个场景：

| 场景 | 协议 | 预期 |
|---|---|---|
| auth | OpenAI-compatible | 401 → `auth` |
| rate_limit | OpenAI-compatible | 429 → `rate_limit` |
| billing | Anthropic Messages | 402 → `billing` |
| not_found | Anthropic Messages | 404 → `not_found` |
| bad_request | OpenAI-compatible | 400 → `bad_request` |
| server | OpenAI-compatible | 503 → `server` |
| network | OpenAI-compatible | 连接失败 → `network` |
| timeout | OpenAI-compatible 流 | 读取超时 → `timeout` |
| cancel | Anthropic Messages 流 | AbortSignal → `aborted` |
| partial_transport | OpenAI-compatible 流 | body 传输中断 → `network`，保留部分输出 |
| missing_terminal | OpenAI-compatible 流 | 正常 EOF 但缺少 `[DONE]` → `invalid_response`，保留部分输出 |
| anthropic_partial_transport | Anthropic Messages 流 | body 传输中断 → `network`，保留部分输出 |
| anthropic_missing_terminal | Anthropic Messages 流 | 正常 EOF 但缺少 `message_stop` → `invalid_response`，保留部分输出 |
| openai_stream_success | OpenAI-compatible 流 | `[DONE]` 正常完成 |
| anthropic_stream_success | Anthropic Messages 流 | `message_stop` 正常完成 |

JSON 包含 schema 版本、矩阵模式、顶层 `passed`、场景名、协议、模式、错误类别、HTTP 状态、是否有部分输出、是否正常终止、输出字符数、单次耗时和通过状态。不会写入 base URL、模型名、Key、响应正文、错误详情或本地路径。`recoveryStatus` 和 `evidenceBoundary` 明确这份结果证明了什么、排除了什么。

## 执行层恢复矩阵

适配器通过后，脚本还会使用生产 `routedLlm` 和同一套本地 HTTP 夹具验证任务级恢复：

| 场景 | 断言 |
|---|---|
| fallback_without_partial | 首个 Provider 返回 503 且没有正文时调用第二个 Provider，最终有增量和 fallback 记录 |
| stop_after_partial | 首个 Provider 已交付正文后缺少协议终态时只调用首个 Provider，抛出 `route_exhausted + partialOutput`，不静默拼接第二段正文 |
| anthropic_to_openai_fallback | Anthropic 首个 Provider 返回 503 时切换到 OpenAI-compatible，并保留增量和 fallback 记录 |
| anthropic_partial_stops_chain | Anthropic 已交付正文后缺少 `message_stop` 时停止链路，不切换到 OpenAI-compatible |

这部分当前为 4/4 通过。JSON 的 `recovery` 数组只保存场景名、通过状态、调用次数、是否发生 fallback、是否停止部分输出和增量字符数，不保存 Provider 地址、模型名、请求正文或错误详情；顶层 `passed=false` 或进程非零都表示门禁失败。

## 真实 Provider 的显式测试

只有明确传入 `--real` 才会读取下面的临时环境变量：

```bash
EG_MATRIX_PROTOCOL=openai \
EG_MATRIX_BASE_URL='https://temporary-provider.example/v1' \
EG_MATRIX_API_KEY="$TEMP_PROVIDER_KEY" \
EG_MATRIX_MODEL='temporary-model' \
pnpm --silent provider:matrix -- --real --json
```

真实模式至少验证一个显式 Provider 的流式正常完成；可以再提供第二组 fallback 环境变量，顺序验证两个协议或供应商的连通性。只配置一个 Provider 时 `recoveryStatus=not_run`。配置完整的 primary/fallback 两组时，脚本还会用本地夹具注入 primary 的无正文 503 和部分输出终态，分别验证生产 `routedLlm` 使用真实 fallback 完成，以及已有部分输出时不调用真实 fallback；这两条受控场景通过时 `recoveryStatus=partial`。真实网络 smoke 不会注入真实上游故障、取消或超时，因此不会把受控恢复写成完整真实故障矩阵，也不会因为两次连通性 smoke 成功就声称生产自动降级已经覆盖全部情况。

单 Provider 仍兼容原有命令。需要比较两个 Provider 时，第二组变量必须完整提供（协议只接受 `openai` 或 `anthropic`）：

```bash
EG_MATRIX_PROTOCOL=openai \
EG_MATRIX_BASE_URL='https://primary-provider.example/v1' \
EG_MATRIX_API_KEY="$PRIMARY_PROVIDER_KEY" \
EG_MATRIX_MODEL='primary-model' \
EG_MATRIX_FALLBACK_PROTOCOL=anthropic \
EG_MATRIX_FALLBACK_BASE_URL='https://fallback-provider.example' \
EG_MATRIX_FALLBACK_API_KEY="$FALLBACK_PROVIDER_KEY" \
EG_MATRIX_FALLBACK_MODEL='fallback-model' \
pnpm --silent provider:matrix -- --real --json
```

JSON 只会把结果命名为 `real_primary_stream` / `real_fallback_stream`，保留协议、终态、错误类别、输出字符数和单次耗时；恢复数组只保留固定场景名、调用次数、fallback/停止标记和增量字符数，不写入 Provider ID、地址、模型名、Key 或正文。`evidenceBoundary` 会列出真实 smoke 的已证实和未覆盖项。fallback 这组真实 smoke 现在同时证明“真实 fallback 能接住受控 primary 故障”，但真实 primary 上游故障仍需要故障代理或可控的真实错误场景。

拿到临时账号后，也可以把这一步作为统一桌面闸门的显式阶段：

```bash
pnpm --silent desktop:gate -- --json --include-real
```

不传 `--include-real` 时，闸门会把 `provider-real` 标为 `not_run`，不会读取真实凭据。

## 证据边界

这份脚本证明生产 OpenAI / Anthropic 适配器在本地可控 HTTP 场景下遵守统一恢复契约。它不能证明：

- 真实 Provider 的 SLA、额度和限流行为；
- Tauri WebView 的首 token、取消或窗口切换表现；
- 工具副作用未知时的账本恢复；
- Windows/Linux 安装包和系统网络代理行为。

这些场景仍需要 Mac WebView 黄金路径、临时真实账号或故障代理，以及原生 Windows/Linux runner 的独立记录。

跨平台 CI 会在三种 runner 上运行本地矩阵，并把脱敏的 `provider-recovery-matrix.json` 与桌面 bundle 一起作为构建产物上传；这仍是本地可控场景证据，不能替代真实 Provider 故障矩阵。
