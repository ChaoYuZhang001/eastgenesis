// 从 docs/BRAND.md 中的 CSS 代码块提取 --eg-* 变量，生成：
//   src/styles/brand-tokens.css —— 变量本身（品牌色 HEX 只允许出现在 BRAND.md 与这个文件里）
//   src/styles/brand-theme.ts   —— Tailwind 主题（只引用 var(--eg-*)），由 tailwind.config.ts 使用
// 用法：node scripts/brand/sync_theme.mjs [--check]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BRAND_MD = resolve(root, "docs/BRAND.md");
const OUT_CSS = resolve(root, "src/styles/brand-tokens.css");
const OUT_TS = resolve(root, "src/styles/brand-theme.ts");

/** 解析 BRAND.md 中所有 ```css 代码块里的 --eg-* 声明，保持出现顺序 */
export function extractTokens(markdown) {
  const tokens = [];
  const seen = new Set();
  const blockRe = /```css\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = blockRe.exec(markdown))) {
    // 去掉注释后按分号切分，支持跨行的值（渐变、字体栈）
    const body = m[1].replace(/\/\*[\s\S]*?\*\//g, "");
    const declRe = /(--eg-[a-z0-9-]+)\s*:\s*([^;]+);/g;
    let d;
    while ((d = declRe.exec(body))) {
      const name = d[1];
      const value = d[2].replace(/\s+/g, " ").trim();
      if (seen.has(name)) throw new Error(`BRAND.md 中重复定义了 ${name}`);
      seen.add(name);
      tokens.push({ name, value });
    }
  }
  if (tokens.length === 0) throw new Error("BRAND.md 中没有找到 --eg-* 变量");
  return tokens;
}

export function renderCss(tokens) {
  const lines = tokens.map((t) => `  ${t.name}: ${t.value};`);
  return ["/* 由 scripts/brand/sync_theme.mjs 从 docs/BRAND.md 生成，请勿手改。 */", ":root {", ...lines, "}", ""].join("\n");
}

const COLOR_VALUE = /^(#[0-9a-fA-F]{3,8}|rgba?\(.+\)|hsla?\(.+\)|var\(--eg-[a-z0-9-]+\))$/;
const LAYOUT = { "sidebar-width": ["width", "sidebar"], "panel-width": ["width", "panel"], "input-height": ["height", "input"] };

/** 按变量名把 token 归到 Tailwind 主题的某一类；无法归类时报错，避免新变量被悄悄忽略 */
export function classify(t, names) {
  const n = t.name.slice("--eg-".length);
  if (n.endsWith("-rgb")) return null; // 通道值，供带透明度的颜色使用
  if (n === "space-unit") return null; // 间距沿用 Tailwind 默认 4px 刻度，这里只作文档
  if (n.startsWith("gradient-")) return ["backgroundImage", `eg-${n.slice("gradient-".length)}`];
  if (n.startsWith("font-")) return ["fontFamily", n.slice("font-".length)];
  if (n.startsWith("radius-")) return ["borderRadius", n.slice("radius-".length)];
  if (n in LAYOUT) return LAYOUT[n];
  if (n.endsWith("-ring")) return ["boxShadow", n];
  if (COLOR_VALUE.test(t.value)) return ["colors", n, names.has(`${t.name}-rgb`)];
  throw new Error(`无法归类的品牌变量 ${t.name}，请在 sync_theme.mjs 中补充规则`);
}

export function buildTheme(tokens) {
  const names = new Set(tokens.map((t) => t.name));
  const theme = { colors: {}, backgroundImage: {}, fontFamily: {}, borderRadius: {}, width: {}, height: {}, boxShadow: {} };
  for (const t of tokens) {
    const c = classify(t, names);
    if (!c) continue;
    const [group, key, alpha] = c;
    theme[group][key] = alpha ? `rgb(var(${t.name}-rgb) / <alpha-value>)` : `var(${t.name})`;
  }
  // 侧栏、面板宽度也用于 max-width / min-width；输入框高度也用于 min-height
  theme.maxWidth = { ...theme.width };
  theme.minWidth = { ...theme.width };
  theme.minHeight = { ...theme.height };
  return theme;
}

export function renderTheme(tokens) {
  return [
    "// 由 scripts/brand/sync_theme.mjs 从 docs/BRAND.md 生成，请勿手改。",
    "// 只引用 var(--eg-*)，变量值见 brand-tokens.css。",
    `export const brandTheme = ${JSON.stringify(buildTheme(tokens), null, 2)} as const;`,
    "",
  ].join("\n");
}

function main() {
  const tokens = extractTokens(readFileSync(BRAND_MD, "utf8"));
  const outputs = [
    [OUT_CSS, renderCss(tokens), "src/styles/brand-tokens.css"],
    [OUT_TS, renderTheme(tokens), "src/styles/brand-theme.ts"],
  ];
  const check = process.argv.includes("--check");
  let stale = false;
  for (const [path, content, label] of outputs) {
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (current === content) continue;
    if (check) {
      console.error(`${label} 与 docs/BRAND.md 不一致，请运行 pnpm brand:theme`);
      stale = true;
    } else {
      writeFileSync(path, content);
    }
  }
  if (check) {
    if (stale) process.exit(1);
    console.log("品牌变量与 BRAND.md 一致");
    return;
  }
  console.log(`已生成品牌变量与 Tailwind 主题（${tokens.length} 个变量）`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
