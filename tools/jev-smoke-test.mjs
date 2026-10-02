#!/usr/bin/env node
// Jev API 冒烟测试：真实调用 TypeSafe SystemOne 的 choice 接口，记录返回、置信度、耗时，并算 P50。
// 用法：node tools/jev-smoke-test.mjs [轮数，默认 1]
// Key：环境变量 TYPESAFE_API_KEY，其次是仓库根目录的 .env.local（已在 .gitignore）。不打印 Key，错误信息会抹掉 Key。
import { loadJevKey, redactor } from "./jev-key.mjs";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const P50_TARGET_MS = 300;

const KEY = loadJevKey();
const redact = redactor(KEY);

const CASES = [
  {
    id: "a",
    question: "帮我写一个快速排序",
    expected: "code",
    criteria: { code: "This is a coding task", reasoning: "This requires complex reasoning", simple: "This is a simple question or greeting" },
  },
  {
    id: "b",
    question: "解释一下量子纠缠",
    expected: "reasoning",
    criteria: { code: "This is a coding task", reasoning: "This requires complex reasoning or explanation", simple: "This is a simple question or greeting" },
  },
  {
    id: "c",
    question: "你好",
    expected: "simple",
    criteria: { code: "This is a coding task", reasoning: "This requires complex reasoning", simple: "This is a simple question or greeting" },
  },
];

async function callJev({ question, criteria }) {
  const t0 = performance.now();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: "jev-latest", state: { question }, questions: { taskType: { type: "choice", criteria } } }),
    signal: AbortSignal.timeout(10_000),
  });
  const ms = performance.now() - t0;
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${redact(await res.text()).slice(0, 200)}`);
  const answer = (await res.json()).answers.taskType;
  return { choice: answer.choice, confidence: answer.confidence, ms };
}

/** 最近排名法：n 个样本取排序后第 ceil(p·n) 个 */
const percentile = (xs, p) => [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil((p / 100) * xs.length) - 1)];

async function main() {
  if (KEY.length < 10) {
    console.error("没有找到 TYPESAFE_API_KEY：设置环境变量，或写进仓库根目录的 .env.local");
    process.exit(1);
  }
  const rounds = Math.max(1, Number(process.argv[2]) || 1);
  console.log(`Jev choice 冒烟测试：${CASES.length} 个用例 × ${rounds} 轮\n`);

  const samples = [];
  let wrong = 0;
  let failed = 0;
  for (let r = 1; r <= rounds; r++) {
    for (const c of CASES) {
      try {
        const x = await callJev(c);
        const ok = x.choice === c.expected;
        wrong += ok ? 0 : 1;
        samples.push(x.ms);
        console.log(`[${r}] ${c.id} "${c.question}" → ${x.choice}（期望 ${c.expected}）置信度 ${x.confidence.toFixed(3)} 耗时 ${x.ms.toFixed(0)}ms ${ok ? "✓" : "✗"}`);
      } catch (e) {
        failed++;
        console.log(`[${r}] ${c.id} "${c.question}" 调用失败：${redact(e.message)}`);
      }
    }
  }

  console.log("─".repeat(50));
  console.log(`调用成功 ${samples.length}/${CASES.length * rounds}；分类正确 ${samples.length - wrong}/${CASES.length * rounds}`);
  if (samples.length) {
    const p50 = percentile(samples, 50);
    console.log(`耗时 最小 ${Math.min(...samples).toFixed(0)}ms · P50 ${p50.toFixed(0)}ms · P90 ${percentile(samples, 90).toFixed(0)}ms · 最大 ${Math.max(...samples).toFixed(0)}ms`);
    console.log(`P50 目标 < ${P50_TARGET_MS}ms：${p50 < P50_TARGET_MS ? "达标" : "未达标"}（只统计本机到服务端的往返，网络不同结果不同）`);
  }
  if (wrong || failed) process.exit(1);
}

main().catch((e) => {
  console.error("致命错误：", redact(e.message));
  process.exit(1);
});
