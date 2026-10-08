# M23 发布门槛审计（更新至2026-10-07）

本记录按源码快照、二进制和运行日期区分证据。当前产品仍为 **Alpha / 内部 QA**；构建、安装生命周期、恢复正确性和公开分发分别验收。

## 2026-10-07 最新证据与门槛


最终本机源绑定闸门：103文件/1017前端测试零跳过通过，549项生产/测试/工具/资源/工作流输入及真实MCP binary起止SHA相同、Root重算一致；typecheck与合成配置/脱敏3文件55项通过。新增两App输入门禁19项、实际旧322负向拒绝/新675正向校验均通过；真实native恢复与Windows路径plugin证明范围分别独立绑定。见 [最终本机闸门](evidence/historical-path-local-gates-2026-10-07.json)及 [起止清单](evidence/historical-path-bound-tests-2026-10-07.json)。这不把a035的历史native恢复挪给后续Windows路径补丁，也不将待运行的新CI写成通过。


Windows连接配置的路径候选修复已本机验证：应用目录URL转义保留原caller query/native join和3个数据库操作，真正SQLx parser及真实SQLite create/reopen保持同schema/文件身份；最终普通plugin10unit+1doc、QA16unit+1doc均通过，Cargo锁未变。原CI路径未直接观测，具体verbatim机制仍是高置信推断；修复后的Windows NSIS/重装待新CI，见 [路径修复证据](evidence/sqlite-opaque-path-local-2026-10-07.md)。


当前新增历史QA恢复实测已通过：旧Git writer `4a88d966` → a035 reader的真实SIGABRT/同task hydrate/活动lease停止/实际到期probe applied/零重放完成，32断言、7动作与清理通过；writer288输入+525完整Git文件、reader675输入+676完整Git文件起止绑定，Root独立复核。见 [历史QA原生恢复证据](evidence/macos-historical-goal-native-2026-10-07.md)。这不是已发布版本安装升级或schema6迁移；下面旧条目的“尚未执行”按其当时来源保留。

