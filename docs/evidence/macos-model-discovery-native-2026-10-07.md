# macOS 原生模型目录与显式调用检查验收

2026-10-07，macOS QA `0.1.0/x64`，实际运行时间为 07:31:59–07:32:10 CST（2026-10-06 23:31:59–23:32:10 UTC），总耗时 11.298 秒。首次运行通过 **5/5 阶段、12/12 断言、15/15 AX 操作**，退出码 0；没有失败试跑或诊断重试。

| 阶段 | 实际观察 |
| --- | --- |
| 新 HOME 启动 | 读取非空的 8 个合成模型；GET 1 次，UI 就绪后观察 1102 ms，推理 POST 为 0。SQLite 没有检查时间或统计。 |
| 设置页费用说明、刷新、连接测试 | 首次推理前，AX 观察到费用与停止边界说明；刷新、连接测试各 GET 1 次，观察 1100 ms，POST 为 0。 |
| 明确点击检查 | 实际 POST 8 次，全部为固定测试文本 `hi`、`max_tokens=1`、无 `stream:true`；SQLite 为 `probed=8, ok=8, unknown=0, notProbed=0`。 |
| 同 profile 受控重启 | 检查统计保留；再次观察 1101 ms，新增 POST 为 0。 |
| 收到响应头及部分 JSON 后停止 | 第二批恰好发起 4 路请求，服务端保持正文未结束。AX 点击停止后，4 个 peer end 和 socket close 均发生在应用活着、任何清理之前；随后观察 1101 ms，没有替补请求。UI/SQLite 为 `total=8, probed=4, ok=0, missing=0, unknown=4, notProbed=4, stopReason=cancelled`。 |

整轮 GET 3 次、POST 12 次；`startupProbeCount=0`、`nonProbePostCount=0`、`actualTaskSubmitCount=0`、`unexpectedRequests=0`。所有自有应用、AX helper 进程组均退出，服务端剩余 socket 为 0，新 HOME 已删除。SQLite 只读核验，没有预先注入模型检查缓存，没有读取私有配置或继承 Provider key 环境。

取消后的 peer end 为约 2.440–3.440 ms，socket close 为约 3.440 ms，服务端墙钟分辨率为 1 ms。它们通过本次 1500 ms 内关闭的功能门槛；这是单次合成连接证据，不能推广为性能基线、真实 Provider 停止计算或退费结论。AX 的文字及窗口/祖先 ScrollArea 边界支持说明和统计的 UI 可见性；没有像素截图或全部 AX 属性读取证明。

## 来源与构建绑定

- [完整原始报告](macos-model-discovery-native-2026-10-07.json) 为 `/tmp/eastgenesis-model-discovery-native.json` 的逐字节副本，SHA-256：`4d1576e56098453742dcc8b398abe119415867250c9841c9e6cd109db0db7537`。
- [构建清单](macos-model-discovery-build-manifest-2026-10-07.json) 包含全部 286 个输入；构建及 GUI 运行的输入起止摘要相同，Root 另外逐文件核对当前源码、binary、manifest、harness 与 cleanup helper。
- binary SHA-256：`a47f7f0499b0b5c5f0bccc8ed271ab9be36e9689ebb287e5b8524e8c4341d243`；新 harness SHA-256：`72fafa44c37851c309a72f4604563bc44da49bf9ec9c23894e5ce407b971df94`。临时 Swift helper 可执行文件的起止摘要也一致，随后随自有 HOME 清理。
- 这是工作树 QA 构建，`formalReleaseBinding=false`。HTTP 成功只证明合成检查连接与统计流程，不证明模型质量或完整任务能力；不覆盖 Windows/Linux、真实双 Provider、启动性能、签名或公证。
