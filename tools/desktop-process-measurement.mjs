// Read-only resource samples for an explicitly owned PID set. No process-name
// matching, command lines, usernames, executable paths or global process logs.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

const SOURCES = {
  darwin: "libproc_rusage_v0_mach_timebase",
  linux: "linux_pidfd_proc_stat_sysconf",
  win32: "windows_process_handle_times_working_set",
};
const REASONS = new Set(["arguments_invalid", "platform_unsupported", "collector_unavailable", "native_api_unavailable", "native_read_failed", "pid_exited", "identity_changed", "parent_drift", "ownership_invalid", "metadata_invalid", "counter_decreased", "clock_invalid", "insufficient_samples", "sampling_in_progress", "closed"]);
const pidValid = (pid) => Number.isSafeInteger(pid) && pid > 0 && pid <= 2_147_483_647;
const fail = (reason) => { throw new Error(REASONS.has(reason) ? reason : "native_read_failed"); };
const nsValid = (value) => typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n;

export function processMeasurementScope(platform = process.platform) {
  return {
    source: SOURCES[platform] ?? "unavailable",
    collection: "explicit_owned_pid_set",
    processTreeCoverage: "unverified",
    processTreeReason: "unregistered_descendants_not_discovered",
    cpu: "sum_own_user_and_system_time_excluding_child_counters",
    cpuCumulativeUnit: "milliseconds",
    cpuWindowUnit: "percent_of_one_logical_cpu",
    cpuWindowFormula: "100 * delta_cpu_ms / observed_wall_ms",
    rssUnit: "bytes",
    rssAggregation: "sum_at_each_sample_shared_pages_may_be_double_counted",
    samplingAtomicity: "non_atomic_collection_window_reported",
    excluded: ["owner_and_sampler_resource_counters", "unregistered_descendants", "processes_outside_verified_ancestry", ...(platform === "darwin" ? ["wkwebview_xpc_without_verified_parent_ancestry"] : [])],
  };
}

export function validateSamplingOptions({ intervalMs = 100, durationMs = 1000 } = {}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000
    || !Number.isSafeInteger(durationMs) || durationMs < 100 || durationMs > 60_000 || intervalMs > durationMs) fail("arguments_invalid");
  return { intervalMs, durationMs };
}

// Identity includes the native high-resolution start token. Linux additionally
// pins a pidfd; Windows retains the original process handle for the whole run.
export function validateOwnedSnapshot(anchors, records) {
  if (!Array.isArray(anchors) || anchors.length === 0 || anchors.length > 32 || !Array.isArray(records) || records.length !== anchors.length) fail("metadata_invalid");
  const unique = new Set();
  return anchors.map((anchor, index) => {
    const row = records[index];
    if (!anchor || !pidValid(anchor.pid) || !pidValid(anchor.parentPid) || !nsValid(anchor.identity) || unique.has(anchor.pid)
      || (index > 0 && !unique.has(anchor.parentPid))
      || !row || row.pid !== anchor.pid || !pidValid(row.parentPid) || !nsValid(row.identity)
      || !nsValid(row.cpuUserNs) || !nsValid(row.cpuSystemNs) || !Number.isSafeInteger(row.rssBytes) || row.rssBytes < 0) fail("metadata_invalid");
    unique.add(anchor.pid);
    if (row.identity !== anchor.identity) fail("identity_changed");
    if (row.parentPid !== anchor.parentPid) fail("parent_drift");
    return { pid: row.pid, parentPid: row.parentPid, identity: row.identity, cpuUserNs: row.cpuUserNs, cpuSystemNs: row.cpuSystemNs, rssBytes: row.rssBytes };
  });
}

