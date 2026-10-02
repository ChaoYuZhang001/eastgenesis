// 回放或重新采样真实 Jev 对标注样例的回答，评估「Jev → 规则引擎」两级链的降级比例与路由准确率。
//   pnpm exec tsx tools/jev-eval.ts                回放 tests/fixtures 下所有录制文件（不需要 Key）
//   pnpm exec tsx tools/jev-eval.ts 录制文件.json   回放指定文件
//   pnpm exec tsx tools/jev-eval.ts --collect 出.json [--cases 样例集.json] [--twice]   用真实 Key 采样并写录制文件
//     --twice 采样两次。每条样例约 0.5s，单次 bash 调用有超时上限，样例多时要分批。
// 样例集按录制文件里的 cases 字段自动选，不用手写 --cases。
// Key 来源同 tools/jev-smoke-test.mjs：环境变量或 .env.local，不打印。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { capabilityStats, evaluateChain, type ChainReport, type JevSample, type RoutingCase } from "../src/decision/eval";
import { CloudJevBackend, DEFAULT_MIN_CONFIDENCE } from "../src/decision/fallback";
import { JevClient } from "../src/decision/jev-client";
import { CLASSIFY_QUESTIONS, VISION_QUESTION } from "../src/decision/jev-config";
import { loadJevKey } from "./jev-key.mjs";

type Doc = { recordAt?: string; model?: string; cases?: string; questions?: Record<string, string>; questionsSha256?: string; samplings: JevSample[][] };

const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const has = (name: string) => args.includes(name);
const short = (e: unknown) => (e instanceof Error ? e.message : String(e));
const root = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const fixturesDir = root("tests/fixtures");
const loadCases = (name: string) => {
  // 三种写法都接受：绝对路径、仓库相对路径（tests/fixtures/x.json）、仅文件名（x.json）
  const candidates = name.startsWith("/") ? [name] : [root(name), root(`tests/fixtures/${name}`)];
  const hit = candidates.find((c) => existsSync(c));
  if (!hit) throw new Error(`找不到样例集：${name}`);
  return (JSON.parse(readFileSync(hit, "utf8")) as { cases: RoutingCase[] }).cases;
};
const readDoc = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Doc;

const questions = { ...CLASSIFY_QUESTIONS, vision: VISION_QUESTION };
const fingerprint = createHash("sha256").update(JSON.stringify(questions)).digest("hex");
const customCasesFile = flag("--cases");
const cases = loadCases(customCasesFile ?? "routing_cases.json");

const pct = (n: number, d: number) => `${n}/${d}（${d ? ((100 * n) / d).toFixed(1) : "0.0"}%）`;
const allMin = (probs: Record<string, number>) => Math.min(1, ...Object.values(probs).map((p) => Math.abs(2 * p - 1)));
const anyMax = (probs: Record<string, number>) => Math.max(0, ...Object.values(probs).map((p) => Math.abs(2 * p - 1)));

/** 每条样例采样一次；返回概率。单次失败重试 2 次 */
async function sampleOnce(backend: CloudJevBackend, list: readonly RoutingCase[]): Promise<JevSample[]> {
  const out: JevSample[] = [];
  for (const c of list) {
    let last = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await backend.classifyTask({ text: c.input, attachments: c.attachments });
        void r;
        out.push({ id: c.id, probs: captured });
        last = "";
        break;
      } catch (e) {
        last = short(e);
        await new Promise((s) => setTimeout(s, 500 * attempt));
      }
    }
    if (last) throw new Error(`${c.id}：${last}`);
  }
  return out;
}

let captured: JevSample["probs"] = {};

function recordProbs(real: JevClient): CloudJevBackend {
  // 只在 ask 外面包一层记下各能力的原始概率；提问和判定仍走 CloudJevBackend 本身
  let last: JevSample["probs"] = {};
  const client = {
    ask: async (...a: Parameters<JevClient["ask"]>) => {
      const r = await real.ask(...a);
      last = Object.fromEntries(Object.entries(r.answers as Record<string, { noul: number }>).map(([k, v]) => [k, v.noul]));
      captured = last;
      return r;
    },
  } as unknown as JevClient;
  return new CloudJevBackend(client);
}

function backendWithKey(): CloudJevBackend {
  const real = JevClient.fromEnv({ TYPESAFE_API_KEY: loadJevKey() });
  if (!real) throw new Error("没有找到 TYPESAFE_API_KEY：设置环境变量，或写进仓库根目录的 .env.local");
  return recordProbs(real);
}

