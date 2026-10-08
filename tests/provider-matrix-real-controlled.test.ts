// @vitest-environment node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

async function waitForFixture(child: ChildProcess, url: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/staged/v1/models`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // The fixture may need a short time to bind its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("fixture did not become ready");
}

describe("controlled real Provider recovery matrix", () => {
  it("runs the opt-in two-provider path without external network or secret output", async () => {
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        const selected = typeof address === "object" && address ? address.port : 0;
        probe.close((error) => error ? reject(error) : resolve(selected));
      });
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    const fixture = spawn(process.execPath, ["tools/desktop-stream-fixture.mjs"], {
      env: { ...process.env, EG_FIXTURE_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    fixture.stdout.resume();
    fixture.stderr.resume();
    const env = {
      ...process.env,
      EG_MATRIX_PROTOCOL: "openai",
      EG_MATRIX_BASE_URL: `${baseUrl}/staged/v1`,
      EG_MATRIX_API_KEY: "synthetic-primary-key",
      EG_MATRIX_MODEL: "fixture-model",
      EG_MATRIX_FALLBACK_PROTOCOL: "openai",
      EG_MATRIX_FALLBACK_BASE_URL: `${baseUrl}/staged/v1`,
      EG_MATRIX_FALLBACK_API_KEY: "synthetic-fallback-key",
      EG_MATRIX_FALLBACK_MODEL: "fixture-model",
    };
    try {
      await waitForFixture(fixture, baseUrl);
      const { stdout } = await execFileAsync(pnpm, ["--silent", "provider:matrix", "--", "--real", "--json"], {
        env,
        maxBuffer: 2 * 1024 * 1024,
        shell: process.platform === "win32",
      });
      const report = JSON.parse(stdout);
      expect(report).toMatchObject({ mode: "real_opt_in", passed: true, recoveryStatus: "partial" });
      expect(report.scenarios).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "real_primary_stream", passed: true }),
        expect.objectContaining({ name: "real_fallback_stream", passed: true }),
      ]));
      expect(report.recovery).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "real_fallback_without_partial", passed: true, fallbackUsed: true, calls: 2 }),
        expect.objectContaining({ name: "real_stop_after_partial", passed: true, partialStopped: true, calls: 1 }),
      ]));
      expect(stdout).not.toContain("synthetic-primary-key");
      expect(stdout).not.toContain("synthetic-fallback-key");
      expect(stdout).not.toContain(baseUrl);
    } finally {
      if (fixture.exitCode === null) {
        fixture.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2_000);
          fixture.once("exit", () => { clearTimeout(timer); resolve(); });
        });
      }
    }
  }, 30_000);
});
