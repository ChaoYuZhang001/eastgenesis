# Linux Debian 包隔离解包启动证据

日期：2026-10-07。来源：GitHub Actions run [37510223615](https://github.com/ChaoYuZhang001/eastgenesis/actions/runs/37510223615)、Ubuntu job `112429133656`，源码快照 `59c2c9d57c7a8105c077bda81a01266b5eb5392a`。

真实 runner 的 `desktop:install:smoke` 通过六项检查：包元数据、payload、动态依赖、二进制启动、SQLite schema 7 和受控退出；随后 runner evidence 汇总校验通过。JSON 见同目录 `linux-deb-extract-2026-10-07.json`。

包为 `east-genesis-desktop` 0.1.0、amd64，6,694,342 字节。进程使用隔离 prefix 和 XDG HOME，SQLite 的 sessions/tool_invocations 表存在；退出信号 SIGTERM，进程组不再存活。Node 的 exitCode 为 null 是信号退出的正常语义，不应单独当作进程仍存活。

证据模式为 `deb-extract`：没有修改系统 dpkg 数据库，尚不证明系统安装、卸载、旧版升级、自动更新、AppImage/RPM 安装、真实 Provider 或签名/公证。运行日志中的临时路径没有写入本报告。