export function summarizeProcessSamples(samples) {
  const empty = { status: "unverified", sampleCount: 0, wallMs: null, cpuCumulativeStartMs: null, cpuCumulativeEndMs: null, cpuDeltaMs: null, cpuPercentOneCore: null, sampledPeakRssBytes: null, reason: "insufficient_samples" };
  try {
    if (!Array.isArray(samples) || samples.length < 2) return empty;
    const anchors = samples[0].processes.map(({ pid, parentPid, identity }) => ({ pid, parentPid, identity }));
    let prior = null;
    let peak = 0;
    const totals = [];
    for (const sample of samples) {
      if (sample.status !== "verified" || !Number.isFinite(sample.observedAtMs) || !Number.isFinite(sample.collectionDurationMs) || sample.collectionDurationMs < 0) fail("metadata_invalid");
      const records = validateOwnedSnapshot(anchors, sample.processes);
      if (prior && sample.observedAtMs <= prior.observedAtMs) fail("clock_invalid");
      if (prior && records.some((row, index) => BigInt(row.cpuUserNs) < BigInt(prior.processes[index].cpuUserNs) || BigInt(row.cpuSystemNs) < BigInt(prior.processes[index].cpuSystemNs))) fail("counter_decreased");
      const rss = records.reduce((sum, row) => sum + row.rssBytes, 0);
      if (!Number.isSafeInteger(rss)) fail("metadata_invalid");
      peak = Math.max(peak, rss);
      totals.push(records.reduce((sum, row) => sum + BigInt(row.cpuUserNs) + BigInt(row.cpuSystemNs), 0n));
      prior = sample;
    }
    const wallMs = samples.at(-1).observedAtMs - samples[0].observedAtMs;
    const cpuDeltaMs = Number(totals.at(-1) - totals[0]) / 1e6;
    return { status: "verified", sampleCount: samples.length, wallMs, cpuCumulativeStartMs: Number(totals[0]) / 1e6, cpuCumulativeEndMs: Number(totals.at(-1)) / 1e6, cpuDeltaMs, cpuPercentOneCore: 100 * cpuDeltaMs / wallMs, sampledPeakRssBytes: peak };
  } catch (error) {
    return { ...empty, reason: REASONS.has(error?.message) ? error.message : "metadata_invalid" };
  }
}

