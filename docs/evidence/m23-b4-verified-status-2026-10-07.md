# b4 / 1c739 固定来源验收与 M23 边界

日期：2026-10-07。本文只说明下列固定来源；后续尚未纳入 b4 的存储恢复或 Windows 启动输入诊断候选不覆盖这些结果。产品状态仍为 Alpha / 内部 QA，M23 未完成。

不可变 local commit 为 `b4cfd3aa37a5dd6804444fd0bbe90187d61f39fe`，local source tree 为 `299d70a34eaaed6a92e312b8d6e0684848872548`；公开 commit 为 `1c739f737e74b62d49d715b61fb6f04cb74ac122`，public tree 为 `ce6c3a9f9a4427fecb40c6939a1501b1c48fa3ae`。CI Root 核验 754 个 public/local Git blob 和 mode 相同；本机额外 MEMORY.md 排除于该公开来源，不读取其内容。本次 M23 文档候选从 b4 的原始文件生成，原文 63,711 bytes、SHA256 `bfa65bff04faba01879fbb85fd9113c9e8dcdfc9bdf655df46ee4b0c5e8ea06f`。

## 实际 macOS 完整 Goal 合成场景

[Root 原生独立核验](macos-b4-goal-v12-r1-root-verification-2026-10-07.json) 分别记录 v12 与 v12-r1 的实际 PASS；二者绑定同一 b4 完整 754 文件 QA App。本目录保存 [v12-r1 实际报告](macos-b4-goal-v12-r1-native-2026-10-07.json)，运行 UTC 06:51:38.870–06:52:05.660，elapsed 26,790ms。binary SHA256 为 `80e3211dec57031072620017d88b82bf99e55606236ad388553dcc8f2390f2c2`；QA manifest SHA256 为 `d28a1ab3db438a46b8c0acd603e63f5559b94db0b8e4b5a96d47ca9717fc8ce5`；controller SHA256 为 `38b3302e2f9432ef0c2832ba79fd192bf70070941331a357b3064d159b2556c4`。

实际 UI 保存两个合成 loopback Provider，两个 GET 各1，Goal提交前 POST0。同一 Goal 执行 Work真实MCP读文件→Codex真实MCP写文件→Chat fallback→summary保留部分输出后失败，持久化为 Goal paused / round interrupted / checkpoint failed。受控退出与重启后恢复同一 task/round，已接受 Chat 标记进入实际恢复请求，点击继续仅新增 summary。恢复前后两个 ledger 均为 applied，read/write调用身份与指纹、41字节产物的内容摘要/inode/mtime不变；`noToolOrProbeReplay=true`。逻辑调用3→4，实际POST合计4→5，最终分布A4/B1。明确QA确认产物完成后，场景存储终态为 Goal completed / round done / checkpoint completed。

Root逐项验证80个typed AX动作，其中51项 fresh owned PID+CF identity proof，以及restart后的数据库身份。v12-r1的fresh read只用于决定打开已有Goal，`visibilityClaimed=false`；实际strict press保留完整扫描、唯一、enabled、visible和PID/CF身份门禁。输入检查的 `inputCheckPassed=true` 与 `nativePassed=false` 只表示执行前来源检查；172项静态检查也不是原生通过。真实PASS来自另一次原生报告及Root核验，不能合并计数。

源码、原App、复制App、binary、harness与helper起止绑定不变。所有自有App/helper进程组、MCP helper和fixture/profile清理完成，剩余fixture sockets0，`cleanup.safe=true`。这是两个合成Provider的单场景桌面证据，完成包含明确QA确认；它不是实际外网上游连通性、真实Provider故障矩阵、广泛助手质量或性能基线。

[历史v11原始失败](macos-b4-goal-v11-native-failure-2026-10-07.json) 独立保留：Provider登记和partial-failure通过，受控重启阶段失败；`restart_home_navigation`按下后，`restart_open_existing_goal`完整扫描match0，未取得resume/completed证明。其 `nativePassed=false`，清理安全；该失败不能被后续v12-r1报告覆盖，也没有证明Goal存储丢失。

