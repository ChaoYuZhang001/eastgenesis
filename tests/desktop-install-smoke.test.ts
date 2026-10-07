// @vitest-environment node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const smoke = resolve(process.cwd(), "tools/desktop-install-smoke.mjs");

describe("desktop Linux install smoke", () => {
  it("fails closed without echoing package paths", () => {
    const secretLikePath = "/tmp/provider-key-secret.deb";
    const result = spawnSync(process.execPath, [smoke, "--package", secretLikePath, "--json"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ schemaVersion: 1, kind: "desktop-install-smoke", passed: false });
    const expectedError = process.platform === "linux" ? "package_missing" : "platform_unsupported";
    expect(report.errors).toEqual([expectedError]);
    expect(result.stdout).not.toContain(secretLikePath);
    expect(result.stderr).toBe("");
  });
});
