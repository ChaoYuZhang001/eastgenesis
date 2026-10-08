import type { ChildProcess } from "node:child_process";

export function hasProcessExited(child: ChildProcess): boolean;
export function stopDetachedProcess(child: ChildProcess, options?: { graceMs?: number; killMs?: number; pollMs?: number }): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  requestedSignal: "SIGTERM" | "SIGKILL";
  leaderExited: boolean;
  processGroupGone: boolean;
  liveProcessGroupGone: boolean;
  zombieProcesses: number;
  groupProbe: "ps-pgid-state";
  controlledCleanup: boolean;
  gracefulTermination: boolean;
}>;
