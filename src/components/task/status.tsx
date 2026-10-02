import { Circle, CircleCheck, CircleHelp, CircleSlash, CircleX, Gauge, LoaderCircle, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { StepState } from "@/lib/steps";
import { STATUS_LABEL } from "@/lib/timeline";
import type { TaskStatus } from "@/stores/tasks";

// 状态一律「图标形状 + 文字」，不靠颜色区分；品牌板没有绿色，成功态不引入新强调色（BRAND.md 4.3）
const STATUS_ICON: Record<TaskStatus, LucideIcon> = {
  running: LoaderCircle,
  completed: CircleCheck,
  failed: CircleX,
  aborted: CircleSlash,
  needs_user: CircleHelp,
  budget_exceeded: Gauge,
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  const Icon = STATUS_ICON[status];
  return (
    <Badge className={cn(status === "completed" && "text-foreground", status === "failed" && "border-east-red/60")}>
      <Icon aria-hidden className={cn(status === "running" && "animate-spin", status === "failed" && "text-east-red")} />
      {STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

const STEP_ICON: Record<StepState, LucideIcon> = { pending: Circle, running: LoaderCircle, done: CircleCheck, failed: CircleX };
export const STEP_LABEL: Record<StepState, string> = { pending: "未开始", running: "进行中", done: "已完成", failed: "失败" };

export function StepIcon({ state }: { state: StepState }) {
  const Icon = STEP_ICON[state];
  return (
    <Icon
      aria-hidden
      className={cn(
        "size-4 shrink-0",
        state === "running" && "animate-spin",
        state === "pending" && "text-muted-foreground",
        state === "failed" && "text-east-red",
      )}
    />
  );
}
