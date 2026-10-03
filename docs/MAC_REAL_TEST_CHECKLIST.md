# Mac 真实验证清单

## 前置准备

### 1. 确认工作目录
```bash
cd /Users/apple/Desktop/EastGenesis-clean
git remote -v
# 应该显示：origin  https://github.com/ChaoYuZhang001/eastgenesis.git
```

### 2. 安装依赖
```bash
# 前端依赖
pnpm install

# Rust 依赖（首次构建时自动拉取）
# 无需手动操作
```

### 3. 启动应用
```bash
pnpm tauri dev
```

### 4. 配置凭据
桌面应用只从系统钥匙串或进程环境变量读 Key，**不读 `.env.local`**。
- 推荐：启动后在「设置 → API Key」里保存 Jev 和模型 Provider 的 Key（存进钥匙串，界面只显示「已配置」）。
- 或者用环境变量启动：先 `set -a; . ./.env.local; set +a` 载入当前终端，再 `pnpm tauri dev`。变量名：Jev 是 `TYPESAFE_API_KEY`，模型是 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 等。不要把 Key 直接写在命令行里（会进 shell 历史）。
- `.env.local`（权限 600，不提交）只给命令行脚本用，例如 `node tools/jev-smoke-test.mjs 10`。

中转站 Provider 在「设置 → 自定义 Provider」里添加。配置存在应用配置目录的 `providers.json`（macOS 一般是 `~/Library/Application Support/com.eastgenesis.desktop/`），Key 只进钥匙串。

---

## 真实对话测试用例

### 用例 A：代码任务（验证 Jev 选中 code 模型）
**输入**：`帮我写一个快速排序`

**预期**：
- 路由面板显示：`决策来源：cloud-jev（第 1 级）`
- 分类：`code`
- 能力：`code, reasoning, zh`
- 置信度：> 0.6
- 耗时：首次调用 < 2s（含 Jev 决策 + 模型响应），后续 < 1s
- 回答质量：给出完整的快速排序代码（Python 或 JavaScript）

**失败反馈**：
- 如果决策来源是 `rules`：说明 Jev 被降级，记录置信度和原因
- 如果分类不是 `code`：记录实际分类和 Jev 返回的概率
- 如果耗时 > 3s：记录实际耗时，判断是 Jev 慢还是模型慢
- 如果回答质量差：记录问题（代码不完整、有错误、无法运行）

---

### 用例 B：推理任务（验证 Jev 选中 reasoning 模型）
**输入**：`12 个外观一样的球，其中一个重量不同，但不知道偏轻还是偏重。只用一台天平，最少称几次能找出它并判断轻重？讲讲算法思路，每一步怎么分组，不用写代码`

（这是标注样例 `reasoning-zh-02`，VM 上两次真实采样都判为 reasoning，置信度 0.90。「解释一下量子纠缠」这类知识讲解按标注规范属于 `qa`，不适合验证 reasoning。）

**预期**：
- 路由面板显示：`决策来源：cloud-jev（第 1 级）`
- 分类：`reasoning`
- 能力：`reasoning, zh`
- 置信度：> 0.6
- 回答质量：答出 3 次，分组思路清楚

**失败反馈**：同用例 A

---

### 用例 C：简单问候（验证快速响应）
**输入**：`你好`

**预期**：
- 路由面板显示：`决策来源：cloud-jev（第 1 级）`
- 分类：`qa`（产品里没有 `simple` 这个类型；类型只有 qa / code / reasoning / vision / long_context / tool_use）
- 能力：`zh`
- 置信度：> 0.6（这句话没有在 VM 上录制过，以实测为准）
- 耗时：记录 Jev 决策耗时和总响应时间。总响应包含模型自身的首字延迟，没有统一目标
- 回答质量：自然的问候回复

**失败反馈**：
- 如果分类错误（如分到 `code` 或 `reasoning`）：浪费了大模型资源，记录 Jev 返回的概率
- 如果明显慢：记录 Jev 决策耗时和模型耗时，判断慢在哪一段

---

### 用例 D：多步任务（验证 Agent 运行时 + MCP）
**输入**：`整理这个文件夹的 PDF，按主题分类`

**前置条件**：
- 内置文件服务器随应用自动启动，不用配置；它只能访问 `~/Downloads`
- 在 `~/Downloads` 下新建一个测试子目录（例如 `~/Downloads/eg-test-pdfs/`），放几个主题不同的 PDF 副本。不要拿真实的下载文件测试
- 输入里写明子目录，例如：`整理 Downloads/eg-test-pdfs 里的 PDF，按主题分类`

**预期**：
- 路由面板显示：`决策来源：cloud-jev（第 1 级）`
- 分类：`tool_use`（能力里同时有 code 或 reasoning 时，主类型仍按优先级取 tool_use；这句没有在 VM 上录制过）
- Agent 自动调用 MCP 工具读取文件列表
- 显示执行时间线（多步：列举文件 → 读取内容 → 分类 → 移动）
- 权限确认弹窗（移动文件时）
- 最终完成分类，给出结果

**失败反馈**：
- 如果 MCP 没被调用：说明 tool_use 分类失败或 MCP 配置有问题
- 如果任务卡住：记录卡在哪一步、错误信息
- 如果分类结果不合理：说明推理能力不足
- 如果没有权限确认：说明权限系统没生效

---

