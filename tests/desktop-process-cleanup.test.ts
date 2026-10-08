// @vitest-environment node
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasProcessExited, stopDetachedProcess } from "../tools/desktop-process-cleanup.mjs";

const children: ChildProcess[] = [];
const supervisorPids: number[] = [];
const readyOutputs = new WeakMap<ChildProcess, string>();

async function fixture(source: string) {
  const child = spawn(process.execPath, ["-e", source], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture readiness timeout")), 3_000);
    const ready = (data: Buffer) => { readyOutputs.set(child, data.toString()); clearTimeout(timer); resolve(); };
    child.stdout!.once("data", ready);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("fixture exited before readiness")); });
  });
  return child;
}

afterEach(async () => {
  for (const pid of supervisorPids.splice(0)) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* supervisor already gone */ }
  }
  for (const child of children.splice(0)) {
    try { process.kill(-child.pid!, "SIGKILL"); } catch { /* group already gone */ }
    if (!hasProcessExited(child)) {
      await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 1_000))]);
    }
  }
});

describe("desktop smoke leader exit classification", () => {
  it("recognizes a signal exit even when the numeric exit code is null", () => {
    expect(hasProcessExited({ exitCode: null, signalCode: "SIGTERM" } as ChildProcess)).toBe(true);
    expect(hasProcessExited({ exitCode: 143, signalCode: null } as ChildProcess)).toBe(true);
    expect(hasProcessExited({ exitCode: null, signalCode: null } as ChildProcess)).toBe(false);
  });
});

