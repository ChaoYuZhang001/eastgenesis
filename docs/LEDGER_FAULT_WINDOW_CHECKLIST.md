# 调用账本故障窗口验收清单

这份清单把“失败可恢复”拆成自动验证和真实桌面验证两部分。自动测试验证同一份 SQLite 文件在独立进程中的原子租约语义；真实 Tauri 验收验证进程退出、文件副作用和界面恢复是否一致。

## 已自动验证

运行：

```bash
pnpm vitest run tests/invocation-ledger-process.test.ts tests/invocation-crash-process.test.ts tests/invocation-ledger.test.ts
```

自动测试使用两个独立 Node 进程同时执行生产 `claim` SQL，要求同一个幂等键只有一个进程取得租约；随后验证过期接管、正确持有者续期、错误持有者续期失败和释放。

`tests/invocation-crash-process.test.ts` 还会启动一个真实独立 worker，在文件副作用已经落盘、最终 `applied` 账本提交之前发送 `SIGKILL`。第二个 worker 使用同一个 SQLite 文件和已过期租约恢复，先通过 `probe` 确认文件已落地，再提交 `applied` 并清理租约；测试要求恢复实例的工具执行次数为 0。这验证的是 Agent Runtime + 生产 SQLite SQL 的崩溃窗口语义，不等同于已验证 Tauri `.app` 的窗口和 UI。

## QA `.app` 故障触发

桌面端已经提供一个默认关闭的 QA 入口。它同时要求 `qa-faults` Cargo feature 和受限环境变量，普通发行构建不会读取环境变量，也不会终止进程。

构建 QA 包：

```bash
pnpm tauri:build:mac:qa
```

启动 QA `.app` 时再传入同一个环境变量（建议直接运行包内二进制，确保环境变量传入 Tauri 进程）：

```bash
EASTGENESIS_QA_FAULT_POINT=after_tool_before_ledger_commit \
  "/path/to/EastGenesis Desktop.app/Contents/MacOS/eastgenesis-desktop"
```

在应用中执行一个只写入测试目录的文件任务。工具返回成功后、调用账本写入 `applied` 前，QA 命令会终止桌面进程。重新启动同一 QA 包，任务恢复应先探测文件状态并跳过重复写入。`after_ledger_started` 可用于验证工具尚未执行时的窗口。不要对真实文件或生产数据库运行该夹具。

## 真实 Tauri 验证

每个场景都要记录：任务 ID、幂等键、工具、进程退出点、磁盘实际状态、账本状态、恢复后的用户可见结果。

1. 启动桌面端，准备一个允许写入的临时目录和一个可观察的文件写入任务。
2. 在以下窗口手动终止进程：
   - `claim` 前；
   - `claim` 后、`started` 写入前；
   - `started` 写入后、工具执行前；
   - 工具已经写入文件、`applied` 写入前；
   - 长任务执行期间；
   - 心跳续期期间暂时阻断数据库访问。
3. 重新启动桌面端并恢复同一任务。
4. 逐项确认：
   - 已落地的文件不会被重复写入；
   - 未落地的步骤可以安全继续；
   - 无法确定的步骤显示为“结果未知”，不会被自动当成成功；
   - 文件内容或版本冲突会停在用户确认；
   - 两个桌面实例不会同时执行同一个副作用；
   - 时间线能显示探测、租约、恢复和最终产物。

## 发布门槛

在真实 Tauri 场景全部通过前，产品只能声称“已实现恢复机制”，不能声称“桌面端崩溃恢复已验证”。有副作用的调用在账本不可用时应按风险等级 fail-closed；只读调用可以继续，但必须在时间线标出恢复能力降低。QA 包本身通过命令接线不等于真实桌面验收，仍需记录上面的任务、文件、账本和 UI 证据。
