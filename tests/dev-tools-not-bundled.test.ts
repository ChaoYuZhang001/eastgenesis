// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// .claude/skills/ 和 SKILL.md 是开发工具：进 git，但不进给最终用户的应用包。
const read = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8");
const conf = JSON.parse(read("src-tauri/tauri.conf.json"));

describe("开发工具不进应用包", () => {
  it("Tauri 打包资源里没有 .claude、skills、SKILL.md", () => {
    expect(JSON.stringify(conf.bundle?.resources ?? [])).not.toMatch(/\.claude|skills|SKILL/i);
  });

  it("应用只打包前端构建产物 ../dist，不是项目根目录", () => {
    expect(conf.build.frontendDist).toBe("../dist");
  });

  it("Vite 没有自定义 publicDir（默认只拷 public/，不会带上 .claude）", () => {
    expect(read("vite.config.ts")).not.toMatch(/publicDir/);
  });
});