最新已结束的 [b6 run 37559890652](https://github.com/ChaoYuZhang001/eastgenesis/actions/runs/37559890652) 绑定源码快照 `b6a4923b46656cd54cf858862f8fb27bdc19551d` 与本机提交 `a035aa93659a6b834a85aa166677fd663913b9b5`，终态 **failure**。macOS/Ubuntu success；Windows普通/QA targets及全部独立doc、MCP15项和两次QA打包通过，已越过e7链接失败，但NSIS首次启动在 `sql_connect_configuration_failed` 停止，数据库不存在且未进入迁移。安装/payload/registry及失败后卸载清理通过，重装和Windows WebDriver未执行。Mac/Ubuntu独立前端用例998、Windows992且另6个平台skip；5份原日志JSON、69份捕获文件与小诊断ZIP经Root独立复核。见 [b6固定终态证据](evidence/ci-b6-three-platform-2026-10-07.md)。

上一轮已结束的 [run 37555825538](https://github.com/ChaoYuZhang001/eastgenesis/actions/runs/37555825538)，绑定源码快照 `e7d00dc29f3160b562042809520027989d732544` 与本机发布提交 `b781765b3ed346d6da1d91f193f5279aaeb4caff`，终态 **failure**。macOS/Ubuntu success；Windows在普通Rust vendor `Builder::build` doctest链接失败，QA workspace、后置文件MCP、QA打包、NSIS及typed SQL启动观察均 `not_run`。详见 [e7固定证据](evidence/ci-e7-three-platform-2026-10-07.md)。它不覆盖当前后续运行时修复，也未复验旧9ee的原生 `Database.load` reject。

| 门槛 | 当前状态 | 已证明的范围 | 尚未证明 |
|---|---|---|---|
| 当前候选本机运行时 | **通过（本地、合成）** | 两项失败先复现后修复；最终102文件/998条、窄78、合成配置/脱敏55及typecheck零跳过通过；真实Node进程/SIGKILL/SQLite受控回归验证旧形状checkpoint与读取错误不重放 | Windows完整启动链、native里实际stale checkpoint/读故障、真实双Provider |
| Linux构建、WebView与安装链 | **通过（b6 CI）** | Ubuntu job `112594535672`：四个原生WebView场景、dpkg QA0.1.0→0.1.1/schema7哨兵及清理通过；998独立前端用例 | 历史生产升级、其他发行格式、三平台性能 |
| Windows候选测试及生命周期 | **测试/打包通过，启动失败（b6 CI）** | 普通/QA all-targets与全部doc、MCP15项、两次QA构建及NSIS安装/完整payload/registry/失败后卸载清理通过 | `sql_connect_configuration_failed`；数据库未创建、migration未开始；重装与原生WebDriver not_run，路径修复后须新Windows CI |
| macOS候选恢复 | **通过（有限、两项修复最终QA包）** | QA `0.1.0/x64` binary `45c7986bd8ab5`，12,213,256 bytes、清单列出的322项输入原生起止绑定；三个既有真实崩溃/租约/探针恢复场景及清理通过，Root独立复核 | 精确4a→a035 QA恢复已实测；已发布升级、native注入读错误/stale checkpoint仍未验证；不是正式发布绑定 |
| 签名与公开分发 | **未验证** | 现有QA构建和功能证据按binary绑定 | Windows签名/SmartScreen、macOS签名/公证/Gatekeeper、arm64/universal与干净用户安装 |
| 自动更新及真实任务质量 | **未实现/未验证** | 确定性路由/恢复与合成工具链已有回归 | 更新签名与回滚、真实双Provider故障矩阵、黄金任务真实回答质量和三平台性能基线 |

Windows候选workflow保留全部workspace非文档目标，普通/QA使用 `--all-targets` 后按core、desktop、SQL plugin分别 `--doc`；QA plugin显式启用 `sqlite,qa-load-observer`，未删除示例或放宽失败门槛。普通/QA plugin doc在macOS各1条实际通过，源码机制与实际rustdoc参数支持应用CRT native搜索路径污染的解释；**b6普通/QA独立doc已通过；NSIS数据库配置失败仍待修复后的Windows验证**，见 [隔离分析](evidence/windows-doctest-isolation-2026-10-07.md)。

两项运行时修复分别把durable ledger纳入恢复判断，以及在ledger读错时固定停止；只有成功读取的null才表示无记录。已有 `started/unknown` 缺原身份时停止，`applied`复用证据。红绿回归、实际Node/SQLite进程故障及998/78/55计数分别绑定于 [本地恢复分析](evidence/durable-ledger-recovery-local-2026-10-07.md) 与 [固定JSON](evidence/durable-ledger-recovery-local-2026-10-07.json)。

包含两项修复的新QA包构建UTC 01:49:08.723–01:53:00.097、原生测试UTC 01:53:14.205–01:56:16.445均通过，完整SHA256为 `45c7986bd8ab5b201ebcdd4cfa049822dccaa723be0649293f8d5f9277aa5fce`。322输入、binary、冻结harness与helper在原生前后摘要一致，Root另Python独立核对；见 [新包原生分析](evidence/macos-ledger-safe-native-2026-10-07.md)、[原始JSON](evidence/macos-ledger-safe-native-2026-10-07.json)、[构建清单](evidence/macos-ledger-safe-build-manifest-2026-10-07.json) 与 [Root核对](evidence/macos-ledger-safe-root-verification-2026-10-07.json)。三场景证明既有正常恢复路径未回归，未在native制造stale plan-only checkpoint或ledger读取故障；这些新故障仍只按本地Node/SQLite证据确认。`formalReleaseBinding=false`。仅含第一项修复的 [b691旧包原生记录](evidence/macos-plan-only-ledger-native-2026-10-07.md) 保持独立历史绑定。

[历史来源审计](evidence/historical-checkpoint-source-audit-2026-10-07.md) 显示迁移4–7同时进入声明schema7的App，没有独立schema6旧App终态来源；当前6→7是迁移前缀合成库经真实plugin升级。精确旧QA writer `4a88d966aa327122695d62f8035cd1eb79c79b8c`→当前native reader尚未执行。本次检查项目GitHub releases/tags为空；不能据此将QA版本夹具称为历史生产发版升级。

## 2026-10-06 初始审计与后续历史补充

以下保留早期来源和当时判断，不能作为2026-10-07当前候选门槛。初始审计对象为 `EastGenesis Desktop`；来源为仓库脚本、工作流和 GitHub Actions run `37483409209`（提交 `c603e1c68c430fc42b2f0790c0925c0c4cf2de58`）；Windows 包格式补充使用后续成功 run `37498160394` 的只读 artifact/log 结果。

### 初始审计当时的结论

| 门槛 | 当前状态 | 已证明的范围 | 尚未证明 |
|---|---|---|---|
| Linux 构建与 WebView | **通过（CI）** | Ubuntu runner 构建 QA bundle；4 个原生 WebView 场景通过；AppImage/deb/rpm 中至少有一个非空产物 | 在隔离环境真实安装、启动已安装版本、升级后数据保留、卸载清理、桌面菜单/XDG 行为 |
| Windows 构建与 WebView2 | **通过（CI）** | Windows runner 构建 QA bundle；4 个 WebView2 场景通过；MSI/NSIS 中至少有一个非空产物 | 静默安装、普通安装、旧版到新版升级、卸载、WebView2 安装前置条件、安装后凭据和数据迁移 |
| macOS QA 包 | **通过（有限）** | `.app`/`.dmg` 存在；原生进程双轮启动、受控退出和 SQLite schema/哨兵检查通过 | 当前包的签名、公证、DMG 签名、Gatekeeper 放行、Apple Silicon/universal 产物、公开安装 |
| 自动更新 | **未实现/未验证** | Tauri bundle targets 为 `all` | 没有 `tauri-plugin-updater`、更新 endpoint、公钥/签名配置、版本发现和升级回滚证据 |

## 证据定位

- `.github/workflows/desktop.yml` 的 `Check platform bundle artifacts` 只调用 `pnpm desktop:bundle:smoke`；它检查目标文件非空，不执行安装或升级。
- `tools/desktop-bundle-smoke.mjs` 的脚本注释明确写着“不安装、不启动、不声称 WebView 或签名验收通过”。
- `tools/desktop-package-smoke.mjs` 只适用于 macOS QA 包：隔离 `HOME` 中启动两轮进程，检查 SQLite schema、表、lease index 和合成 session 哨兵。报告的 `evidenceBoundary.excluded` 包含 `signing/notarization`。
- `tools/desktop-runner-evidence-validate.mjs` 的发布边界仍排除“installation/upgrade success beyond the recorded package smoke”。
- `tools/desktop-install-smoke.mjs` 已在真实 Ubuntu job `112429133656`（run `37510223615`，快照 `59c2c9d5`）通过：它把 `.deb` 解包到隔离 prefix，检查依赖、启动二进制、验证 SQLite schema 7 并通过 SIGTERM 结束进程组；报告的 `mode=deb-extract` 明确不是系统安装或升级。脱敏证据见 `docs/evidence/linux-deb-extract-2026-10-07.json`，不得回填到较早 run `37483409209`。
- `src-tauri/tauri.conf.json` 只配置了 `bundle.active=true` 和 `targets=all`；仓库没有 `tauri-plugin-updater`、更新 endpoint、签名公钥或更新签名密钥配置。
- Actions run `37483409209` 的三个 job 均成功，但 Windows/Linux 的成功步骤是构建、WebDriver 和 bundle 检查；macOS 的 `Smoke-test the packaged Mac binary` 是原生进程 package smoke。该 run 没有 install/upgrade 步骤，也没有 macOS codesign/notary 步骤。
- 后续成功 run `37498160394` 的 Windows bundle 实际包含 `EastGenesis Desktop_0.1.0_x64_en-US.msi`（7,069,696 bytes）和 `EastGenesis Desktop_0.1.0_x64-setup.exe`（约 5.35 MiB，NSIS）；这只确认 MSI/NSIS 格式产物，仍没有安装器执行、升级、卸载或迁移步骤。

本次 run 上传的 bundle artifact 大小如下，表示 CI 产物大小，不表示安装成功：

| Artifact | 大小 |
|---|---:|
| `eastgenesis-desktop-Windows` | 12,212,691 bytes |
| `eastgenesis-desktop-Linux` | 214,847,652 bytes |
| `eastgenesis-desktop-macOS` | 13,963,454 bytes |

## 平台缺口与下一步证据

### Linux

应在 Ubuntu runner 中建立临时 `HOME`/XDG 目录，选择一种实际交付格式并执行：

1. 安装当前版本（AppImage 可先解包；deb/rpm 使用临时 root 或 runner 专用 VM）；
2. 启动已安装二进制，写入一个合成 session/设置哨兵；
3. 安装同一产品 ID 的下一版本；
4. 再启动并核验哨兵、SQLite migration、文件权限和 desktop entry；
5. 记录卸载结果和数据保留策略。

如果 runner 不能安全执行系统包安装，应明确输出 `install=blocked`，保留构建和包结构证据，不能用 bundle smoke 替代。当前新增的 deb 解包 smoke 只提供隔离前缀证据，仍需后续真正的临时系统安装和升级测试。

### Windows

应在 Windows runner 中以临时安装目录和临时用户数据执行 MSI 或 NSIS 的安装/升级回归：

1. 安装基线版本并启动一次；
2. 记录合成 session、Provider 配置占位和应用版本；
3. 安装同产品 ID 的新版本；
4. 核验数据迁移、快捷方式、WebView2 运行时、文件权限和卸载结果；
5. 对 MSI/NSIS 选择一种正式交付格式，另一种只作为构建产物或明确标记未验收。

安装测试必须在独立 runner/VM 中完成，不能把本机用户目录或 CI runner 的全局安装状态作为证据。

### macOS

公开分发需要独立的发行工作流，不应在普通 QA workflow 中隐式签名或上传：

1. 发行构建关闭 `qa-faults`；
2. 使用 Developer ID Application 对 `.app` 签名，并启用 hardened runtime；
3. 对 DMG 及其中的 `.app` 验证签名；
4. 使用受保护的 Apple API key/Keychain profile 调用 `notarytool submit --wait`；
5. `stapler staple` 后运行 `stapler validate`、`codesign --verify`、`spctl --assess`；
6. 在干净 macOS 用户环境安装并启动，至少覆盖当前 x86_64 主机和目标 arm64/universal 产物。

当前主机能看到 Developer ID Application 身份和 Xcode `notarytool`，但本审计没有签名、上传或公证；存在身份不等于发行证据已完成。

## 初始审计的发布状态与持续门槛

M23 在初始审计时标记为 **Alpha / 内部 QA**，当前阶段仍未升级。run `37483409209` 可以作为三平台构建、确定性路由/恢复和 Linux/Windows WebView 的证据，但不能作为下列条件的替代：

- Windows完整原生安装/重装/卸载，以及Linux同源码QA版本夹具以外的历史生产升级；
- macOS 发行签名与 notarization；
- 自动更新、回滚和数据迁移；
- 真实 Provider 故障矩阵。

只有上述证据在原生 runner、隔离用户环境和受保护发布凭据下分别产生，并被上传前的脱敏校验器接纳，才可把分发门槛从 `not_run` 改为 `passed`。
