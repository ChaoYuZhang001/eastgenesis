EastGenesis 原生源传输取消只读审查

结论：M23 产品取消 P0 尚未通过。Rust 的取消标志不能唤醒已挂起的闲置响应体读取；前端已停止与源连接已关闭是两项不同的验收结果。本批未修复 Rust 取消，也未修改生产源码。

范围：仅读取代码、访问官方协议/依赖说明、运行独立临时 loopback 实验。未运行 GUI、未读取私有配置、未调用真实 Provider、未 commit/push。报告不包含绝对路径、用户标识、URL、密钥或源正文。

Rust 实验固定参数：复制生产 net 模块到独立临时 harness，仅公开预算函数；使用已编译的 reqwest 0.12.28。read timeout=400ms，total timeout=800ms，头部后 20ms 在独立线程设置取消标志；服务端发 HTTP 头并声明 Content-Length 100，保持响应体闲置。服务端观察上限 1200ms，进程 watchdog 2500ms。

精确输出：read_budget_ms=400 headers_ms=Some(4) cancel_ms=Some(25) finished_ms=414 server_peer_closed_ms=Some(415) chunks=0 result=timeout

这项实验证明：25ms 已取消时，原生读取与连接仍存在；414ms 读取超时返回 timeout，415ms 才观察到 peer close。400ms 是缩短实验预算。生产 60000ms 单次读取预算为源码值，未做 60 秒生产实测。

机制位置：src-tauri/src/net.rs:17-18、83-91、109-141 只在响应头后及读取前检查 AtomicBool；reader.read 没有取消唤醒机制。src-tauri/src/lib.rs:207-211 仅 flag.store；181-202 在 worker 返回后才移除 streams 记录。src/platform/tauri-backend.ts:75-104 对前端立即 error、清队列并忽略迟到事件。

180 秒总预算的附加边界：net.rs:127-141 的 deadline 只在读取之间检查；临近 deadline 启动的读取可再消耗一次 read budget。严格 180 秒 wall-clock 上限未被代码保证；该超时延长是源码推导，未进行长时实验。

Node 实验使用实际 src/core/llm/http.ts 的 postJson/readSse 与本机 Node v22.23.1 / Undici 6.27.0。provider timeout=2000ms，abort 后观察 600ms，watchdog=2500ms。普通例：headers30ms、caller/source abort31ms、ProviderError aborted34ms、server close37ms。8 轮显式 GC 例：headers29ms、caller/source abort63ms、ProviderError aborted67ms、server close70ms。本机这两个有界场景未复现弱引用取消失败。

http.ts:47-59、63-68、86-95 保留 source signal 的 abort 监听，直到正文 finally；123-149 依赖 Fetch 对 body 的 abort 实现，没有主动 reader.cancel/release。Fetch 标准规定已到响应头后仍应对响应体报 abort。安装的 Undici 有 WeakRef/FinalizationRegistry 机制，但仅此不能判为当前浏览器故障。浏览器 dev/tests 选 memory mock，桌面流式模型请求经 proxy-fetch.ts:61-70 走 IPC + Rust。Windows budget agent 的 tools/provider-matrix.ts 取消 reader 修复必须独立归属，不可替代 Rust 源传输取消证据。

此前证据边界：tools/desktop-webdriver-smoke.mjs:418-433 的 idle-cancel 等首 chunk DOM、点击停止、等待已停止，没有服务端 close、socket、worker 或 streams-map 断言。desktop-stream-fixture.mjs:77-87 先发一条 delta 后保持 120000ms；close 仅清 timer，无关闭时间记录。webdriver smoke:508-522 结束时先删 session/停 driver，应用退出也可清理残留连接。desktop-stream-fixture-smoke.mjs:27-47、145-151 是直接 Node Fetch 并只看 AbortError。tests/llm.test.ts:113-130、154-168 的手工 ReadableStream error 是适配器状态/错误映射证据。

