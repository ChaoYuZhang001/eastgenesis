# 目标执行失败保留原任务与继续计数修复

2026-10-07。当前候选基于parent `4fca797429fd66f839a6e4ea83613d6834b108d0`。源文件起止摘要、原始红绿日志和实际执行记录见[固定报告](goal-failed-recovery-local-2026-10-07.json)。本轮不是此前567 CI或a035原生App的结果。

## 已复现的执行路径

GoalRunner原先在任务failed后关闭失败轮次并自动新开一轮；新轮创建新task和新的幂等命名空间。受控Runtime/task-store场景先读取文件、写入代码、完成Chat分析，在最终总结已产生部分输出后失败。旧执行器在同一目标内start/read/write各执行三次，违背“从未完成步骤继续”的目标。该原始重放红日志保留；最初夹具未包装RouteExhaustedError的计数诊断单独标记，不计为真实计费回归。

改为暂停原轮后，真实 executeWithFallback 契约下又复现一项错误：读回同task checkpoint，仅新增一次summary，事件历史却被再次累计，used_llm_calls从3变为7。正确结果应为4。

## 修改和验证

普通failed结果现在将目标转paused、原轮转interrupted，并用确切taskId保存checkpoint；不会自动新建task。完成但未达成的正常多轮、aborted/needs_user暂停及预算闸门保留。checkpoint回调失败时保持暂停并只展示固定存储错误。

每次tasks.run在onEvent局部累计llm/llm_failed（包含既有一层subagent），惰性轮次句柄使用本次新增计数；outcomeOf仍描述完整任务实据，不删除旧事件。这不使用有界历史的起始offset，也不新增Goal/SQLite计费水位。

最终7文件65项和typecheck通过，5项直接输入起止相同。生产Runtime、tasks惰性句柄、Goal状态机、轮次JSON解析与hydrate真实运行，模型传输、完成判定及工具注册是合成依赖；工具实际读写自有临时文件。保存读回后只有一个原轮/原task，继续只请求summary，先前Chat结论marker进入该请求，文件读写各一次，inode/mtimeNs/SHA不变；计数3+1=4，预算5后剩2。目标预算已用尽3次时，继续不新增请求或任务。

Root重算源和7份日志摘要。这些是本机合成回归，没有执行新的原生App重启或真实Provider。没有新增500事件/子agent压力测试；现有局部计数方案不依赖事件历史长度，但不把静态依据当实测。进程崩溃前尚未结算的旧RoundResult不会由继续运行追补，持久计费水位仍未实现。长Chat输出受既有字段预算限制；不得声称无损正文恢复或复用旧原生结果覆盖本轮。