## 观察重点

### 路由面板
- 普通模式：每条回答下方一行路由摘要（用了哪个模型、耗时），点开看原因
- 专家模式（左侧边栏底部的开关）：右侧面板显示完整路由数据
- 完整路由数据包括：
  - 决策来源：`cloud-jev（第 1 级）` / `rules（第 3 级，已降级）`
  - 分类结果：type + capabilities
  - 置信度：0.00 - 1.00
  - 耗时：决策层的耗时（不含模型响应）
  - 跳过的后端（如果有降级）

### 启动页
- 品牌资产：Logo、配色、字体是否符合 `docs/BRAND.md`
- 动画流畅度：淡出是否顺滑
- 过渡时机：初始化完成就进入主界面（淡出 250ms），不人为延长

### 设置页
- Provider 列表：官方 7 家 + 自定义
- MCP：只读登记表。服务器由用户写在 `mcp.json` 里，界面不能添加或修改；每台服务器显示连接状态和最近的错误输出（已脱敏）
- 凭据管理：Key 存系统钥匙串，界面只显示「已配置 / 未配置」，不回显

### 性能
- 首次冷启动：< 5s（Tauri 启动 + React 渲染 + SQLite 初始化）
- 后续热启动：< 2s
- 任务响应：简单任务 < 1s，复杂任务视模型而定
- Jev 决策：P50 < 300ms（目标），当前 VM 实测 328ms

---

## "鸡肋"感自查

如果有以下感受，立刻反馈：

1. **路由没用上**
   - 所有任务都被降级到 `rules`，Jev 从来没被用到
   - 原因可能：Key 没配好、网络超时、置信度阈值太高

2. **快速模型不够快**
   - 简单问候 `你好` 也要等 3-5 秒
   - 原因可能：Jev 决策慢、模型选择错误、网络延迟

3. **分类不准**
   - 代码任务被分成 `reasoning`，用了慢模型
   - 简单问候被分成 `code`，浪费资源
   - 原因可能：Jev 措辞有问题、规则引擎太粗糙

4. **多步任务体验差**
   - 不知道 Agent 在干什么，黑盒等待
   - 原因可能：时间线不清晰、没有实时反馈

5. **权限弹窗烦人**
   - 同一个操作反复确认
   - 原因可能：权限缓存策略太保守

6. **UI 不够透明**
   - 不知道用了哪个模型、为什么选这个模型
   - 原因可能：路由面板信息不足、隐藏太深

7. **设置页复杂**
   - 不知道怎么配置 Provider、MCP
   - 文档和实际 UI 对不上

---

## 反馈模板

每个用例测试后，按这个格式反馈：

```
【用例 X】
输入：<你的实际输入>
决策来源：<cloud-jev / rules / ...>
分类：<code / reasoning / simple / ...>
置信度：<0.00 - 1.00>
耗时：<Jev 决策 Xms，总响应 Ys>
回答质量：<好 / 一般 / 差>
问题：<如果有>
```

---

## 常见问题

### Q1: Jev 一直被降级到 rules
- 看「设置 → API Key」里 Jev 是否显示已配置（桌面应用不读 `.env.local`）
- 路由面板的「跳过」原因会写明是没有 Key、调用失败还是置信度低于阈值
- 检查网络：`curl -I https://api.typesafe.ai`
- 查看开发者工具（Cmd+Option+I）的 Console，搜索 "Jev" 或 "降级"

### Q2: 应用启动后闪退
- 查看 Console.app（Mac 系统日志）搜索 "EastGenesis"
- 检查 SQLite 数据库 `eastgenesis.db`：在应用配置目录（macOS 一般是 `~/Library/Application Support/com.eastgenesis.desktop/`）
- 检查终端里 `pnpm tauri dev` 的输出

### Q3: MCP 工具调用失败
- 内置文件服务器不在 PATH 里：它是应用自己以 `--mcp-files` 参数启动的子进程，只能访问 `~/Downloads`
- 检查子进程是否启动：`ps aux | grep -- --mcp-files`
- 看「设置 → MCP」里该服务器的连接状态和最近的错误输出

### Q4: 性能比预期慢很多
- 首次冷启动慢是正常的（编译 Rust、初始化 SQLite）
- 如果热启动也慢，检查是否在做不必要的网络请求
- 用 Chrome DevTools Performance 录制，看卡在哪里

### Q5: 路由面板不显示
- 右侧面板只在专家模式下显示（左侧边栏底部的开关）；普通模式看回答下方的路由摘要
- 组件在 `src/components/panel/RoutePanel.tsx`，由 `src/components/panel/RightPanel.tsx` 渲染
- 查看 React DevTools，确认组件挂载了

---

## 测试完成标准

- [ ] 4 个用例全部通过（或失败原因已记录）
- [ ] 路由面板正常显示，信息完整
- [ ] 启动页、设置页无明显 bug
- [ ] 记录 Jev 决策耗时：目标 P50 < 300ms（VM 实测 328ms，未达标）
- [ ] 无"鸡肋"感，每个功能都有价值
- [ ] 所有问题已反馈，带截图或日志

其余 5 家官方适配器、记忆、技能库、多 Agent 协同和端到端测试已在 M6、M7 完成。测试通过后进入 M8–M10（项目、目标、长任务），设计见 `docs/PROJECT_GOAL_DESIGN.md`。
