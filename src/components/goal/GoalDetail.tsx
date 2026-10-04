import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, ChevronRight, CircleHelp, Ellipsis, LoaderCircle, Pause, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem } from "@/components/ui/menu";
import { FAIL_CAUSE_LABEL, canTransition, failCause, goalPhase, type Goal, type GoalRound, type RoundVerdict } from "@/decision/goal";
import { RouteLine } from "@/components/chat/RouteLine";
import { runGoal } from "@/lib/goal-run";
import { routeSummary } from "@/lib/route-summary";
import { lastRoute } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import { savedText } from "@/lib/savings";
import { sessionSummary } from "@/lib/sidebar-rows";
import { useTasksSavings } from "@/lib/use-savings";
import { useGoals } from "@/stores/goals";
import { useTasks, type TaskCard } from "@/stores/tasks";
import { useProjects } from "@/stores/projects";
import { useDialogs } from "@/stores/dialogs";
import { ConfirmPrompt } from "@/components/task/ConfirmPrompt";
import { PlanPrompt } from "@/components/task/PlanPrompt";
import { STEP_LABEL, StepIcon } from "@/components/task/status";
import { stepProgress } from "@/lib/steps";
import { GoalStatusIcon, goalStatusText } from "./GoalStatus";

// 目标详情（docs/UI_LAYOUT_V3.md 2.3）：开始 / 继续都会启动自动多轮循环（lib/goal-run.ts）。
// 每一轮先改状态、再交给执行器；暂停和放弃由 store 直接停掉正在跑的那一轮。
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
  const tasks = useTasks((s) => s.tasks);
  const mine = useMemo(() => tasks.filter((t) => t.goalId === goal.id), [tasks, goal.id]);
  const saved = savedText(useTasksSavings(mine));
  const [error, setError] = useState<string | null>(null);
  const phase = goalPhase(goal);
  // 正在跑一轮：这一轮的任务卡挂在目标上（不进会话列表），进度和确认提示都从它读
  const working = phase === "working";
  const active = tasks.find((t) => t.id === goal.rounds.at(-1)?.task_id && t.status === "running") ?? null;
  const cause = goal.status === "failed" ? failCause(goal) : null;
  const canAbandon = canTransition(goal.status, "abandoned");
  const run = async (f: () => Promise<string | null>) => setError(await f());

  // 开始 / 继续：先改状态，成功后再启动循环（状态没改成功就不该跑）
  const begin = async () => {
    const err = await start(goal.id);
    if (err) return err;
    runGoal(goal.id);
    return null;
  };
  const main =
    goal.status === "idle" ? { label: "开始", icon: Play, act: begin }
    : goal.status === "paused" ? { label: "继续", icon: Play, act: begin }
    : goal.status === "running" ? { label: "暂停", icon: Pause, act: () => pause(goal.id) }
    : null;

  const status = [
    goalStatusText(goal),
    goal.rounds.length ? `第 ${goal.rounds.length} 轮` : null,
    `模型调用 ${goal.used_llm_calls} / ${goal.max_llm_calls}`,
    project ? project.name : null,
    // 路由摘要：这个目标下各轮用了哪些模型、和最强模式比省了多少（每轮都是一张任务卡，从它们的事件里统计）
    mine.length ? [sessionSummary(mine), saved].filter(Boolean).join(" · ") : null,
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
          {working && (
            <p role="status" className="text-xs text-muted-foreground">
              正在执行第 {goal.rounds.length} 轮；每轮结束会按执行记录判断目标达成没有，没达成就自动开下一轮。
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm">
              {error}
            </p>
          )}
        </header>

        {phase === "awaiting_user" && <AwaitingBar goal={goal} onError={setError} resolve={resolve} />}
        {active && <ActiveRound card={active} />}

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
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            const err = await resolve(goal.id, "continue");
            onError(err);
            // 你确认继续之后才开下一轮：循环自己不推进 uncertain 的那一轮
            if (!err) runGoal(goal.id);
          }}
        >
          继续下一轮
        </Button>
      </div>
    </section>
  );
}

/**
 * 正在跑的那一轮（V3 2.3）：计划模式的计划确认、权限确认和当前步骤都落在这里。
 * 目标轮次不进会话列表，所以这些提示必须在这一页出现，否则会一直挂着等不到人。
 */
function ActiveRound({ card }: { card: TaskCard }) {
  const { respond, respondPlan } = useTasks();
  const steps = useMemo(() => stepProgress(card.events), [card.events]);
  const current = steps.find((s) => s.state === "running") ?? steps.find((s) => s.state === "pending") ?? null;
  return (
    <section role="region" aria-label="正在执行的一轮" className="space-y-3 rounded-lg border border-border bg-surface-2 p-4">
      <p role="status" className="flex items-center gap-2 text-sm">
        <LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin" />
        <span className="min-w-0 flex-1 truncate">{current ? current.goal : "正在准备下一步"}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          第 {steps.filter((s) => s.state === "done").length} / {steps.length} 步
        </span>
      </p>
      {card.pendingPlan && <PlanPrompt plan={card.pendingPlan} onRespond={(ok) => respondPlan(card.id, ok)} />}
      {card.pendingConfirm && <ConfirmPrompt req={card.pendingConfirm} onRespond={(ok) => respond(card.id, ok)} />}
    </section>
  );
}

function RoundsList({ goal }: { goal: Goal }) {
  const rounds = goal.rounds;
  // 每一轮都是一张任务卡（执行器建的），轮次记着它的 id：展开一轮能看到那一轮的执行过程
  const tasks = useTasks((s) => s.tasks);
  if (!rounds.length) return <p className="text-sm text-muted-foreground">还没有开始任何一轮。</p>;
  return (
    <ol aria-label="轮次" className="space-y-3">
      {rounds.map((r, i) => (
        <RoundItem key={r.index} round={r} defaultOpen={i === rounds.length - 1} card={tasks.find((t) => t.id === r.task_id)} />
      ))}
    </ol>
  );
}

function RoundItem({ round, defaultOpen, card }: { round: GoalRound; defaultOpen: boolean; card?: TaskCard }) {
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
  // 这一轮的折叠路由行（V3 5.2）：模型、降级、省了多少，点开是路由决策和执行过程
  const events = card?.events ?? [];
  const summary = useMemo(() => routeSummary(lastRoute(events), events), [events]);
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
        {summary && card && <RouteLine summary={summary} durationMs={card.endedAt ? card.endedAt - card.startedAt : null} card={card} />}
        {round.status === "running" && <p className="text-xs text-muted-foreground">这一轮还在跑，结束后才有判定。</p>}
      </div>
    </li>
  );
}