function report(name: string, samples: JevSample[][]) {
  const t = DEFAULT_MIN_CONFIDENCE;
  const chains = samples.map((s) => evaluateChain(cases, s, t));
  const first = chains[0];
  console.log(`\n=== ${name}：${first.total} 条 × ${samples.length} 次采样（路由正确 = 主类型一致且硬性能力一致）===`);
  console.log(`规则引擎单独 ${pct(first.rulesOk, first.total)} · Jev 单独 ${chains.map((r) => pct(r.jevOk, r.total)).join(" 与 ")}`);
  console.log(`整条链逐轮：${chains.map((r, i) => `第${i + 1}轮 对 ${r.chainOk} 条、错 ${r.total - r.chainOk} 条`).join(" · ")}`);
  console.log(`整条链（阈值 ${t}）${chains.map((r) => pct(r.chainOk, r.total)).join(" 与 ")} · 降级比例 ${chains.map((r) => ((100 * r.handed) / r.total).toFixed(1) + "%").join(" 与 ")}`);

  console.log("\n能力标签（Jev 概率 ≥ 0.5，与是否降级无关；两次采样合计）：");
  for (const [k, n] of Object.entries(capabilityStats(cases, samples.flat()))) {
    const prec = n.tp + n.fp ? n.tp / (n.tp + n.fp) : 1;
    const rec = n.tp + n.fn ? n.tp / (n.tp + n.fn) : 1;
    const fpRate = n.fp + n.tn ? n.fp / (n.fp + n.tn) : 0;
    console.log(`  ${k.padEnd(13)} 命中 ${n.tp} · 误报 ${n.fp} · 漏报 ${n.fn} · 精确 ${prec.toFixed(2)} · 召回 ${rec.toFixed(2)} · 误报率 ${fpRate.toFixed(2)}`);
  }

  console.log("\n阈值扫描（整条链准确率 · 降级比例 · Jev 上场率）：");
  for (const x of [0.5, 0.6, 0.7, 0.8]) {
    const cells = samples.map((s) => {
      const r = evaluateChain(cases, s, x);
      const handed = (100 * r.handed) / r.total;
      return `${pct(r.chainOk, r.total)} · ${handed.toFixed(1)}% · ${(100 - handed).toFixed(1)}%`;
    });
    console.log(`  ${x}: ${cells.join("  ‖  ")}`);
  }

  console.log(`\n策略对照（阈值 ${t}）：交给规则引擎 | 其中 Jev 本来也对 | 留用的 Jev 里错的 | 整条链准确率`);
  const variants: [string, (p: Record<string, number>, j: { confidence: number }) => number][] = [
    ["产品：只算会改变结果的判断", (_p, j) => j.confidence],
    ["旧：全部取最小", allMin],
    ["对照：取最大", anyMax],
  ];
  for (const [label, fn] of variants) {
    const rs = samples.map((s) => evaluateChain(cases, s, t, fn));
    console.log(`  ${label} | ${rs.map((r) => pct(r.handed, r.total)).join(" 与 ")} | ${rs.map((r) => pct(r.handedJevOk, r.handed)).join(" 与 ")} | ${rs.map((r) => pct(r.keptWrong, r.kept)).join(" 与 ")} | ${rs.map((r) => pct(r.chainOk, r.total)).join(" 与 ")}`);
  }

  chains.forEach((r: ChainReport, i: number) => {
    const errs = r.outcomes.filter((o) => !(o.handed ? o.rulesOk : o.jevOk));
    console.log(`\n采样 ${i + 1}：链上错的 ${errs.length} 条`);
    for (const o of errs) {
      const c = cases.find((x) => x.id === o.id)!;
      const s = samples[i].find((x) => x.id === o.id)!;
      const probs = Object.entries(s.probs).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(" ");
      console.log(`  ${o.id.padEnd(22)} 期望 ${c.expected_type.padEnd(12)} ${o.by === "jev" ? "Jev 决策" : "规则引擎接手"} 置信度 ${o.confidence.toFixed(2)} 错误类型 ${o.error}  [${probs}]`);
    }
    console.log(`  降级样例：${r.outcomes.filter((o) => o.handed).map((o) => `${o.id}(${o.rulesOk ? "规则对" : "规则错"})`).join(" ")}`);
  });
}

if (flag("--collect")) {
  const out = flag("--collect")!;
  // 一次 bash 调用只采一轮（一轮约 30–60s，避开单次调用的超时上限）；多轮由调用方分批跑，最后合并
  const rounds = has("--twice") ? 2 : 1;
  const round = Number(flag("--pass") ?? 1);
  const backend = backendWithKey();
  console.log(`采样第 ${round}/${rounds} 轮（${cases.length} 条）…`);
  const fresh = await sampleOnce(backend, cases);
  const previous: JevSample[][] = existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as Doc).samplings : [];
  // 始终按轮次定位写入：第 N 轮覆盖第 N 轮，不追加，重复跑同一轮不会重复计数
  const samplings = Array.from({ length: rounds }, (_, i) => (i === round - 1 ? fresh : previous[i] ?? []));
  if (samplings.some((x) => x.length === 0)) console.log(`注意：目前只有第 ${round} 轮，其余轮次还没跑`);
  const doc: Doc = {
    recordAt: new Date().toISOString().slice(0, 10),
    model: "jev-latest",
    cases: (customCasesFile ?? "routing_cases.json").split("/").pop(),
    questions,
    questionsSha256: fingerprint,
    samplings,
  };
  writeFileSync(out, JSON.stringify(doc, null, 1));
  console.log(`第 ${round}/${rounds} 轮完成，已写入 ${out}（共 ${samplings.length} 轮）`);
  report(`${out.split("/").pop()}（${samplings.length} 轮）`, samplings);
} else {
  const file = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  const files = file ? [file] : readdirSync(fixturesDir).filter((f) => /^jev_recorded_.*\.json$/.test(f)).map((f) => `${fixturesDir}/${f}`);
  for (const f of files) {
    if (!existsSync(f)) {
      console.log(`找不到 ${f}`);
      continue;
    }
    const doc = readDoc(f);
    const listed = loadCases(doc.cases ?? "routing_cases.json");
    const missing = doc.samplings.flat().filter((s) => !listed.some((c) => c.id === s.id));
    if (missing.length) {
      console.log(`跳过 ${f.split("/").pop()}：${missing.length} 条样例不在 ${doc.cases} 里`);
      continue;
    }
    if (doc.cases !== (customCasesFile ?? "routing_cases.json").split("/").pop()) {
      console.log(`\n（${f.split("/").pop()} 用的是样例集 ${doc.cases}，单独评估）`);
    }
    report(f.split("/").pop()!, doc.samplings);
  }
}
