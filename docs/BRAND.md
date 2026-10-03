# EastGenesis 品牌规范

> 依据：`assets/brand/brand-board.png`（品牌板，只读）。
> 素材由 `scripts/brand/` 下的脚本从品牌板自动拆分。需要调整时改脚本重新生成，不手工修图，也不改动品牌板。
> 标注「品牌板」的内容直接来自品牌板；标注「建议」的内容是品牌板没有规定、为落地补充的约定；标注「项目要求」的内容来自产品需求。

## 1. 品牌名

| 项目 | 规范 |
|---|---|
| 品牌名 | EastGenesis（E、G 大写，连写，不加空格） |
| 产品名 | EastGenesis Desktop；字标中 DESKTOP 以宽字距大写排在品牌名下方 |
| 中文名 | 品牌板没有给出中文名，不自行翻译或造词 |
| 全大写 | 只用于宽字距装饰排版，例如页脚「EASTGENESIS · DESKTOP」 |

错误写法：Eastgenesis、East Genesis、East-Genesis、EastGenesis desktop。

## 2. 标语（品牌板）

| 用途 | 中文 | 英文 |
|---|---|---|
| 主标语 | 汇天下之智 · 开创每一个可能 | The world's intelligence, in everyone's hands. |
| 辅助标语 | 一桌智能 / 创见无限 | — |
| 品牌愿景（页脚） | 开放智能，创造属于每一个人的可能 | — |
| 行动词（主视觉右上竖排） | — | CREATE / ORCHESTRATE / EMPOWER / TOGETHER |

场景文案（品牌板各场景图的说明文字）：

| 场景 | 标题 | 说明 |
|---|---|---|
| 桌面应用图标 | 桌面应用图标效果 | 简洁醒目，适配多平台 |
| 启动加载页 | 启动加载页 | 从想法，到成果 |
| 产品界面 | 产品界面效果 | 专业、现代、专注 |

排版：中文主标语在品牌板上是加宽字距排版（CSS 约 `letter-spacing: 0.3em`），用字距实现，不用空格模拟；英文主标语句首大写，句末保留句号。

## 3. 价值观（品牌板）

| 中文 | 开放 | 协同 | 高效 | 创造 |
|---|---|---|---|---|
| 英文 | Open | Orchestrate | Empower | Create |

英文不是逐字翻译，按品牌板原文成对使用，顺序固定。

## 4. 品牌色

### 4.1 主色（品牌板标注）

| 名称 | HEX | RGB | 角色 |
|---|---|---|---|
| 东方红 East Red | `#D60000` | 214, 0, 0 | 主色：标志红色弧线、主按钮、选中态、焦点描边 |
| 中国金 China Gold | `#FFC700` | 255, 199, 0 | 点缀色：标志金色弧与星芒、高亮、少量强调 |

品牌板上两个色块都是渐变，HEX 是标注的代表色。脚本沿色块逐点取样，与标注值的偏差见 4.4 节。

### 4.2 CSS 变量

代码中使用品牌色只通过下列变量。注释标记：「品牌板」为品牌板标注值；「实测」取自 4.4 节的脚本取样；「参考」取自品牌板上的样机渲染图，受透视和光照影响，有官方色值后替换；「估」为目测估计，还没有对应取样。

