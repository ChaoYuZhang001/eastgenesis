#!/usr/bin/env node
// DecisionLayer.routeTask 真实路由与降级验证。运行：pnpm exec tsx tools/jev-route-test.mjs
// 有 Key：由 cloud-jev（第 1 级）决策。Jev 自己对某项能力把握不足（置信度 < 0.6）而交给规则引擎是设计行为，
//   会如实标出，不算失败；Jev 调用出错、或一条都没有走 cloud-jev 才算失败。
// 无 Key：必须降级到 rules（第 3 级），并列出被跳过的后端和原因。
// Key 来源同 tools/jev-smoke-test.mjs，不打印。
import { loadJevKey } from "./jev-key.mjs";
import { DecisionLayer } from "../src/decision/decision-layer.ts";

const KEY = loadJevKey();
if (KEY.length < 10) {
  console.error("没有找到 TYPESAFE_API_KEY：设置环境变量，或写进仓库根目录的 .env.local");
  process.exit(1);
}

const PROMPTS = [
  ["a", "帮我写一个快速排序"],
  ["b", "解释一下量子纠缠"],
  ["c", "你好"],
];
const CHAIN = [
  ["cloud-jev", 1],
  ["local-jev", 2],
  ["rules", 3],
];

function chainPath(meta) {
  const skipped = new Map(meta.skipped.map((s) => [s.backend, s.reason]));
  return CHAIN.map(([name, level]) => {
    if (name === meta.backend) return `${name}（第 ${level} 级）✓ 采用`;
    if (skipped.has(name)) return `${name}（第 ${level} 级）✗ ${skipped.get(name)}`;
    return `${name}（第 ${level} 级）· 未走到`;
  }).join(" → ");
}

async function run(title, env) {
  console.log(`\n=== ${title} ===`);
  const layer = DecisionLayer.fromEnv(env);
  const rows = [];
  for (const [id, text] of PROMPTS) {
    const t0 = performance.now();
    const { decision, meta } = await layer.routeTask({ text });
    const ms = performance.now() - t0;
    const c = decision.classification;
    console.log(`[${id}] "${text}"`);
    console.log(`    分类 ${c.type}　能力 ${c.capabilities.join(",")}`);
    console.log(`    决策来源 ${meta.backend}（第 ${meta.level} 级）${meta.degraded ? "已降级" : "未降级"} 置信度 ${meta.confidence.toFixed(3)} 耗时 ${ms.toFixed(0)}ms`);
    console.log(`    降级链 ${chainPath(meta)}`);
    rows.push(meta);
  }
  return rows;
}

const withKey = await run("有 Key", { TYPESAFE_API_KEY: KEY });
const noKey = await run("无 Key（TYPESAFE_API_KEY 清空）", {});
const badKey = await run("Key 无效（假 Key，服务端返回 401）", { TYPESAFE_API_KEY: "invalid-key-for-test-0000000000" });

const fromJev = withKey.filter((m) => m.backend === "cloud-jev").length;
const jevErrors = withKey.filter((m) => m.skipped.some((s) => s.reason.startsWith("调用失败"))).length;
const toRules = (rows) => rows.every((m) => m.backend === "rules" && m.level === 3 && m.degraded);
const noKeyOk = toRules(noKey);
const badKeyOk = toRules(badKey) && badKey[0].skipped.some((s) => s.reason.includes("auth"));

console.log(`\n${"─".repeat(50)}`);
console.log(`有 Key：${fromJev}/${PROMPTS.length} 条由 cloud-jev 决策，${withKey.length - fromJev} 条因 Jev 把握不足（置信度 < 0.6）交给规则引擎；Jev 调用出错 ${jevErrors} 条`);
console.log(`无 Key：${noKeyOk ? "全部降级到 rules（第 3 级）✓" : "降级结果不符合预期 ✗"}`);
console.log(`假 Key：${badKeyOk ? "鉴权失败后全部降级到 rules（第 3 级）✓" : "降级结果不符合预期 ✗"}`);
if (jevErrors > 0 || fromJev === 0 || !noKeyOk || !badKeyOk) process.exit(1);
