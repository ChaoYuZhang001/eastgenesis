// @vitest-environment node
import { describe, expect, it } from "vitest";
import { processMeasurementScope, validateSamplingOptions, validateOwnedSnapshot, summarizeProcessSamples, createOwnedProcessSampler } from "../tools/desktop-process-measurement.mjs";
import type { ProcessRecord, ProcessSample } from "../tools/desktop-process-measurement.mjs";

const root: ProcessRecord = { pid: 101, parentPid: 100, identity: "12345", cpuUserNs: "1000000000", cpuSystemNs: "500000000", rssBytes: 1000 };
const descendant: ProcessRecord = { pid: 102, parentPid: 101, identity: "12346", cpuUserNs: "200000000", cpuSystemNs: "100000000", rssBytes: 2000 };
const frame = (observedAtMs: number, processes: ProcessRecord[]): ProcessSample => {
  let cpuCumulativeMs: number | null = null;
  try { cpuCumulativeMs = Number(processes.reduce((sum, row) => sum + BigInt(row.cpuUserNs) + BigInt(row.cpuSystemNs), 0n)) / 1e6; } catch { /* Preserve deliberately malformed records for rejection tests. */ }
  return { status: "verified", observedAtMs, collectionDurationMs: 1, processes, rssBytes: processes.reduce((sum, row) => sum + row.rssBytes, 0), cpuCumulativeMs };
};

describe("owned process resource measurement contract", () => {
  it("reports own cumulative CPU separately from the sampled interval and permits more than 100 percent", () => {
    const result = summarizeProcessSamples([frame(1000, [root]), frame(1100, [{ ...root, cpuUserNs: "1200000000", cpuSystemNs: "550000000" }])]);
    expect(result).toMatchObject({ status: "verified", sampleCount: 2, wallMs: 100, cpuCumulativeStartMs: 1500, cpuCumulativeEndMs: 1750, cpuDeltaMs: 250, cpuPercentOneCore: 250, sampledPeakRssBytes: 1000 });
  });

  it("takes the peak of simultaneous RSS sums rather than the sum of individual peaks", () => {
    const result = summarizeProcessSamples([frame(1000, [{ ...root, rssBytes: 10000 }, { ...descendant, rssBytes: 1000 }]), frame(1100, [{ ...root, rssBytes: 1000 }, { ...descendant, rssBytes: 10000 }])]);
    expect(result).toMatchObject({ status: "verified", sampledPeakRssBytes: 11000, cpuCumulativeStartMs: 1800, cpuDeltaMs: 0, cpuPercentOneCore: 0 });
  });

  it("fails closed on PID reuse, parent drift and a changed registered set", () => {
    for (const changed of [{ ...root, identity: "99999" }, { ...root, parentPid: 999 }, { ...root, pid: 999 }]) {
      expect(summarizeProcessSamples([frame(1000, [root]), frame(1100, [changed])])).toMatchObject({ status: "unverified", cpuDeltaMs: null, sampledPeakRssBytes: null });
    }
    expect(() => validateOwnedSnapshot([root], [{ ...root, identity: "99999" }])).toThrow("identity_changed");
    expect(() => validateOwnedSnapshot([root], [{ ...root, parentPid: 999 }])).toThrow("parent_drift");
    expect(summarizeProcessSamples([frame(1000, [root]), frame(1100, [root, descendant])])).toMatchObject({ status: "unverified", reason: "metadata_invalid" });
    expect(() => validateOwnedSnapshot([root, { ...descendant, parentPid: 999 }], [root, { ...descendant, parentPid: 999 }])).toThrow("metadata_invalid");
  });

  it("rejects a reset individual CPU counter even if total CPU rises", () => {
    expect(summarizeProcessSamples([frame(1000, [root]), frame(1100, [{ ...root, cpuUserNs: "999999999", cpuSystemNs: "900000000" }])]))
      .toMatchObject({ status: "unverified", reason: "counter_decreased", cpuPercentOneCore: null });
  });

  it("uses exact counter subtraction before converting nanoseconds to milliseconds", () => {
    const a = { ...root, cpuUserNs: "18000000000000000000", cpuSystemNs: "0" };
    expect(summarizeProcessSamples([frame(1000, [a]), frame(1100, [{ ...a, cpuUserNs: "18000000000000100000" }])]))
      .toMatchObject({ status: "verified", cpuDeltaMs: 0.1, cpuPercentOneCore: 0.1 });
  });

  it("requires bounded sampling and valid monotonic observation clocks", () => {
    expect(validateSamplingOptions({ intervalMs: 100, durationMs: 60000 })).toEqual({ intervalMs: 100, durationMs: 60000 });
    for (const opts of [{ intervalMs: 99 }, { durationMs: 60001 }, { intervalMs: 100.5 }, { durationMs: NaN }, { intervalMs: 1000, durationMs: 100 }]) {
      expect(() => validateSamplingOptions(opts)).toThrow("arguments_invalid");
    }
    expect(summarizeProcessSamples([frame(1000, [root])])).toMatchObject({ status: "unverified", reason: "insufficient_samples" });
    expect(summarizeProcessSamples([frame(1000, [root]), frame(1000, [root])])).toMatchObject({ status: "unverified", reason: "clock_invalid" });
  });

  it("keeps resource scope explicit and excludes unowned WKWebView XPC", () => {
    expect(processMeasurementScope("darwin")).toMatchObject({ processTreeCoverage: "unverified", cpuCumulativeUnit: "milliseconds", cpuWindowUnit: "percent_of_one_logical_cpu", rssUnit: "bytes" });
    expect(processMeasurementScope("darwin").excluded).toContain("wkwebview_xpc_without_verified_parent_ancestry");
    expect(processMeasurementScope("linux").source).toBe("linux_pidfd_proc_stat_sysconf");
    expect(processMeasurementScope("win32").source).toBe("windows_process_handle_times_working_set");
  });

  it("strips nonnumeric process information and emits only fixed failure reasons", () => {
    const result = validateOwnedSnapshot([root], [{ ...root, commandLine: "private-command", username: "private-user", path: "/private/path" }]);
    expect(result).toEqual([root]);
    expect(JSON.stringify(result)).not.toMatch(/private-/);
    for (const changed of [{ ...root, cpuUserNs: "private-command" }, { ...root, rssBytes: -1 }, { ...root, cpuSystemNs: "18446744073709551616" }]) {
      const result = summarizeProcessSamples([frame(1000, [root]), frame(1100, [changed])]);
      expect(result).toMatchObject({ status: "unverified", reason: "metadata_invalid" });
      expect(JSON.stringify(result)).not.toMatch(/private-/);
    }
  });

  it("never runs a backend for another platform or an invalid PID", async () => {
    await expect(createOwnedProcessSampler({ rootPid: -1 })).rejects.toThrow("arguments_invalid");
    await expect(createOwnedProcessSampler({ rootPid: process.pid })).rejects.toThrow("arguments_invalid");
    await expect(createOwnedProcessSampler({ rootPid: process.pid + 1, platform: process.platform === "darwin" ? "linux" : "darwin" })).rejects.toThrow("platform_unsupported");
  });
});
