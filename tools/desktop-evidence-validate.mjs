#!/usr/bin/env node
// 校验从“复制脱敏证据”得到的 JSON。
// 该工具只做结构和泄漏边界检查，不把校验通过解释成 WebView 或 Provider 已通过。
import { readFile } from "node:fs/promises";

const source = process.argv[2] ?? "-";
const raw = source === "-" ? await readStdin() : await readFile(source, "utf8");
const errors = [];

function readStdin() {
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk; });
    process.stdin.once("end", () => resolve(value));
    process.stdin.once("error", reject);
  });
}

let evidence;
try {
  evidence = JSON.parse(raw);
} catch {
  errors.push("输入不是合法 JSON");
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const has = (value, key) => isObject(value) && Object.prototype.hasOwnProperty.call(value, key);
const required = (value, path, kind) => {
  if (!has(value, path)) errors.push(`缺少字段 ${path}`);
  else if (kind === "object" && !isObject(value[path])) errors.push(`${path} 必须是对象`);
  else if (kind === "array" && !Array.isArray(value[path])) errors.push(`${path} 必须是数组`);
};

if (isObject(evidence)) {
  if (evidence.schemaVersion !== 1) errors.push("schemaVersion 必须为 1");
  for (const key of ["capturedAt", "task", "routes", "models", "stream", "tools", "events", "privacy"]) {
    required(evidence, key, ["task", "models", "stream", "tools", "events", "privacy"].includes(key) ? "object" : key === "routes" ? "array" : undefined);
  }
  if (has(evidence, "surfaceJourney")) {
    if (!Array.isArray(evidence.surfaceJourney)) errors.push("surfaceJourney 必须是数组");
    else if (evidence.surfaceJourney.some((surface) => !["chat", "work", "codex"].includes(surface))) errors.push("surfaceJourney 含未知能力面");
  }
  if (Array.isArray(evidence.routes)) {
    const routeSurfaces = [];
    const seenRouteSurfaces = new Set();
    for (const [index, route] of evidence.routes.entries()) {
      if (!isObject(route)) {
        errors.push(`routes[${index}] 必须是对象`);
        continue;
      }
      if (has(route, "surface") && route.surface !== null && !["chat", "work", "codex"].includes(route.surface)) errors.push(`routes[${index}].surface 含未知能力面`);
      if (has(route, "stepId") && route.stepId !== null && typeof route.stepId !== "string") errors.push(`routes[${index}].stepId 必须是字符串或 null`);
      if (route.kind === "step" && typeof route.stepId !== "string") errors.push(`routes[${index}] 的 step 路由必须带 stepId`);
      if (route.kind === "task" && route.stepId !== null) errors.push(`routes[${index}] 的 task 路由 stepId 必须为 null`);
      if (route.surface && !seenRouteSurfaces.has(route.surface)) {
        seenRouteSurfaces.add(route.surface);
        routeSurfaces.push(route.surface);
      }
    }
    if (Array.isArray(evidence.surfaceJourney) && routeSurfaces.some((surface, index) => evidence.surfaceJourney[index] !== surface)) {
      errors.push("routes 的能力面顺序与 surfaceJourney 不一致");
    }
  }

  const task = evidence.task;
  for (const key of ["id", "status", "startedAt", "endedAt", "durationMs", "mode", "preference", "preferenceSource", "permission", "filesCount", "goalChars"]) required(task, key);
  for (const section of ["models", "stream", "tools", "events"]) {
    const value = evidence[section];
    if (!isObject(value)) continue;
    if (section === "models") {
      for (const key of ["calls", "firstCallAt", "lastCallAt", "successful", "attempted", "providers", "fallbackCount", "retries"]) required(value, key);
      if (has(value, "skipped")) {
        if (!Array.isArray(value.skipped)) errors.push("models.skipped 必须是数组");
        else for (const [index, item] of value.skipped.entries()) {
          if (!isObject(item) || Object.keys(item).length !== 2 || !has(item, "profileId") || !has(item, "code")) {
            errors.push(`models.skipped[${index}] 只允许 profileId 和 code`);
            continue;
          }
          if (typeof item.profileId !== "string" || !item.profileId.trim()) errors.push(`models.skipped[${index}].profileId 必须是非空字符串`);
          if (!["provider_down", "unhealthy"].includes(item.code)) errors.push(`models.skipped[${index}].code 含未知跳过码`);
        }
      }
    }
    if (section === "stream") for (const key of ["partialOutput", "firstChunkAt", "lastChunkAt", "partialOutputChars", "summaryChars"]) required(value, key);
    if (section === "tools") for (const key of ["calls", "firstCallAt", "lastCallAt", "succeeded", "failed", "artifacts", "ledgerStates"]) required(value, key);
    if (section === "events") for (const key of ["total", "firstRecordedAt", "lastRecordedAt", "byType", "recoveries", "runEndStatus"]) required(value, key);
  }

  const omitted = evidence.privacy?.omitted;
  const expectedOmitted = ["goal", "tool_args", "tool_output", "file_paths", "file_contents", "reasoning", "raw_event_text"];
  if (JSON.stringify(omitted) !== JSON.stringify(expectedOmitted)) errors.push("privacy.omitted 不符合固定省略清单");

  const forbiddenKeys = new Set(["goal", "args", "output", "content", "path", "file_paths", "file_contents", "tool_args", "tool_output", "reasoning", "raw_event_text", "apiKey", "authorization", "baseUrl", "url"]);
  // Keep token-like matches bounded so ordinary identifiers such as `task-...`
  // are not misclassified because they contain the substring `sk-`.
  const secretPattern = /(?:^|[^a-z0-9])(?:bearer\s+|sk-[a-z0-9]{8,}|x-api-key\s*[:=])/i;
  const visit = (value, path = "$", isPrivacyOmitted = false) => {
    if (Array.isArray(value)) return value.forEach((item, index) => visit(item, `${path}[${index}]`, isPrivacyOmitted));
    if (!isObject(value)) {
      if (typeof value === "string" && !isPrivacyOmitted && secretPattern.test(value)) errors.push(`疑似凭据或 Authorization 出现在 ${path}`);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (forbiddenKeys.has(key) && !(path === "$.privacy" && key === "omitted")) errors.push(`禁止字段 ${childPath}`);
      visit(child, childPath, path === "$.privacy" && key === "omitted");
    }
  };
  visit(evidence);
}

const valid = errors.length === 0;
const report = {
  schemaVersion: 1,
  valid,
  source: source === "-" ? "stdin" : "file",
  ...(valid
    ? {
        taskStatus: evidence.task.status,
        routeCount: evidence.routes.length,
        modelCalls: evidence.models.calls,
        providerCount: evidence.models.providers.length,
        recoveryCount: evidence.events.recoveries,
        partialOutput: evidence.stream.partialOutput,
      }
    : { errors: errors.slice(0, 20) }),
  boundary: "结构和脱敏边界通过；不证明真实 WebView、Provider 或桌面安装验收",
};
console.log(JSON.stringify(report, null, 2));
if (!valid) process.exitCode = 1;
