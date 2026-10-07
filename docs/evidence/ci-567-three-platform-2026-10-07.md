# 567 三平台 CI 固定终态

[run 37563580233](https://github.com/ChaoYuZhang001/eastgenesis/actions/runs/37563580233) 于 2026-10-07 03:03:07 UTC 完整结束，整体 failure。公开源码 `567fc9e1fc14c991a973440b06d8ccf589576733` 对应本机不可变提交 `4fca797429fd66f839a6e4ea83613d6834b108d0` 的项目 subtree `f47c97b25cf2e71d3a66b272bd53986d14d965bc`。后续工作树中的 Chat 输出、反思状态或路由文案修复不属于该 run。

| 平台 | 终态 / UTC | 前端与后置集成 | 原生、打包、安装 |
|---|---|---|---|
| Windows，job112606129427 | failure / 02:49:46 | 999 passed、17 skipped、1 failed；MCP/cross-process 未执行 | Rust、SQL 修复、QA 打包、NSIS、WebDriver 全部未执行 |
| macOS，job112606129513 | success / 02:56:12 | 1006 passed、11 skipped；后置 MCP15 补齐11并重复4，唯一覆盖1017；cross-process3为重复专项 | 普通SQL10+doc1、QA16+doc1；包 smoke 与 runner evidence通过；CI WebView明确not_run |
| Ubuntu，job112606129161 | success / 03:03:07 | 同macOS，唯一覆盖1017 | SQL普通10+doc1、QA16+doc1；4真实WebView、Deb解包启动/schema7和实际dpkg生命周期通过 |

Windows 的目录 symlink 创建成功，实际结果 `accepted:true/prefix:EastGenesis`，相邻 `UnexpectedProject` 拒绝案例通过。唯一失败是测试传统 `realpathSync()` 得到 `RUNNER~1`，实际异步 native API 得到 `runneradmin`，完整对象比较的路径字符串不同。不存在本轮已观察到的 symlink EPERM 或范围门禁失败；该 run 没有进入 SQL 修复或 NSIS 阶段。[本机修正证据](windows-native-realpath-test-2026-10-07.md) 单独保留，须下一轮 Windows 实测。

Ubuntu 小诊断 ZIP 的 staged、slow-first-token、truncated、idle-cancel 四个真实 Tauri WebView 场景均通过。每场景只有一次描述样本，不能作为性能基线或真实模型首 token 数据。Deb 解包的 binary 启动、schema7、受控清理通过；另一个报告实际执行 `dpkg` 安装0.1.0→0.1.1、两个4000ms启动周期、schema7及合成 session sentinel 留存，并完成卸载/purge且保留用户数据。两个版本使用同一份代码，这是 QA 版本安装升级生命周期，不能代替历史发行代码或 schema 升级。

macOS 构建日志记录 app11.37MiB、DMG6,927,998bytes。打包 binary smoke 和原日志 runner evidence通过；没有下载其桌面 bundle，因而未独立读取 bundle 内的 `package-quality.json`。CI macOS WebView 的 not_run 边界不与其他本机 GUI 证据混算。

Root 重新核对最终 capture 64个文件/1,342,216bytes，其中索引17,666bytes、SHA `ec6b1f48ee0a6adc5572e96a8441027ab4397e8d9e9889ef20edfb4f70abfb98`；重新从原日志行解析4份 stdout JSON，并比较完整对象。两个小 ZIP 仅4,210bytes Windows前置gate JSON和6,810bytes Linux诊断，GitHub digest和每个成员均一致；没有下载大型桌面安装包。

Root 还查询新鲜 run/jobs/commit/artifacts API，验证公开tree和唯一parent、本机提交的12个输入blob。原输入清单的 workingtree 匹配只是02:48:57 UTC的历史观察；此处最终绑定不可变4fca Git对象，排除后续dirty工作树。详见[独立核验JSON](ci-567-three-platform-2026-10-07.json)。

仍未证明：新的 Chat/反思/路由修复的实际桌面恢复、Windows补丁后SQL启动及完整NSIS、真实双Provider故障切换、历史正式发行升级、跨平台性能基线、签名与公证。整体仍为Alpha/内部QA。
