# cf8 三平台 CI 终态证据

2026-10-07。[run37568809472](https://github.com/ChaoYuZhang001/eastgenesis/actions/runs/37568809472)终态failure：macOS/Ubuntu success，Windows failure。公开源码 `cf8f54a6658417a39824effe21460b3f9893beca` 与本机不可变 `662a70e092979f585ab793c9e78269d31ce4a9a4:EastGenesis` 同树 `ec0a10c4c753430bf634235b6aa2175250ae1959`，唯一parent为main `e8b5d61f107fba9a580a7a856613b6280b89c0ec`。后来Goal正文UI修改不在此run。

## 平台结果

Mac/Ubuntu cold前端1050passed+11skip（1061population），native MCP15补11/重复4，最终唯一1061passed、0剩余skip；Windows cold1044passed+17skip，MCP同样补11/重复4，唯一1055passed、6平台限定skip。独立crash step3条为重复，不另加覆盖；见[覆盖审计](ci-cf8-frontend-coverage-2026-10-07.json)。目录别名输入file19passed，Windows已跨过567短路径测试失败。

SQL plugin Mac/Ubuntu baseline10+doc1、QA16+doc1，6个路径用例两feature均通过。Windowsbaseline9+doc1、QA15+doc1，5个路径用例通过；第6个非UTF8为cfg(unix)，不编译进Windows。三平台前端typecheck/build、Rust、MCP和QA打包实际通过。

Ubuntu四个真实WebView DOM场景通过；[真实dpkg报告](ci-cf8-linux-upgrade-2026-10-07.json)通过，同源码QA0.1.0→0.1.1、schema7、sentinel和清理通过。Mac package smoke通过；Mac CI WebDriver仍not_run，不等于新Goal原生UI通过。

## Windows 唯一失败

[实际stdout报告](ci-cf8-windows-install-2026-10-07.json)来自原日志3287–3633行，已与回显workflow命令区分。NSIS安装、payload SHA、注册表通过；cycle1稳定窗口通过，数据库、根进程、窗口存在，job内8个进程。34626ms后database_timeout：131次schema probe全失败，lastProbeFailureStage=process_job。

36条typed启动记录已到sql_connect_resolved→sql_migration_resolved→sql_load_resolved→schema_read_resolved→frontend_ready（5485ms），已跨过此前SQL连接拒绝。但外部Python schema探针没有成功，不能用frontend_ready替代完整schema7验收。process_job覆盖Start-Controlled多个阶段，尚无具体Win32 code，不能断言AssignProcessToJobObject是唯一原因。

launches=[]，cycle2/reinstall未尝试，整体cleanup未通过；NSIS卸载、安装二进制移除、注册表移除为true。后续restore/Windows WebDriver/runner evidence未执行。保持job失败，修诊断与探测器后须新runner验证，不能只增加timeout或降低门槛。

## 冻结与独立核验

Root重新核对55份捕获文件2401325bytes、完整ZIP56成员、710个不可变Git blob/mode/SHA、5份实际stdout JSON行段，并重新查询终态API与公开commit tree/parent；见[Root固定核验](ci-cf8-root-verification-2026-10-07.json)。索引SHA `20fd2cb5ec0f071bcf22d8b4dc2e798972fdb1587f7ec25f8def185abbd3c878`，ZIP SHA `e861093653e829d704274eb72680202b2a6587b43f8dcaaa7ed465232a021c9a`（490273bytes）。原始捕获在/tmp/eastgenesis-cf8-ci，含完整日志；仅下载小型Linux WebDriver诊断ZIP，桌面安装包未下载。

CI使用合成Provider，结果不证明真实双供应商切换、正式历史版本升级、签名/公证或性能基线。产品仍Alpha/内部QA。
