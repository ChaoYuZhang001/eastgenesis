// 桌面黄金路径的脱敏验收证据。
// 这份结构故意不包含任务正文、工具参数、工具输出、路径或推理内容，
// 只保留可以复盘“谁做的、为什么、什么时候、是否恢复”的字段。
import type { AgentEvent } from "@/agent";
import type { RouteTrace, WorkSurface } from "@/decision";
import type { TaskCard } from "@/stores/tasks";
import { redact } from "@/core/redact";

const MAX_REASON = 200;
const chars = (value: string | null | undefined) => (value ? Array.from(value).length : 0);

export interface DesktopEvidenceRoute {
  kind: "task" | "step";
  /** step 路由的稳定 ID；任务级路由为 null，不携带步骤目标正文。 */
  stepId: string | null;
  /** step 路由实际使用的能力面；任务级路由为 null。 */
  surface: WorkSurface | null;
  recordedAt: number | null;
  profileId: string | null;
  provider: string | null;
  policyVersion: string | null;
  backend: string;
  degraded: boolean;
  chain: { profileId: string; provider: string; stage: string }[];
  input: Pick<RouteTrace["input"], "textChars" | "attachmentCount" | "attachmentKinds" | "attachmentChars" | "preference" | "latency" | "maxCostTier" | "surfaceHint" | "lock"> | null;
  snapshot: { profileSetId: string; availabilitySetId: string; profiles: number; availability: number } | null;
  reason: string | null;
}

export interface DesktopEvidence {
  schemaVersion: 1;
  capturedAt: number;
  task: {
    id: string;
    status: TaskCard["status"];
    startedAt: number;
    endedAt: number | null;
    durationMs: number | null;
    mode: TaskCard["mode"];
    preference: TaskCard["preference"];
    preferenceSource: TaskCard["preferenceSource"];
    permission: TaskCard["permission"];
    filesCount: number;
    goalChars: number;
  };
  routes: DesktopEvidenceRoute[];
  /** 这条任务实际经过的能力面，按执行顺序去重；只保留固定枚举，不含目标或工具内容。 */
  surfaceJourney: WorkSurface[];
  models: {
    calls: number;
    firstCallAt: number | null;
    lastCallAt: number | null;
    successful: string[];
    attempted: string[];
    providers: string[];
    fallbackCount: number;
    retries: number;
  };
  stream: {
    partialOutput: boolean;
    firstChunkAt: number | null;
    lastChunkAt: number | null;
    partialOutputChars: number;
    summaryChars: number;
  };
  tools: {
    calls: number;
    firstCallAt: number | null;
    lastCallAt: number | null;
    succeeded: number;
    failed: number;
    artifacts: number;
    ledgerStates: Record<string, number>;
  };
  events: {
    total: number;
    firstRecordedAt: number | null;
    lastRecordedAt: number | null;
    byType: Record<string, number>;
    recoveries: number;
    runEndStatus: string | null;
  };
  privacy: {
    omitted: readonly [
      "goal",
      "tool_args",
      "tool_output",
      "file_paths",
      "file_contents",
      "reasoning",
      "raw_event_text",
    ];
  };
}

type RouteEvent = Extract<AgentEvent, { type: "route" | "step_route" }>;

function providerOf(profileId: string | null): string | null {
  if (!profileId) return null;
  const slash = profileId.indexOf("/");
  return slash > 0 ? profileId.slice(0, slash) : profileId;
}

function safeReason(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  return redact(value).slice(0, MAX_REASON);
}

function inputOf(trace: RouteTrace | undefined): DesktopEvidenceRoute["input"] {
  if (!trace) return null;
  const input = trace.input;
  return {
    textChars: input.textChars,
    attachmentCount: input.attachmentCount,
    attachmentKinds: [...input.attachmentKinds],
    attachmentChars: input.attachmentChars,
    preference: input.preference,
    latency: input.latency,
    ...(input.maxCostTier === undefined ? {} : { maxCostTier: input.maxCostTier }),
    ...(input.surfaceHint === undefined ? {} : { surfaceHint: input.surfaceHint }),
    ...(input.lock === undefined ? {} : { lock: input.lock }),
  };
}

function routeOf(event: RouteEvent): DesktopEvidenceRoute {
  const trace = event.decision.trace;
  return {
    kind: event.type === "route" ? "task" : "step",
    stepId: event.type === "step_route" ? event.step.id : null,
    surface: event.type === "step_route" ? event.surface ?? event.decision.classification.surface ?? null : null,
    recordedAt: event.recordedAt ?? null,
    profileId: event.profileId,
    provider: providerOf(event.profileId),
    policyVersion: trace?.policyVersion ?? null,
    backend: event.meta.backend,
    degraded: event.meta.degraded,
    chain: event.decision.chain.map((entry) => ({ profileId: entry.profileId, provider: entry.provider, stage: entry.stage })),
    input: inputOf(trace),
    snapshot: trace?.snapshot
      ? {
          profileSetId: trace.snapshot.profileSetId,
          availabilitySetId: trace.snapshot.availabilitySetId,
          profiles: trace.snapshot.profiles.length,
          availability: trace.snapshot.availability.length,
        }
      : null,
    reason: safeReason(event.decision.primary?.reason ?? event.reasons.at(-1)),
  };
}

function flatten(events: readonly AgentEvent[]): AgentEvent[] {
  return events.flatMap((event) => (event.type === "subagent" ? [event, ...flatten([event.event])] : [event]));
}

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function surfaceOf(event: AgentEvent): WorkSurface | null {
  if (event.type === "step_start") return event.surface ?? null;
  if (event.type === "step_route") return event.surface ?? event.decision.classification.surface ?? null;
  return null;
}

