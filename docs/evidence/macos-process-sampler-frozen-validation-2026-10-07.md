# macOS 冻结 sampler 原生校准

本次执行时间为 2026-10-06T22:53:56.054Z 至 2026-10-06T22:53:57.361Z，结果 **passed**。固定原始数值记录的 SHA256 为 `8101f529dcc2ac13f26988a661647c098e48d2742f32cb1f2a9e23fd00bea13c`；JSON 保存每次 native sample、目标自身 CPU 边界、退出与 helper 清理事实，并绑定 sampler、类型声明、契约测试及本校准脚本的起止源码 SHA。起止源码一致：true。

校准条件为一个本脚本直接创建的自有 Node 子进程：32 MiB 已写入 Buffer，100 ms 间隔、1,200 ms 请求窗口，单段忙循环请求 800 ms。独立测量窗口数为 1，实际采样点 12；CPU 增量 800.521441 ms，一核归一化 71.23914102347385%，RSS 采样峰值 75452416 bytes。目标自身 process.cpuUsage() 前后观测给出 native 首末采样的 CPU 增量 bracket；固定 2 ms counter tolerance 单独记录。所有子进程退出：true；目标退出后的连续两次 sample fail closed：true。

Darwin 本次状态为 executed；Linux/Windows 仍为 not_run。只涵盖一个登记 PID，owner/helper 不计入资源，未验证后代登记或完整 WebView 树；未登记后代与无法验证亲子归属的 WKWebView XPC excluded。RSS 是 resident bytes，CPU 使用 own user+system 累计 counter，窗口比例按一核 100% 计算。这里是 sampler 校准，不是 EastGenesis 资源、启动或三平台性能基线。此前没有运行时 SHA 绑定的摘录原样保留。
