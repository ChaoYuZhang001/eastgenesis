#!/usr/bin/env node
// 任务级路由基准：只回放匿名标注任务，不调用 Provider、不读取 Key、不保存任务正文。
// 这个门禁证明“任务事实 → 能力面/硬能力/透明路由/可恢复标签”的确定性契约，
// 不把规则命中率外推成真实回答质量、延迟或生产 SLA。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MODEL_PROFILES } from "../src/decision/profiles";
import { route } from "../src/decision/router";
import { CAPABILITIES, WORK_SURFACES, type Capability, type WorkSurface } from "../src/decision/types";

interface GoldenAttachment {
  kind: "image" | "text" | "code" | "pdf";
  chars?: number;
}

interface GoldenTask {
  id: string;
  category: "chat" | "work" | "codex" | "cross_surface";
  input: string;
  attachments?: GoldenAttachment[];
  expected_surface: WorkSurface;
  expected_type: string;
  hard_capabilities: Capability[];
  acceptable_providers: string[];
  required_surfaces?: WorkSurface[];
  route_reason: string;
  recovery: {
    preserve_partial_output: boolean;
    resume: "retry_or_next" | "checkpoint" | "artifact_checkpoint" | "checkpoint_and_confirm";
  };
}

interface GoldenFixture {
  schemaVersion: number;
  updated: string;
  tasks: GoldenTask[];
}

interface Failure {
  id: string;
  check: string;
  expected?: string | number | boolean;
  observed?: string | number | boolean;
}

const jsonOutput = process.argv.includes("--json");
const fixturePath = resolve(process.cwd(), "tests/fixtures/golden_tasks.json");
const failures: Failure[] = [];

function fail(id: string, check: string, expected?: string | number | boolean, observed?: string | number | boolean) {
  failures.push({ id, check, ...(expected !== undefined ? { expected } : {}), ...(observed !== undefined ? { observed } : {}) });
}

function readFixture(): GoldenFixture {
  const raw = JSON.parse(readFileSync(fixturePath, "utf8")) as Partial<GoldenFixture>;
  if (!raw || typeof raw !== "object") throw new Error("golden task fixture must be an object");
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.tasks)) throw new Error("unsupported golden task fixture schema");
  return raw as GoldenFixture;
}

const fixture = readFixture();
const tasks = fixture.tasks;
const ids = new Set<string>();
const profilesById = new Map(MODEL_PROFILES.map((profile) => [profile.id, profile]));
const allAvailable = () => ({ ok: true as const, health: 1 });
const validCategories = new Set(["chat", "work", "codex", "cross_surface"]);
const validResume = new Set(["retry_or_next", "checkpoint", "artifact_checkpoint", "checkpoint_and_confirm"]);

if (fixture.schemaVersion !== 1) fail("fixture", "schemaVersion", 1, fixture.schemaVersion);
if (tasks.length !== 30) fail("fixture", "taskCount", 30, tasks.length);

const categoryCounts: Record<string, number> = {};
const surfaceCounts: Record<string, number> = {};
let typeMatches = 0;
let surfaceMatches = 0;
let primaryAcceptable = 0;
let hardCapabilityMatches = 0;
let fallbackDiverse = 0;
let transparentTraces = 0;
let recoveryLabels = 0;
let crossSurfaceLabels = 0;

