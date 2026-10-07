# 已完成 Chat 结论与反思状态的本地恢复修复

2026-10-07。本轮基于 parent `4fca797429fd66f839a6e4ea83613d6834b108d0` 的未提交候选；它不属于567 CI或a035原生构建。精确六文件SHA、红绿原日志SHA和独立审查记录见[固定JSON](completed-chat-recovery-local-2026-10-07.json)。

## 已复现的问题

同一目标先实际读取自有临时文件、写入代码文件、完成Chat分析，最终总结中断。运行时的 `StepRecord.output` 有结论，但该结果没有写入持久化事件；任务转换、JSON存储、解析、hydration和恢复后，summary请求中该已完成Chat的上下文为空。两条原始产品红测试均找不到唯一合成结论marker。首次夹具的Codex分类失败独立保留，不计为正文丢失的红证据。

另两条真实运行时回归捕获反思拒绝后的窗口：`done=false/score=0.1`，在异步replan内抛AbortError、尚未发出recover事件。终态aborted或运行中checkpoint经真实转换/解析恢复，旧逻辑将失败Chat误当完成、跳到summary。修正恢复后，任务进度与两种技能提取仍出现两条测试共六处失败断言；消费者也已同步修复。

## 结果及验证

运行时仅给接受的非工具结果保存 `reflect.output`，并用可选 `accepted` 字段记录实际接受或拒绝判定。恢复层、任务步骤进度、成功步骤提取和技能配方提取直接消费该值，不复制评分阈值猜测。两个反例验证 `done=false` 的Chat评分0.3和可信结构化工具评分0.1仍被运行时接受，因此可以完成而不重放。

最终专项9文件/116测试通过，新文件10条：

- 实际Runtime→taskToStoredTurn→normalizeSession→JSON→parseTurns→fromStoredTurn→recoveryCheckpoint→同task继续；恢复后的实际summary请求含先前Chat结论。
- 已完成的文件读写各一次，inode、mtimeNs与SHA不变；已完成场景只请求summary，失败窗口场景从Chat继续，仅请求answer与summary。
- `accepted=false`不会被卡片进度或技能提取计为完成，实际重试成功后能转为完成。
- 工具和probe结果不被非工具正文覆盖，非字符串不进入history，既有公开证据投影不含正文。

快照先脱敏，使用现有4000 UTF-16 code-unit会话字段上限；截断提示在预算内，并保留合法Unicode切口。长输出只保存带提示的前缀，不能声称无损恢复。旧checkpoint没有正文或接受判定时保持既有兼容语义，无法追溯恢复从未保存的内容或区分旧失败窗口。

源文件及原日志均由Root重新计算摘要，并经独立只读审查。没有在本专项运行真实桌面、真实Provider或新的三平台CI。后续全量、本机build和新桌面验收须分别绑定实际来源；不得扩大先前a035原生证据。
