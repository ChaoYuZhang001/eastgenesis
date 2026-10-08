# Windows 安装验收：受控进程首失败诊断

日期：2026-10-07。阶段：Alpha / 内部 QA；Windows 原生结果待下一源码快照 CI。

## 问题与实际边界

公开源码 `cf8f54a6658417a39824effe21460b3f9893beca` 的 [run 37568809472](https://github.com/ChaoYuZhang001/eastgenesis/actions/runs/37568809472) 中，NSIS 已安装完整 payload，应用具有稳定窗口，typed SQL trace 已到连接、迁移、加载和 `frontend_ready`。外部 Python schema 探针的 131 次启动全部失败于 `process_job`，随后被报告为 `database_timeout`。因此不能从此报告确认 schema 7，也不能将错误具体归因于 Assign Job、Python、数据库或应用退出。

本片只增加严格、脱敏的受控进程诊断，并在启动基础设施首失败时停止数据库轮询。它没有修复或确认实际 Windows 根因，也没有降低安装验收门槛。

## 候选实现

基线是本机不可变提交 `31dcc35279f0e0e06d843d3d04a172bf987708b8`。四文件补丁 SHA-256 为 `6b8b0066c4dac87f7ab846acfa52485d948c5fc573a81b1f36eba4c1c9993f46`，25,510 bytes；Root 已在 Desktop Git 根目录使用 `--directory=EastGenesis` 实际应用并逐项核对候选哈希。

- `startupDiagnostics[].processJobFailure` 只接受 `stage / win32Error / hresult / suspendCount` 四字段。旧报告允许省略该字段；新报告的 `process_job` 失败必须携带有效详情。
- 阶段覆盖 Job 创建及限制、标准输入输出句柄、环境块、进程创建、Job 分配、托管进程查询与句柄、线程恢复，以及固定 `unknown`。异常文本、路径和堆栈不进入新字段。
- 失败的 Win32 API 后立即取得错误码，再清理资源；托管异常只保存整数 HResult。`ResumeThread == UINT_MAX` 保存 Win32 错误与该计数，成功但异常的 0 或大于 1 只保存计数，不读取陈旧错误码。仅返回 1 才接受正常恢复。
- SQLite probe 的 `process_job` 首失败立即终止原轮询，诊断在启动 trace reader 前固定，避免后续读取进程覆盖它。
- MJS 投影拒绝未知字段/阶段、越界及非整数数字、互相矛盾的 Win32/HResult/count 组合，并重新生成四字段对象。

`CREATE_SUSPENDED → AssignProcessToJobObject → 保留托管进程句柄 → ResumeThread` 与 `KILL_ON_JOB_CLOSE` 保持不变。没有增加 breakaway，也没有增加 4 秒稳定窗口和 30 秒数据库等待。外部 Python 对 schema 7、表和 lease index 的校验仍是必需条件；前端 trace 不替代它。

## 本机验证

| 检查 | 结果 | 证据边界 |
|---|---|---|
| 同一最终专项测试对旧实现运行 | 30 项：26 passed、4 expected failed | 在独立临时夹具中验证新契约确实检测旧实现缺口 |
| 候选专项 | 30 passed | MJS 实际投影、负例、嵌入 Python 与 PS/C# 源码结构 |
| 候选声明与正负类型 consumer | no-emit 检查 exit 0 | 不等于 C# 或 PowerShell 编译 |
| Root 正常仓库检查 | 4 文件 85 passed，typecheck exit 0 | 专项 30 + 合成配置/脱敏 55；558 个列举输入起止相同 |
| 独立只读审阅 | 无源码阻断 | 核对固定补丁、四基线/候选 SHA、红绿日志和严格资源边界 |

此前 `31dcc` 的生产 UI/运行时已通过 108 文件 1068 条全量本机测试。本片变更四个工具/测试文件，Root 已逐项确认与此前 558 个输入之间仅这四项不同；本片 85 项专项结果不能写成修改后的全量通过。新全量由下一 CI 执行。

闸门 JSON 的 `localParentRevision` 继承此前全量 manifest 的来源字段，不代表本片已提交版本。本片检查时 HEAD 是 `31dcc`，四文件为工作树候选；实际 558 个输入的起止 SHA 与 Root 重算才是本次专项的来源依据。发布绑定以之后生成的源码快照记录和 CI head 为准。

当前主机没有 `pwsh / dotnet / csc / mcs`，所以 PowerShell、Add-Type、WinAPI、NSIS 未在本机执行。新增的首失败退出和 C# 错误捕获只有源码结构证据，真实行为须由 disposable hosted Windows CI 证明。没有使用真实 Provider。安装器在 `Start-App` 之前发生 `process_job` 时仍只有旧顶层固定错误；Python PE/runtime 身份绑定也不属于本片。

下一 CI 成功仍须证明外部 schema、sentinel、repair、完整 payload、registry、两轮启动及卸载；若失败，应保留第一条具体子阶段与数字，不把诊断增加写成安装成功。

## 固定来源

- [候选/基线、红绿日志与边界清单](windows-process-job-diagnostic-local-2026-10-07.json)，SHA `325395a0f1fc70a520b9b4916d2f69b1d9f2af2d185dfbf0ab35d817426ee100`。
- [独立只读审阅](windows-process-job-diagnostic-review-2026-10-07.json)，SHA `9450ac1fd06afa6cba0123bb09f9cac6a0d848276b2b0f017f1cb7db642152f5`。
- [Root 正常仓库闸门](windows-process-job-diagnostic-gates-2026-10-07.json)，SHA `e273c28f8797491ca8f83d5284d0dc666599dc8a51fb25c908514b4cf0182735`。
- [Root 独立核对](windows-job-native-v6-root-2026-10-07.json)。