/** 生成可复制到验收记录、CI 附件或 issue 的脱敏证据。now 仅用于让单测固定 capturedAt。 */
export function desktopEvidenceOf(card: TaskCard, now = Date.now()): DesktopEvidence {
  const events = flatten(card.events);
  const byType: Record<string, number> = {};
  const routes: DesktopEvidenceRoute[] = [];
  const stepSurfaces: WorkSurface[] = [];
  const taskSurfaces: WorkSurface[] = [];
  const seenStepSurfaces = new Set<WorkSurface>();
  const seenTaskSurfaces = new Set<WorkSurface>();
  const successful = new Set<string>();
  const attempted = new Set<string>();
  const providers = new Set<string>();
  let calls = 0;
  let firstCallAt: number | null = null;
  let lastCallAt: number | null = null;
  let fallbackCount = 0;
  let retries = 0;
  let toolCalls = 0;
  let firstToolCallAt: number | null = null;
  let lastToolCallAt: number | null = null;
  let succeeded = 0;
  let failed = 0;
  let artifacts = 0;
  let recoveries = 0;
  let runEndStatus: string | null = null;
  const recordedTimes = events.map((event) => event.recordedAt).filter((at): at is number => typeof at === "number");
  const ledgerStates: Record<string, number> = {};

  for (const event of events) {
    increment(byType, event.type);
    const surface = surfaceOf(event);
    if (surface && !seenStepSurfaces.has(surface)) {
      seenStepSurfaces.add(surface);
      stepSurfaces.push(surface);
    }
    if (event.type === "route") {
      const taskSurface = event.decision.classification.surface;
      if (taskSurface && !seenTaskSurfaces.has(taskSurface)) {
        seenTaskSurfaces.add(taskSurface);
        taskSurfaces.push(taskSurface);
      }
    }
    if (event.type === "route" || event.type === "step_route") {
      routes.push(routeOf(event));
      continue;
    }
    if (event.type === "llm") {
      calls++;
      if (event.recordedAt !== undefined) {
        firstCallAt ??= event.recordedAt;
        lastCallAt = event.recordedAt;
      }
      successful.add(event.profileId);
      attempted.add(event.profileId);
      const provider = providerOf(event.profileId);
      if (provider) providers.add(provider);
      fallbackCount += event.fallbacks?.length ?? 0;
      retries += event.retries ?? 0;
      for (const fallback of event.fallbacks ?? []) {
        attempted.add(fallback.profileId);
        const fallbackProvider = providerOf(fallback.profileId);
        if (fallbackProvider) providers.add(fallbackProvider);
      }
      continue;
    }
    if (event.type === "llm_failed") {
      retries += event.retries ?? 0;
      fallbackCount += event.attempts.length;
      for (const attempt of event.attempts) {
        attempted.add(attempt.profileId);
        const provider = providerOf(attempt.profileId);
        if (provider) providers.add(provider);
      }
      continue;
    }
    if (event.type === "tool_result") {
      toolCalls++;
      if (event.recordedAt !== undefined) {
        firstToolCallAt ??= event.recordedAt;
        lastToolCallAt = event.recordedAt;
      }
      if (event.ok) succeeded++;
      else failed++;
      artifacts += event.artifacts?.length ?? 0;
      increment(ledgerStates, event.executionState ?? "not_recorded");
      continue;
    }
    if (event.type === "probe") {
      if (event.state === "applied") {
        toolCalls++;
        if (event.recordedAt !== undefined) {
          firstToolCallAt ??= event.recordedAt;
          lastToolCallAt = event.recordedAt;
        }
      }
      artifacts += event.artifacts?.length ?? 0;
      increment(ledgerStates, event.state);
      continue;
    }
    if (event.type === "recover") recoveries++;
    if (event.type === "run_end") runEndStatus = event.status;
  }

  return {
    schemaVersion: 1,
    capturedAt: now,
    task: {
      id: card.id,
      status: card.status,
      startedAt: card.startedAt,
      endedAt: card.endedAt,
      durationMs: card.endedAt === null ? null : Math.max(0, card.endedAt - card.startedAt),
      mode: card.mode,
      preference: card.preference,
      preferenceSource: card.preferenceSource,
      permission: card.permission,
      filesCount: card.files.length,
      goalChars: chars(card.goal),
    },
    routes,
    surfaceJourney: stepSurfaces.length ? stepSurfaces : taskSurfaces,
    models: {
      calls,
      firstCallAt,
      lastCallAt,
      successful: [...successful],
      attempted: [...attempted],
      providers: [...providers],
      fallbackCount,
      retries,
    },
    stream: {
      partialOutput: card.streamingInterrupted === true,
      firstChunkAt: card.streamFirstChunkAt ?? null,
      lastChunkAt: card.streamLastChunkAt ?? null,
      partialOutputChars: card.streamingInterrupted ? chars(card.streamingText) : 0,
      summaryChars: chars(card.summary),
    },
    tools: { calls: toolCalls, firstCallAt: firstToolCallAt, lastCallAt: lastToolCallAt, succeeded, failed, artifacts, ledgerStates },
    events: { total: events.length, firstRecordedAt: recordedTimes[0] ?? null, lastRecordedAt: recordedTimes.at(-1) ?? null, byType, recoveries, runEndStatus },
    privacy: {
      omitted: ["goal", "tool_args", "tool_output", "file_paths", "file_contents", "reasoning", "raw_event_text"],
    },
  };
}
