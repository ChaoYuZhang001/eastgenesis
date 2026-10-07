// @vitest-environment node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const validator = resolve(process.cwd(), "tools/desktop-evidence-validate.mjs");

const validEvidence = () => ({
  schemaVersion: 1,
  capturedAt: "2026-10-07T00:00:00.000Z",
  task: {
    id: "task-250b2b54-9ff8-4079-9bb3-bf8359df9d2d",
    status: "completed",
    startedAt: 1_000,
    endedAt: 1_100,
    durationMs: 100,
    mode: "quick",
    preference: "balanced",
    preferenceSource: "global",
    permission: "confirm",
    filesCount: 0,
    goalChars: 0,
  },
  routes: [{ kind: "task", stepId: null, surface: null }],
  models: {
    calls: 0,
    firstCallAt: null,
    lastCallAt: null,
    successful: [],
    attempted: [],
    providers: [],
    fallbackCount: 0,
    retries: 0,
  },
  stream: { partialOutput: false, firstChunkAt: null, lastChunkAt: null, partialOutputChars: 0, summaryChars: 0 },
  tools: { calls: 0, firstCallAt: null, lastCallAt: null, succeeded: 0, failed: 0, artifacts: 0, ledgerStates: {} },
  events: { total: 0, firstRecordedAt: null, lastRecordedAt: null, byType: {}, recoveries: 0, runEndStatus: "completed" },
  privacy: { omitted: ["goal", "tool_args", "tool_output", "file_paths", "file_contents", "reasoning", "raw_event_text"] },
});

const validate = (evidence: unknown) => spawnSync(process.execPath, [validator], {
  input: `${JSON.stringify(evidence)}\n`,
  encoding: "utf8",
});

describe("desktop evidence validator", () => {
  it("does not reject ordinary task identifiers containing the sk- substring", () => {
    const result = validate(validEvidence());
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1, valid: true });
  });

  it("still rejects a token-like value at a non-word boundary", () => {
    const evidence = validEvidence();
    evidence.task.id = "task-sk-123456789012345";
    const result = validate(evidence);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1, valid: false });
    expect(result.stdout).toContain("疑似凭据或 Authorization");
  });
});
