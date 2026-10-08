import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { buildTheme, extractTokens, renderCss, renderTheme } from "../scripts/brand/sync_theme.mjs";
import tailwindConfig from "../tailwind.config";

const root = resolve(__dirname, "..");
const brandMd = readFileSync(join(root, "docs/BRAND.md"), "utf8");
const tokens = extractTokens(brandMd);
const byName = Object.fromEntries(tokens.map((t) => [t.name, t.value]));
const lf = (text: string) => text.replaceAll("\r\n", "\n");

/** src/ 下的源码（不含生成的 brand-tokens.css），外加 index.html 和 tailwind.config.ts */
function sources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx?|css)$/.test(name) && name !== "brand-tokens.css") out.push({ file: relative(root, p), text: readFileSync(p, "utf8") });
    }
  };
  walk(join(root, "src"));
  for (const f of ["index.html", "tailwind.config.ts"]) out.push({ file: f, text: readFileSync(join(root, f), "utf8") });
  return out;
}

function offenders(re: RegExp, prep: (line: string) => string = (l) => l): string[] {
  const hits: string[] = [];
  for (const { file, text } of sources()) {
    text.split("\n").forEach((line, i) => {
      const m = prep(line).match(re);
      if (m) hits.push(`${file}:${i + 1} ${m[0]}`);
    });
  }
  return hits;
}

describe("品牌主题：与 BRAND.md 一致", () => {
  it("解析出主色、字体和布局变量", () => {
    expect(byName["--eg-east-red"]).toBe("#D60000");
    expect(byName["--eg-china-gold"]).toBe("#FFC700");
    expect(byName["--eg-east-red-rgb"]).toBe("214 0 0");
    expect(byName["--eg-font-sans"]).toContain("Inter");
    expect(byName["--eg-gradient-sunrise"]).toMatch(/^radial-gradient\(/);
    expect(byName["--eg-sidebar-width"]).toBe("240px");
    expect(byName["--eg-panel-width"]).toBe("320px");
    expect(byName["--eg-input-height"]).toBe("56px");
    expect(byName["--eg-radius-lg"]).toBe("12px");
  });

  it("生成的 brand-tokens.css、brand-theme.ts 与 BRAND.md 同步", () => {
    // Windows Git checkouts may materialize tracked text as CRLF; generated
    // output intentionally uses LF so the semantic content is portable.
    expect(lf(readFileSync(join(root, "src/styles/brand-tokens.css"), "utf8"))).toBe(renderCss(tokens));
    expect(lf(readFileSync(join(root, "src/styles/brand-theme.ts"), "utf8"))).toBe(renderTheme(tokens));
  });

  it("Tailwind 主题使用生成结果：品牌色可带透明度，尺寸与圆角来自变量", () => {
    const theme = buildTheme(tokens);
    const t = tailwindConfig.theme as Record<string, any>;
    expect(t.colors["east-red"]).toBe("rgb(var(--eg-east-red-rgb) / <alpha-value>)");
    expect(t.extend.width.sidebar).toBe("var(--eg-sidebar-width)");
    expect(t.extend.height.input).toBe("var(--eg-input-height)");
    expect(t.extend.borderRadius).toEqual(theme.borderRadius);
    expect(t.extend.fontFamily).toEqual(theme.fontFamily);
  });

  it("Tailwind 默认色板不可用：颜色只有品牌色和语义色", () => {
    const keys = Object.keys((tailwindConfig.theme as Record<string, any>).colors);
    const allowed = new Set([...Object.keys(buildTheme(tokens).colors), "inherit", "current", "transparent", "background", "foreground", "border", "input", "ring", "primary", "secondary", "muted", "accent", "destructive", "card", "popover"]);
    expect(keys.filter((k) => !allowed.has(k))).toEqual([]);
    for (const k of ["red", "gray", "white", "black", "blue", "yellow"]) expect(keys).not.toContain(k);
  });

  it("代码里引用的每个 --eg-* 变量都在 BRAND.md 中定义", () => {
    const missing = sources().flatMap(({ file, text }) =>
      [...text.matchAll(/var\((--eg-[a-z0-9-]+)\)/g)].map((m) => m[1]).filter((n) => !(n in byName)).map((n) => `${file} ${n}`),
    );
    expect(missing).toEqual([]);
  });
});

describe("品牌主题：拦截硬编码颜色", () => {
  // 私有字段（#name、this.#name）不是颜色，先去掉再检查
  const stripPrivate = (l: string) => l.replace(/(?:\.|^\s*(?:(?:readonly|static|async|get|set)\s+)*)#[A-Za-z_]\w*/g, "");

  it("不写 HEX 颜色", () => {
    expect(offenders(/(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/, stripPrivate)).toEqual([]);
  });

  it("不写数值形式的 rgb()/hsl()（通过 var(--eg-*-rgb) 引用的除外）", () => {
    expect(offenders(/\b(?:rgba?|hsla?)\(\s*[\d.]/)).toEqual([]);
  });

  it("不用 Tailwind 默认色板和黑白类名", () => {
    const palette = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
    const prefix = "bg|text|border|ring|ring-offset|fill|stroke|from|via|to|outline|divide|placeholder|caret|accent|decoration|shadow";
    expect(offenders(new RegExp(`\\b(?:${prefix})-(?:(?:${palette})-\\d{2,3}|white|black)\\b`))).toEqual([]);
  });

  it("检测规则本身有效（防止正则失效后测试空转）", () => {
    const hex = /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/;
    expect(hex.test('color: "#D60000"')).toBe(true);
    expect(hex.test("bg-[#fff]")).toBe(true);
    expect(hex.test(stripPrivate("  readonly #add = 1;"))).toBe(false);
    expect(hex.test(stripPrivate("this.#fade()"))).toBe(false);
  });
});
