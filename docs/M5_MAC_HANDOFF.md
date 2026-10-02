# M5 Mac 端交付清单

以下命令都在项目文件夹（`EastGenesis/`）里执行。

## 一、准备（只做一次）

- Xcode 命令行工具：`xcode-select --install`
- Rust：用 rustup 装最新 stable，至少 1.90（Tauri 2.12 的要求），`rustc -V` 确认
- Node 22 LTS；pnpm 由 corepack 按 `package.json` 固定为 9.15.4：`corepack enable`

## 二、导出 bundle 后运行的命令

`EastGenesis-repo/` 是之前从 bundle clone 的副本，它的 origin 已经指向 `eastgenesis.bundle`。

```sh
cd EastGenesis-repo
git pull --ff-only                  # 从 eastgenesis.bundle 拉取最新提交
pnpm install --frozen-lockfile
pnpm tauri dev                      # 首次会编译全部 Rust 依赖，耗时较长
```

`Cargo.lock` 已经提交在仓库里（2026-09-30 在 VM 生成，并对 macOS 目标做过编译检查）。不要删，也不用自己生成，Tauri 内部 crate 的版本靠它固定。编译完运行一次 `git status --short`，应该没有输出；如果出现 `M Cargo.lock`，说明本机解析出的版本和提交的不一致，请告诉我。

`pnpm tauri dev` 正常后，再做未签名打包（M7）：`pnpm tauri:build:mac`。产物在项目根目录的 `target/release/bundle/`：`macos/EastGenesis Desktop.app` 和 `dmg/EastGenesis Desktop_0.1.0_x64.dmg`。这个脚本设了 `CI=true`，让 Tauri 跳过 create-dmg 用 AppleScript 让 Finder 排版 DMG 窗口的那一步。2026-09-30 这台 Mac 上，这一步两分钟后失败，没有生成 .dmg；直接用 `pnpm tauri build` 还会走这一步。跳过后 DMG 窗口是 Finder 的默认排列，内容不变（应用和「应用程序」快捷方式）。如果还失败，在命令后加 `--verbose`，日志里会有 bundle_dmg.sh 的完整输出。

打开 .dmg，把应用拖进「应用程序」，再从那里启动，第三节的检查用打包版再做一遍（打包版用内嵌的前端资源，不连 Vite）。没有签名和公证，只供本机试用。从访达启动时读不到终端里的环境变量，Key 要先存进钥匙串。

只看界面、不编译外壳：`pnpm dev:web`，打开 `http://localhost:1421`，使用模拟后端。地址后加 `?mock=fail-init`、`?mock=slow,jev` 等参数，可以预览失败和慢速状态。

## 三、首次启动要确认的事

- 窗口：默认 1280×820，最小 960×640。最小宽度下右侧面板仍可折叠。
- 启动页：打开 SQLite 期间显示，完成后淡出。失败时显示图标、说明和「重试」按钮。
- 侧栏底部应显示「SQLite · 结构版本 3」（M6 新增记忆表和技能表，之前建过的数据库会自动迁移），且没有「模拟后端」标记。出现该标记说明没识别到 Tauri 环境，请告诉我。
- 钥匙串：在「系统与工具 → API Key」保存 Key 时，macOS 会询问是否允许访问钥匙串，选「始终允许」。未签名的开发构建重新编译后可能再次询问，这属于正常现象。条目的服务名是 `com.eastgenesis.desktop`，账户是 `provider/<id>` 或 `jev`。
- Key 来源：钥匙串优先，其次是环境变量（如 `OPENAI_API_KEY`、`TYPESAFE_API_KEY`）。环境变量只在从终端运行 `pnpm tauri dev` 时生效。
- 真实请求：「测试连接」和提交任务会用你的 Key 发出真实请求，可能产生费用。7 家官方 Provider（OpenAI、Anthropic、Google Gemini、DeepSeek、通义千问、Kimi、Ollama）和自定义 Provider 都已接好。通义千问和 Kimi 的 Key 按地域签发，要在 Key 那一行选对地域。Ollama 默认关闭，本机在运行时再打开「让路由使用本机 Ollama」。任务能用的工具来自 MCP 服务器，见下一条。
- MCP 服务器（M6）：在 `~/Library/Application Support/com.eastgenesis.desktop/mcp.json` 登记，目录不存在就新建。格式见「系统与工具 → MCP 服务器」里的示例。
  - command 写绝对路径。用 npx、uvx 启动的，还要在 env 里写 PATH（例如 `/opt/homebrew/bin:/usr/bin:/bin`），否则找不到 node、uv。
  - 密钥写成 `${keychain:NAME}`，在设置页填写。钥匙串账户是 `mcp/<服务器>/<NAME>`。
  - 请试一个真实服务器：启动、看工具列表、提交一个会用到它的任务。启动失败时卡片里有 stderr，可以直接复制给我。