```css
:root {
  /* 主色（品牌板标注） */
  --eg-east-red: #D60000;
  --eg-china-gold: #FFC700;
  --eg-east-red-rgb: 214 0 0;
  --eg-china-gold-rgb: 255 199 0;

  /* 渐变 */
  --eg-gradient-icon: linear-gradient(114deg, #7C020B 0%, #1A0000 100%); /* 实测：彩色图标底色，平面拟合的近似 */
  --eg-gradient-gold: linear-gradient(90deg, #FEB003 0%, #FED43D 100%);  /* 实测：中国金色块两端 */
  --eg-gradient-sunrise: radial-gradient(120% 60% at 50% 100%,
      #FEF29E 0%, #FF8A1F 18%, var(--eg-east-red) 38%, #2A0505 72%);  /* 光心实测，其余色标估 */

  /* 深色主题：主视觉、启动页、产品界面 */
  --eg-night: #2B0000;          /* 实测：主视觉夜空（左缘中部取样），越往上越暗 */
  --eg-surface: #363134;        /* 参考：产品界面主区 */
  --eg-surface-2: #181717;      /* 参考：侧栏，比主区暗 */
  --eg-border-dark: rgb(255 255 255 / 0.10);
  --eg-text-on-dark: #FFFFFF;
  --eg-text-on-dark-muted: rgb(255 255 255 / 0.62);

  /* 浅色主题：浅色 Logo 组合区、文档 */
  --eg-paper: #F9FAFB;          /* 实测：浅色 Logo 面板 */
  --eg-ink: #060C12;            /* 实测：深色字标 */
  --eg-ink-muted: #6E6E73;      /* 估 */

  /* 交互 */
  --eg-selected-bg: rgb(var(--eg-east-red-rgb) / 0.16);
  --eg-focus-ring: 0 0 0 2px var(--eg-east-red), 0 0 0 4px var(--eg-text-on-dark-muted); /* 建议：红色描边外加浅色外圈，见 4.3 */
}
```

图标底色在品牌板上不是单纯的线性渐变：金色弧外侧有一圈红色辉光，G 的内腔更暗。`--eg-gradient-icon` 只表达左上亮、右下暗的整体走向。

### 4.3 用色规则

1. 红为主、金为辅。金色只用于星芒、高亮和细节点缀，不做大面积底色，也不做正文文字色。
2. 主按钮用东方红底配白字；悬停、按下只调明度，不换色相。
3. 选中态用 `--eg-selected-bg`（半透明东方红）配红色图标，对应品牌板产品界面中「工作台」的选中样式。
4. 品牌红和错误提示容易混淆：错误状态要配图标和文字说明，不能只靠红色区分。
5. 不引入品牌板以外的强调色。

对比度（按 WCAG 2.x 相对亮度公式计算）：

| 前景 / 背景 | 对比度 | 适用范围 |
|---|---|---|
| 东方红 / 白 | 5.44:1 | 正文可用（AA） |
| 白 / 东方红 | 5.44:1 | 正文可用（AA），主按钮文字用白色 |
| 东方红 / 黑 | 3.86:1 | 只用于大字号和图形；深色底越亮，对比度越低 |
| 中国金 / 黑 | 13.42:1 | 正文可用（AAA） |
| 中国金 / 东方红 | 3.48:1 | 只用于大字号和图形 |
| 中国金 / 白 | 1.56:1 | 不可用：浅色底上不用金色文字或细线图标 |
| 白 / `--eg-surface` | 12.76:1 | 正文可用（AAA） |
| `--eg-text-on-dark-muted` / `--eg-surface` | 5.98:1 | 正文可用（AA） |
| 中国金 / `--eg-surface` | 8.16:1 | 图形可用（如输入框的火花图标）；按第 1 条不做正文色 |
| 东方红 / `--eg-surface-2` | 3.29:1 | 只用于大字号和图形 |
| 东方红 / 侧栏选中底 | 3.06:1 | 刚过 3:1，只用于图形；选中项同时要有文字标签 |
| 东方红 / `--eg-surface` | 2.34:1 | 不足 3:1，见下文 |

侧栏选中底指 `--eg-selected-bg` 叠在 `--eg-surface-2` 上的结果。带深色表面的几行按 4.2 节的参考值计算，表面色确定后需要重算。东方红在 `--eg-surface` 上达不到 WCAG 1.4.11 要求的 3:1：主区里的红色图标、细线和焦点描边（`--eg-focus-ring`）不能只靠红色被识别，需要搭配文字、形状变化或浅色外圈等其他提示。

对比度只是无障碍的一部分，完整的合规结论需要用辅助技术做人工测试。

### 4.4 实测值（脚本生成）

