// 品牌素材唯一入口：只从 assets/brand/ 取用（CLAUDE.md 品牌纪律 2、6）。
// 本应用是深色主题，所以默认使用深色底版本。
import markForDarkBg from "@brand/logo/mark-for-dark-bg.png";
import wordmarkLight from "@brand/logo/wordmark-light.png";
import logoDarkTransparent from "@brand/logo/logo-dark-transparent.png";
import splashHorizon from "@brand/splash/splash-bg-horizon.png";

export const brand = {
  name: "EastGenesis",
  product: "EastGenesis Desktop",
  slogan: { zh: "汇天下之智 · 开创每一个可能", en: "The world's intelligence, in everyone's hands." },
  splashCaption: "从想法，到成果",
  assets: { markForDarkBg, wordmarkLight, logoDarkTransparent, splashHorizon },
} as const;
