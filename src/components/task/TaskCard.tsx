import { useEffect, useMemo, useRef, type DragEvent } from "react";
import { ArrowDown, ArrowUp, ChevronRight, GripVertical, Lock, SkipForward, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { subAgentSteps, subAgentViews } from "@/lib/subagents";
import { stepProgress } from "@/lib/steps";
import { usageTotals } from "@/lib/timeline";
import { useTasks, type TaskCard as Card } from "@/stores/tasks";
import { ConfirmPrompt } from "./ConfirmPrompt";
import { MemoryPrompt } from "./MemoryPrompt";
import { SaveSkill } from "./SaveSkill";
import { STEP_LABEL, StatusBadge, StepIcon } from "./status";

export interface TaskCardProps {
  card: Card;
  index: number;
  count: number;
  active: boolean;
  dragging: boolean;
  dropTarget: boolean;
  onMove(id: string, toIndex: number): void;
  onDragStart(id: string, e: DragEvent): void;
  onDragOver(id: string, e: DragEvent): void;
  onDrop(id: string, e: DragEvent): void;
  onDragEnd(): void;
}

// 每张卡片是一个独立的 Agent 工作空间：计划进度、权限确认、成果都在卡片里
export function TaskCard({ card, index, count, active, dragging, dropTarget, onMove, onDragStart, onDragOver, onDrop, onDragEnd }: TaskCardProps) {
  const { toggleCollapse, close, cancel, select, respond } = useTasks();
  const ref = useRef<HTMLElement>(null);
  // 多 Agent 协同时每个子 Agent 一行；否则是当前计划的步骤
  const steps = useMemo(() => {
    const agents = subAgentViews(card.events);
    return agents.length ? subAgentSteps(agents) : stepProgress(card.events);
  }, [card.events]);
  const usage = useMemo(() => usageTotals(card.events), [card.events]);
  const body = `${card.id}-body`;
  const running = card.status === "running";

  // 移到首位或末位后，被点的按钮会变成禁用而丢失焦点：把焦点交给另一个方向的按钮
  useEffect(() => {
    const el = ref.current;
    if (el && el.contains(document.activeElement) && (document.activeElement as HTMLButtonElement).disabled) {
      el.querySelector<HTMLButtonElement>("[data-move]:not(:disabled)")?.focus();
    }
  }, [index]);

  return (
    <article
      ref={ref}
      aria-label={`任务：${card.goal}`}
      aria-current={active ? "true" : undefined}
      onFocus={() => !active && select(card.id)}
      onClick={() => !active && select(card.id)}
      onDragOver={(e) => onDragOver(card.id, e)}
      onDrop={(e) => onDrop(card.id, e)}
      className={cn(
        "rounded-lg border bg-surface-2 transition-opacity",
        active ? "border-east-red/60" : "border-border",
        dropTarget && "border-dashed border-foreground",
        dragging && "opacity-50",
      )}
    >
      <header className="flex items-center gap-2 px-3 py-2">
        {/* 拖拽手柄只服务指针；键盘和单指操作用右侧的上移、下移按钮（WCAG 2.5.7） */}
        <span
          aria-hidden
          draggable
          onDragStart={(e) => onDragStart(card.id, e)}
          onDragEnd={onDragEnd}
          title="拖动排序"
          className="cursor-grab text-muted-foreground active:cursor-grabbing"
        >
          <GripVertical className="size-4" />
        </span>
        <h3 className="min-w-0 flex-1">
          <button
            type="button"
            aria-expanded={!card.collapsed}
            aria-controls={body}
            onClick={() => toggleCollapse(card.id)}
            className="flex w-full items-center gap-2 rounded-sm text-left text-sm font-medium"
          >
            <ChevronRight aria-hidden className={cn("size-4 shrink-0 transition-transform", !card.collapsed && "rotate-90")} />
            <span className="truncate" title={card.goal}>
              {card.goal}
            </span>
          </button>
        </h3>
        {card.override && (
          <Badge title="手动干预">
            {card.override.mode === "lock" ? <Lock aria-hidden /> : <SkipForward aria-hidden />}
            {card.override.mode === "lock" ? "已锁定" : "下一步"} {card.override.profileId}
          </Badge>
        )}
        {card.multi && <Badge>多 Agent</Badge>}
        <StatusBadge status={card.status} />
        <Button data-move size="icon" variant="ghost" className="size-8" aria-label="上移" disabled={index === 0} onClick={() => onMove(card.id, index - 1)}>
          <ArrowUp aria-hidden />
        </Button>
        <Button data-move size="icon" variant="ghost" className="size-8" aria-label="下移" disabled={index === count - 1} onClick={() => onMove(card.id, index + 1)}>
          <ArrowDown aria-hidden />
        </Button>
        {running && (
          <Button size="icon" variant="ghost" className="size-8" aria-label="停止任务" onClick={() => cancel(card.id)}>
            <Square aria-hidden />
          </Button>
        )}
        <Button size="icon" variant="ghost" className="size-8" aria-label="关闭任务" onClick={() => close(card.id)}>
          <X aria-hidden />
        </Button>
      </header>

      <div id={body} hidden={card.collapsed} className="space-y-4 border-t border-border px-4 py-4">
        {card.pendingConfirm && <ConfirmPrompt req={card.pendingConfirm} onRespond={(ok) => respond(card.id, ok)} />}
        {card.proposal && <MemoryPrompt taskId={card.id} proposal={card.proposal} />}
        {steps.length > 0 && (
          <ol aria-label="执行步骤" className="space-y-1 text-sm">
            {steps.map((s) => (
              <li key={s.id} className="flex items-center gap-2">
                <StepIcon state={s.state} />
                <span className="sr-only">{STEP_LABEL[s.state]}：</span>
                <span className={cn("min-w-0 flex-1 truncate", s.state === "pending" && "text-muted-foreground")}>{s.goal}</span>
                {s.tool && <code className="font-mono text-xs text-muted-foreground">{s.tool}</code>}
              </li>
            ))}
          </ol>
        )}
        {steps.length === 0 && running && <p className="text-sm text-muted-foreground">正在分析任务…</p>}
        {card.summary && (
          <section aria-label={card.status === "completed" ? "成果" : "结果"} className="rounded-md bg-surface p-3">
            <p aria-hidden className="mb-1 text-xs text-muted-foreground">{card.status === "completed" ? "成果" : "结果"}</p>
            <p className="whitespace-pre-wrap text-sm">{card.summary}</p>
          </section>
        )}
        {card.status === "completed" && <SaveSkill card={card} />}
        <p className="text-xs text-muted-foreground">
          模型调用 {usage.calls} 次 · {usage.tokens > 0 ? `${usage.tokens} tokens` : "token 数未知"}
        </p>
      </div>
    </article>
  );
}
