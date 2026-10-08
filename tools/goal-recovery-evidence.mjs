const forbiddenKeys = new Set([
  "goal",
  "args",
  "output",
  "content",
  "path",
  "filePath",
  "file_paths",
  "tool_args",
  "tool_output",
  "reasoning",
  "raw_event_text",
  "apiKey",
  "authorization",
  "baseUrl",
  "url",
]);

const secretPattern = /(?:bearer\s+|sk-[a-z0-9]{8,}|x-api-key\s*[:=])/i;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value, path, errors) {
  if (typeof value !== "string" || value.trim().length === 0) errors.push(`${path} 必须是非空字符串`);
}

function requiredStringArray(value, path, errors) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    errors.push(`${path} 必须是字符串数组`);
  }
}

function visit(value, path, errors) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, `${path}[${index}]`, errors));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (forbiddenKeys.has(key)) errors.push(`禁止字段 ${childPath}`);
    visit(child, childPath, errors);
  }
}

export function validateGoalRecoveryEvidence(evidence) {
  const errors = [];
  if (!isObject(evidence)) {
    errors.push("顶层必须是对象");
  } else {
    if (evidence.schemaVersion !== 1) errors.push("schemaVersion 必须为 1");
    if (evidence.kind !== "goal-recovery-crash-smoke") errors.push("kind 不匹配");
    if (evidence.passed !== true) errors.push("passed 必须为 true");
    if (evidence.goalStatus !== "completed") errors.push("goalStatus 必须为 completed");
    requiredString(evidence.taskId, "taskId", errors);
    if (!Number.isInteger(evidence.runCalls) || evidence.runCalls !== 0) errors.push("runCalls 必须为 0");
    if (evidence.ledgerState !== "applied") errors.push("ledgerState 必须为 applied");
    if (!isObject(evidence.evidenceBoundary)) {
      errors.push("evidenceBoundary 必须是对象");
    } else {
      requiredStringArray(evidence.evidenceBoundary.proven, "evidenceBoundary.proven", errors);
      requiredStringArray(evidence.evidenceBoundary.excluded, "evidenceBoundary.excluded", errors);
    }
    visit(evidence, "$", errors);
    const serialized = JSON.stringify(evidence);
    if (secretPattern.test(serialized)) errors.push("证据疑似包含凭据或 Authorization");
  }
  return { valid: errors.length === 0, errors: errors.slice(0, 20) };
}
