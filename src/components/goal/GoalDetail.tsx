import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, ChevronRight, CircleHelp, Ellipsis, Pause, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem } from "@/components/ui/menu";
import { FAIL_CAUSE_LABEL, canTransition, failCause, goalPhase, type Goal, type GoalRound, type RoundVerdict } from "@/decision/goal";
import { cn } from "@/lib/utils";
import { useGoals } from "@/stores/goals";
import { useProjects } from "@/stores/projects";
import { useDialogs } from "@/stores/dialogs";
import { STEP_LABEL, StepIcon } from "@/components/task/status";
import { GoalStatusIcon, goalStatusText } from "./GoalStatus";

// 目标详情（docs/UI_LAYOUT_V3.md 2.3）。M9 只接 M8 的 store：「开始」只改状态，
// 自动多轮循环、每轮调 checkDoneWithEvidence、用量上限检测在 M10 接上。
const ROUND_LABEL: Record<GoalRound["status"], string> = {
  running: "进行中",
  done: "已完成",
  not_done: "未完成",
  uncertain: "拿不准",
  failed: "执行出错",
  interrupted: "被打断",
};
const BY_LABEL: Record<RoundVerdict["by"], string> = { rules: "规则判定", jev: "Jev 判定", user: "你确认", runtime: "执行出错" };
const VERDICT_LABEL: Record<RoundVerdict["verdict"], string> = { done: "已完成", not_done: "未完成", uncertain: "拿不准" };

export function verdictText(v: RoundVerdict): string {
  if (v.by === "runtime") return `执行出错：${v.reason}`;
  const conf = v.by === "jev" && v.confidence !== undefined ? `（置信度 ${v.confidence.toFixed(2)}）` : "";
  return `${BY_LABEL[v.by]}：${VERDICT_LABEL[v.verdict]}${conf}`;
}

export function GoalDetail({ id }: { id: string }) {
  const goal = useGoals((s) => s.items.find((g) => g.id === id) ?? null);
  const loaded = useGoals((s) => s.loaded);
  if (!goal) {
    return (
      <main aria-label="目标" className="flex min-w-0 flex-1 items-center justify-center bg-surface p-8 text-sm text-muted-foreground">
        {loaded ? "这个目标已被删除或不存在。" : "读取中…"}
      </main>
    );
  }
  return <GoalView goal={goal} />;
}

function GoalView({ goal }: { goal: Goal }) {
  const { start, pause, resolve } = useGoals();
  const project = useProjects((s) => (goal.project_id ? s.items.find((p) => p.id === goal.project_id) ?? null : null));
  const ask = useDialogs((s) => s.ask);
  const [error, setError] = useState<string | null>(null);
  const phase = goalPhase(goal);
  const cause = goal.status === "failed" ? failCause(goal) : null;
  const canAbandon = canTransition(goal.status, "abandoned");
  const run = async (f: () => Promise<string | null>) => setError(await f());

  const main =
    goal.status === "idle" ? { label: "开始", icon: Play, act: () => start(goal.id) }
    : goal.status === "paused" ? { label: "继续", icon: Play, act: () => start(goal.id) }
    : goal.status === "running" ? { label: "暂停", icon: Pause, act: () => pause(goal.id) }
    : null;

  const status = [
    goalStatusText(goal),
    goal.rounds.length ? `第 ${goal.rounds.length} 轮` : null,
    `模型调用 ${goal.used_llm_calls} / ${goal.max_llm_calls}`,
    project ? project.name : null,
  ].filter(Boolean);

  return (
    <main aria-label="目标" className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-surface px-8 py-8">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <header className="space-y-2">
          <div className="flex items-start gap-3">
            <h1 className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xl font-semibold">{goal.description}</h1>
            {main && (
              <Button size="sm" onClick={() => void run(main.act)}>
                <main.icon aria-hidden />
                {main.label}
              </Button>
            )}
            <Menu label="目标的更多操作" title="更多操作" align="end" width="w-48" trigger={<Ellipsis aria-hidden className="size-4" />}
              triggerClassName="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground">
              {canAbandon && (
                <MenuItem icon={<Archive aria-hidden />} onSelect={() => ask({ kind: "abandon-goal", id: goal.id })}>
                  放弃目标…
                </MenuItem>
              )}
              <MenuItem icon={<Trash2 aria-hidden />} onSelect={() => ask({ kind: "delete-goal", id: goal.id })}>
                删除目标…
              </MenuItem>
            </Menu>
          </div>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <GoalStatusIcon goal={goal} className="size-3" />
            {status.join(" · ")}
          </p>
          {cause && <p className="text-sm">失败原因：{FAIL_CAUSE_LABEL[cause]}</p>}
          {goal.status === "running" && phase !== "awaiting_user" && (
            <p className="text-xs text-muted-foreground">自动多轮执行还没有接入（M10），现在只记录状态。</p>
          )}
          {error && (
            <p role="alert" className="text-sm">
              {error}
            </p>
          )}
        </header>

        {phase === "awaiting_user" && <AwaitingBar goal={goal} onError={setError} resolve={resolve} />}

        <RoundsList goal={goal} />
      </div>
    </main>
  );
}