// One isolated, persistent Python helper holds pidfds / process handles, so a
// PID reused after an exit cannot be rebound to a different process. Its JSON
// protocol emits only PID, parent PID, start identity and numeric counters.
const NATIVE_HELPER = String.raw`
import ctypes as c, errno, json, os, select, struct, subprocess, sys
platform = sys.platform
held = {}
def bad(reason): raise RuntimeError(reason)
if platform == 'darwin':
    lib = c.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    mach = c.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    class Usage(c.Structure):
        _fields_ = [('uuid', c.c_ubyte * 16)] + [(name, c.c_uint64) for name in ['user','system','idle','interrupt','pageins','wired','resident','footprint','start','exit']]
    class Timebase(c.Structure): _fields_ = [('numer', c.c_uint32), ('denom', c.c_uint32)]
    lib.proc_pid_rusage.argtypes = [c.c_int, c.c_int, c.c_void_p]
    lib.proc_pid_rusage.restype = c.c_int
    lib.proc_pidinfo.argtypes = [c.c_int, c.c_int, c.c_uint64, c.c_void_p, c.c_int]
    lib.proc_pidinfo.restype = c.c_int
    tb = Timebase()
    if mach.mach_timebase_info(c.byref(tb)) != 0 or tb.numer == 0 or tb.denom == 0: bad('native_api_unavailable')
    def usage(pid):
        value = Usage()
        if lib.proc_pid_rusage(pid, 0, c.byref(value)) != 0: bad('pid_exited' if c.get_errno() == errno.ESRCH else 'native_read_failed')
        return value
    def parent(pid):
        data = c.create_string_buffer(64)
        if lib.proc_pidinfo(pid, 13, 0, data, 64) != 64: bad('pid_exited' if c.get_errno() == errno.ESRCH else 'native_read_failed')
        actual, ppid, _, status = struct.unpack_from('=IIII', data.raw)
        if actual != pid: bad('identity_changed')
        if status == 5: bad('pid_exited')
        return ppid
    def read(pid):
        a = usage(pid); ppid = parent(pid); b = usage(pid)
        if a.start != b.start: bad('identity_changed')
        if parent(pid) != ppid: bad('parent_drift')
        return dict(pid=pid,parentPid=ppid,identity=str(b.start),cpuUserNs=str(b.user*tb.numer//tb.denom),cpuSystemNs=str(b.system*tb.numer//tb.denom),rssBytes=b.resident)
elif platform.startswith('linux'):
    if not hasattr(os, 'pidfd_open'): bad('native_api_unavailable')
    hz = os.sysconf('SC_CLK_TCK'); page = os.sysconf('SC_PAGE_SIZE')
    def read(pid):
        fd = held[pid]['handle']
        if select.select([fd],[],[],0)[0]: bad('pid_exited')
        with open('/proc/%d/stat' % pid, 'r') as f: text = f.read(8192)
        end = text.rfind(') '); parts = text[end+2:].split()
        if end < 0 or int(text[:text.find(' ')]) != pid or len(parts) < 22: bad('metadata_invalid')
        if parts[0] in ('Z','X','x'): bad('pid_exited')
        if select.select([fd],[],[],0)[0]: bad('pid_exited')
        return dict(pid=pid,parentPid=int(parts[1]),identity=parts[19],cpuUserNs=str(int(parts[11])*1000000000//hz),cpuSystemNs=str(int(parts[12])*1000000000//hz),rssBytes=int(parts[21])*page)
elif platform == 'win32':
    kernel = c.WinDLL('kernel32', use_last_error=True); psapi = c.WinDLL('psapi', use_last_error=True)
    class FT(c.Structure): _fields_ = [('low',c.c_uint32),('high',c.c_uint32)]
    class Memory(c.Structure):
        _fields_ = [('cb',c.c_uint32),('faults',c.c_uint32)] + [(x,c.c_size_t) for x in ['peak','working','quotaPeakPaged','quotaPaged','quotaPeakNonPaged','quotaNonPaged','pagefile','peakPagefile']]
    kernel.OpenProcess.argtypes=[c.c_uint32,c.c_int,c.c_uint32]; kernel.OpenProcess.restype=c.c_void_p
    kernel.CloseHandle.argtypes=[c.c_void_p]
    kernel.WaitForSingleObject.argtypes=[c.c_void_p,c.c_uint32]; kernel.WaitForSingleObject.restype=c.c_uint32
    kernel.GetProcessTimes.argtypes=[c.c_void_p,c.POINTER(FT),c.POINTER(FT),c.POINTER(FT),c.POINTER(FT)]
    psapi.GetProcessMemoryInfo.argtypes=[c.c_void_p,c.POINTER(Memory),c.c_uint32]
    def alive(handle):
        state=kernel.WaitForSingleObject(handle,0)
        if state == 0: bad('pid_exited')
        if state != 258: bad('native_read_failed')
    def ppid(pid):
        # Project only two numeric properties; no CommandLine or user data.
        command="Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId FROM Win32_Process WHERE ProcessId = %d' | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress" % pid
        exe=os.path.join(os.environ['SystemRoot'],'System32','WindowsPowerShell','v1.0','powershell.exe')
        result=subprocess.run([exe,'-NoLogo','-NoProfile','-NonInteractive','-Command',command],capture_output=True,timeout=2,check=True)
        row=json.loads(result.stdout.decode('utf-8-sig'))
        if row['ProcessId'] != pid: bad('identity_changed')
        return int(row['ParentProcessId'])
    def read(pid):
        handle=held[pid]['handle']; alive(handle)
        created=FT(); exited=FT(); user=FT(); system=FT(); memory=Memory(); memory.cb=c.sizeof(memory)
        if not kernel.GetProcessTimes(handle,c.byref(created),c.byref(exited),c.byref(system),c.byref(user)) or not psapi.GetProcessMemoryInfo(handle,c.byref(memory),c.sizeof(memory)): bad('native_read_failed')
        alive(handle)
        number=lambda x: (x.high<<32)|x.low
        return dict(pid=pid,parentPid=held[pid]['parentPid'],identity=str(number(created)),cpuUserNs=str(number(user)*100),cpuSystemNs=str(number(system)*100),rssBytes=memory.working)
else: bad('platform_unsupported')
def register(pid, expected_parent):
    if pid in held: bad('ownership_invalid')
    held[pid] = {}
    if platform.startswith('linux'):
        held[pid]['handle']=os.pidfd_open(pid,0)
    elif platform == 'win32':
        handle=kernel.OpenProcess(0x100410,False,pid)
        if not handle: bad('native_read_failed')
        held[pid]['handle']=handle; alive(handle)
        held[pid]['parentPid']=ppid(pid); alive(handle)
    row=read(pid)
    if expected_parent is not None and row['parentPid'] != expected_parent: bad('ownership_invalid')
    held[pid]['identity']=row['identity']; held[pid]['parentPid']=row['parentPid']
    return row
def close():
    for value in held.values():
        if 'handle' in value:
            if platform.startswith('linux'): os.close(value['handle'])
            elif platform == 'win32': kernel.CloseHandle(value['handle'])
try:
    for line in sys.stdin:
        request=json.loads(line); seq=request['seq']
        try:
            if request['operation']=='close':
                print(json.dumps(dict(seq=seq,status='closed')),flush=True); break
            pid=request['pid']
            row=register(pid,request.get('parentPid')) if request['operation']=='register' else read(pid)
            if row['identity'] != held[pid]['identity']: bad('identity_changed')
            if row['parentPid'] != held[pid]['parentPid']: bad('parent_drift')
            print(json.dumps(dict(seq=seq,status='verified',record=row)),flush=True)
        except Exception as error:
            reason=str(error) if isinstance(error,RuntimeError) else 'native_read_failed'
            if isinstance(error,(ProcessLookupError,FileNotFoundError)): reason='pid_exited'
            print(json.dumps(dict(seq=seq,status='unverified',reason=reason)),flush=True)
finally: close()
`;

