// @vitest-environment node
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

const script = resolve("tools/desktop-linux-upgrade-smoke.mjs");
describe("privileged Linux installation smoke boundary", () => {
  it("refuses system mutation outside a disposable runner, with redacted errors", () => {
    const result = spawnSync(process.execPath, [script, "--json", "--baseline-version", "0.1.0", "--upgrade-version", "0.1.1"], {
      encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "false", RUNNER_OS: "Linux" },
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ passed: false, packages: [], checks: {}, errors: [process.platform === "linux" ? "disposable_runner_required" : "platform_unsupported"] });
    expect(result.stdout).not.toContain(process.cwd());
  });
  it("rejects same-version reinstall before inspecting packages", () => {
    const result = spawnSync(process.execPath, [script, "--json", "--baseline-version", "0.1.0", "--upgrade-version", "0.1.0"], {
      encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "true", RUNNER_OS: "Linux", RUNNER_ENVIRONMENT: "github-hosted" },
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ passed: false, packages: [], errors: [process.platform === "linux" ? "distinct_versions_required" : "platform_unsupported"] });
  });
  it("refuses self-hosted runner system state", () => {
    const result = spawnSync(process.execPath, [script, "--json", "--baseline-version", "0.1.0", "--upgrade-version", "0.1.1"], {
      encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "true", RUNNER_OS: "Linux", RUNNER_ENVIRONMENT: "self-hosted" },
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ passed: false, packages: [], errors: [process.platform === "linux" ? "disposable_runner_required" : "platform_unsupported"] });
  });
});