// Windows has no POSIX negative-PID process group signals. These tests use
// real detached Node processes on macOS/Linux; no platform semantics are mocked.
describe.skipIf(process.platform === "win32")("desktop POSIX process cleanup", () => {
  const options = { graceMs: 200, killMs: 2_000, pollMs: 20 };

  it("accepts actual TERM signal exit with exitCode null", async () => {
    const child = await fixture("setInterval(() => {}, 1000); process.stdout.write('ready');");
    const result = await stopDetachedProcess(child, options);
    expect(result).toMatchObject({ exitCode: null, signal: "SIGTERM", requestedSignal: "SIGTERM", leaderExited: true, processGroupGone: true, controlledCleanup: true, gracefulTermination: true });
  });

  it("accepts a TERM handler that exits with 143", async () => {
    const child = await fixture("process.on('SIGTERM', () => process.exit(143)); setInterval(() => {}, 1000); process.stdout.write('ready');");
    const result = await stopDetachedProcess(child, options);
    expect(result).toMatchObject({ exitCode: 143, signal: null, requestedSignal: "SIGTERM", leaderExited: true, processGroupGone: true, controlledCleanup: true, gracefulTermination: true });
  });

  it("records forced cleanup when the leader ignores TERM", async () => {
    const child = await fixture("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready');");
    const result = await stopDetachedProcess(child, options);
    expect(result).toMatchObject({ exitCode: null, signal: "SIGKILL", requestedSignal: "SIGKILL", leaderExited: true, processGroupGone: true, controlledCleanup: true, gracefulTermination: false });
  });

  it("cleans a surviving descendant after the leader exits", async () => {
    const child = await fixture([
      "const { spawn } = require('node:child_process');",
      "const descendant = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready');\"], { stdio: ['ignore', 'pipe', 'ignore'] });",
      "descendant.stdout.once('data', () => process.stdout.write('ready'));",
      "setInterval(() => {}, 1000);",
    ].join("\n"));
    const result = await stopDetachedProcess(child, options);
    expect(result).toMatchObject({ exitCode: null, signal: "SIGTERM", requestedSignal: "SIGKILL", leaderExited: true, liveProcessGroupGone: true, controlledCleanup: true, gracefulTermination: false });
    // An orphan may remain as Z until Linux PID 1 reaps it. The report keeps
    // that fact separate; accepting a dead zombie never accepts a live member.
    if (!result.processGroupGone) expect(result.zombieProcesses).toBeGreaterThan(0);
  });

  it("cleans descendants when the caller has already observed an early leader exit", async () => {
    const child = await fixture([
      "const { spawn } = require('node:child_process');",
      "const descendant = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready');\"], { stdio: ['ignore', 'pipe', 'ignore'] });",
      "descendant.stdout.once('data', () => process.stdout.write('ready'));",
      "setInterval(() => {}, 1000);",
    ].join("\n"));
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM"); // leader only; the descendant still owns group work
    await exited;
    expect(hasProcessExited(child)).toBe(true);
    const result = await stopDetachedProcess(child, options);
    expect(result).toMatchObject({ requestedSignal: "SIGKILL", leaderExited: true, liveProcessGroupGone: true, controlledCleanup: true, gracefulTermination: false });
    if (!result.processGroupGone) expect(result.zombieProcesses).toBeGreaterThan(0);
  });

  it("accepts only dead members while a real supervisor holds a zombie for reaping", async () => {
    // The supervisor leaves the target group before waiting, so it can keep
    // and reap a killed descendant. Darwin kill(group, 0) returns EPERM during
    // this real zombie window; Linux may still return success. No probes or
    // child-process APIs are mocked, and the supervisor exits after waitpid.
    const root = mkdtempSync(join(tmpdir(), "eastgenesis-zombie-reap-"));
    const marker = join(root, "reap");
    const python = [
      "import os, signal, sys, time",
      "from pathlib import Path",
      "ready_read, ready_write = os.pipe()",
      "child = os.fork()",
      "if child == 0:",
      " os.close(ready_read)",
      " signal.signal(signal.SIGTERM, signal.SIG_IGN)",
      " os.write(ready_write, b'1')",
      " os.close(ready_write)",
      " while True: time.sleep(0.05)",
      "else:",
      " os.close(ready_write)",
      " os.read(ready_read, 1)",
      " os.close(ready_read)",
      " os.setsid()",
      " print('ready', flush=True)",
      " deadline = time.monotonic() + 10",
      " while not Path(sys.argv[1]).exists() and time.monotonic() < deadline: time.sleep(0.02)",
      " os.waitpid(child, 0)",
    ].join("\n");
    const nodeSource = [
      "const { spawn } = require('node:child_process');",
      `const supervisor = spawn('python3', ['-c', ${JSON.stringify(python)}, ${JSON.stringify(marker)}], { stdio: ['ignore', 'pipe', 'ignore'] });`,
      "supervisor.stdout.once('data', () => process.stdout.write(`ready:${supervisor.pid}`));",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const child = await fixture(nodeSource);
    const targetPid = child.pid!;
    const supervisorPid = Number(readyOutputs.get(child)?.split(":")[1]);
    expect(Number.isInteger(supervisorPid) && supervisorPid > 0).toBe(true);
    supervisorPids.push(supervisorPid);
    try {
      const result = await stopDetachedProcess(child, options);
      expect(result).toMatchObject({ requestedSignal: "SIGKILL", leaderExited: true, processGroupGone: false, liveProcessGroupGone: true, controlledCleanup: true, gracefulTermination: false });
      expect(result.zombieProcesses).toBeGreaterThan(0);
      let probeCode = "exists";
      const probeDeadline = Date.now() + 1_000;
      do {
        try { process.kill(-targetPid, 0); } catch (error) { probeCode = (error as NodeJS.ErrnoException).code ?? "unknown"; }
        if (probeCode === "EPERM" || process.platform !== "darwin") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      } while (Date.now() < probeDeadline);
      if (process.platform === "darwin") expect(probeCode).toBe("EPERM");
    } finally {
      // Let the independent supervisor reap, even when the assertion failed.
      try { process.kill(-targetPid, "SIGKILL"); } catch { /* only zombies/gone */ }
      writeFileSync(marker, "reap\n");
      const deadline = Date.now() + 3_000;
      let gone = false;
      while (Date.now() < deadline) {
        const states = execFileSync("ps", ["-eo", "pgid=,stat="], { encoding: "utf8" }).trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/));
        gone = !states.some((row) => Number(row[0]) === targetPid);
        if (gone) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      rmSync(root, { recursive: true, force: true });
      expect(gone).toBe(true);
    }
  }, 15_000);
});