function nativeCollector(platform, pythonExecutable) {
  const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  const child = spawn(pythonExecutable ?? (platform === "win32" ? "python" : "python3"), ["-I", "-u", "-c", NATIVE_HELPER], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  // Drain without collecting interpreter errors (which can contain paths).
  child.stderr.resume();
  const pending = new Map();
  let seq = 0;
  let unavailable = false;
  const rejectAll = () => { unavailable = true; for (const entry of pending.values()) entry.reject(new Error("collector_unavailable")); pending.clear(); };
  child.once("error", rejectAll); child.once("exit", rejectAll);
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      if (line.length > 4096) fail("metadata_invalid");
      const result = JSON.parse(line); const entry = pending.get(result.seq);
      if (!entry) fail("metadata_invalid");
      pending.delete(result.seq); entry.resolve(result);
    } catch { rejectAll(); child.kill(); }
  });
  return {
    async request(operation, data = {}, timeoutMs = 3000) {
      if (unavailable) fail("collector_unavailable");
      const id = ++seq;
      let timer;
      try {
        return await new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          timer = setTimeout(() => { pending.delete(id); reject(new Error("collector_unavailable")); child.kill(); }, timeoutMs);
          child.stdin.write(`${JSON.stringify({ seq: id, operation, ...data })}\n`, (error) => { if (error) rejectAll(); });
        });
      } finally { clearTimeout(timer); }
    },
    async close() {
      try { if (!unavailable) await this.request("close", {}, 500); } catch {}
      finally {
        lines.close(); child.stdin.destroy(); child.kill();
        if (child.exitCode === null && child.signalCode === null) {
          await new Promise((resolve) => {
            const done = () => { clearTimeout(timer); child.removeListener("exit", done); resolve(); };
            const timer = setTimeout(done, 500); child.once("exit", done);
          });
        }
      }
    },
  };
}

