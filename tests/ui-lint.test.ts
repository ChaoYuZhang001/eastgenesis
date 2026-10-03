// 布局规范静态检查：间距只用 4px 的整数倍、圆角只用品牌变量、任意值必须登记（BRAND.md 7.1）
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(__dirname, "..");
function tsx(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".tsx")) out.push({ file: relative(root, p), text: readFileSync(p, "utf8") });
    }
  };
  walk(join(root, "src"));
  return out;
}

// 类名边界：前面是空白、引号、反引号或变体冒号
const B = String.raw`(?<=[\s"'\`:])`;
const E = String.raw`(?=[\s"'\`]|$)`;
// 长的写在前面：否则 gap-x-3 会被当成 gap 加值 x-3
const SPACING = new RegExp(`${B}-?(?:gap-x|gap-y|gap|space-x|space-y|px|py|pt|pb|pl|pr|ps|pe|p|mx|my|mt|mb|ml|mr|ms|me|m)-([^\\s"'\`]+)${E}`, "g");
const ROUNDED = new RegExp(`${B}rounded(?:-[a-z0-9]+)*${E}`, "g");
const ARBITRARY = new RegExp(`${B}(?:[a-z-]+:)*[a-z][a-z0-9-]*-\\[[^\\]\\s]+\\]${E}`, "g");

/** 登记过的任意值：启动页按 BRAND.md 第 6 节的版式比例定位；网格模板和过渡属性不涉及尺寸与颜色 */
const ARBITRARY_ALLOWED = new Set([
  "top-[32%]",
  "top-[55%]",
  "w-[min(22vw,180px)]",
  "w-[min(40vw,360px)]",
  "grid-cols-[auto_1fr]",
  // 首屏输入框落在视觉 40%：上 2 份、下 3 份
  "grid-rows-[2fr_auto_3fr]",
  // 用户那句话的气泡不占满整行
  "max-w-[80%]",
  "transition-[filter,background-color]",
  // 图标栏宽 60（docs/UI_LAYOUT_V3.md 第 10 节第 1 条：不在 Tailwind 刻度上，登记为任意值，不改 BRAND.md）
  "w-[60px]",
  // 回答下方的路由浮层最高为视口的 60%，超出内部滚动（V3 5.2）
  "max-h-[60vh]",
]);
const ROUNDED_ALLOWED = /^rounded(?:-(?:t|b|l|r|s|e|tl|tr|bl|br))?-(?:sm|md|lg|full|none)$/;

describe("布局规范（BRAND.md 7.1）", () => {
  const files = tsx();

  it("间距只用 Tailwind 默认刻度的整数档（4px 的整数倍）", () => {
    const bad = files.flatMap(({ file, text }) => [...text.matchAll(SPACING)].filter((m) => !/^(\d+|auto)$/.test(m[1])).map((m) => `${file}: ${m[0]}`));
    expect(bad).toEqual([]);
  });

  it("圆角只用 rounded-sm/md/lg（品牌变量）", () => {
    const bad = files.flatMap(({ file, text }) => (text.match(ROUNDED) ?? []).filter((c) => !ROUNDED_ALLOWED.test(c)).map((c) => `${file}: ${c}`));
    expect(bad).toEqual([]);
  });

  it("任意值类名必须登记", () => {
    const bad = files.flatMap(({ file, text }) => (text.match(ARBITRARY) ?? []).filter((c) => !ARBITRARY_ALLOWED.has(c.replace(/^(?:[a-z-]+:)+/, ""))).map((c) => `${file}: ${c}`));
    expect(bad).toEqual([]);
  });

  it("检查规则本身有效", () => {
    const sample = ` "px-3 py-0.5 mt-[3px] gap-px gap-x-3 -mb-1 rounded rounded-xl rounded-lg hover:w-[13px] top-[32%]" `;
    expect([...sample.matchAll(SPACING)].map((m) => m[1])).toEqual(["3", "0.5", "[3px]", "px", "3", "1"]);
    expect((sample.match(ROUNDED) ?? []).filter((c) => !ROUNDED_ALLOWED.test(c))).toEqual(["rounded", "rounded-xl"]);
    expect(sample.match(ARBITRARY)).toEqual(["mt-[3px]", "hover:w-[13px]", "top-[32%]"]);
  });
});
