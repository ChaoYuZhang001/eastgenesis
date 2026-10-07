# 历史任务 checkpoint 来源审计 — 2026-10-07

本审计确认可追溯的旧writer边界，并发现实际恢复风险。它没有运行旧桌面包，因此不是历史发行升级通过证据。固定提交、日期和逐文件来源摘要见 [JSON](historical-checkpoint-source-audit-2026-10-07.json)。

| 项目内历史提交 | 日期 CST | 实际来源 |
|---|---|---|
| `c9d749693bd375e2acfbd32c4ec71a4a20415006` | 2026-10-02 10:30:10 | eg-core迁移1–3；没有持久化Goal/session checkpoint |
| `2292d5706d12fe0d638cd4d9201d555a77a1bbb3` | 2026-10-06 07:49:46 | 一次加入迁移4–7；前端已声明schema7，已有running会话checkpoint |
| `f44a4d3faa0897897c5fe03e9f3874a8d64a6b30` | 2026-10-06 11:24:10 | 最早GoalRound.task_checkpoint；复用StoredTurn，旧writer依赖延迟保存，没有当前副作用前落盘屏障 |
| `4a88d966aa327122695d62f8035cd1eb79c79b8c` | 2026-10-07 03:45:15 | 可安全隔离构建的旧QA候选：Goal checkpoint、MCP故障点、副作用前落盘及QA Keychain隔离均存在 |

迁移6和7同时进入同一已声明schema7的App；没有找到schema6作为旧App终态的已提交来源。现有macOS schema6→7验证应继续称为“当前迁移前缀合成旧库经真实plugin升级”。其completed哨兵JSON逐字节保留不证明旧checkpoint被解析或续跑。

截至本次检查，`ChaoYuZhang001/eastgenesis` 的GitHub releases和tags API均为空。不能据此推断其他仓库的旧产品就是本项目生产前驱，也不能将QA 0.1.0→0.1.1版本号夹具改称历史生产升级。

当前GoalRound保存StoredTurn，没有独立checkpoint版本信封。normalizeTurn补可选字段，parseRounds读回，recoveryCheckpoint从事件重建恢复状态。缺events/plan时不能继续；未知Goal状态被跳过。仅增加版本字段无法解决“旧checkpoint有计划、没有步骤身份，但durable ledger已推进”的实际分支风险。该分支已有失败回归，运行时现将命中durable ledger纳入恢复：未决状态缺原身份停在needs_user，applied结果直接复用。

下一项跨来源桌面验收须以完整来源证明执行：从精确`4a88d966`隔离构建旧QA app，旧包自己创建真实Goal/Task/Invocation并发生MCP故障；当前包在同一物理数据根读取并继续，核对任务/轮次/幂等身份、活跃租约、过期后的真实probe和副作用次数。旧/新binary都绑定完整构建清单。现有goal harness首次和重启共用一个app参数，需要专用writer/reader入口才能验收这条链。

当前源码审计、合成旧形状的两Node进程SIGKILL回归，以及同一新QA包的原生崩溃恢复，分别保留证据边界；任何一项都不能单独替代旧native writer→新native reader的实际执行。