以下区块由 `scripts/brand/extract_brand_assets.py` 每次运行时自动改写，请勿手工编辑。

<!-- BRAND:AUTO:START -->
> 由 `scripts/brand/extract_brand_assets.py` 于 2026-09-29 生成，请勿手改。

| 项目 | 实测 HEX | 说明 |
|---|---|---|
| 东方红 色块 | #CE0102 → #FC2B2B | 渐变；最接近标注值 #D60000 的样本为 #D30202（ΔRGB 4.1） |
| 中国金 色块 | #FEB003 → #FED43D | 渐变；最接近标注值 #FFC700 的样本为 #FDB608（ΔRGB 18.9） |
| 主视觉背景（深红夜空） | #2B0000 | 像素中位数取样 |
| 浅色面板背景 | #F9FAFB | 像素中位数取样 |
| 页面底色 | #FAFCFD | 像素中位数取样 |
| 产品界面主区背景（参考） | #363134 | 像素中位数取样 |
| 产品界面侧栏背景（参考） | #181717 | 像素中位数取样 |
| 侧栏选中项底色（参考） | #342525 | 像素中位数取样 |
| 日出高光核心 | #FEF29E | 像素中位数取样 |
| 字标墨色 | #060C12 | 像素中位数取样 |
| 标志金色（实测） | #FBB61D | 像素中位数取样 |
| 标志红色（实测） | #E2070E | 像素中位数取样 |
| 彩色图标底色（平面拟合） | #7C020B → #1A0000 | 板上彩色图标去掉标志后的底色，平面拟合（4173 个样本）；左上 → 右下 |
<!-- BRAND:AUTO:END -->

## 5. 字体（建议）

品牌板没有标注字体。以下按品牌板的字形风格给出建议；日后有官方字体规范时以官方为准。

| 用途 | 建议 | 说明 |
|---|---|---|
| 字标 EastGenesis | 不用字体重排，直接用 `assets/brand/logo/` 下的字标图片 | 品牌板字标是粗重的几何无衬线，属于图形资产 |
| 英文标题、宽字距大写 | Montserrat（600–800） | 风格接近字标；DESKTOP、页脚、行动词等大写排版用 `letter-spacing: 0.3em–0.5em` |
| 英文界面正文 | Inter；macOS 上回落到系统字体 | 小字号下可读性好 |
| 中文 | 思源黑体（Noto Sans SC）；macOS 用苹方，Windows 用微软雅黑 | 标题 Medium–Bold，正文 Regular |
| 代码、日志 | JetBrains Mono | 智能体输出、终端日志 |

```css
:root {
  --eg-font-sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI",
                  "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif;
  --eg-font-display: "Montserrat", var(--eg-font-sans);
  --eg-font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
```

授权：Inter、Montserrat、Noto Sans SC、JetBrains Mono 均为 SIL OFL 1.1，可以随应用本地打包（不从在线 CDN 加载，保证离线可用）。苹方、SF、微软雅黑是系统字体，只通过字体栈调用，不打包。

## 6. 启动页

品牌板「启动加载页 · 从想法，到成果」画面，自上而下（位置为目测比例）：

| 层 | 内容（品牌板） | 素材 |
|---|---|---|
| 背景 | 深红到近黑的夜空，越往上越暗 | `--eg-night` 纯色或渐变 |
| 标志 | 彩色 G 标志带辉光，水平居中，中心约在画面高度 32% | `logo/mark-for-dark-bg.png` |
| 字标 | 白色 EastGenesis 约在 55%–65% 高度，下方为宽字距小字 DESKTOP | `logo/wordmark-light.png` |
| 地平线 | 底部约 20% 是弧形星球地表和城市灯光；中心白金色日出光芒沿地平线向两侧散成橙红光带，光心约在 87% 高度 | `splash/splash-bg-horizon.png` |

画面里没有进度条和加载文案。完整效果见 `splash/splash-reference.png`，大尺寸主视觉见 `splash/hero-keyvisual.png`。

实现建议：

