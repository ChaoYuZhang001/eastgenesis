// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const validator = resolve(process.cwd(), "tools/goal-recovery-evidence-validate.mjs");

const validEvidence = {
  schemaVersion: 1,
  kind: "goal-recovery-crash-smoke",
  passed: true,
  goalStatus: "completed",
  taskId: "task-process-crash-window",
  runCalls: 0,
  ledgerState: "applied",
  evidenceBoundary: {
    proven: ["same task id after restart"],
    excluded: ["real Tauri WebView interaction", "real Provider availability"],
  },
};

describe("goal recovery evidence validator", () => {
  it("accepts the production crash-window evidence shape", () => {
    const root = mkdtempSync(join(tmpdir(), "eastgenesis-goal-evidence-"));
    const file = join(root, "goal-recovery-quality.json");
    try {
      writeFileSync(file, `${JSON.stringify(validEvidence)}\n`, "utf8");
      const report = JSON.parse(execFileSync(process.execPath, [validator, file], { encoding: "utf8" }));
      expect(report).toMatchObject({ valid: true, kind: validEvidence.kind, runCalls: 0, ledgerState: "applied" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects forbidden fields and never echoes their value", () => {
    const root = mkdtempSync(join(tmpdir(), "eastgenesis-goal-evidence-invalid-"));
    const file = join(root, "goal-recovery-quality.json");
    const secret = "sk-123456789012345";
    try {
      writeFileSync(file, `${JSON.stringify({ ...validEvidence, apiKey: secret, url: "https://private.invalid" })}\n`, "utf8");
      const result = spawnSync(process.execPath, [validator, file], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ valid: false });
      expect(result.stdout).not.toContain(secret);
      expect(result.stdout).not.toContain("private.invalid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