后续最小方向：改用 async reqwest，采用 watch/CancellationToken 或正确处理无丢失唤醒的 Notify + AtomicBool；同时把 send、chunk 等待与取消/总 deadline select，取消时 drop Response。保持原先的闲置预算、增量脱敏与部分输出策略。不要缩短 read timeout 轮询后吞掉/重试 timeout，这可能误杀正常慢响应。

验收补口应同时断言：app 继续运行期间，idle cancel 后服务端 peer close 及时发生，native worker/streams 记录释放；前端不出现迟到 delta；slow-first-token 与部分输出/脱敏回归通过。尚未验证浏览器引擎、QA binary GUI、本机生产 60 秒值、真实 Provider 费用或对端计算终止。

参考 QA binary SHA256：b7ce68b84a935cfb902535346d390c98b1491431ae75a758dd474c17ff90b96d。此值来自主任务，本审查未启动或复验该 binary；13 权限 + 3 恢复证据不可外推为源传输及时取消。

所审源码 SHA256（全文件值在报告生成时取得；net.rs tests 正由主任务并行修改，故额外列出实际审查的生产前缀哈希）：

- src/core/llm/http.ts: 1a1927485f7054bccada515a396bb296ed6cd69730c006bbe3431d122103aeff (whole file at report creation; read-only audit)
- src-tauri/src/net.rs: e8646fa1c4c477c1829396cef443c9f41d5877fefabb4d3400f9fb7e1db03ad9 (whole file at report creation; read-only audit)
- src-tauri/src/lib.rs: cd9c2997a85d7e8a205f117ef6430897a5c27a82ea1c0b411f3c5b3bd79a4780 (whole file at report creation; read-only audit)
- src/platform/tauri-backend.ts: 9f5d4c3ead7e3c42bb2d0a7b3c837188dec40910de28fb65d7ce480721cff82d (whole file at report creation; read-only audit)
- src/platform/proxy-fetch.ts: a9cc43d9707ba797658f761e293616034c2ed410fba2c0c064d9d7d540cea456 (whole file at report creation; read-only audit)
- src/platform/index.ts: c8ea8aa72f3bcdebf11c8c210660b9afa6e6fd6e6f275d6a15ffd6c2779371dc (whole file at report creation; read-only audit)
- src/lib/providers.ts: 38f06fe1516a0dbb6baec1d25877076275b9a355ea1d861c0994b9bb69ace9f7 (whole file at report creation; read-only audit)
- tools/desktop-webdriver-smoke.mjs: 2d3ad03ab1cdd29eab1df706966c1f82841d2560798ce46b0942f6c36d98f53b (whole file at report creation; read-only audit)
- tools/desktop-stream-fixture.mjs: 8ec9c7997021d84df8b4cb06674ce858995e27b65643502924ea42e30104eb25 (whole file at report creation; read-only audit)
- tools/desktop-stream-fixture-smoke.mjs: 944b95ed4db609c9d6ce15d80b73c2074b63adda4dfde4318a992a698b5ce3fe (whole file at report creation; read-only audit)
- tests/llm.test.ts: 9e50f24c3a1f1f8f6267fc6494ccc0d56a801c6f8f25f08e84369833978952c5 (whole file at report creation; read-only audit)
- src-tauri/Cargo.toml: d9a93f6b2c6afee46d919145c9006f9ee32104a257338dba95e8a5900f1c11e4 (whole file at report creation; read-only audit)
- src-tauri/src/net.rs: 90b3487a932c95d6bdfdf745f4f64d74a2b09231f2449a52efdb1242dae22791 (production prefix only, ending before cfg(test); concurrent changes to tests excluded)

Rust harness SHA256: 11b4f83085d0d17cf889dd2fbe923d8d2a89285fc8d582358fd140c52820bfc9
Node harness SHA256: daf4ffcac764152d1a4f3cf517f37212aba3de86b21e830eafc4eebdaa7feeb4

临时报告：eg-native-cancel-audit-20261007.json；eg-native-cancel-audit-20261007.md。详细结构化参数、输出、证据边界与实现建议见 JSON。