1. 光带图横向铺满、底部对齐；窗口比素材宽时居中裁切，不拉伸。拆出的光带宽约 900px，在大窗口或高分屏上会发虚，正式版建议用 `--eg-gradient-sunrise` 以 CSS 重绘，或向设计方索取高分辨率源文件。
2. 需要加载提示时，可在 DESKTOP 下方用 `--eg-text-on-dark-muted` 显示「从想法，到成果」。品牌板上这句是场景说明，不在画面内。
3. 动效只做辉光和光带的缓慢呼吸（周期 2–3 秒）；系统开启「减少动态效果」（`prefers-reduced-motion`）时关闭。
4. 启动页只在初始化期间显示，完成后约 250ms 淡出，不为展示品牌人为延长。Tauri 中可用独立的 splashscreen 窗口，主窗口就绪后关闭它。

## 7. 界面布局参考

品牌板「产品界面效果 · 专业、现代、专注」，见 `ui-reference/product-ui.png`。

深色主题窗口，左上角是 macOS 红黄绿窗口按钮。左侧为固定宽度侧栏（品牌板画面右侧被裁切，比例无法确定，建议 220–240px），顶部是小号组合标志（G 标志 + EastGenesis + DESKTOP），下方为导航：

| 导航项 | 图标（目测） | 状态 |
|---|---|---|
| 工作台 | 房子 | 选中：红色图标、半透明红色圆角底 |
| 智能体 | 六边形 | 默认 |
| 模型与路由 | 立方体 | 默认 |
| 系统与工具 | 交叉的工具 | 默认 |

主区左上是两行大字问候「你好，」「今天想创造什么？」；下方是圆角任务输入框：暗红描边，左侧金色火花图标，占位文字「描述你的任务，或选择一个智能体...」。

实现建议：

1. 侧栏与主区用两级深色表面区分（`--eg-surface-2`、`--eg-surface`），不用高饱和底色。
2. 选中态用 `--eg-selected-bg` 加红色图标；输入框默认描边为低透明度东方红，聚焦时用 `--eg-focus-ring`。
3. 金色只出现在火花图标这类小元素上。
4. 应用显示名用「EastGenesis Desktop」（品牌板 Dock 提示框），对应 `tauri.conf.json` 的 `productName`；Dock 中使用彩色图标，效果见 `ui-reference/dock-preview.png`。

### 7.1 布局变量（建议）

品牌板没有标注尺寸，以下为建议值（M5 产品需求给定）。Tailwind 主题由 `scripts/brand/sync_theme.mjs` 从本节和 4.2、5 节生成，代码里只用生成的类名（如 `w-sidebar`、`h-input`、`rounded-lg`）。

```css
:root {
  --eg-sidebar-width: 240px;   /* 建议：左侧边栏 */
  --eg-panel-width: 320px;     /* 建议：右侧时间线与路由面板，可折叠 */
  --eg-input-height: 56px;     /* 建议：任务输入框 */
  --eg-radius-lg: 12px;        /* 建议：输入框、卡片 */
  --eg-radius-md: 8px;         /* 建议：按钮、导航项 */
  --eg-radius-sm: 6px;         /* 建议：标签、小控件 */
  --eg-space-unit: 4px;        /* 建议：间距基数，与 Tailwind 默认刻度一致（p-1 = 4px） */
}
```

间距只用 4px 的整数倍（Tailwind 默认刻度），不写任意像素值。

## 8. Logo 使用规则

### 8.1 按背景选版本

| 背景 | 组合 Logo | 单独标志 | 字标 |
|---|---|---|---|
| 白、浅灰等浅色底 | `logo/logo-light-transparent.png` | `logo/mark-color.png` | `logo/wordmark-dark.png` |
| 黑、夜空深红等深色底 | `logo/logo-dark-transparent.png` | `logo/mark-for-dark-bg.png` | `logo/wordmark-light.png` |
| 东方红等彩色底，或深色底单色场景 | — | `logo/mark-mono-white.png` | `logo/wordmark-light.png` |
| 浅色底单色场景（打印、菜单栏模板图标） | — | `logo/mark-mono.png` | `logo/wordmark-dark.png` |

