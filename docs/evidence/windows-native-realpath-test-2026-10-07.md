# Windows 目录别名测试的 native 路径修正

2026-10-07。此记录仅证明测试期望的修正及本机验证，不证明 Windows SQLite 或安装生命周期已经通过。

## 原始失败与原因

[固定 run 37563580233](https://github.com/ChaoYuZhang001/eastgenesis/actions/runs/37563580233) 的 Windows job `112606129427` 在前端测试阶段失败，源码为 `567fc9e1fc14c991a973440b06d8ccf589576733`。原日志 1453–1457 显示同一目录的两种表示：测试使用的传统 `fs.realpathSync()` 保留 `RUNNER~1`，实际 `fs/promises.realpath()` 返回 `runneradmin`。对象的 `accepted: true`、`prefix: EastGenesis` 一致，`UnexpectedProject` 的范围拒绝案例也已通过。

该 job 的前端总数为 1017：999 passed、17 skipped、1 failed。它未执行 Rust/SQL 插件测试、NSIS 或 Windows WebDriver。不能用该失败判断新的 SQL 路径修复无效，也不能把未执行阶段计为通过。

## 修正及验证

只修改 `tests/desktop-goal-upgrade-inputs.test.ts`：使用 `realpathSync.native()` 与实际异步 native API 的规范化保持一致，仍比较完整结果对象；同时对实际 Git 根与源码目录使用 bigint `stat` 的 `dev/ino` 核对文件系统身份，并要求实际路径是目录。`UnexpectedProject` 仍必须被 `scoped_git_project_invalid` 拒绝。生产 harness 未改。

- 专项：`pnpm exec vitest run tests/desktop-goal-upgrade-inputs.test.ts --minWorkers=2 --maxWorkers=2`，实际进程 `33991` exit 0，19 passed、零跳过。
- 类型检查：`pnpm run typecheck`，实际进程 `37180` exit 0。
- 独立只读审查核对了 Windows 原日志与完整测试 diff，未发现放宽范围闸门或跳过测试。

精确 SHA 与进程记录在[固定 JSON](windows-native-realpath-test-2026-10-07.json)。此次仅有 macOS 本机专项和类型检查；先前 1017 全套绑定的是原测试文件 SHA，不能改写为本次修正后的全套结果。新 Windows CI 尚待执行。没有运行 App、GUI 或真实 Provider。
