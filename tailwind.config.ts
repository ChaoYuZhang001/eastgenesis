import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";
import { brandTheme } from "./src/styles/brand-theme";

// 品牌部分由 scripts/brand/sync_theme.mjs 从 docs/BRAND.md 生成（src/styles/brand-theme.ts），这里不写任何色值。
// colors 直接替换而不是 extend：Tailwind 默认色板（red-500、white、black 等）不可用，只能用品牌色和语义色。
const colors = {
  inherit: "inherit",
  current: "currentColor",
  transparent: "transparent",
  ...brandTheme.colors,
  // shadcn/ui 语义色（globals.css 映射到 --eg-*）
  background: "var(--background)",
  foreground: "var(--foreground)",
  border: "var(--border)",
  input: "var(--input)",
  ring: "var(--ring)",
  primary: { DEFAULT: "var(--primary)", foreground: "var(--primary-foreground)" },
  secondary: { DEFAULT: "var(--secondary)", foreground: "var(--secondary-foreground)" },
  muted: { DEFAULT: "var(--muted)", foreground: "var(--muted-foreground)" },
  accent: { DEFAULT: "var(--accent)", foreground: "var(--accent-foreground)" },
  destructive: { DEFAULT: "var(--destructive)", foreground: "var(--destructive-foreground)" },
  card: { DEFAULT: "var(--card)", foreground: "var(--card-foreground)" },
  popover: { DEFAULT: "var(--popover)", foreground: "var(--popover-foreground)" },
};

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    colors,
    // 默认色板被移除后，这几项的默认值要显式指定
    borderColor: { ...colors, DEFAULT: "var(--border)" },
    ringColor: { ...colors, DEFAULT: "var(--ring)" },
    ringOffsetColor: { ...colors },
    extend: {
      fontFamily: { ...brandTheme.fontFamily },
      backgroundImage: { ...brandTheme.backgroundImage },
      borderRadius: { ...brandTheme.borderRadius },
      width: { ...brandTheme.width },
      height: { ...brandTheme.height },
      maxWidth: { ...brandTheme.maxWidth },
      minWidth: { ...brandTheme.minWidth },
      minHeight: { ...brandTheme.minHeight },
      boxShadow: { ...brandTheme.boxShadow },
      letterSpacing: { brand: "0.3em", "brand-wide": "0.5em" },
      keyframes: {
        "eg-breathe": { "0%, 100%": { opacity: "0.75" }, "50%": { opacity: "1" } },
      },
      animation: { "eg-breathe": "eg-breathe 2.6s ease-in-out infinite" },
    },
  },
  plugins: [animate],
} satisfies Config;
