# CLAUDE.md · EastGenesis Desktop

在本仓库工作时必须遵守以下规则。品牌细节以 `docs/BRAND.md` 为准，任务进度记在 `docs/TASKS.md`。

## 项目

- EastGenesis Desktop：基于 Tauri 的桌面应用。
- 工作语言：简体中文，包括文档、提交说明、界面文案和报告。
- 用户授权完全自主执行：命令由 Claude 自己运行、自己验证，不要求用户手动执行。

## 品牌规范纪律

1. 品牌板 `assets/brand/brand-board.png` 只读：不修改、不覆盖、不移动、不重新压缩。脚本在处理前后各计算一次它的 SHA-256，记录在 `assets/brand/manifest.json`，由自检脚本比对。
2. 品牌素材只从 `assets/brand/` 取用。不临时截图，不从网上找替代图，不自行重绘 Logo。
3. 素材需要调整时，改 `scripts/brand/` 下的脚本后重新生成，不手工修图。依次运行 `extract_brand_assets.py`、`gen_platform_icons.py`、`verify_brand_assets.py`，自检没有「失败」项才算完成。
4. 颜色只用 `docs/BRAND.md` 定义的 CSS 变量（`--eg-*`）。代码里不硬编码品牌色 HEX，不引入品牌板以外的强调色。
5. 红为主、金为辅：金色不做大面积底色。文字配色遵守 `docs/BRAND.md` 4.3 节的对比度表，例如浅色底上不用金色文字。
6. Logo 按背景选版本：浅色底用 `mark-color`、`logo-light-transparent`；深色底用 `mark-for-dark-bg`、`logo-dark-transparent`；彩色底用 `mark-mono-white`。不拉伸、不旋转、不改色、不加特效，不用字体重打字标。
7. 应用图标只从 `assets/brand/icons/icon-1024.png` 经 `scripts/brand/gen_platform_icons.py` 生成到 `src-tauri/icons/`。不放大品牌板上的小图标，不手改 `src-tauri/icons/` 下的文件。
8. 品牌名写作 EastGenesis / EastGenesis Desktop。品牌板没有中文名，不自行翻译。标语和价值观按 `docs/BRAND.md` 原文使用，不改写。
9. 字体按 `docs/BRAND.md` 第 5 节：只打包 SIL OFL 等允许再分发的字体，系统字体只通过字体栈调用。
10. 品牌板没有规定的内容（字体、安全区、最小尺寸、估计色值等）在文档中标注「建议」或「估」，有实测值或官方规范后再更新。

## 工作纪律

- 每完成一步更新 `docs/TASKS.md`，包括状态表和日志。
- 不执行 `rm`、`git push` 等危险或不可逆命令。确实需要删除文件或推送时，先说明影响，征得用户同意。
- 生成的文档和 JSON 只写相对路径，不写本机绝对路径。
- 外部依赖固定版本（例如 `@tauri-apps/cli@2.5.0`），不用浮动版本。
- 声称「已验证」之前，必须实际运行过对应的脚本或检查；无法运行时如实说明。