路径相对 `assets/brand/`。

### 8.2 规则

1. 带辉光的 `mark-for-dark-bg.png`、`logo-dark-transparent.png` 只用于深色背景。辉光是从深色底上抠出的半透明像素，放到浅色底上会变成脏边。
2. 安全区（建议）：组合 Logo 四周留白不小于字标大写 E 的高度；单独标志四周不小于标志宽度的 1/4。品牌板没有规定安全区。
3. 最小尺寸（建议）：组合 Logo 显示宽度不小于 160px，再小 DESKTOP 小字就难以辨认，应改用单独标志。32px 及以下用应用图标形态（带圆角底），品牌板「最小尺寸效果」展示到 16px。
4. 不拉伸或压扁，不旋转，不改色或重新配色，不加描边、投影或外发光（深色版自带的辉光除外），不改变标志与字标的相对大小和位置，不用字体重新输入字标。
5. 不把彩色标志放在接近东方红的底色或杂乱照片上，这类背景用白色单色标志。
6. 应用图标默认用彩色版（品牌板标注「推荐」）；深色、浅色、单色版用于系统主题适配和单色场景。
7. 应用图标一律从 `icons/icon-1024.png` 派生（满版场景用 `icons/icon-1024-fullbleed.png`），不放大品牌板上约 100px 的小图标。`icons/icon-{color,dark,light,mono}.png` 只作各版本的外观参考。
8. 单色标志取自品牌板上的小图标，分辨率有限，只适合托盘、菜单栏等小尺寸；大尺寸的单色需求需要矢量源文件。

## 9. 素材清单

路径相对 `assets/brand/`。`platform-icons.json` 由 `gen_platform_icons.py` 生成，`verify/` 由 `verify_brand_assets.py` 生成，其余均由 `extract_brand_assets.py` 生成。每个文件的尺寸、用途和来源坐标都记录在 `manifest.json`。

| 文件 | 用途 |
|---|---|
| `logo/logo-light.png` | 浅色组合 Logo，保留品牌板浅色底 |
| `logo/logo-light-transparent.png` | 浅色组合 Logo 透明版，用于浅色背景 |
| `logo/mark-color.png` | 彩色标志透明版，用于浅色背景 |
| `logo/wordmark-dark.png` | 深色字标（EastGenesis DESKTOP），用于浅色背景 |
| `logo/logo-dark.png` | 深色组合 Logo，保留品牌板夜空底和中英文标语 |
| `logo/logo-dark-transparent.png` | 深色组合 Logo 透明版，只用于深色背景 |
| `logo/mark-for-dark-bg.png` | 带辉光的彩色标志透明版，只用于深色背景 |
| `logo/wordmark-light.png` | 白色字标，用于深色背景 |
| `logo/mark-mono.png` | 单色（黑）标志透明版 |
| `logo/mark-mono-white.png` | 单色（白）标志透明版，用于深色或彩色背景 |
| `icons/board-crops/icon-*-raw.png` | 品牌板上 4 款图标的原样裁切（带板面底色） |
| `icons/icon-{color,dark,light,mono}.png` | 4 款图标的圆角透明版（品牌板分辨率） |
| `icons/icon-1024.png` | 应用图标母版，四周按 macOS 网格留 100px 透明边，作为 `tauri icon` 的输入 |
| `icons/icon-1024-fullbleed.png` | 满版图标母版（无留白），用于 Web、文档和小尺寸派生 |
| `app-icons/icon-{512,256,128,64,32,24,16}.png` | 由满版母版缩小得到的各尺寸图标 |
| `app-icons/board-preview-{64,32,24,16}.png` | 品牌板「最小尺寸效果」原样裁切，用于对照 |
| `splash/hero-keyvisual.png` | 主视觉 Key Visual（夜空、日出、Logo、标语） |
| `splash/splash-bg-horizon.png` | 启动页背景：无文字的地平线日出光带 |
| `splash/splash-reference.png` | 启动加载页效果参考图 |
| `ui-reference/dock-preview.png` | 桌面 Dock 图标效果参考图 |
| `ui-reference/product-ui.png` | 产品界面效果参考图 |
| `colors/swatch-east-red.png`、`colors/swatch-china-gold.png` | 品牌色块截取 |
| `colors/colors.json` | 标注色、色块取样、偏差和其他取样色 |
| `manifest.json` | 全部输出、区域坐标、原图 SHA-256 和处理日志 |
| `platform-icons.json` | 各平台图标的生成方式和文件清单 |
| `verify/report.json`、`verify/contact-sheet.png` | 自检结果和目检拼图（每个素材各有浅底、深底缩略图） |