export async function createOwnedProcessSampler({ rootPid, ownerPid = process.pid, pythonExecutable, platform = process.platform } = {}) {
  if (!pidValid(rootPid) || !pidValid(ownerPid) || rootPid === ownerPid || (pythonExecutable !== undefined && (typeof pythonExecutable !== "string" || !pythonExecutable))) fail("arguments_invalid");
  if (!SOURCES[platform] || platform !== process.platform) fail("platform_unsupported");
  const collector = nativeCollector(platform, pythonExecutable);
  const anchors = [];
  let blocked = null;
  let measuring = false;
  let closed = false;
  const scope = processMeasurementScope(platform);
  const platformExecution = { darwin: platform === "darwin" ? "executed" : "not_run", linux: platform === "linux" ? "executed" : "not_run", win32: platform === "win32" ? "executed" : "not_run" };
  let ownerAnchor;
  const requestRecord = async (operation, pid, parentPid, timeoutMs) => {
    const response = await collector.request(operation, { pid, ...(parentPid === undefined ? {} : { parentPid }) }, timeoutMs);
    if (response.status !== "verified") fail(response.reason);
    return response.record;
  };
  try {
    const owner = await requestRecord("register", ownerPid);
    ownerAnchor = { pid: ownerPid, parentPid: owner.parentPid, identity: owner.identity };
    validateOwnedSnapshot([ownerAnchor], [owner]);
    const root = await requestRecord("register", rootPid, ownerPid);
    validateOwnedSnapshot([{ pid: rootPid, parentPid: ownerPid, identity: root.identity }], [root]);
    anchors.push({ pid: rootPid, parentPid: ownerPid, identity: root.identity });
  } catch (error) { await collector.close(); throw error; }
  const sample = async (timeoutMs = 3000) => {
    const started = performance.now();
    const deadline = started + timeoutMs;
    const read = (pid) => requestRecord("read", pid, undefined, Math.max(1, Math.floor(deadline - performance.now())));
    try {
      if (closed) fail("closed"); if (blocked) fail(blocked);
      validateOwnedSnapshot([ownerAnchor], [await read(ownerPid)]);
      const records = await Promise.all(anchors.map((anchor) => read(anchor.pid)));
      validateOwnedSnapshot([ownerAnchor], [await read(ownerPid)]);
      const processes = validateOwnedSnapshot(anchors, records);
      const rssBytes = processes.reduce((sum, row) => sum + row.rssBytes, 0);
      if (!Number.isSafeInteger(rssBytes)) fail("metadata_invalid");
      const cpuCumulativeMs = Number(processes.reduce((sum, row) => sum + BigInt(row.cpuUserNs) + BigInt(row.cpuSystemNs), 0n)) / 1e6;
      const ended = performance.now();
      return { status: "verified", observedAtMs: (started + ended) / 2, collectionDurationMs: ended - started, processes, rssBytes, cpuCumulativeMs };
    } catch (error) {
      blocked = REASONS.has(error?.message) ? error.message : "native_read_failed";
      return { status: "unverified", reason: blocked, observedAtMs: performance.now(), collectionDurationMs: performance.now() - started, processes: [], rssBytes: null, cpuCumulativeMs: null };
    }
  };
  return {
    scope,
    platformExecution,
    sample,
    async registerDescendant(pid, parentPid) {
      if (closed) fail("closed"); if (blocked) fail(blocked); if (measuring) fail("sampling_in_progress");
      if (!pidValid(pid) || !pidValid(parentPid) || anchors.length >= 32 || anchors.some((anchor) => anchor.pid === pid) || !anchors.some((anchor) => anchor.pid === parentPid)) fail("ownership_invalid");
      try {
        const before = await sample(); if (before.status !== "verified") fail(before.reason);
        const row = await requestRecord("register", pid, parentPid);
        validateOwnedSnapshot([{ pid, parentPid, identity: row.identity }], [row]);
        const after = await sample(); if (after.status !== "verified") fail(after.reason);
        anchors.push({ pid, parentPid, identity: row.identity });
      } catch (error) { blocked = REASONS.has(error?.message) ? error.message : "native_read_failed"; fail(blocked); }
    },
    async measure(options = {}) {
      const settings = validateSamplingOptions(options);
      if (measuring) fail("sampling_in_progress");
      measuring = true;
      const samples = []; const started = performance.now(); const deadline = started + settings.durationMs;
      try {
        while (deadline - performance.now() >= 1) {
          const next = await sample(Math.max(1, Math.floor(deadline - performance.now())));
          if (next.status !== "verified") return { schemaVersion: 1, kind: "desktop-process-measurement", status: "unverified", reason: next.reason, scope, platformExecution, settings, samples, summary: null };
          samples.push(next);
          const remaining = deadline - performance.now();
          if (remaining <= settings.intervalMs) break;
          await delay(settings.intervalMs);
        }
        const summary = summarizeProcessSamples(samples);
        return { schemaVersion: 1, kind: "desktop-process-measurement", status: summary.status, ...(summary.reason ? { reason: summary.reason } : {}), scope, platformExecution, settings, samples, summary };
      } finally { measuring = false; }
    },
    async close() { closed = true; await collector.close(); },
  };
}
