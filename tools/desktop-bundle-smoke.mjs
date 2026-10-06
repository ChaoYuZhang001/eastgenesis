#!/usr/bin/env node
// 跨平台 bundle 产物烟测：只检查当前目标平台生成了至少一个可交付安装包，
// 不安装、不启动、不声称 WebView 或签名验收通过。
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const bundleRoot = resolve(process.argv[2] ?? "target/release/bundle");

async function filesUnder(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else files.push(path);
  }
  return files;
}

const files = await filesUnder(bundleRoot).catch((error) => {
  throw new Error(`bundle 目录不可读：${bundleRoot}（${error.message}）`);
});

const byPlatform = {
  darwin: {
    label: "macOS",
    patterns: [
      /\/macos\/EastGenesis Desktop\.app\/Contents\/Info\.plist$/i,
      /\/dmg\/EastGenesis Desktop_[^/]+\.dmg$/i,
    ],
    minimumMatches: 2,
  },
  win32: {
    label: "Windows",
    patterns: [/\/(?:msi|nsis)\/[^/]+\.(?:msi|exe)$/i, /\/(?:msi|nsis)\/[^/]+\.zip$/i],
    minimumMatches: 1,
  },
  linux: {
    label: "Linux",
    patterns: [/\/(?:appimage|deb|rpm)\/[^/]+\.(?:AppImage|deb|rpm)$/i],
    minimumMatches: 1,
  },
};

const spec = byPlatform[process.platform];
if (!spec) {
  throw new Error(`暂不支持的平台：${process.platform}`);
}

const normalized = (path) => path.replaceAll("\\", "/");
const matches = files.filter((path) => spec.patterns.some((pattern) => pattern.test(normalized(path))));
const valid = [];
for (const path of matches) {
  const info = await stat(path);
  if (info.size > 0) valid.push({ path, bytes: info.size });
}

if (valid.length < spec.minimumMatches) {
  const found = valid.map((item) => item.path).join(", ") || "无";
  throw new Error(`${spec.label} bundle 产物不足：需要至少 ${spec.minimumMatches} 个非空产物，实际 ${found}`);
}

console.log(`${spec.label} bundle smoke passed:`);
for (const item of valid) console.log(`- ${item.path} (${item.bytes} bytes)`);
