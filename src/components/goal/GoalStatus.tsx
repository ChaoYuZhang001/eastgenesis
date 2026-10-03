import { CircleCheck, CircleDashed, CircleHelp, CirclePause, CircleSlash, CircleX, LoaderCircle, type LucideIcon } from "lucide-react";
import { GOAL_STATUS_LABEL, goalPhase, type Goal, type GoalStatus } from "@/decision/goal";
import { cn } from "@/lib/utils";

// 目标状态：图标形状 + 文字，颜色只做辅助；成功态不用绿色（docs/UI_LAYOUT_V3.md 2.4、BRAND.md 4.3）
const ICON: Record<Exclude<GoalStatus, "deleted">, LucideIcon> = {
  idle: CircleDashed,
  running: LoaderCircle,
  paused: CirclePause,
  completed: CircleCheck,
  failed: CircleX,
  abandoned: CircleSlash,
};

/** 状态文字：「等你确认」不是单独的状态，目标仍是进行中，只是最后一轮拿不准（goalPhase = awaiting_user） */
export function goalStatusText(g: Pick<Goal, "status" | "rounds">): string {
  return goalPhase(g) === "awaiting_user" ? "等你确认" : GOAL_STATUS_LABEL[g.status];
}

export function GoalStatusIcon({ goal, className }: { goal: Pick<Goal, "status" | "rounds">; className?: string }) {
  const phase = goalPhase(goal);
  if (phase === "awaiting_user") return <CircleHelp aria-hidden className={cn("size-4 shrink-0", className)} />;
  const Icon = goal.status === "deleted" ? CircleSlash : ICON[goal.status];
  return (
    <Icon
      aria-hidden
      className={cn(
        "size-4 shrink-0",
        // 只在真的在跑时转；「减少动态效果」打开时 globals.css 和 .motion-off 会关掉动画
        phase === "working" && "animate-spin",
        (goal.status === "idle" || goal.status === "paused" || goal.status === "abandoned") && "text-muted-foreground",
        goal.status === "failed" && "text-east-red",
        className,
      )}
    />
  );
}

/** 图标 + 文字的状态标记 */
export function GoalStatusBadge({ goal }: { goal: Pick<Goal, "status" | "rounds"> }) {
  return (
    <span className="inline-flex items-center gap-1">
      <GoalStatusIcon goal={goal} className="size-3" />
      {goalStatusText(goal)}
    </span>
  );
}
