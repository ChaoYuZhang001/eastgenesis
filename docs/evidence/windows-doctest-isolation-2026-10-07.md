# Windows workspace doctest 的 native 搜索路径隔离

2026-10-07，源码快照 `e7d00dc29f3160b562042809520027989d732544` 的 Windows CI 在 SQL 插件的 `Builder::build` 文档测试链接时失败。原始链接参数、锁定 Tauri 依赖和 Cargo 官方源码共同支持以下机制：同一次 workspace compilation 把应用的 native 搜索路径交给了插件 doctest，其中包含 Tauri 应用用于覆盖 CRT 的 `msvcrt.lib`，但该 doctest 没有应用目标的 CRT linker 参数。

候选修正只调整 Windows 测试命令的执行边界：所有 workspace 非文档目标继续测试，三个 package 的普通及 QA doctest 分别执行；macOS/Linux 保留原命令。发布时的 CRT、插件示例和 doctest 开关均未改变。**独立插件 doctest 已在 macOS 普通及 QA 配置下实际通过；本记录尚不证明修正后 Windows 链接成功。**

## 原始失败证据

原运行为 [CI run 37555825538、Windows job 112581698276](https://github.com/ChaoYuZhang001/eastgenesis/actions/runs/37555825538/job/112581698276)。原日志 basename 为 `windows-job-112581698276.log`，SHA-256 为 `a6e8c6b323cfba47231000c619119a1a83315af6d88d87e2ac36933945514983`。本记录不复制机器绝对路径或整条 linker 命令；完整字节身份及行号见 [固定 JSON](windows-doctest-isolation-2026-10-07.json)。

| 原日志行号 | 直接观察 | 意义 |
|---|---|---|
| 2406 | `Builder::build`，源码 `vendor/tauri-plugin-sql/src/lib.rs:231`，FAILED | 一个文档示例在链接阶段失败 |
| 2413 | `/defaultlib:msvcrt`，native 搜索包含应用 `eastgenesis-desktop/out` | 插件示例实际接收到应用 build-script 输出路径 |
| 2415 | 应用 out 中 `msvcrt.lib` 的 `LNK4003: invalid library format; library ignored` | linker 选中了应用用于 CRT 覆盖的文件 |
| 2416–2417 | `mainCRTStartup`、`memcpy` 未定义 | CRT 符号没有正确满足 |
| 后续失败汇总 | `LNK1120`，19 个 unresolved externals | 文档示例没有生成可执行文件 |

已显示的 linker 参数不包含应用输出的 `/NODEFAULTLIB:msvcrt.lib` 或完整静态 CRT 默认库选择。原日志同时确认插件四条迁移单元测试通过，desktop/core 各有零个文档示例；普通 workspace 命令随后失败，`set -e` 下的 QA workspace 命令尚未执行。CI 明确打印 `rustc 1.99.0 (b940084d7 2026-09-28)`，但没有打印 Cargo binary version，后者保持 **unknown**。

## primary source 解释

锁文件钉定 `tauri-build 2.7.0`，crate checksum 为 `5b5ae674f48836f5dd2eeaf9e221c095bd3e78a8d0439c77ca93b48740a1b644`。项目 `src-tauri/build.rs:1–3` 正常调用 `tauri_build::build()`。

[Tauri 2.7.0 的 `static_vcruntime.rs`](https://docs.rs/crate/tauri-build/2.7.0/source/src/static_vcruntime.rs) 的 10–25 行输出应用目标的 CRT linker 参数，28–57 行创建替代 `msvcrt.lib` 并通过 `cargo:rustc-link-search=native=...` 加入应用 out 路径。[同版 `lib.rs`](https://docs.rs/crate/tauri-build/2.7.0/source/src/lib.rs) 的 903–905 行在 Windows 构建中调用该逻辑。固定 JSON 记录本地锁定 crate 两个源码文件的 SHA，便于核对实际读取版本。

Cargo 官方 **0.99.0**，revision `797e8a9bca276c1c9f9f738d2a20f484fa4eea9d` 的两个位置说明共享路径的范围：

- [`build_runner/mod.rs:301–313`](https://github.com/rust-lang/cargo/blob/797e8a9bca276c1c9f9f738d2a20f484fa4eea9d/src/cargo/core/compiler/build_runner/mod.rs#L301)：把本次 compilation 的所有 build-script `library_paths` 加入一个 `compilation.native_dirs` 集合。
- [`cargo_test.rs:231–233`](https://github.com/rust-lang/cargo/blob/797e8a9bca276c1c9f9f738d2a20f484fa4eea9d/src/cargo/ops/cargo_test.rs#L231)：为每个 doctest 注入整个集合。

官方 **0.100.0**，revision `5f94df4789f005f9a352888e8355ffc645b7ed0e` 的 [`build_runner/mod.rs:301–313`](https://github.com/rust-lang/cargo/blob/5f94df4789f005f9a352888e8355ffc645b7ed0e/src/compiler/build_runner/mod.rs#L301) 和 [`cargo_test.rs:231–233`](https://github.com/rust-lang/cargo/blob/5f94df4789f005f9a352888e8355ffc645b7ed0e/src/ops/cargo_test.rs#L231) 保留相同逻辑。四份官方源码的 revision、URL、basename、SHA 和行号均在固定 JSON 中。

这里的集合来自**当前选中的 compilation 和 build scripts**，并非遍历磁盘上全部缓存目录。workspace 同时选中应用与插件时，应用 out 路径进入共享集合；只选择 `tauri-plugin-sql` 时，其依赖图不包含应用 build script。这个推断与原始 Windows linker 参数和后述 macOS 实际 rustdoc 参数一致。

本机 Cargo 为 `cargo 1.98.1 (797e8a9bc 2026-08-05)`，revision 与所读取 0.99.0 源码一致。0.100.0 作为相关版本源码佐证，**没有被认定为已核验的 Windows CI Cargo binary**。

## 候选命令与覆盖范围

`.github/workflows/desktop.yml` 的 Windows 分支使用以下完整命令；每条失败都会终止该步骤：

```bash
cargo test --workspace --all-targets --locked
cargo test -p eg-core --doc --locked
cargo test -p eastgenesis-desktop --doc --locked
cargo test -p tauri-plugin-sql --features sqlite --doc --locked

cargo test --workspace --all-targets --features qa-faults --locked
cargo test -p eg-core --doc --locked
cargo test -p eastgenesis-desktop --features qa-faults --doc --locked
cargo test -p tauri-plugin-sql --features sqlite,qa-load-observer --doc --locked
```

`--all-targets` 覆盖 workspace 非文档目标；三个 package 的独立 `--doc` 保留所有文档测试。`eg-core` 没有 QA feature，两个模式中的该命令配置相同。应用的 `qa-faults` 启用插件 `qa-load-observer`；独立 QA 插件命令显式启用 `sqlite,qa-load-observer`，避免因为 package selection 改变而遗漏 SQLite 或 observer。

当前 metadata 的非 custom-build 目标是 core lib、`eg-mcp-files` bin、两个 core integration tests、desktop lib/bin、插件 lib。普通及 QA workspace all-target 测试仍保留应用与 Tauri/Wry 的完整依赖图；独立 plugin doc 不选择由应用引入的 Tauri/Wry feature，该示例本身为泛型 `R: tauri::Runtime` 的 API 示例。

Unix 分支继续执行 `cargo test --workspace --locked` 和 `cargo test --workspace --features qa-faults --locked`。没有设置 `doctest = false`、`ignore` 或 `no_run`，没有删除示例、改变发布 CRT、覆盖 Cargo 全局 linker flags 或降低测试失败标准。

## 已实际执行的本地验证

macOS，`rustc 1.98.1 (48a229cea 2026-09-01)`；以下两个命令均执行了原 `Builder::build` 示例，各为 **exit 0、1 passed、0 failed、0 ignored**。验证快照时间为 `2026-10-07T01:27:30.299Z`。

| 配置 | 已执行命令 | verbose 日志 basename | SHA-256 |
|---|---|---|---|
| 普通 | `cargo test -p tauri-plugin-sql --features sqlite --doc --locked -vv` | `eastgenesis-plugin-independent-doc-normal.log` | `ac16e060e2acf813bcbf56bb95d1dd2ed0d9c113801ed51795ac29009dd66e4c` |
| QA | `cargo test -p tauri-plugin-sql --features sqlite,qa-load-observer --doc --locked -vv` | `eastgenesis-plugin-independent-doc-qa.log` | `e63370d453b9aac4d941c8e57fce9b367a085c287b44100131282358695ae0fb` |

每份日志只有一次插件 rustdoc 调用。最终命令中的 native `-L` 均只有匿名化后的 `libsqlite3-sys/out`，没有应用 out 搜索路径，也没有编译 `eastgenesis-desktop`。普通 rustdoc 无 observer feature，QA rustdoc 实际有 `feature="qa-load-observer"`。原始本地核验清单 basename 为 `eastgenesis-windows-doctest-isolation-review.json`，SHA 为 `f20460b241cb45db48149fb085cb15dea9eb09ec73399dff60e49b8b0ebe228a`；固定 JSON 转存公开所需字段并移除机器绝对路径。

## 结论与后续验证边界

证据支持的是测试 compilation 边界导致的 CRT 路径污染，以及独立 package 命令在 macOS 上确实移除了该路径并执行文档示例。下一次 Windows CI 必须实际通过普通/QA all-target 和各 package doc，才能确认 Windows 修正有效。应用和 core 当前零文档示例，未来新增示例仍需自己的成功链接与执行证据。

泛型 Builder 示例只验证插件公共 API，不启动桌面、不连接数据库、不运行迁移或任务恢复。这项修正也**不能解释或解决更早一次 Windows 原生 `Database.load` reject**；那个问题仍需实际原生阶段诊断。本文不宣称 Windows 安装/启动、历史版本升级、真实双 Provider、三平台性能或签名发布完成。