// 最后一轮拿不准：不自动进入下一轮，也不自动收尾，等你确认
function AwaitingBar({ goal, resolve, onError }: { goal: Goal; resolve: (id: string, c: "done" | "continue") => Promise<string | null>; onError: (e: string | null) => void }) {
  const last = goal.rounds[goal.rounds.length - 1];
  return (
    <section role="region" aria-label="等你确认" className="space-y-3 rounded-lg border border-border bg-surface-2 p-4">
      <p className="flex items-center gap-2 text-sm">
        <CircleHelp aria-hidden className="size-4 shrink-0 text-china-gold" />
        <span>
          <span className="font-medium">AI 声称完成，但无实据</span>
          {last?.verdict?.reason && <span className="block text-muted-foreground">{last.verdict.reason}</span>}
        </span>
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={async () => onError(await resolve(goal.id, "done"))}>
          确认已完成
        </Button>
        <Button size="sm" variant="outline" onClick={async () => onError(await resolve(goal.id, "continue"))}>
          继续下一轮
        </Button>
      </div>
    </section>
  );
}

function RoundsList({ goal }: { goal: Goal }) {
  const rounds = goal.rounds;
  if (!rounds.length) return <p className="text-sm text-muted-foreground">还没有开始任何一轮。</p>;
  return (
    <ol aria-label="轮次" className="space-y-3">
      {rounds.map((r, i) => (
        <RoundItem key={r.index} round={r} defaultOpen={i === rounds.length - 1} />
      ))}
    </ol>
  );
}

function RoundItem({ round, defaultOpen }: { round: GoalRound; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) first.current = false;
    else if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  const body = `round-${round.index}`;
  const steps = useMemo(
    () => round.items.map((it) => ({ ...it, state: it.status === "skipped" ? ("pending" as const) : it.status })),
    [round.items],
  );
  return (
    <li className="rounded-lg border border-border">
      <button type="button" aria-expanded={open} aria-controls={body} onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm">
        <ChevronRight aria-hidden className={cn("size-4 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="min-w-0 flex-1 truncate font-medium">
          第 {round.index} 轮{round.title ? ` · ${round.title}` : ""}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{ROUND_LABEL[round.status]}</span>
      </button>
      <div id={body} hidden={!open} className="space-y-3 border-t border-border px-4 py-3 text-sm">
        {steps.length > 0 ? (
          <ol aria-label={`第 ${round.index} 轮的步骤`} className="space-y-1">
            {steps.map((s) => (
              <li key={s.id} className="flex items-center gap-2">
                <StepIcon state={s.state} />
                <span className="sr-only">{STEP_LABEL[s.state]}：</span>
                <span className={cn("min-w-0 flex-1", s.state === "pending" && "text-muted-foreground")}>{s.text}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-muted-foreground">这一轮没有记录步骤。</p>
        )}
        {round.verdict && <p className="text-muted-foreground">{verdictText(round.verdict)}</p>}
      </div>
    </li>
  );
}
