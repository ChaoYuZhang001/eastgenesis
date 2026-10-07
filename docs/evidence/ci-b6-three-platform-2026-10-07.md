# b6 三平台 CI 终态证据 — 2026-10-07

源码快照 `b6a4923b46656cd54cf858862f8fb27bdc19551d` 的 [run 37559890652](https://github.com/ChaoYuZhang001/eastgenesis/actions/runs/37559890652) 终态 **failure**。它绑定本机提交 `a035aa93659a6b834a85aa166677fd663913b9b5`，项目 source tree `59f78ecb67c50b8806fc46397e6ad6a2b1ff7c45`；GitHub commit tree 与本机项目子树相等。源码归档 14,295,040 bytes，未推送整个 Desktop 历史或构建缓存。

| 平台 | Job | 终态 | 完成 UTC | 实际范围 |
|---|---:|---|---|---|
| macOS | 112594535379 | success | 02:08:19 | 普通/QA Rust、MCP补测、QA打包、package/runner；native WebDriver not_run |
| Ubuntu | 112594535672 | success | 02:17:48 | 普通/QA Rust、MCP、四个原生WebView场景、真实dpkg QA版本夹具安装/升级/卸载 |
| Windows | 112594535653 | failure | 02:23:55 | 普通/QA all-targets及独立doc、MCP、两次QA构建通过；NSIS首轮数据库连接配置失败 |

## Windows：已越过链接失败，仍未完成安装启动链

八条普通/QA Rust target/doc命令均通过，SQL插件普通/QA doctest各1项通过，MCP3文件15项通过。应用QA包与隔离NSIS夹具两次构建均通过，实际NSIS安装、注册表、完整payload绑定与失败后的卸载/清理均通过。不能因为有安装包就将生命周期判为成功。

首轮启动 `database_timeout`，实际观察34,355ms，rootProcessAlive/windowPresent均true，job有7个进程；databaseExists=false，schemaProbeAttempts=0。严格31条trace显示：

| 序号 | 阶段 | elapsed ms |
|---:|---|---:|
| 23 | db_load_called | 3271 |
| 24 | sql_load_entered | 3285 |
| 25 | sql_connect_started | 3285 |
| 27 | sql_connect_configuration_failed | 3285 |
| 29 | db_load_failed | 3289 |
| 30 | backend_init_failed | 3289 |
| 31 | frontend_boot_failed | 3289 |

typed类别来自原SQLx Result，不包含原始路径或异常文本。它证明失败位于连接配置，尚未进入迁移；没有观察到cannot_open或io_permission_denied，不应再将原因称为权限错误。第二轮重装和后续Windows WebDriver均not_run。有关Windows verbatim路径与SQLx首个问号解析的后续本机诊断，不属于本次CI直接观察，仍须新候选Windows实测确认。

## 用例计数与平台边界

Mac/Ubuntu cold frontend987 passed+11 skipped=998，Rust后MCP15/15补齐11个缺二进制用例，并重复4个：独立执行人口为998。Windows cold981 passed+17 skipped=998；MCP补齐11个，独立执行992，另6个POSIX cleanup平台skip不能计为通过。三次跨进程SQLite/SIGKILL用例均通过，但属于既有前端人口的重复验证，不能额外加计。

Ubuntu四个实际WebView场景通过，staged/slow/truncated/idle的headers、首body bytes、transport terminal分别为74/110/725、66/364/979、66/67/81、71/72/415ms。这是单次IPC观察，非模型首token/首帧或任务完成率。实际dpkg QA0.1.0→0.1.1/schema7、两次4000ms存活、安装身份/合成哨兵/清理通过。deb为6,694,616与6,694,618 bytes；同源码版本号夹具不证明历史生产升级。

## Root独立复核

固定capture index SHA256 `ba2475611a271c358a81f9896d8417810a7e7b7c366d9a078c4d3b749ebe2b47`，69文件/1,683,427 bytes。Root重算每份文件大小/摘要，重新请求GitHub终态run/jobs/tree，对五份JSON按原日志行范围去除时间戳重新解析并比对相等，另校验Windows31条顺序及无migration阶段。

Linux小诊断ZIP仅6,807bytes，SHA256 `03479e059947bd7e209f4eba514b307e455aaed7ebf26748ffd1abd7f37b5e4d`，与GitHub digest及12个成员逐字节一致。没有下载三个大bundle；其metadata大小分别为Linux228,220,513、Mac13,955,110、Windows12,197,548bytes。完整源码/原日志来源及校验结果见[固定JSON](ci-b6-three-platform-2026-10-07.json)。首次Root核对捕获了尚在更新的coverage派生文件，最终index冻结后重新全部核验，不把观察期快照误称终态绑定。

本CI不覆盖新未提交的历史两App harness、后续路径修复、真实双Provider、历史生产发行升级、签名/公证或三平台性能基线。产品继续保持Alpha/内部QA。
