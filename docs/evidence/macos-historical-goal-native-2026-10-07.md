# macOS 精确历史 QA writer → 当前 reader：真实目标恢复

日期：2026-10-07；macOS/x64，两个QA应用版本均为0.1.0，schema均为7。实际执行UTC 02:37:00.313–02:38:15.971，exit0，单场景32断言/7个AX动作全部通过。两份源码来自不同实际Git提交，版本号相同；这属于历史源码QA恢复，不是已发布版本的安装升级。

| 角色 | 实际来源 | 二进制SHA256 | 字节 | 构建绑定 |
|---|---|---|---:|---|
| writer | 4a88d966aa327122695d62f8035cd1eb79c79b8c | 552c8e86168491003348334d4714de1bcd2957ee12488b424e34f8e468f75e86 | 12,229,664 | 288项编译输入，以及525个完整Git blob/权限在构建起止一致 |
| reader | a035aa93659a6b834a85aa166677fd663913b9b5 | 45c7986bd8ab5b201ebcdd4cfa049822dccaa723be0649293f8d5f9277aa5fce | 12,213,256 | 隔离完整源码重建，675项输入与676个完整Git blob/权限起止一致 |

reader构建UTC 2026-10-07T02:27:32.208Z–2026-10-07T02:31:36.985Z。675项sourceHashes覆盖完整跟踪源码、入口和资源，仅排除非构建输入MEMORY.md；该文件仍包含在完整676个导出blob校验中。reader binary与先前322项清单构建字节相同，但本次有新的构建时间/来源记录，不补写旧运行。旧writer源码归档10,997,760bytes，reader14,295,040bytes；依赖锁一致，复用本地已安装依赖与编译缓存，不改旧Cargo锁或替换旧官方SQL插件。

## 实际原生流程

fresh HOME没有预建appdata或账本。旧writer通过真实Tauri WebView创建目标、批准builtin MCP移动Downloads中的固定文件，然后在 after_tool_before_ledger_commit 发生实际SIGABRT；文件已移动，账本仍started，checkpoint包含原invocation/key，尚无tool_result。harness对数据库只读查询，从未写造任务或租约。

新reader在同一HOME启动，UI呈现继续并hydrate同一task/单round，SQLx完整metadata不变。活动QA租约仍有效时实际点击继续，任务停在needs_user，账本和文件未变。实际等待18,233ms直至原30秒QA租约到期（未改数据库时间），再次继续后真实probe=applied，原调用账本更新applied并释放lease，恢复tool_result为0，goal和task实际均completed。文件inode、mtimeNs和SHA始终相同，没有再次移动。

实际fixture请求：catalog1、plan1、args2、stream1、jsonOther1、unexpected0。仅127.0.0.1合成HTTP，QA禁用钥匙串，运行环境不继承Provider密钥，也未创建providers.json。writer/reader的MCP子进程分别校验为其同一个绑定App的 `--mcp-files` 模式。

## 清理和来源复核

两角色源文件、manifest、binary、整个App bundle和冻结harness/helper在原生起止一致；Root另重算288/675来源SHA以及525/676Git blob/权限，与原报告和原始manifest相等。原报告SHA256 `315bdc257346809fc6ce5c1cc45d15dee4f10c3353d74fe28293c61be335c4d3`，harness `90f02f5f5d02428e1a791f7f136af6b898553e3a50cb398199daa1d568073d8a`。

writer leader在SIGABRT后退出，冻结helper证明其自有group没有活进程；没有断言含僵尸的整个group绝对不存在。reader受控SIGTERM退出，group不存在。自有MCP清理没有unknown，fixture关闭且剩余socket0，合成clipboard清空，临时运行profile及两份运行副本删除；保留构建来源及原始报告以供复核。没有把正常用户App或系统XPC进程纳入清理结论。

reader验证采用独立临时Git authority中的完整a035导出，HEAD与项目prefix固定，Git objects只读引用本地原仓库，没有复制整个Desktop历史；实际编译使用相同a035隔离导出。这样正在并行修改的Windows路径补丁没有混入已构建reader。

## 失败记录与门禁

最初旧源码导出因Git cwd prefix得到空tar，完整树门禁拒绝后改从Git root导出；没有启动App。新harness合法CLI测试曾暴露sha256选项名数字被拒绝，修复后19项入口测试通过。首轮实际源码门禁因macOS `/tmp` 和 `/private/tmp` 别名未经规范化，以scoped_git_project_invalid拒绝，native=false/ownedProcesses0；原失败报告SHA35d044692437f726ce423a5afd115619f9b7cbed9ceb35a0d30c185df1b14c69保留，没有误称覆盖检查通过。

规范化root后第二次实际门禁对旧322项manifest产生预期compiled_input_coverage_missing，新675项manifest起止通过；这两轮均没有启动GUI且report.passed=false，只代表输入门禁结果。随后本次真实原生场景第一次执行即通过。旧manifest的覆盖缺口不能用当前源码检查事后补成历史完整来源。

## 证据边界

本次覆盖精确旧Git来源到当前a035候选的after-tool-before-ledger-commit恢复。它不覆盖已发布版本升级、schema6旧App/6→7迁移、旧writer在强checkpoint barrier下自然生成plan-only快照、native账本读取故障、真实Provider、Windows/Linux历史恢复、生产10分钟租约等待、任意外部服务副作用、安全签名或公证。两个native恢复状态及文件/迁移身份保持是本次实测；模型质量和一般自动任务判断不由固定fixture证明。

原始字节记录：[native JSON](macos-historical-goal-native-2026-10-07.json)、[writer构建](macos-historical-writer-build-manifest-2026-10-07.json)、[reader完整构建](macos-historical-reader-build-manifest-2026-10-07.json)、[Root独立校验](macos-historical-goal-root-verification-2026-10-07.json)。产品仍为Alpha/内部QA。