`src-tauri/icons/`（相对项目根目录）由 `gen_platform_icons.py` 生成，包括 `32x32.png`、`64x64.png`、`128x128.png`、`128x128@2x.png`、`icon.png`、`icon.ico`、`icon.icns`，以及 Windows 磁贴 `Square*Logo.png` 和 `StoreLogo.png`。`tauri icon`（2.5.0）还会生成移动端的 `android/`、`ios/` 目录，见第 10 节第 3 条；完整清单见 `platform-icons.json`。

## 10. 各平台应用图标

`scripts/brand/gen_platform_icons.py` 以 `icons/icon-1024.png` 为输入执行 `tauri icon`，依次尝试本机 `tauri`、`cargo tauri` 和 `npx --yes @tauri-apps/cli@2.5.0`（固定版本，需要联网临时下载）。三者都不可用或都执行失败时，改用 Pillow 按 `tauri icon` 的文件名和尺寸生成；兜底只生成桌面端文件，ICNS 能否写出取决于 Pillow 版本。实际用了哪种方式记录在 `platform-icons.json`。

取舍说明：

1. 母版四周按 macOS 图标网格留了 100px 透明边（本体 824px），在 macOS Dock 中与系统图标视觉大小一致。Windows、Linux 图标通常占满画布，同一母版在这两个平台上会显得偏小。`tauri icon` 用一张图生成全部平台的图标，要兼顾两边，需要再用 `icons/icon-1024-fullbleed.png` 生成一次，替换 Windows、Linux 用到的文件。目前统一用留白版。
2. 母版不是放大品牌板上约 100px 的小图标得来的。标志用主视觉里约 200px 的标志，按彩色图标里的比例和位置合成；主视觉标志是连同辉光一起抠出的，合成后周围留有少量辉光。底色的做法：把主视觉标志按同样位置放进品牌板彩色图标，去掉标志覆盖的像素，对剩下的底色做平面拟合（稳健回归），结果是左上亮、右下暗。品牌板图标金色弧外侧的红色辉光和 G 内腔的暗部，平面底色表达不了；自检把母版缩到品牌板尺寸逐像素比较，平均差值记在 `verify/report.json`。精度仍受品牌板分辨率限制，正式发布前建议用矢量源文件重做母版。
3. `tauri icon` 还会生成 `android/`、`ios/` 目录。本项目是桌面应用，用不到这两套，它们也不符合移动端规范：iOS 图标不能带透明，CLI 按 `--ios-color` 的默认值（白色）填充母版的透明边，图标四周会出现白边；Android 的 `ic_launcher_foreground.png` 带着完整的圆角底，不是自适应图标要求的单独前景层。以后做移动端时，应以满版母版为输入，并单独设计自适应图标的前景层和背景层。

## 11. 重新生成与自检

在项目根目录依次运行。至少需要 Python 3 和 Pillow；装有 Tauri CLI 或 Node 时，平台图标优先用 `tauri icon` 生成。三个脚本都不修改品牌板。

```bash
python3 scripts/brand/extract_brand_assets.py   # 识别、裁剪、抠图、取色，回填 4.4 节
python3 scripts/brand/gen_platform_icons.py     # 生成 src-tauri/icons/
python3 scripts/brand/verify_brand_assets.py    # 自检；有「失败」项时退出码为 1，「警告」不影响
```