for (const task of tasks) {
  if (ids.has(task.id)) fail(task.id || "unknown", "uniqueId", true, false);
  ids.add(task.id);
  categoryCounts[task.category] = (categoryCounts[task.category] ?? 0) + 1;

  if (!task.id || !task.input || !validCategories.has(task.category)) {
    fail(task.id || "unknown", "annotationShape", true, false);
    continue;
  }
  if (!WORK_SURFACES.includes(task.expected_surface)) fail(task.id, "expectedSurface", "chat|work|codex", task.expected_surface);
  if (!Array.isArray(task.hard_capabilities) || task.hard_capabilities.some((cap) => !CAPABILITIES.includes(cap))) {
    fail(task.id, "hardCapabilitiesShape", true, false);
  }
  if (!Array.isArray(task.acceptable_providers) || task.acceptable_providers.length === 0) fail(task.id, "acceptableProviders", true, false);
  if (!task.route_reason || !task.recovery || !validResume.has(task.recovery.resume)) fail(task.id, "recoveryAnnotation", true, false);
  else recoveryLabels++;

  if (task.required_surfaces) {
    const required = new Set(task.required_surfaces);
    const valid = task.required_surfaces.every((surface) => WORK_SURFACES.includes(surface));
    if (!valid || !required.has(task.expected_surface)) fail(task.id, "requiredSurfaceChain", true, false);
    else crossSurfaceLabels++;
  }

  const decision = route(
    { text: task.input, ...(task.attachments ? { attachments: task.attachments } : {}) },
    { profiles: MODEL_PROFILES, availability: allAvailable },
  );
  const surface = decision.classification.surface ?? "chat";
  surfaceCounts[surface] = (surfaceCounts[surface] ?? 0) + 1;
  const typeOk = decision.classification.type === task.expected_type;
  const surfaceOk = surface === task.expected_surface;
  if (typeOk) typeMatches++;
  else fail(task.id, "taskType", task.expected_type, decision.classification.type);
  if (surfaceOk) surfaceMatches++;
  else fail(task.id, "workSurface", task.expected_surface, surface);

  const primary = decision.primary;
  if (!primary) {
    fail(task.id, "primaryRoute", true, false);
    continue;
  }
  if (task.acceptable_providers.includes(primary.provider)) primaryAcceptable++;
  else fail(task.id, "primaryProvider", "acceptable", primary.provider);

  const classifiedHard = task.hard_capabilities.every((cap) => decision.classification.capabilities.includes(cap));
  const primaryProfile = profilesById.get(primary.profileId);
  const primaryHard = task.hard_capabilities.every((cap) => primaryProfile?.capabilities.includes(cap));
  if (classifiedHard && primaryHard) hardCapabilityMatches++;
  else fail(task.id, "hardCapabilities", true, false);

  const providerCount = new Set(decision.chain.slice(0, 3).map((entry) => entry.provider)).size;
  if (decision.chain.length >= 2 && providerCount >= 2) fallbackDiverse++;
  else fail(task.id, "fallbackProviderDiversity", ">=2", providerCount);

  const traceText = JSON.stringify(decision.trace ?? {});
  if (!traceText.includes(task.input) && decision.reasons.some((reason) => reason.includes("任务类型")) && decision.reasons.some((reason) => reason.includes("工作能力"))) {
    transparentTraces++;
  } else {
    fail(task.id, "redactedTransparentTrace", true, false);
  }
}

const total = tasks.length;
const checks = {
  schema: fixture.schemaVersion === 1,
  taskCount: total === 30,
  uniqueIds: ids.size === total,
  annotationShape: failures.every((item) => item.check !== "annotationShape" && item.check !== "hardCapabilitiesShape" && item.check !== "acceptableProviders"),
  surfaceAccuracy: surfaceMatches === total,
  typeAccuracy: typeMatches === total,
  primaryProviderCoverage: primaryAcceptable === total,
  hardCapabilityCoverage: hardCapabilityMatches === total,
  fallbackProviderDiversity: fallbackDiverse === total,
  transparentRedactedTrace: transparentTraces === total,
  recoveryAnnotations: recoveryLabels === total,
  crossSurfaceAnnotations: crossSurfaceLabels === tasks.filter((task) => task.required_surfaces).length,
};
const passed = Object.values(checks).every(Boolean);

const report = {
  schemaVersion: 1,
  gate: "golden-task-routing",
  passed,
  fixture: { schemaVersion: fixture.schemaVersion, updated: fixture.updated, total },
  coverage: {
    categoryCounts,
    surfaceCounts,
    taskTypeAccuracy: total ? typeMatches / total : 0,
    workSurfaceAccuracy: total ? surfaceMatches / total : 0,
    primaryProviderCoverage: total ? primaryAcceptable / total : 0,
    hardCapabilityCoverage: total ? hardCapabilityMatches / total : 0,
    fallbackProviderDiversity: total ? fallbackDiverse / total : 0,
    redactedTransparentTrace: total ? transparentTraces / total : 0,
  },
  checks,
  failures,
  evidenceBoundary: {
    proven: [
      "30 条匿名任务的能力面和任务类型确定性回放",
      "硬能力过滤与主模型能力覆盖",
      "首选 Provider 可接受范围和至少两家 Provider 的降级链",
      "路由理由存在且 trace 不包含任务正文",
      "跨 Chat、Work、Codex 任务链的标注覆盖",
    ],
    excluded: [
      "真实 Provider 回答质量、事实正确率和工具成功率",
      "首 token 延迟、成本、限额和生产 SLA",
      "真实桌面 WebView、文件系统和权限交互",
      "跨步骤恢复是否在真实副作用上安全",
    ],
  },
};

if (jsonOutput) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`golden task gate ${passed ? "passed" : "failed"}: ${total} tasks`);
  for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (failures.length) console.log(`failures: ${failures.map((failure) => `${failure.id}/${failure.check}`).join(", ")}`);
}
if (!passed) process.exitCode = 1;