- 记忆（M6）：在「系统与工具 → 记忆与技能库」添加一条偏好，再提交任务，时间线里应出现「参考了 N 条记忆」。重启应用后记忆还在，说明 SQLite 读写正常。
- 技能库（M6）：任务完成后点卡片上的「保存为技能」，再提交一个类似的任务，时间线里应出现「参考了 1 个技能」。
- 多 Agent 协同（M6）：勾选任务输入框下的「多 Agent 协同」再提交，卡片上每个子 Agent 一行，右侧「子 Agent」面板显示各自的模型和进度，最后给出合并后的成果。两个子 Agent 会同时发请求，请留意是否触发 Provider 的限流。
- 本地决策模型（M6）：本机运行 Ollama 并拉取模型（例如 `ollama pull qwen3:8b`），先在终端跑一次 `ollama run qwen3:8b 你好` 让模型加载进内存（首次加载可能超过 8 秒的决策超时），再在「系统与工具 → API Key」最下面的「本地决策模型」里选它，然后提交任务。时间线的反思条目应显示「本地 Jev」。路由面板里「本地 Jev（…）」括号中是它没接手的原因，例如「置信度…低于阈值」「调用失败（timeout）」「调用失败（config）」，请抄给我。config 多半是模型没拉取：拉取后在设置里先选「不使用」再选回它，就会重新尝试。
- 请顺手试一下：拖拽和上移/下移任务卡片、折叠和关闭卡片、折叠右侧面板、用 Tab 键遍历焦点。这些在 VM 里只在 jsdom 中测过，没在真实 WKWebView 里跑过。
- Jev 耗时（P50 目标 < 300ms）：在 `EastGenesis-repo/` 根目录放一个 `.env.local`，写一行 `TYPESAFE_API_KEY=你的 Key`（已被 .gitignore 忽略），运行 `node tools/jev-smoke-test.mjs 10`，把最后几行（P50、P90）抄给我。VM 里实测 P50 是 328ms，未达标，其中往返网络 P50 约 250ms，Mac 上可能不同。用完请删掉 `.env.local`。

## 四、出错时怎么反馈

把输出写到项目文件夹里，我可以直接读取，写好后告诉我一声即可。Rust 侧代码没有日志输出，这些文件里不应出现 Key；发送前可以搜一下 `sk-` 再确认一遍。

日志放在 `EastGenesis-repo/` 根目录（`*.log` 已在 .gitignore 中，不会被提交）：

```sh
RUST_BACKTRACE=1 pnpm tauri dev > mac-tauri-dev.log 2>&1
pnpm tauri:build:mac > mac-tauri-build.log 2>&1
{ rustc -V; cargo -V; sw_vers; pnpm tauri info; } > mac-env-info.log 2>&1
```

- webkit2gtk 报错：webkit2gtk 只用于 Linux，macOS 用的是系统自带的 WKWebView。如果在 Mac 上看到 webkit2gtk 相关报错，说明依赖配置有问题。请额外运行 `cargo tree -i webkit2gtk > mac-webkit.log 2>&1`。
- 白屏：在窗口里右键选「检查元素」（或按 ⌥⌘I），把控制台里的红色报错复制给我。
- 报错含 `not allowed`：通常是 `src-tauri/capabilities/default.json` 缺少权限，把完整报错发给我。
