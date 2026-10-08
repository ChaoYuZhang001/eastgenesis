# M23 执行计划：从确定性 Alpha 到可验证桌面 Beta

日期：2026-10-07
适用项目：EastGenesis Desktop
当前阶段：Alpha / 内部 QA

### 当前证据：760b/e723 原生与 CI 已核验，Windows Python 选择修复待新 CI

已结束的最新完整来源为本机 `760b1b21feb03f8f7fede759910e3e52f9830130` / 公开 `e723361f4fe5fbb90c65227c76c5bd3b8af50371`，787 个公开源码文件。调用结算与完成收尾修复已包含在此来源；原 3 条存储 RED 测试保留原字节，修复后的隔离 13 文件 / 137 条全通过。此来源本机完整 110 文件 / 1132 条全通过、零跳过，typecheck/build、SQL 普通 12+doc1 与 QA 18+doc1 均通过；55 条合成配置/脱敏用例包含在全量内。[本机修复范围](evidence/goal-settlement-recovery-local-2026-10-07.md)、[来源门禁](evidence/settlement-windows-current-gates-2026-10-07.json)。

[e723 run37593401238](https://github.com/ChaoYuZhang001/eastgenesis/actions/runs/37593401238) 已终态：macOS / Ubuntu success，Windows 在原第 22 步 NSIS 外部 schema probe 的 `CreateProcessW / Win32 123` 失败。Windows 新输入诊断记录 application 不存在且 fullPath 比较失败，但没有记录 Python discovery 数量，具体根因尚不能确诊；应用存活、DB 存在、启动 trace 和失败后卸载通过，不能替代 schema7、repair、第二 cycle 或 Windows DOM。Linux 四个真实 DOM 场景及同代码 QA Deb 安装/递增版本 fixture 升级/purge 通过。各平台唯一前端计数、SQL 结果和限制见[固定 CI / 原生证据](evidence/e723-terminal-ci-and-native-2026-10-07.md)。

760b 的新 macOS QA 缓存构建和完整真实 Tauri/AX Goal 场景已通过并完成独立只读复核：实际 UI 登记两个合成 Provider，Work 读文件→Codex 写文件→Chat 切换与总结部分失败，受控重启后在同一 Goal/task/round 继续仅新增 summary；原读写/probe 不重放、文件与 applied 账本不变。逻辑计数 3→3→4，实际 POST 4→5；明确 QA 点击“确认已完成”后才收尾。原十分钟 cold 构建超时保持失败。此场景及新 settlement 窄测是不同证据，均不证明真实上游、全部存储故障、完整账单或生产升级。[固定 CI / 原生证据](evidence/e723-terminal-ci-and-native-2026-10-07.md)。

当前后续候选已应用 Windows Python 选择 r2：选择一个实际 ApplicationInfo，再读取并验证单个完整 Path；原 Native C# 启动器、Python SQL 探针、Job-before-ResumeThread、NSIS 修复/两轮验收链逐字保留。隔离候选的既有 68 项消费者契约与 typecheck 通过，无新增源码字符串镜像测试；新增双 PATH、真实 Win32 123、物理 SQLite 与后代 Job 清理回归只在新 Windows CI 执行。本机未执行 PowerShell/WinAPI，旧 e723/native 结果不挪给后续源码。[Windows r2 范围与边界](evidence/windows-python-selection-r2-local-2026-10-07.md)。

新运行完整计数可幂等结算；legacy 缺失或运行中计数仍可能未知，未知且未完成时安全暂停，产品尚无补录次数/解除暂停入口。独立正余额 Jev、raw fallback 完整调用计量、旧 task usage 一次性标记、一般 checkpoint 新鲜度和任意长 accepted-output 保留仍待补齐。真实两个独立 Provider、三平台签名/公证、生产跨版本迁移、性能基线和广泛任务质量也尚未证明；产品继续为 Alpha / 内部 QA。

### 历史验收：b4/1c739（固定旧来源）

本节历史验收绑定不可变源码 `b4cfd3aa37a5dd6804444fd0bbe90187d61f39fe`、source tree `299d70a34eaaed6a92e312b8d6e0684848872548` 与公开快照 `1c739f737e74b62d49d715b61fb6f04cb74ac122` 的 754 文件；后续存储恢复和 Windows 启动输入诊断候选未包含在该 CI 或 QA binary 的来源中。以下结果不代表 M23 完成，产品状态继续保持 Alpha / 内部 QA。见[固定来源与验收边界](evidence/m23-b4-verified-status-2026-10-07.md)。

- b4 完整来源的真实 macOS Tauri/AX Goal 场景在 v12 与 v12-r1 均为 synthetic PASS；v12-r1 原生运行 UTC 06:51:38.870–06:52:05.660，26,790ms。两个合成 loopback Provider 由真实 UI 登记，实际 Work 读文件→Codex 写文件→Chat fallback→summary 部分失败；受控退出和重启保留同一 Goal/task/round、accepted Chat 与 partial，点击继续只新增 summary，read/write 与账本 probe 均未重放，两个 applied ledger 的身份/指纹及文件字节/inode/mtime 不变。逻辑调用 3→4、实际 wire POST 4→5；完成包含明确 QA 确认，确认后场景 Goal/round/checkpoint 才为 completed/done/completed。754 源、QA App、harness/helper 起止绑定和自有进程/fixture/profile 清理由 Root 独立核验。此前 v11 的 Provider 与 partial 阶段通过，但重启导航后打开已有 Goal 完整扫描 match0，原生失败、未证明恢复/完成；原报告独立保留。该通过只覆盖此合成场景，不证明真实上游 Provider、存储失败恢复或广泛任务质量/性能。见[原生固定来源](evidence/macos-b4-goal-v12-r1-root-verification-2026-10-07.json)。
- 新结束 [1c739 run37580929560](https://github.com/ChaoYuZhang001/eastgenesis/actions/runs/37580929560) 绑定上述 b4/public 754 blobs/modes，整体 failure，Mac/Ubuntu success，Windows 在第22步 NSIS 生命周期验收失败。Mac/Ubuntu 前端唯一1076全pass；Windows唯一1070pass、6个 Unix 进程组用例skip，MCP与跨进程重复不叠加。Windows SQL普通13+doc1、QA19+doc1通过，真实 share_mode 短锁释放后删除成功与持续锁预算后硬失败均在普通/QA执行。首轮外部 schema 探测仅尝试1次，即 `process_job/process_create`、Win32 123；应用4秒存活、DB存在、36条启动trace完整且到达frontend_ready，不能替代外部schema7。NSIS安装/registry和失败后卸载清理通过；repair、cycle2、Windows DOM未完成，具体非法输入仍未知。Linux四真实DOM及同源码QA0.1.0→0.1.1 dpkg两cycle/schema7通过；Mac CI仅unsigned package smoke，CI DOM未运行。Root核验107份捕获/5实际stdout和完整ZIP，echo JSON不计执行证据。见[新CI固定终态](evidence/ci-1c739-terminal-audit-2026-10-07.json)。
- b4 来源当时确认3条新隔离存储回归 RED：终态 checkpoint 成功但旧调用结算失败后恢复越过max3；completed checkpoint 已落库而调用结算失败后无法仅结算并收尾；Runtime completed但completed checkpoint拒写后无法仅补保存并收尾。原始RED运行3failed/4filtered；另一次既有兼容验证4pass，分别保留，不计入CI通过数。该RED报告形成时仅有候选设计、没有修复实现；后续候选结果须由Root以新来源更新，不能用上述正常存储GUI通过覆盖这三个故障窗口。见[存储RED与设计](evidence/goal-b4-settlement-red-and-design-2026-10-07.json)。

以下条目保留本次 b4/1c739 核验之前的历史状态；其中“最新”“待执行”等措辞只描述当时快照，不覆盖上方来源限定的结果。旧 v11、旧 CI 失败以及真实 Provider、签名/公证、生产升级/schema迁移和性能缺口继续保留。

- 新候选已修复真实checkpoint adapter吞掉store错误字符串的问题，并在ordered stop受控显示固定存储错误，原Goal/task/round和stop boolean语义保持；Windows数据库测试夹具改为runtime先销毁再删除，只有实际Os32/33短预算重试，持续锁仍硬失败。Root正常仓库108文件1076项全pass/零skip、typecheck/build、SQL普通12+doc1/QA18+doc1通过，558项输入和实际MCP起止不变；全量内配置/脱敏55项已实际计入。真实Windows锁、NSIS、新source QA/完整Goal待执行，不证明stale checkpoint freshness或全部重放风险。见[新候选本机证据](evidence/checkpoint-sqlite-local-2026-10-07.md)。
- 最新已结束[2b509 run37575271906](https://github.com/ChaoYuZhang001/eastgenesis/actions/runs/37575271906)绑定local c16/public2b509的733 blobs/modes：整体failure，Mac/Ubuntu success，Windows Rust第17步的Directory::drop因Os32失败（插件8pass/1fail），尚未NSIS/新的process_job诊断。两成功平台唯一前端1073全pass，Windows1056pass/17skip；Linux四真实DOM和同源码QA Deb安装升级通过，Mac真实DOM未运行。Root新鲜API和85捕获/ZIP及Git来源独立核验。见[最新CI终态](evidence/ci-2b509-three-platform-2026-10-07.md)。
- c16完整733源QA及独立核验通过；新macOS v7/v8/v9保持安全失败，v8完整1188节点但同名复选框raw2，v9明确按键前owned PID前台guard失败且未发按键。v10实际CFEqual/PID证明两模型各2引用为同一owned控件，GET各1/POST0、完整扫描与清理/source绑定通过；这是candidate-only身份诊断，nativePassed=false/Goal未运行/visible=false。必须新活PID自证且保留控件可见/唯一门禁，后续完整Goal绑定新QA而非借用c16身份通过。见[macOS原生诊断](evidence/macos-c16-unified-goal-diagnostics-2026-10-07.md)。
- Windows受控进程诊断候选已实际应用，基线31dcc，四文件哈希与固定补丁相同。Root正常仓库4文件85项（Windows30+合成配置/脱敏55）及typecheck通过，558输入起止不变；process_job首失败停止数据库轮询，固定四字段报告具体阶段/Win32/HResult/suspendCount，保留先AssignJob后Resume和外部schema7验收。PowerShell/C#/WinAPI本机未执行，实际错误根因与完整安装仍须下一源码快照CI，不能将诊断增加写成修复通过。见[Windows诊断候选](evidence/windows-process-job-diagnostic-local-2026-10-07.md)。
- 目标轮次正文候选已完成本机验证：新UI7项、相邻3文件22项和typecheck通过；Root全量108文件1068项零失败/零跳过，558项输入与真实MCP起止不变，build和合成配置/脱敏55项通过。RoundItem现在显示生成、保留partial和最终总结，顶部继续沿用原task/原轮，实际临时文件不重放、Chat标记进入恢复summary、计数3+1=4。见[目标正文本机证据](evidence/goal-output-ui-local-2026-10-07.md)。新的31dcc完整721源文件QA构建及独立核对通过，binary d2446cb1；实际native v4/v5启动门禁失败，v6初始启动1365ms与两个合成Provider真实UI保存/GET各1通过，但能力矩阵AX扫描不完整而停止，POST0、Goal未提交、任务执行/恢复未证明，清理与结束绑定通过。见[新QA及原生失败证据](evidence/macos-unified-goal-output-native-2026-10-07.md)。后续Windows工具/文档候选须新的完整QA绑定及新CI，不借用cf8或旧a035的通过。
- 历史已结束[cf8 run37568809472](https://github.com/ChaoYuZhang001/eastgenesis/actions/runs/37568809472)整体failure，Mac/Ubuntu success，Windows安装验收failure。Windows已跨过目录别名测试、Rust/SQL/MCP/QA打包，并观察typed SQL连接/迁移/加载及frontend_ready；外部schema探测131次都在process_job失败，具体Win32子阶段待验证，完整安装/reinstall/WebDriver未完成。Mac/Ubuntu唯一前端1061全pass；Windows唯一1055pass+6平台skip。Root核验55份捕获、710 Git blobs、5实际stdout JSON及终态API。见[cf8终态证据](evidence/ci-cf8-three-platform-2026-10-07.md)。
- cf8所含恢复/路由候选已完成最终本机验证：107文件1061项零失败/零跳过，557项列举输入（新增直接import的config及测试读取的BRAND/BENCHMARK）与真实MCP binary起止不变；typecheck、前端build、合成配置/脱敏3文件55项通过，Root逐项重算。此前首次全量1031/1failed和目标修复前1058全部通过分别保留。已接受Chat结果以脱敏4000字段快照保存，反思接受判定由恢复/进度/技能提取共享；Goal failed暂停原轮和原task，继续仅新增summary，真实临时文件不重放，计数3+1=4；默认路由、错误、专家时间线和证据投影区分实际失败与未调用跳过。具体固定来源见[最终本机验证](evidence/completed-step-final-local-2026-10-07.md)、[Chat恢复](evidence/completed-chat-recovery-local-2026-10-07.md)、[目标继续](evidence/goal-failed-recovery-local-2026-10-07.md)、[路由一致性](evidence/route-transparency-local-2026-10-07.md)。这些结果基于parent4fca候选工作树，须新源码快照CI及新的原生构建；当时GoalDetail部分输出/总结正文尚未展示；新的正文候选见上方本机证据，真实统一目标GUI仍待原生验收。未结算崩溃旧调用不追补、长正文非无损，真实双Provider/完整Windows安装/正式发行升级/性能/签名缺口保留。
- 历史已结束的 [567 run37563580233](https://github.com/ChaoYuZhang001/eastgenesis/actions/runs/37563580233) 绑定公开源码 `567fc9e1fc14c991a973440b06d8ccf589576733`、本机不可变提交 `4fca797429fd66f839a6e4ea83613d6834b108d0` 与 source tree `f47c97b25cf2e71d3a66b272bd53986d14d965bc`，终态failure。macOS/Ubuntu success；两平台前端1006passed+11skip，后置MCP15（4重复）补齐唯一1017；普通SQL10+doc1/QA16+doc1以及6个路径回归实际通过。Linux4真实WebView、Deb解包/schema7和同源码0.1.0→0.1.1实际dpkg两cycle各4000ms通过。Windows前端999passed/17skip/1failed，原日志明确为目录别名测试的RUNNER~1短路径与runneradmin长路径期望差异，实际项目范围闸门通过；Rust、SQL修复、NSIS、WebDriver未运行。本机测试已改native realpath并增加dev/ino身份核对，19专项与typecheck通过，待新WindowsCI。Root逐项核验64捕获文件、4份原日志JSON、两个小ZIP成员和新鲜API/tree；当前dirty修复不属于该run。源码归档15,431,680bytes不含target/node_modules/Desktop Git历史。见[567终态证据](evidence/ci-567-three-platform-2026-10-07.md)和[路径测试修正](evidence/windows-native-realpath-test-2026-10-07.md)。
- 最终本机源绑定闸门103文件/1017前端测试零跳过通过，549项生产/测试/工具/资源/工作流输入及真实MCP binary起止摘要相同，Root逐项重算一致；typecheck与合成配置/脱敏3文件55项通过。两App入口/来源门禁19项通过，旧322清单实际被coverage门禁拒绝，新675清单实际起止通过；见[最终本机闸门](evidence/historical-path-local-gates-2026-10-07.json)和[原始起止清单](evidence/historical-path-bound-tests-2026-10-07.json)。这些本机结果绑定当前候选来源，不把新CI待执行阶段计为通过。
- 精确历史QA writer `4a88d966`→readera035的实际macOS恢复已通过：旧App内置MCP移动文件后SIGABRT，新App hydrate同一task/单round，活动lease停止，实际到期probe applied后零副作用重放完成，goal/task均completed。32断言、7动作、自有livegroups/fixture/profile清理通过；writer288输入+525完整Git文件、reader675输入+676完整Git文件在构建/原生起止绑定，Root与独立review重算一致。见[历史QA原生证据](evidence/macos-historical-goal-native-2026-10-07.md)。这是两个版本号同为0.1.0/schema7的指定QA源码恢复，非正式发行升级/schema6迁移；native结果绑定a035，不挪给后续Windows路径补丁。此前“尚未执行”条目仅保留当时边界。
- Windows连接配置候选修复仅对vendor SQL path_mapper的应用目录URL文件部分转义，保留caller query/native join及原database_exists/create/connect；真正SQLx parser与真实SQLite create/reopen/schema7/同inode回归通过。最终普通plugin10unit+1doc、QA16unit+1doc全部通过，Cargo锁不变；具体Windowsverbatim路径机制仍是原CItyped Configuration、源码链及合成parser重现支持的推断。修复后的实际NSIS/重装须新WindowsCI证明；见[路径修复证据](evidence/sqlite-opaque-path-local-2026-10-07.md)。

- 此前已结束的 [b6 run 37559890652](https://github.com/ChaoYuZhang001/eastgenesis/actions/runs/37559890652) 绑定源码快照 `b6a4923b46656cd54cf858862f8fb27bdc19551d` 与本机提交 `a035aa93659a6b834a85aa166677fd663913b9b5`，终态 **failure**。macOS/Ubuntu success；Windows普通/QA targets及全部独立doc、MCP15项和两次QA打包通过，已越过e7链接失败，但NSIS首次启动在 `sql_connect_configuration_failed` 停止，数据库不存在且未进入迁移。安装/payload/registry及失败后卸载清理通过，重装和Windows WebDriver未执行。Mac/Ubuntu独立前端用例998、Windows992且另6个平台skip；5份原日志JSON、69份捕获文件与小诊断ZIP经Root独立复核。见 [b6固定终态证据](evidence/ci-b6-three-platform-2026-10-07.md)。
- 上一轮源码快照 `e7d00dc29f3160b562042809520027989d732544`（本机发布提交 `b781765b3ed346d6da1d91f193f5279aaeb4caff`）的 [run 37555825538](https://github.com/ChaoYuZhang001/eastgenesis/actions/runs/37555825538) 终态为 **failure**：macOS job `112581698088`、Ubuntu job `112581697871` success，Windows job `112581698276` 在普通 Rust 的 vendor `Builder::build` doctest 链接阶段失败。本轮 Windows QA workspace、Rust 后文件 MCP、QA 打包、NSIS 生命周期及 typed SQL 启动 trace 全部 `not_run`；它没有复验或解决旧 9ee 的 `Database.load` reject。Mac/Ubuntu frontend 980 passed+11 skipped，Rust 后 MCP 15 passed 补齐11个并重复4个，即991个独立用例；Windows为974 passed+17 skipped且未补测，不能将skip计为通过。66份捕获文件与四份原日志JSON由Root独立核对，见 [e7终态证据](evidence/ci-e7-three-platform-2026-10-07.md)。
- 当前候选 Windows workflow 已将普通/QA workspace 改为 `--all-targets`，并分别执行 core、desktop、SQL plugin 的普通/QA `--doc`；QA plugin显式启用 `sqlite,qa-load-observer`。这保留非文档目标和所有文档示例，隔离应用 build-script 的 CRT native 搜索路径。macOS 上插件独立普通/QA doctest各1条通过，实际rustdoc命令不含应用out路径；**b6已验证修正后的Windows链接成功；安装连接配置失败仍待路径修复后新CI**。见 [doctest隔离证据](evidence/windows-doctest-isolation-2026-10-07.md)。
- 当前运行时已完成两项真实失败回归与修复：旧checkpoint只有计划、但durable ledger已推进时必须进入恢复，`started/unknown` 缺原身份停在 `needs_user`，`applied`直接复用；账本读取抛错时固定停止，不能把异常当成“没有记录”继续批准或执行。两个新增Node进程/SQLite案例通过真实副作用后SIGKILL、旧形状checkpoint及连接局部读取错误验证不重放、副作用指纹与完整账本行不变。最终本机 **102文件/998条、窄5文件/78条、合成配置/脱敏3文件/55条及typecheck全部通过、零跳过**（2026-10-07 09:41:52 CST开始，全量70.09秒，2 workers）。固定计数、红绿日志及受控故障范围见 [本地恢复分析](evidence/durable-ledger-recovery-local-2026-10-07.md) 与 [固定JSON](evidence/durable-ledger-recovery-local-2026-10-07.json)。这些是合成Provider及当前代码的本地证明，未进入e7 CI；真实双Provider故障矩阵和旧native writer→新reader仍未验证。
- 包含两项恢复修复的最终macOS `26.7.1/x64`、QA `0.1.0` binary `45c7986bd8ab5b201ebcdd4cfa049822dccaa723be0649293f8d5f9277aa5fce`（12,213,256 bytes），构建UTC 01:49:08.723–01:53:00.097、原生UTC 01:53:14.205–01:56:16.445均通过。冻结harness在真实Tauri/WebView/MCP执行三个既有故障恢复场景：活跃租约阻止重放，过期 `not_applied` 再批准后仅一次move，`applied`复用且恢复tool_result为0，`unknown`暂停且不重建；全部自有进程/profile清理。清单列出的322项构建输入、binary、harness和helper原生前后SHA一致，Root另以Python独立核对。见 [新包原生分析](evidence/macos-ledger-safe-native-2026-10-07.md)、[原始JSON](evidence/macos-ledger-safe-native-2026-10-07.json)、[构建清单](evidence/macos-ledger-safe-build-manifest-2026-10-07.json)、[Root核对](evidence/macos-ledger-safe-root-verification-2026-10-07.json)。这是工作树QA功能绑定，`formalReleaseBinding=false`；该轮没有在native制造stale plan-only快照或ledger读取异常，不能将“既有恢复未回归”扩大为新故障的GUI实测。

仅包含第一项plan-only修复的旧binary `b691ca8fd9f85` 及其 [三场景原生记录](evidence/macos-plan-only-ledger-native-2026-10-07.md) 独立保留，不覆盖其来源或扩大范围。[历史来源审计](evidence/historical-checkpoint-source-audit-2026-10-07.md) 未找到独立schema6旧App，现有6→7仍是当前迁移前缀合成旧库。真实双Provider、三平台性能、Windows完整NSIS、生产旧writer升级及签名/公证缺口继续保留。

以下条目按各自提交、binary和运行时间保留历史证据；当前本机计数、历史QA恢复和CI状态以本节最新来源为准，较早通过不能覆盖新快照的失败或未执行阶段。

- 最终候选的schema兼容/迁移重试和QA typed SQL观察链已完成本机闭环：前端102文件/991条零跳过、专项83、合成脱敏55、MCP15、typecheck、普通/QA Rust desktop36/35、core各90、stdio3+2、plugin4/10及doc1通过。322输入QA构建/binary `49a080f76ce3b`，实际macOS两轮各attempt1再次验证合成6→7、八表旧字段/ledger四状态、新lease及重启SQLx metadata不变；每轮36条trace、七个native SQL阶段齐全，所有自有进程/profile清理。Root独立验证源码/构建/原报告/严格trace与阶段顺序。typed类别保持原Result，仅QA强隔离guard启用，Windows特定错误及完整NSIS生命周期须新CI验证；不扩大到历史生产迁移/恢复执行、真实Provider或正式分发。见 `docs/evidence/schema-retry-local-2026-10-07.md`、`macos-schema-upgrade-observer-native-2026-10-07.md`。
- 源码快照 `9ee88388a584ab7fbadb4049aa5e93a4950d57a1` 的 run `37550937897` 已终态 **failure**：macOS/Ubuntu success，Windows NSIS 首轮 `database_timeout`。新增有效 27 条启动 trace 观察到 `db_load_called→db_load_failed→backend_init_failed→frontend_boot_failed`，未进入 schema query；具体权限/路径/SQLx原因仍未知。完整payload与失败后卸载清理通过，重装及后续WebView未执行。CI前端实际970passed/11skipped，缺文件MCP二进制的11条不计通过；下一候选已加Rust后显式构建与专项运行，本机15条通过。Root独立核对70文件SHA/大小、run/head/三job、五份原日志JSON重提取和严格trace。见 `docs/evidence/ci-9ee-three-platform-2026-10-07.md`。
- SQL迁移重试与schema启动防护已取得实际macOS QA证据：320输入、binary `933ffb249975e`，合成当前migration前缀1–6的旧库由实际app/plugin完成6→7，第二轮同profile完整snapshot/SQLx metadata不变；八表旧字段、ledger四状态和新NULL leases保留，两轮仅各attempt1且自有进程/profile清理。修复保留失败的迁移定义并串行迁移，前端拒绝旧/未来/无效schema进入ready；此前3个unsafe-ready回归先失败，修复后9个schema用例与本地全量990通过。此构建不含后续typed SQL observer，历史发行版迁移、checkpoint hydration/恢复执行仍未证明。见 `docs/evidence/macos-schema-upgrade-native-2026-10-07.md`。下一候选增加QA typed错误类别，用新Windows实际运行定位load失败，不能把macOS结果当Windows已修复。
- 新 QA-only 启动阶段观察链已冻结：原生 builder/setup/page/state、document start、前端入口/bootstrap 及 SQL import/load/schema 用固定白名单记录；严格 64 条/32 KiB/UUID/序号/字段读取，Windows helper 在原有 4 秒/30 秒门禁后、清理前捕获，不预建 appdata、不放宽超时、不以缺失阶段猜根因。最终前端 **101 文件/981 条**、读取器/helper **67 条**、合成脱敏 **55 条**、typecheck、普通/QA Rust desktop **36/35** 与 core 各 **90** 通过；隔离 macOS QA 构建绑定 **288** 个输入与 binary `5f6cb54609207`。实际 macOS 开启/缺少诊断旗标各一次通过：两轮真实只读 schema7，开启时 29 条记录/10 个必需 marker，缺旗标 sidecar0，自有进程与 profile 完整清理。首轮因新 macOS harness 使用错误物理 DB 路径而失败，原始两样本完整保留；仅修正工具路径后限定一次重跑，未改 binary。该证据不证明 Windows 根因、AX 可交互、性能、真实 Provider 或正式发布。见 `docs/evidence/windows-startup-stage-2026-10-07.md` 及绑定的失败/成功原始报告。
- 源码快照 `3832994f35e0ca316f71c15ebee9e3922fa1e069` 的 run `37548012255` 已终态 **failure**：macOS/Ubuntu success，Windows 首轮 NSIS `database_timeout`；窗口/进程存活、DB不存在/schema探针0次，完整 payload SHA与安装/注册/失败后卸载清理通过，第二轮和 WebView/runner 未执行。Ubuntu 四场景原生 IPC记录及 dpkg QA0.1.0→0.1.1 生命周期通过，场景各 n=1/不是性能基线。25 份源产物的大小/摘要、三平台 job 与 5 份原始 JSON重提取均由 Root 独立核对。见 `docs/evidence/ci-383-three-platform-2026-10-07.md`。该快照包含模型目录显式检查修复，尚不包含上述后续启动阶段观察；新的 Windows 证据待下一快照 CI。
- 模型目录与推理检查已分开：启动（包括旧未检查缓存）、保存、刷新、测试连接只 GET；用户明确点击并看到费用说明后才 POST 检查，最多 100 模型/4 路/单次 20 秒/整批 60 秒，支持停止并保存成功、缺失、未知和未发起数量。单次期限覆盖响应头和完整正文，超时/取消/预算耗尽停止整批队列；旧 buffered 后端不声称可撤销已发送请求。配置/目录版本、GET 逆序、迟返连接提示及损坏统计均有回归。自动路由继续使用已登记模型，无需先检查；目录型号仅为手动锁定候选，目录缺失记录不排除已登记模型的自动路由。最终前端 **99 文件/932 条**、定向 **5 文件/52 条**、配置脱敏 **3 文件/55 条**通过，typecheck 与 macOS QA build 通过。见 `docs/evidence/model-discovery-explicit-checks-2026-10-07.md` 与固定 JSON。
- 新 macOS QA `0.1.0/x64` binary `a47f7f0499b0b` 于 07:31:59–07:32:10 CST 首次通过原生模型检查 **5 阶段/12 断言/15 AX 操作**：新 HOME 的 8 模型非空目录、刷新/连接测试及同 profile 重启没有隐式推理；明确检查 8 次成功并持久化；第二批收到 headers 与部分 JSON 后实际点击停止，4 路真实 socket 在应用活着、任何清理前关闭，1101 ms 内没有替补请求，UI/SQLite 保留 unknown4/notProbed4/cancelled。286 个构建输入、binary、manifest、harness 及 helper 起止摘要一致，Root 独立复核，全部自有进程/连接/profile 清理。该轮是合成 HTTP 连接检查，不证明真实模型质量、远端计算停止或退费，也不复用旧包的启动性能证明。见 `docs/evidence/macos-model-discovery-native-2026-10-07.md`、原始 JSON 及完整构建清单。
- 源码快照 `30d30c5f7488a5b8ebd1f511a879215eaa8f6945` 的 run `37544262739` 已终态 **failure**：macOS/Ubuntu success，Windows 首轮 NSIS `database_timeout`。新的失败快照确认窗口/进程仍在、预期 DB 不存在，schema probe 因此未启动（0 次），不能继续归因于 schema 查询或应用退出。安装、注册、完整预期 payload SHA 与失败后卸载清理均通过；第二轮与 WebView/runner 未执行。Ubuntu 四个场景的真实 IPC 到达记录已验证，但各 n=1，不是性能基线。见 `docs/evidence/ci-30d-three-platform-2026-10-07.md` 与来源绑定。下一步为保持现有期限的 QA-only 启动阶段诊断，观察 native setup/page、前端入口/bootstrap、SQL import/load；不能以窗口存在推断这些阶段完成。这份 CI 不覆盖上述后续模型目录修复。
- 本批测量/Windows 诊断工具冻结后，全量前端 96 文件/900 条通过（06:59:27 CST 开始，66.25s，2 workers），最终 typecheck 与 QA 前端 build 通过；合成配置/脱敏 54 条、测量工具窄 44 条与 Windows helper 窄 24 条通过。Windows Python 探针从真实 PS here-string 提取后执行，schema 成功及缺表的固定 `schema_query`/exit1/空 stdout-stderr 均验证；本机未执行 PowerShell/NSIS。新诊断在 cleanup 前区分 DB存在、探针结果、root/窗口及 job计数，新的成功报告须有匹配两次 launch 的两轮诊断，未知值保留 null；不改生产启动、不延长超时。QA IPC observer 只记 callback 到达时刻和匿名序号，保留原 Channel 派发，失去 hook ownership/同毫秒倒序均拒绝测量，缺失数据不估算；真实 Linux/Windows native timing 尚待下一快照 CI，不能用 JS 契约冒充原生首 token。固定日志/源码摘要见 `docs/evidence/desktop-readiness-diagnostics-local-2026-10-07.json`。生产 Rust 源码未变化，普通/QA workspace 的平台证据继续按下述快照 537 单独绑定。
- 新的显式自有 PID 资源 sampler 已在冻结源码上做本机 Darwin 原生校准（06:53:56–06:53:57 CST）：12 点/1123.710ms，模块 CPU 增量 800.521ms 落在目标自身 `process.cpuUsage()` 的 800.075–800.854ms bracket 内；退出后的连续两次采样均 `pid_exited/unverified`、CPU/RSS 为 null，目标/helper 实际退出，4 份工具/类型/测试/校准脚本起止 SHA 一致。它验证采样计数，不是 EastGenesis 的资源基线；仅一个自有 Node PID，未登记后代和 WK XPC 排除，Linux/Windows native 仍 `not_run`。原缺运行时源码绑定的实测摘录独立保留，不冒充冻结校准。见 `docs/evidence/macos-process-sampler-frozen-validation-2026-10-07.json` 与说明。
- 快照 `537e93c362ab74ffd3b54dea78301755b42fb957` 的 run `37539711370` 已终态 failure：macOS/Ubuntu success，Windows 在 NSIS 安装后的 `database_timeout` 失败。macOS 普通/QA desktop 31/30、core 各 90，慢流夹具两种 feature 均通过，package/runner 24/24；Ubuntu 四个 WebView 场景、解包 6/6、dpkg 10/10、runner 33/33 通过。Windows 的实际 isolation probe、安装、注册和完整预期 payload SHA 均已通过，失败后 exe/注册项清理通过；尚未执行重装与第二轮启动，不能将 10 个已完成 true 检查写成整个生命周期通过。`launches=[]` 是完成周期为空，不证明没有启动调度。固定 JSON/源日志摘要及每份原始 JSON 的 hash 绑定见 `docs/evidence/ci-537-three-platform-2026-10-07.json` 与说明；根因需新的数据库/进程诊断，不放宽等待期限或安装门禁。
- 最新 macOS `26.7.1/x64`、QA `0.1.0` 包 `76af4ff199126` 于 06:44:14–06:45:19 CST 完成 20 对正式启动观察，40/40 通过：新 profile 基本可交互 median/p95 1245.477/1336.772ms，同 profile 受控退出后重启 1266.485/1368.403ms；输入写入/读回并实际启用提交、QA Provider/模型菜单可用分别另记。目标 50ms AX 轮询的实际最大间隔为 269.801ms，因此只报告包含探针开销的可交互观察上界，不宣称首帧或严格 100ms 分辨率。25 份生产源码、binary、manifest、harness、Swift observer/helper 的起止摘要一致，Root 独立复核；40 组 app 和 observer 均清理、40 次 models/0 inference/0 submit。空模型目录和单个预设 QA 模型是显式测量条件，不证明真实多模型目录启动；OS 缓存和背景负载未控制，不称冷暖启动。7 轮 n1 pilot 共 14 样本（含 6 失败）完整保留，n1 不报 p95。见 `docs/evidence/macos-startup-performance-2026-10-07.json` 与说明；三平台性能及真实 Provider 首 token/资源基线仍未完成。
- 本批最终冻结后全量前端 93 文件/874 条通过（06:15:05–06:16:09 CST，2 workers），typecheck 与 QA 构建通过；合成配置/脱敏 54 条与 Windows helper 19/runner 13 的独立 86 条 smoke 全通过。Rust 普通/QA workspace 的完整结果与当前 net 摘要仍匹配，新 macOS cancel 包及源码绑定经 Root 独立复核。Windows payload 比较按已钉定 CLI 的原位打包类型 patch 派生完整预期 SHA，保留原始 source probe 与实装/修复双摘要门禁；任意其他字节改变仍拒绝。具体 fixed evidence 见 `native-response-integrity-local-2026-10-07.json`、`windows-nsis-payload-c70-analysis-2026-10-07.json`。本地通过不等于新的三平台 CI 或 Windows NSIS 生命周期通过，真实双 Provider、生产迁移、性能基线和签名/公证缺口继续保留。
- 最新 macOS QA `0.1.0/x64` 包 `76af4ff199126`（12,184,520 字节）于 06:08:33–06:12:31 CST 成功构建，包含下述响应完整性与超限 stop 策略；25 个列出源码在构建前后保持同一摘要。原冻结取消 harness `0621aa3a76b6` 于 06:13:06–06:13:39 CST 在该包再次通过 13/13：实际 AX 点击至 response/peer EOF/socket close 约 18.958ms，SQLite aborted 约 148.958ms，完整 1500ms 观察内应用持续存活、部分输出稳定。AX 操作含按钮查找的 2162ms 独立记录，不能混入点击后的取消延迟。外部另核对 GUI 起止全部 25 源码匹配编译清单；原脚本自己的运行时快照仍只有 10 文件，不补写脚本未执行的断言。见 `macos-integrity-build-manifest-2026-10-07.json` 与 `macos-native-cancel-integrity-2026-10-07.json`。该轮只证明 native cancel 未回归，没有执行新 UTF-8/超限 GUI 验收，也不重用旧包的 picker/目标恢复证据宣称该新包全面通过；它仍是工作树 QA 构建、`formalReleaseBinding=false`。
- 后续候选已修复此前登记的读取完整性缺口：JSON 用 MAX+1 探测并严格 UTF-8 解码；流式保留最多 3 字节未完成字符，跨独立 TCP frame 的中文/emoji 不再 lossy 解码，非法/残缺 UTF-8 明确 `invalid_response`。达到 16 MiB 后仍等待真实 EOF，超出的原始字节明确 `response_too_large`，不解码或发到 IPC；这不是网络接收字节的硬上限。原生产 read 60 秒/total 180 秒、取消、脱敏与禁止重定向保持。普通/QA net 各 22 条、慢流独立重复 5 次通过；完整 Rust workspace 桌面 lib 31/30、core 90、真实 stdio 3+2 通过。前端通过真实 adapter+合成 IPC 的 11 条回归保留结构化错误/部分输出，并在 OpenAI DONE 与 Anthropic message_stop 时取消未读 HTTP body，不等待连接自然 EOF。路由执行器 35 条通过：超限即 stop、不调第二模型、不记健康失败；格式错误尚无正文可记录 attempts 后降级，已有正文后一律 stop。见 `docs/evidence/native-response-integrity-local-2026-10-07.json`；TCP、IPC、路由及 native GUI 的证明范围分开记录。
- 性能证据改为按四个 fixture 场景单独记录点击命令前到 task store 首段正文、终态文本观测的描述样本；缺失/非法时间戳不再用轮询时刻补出“首段”。旧数值没有来源标记时记 `legacy_unverified`，单样本 p50/p95 为 null，不再混算不同场景的分布。纯测量、汇总及 runner 的 23 条回归通过。此改动纠正记录语义，没有补齐冷暖启动、首帧、真实模型首 token、CPU/RSS 或三平台性能基线。
- 源码快照 `c70ea1d67979f09c05227b5c078890dd8112d232` 的 run `37535219828` 已终态 failure。Ubuntu job `112514305624` success：四个 WebView 场景、真实 dpkg 安装/同源码 QA 版本升级/purge 10 项和 runner 33 项再次通过；两版 deb 为 6,675,670 / 6,675,662 字节。Windows job `112514305525` 已通过实际编译配置 isolation probe，并执行一次 NSIS 安装；安装后 exe 与构建 source 摘要不一致，`payload_mismatch` 在应用启动/重装前阻断，失败后卸载与 exe/注册项清理均通过。八个已完成检查为 true 不代表整个生命周期通过。macOS job `112514305264` 普通 Rust 的慢流夹具先发生 server write BrokenPipe/join panic，随后 11 条因测试锁 poison 失败；原客户端错误没有被保留，不能断言精确调度原因。QA/打包阶段 skipped。固定源 JSON/hash/job 绑定见 `docs/evidence/ci-c70-three-platform-2026-10-07.json` 及其两份平台报告；旧成功 run 不替代这一快照的失败结果。
- 新取消实现已构建 macOS QA `0.1.0/x64` binary `56405de93a809`（12,184,520 字节），21 个列出源码在构建前后保持同一摘要，见 `docs/evidence/macos-async-cancel-build-manifest-2026-10-07.json`；这是工作树 QA 功能绑定，不是正式签名/发布绑定。Node CLI 预算取消与 Rust 产品取消分别验收。
- 修正 AX 搜索计时后，同一冻结 native cancel harness `0621aa3a76b6` 在旧 `b7ce68` 包的实际点击后完整 1501ms 窗口看到 UI/SQLite aborted/部分输出稳定但 response/socket 不关闭；清理应用才关闭。新 `56405de` 包在真实 AX 点击后约 21.69ms 关闭 response/socket，应用仍存活，SQLite aborted 约 145.69ms，13 项断言全通过，close phase=live_app_observation。见 `docs/evidence/macos-native-cancel-before-fix-2026-10-07.json` 与 `macos-native-cancel-after-fix-2026-10-07.json`。旧初版把 AX 查找计入窗口，已由这份校准后的报告替代；不能使用旧计时支持完整 1.5 秒点击后结论。同一新 binary 再次通过原冻结 picker 的 13/13 与目标崩溃恢复的 3/3（05:26:26–05:33:41 CST），见 `macos-native-picker-async-cancel-2026-10-07.json` 与 `macos-goal-fault-recovery-async-cancel-2026-10-07.json`。两组 binary/harness/manifest/21 个源码起止摘要完全一致并匹配构建 manifest，Root 独立核对当前文件；各自隔离 profile、应用和夹具均受控清理。目标 harness 本身未执行 expected-SHA 参数检查，因此该轮由外部冻结检查严格比较开始/结束期望 binary 与源码，再附报告绑定；不据此修改原 harness 或补写其原本没有的断言。
- Rust 流改为异步 reqwest，取消、绝对总期限、网络结果依次竞争；取消释放响应，发事件前重新检查状态。保留生产 read 60 秒/total 180 秒、16 MiB 原始读取上限、增量脱敏与禁止重定向。256 条有界登记、180 秒提前取消/最近完成记录和 Arc 身份清理覆盖早取消、重复 ID、旧结束与容量失败。普通/QA `net::tests` 各 13 条及 core Provider 12 条通过，真实 TCP 三类取消在独立 800ms/1s 实验预算下及时 EOF/reset；见 `docs/evidence/native-stream-rust-checks-2026-10-07.json`。用户正常 UUID 调用避免 ID 复用歧义；若强制过 TTL 复用同 ID，极晚旧取消仍不能由原接口识别代次。
- Windows 安装前校验改为专用 CLI probe，与应用共用唯一 embedded Context 工厂；支持 marker 只允许探测调用，必须由真实编译配置、QA feature、固定 JSON、退出码与 binary SHA 证明隔离。安装后启动继续要求该配置。helper 记录 install/reinstall/uninstall 实际 dispatch；无安装为 false，有 dispatch 但缺可靠报告/注册状态为 null，输出写失败保留已观察操作。14 条 helper + 13 条 runner consumer、两种 feature 的 probe 各 4 条通过。新 macOS native probe 实际拒绝缺 isolation 的 QA 包，临时 HOME 无文件创建（见 `macos-qa-config-probe-negative-2026-10-07.json`）；Windows PE/PS/stdout/NSIS 新代码仍待 runner，未找到旧 UTF8 扫描失败根因的可靠证明。
- 本批冻结后全量前端 91 文件/846 条通过（05:17:28–05:18:31 CST），typecheck/build 通过；两套完整 Rust workspace 均通过：普通 lib 22、QA lib 21，core 90，真实 stdio 3+2；配置脱敏 54 与 Windows/runner 27 的定向 81 条再次通过。独立只读审查未发现提交阻塞项。已有两项读取限制登记到后续：达到 16 MiB 只结束读取，尚无显式超限错误；每块 lossy UTF8 解码可能损坏跨块字符。此次取消修复保留这两个旧语义，不据此宣称任意大响应或任意 Unicode 分块完整交付。
- 新 macOS `26.7.1/x64`、QA `0.1.0`（binary `b7ce68b84a935`）在同一进程通过原生目录/权限完整 13 场景（04:33:52–04:37:38 CST）：工作目录与项目 native picker/取消/UI/SQLite 不自动授权；未授权、外部目录、符号链接读写和撤销后写入均由 Rust 拒绝且自有文件指纹不变；显式授权后真实 write/read 完成，撤销后默认 Downloads 仍真实 write/read 完成。见 `docs/evidence/macos-picker-sandbox-2026-10-07.json` 与说明。报告核对 binary/harness 及列出的 7 源码起止摘要，Root 独立核对其与本地 `aebe9c8a` 一致；`mcp-transport.ts` 未在该轮起止清单内，仅作事后提交核对，不补写不存在的起始证据。
- 同一新 binary 再次通过冻结故障 harness 的三场景（04:39:55–04:43:00 CST），验证新的 MCP 事件/命令身份桥接没有破坏同任务恢复：活跃租约阻止重放；到期后的 `not_applied` 只执行一次 move，`applied` 保持产物并产生零个恢复工具结果，`unknown` 保持账本 unknown/goal paused 且不重建。三个临时 profile 均受控清理。见 `docs/evidence/macos-goal-fault-recovery-connection-2026-10-07.json`；普通租约仍 10 分钟，QA 用 30 秒；它仍是合成 Provider 下的 native 功能证据。
- run `37527468910`（快照 `e2605442`）三平台 frontend 门禁通过；Ubuntu job `112488011840` 已终态 success，含四个真实 WebView 场景、dpkg 安装/QA 版本升级/purge 的 10 项检查和 runner evidence 33 项。新两版 deb 均为 6,707,734 字节，见 `docs/evidence/linux-dpkg-lifecycle-connection-2026-10-07.json` 与 `linux-runner-connection-2026-10-07.json`；Windows job `112488011551` 已终态 failure：隔离 QA NSIS 构建成功，但安装前 PE 字符串启发式校验报 `qa_isolation_missing`，installer 尚未调度，launches 为空；见 `docs/evidence/windows-nsis-before-isolation-fix-2026-10-07.json`。正在改为可靠的实际 embedded config 证明，不删除隔离门禁。macOS 普通 Rust 含新的 3 条文件工具 stdio 回归通过，但 QA 的 idle-read 测试返回 Ok，导致测试锁 poison 连带另两例失败。原 100ms sleep 可在客户端调度停顿时把 body 提前缓冲；Root 用 150ms headers callback 延迟确定性复现旧 fixture 返回 Ok。测试改为结果前保持 body 不可用、结束总是释放并 join，原 20ms/200ms 期限不变；真实 stdio 测试自有目录加原子序号，避免平行线程时间戳重合。两项只改变测试夹具，普通与 QA workspace 本地均通过，待下一快照 CI 验证。
- 对预算用例的本机有界诊断已复现实际取消缺口：响应头已收到后，源 AbortSignal 约 440ms 触发，受控恢复仍未返回，服务器响应体直到约 7492ms 的父进程终止才关闭；诊断开/关都能出现。Node 22.23.1 的强制 GC 有界实验显示 source signal 已 aborted 时 fetch 内部弱引用取消控制器可能已消失；这是 Node CLI/harness 路径证据，不能外推至 WebView 或 Rust。预算 harness 的 body reader 已直接绑定源取消；默认无诊断、开启诊断和强制 GC 的三组 fresh fixture 全部通过，每组保留 250ms 请求期限、三次预算和 8 秒父进程上限，且 body 实际关闭耗时必须为数值、小于 4 秒。整个预算文件 14 条通过，旧 forced-GC 实现稳定触发 8 秒终止/7491ms 才关闭，新实现三组约 793–948ms 完成。此修复范围为 Node CLI 工具，仍待 Windows 新快照 CI，不替代 Rust 产品层传输取消。
- 源传输取消的独立审查发现产品 P0：前端立即停止并丢弃迟到 Channel 事件，Rust AtomicBool 却不能唤醒正在阻塞的 read。生产函数的独立有界副本使用 read 400ms/total 800ms，headers 4ms、取消 25ms、函数返回 414ms、peer close 415ms、结果 timeout；参数经过实验缩短，生产 60 秒读等待只作源码推导。此前 WebDriver idle-cancel 没有 server close/worker 退出断言，不能证明连接及时关闭。报告 `docs/evidence/native-cancel-before-fix-2026-10-07.json` 保留该未通过边界；该旧版失败边界保留；新实现和新包取消证据分别在本页最新条目验收，不将工具 wrapper 修复冒充产品修复。
- 较早终态 run `37522917333`（快照 `ccbb5b5d`，2026-10-07 04:17 CST）macOS 与 Ubuntu 成功，Windows 在单一预算用例失败。Windows CRLF 导入问题在真实 runner 已消失；失败用例耗时 8023ms，空 stdout 与 8000ms 子进程上限一致，旧日志不足以区分 HTTP body、受控恢复、fixture 退出或 launcher 阶段。新增仅固定枚举/计数/毫秒的显式诊断，仍保留 250ms 请求期限、三次共享预算和响应体关闭断言；修复与 Windows NSIS 链均尚未证明。
- 此快照的 Ubuntu job `112472602358` 已通过真实 `dpkg-system` 安装 `0.1.0` → 同源码 QA `0.1.1` 升级 → purge：10 项检查全通过，两版已安装进程身份、4 秒存活、schema 7、session 保留、卸载登记/payload 消失与清理确认均成立，上传前 runner evidence 33 项通过。原始 JSON 从已完成 job log 精确提取并绑定 run/head，见 `docs/evidence/linux-dpkg-lifecycle-2026-10-07.json`；它仍不证明跨 schema 迁移、自动更新/回滚或其他 Linux 分发。
- 此快照的 macOS job `112472601952` 通过 bundle、隔离 package 双轮与 runner evidence（24 项检查）；该 runner 的 tauri-driver 明确不支持 macOS，不替代本机 Accessibility/WebView 黄金路径，也不证明签名、公证或生产安装升级。
- 目录白名单新增同进程同步修复：保存失败不发布新的内存权限；保存成功停止旧内置文件进程并更新登记启动参数，启动/发送/停止/目录变更串行化。三个真实 `eg-mcp-files` stdio 集成回归通过，覆盖授权前拒绝、授权后读写、撤销后拒绝、默认 Downloads、越界/Unix 符号链接、添加/撤销保存失败保持旧服务，以及旧连接不能写入/停止新进程。每次连接的独立身份也进入真实 Tauri event 映射，6 条回归拒收旧消息/退出并透传同身份命令。旧 `552c8e861684` 桌面包的真实原生 picker 复现授权后仍 `path_not_allowed`（6 项通过、1 项失败、5 项未执行），见 `docs/evidence/macos-picker-before-fix-2026-10-07.json`；新 binary 的上述 13 项 native 路径独立通过，stdio/UI/事件映射的验证范围分别保留。
- run `37521359524`（快照 `070884fc`）三个平台在前端回归失败，安装/升级/卸载步骤均未执行：Linux/macOS 的预算用例超过测试期限，Windows 的两个导入 suite 遇到 CRLF shebang 经 Vite SSR 转换后的语法错误。Windows 问题已用实际 Vite 转换与 Node 解析复现并移除无必要的 shebang；预算用例改为先停止监听再清理全部自有连接，新增响应体关闭观察并缩短子进程诊断上限。不能把该失败 run 的少量 JSON artifact 当成安装包或原生生命周期证据。
- 较早 run `37513231951`（快照 `b61b1086`）Windows/Ubuntu 成功，macOS 在真实子进程回归失败：Darwin 的全 zombie 进程组可对 kill(0) 返回 EPERM。已用独立监督进程真实复现并修复，本机 7 条进程回归通过；最新 ccbb macOS runner 也通过该回归与完整 job。
- 新增 Linux 真实 dpkg 安装/QA 递增版本升级/卸载，以及 Windows 真实 NSIS 安装/同包修复/卸载执行链，并接入 workflow 和上传前证据校验；Linux 已取得上述 ccbb runner 证据，Windows e260 在安装前 isolation gate 停止，安装尚未执行。同源码的 QA 版本差异不能冒充跨 schema 迁移或产品发版，Windows 同包修复不能冒充跨版本升级。边界见 `docs/M23_INSTALL_LIFECYCLE.md`。
- 真实 Provider harness 新增实际 HTTP 调度计数（包括路由重试）、禁止重定向、请求与响应体总超时和输出 token 参数。默认最多 3 次实际请求、每次 10 秒、请求参数 128 输出 token；参数上限分别为 8 次、30 秒和 1024 token。12 条新增合成回归加既有受控恢复回归通过；这只证明 harness 有界，不证明供应商遵守 token 参数、实际费用上限或任何真实 Provider 请求。当前没有本轮双 Provider 实测证据，仍需显式授权及临时本机配置。
- Linux/Windows 已取得真实 Tauri WebView 四场景 runner 证据（成功 run `37498160394`）。套件名 `truncated` 当前使用显式 SSE 错误的 `partial-output` 夹具，不能据此声称传输层 Content-Length 截断已在这两个平台验收。
- macOS `x86_64`、QA `0.1.0` 包通过真实 Accessibility 会话杀进程/重启：SQLite 的 running checkpoint 含部分输出，重启读回同一任务、恢复部分输出、显示 aborted 和继续入口，并实际点击继续后停止。见 `docs/evidence/macos-p0-recovery-2026-10-07.json`。
- macOS 真实 Content-Length 截断在修复异步 Channel terminal 后通过：界面收到失败终态，SQLite 保留部分输出和失败状态，继续入口可见。见 `docs/evidence/macos-p0-truncated-2026-10-07.json`。修复前 running 约 67 秒的结果只属于旧构建。
- macOS `26.7.1/25G241`、`x86_64`、QA `0.1.0`（binary SHA-256 前缀 `552c8e861684`）在同一正式轮次通过三场景（2026-10-07 03:49–03:52 CST）：`after_ledger_started` → 有效租约阻止重放 → 过期探测未执行 → 再次批准且仅一次移动；`after_tool_before_ledger_commit` → 有效租约阻止重放 → 过期探测 applied → 零个恢复工具结果且产物 inode/mtime/digest 不变；仅由 harness 删除临时输出的未知场景 → 真实 probe unknown、SQLite unknown、needs_user/paused、无批准与文件重建。见 `docs/evidence/macos-goal-fault-recovery-2026-10-07.json`。报告绑定当时的恢复源码摘要、harness 摘要与实际二进制摘要；这是 QA 候选的功能证明，不能冒充正式发布绑定，也不外推为任意工具或外部服务的副作用恢复。AppKit 异常退出恢复提示只在测试 PID 的窗口精确点击“不重新打开”同义按钮，旧部分报告的 AX 失败不属于生产账本断言失败。
- 恢复实现已补齐副作用前 checkpoint 持久化屏障、终态落库等待、原 gate 调用身份跨重试保留、缺身份与连续两次参数漂移的停止策略、过期旧 owner 的 unknown/conflict 接管，以及并发 terminal 重新读取和校验。新增运行时、真实 SQLite 和 UI 竞态回归通过；普通生产租约仍为 10 分钟，三场景故障验证使用仅 QA 可用的 30 秒租约。目标模式目录选择白名单完整黄金路径、真实双 Provider 故障矩阵、Windows 安装/生产迁移和签名/公证仍待验证；Linux 同源码 QA 版本的 dpkg 生命周期已取得独立证据。
- Linux `.deb` 隔离解包 smoke 已在真实 Ubuntu job `112429133656`（run `37510223615`）通过：包元数据、payload、依赖、隔离启动、SQLite schema 7 和 SIGTERM 受控退出均通过，runner evidence 也通过。见 `docs/evidence/linux-deb-extract-2026-10-07.json`；模式明确为 `deb-extract`，没有修改系统包数据库，仍不证明系统安装/升级/卸载。
- 此前预算修复后的本机全量前端回归为 91 文件 / 844 条通过（2026-10-07 05:01:52–05:02:55，2 个 worker），包括新增连接身份/旧事件回归、Windows CRLF 导入、诊断开/关和强制 GC 下的真实响应体关闭断言（见 `docs/evidence/provider-budget-body-cancellation-2026-10-07.json`）；当轮 typecheck/build 通过，普通 Rust workspace 和 `qa-faults` workspace 均通过（core 90 条与真实 stdio 3+2 条）。最新冻结后的 846 条结果见本页顶部更新。合成 Provider 配置/脱敏定向 54 条包含在该轮全量回归中，源码与相关历史的 fail-closed 凭据扫描通过。普通测试不读取真实 Provider 凭据。真实文件 MCP 的已落地恢复用例按生产逻辑补齐原身份，并验证没有工具执行结果且文件 inode/mtime 不变；旧缺身份的记录继续停止自动恢复。
- 成功 run `37510223615` 的三平台 job 全部通过（快照 `59c2c9d5`）；该基线包含异步流终态修复、macOS 两份 P0 证据及 Linux deb-extract 校验。后续生命周期 helper 与上述文档更新的 CI 必须按新快照单独确认，不能沿用该基线冒充最新提交通过。

## 1. 本阶段的判断

项目的产品方向已经冻结为一个统一任务工作台：用户提交一个目标，系统在同一条任务链里按步骤使用 Chat、Work、Codex 三种能力面。能力面不绑定模型供应商；路由需要可解释；Provider 失败要保留进度并可恢复；模型选择要由任务事实驱动。

当前工作是把统一任务链推进到真实环境并保留可复盘证据。760b 的 macOS 完整 Goal 合成 GUI 已取得同任务重启、summary-only 继续、无读写/probe 重放和明确 QA 确认后的终态证据；三个原存储 RED 故障窗口的修复通过单独本机窄测。最新已结束 e723 CI 为 Mac/Ubuntu 通过、Windows 外部 schema 探测 Win32 123 失败；新 Windows Python 选择 r2 待其自身来源的实际 CI。完整 NSIS repair/cycle2、Windows DOM 和真实两个独立 Provider 仍未完成。以下列表保留早期确定性基线和实现演进，具体计数、原生结果与仍未证明的项目以本页顶部固定来源为准：

- 本地流式夹具 7/7；
- Provider 适配器 15/15，任务级恢复 4/4；
- 主样例和 hold-out 路由硬能力门禁均通过，当前两套规则准确率为 100%；
- Vitest 84 个文件 / 757 条测试、TypeScript 类型检查和前端构建通过。
- 运行中的会话回合现在会保存脱敏 checkpoint；重启读回时未落盘终态会显示为 `aborted`，保留计划和步骤并提供“从未完成步骤继续”。这已有内存后端和 UI 重启回归，但还没有真实 Tauri 进程杀进程/重启证据。
- 目标模式的运行中轮次也会在启动读回时安全转为 `paused/interrupted`，保留中断原因；用户点击“继续”后重新进入账本探测和权限闸门。目标状态、mock/SQLite 回归已通过，但目标轮次的真实 Tauri 杀进程、任务卡事件恢复和工具副作用路径仍未在桌面包中验证。
- 目标轮次现在保存脱敏任务 checkpoint，并在 `start_round`/`resume_round` 成功落库后才启动 Agent；重启 hydration 会复用原 `task_id`，缺少 checkpoint 或任务归属不一致时 fail-closed 暂停。`needs_user` 不再自动重跑，而是暂停并把原因带回目标详情。该链已有 runner、目标 store/UI 和会话 hydration 回归，以及最新 macOS QA 包的原生双轮启动 smoke；真实 Tauri 杀进程、工具副作用 probe 和 WebView 继续按钮仍未证明。
- 独立 Node/SQLite crash worker 现已把目标 checkpoint 与生产调用账本串起来：崩溃窗口恢复后目标沿用原 `task_id`，ledger probe 认定 marker 已落地，工具实际调用次数为 0。该结果是跨进程生产逻辑证据，仍需在真实 Tauri 进程和 WebView 中复验。
- 跨进程恢复 smoke 现在在通过时生成脱敏 `goal-recovery-quality.json`，并接入三平台 CI 工作流的上传清单；文件缺失或 SQLite 场景被跳过会使该步骤失败。这样可以把“本机通过”与“runner 产物存在”分开审计，但仍不把 Node/SQLite 证据外推为 Tauri WebView 或真实 Provider 证据。
- 恢复证据在上传前还会通过 `desktop:goal-recovery:validate` 做结构和泄漏边界校验；校验器只输出状态、任务 ID、账本状态和固定边界，不回显被拒绝的敏感值。
- 本地 `desktop:gate` 也执行同一跨进程恢复和校验流程，并在总闸门 JSON 中列为必需阶段；本机通过不替代 runner，但可以防止开发分支在推送前漏掉恢复回归。
- 对未知副作用的恢复现在要求参数幂等身份可证明；如果恢复时重新生成的参数导致幂等键漂移，或工具没有探针，运行时会停在 `needs_user`，不把它当成新调用。已落地的账本 `applied` 和其他进程持有的租约分别优先走终态/竞争分支。
- 任务级路由现在有 30 条匿名黄金任务：Chat 6、Work 7、Codex 8、跨能力链 9。`golden:gate` 在不读取 Key、不调用 Provider 的条件下校验任务类型/能力面、硬能力过滤、主 Provider 可接受范围、跨 Provider 降级链、脱敏路由 trace 和恢复标注；本机 30/30 通过，并已接入 `desktop:gate` 与三平台 CI 的上传清单。
- 恢复入口现在在回答区、专家任务卡和目标详情的轮次里同时显示脱敏的失败原因；原因经过 `redact` 二次遮罩并限制为 240 字，未知副作用仍单独显示“继续前会重新确认”。目标页还明确提示顶部“继续”会先检查账本再恢复未完成步骤。这让“为什么停下”和“如何继续”在三类执行入口都可见；UI 与恢复单测已覆盖，仍不替代真实 WebView 点击验收。
- 恢复提示改动后的 macOS QA 包已经重新生成：`.app` 12.15 MiB、`.dmg` 6.90 MiB；`desktop:bundle:smoke` 和隔离 HOME 下的 `desktop:package:smoke` 双轮启动/受控退出、SQLite schema 7、sessions/tool_invocations/lease index 与合成 session 哨兵均通过。该包仍未签名，原生进程证据不等于 WebView hydration、真实点击或真实 Provider 证据。
- 原生 package smoke 现在额外输出两轮进程周期的脱敏统计（样本、min/max、nearest-rank p50/p95），并由 `desktop:gate` 汇总；当前样本约为 4.03–4.05 秒。该指标从 `spawn` 计时到受控退出和 SQLite 检查完成，包含固定 4 秒存活窗口，只能作为进程/重启烟测时间记录，不作为冷启动、WebView 首屏、首 token 或跨平台性能基线。
- Linux/Windows WebDriver 套件汇总现在额外输出首段和首个保留输出的脱敏 p50/p95；这些时间来自真实 Tauri WebView 与本地 QA fixture 的交互，未来 runner 可直接比较平台差异，但不代表真实 Provider 延迟，也不包含冷启动。
- 自定义 Provider 的桌面可用性现在对未知协议 fail-closed：只有声明了已实现的恢复契约才会进入自动路由；适配器构造也不再把未知协议静默当成 OpenAI 兼容。
- `provider:matrix -- --real` 现在把真实 smoke 的证据边界写入 JSON：逐 Provider 记录脱敏单次耗时；单 Provider 标记 `recoveryStatus=not_run`，双 Provider 还用本地 primary 故障和真实 fallback 验证两条受控恢复路径并标记 `partial`，明确真实连通性、受控恢复和真实上游故障矩阵不是同一项证据。
- 双 Provider 受控恢复路径已有无外网合成回归：本地 fixture 作为 primary/fallback upstream 时，实际执行 `--real` JSON，断言 fallback 接手、部分输出停止、证据脱敏和 `recoveryStatus=partial`；该测试只验证 harness 与生产路由组合，不替代真实供应商账号。
- `provider:controlled-recovery` 已接入本地 `desktop:gate` 与三平台 workflow，并上传 `provider-controlled-recovery.json`；它使用合成 Key 和 loopback fixture，不访问外网，把受控恢复组合从单测提升为每个平台可下载的脱敏产物。
- Linux/Windows WebDriver 套件汇总器在输入异常时只使用固定序号，不回显本地文件名；四场景正向聚合、缺失/重复/非法输入仍 fail-closed，避免 CI 诊断产物把临时路径或 Provider 标识带入上传证据。
- 此前本机源码总闸门已复验：fixture 7/7、Provider 15/15、受控恢复 2/2、跨进程目标恢复、routing/golden、Vitest 84/757、typecheck/build 全部通过；随后用同一提交重新生成 QA 包，bundle smoke 和 macOS package 双轮重启也通过。该轮 package 周期样本为 4061–4071 ms；该指标仍不等于冷启动或 WebView 首屏。最新前端/原生回归以本页顶部时间和源码快照为准。
- 三平台 workflow 新增 `desktop:runner:evidence`，在上传前检查 Provider、受控恢复、路由、黄金任务、跨进程恢复和平台专属 WebDriver/package 产物；它还会拒绝 `packageBinary`、URL、Key 和本机路径，输出 `runner-evidence.json`。缺少或失败的产物会阻断对应 runner。
- Linux WebDriver smoke 现在在真实 Tauri session 外包一层 `xvfb-run`，并固定虚拟屏幕尺寸；Ubuntu runner 不再因为缺少 GTK/WebKit 显示环境而在 session 建立前失败。该修复只改善 runner 启动条件，仍需 workflow 实际执行才能证明 Linux WebView 路径。
- 目标暂停/放弃/删除现在按“先停止执行、再落盘任务 checkpoint”的顺序处理；用户紧接着点击“继续”时，目标 store 会等待这份 checkpoint 可见后再恢复，超时则继续 fail-closed 暂停。新增真实 UI 竞态回归，验证恢复沿用同一轮和同一 `task_id`，避免把异步写回窗口误判为不可恢复。
- 当前提交的 Rust 原生层也已在本机复验：`cargo test --workspace --locked` 与 `cargo test --workspace --features qa-faults --locked` 均通过，覆盖桌面流式取消/截断、路径白名单、Provider/密钥脱敏、MCP guard、PDF 解析、SQLite migration 和 stdio 集成；这仍不替代三平台 runner、安装升级和签名证据。
- 首次三平台 runner 已取得：GitHub Actions run `37483409209`（提交 `c603e1c6`）的 Ubuntu、macOS、Windows job 全部成功。Linux/Windows 四个原生 WebView 场景、跨进程目标恢复、Provider/受控恢复、路由/golden、前端 typecheck/test/build 和平台 QA 打包均通过；macOS 通过原生 package smoke。该结果仍排除 macOS WebView 六条人工黄金路径、真实 Provider 故障矩阵、签名/notarization 和 Windows/Linux 安装升级。

当前证据覆盖本地协议/路由/恢复回归、历史 Linux/Windows 原生 WebView 场景、macOS 会话与工具副作用崩溃窗口恢复、原生目录/权限13项黄金路径、Linux同源码QA版本的系统安装/升级/卸载，以及b4真实macOS完整Goal合成场景的同任务重启与明确QA确认。b4的三个存储故障RED、新1c739 Windows外部schema/repair/cycle2/DOM失败或未完成，以及真实双Provider故障矩阵、生产跨版本/schema迁移、三平台性能和签名/notarization缺口仍保留，因此产品状态继续保持Alpha / 内部QA。较早通过只覆盖当时的来源，不能替代新快照；当前平台状态以本页顶部固定来源为准。

## 2. M23 的唯一目标

> 证明同一个跨 Chat、Work、Codex 的任务，在真实桌面外壳中能够透明选路、保留部分结果、按安全边界恢复，并在至少两个真实 Provider 之间稳定切换。

如果一项工作不能增加这条链的证据、可靠性或安全性，放入后续版本，不在 M23 插入。

## 3. 执行顺序

### P0：完成真实桌面黄金路径

在已授权的源码推送后，由 `.github/workflows/desktop.yml` 的 PR synchronize 触发新候选三平台 CI，并按实际head核对结果。历史e7 doctest、b6连接配置、567前端别名与2b509数据库cleanup失败分别保留；新1c739已跨过Windows普通/QA SQL13/19及真实短锁/持续锁回归，但NSIS首轮外部schema探测仍在process_create/Win32 123停止。下一候选须以实际输入诊断定位该受控进程失败并重新验收外部schema7、repair、两cycle/清理与WindowsDOM，不能以应用frontend_ready trace替代外部schema验收；b4三个存储RED也须独立修复和复验，正常存储的GUI PASS不覆盖故障窗口。除桌面包、路由和 WebDriver 产物外，每个平台都必须生成 `goal-recovery-quality.json`；Linux 和 Windows 必须通过四个 WebDriver 场景：`staged`、`slow-first-token`、`truncated`、`idle-cancel`。每个场景都要保留套件汇总 JSON、runner/驱动版本和失败日志；失败时保持 job 失败，不能用本地结果替代。

macOS 使用当前 `qa-faults` 包完成人工或可用的图形自动化验收：

1. 成功流的 headers、首段、后续段和终态顺序正确；
2. 首 token 延迟期间任务仍显示运行中；
3. 截断后保留部分输出，并显示可解释的失败或中断状态；
4. 用户取消后请求停止，后台没有继续消费；
5. 账本两个崩溃窗口重启后不会重复已落地副作用；
6. 工作目录和项目目录选择遵守白名单，越界路径被拒绝。

每条路径必须记录任务 ID、能力面链、Provider/模型、路由尝试、时间戳、最终状态、账本状态和脱敏日志。只有截图或“看起来能用”不算通过。

### P1：完成真实 Provider 中立性

接入并实测至少两种不同的 Provider：一个 OpenAI-compatible 云端服务，以及一个不同协议或不同供应商的服务；第三个本地或局域网 Provider 作为加分项。真实测试使用临时账号或受控代理，凭据只通过环境变量或钥匙串进入进程。

必须覆盖：401/403、404、429、5xx、网络断开、超时、用户取消和工具副作用未知。每个结果只输出协议、错误类别、尝试顺序、部分输出长度和最终状态，不写入密钥、正文、完整 URL 或本地路径。

完成标准不是“两个模型都能回答”，而是所有候选适配器都能表达以下契约：

```text
流式请求 → 标准化错误 → 取消 → 部分输出 → 重试安全性 → 用量/成本（可用时）
```

无法表达取消、部分输出或错误类别的适配器不得进入自动路由链，只能被用户手动锁定。

### P1：把路由质量从规则证据推进到任务证据

保留现有的确定性 routing gate，同时使用 `tests/fixtures/golden_tasks.json` 的 30 条匿名黄金任务，覆盖简单问答、文件研究、文档交付、代码修改和跨能力链任务。`pnpm golden:gate -- --json` 与 `pnpm desktop:gate -- --json` 都会执行这组回放；每条任务至少记录：

- 期望能力面和硬能力；
- 可接受的 Provider 范围；
- 用户能理解的选路理由；
- 主 Provider 失败后的合格接手条件；
- 是否保留部分输出和恢复入口。

先由产品和工程共同标注，再在真实 Provider 环境回放。规则准确率、模型回答质量、延迟和成本分开报告，不把规则命中率写成回答质量，也不把本地 fallback 覆盖率写成生产 SLA。当前 30/30 只是一项确定性路由基线；真实 Provider 回放、回答质量和跨步骤恢复仍是 `not_run`。

### P2：补齐 ChatGPT Desktop 基线

只有 P0 和 P1 通过后，再按用户价值补齐：对话历史与搜索、项目上下文、文件与成果导出、联网引用、全局快捷唤起、窗口恢复、语音和多模态。每一项都必须挂到同一个 Goal/Task/Step 模型上：文件是任务上下文，代码仓库是步骤能力，文档和表格是结果交付物，不重新创建三个会话系统。

首批不做插件市场、复杂多 Agent 编排或更多独立模式。这些功能会扩大权限和故障面，却不能解决当前的真实桌面证据缺口。

## 4. 每周交付节奏

### 第 1 周：目标 runner 与桌面证据

- 手动触发 GitHub Actions，确认 Linux/Windows 构建、安装包和四个 WebDriver 场景的真实结果；
- 在有可访问窗口的 macOS 环境完成六条黄金路径；
- 把每个平台的 `webdriver-quality.json`、包体积和失败原因汇总到发布闸门；
- 任何平台失败都登记为阻塞项，不以另一平台通过替代。

### 第 2 周：真实 Provider 故障矩阵

- 配置两个临时 Provider 或受控故障代理；
- 运行双 Provider `desktop:gate -- --include-real` 和八类故障矩阵；
- 核对取消、部分输出、降级和副作用未知状态；
- 删除测试凭据，确认日志、SQLite、验收 JSON 和构建产物无敏感内容。

### 第 3 周：安全与性能基线

- 测试提示注入、恶意文件、符号链接、路径穿越、MCP 声明缺失和跨进程租约竞争；
- 测量冷启动、输入可用、headers、首 token、终态的 p50/p95；
- 测量空闲内存、流式峰值、取消后连接和线程残留；
- 对 macOS、Windows、Linux 分别记录，不用单一平台推断跨平台体验。

### 第 4 周：小规模内部试用

- 选择 5–10 名内部用户和 5 条真实工作流；
- 观察用户是否理解“自动路由”、是否能找到失败原因、是否能区分“继续”与“重新开始”；
- 记录手动锁定模型的触发原因，以及用户是否认为降级链透明而可控；
- 根据任务完成率、恢复成功率和解释理解率决定是否进入邀请制 Beta 评审。

## 5. 发布门槛

M23 结束时，以下条件必须有结果；未完成项明确写 `not_run` 或 `blocked`：

| 领域 | 进入邀请制 Beta 的最低条件 |
|---|---|
| 统一任务链 | 至少一条真实跨能力链任务可复盘，Chat/Work/Codex 不需要中途切模式 |
| WebView | Linux/Windows 四场景有 runner 证据；macOS 六条黄金路径有图形环境记录 |
| Provider | 至少两个真实 Provider 完成连通性和故障矩阵；没有静默换模型 |
| 恢复 | 已落地副作用不重复执行；未知副作用停在 `needs_user` |
| 路由 | 用户能说出实际 Provider/模型和主要理由；手动锁定失败时不偷偷降级 |
| 安全 | 密钥、正文、完整路径不进入日志和脱敏证据；越界文件访问被拒绝 |
| 性能 | 三平台都有启动、首 token、终态和资源基线，异常值有解释 |
| 分发 | macOS 签名/notarization，Windows/Linux 至少一个可安装包和升级烟测 |

任何一项缺失时，产品定位仍是 Alpha / 内部 QA。

## 6. 产品决策原则

1. **复制交互基线，不复制供应商锁定。** ChatGPT Desktop 的历史、项目、文件、语音和快捷唤起是体验基线；模型选择、失败处理和执行证据是 EastGenesis 的差异化。
2. **透明度是默认体验，评分是专家信息。** 默认只显示能力、Provider/模型、原因和失败后的下一步；成本、延迟和权重放进展开面板。
3. **恢复优先于重试按钮。** 能安全继续就从 checkpoint 继续；副作用不明就停下询问；不能把两个模型的部分正文静默拼接。
4. **真实证据优先于功能数量。** 每加入一个桌面能力，都必须补对应的测试、脱敏记录和平台边界。
5. **手动控制必须是诚实的。** 用户锁定模型后，能力不匹配和不可用要直接报出；自动路由只能在用户选择“自动”时介入。
