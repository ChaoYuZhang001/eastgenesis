# Windows Python 选择 r2：本机证据与实际 CI 边界

记录日期：2026-10-07。基线为 local `760b1b21feb03f8f7fede759910e3e52f9830130` / public `e723361f4fe5fbb90c65227c76c5bd3b8af50371`。此修复是该基线之后的候选；本文不声明新的 Windows 原生结果。

## 问题与修改

e723 的 NSIS 外部 schema probe 实际在 `process_create / Win32 123` 停止，application length124、existsfalse、fullPathComparisonfailed。原 `(Get-Command 'python' -CommandType Application -ErrorAction Stop).Source` 可以经多个 ApplicationInfo 的集合转换进入原 `[string] Binary`；旧实际运行没有记录 discovery 数量，故该次失败的具体成因尚待验证。

生产修改仅增加 Assert-PythonExecutable / Resolve-PythonApplication，并替换一行发现代码：先按发现顺序选择一个真实 ApplicationInfo，再读取 scalar Path。在字符串转换前拒绝集合，要求已有完整普通 `.exe`、无 reparse、有限 DOS/PE executable header；保留合法内部空格，不拆分/拼接发现结果，不增加 fallback。

原 Native C# body SHA-256 `e567c176fe207a1b7b6f60cfa8a3a64831f063d894d5a04564d7a8b895c7de57` 与原 Python SQL body `bf9acd83b73c0d45fd78c3ea662db3d069afaaf4dce98133246dae58d90439d4` 逐字不变。原先创建 suspended process、AssignJob 后 ResumeThread、超时/清理、物理 schema7、NSIS repair/两次启动/sentinel/uninstall 均保留。

## 本机实际检查

r2 使用三个文件；未新增源码字符串镜像测试。隔离候选中原有消费者契约一个文件 68 passed / 0 failed / 0 skipped，最终 TMPDIR=/tmp，session2888 exit0；完整 typecheck session48748 exit0。Root 重新核对 16 个冻结证据的 bytes/SHA/mode、补丁适用性和两个原 body 相等，实际应用后三个文件与冻结候选相同。独立审阅未发现剩余确认静态阻断。本机没有执行 PowerShell parser、Add-Type、WinAPI、NSIS 或新 Windows 回归。

| 固定证据 | SHA-256 |
|---|---|
| 3-file patch / 28396 bytes | `8afc96c0386f2a9644ae8784a4ffe2f3ff45bbf5e9d347ec9aacd289964fec67` |
| 16-file index | `796b6c2a326a0362c1f22970ec6d935c9f2303866250847eb81bea6511e6df01` |
| validation-r2.json / 7527 bytes | `e69d871a3b0d6830f7f40e1ff84008cdb63d9cbe5b2849b85fc562a48520f90c` |
| independent-readonly-review.json / 9834 bytes | `3b87f56bb1d116399ac8e9506d21cad829798710631a0ea188c0e1a01615a1ef` |
| Root actual apply proof | `9a49ec305cbba0ef7ccac8f2b90fcbdfb6d4ec2e7b48ad72053609211b649664` |

原始候选与证据在 `/tmp/eastgenesis-windows-python-selection-candidate-r2-20261007-ojuszjv4`；Root apply proof 在 `/tmp/eastgenesis-windows-python-r2-root-apply-20261007.json`。r1 的 76 项结果包含已移除的八项镜像 guard，只保留历史，不算 r2 新验证。

## 新 Windows CI 必须实际证明

workflow 在 Rust/前端/NSIS 之前使用 actions/setup-python@v5.6.0 的 python-path、Python3.12.10 x64 与 Windows PowerShell5.1 Desktop。回归只按 AST allowlist 加载原函数/Native/probe 定义，不执行 installer main。复制一份完整运行时到含空格目录，第二 PATH 只放同 SHA 的真实 python.exe 用于发现。

必须观察默认 Get-Command 两个实际 ApplicationInfo（无 -All/mock/人为数组）、旧 Source collection 经原 typed launcher 实际产生 process_create123；新 selector 返回第一 scalar path 后真实运行 Python，并使用原 SQL 探针验证 schema7/seed/sentinel。还须观察 parent exit 后一个 live owned descendant，经原 Wait-Command 使 Job Active0，再关闭所有所创建 Job handles、恢复环境、删除自有根并核对 source/self 起止 SHA。若旧发现或失败机制不可复现，回归失败，不改造证据以通过。

每个进程 10s、每 Job 清理 5s，120s work-budget 只在阶段间检查，不能抢占同步 copy/AST/compile；workflow5min 是总运行界限。保留 firstFailurePhase，清理失败单独记录；只输出固定标签、计数、布尔和哈希。r2 已修复 UInt32 Win32Error 被 [int] 筛除问题，成功明确 exit0。

新增 schema7 是最小 synthetic SQLite fixture，不能代替 App migration、NSIS repair/cycle2 或 DOM。allHandlesClosed 指 Job handles；retainedProcessesDisposed 仅显式 caller-retained managed Process 列表。随后原 NSIS 安装链仍须完整执行通过。旧 e723 的失败事实和原生功能限制见 [e723/760b 固定证据](e723-terminal-ci-and-native-2026-10-07.md)。
