// POSIX detached-process smoke cleanup. A signal exit has exitCode=null and
// signalCode set; leader exit and descendant cleanup are separate facts.
import { execFileSync } from "node:child_process";

export const hasProcessExited = (child) => child.exitCode !== null || child.signalCode !== null;

function fail(stage) {
  const error = new Error(stage);
  error.stage = stage;
  throw error;
}

function inspectGroup(child) {
  let permissionDenied = false;
  try {
    process.kill(-child.pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return { exists: false, live: 0, zombies: 0 };
    // Darwin can return EPERM for a group containing only an unreaped zombie.
    // EPERM itself is never proof of cleanup; require the state snapshot below.
    if (error?.code === "EPERM") permissionDenied = true;
    else fail("process_group_probe");
  }
  // kill(0) also succeeds for Linux orphan zombies while PID 1 has not reaped
  // them. They cannot execute work or respond to another signal. Inspect only
  // group ID and state; never collect commands, paths or environment values.
  let states;
  try {
    states = execFileSync("ps", ["-eo", "pgid=,stat="], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  } catch {
    fail("process_group_probe");
  }
  let live = 0;
  let zombies = 0;
  for (const line of states.trim().split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = line.trim().split(/\s+/);
    if (!/^\d+$/.test(row[0])) fail("process_group_probe");
    if (Number(row[0]) !== child.pid) continue;
    // BSD/Linux add platform-specific flags after the base state. Only the
    // target group matters; unrelated system process flags cannot fail cleanup.
    if (row.length !== 2 || !/^[A-Za-z]\S*$/.test(row[1])) fail("process_group_probe");
    if (row[1].startsWith("Z")) zombies++;
    else live++;
  }
  if (permissionDenied) {
    if (live > 0) fail("process_group_probe");
    if (zombies === 0) {
      // A reap may race ps. Only a new ESRCH proves an empty snapshot is gone;
      // an invisible or inaccessible live group must remain fail-closed.
      try { process.kill(-child.pid, 0); } catch (error) {
        if (error?.code === "ESRCH") return { exists: false, live: 0, zombies: 0 };
      }
      fail("process_group_probe");
    }
  }
  return { exists: live + zombies > 0, live, zombies };
}

function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") fail("process_signal");
  }
}

export async function stopDetachedProcess(child, { graceMs = 5_000, killMs = 5_000, pollMs = 50 } = {}) {
  if (process.platform === "win32") fail("process_groups_unsupported");
  if (!Number.isInteger(child.pid) || child.pid <= 0) fail("process_pid_missing");
  if (hasProcessExited(child) && inspectGroup(child).live === 0) fail("process_early_exit");

  const pause = () => new Promise((resolve) => setTimeout(resolve, pollMs));
  let requestedSignal = "SIGTERM";
  signalGroup(child, requestedSignal);
  let deadline = Date.now() + graceMs;
  // Waiting on both facts also yields to Node's exit event before reading its
  // codes: ESRCH can be observed before that event has been dispatched.
  while ((!hasProcessExited(child) || inspectGroup(child).live > 0) && Date.now() < deadline) await pause();

  if (inspectGroup(child).live > 0) {
    requestedSignal = "SIGKILL";
    signalGroup(child, requestedSignal);
    deadline = Date.now() + killMs;
    while ((!hasProcessExited(child) || inspectGroup(child).live > 0) && Date.now() < deadline) await pause();
  }

  const leaderExited = hasProcessExited(child);
  const group = inspectGroup(child);
  const processGroupGone = !group.exists;
  const liveProcessGroupGone = group.live === 0;
  if (!leaderExited || !liveProcessGroupGone) fail("process_termination");
  return {
    exitCode: child.exitCode,
    signal: child.signalCode,
    requestedSignal,
    leaderExited,
    processGroupGone,
    liveProcessGroupGone,
    zombieProcesses: group.zombies,
    groupProbe: "ps-pgid-state",
    controlledCleanup: true,
    gracefulTermination: requestedSignal === "SIGTERM" && (child.signalCode === "SIGTERM" || child.exitCode === 143 || child.exitCode === -15),
  };
}