自检项目：

- 品牌板 SHA-256 未变，清单文件齐全且尺寸一致；区域定位出现贴边或兜底时给出警告，提示人工复核。
- 透明 Logo 外圈近乎全透明（alpha 不超过 16），说明没被裁断；带底色的组合外圈是纯底色。
- 字标 i 上的金点在深、浅两版字标里都保留下来；透明 Logo 没有夜空星点留下的孤立噪点。
- 图标方正，圆角外透明，字形居中。
- icon-1024 留白和标志位置正确；标志比例只作参考，有偏差时给出警告；缩到品牌板尺寸后，与板上彩色图标的平均像素差不超过 25。
- 主视觉边界准确，光带顶部没有文字残留。
- 色块渐变上最接近标注值的取样点，与标注值相差不超过 ΔRGB 30。
- 各平台图标齐全，且由母版派生。
- 生成的 JSON 和文档中没有本机绝对路径。

`verify/contact-sheet.png` 把每个素材分别放在浅底和深底上，供人工目检边缘和居中。自检只能发现已知类型的问题，改动抠图或取色逻辑后仍要放大目检。

修改本文档里的 CSS 变量后，运行 `pnpm brand:theme` 重新生成 `src/styles/brand-tokens.css` 和 `src/styles/brand-theme.ts`（`pnpm build` 会自动运行）。`tests/brand-theme.test.ts` 检查生成文件与本文档一致、代码里引用的变量都有定义，并拦截 HEX、数值 rgb()/hsl()、Tailwind 默认色板和黑白类名。Tailwind 配置直接替换了 `colors`，默认色板不可用。

## 12. 界面设计原则（项目要求）

品牌板只规定了视觉。下面三条来自产品需求，决定界面上放什么、先放什么，优先级依次递减；与第 4–8 节冲突时，以第 4–8 节的视觉规定为准。

1. 透明度优先。应用替用户做的每个决定都要看得到：选了哪个模型、调了哪个工具、为什么失败、换成了谁。执行时间线（`panel/Timeline.tsx`）逐步列出决策，带成本档、tokens 和耗时；降级的那一步标成提醒，写明先试了谁、原因。有副作用的工具先停下来请用户确认（`task/ConfirmPrompt.tsx`），列出工具、风险、步骤、原因和已脱敏的参数。密钥只显示来源（环境变量、系统钥匙串），不回显内容。失败原因用中文说明，不只给错误码，也不藏起来。
2. 成果驱动。界面围绕交付物组织，不围绕对话。每个任务是一张卡片（`task/TaskCard.tsx`）：计划进度、权限确认和最终成果都在卡片里，成果单独成块、标明「成果」，逐步的过程信息放在右侧面板。状态一律图标形状加文字（`task/status.tsx`），不靠颜色区分，成功态不引入绿色（4.3 节）。完成的任务可以保存为技能，下次规划时参考。文案先说结果，例如「已写入 3 个文件」，不写「处理完成」这类空话。
3. 路由可视化。多模型中立是产品的核心，选模型的过程必须摊开。路由面板（`panel/RoutePanel.tsx`）显示任务类型和置信度、能力匹配、质量、成本、延迟四项权重、首选、备选、兜底组成的降级链、被排除的模型及原因，以及做决策的是哪一级后端（云端 Jev、本地决策模型、规则引擎）。用户可以手动干预（`panel/Intervention.tsx`）：只改下一次调用，或整个任务锁定一个模型；锁定后不再自动降级，界面要写明这一点。

落地约定：

- 三条原则都不引入新颜色。提醒、错误、确认沿用第 4 节的变量，金色仍只用于小元素。
- 过程信息默认可见，但不抢成果的位置：放在回答下方的折叠行和浮层，主区留给对话和成果。
- 降级链、时间线靠文字和图标表达层级和先后，色觉障碍用户也能读懂。