## 新 CI 终态及平台范围

[run37580929560](https://github.com/ChaoYuZhang001/eastgenesis/actions/runs/37580929560) 已 completed/failure。Ubuntu job112660171376和macOS job112660171518 success，Windows job112660171525 failure。[终态审计](ci-1c739-terminal-audit-2026-10-07.json) 与 [Root核验](ci-1c739-root-verification-2026-10-07.json) 基于实际job原日志和5份kind-bearing stdout，命令echo中的JSON排除。

- Mac/Ubuntu frontend唯一1076pass/0skip；Windows唯一1070pass/6skip，剩余是Unix进程组用例。Rust后MCP15中11条补齐cold skip、4条重复；另3条cross-process rerun不叠加到唯一计数。
- Windows SQL普通13unit+1doc、QA19unit+1doc实际通过；普通/QA均执行share_mode真实短锁释放后删除和持续锁预算后硬失败回归，跨平台未编译的Windows专有用例不借用Mac/Linux通过。
- Windows第22步 `Smoke-test real Windows NSIS installation lifecycle` 的cycle1，在第一且唯一一次外部schema probe启动时失败：`process_job` / typed substage `process_create` / Win32 123，HResult与suspendCount均null。应用4秒稳定窗口、进程/窗口存活、数据库存在，36条trace完整且最后为 `frontend_ready`；这些证明应用连接/迁移/前端ready被观察，外部schema7仍未验证。成功launch记录0，same-package repair与cycle2未到达，Windows DOM未到达。NSIS安装/payload/registry及失败后卸载binary/registry清理通过。实际application/cwd/command未记录，123本身不能指明哪个输入非法。见[实际Windows stdout](ci-1c739-windows-install-actual-stdout-2026-10-07.json)。
- Linux四个实际Tauri DOM场景 `staged`、`slow-first-token`、`truncated`、`idle-cancel`通过，各n=1，仅描述性观察。Deb解包schema7通过；同源码QA版本0.1.0→0.1.1实际dpkg两cycle均安装进程身份/schema7/4000ms存活窗口通过，sentinel保留并purge清理。不同QA版本号不证明生产跨版本代码/schema迁移、updater或rollback。
- macOS CI unsigned package smoke通过，实际DMG6,929,037 bytes；该CI没有macOS DOM执行，macOS本地完整Goal AX证据独立记录，不能与CI平台范围混用。签名/notarization与生产分发仍未证明。

完整capture ZIP继续保留在受控 `/tmp`，不把107份捕获文件批量复制到文档：`eastgenesis-ci-1c739-complete-evidence.zip` 为523,467 bytes，SHA256 `edb2ba2b3d15e4dfdc6ef853d4d7d2e930d19b07b1098ed2d51136e5610174f7`，108 members。其[完整索引](ci-1c739-complete-sha256-index-2026-10-07.json)列107个文件、2,617,727 bytes，index自身和ZIP不在索引内；Root已核验所有冻结member内容。本次文档准备重算ZIP大小/SHA及member数，不重新运行watch、API或下载。

## b4 仍失败的存储窗口

[原始RED与设计报告](goal-b4-settlement-red-and-design-2026-10-07.json) 绑定同一b4 754文件来源；[RED原日志](goal-b4-settlement-red-2026-10-07.log)实际3failed/4filtered，另一次[既有兼容原日志](goal-b4-settlement-compatibility-2026-10-07.log)4pass。它们与CI计数独立。

1. `终态 checkpoint 成功但旧3次调用结算失败时，重启继续先补结算且不越过 max3`：实际新增一次summary，Goal错误显示completed/used1，而期望在已有3次调用后不能再调用并保留used3。
2. `completed checkpoint 已成功而调用结算失败时，重启继续仅补结算和Goal收尾，不再执行模型或文件`：实际Goal paused/used0，checkDone0，没有完成结算与收尾。
3. `Runtime完成但completed checkpoint拒写时，同进程继续仅补保存和Goal收尾，保留已接受Chat且无副作用重放`：实际Goal仍paused，round interrupted且checkpoint running，checkDone0，没有完成终态保存与收尾。

该报告形成时 `candidateImplemented=false`，只有候选设计；后续Root的修复、验证与落地状态不在这些固定输入中，必须用新来源更新。正常存储的GUI PASS不能覆盖这些故障窗口，也不能由持久化失败直接推断文件必然重复执行。

历史v11、c16/v10 candidate-only及旧CI失败仍各自保留原来源。真实双Provider、生产跨版本/schema迁移、签名/公证和三平台性能缺口继续保留；未达到M23整体结束或邀请制Beta门槛。

## 固定副本大小与SHA256

下列文件均为指定实际来源的逐字节副本，未修改字段或删掉失败结果；staging清单另保存原sourcePath、source SHA/bytes及副本一致性。

| 固定副本 | Bytes | Source及副本SHA256 |
|---|---:|---|
| [ci-1c739-root-verification-2026-10-07.json](ci-1c739-root-verification-2026-10-07.json) | 4568 | `577461de4fb27cfbeb6d3418e4ccdceaa9229940a08957d0c91e1d1bf12cea9b` |
| [ci-1c739-terminal-audit-2026-10-07.json](ci-1c739-terminal-audit-2026-10-07.json) | 15741 | `c86cf5eb6c20b5feb62534444bac27ce6356bd9e67665115340ed0c867e66e02` |
| [ci-1c739-complete-sha256-index-2026-10-07.json](ci-1c739-complete-sha256-index-2026-10-07.json) | 19292 | `2d0a5fc3f8bf0500bce3d8b97422b3921c22b2b4ad7a243a5d5941c89b0b151f` |
| [macos-b4-goal-v12-r1-root-verification-2026-10-07.json](macos-b4-goal-v12-r1-root-verification-2026-10-07.json) | 2115 | `9991c3b73e840996dac9f394a756a82857888c88bc9dc3d68edca92491930c18` |
| [macos-b4-goal-v12-r1-native-2026-10-07.json](macos-b4-goal-v12-r1-native-2026-10-07.json) | 1025412 | `28db71939675c4c348f613afd14d4bff590f5d091f38aabe953e914b3e0e70bd` |
| [macos-b4-goal-v12-r1-input-check-2026-10-07.json](macos-b4-goal-v12-r1-input-check-2026-10-07.json) | 97257 | `249e851ca4b0a11532100e0ce13591b0335380a34e164000867bd3695ef0f49b` |
| [macos-b4-goal-v12-r1-static-summary-2026-10-07.json](macos-b4-goal-v12-r1-static-summary-2026-10-07.json) | 6375 | `23306f473b54ad8e8cef015b70c6fd60667abb652e1344011d240e92ed3476af` |
| [goal-b4-settlement-red-and-design-2026-10-07.json](goal-b4-settlement-red-and-design-2026-10-07.json) | 2521 | `e9f4b960e0a8eeb5f43cbcab4aa3087d07903fa9755b4de4b5259703c4b1edac` |
| [macos-b4-goal-v11-native-failure-2026-10-07.json](macos-b4-goal-v11-native-failure-2026-10-07.json) | 908630 | `fcf26ec4e8bfe8e9b5b28a7f70f5e6ed414a3b0c3ca44fa6adf16e073d2a909b` |
| [goal-b4-settlement-red-2026-10-07.log](goal-b4-settlement-red-2026-10-07.log) | 10533 | `5e453df208ca6b06662eb0fbd784ec883883036e26a6c1adfec216fb76fa7de9` |
| [goal-b4-settlement-compatibility-2026-10-07.log](goal-b4-settlement-compatibility-2026-10-07.log) | 343 | `a0690a1a41a2b5fc406a8c132053ad2d49782a0b5a8c5500af32023b463ff085` |
| [ci-1c739-windows-install-actual-stdout-2026-10-07.json](ci-1c739-windows-install-actual-stdout-2026-10-07.json) | 9504 | `f1cdf747428001f4c65d35c3f96706c5883ac49bfdd592352e613b800c47d84d` |
