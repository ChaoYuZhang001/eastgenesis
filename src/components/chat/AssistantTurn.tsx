import { useId, useMemo, useState } from "react";
import { Brain, ChevronRight, Circle, Paperclip, Square, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmPrompt } from "@/components/task/ConfirmPrompt";
import { MemoryPrompt } from "@/components/task/MemoryPrompt";
import { PlanPrompt } from "@/components/task/PlanPrompt";
import { SaveSkill } from "@/components/task/SaveSkill";
import { STEP_LABEL, StepIcon } from "@/components/task/status";
import { SubAgents } from "@/components/panel/SubAgents";
import { doneText, progressOf } from "@/lib/progress";
import { reasoningParts, type ReasoningPart } from "@/lib/reasoning";
import { formatDuration, routeSummary } from "@/lib/route-summary";
import { stepProgress } from "@/lib/steps";
import { subAgentSteps, subAgentViews } from "@/lib/subagents";
import { lastRoute } from "@/lib/timeline";
import { ACTION_LABEL, artifactsOf, changesOf } from "@/lib/artifacts";
import { cn } from "@/lib/utils";
import { useSettings } from "@/stores/settings";
import { useTasks, type TaskCard } from "@/stores/tasks";
import { useUi } from "@/stores/ui";
import { RouteLine } from "./RouteLine";

// 会话里的一轮：用户那句话 + 助手这一轮的执行与成果。
// 运行中只显示当前那一步，结束后折叠成一行（docs/UI_LAYOUT_SPEC.md D 节）。
export function AssistantTurn({ card }: { card: TaskCard }) {
  const { cancel, respond, respondPlan } = useTasks();
  const running = card.status === "running";
  const events = card.events;
  const agents = useMemo(() => subAgentViews(events), [events]);
  const steps = useMemo(() => (agents.length ? subAgentSteps(agents) : stepProgress(events)), [agents, events]);
  const progress = useMemo(() => progressOf(events), [events]);
  const summary = useMemo(() => routeSummary(lastRoute(events), events), [events]);
  const showReasoning = useSettings((s) => s.showReasoning);
  const thoughts = useMemo(() => (showReasoning ? reasoningParts(events) : []), [events, showReasoning]);
  const duration = (card.endedAt ?? Date.now()) - card.startedAt;

  return (
    <article aria-label={`任务：${card.goal}`} className="space-y-4">
      <div className="flex justify-end">
        <div className="max-w-[80%] space-y-1">
          <p className="whitespace-pre-wrap rounded-lg bg-surface-2 px-4 py-3 text-sm">{card.goal}</p>
          {card.files.length > 0 && (
            <p className="flex flex-wrap justify-end gap-2 text-xs text-muted-foreground">
              {card.files.map((f) => (
                <span key={f} className="flex items-center gap-1">
                  <Paperclip aria-hidden className="size-3" />
                  {f}
                </span>
              ))}
            </p>
          )}
        </div>
      </div>

      <div className="space-y-3">
        {running ? (
          <p role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Circle aria-hidden className="size-2 shrink-0 animate-eg-breathe fill-current text-china-gold" />
            <span className="min-w-0 truncate">{progress.text}</span>
          </p>
        ) : (
          <StepsDisclosure card={card} steps={steps} text={doneText(card.status, progress, formatDuration(duration))} />
        )}

        {card.pendingPlan && <PlanPrompt plan={card.pendingPlan} onRespond={(ok) => respondPlan(card.id, ok)} />}
        {card.pendingConfirm && <ConfirmPrompt req={card.pendingConfirm} onRespond={(ok) => respond(card.id, ok)} />}

        {agents.length > 0 && <MultiAgents agents={agents} />}

        {thoughts.length > 0 && <ReasoningDisclosure parts={thoughts} />}

        {card.summary && (
          <section aria-label={card.status === "completed" ? "成果" : "结果"} className="rounded-md bg-surface p-4">
            <p aria-hidden className="mb-1 text-xs text-muted-foreground">
              {card.status === "completed" ? "成果" : "结果"}
            </p>
            <p className="whitespace-pre-wrap text-sm">{card.summary}</p>
            <TurnFiles events={events} />
          </section>
        )}

        {summary && <RouteLine summary={summary} durationMs={card.endedAt ? duration : null} card={card} />}

        {card.proposal && <MemoryPrompt taskId={card.id} proposal={card.proposal} />}
        {card.status === "completed" && <SaveSkill card={card} />}

        {running && (
          <Button size="sm" variant="outline" onClick={() => cancel(card.id)}>
            <Square aria-hidden />
            停止任务
          </Button>
        )}
      </div>
    </article>
  );
}

// 本轮写入、移动、删除的文件（取自工具调用记录）。点文件名在右侧面板只读预览；面板不自动弹出（V3 第 7 节）
function TurnFiles({ events }: { events: TaskCard["events"] }) {
  const files = useMemo(() => changesOf(artifactsOf(events).files), [events]);
  const openPanel = useUi((s) => s.openPanel);
  if (!files.length) return null;
  const narrow = () => typeof window !== "undefined" && window.innerWidth < 1180;
  return (
    <div className="mt-3 space-y-1 border-t border-border pt-3 text-xs">
      <ul aria-label="改动的文件" className="space-y-1">
        {files.map((f) => (
          <li key={`${f.action}-${f.path}`} className="flex gap-2">
            <span className="shrink-0 text-muted-foreground">{ACTION_LABEL[f.action]}</span>
            {f.action === "deleted" ? (
              <span className="break-all font-mono">{f.path}</span>
            ) : (
              <button type="button" onClick={() => openPanel("files", f.to ?? f.path, narrow())} className="break-all text-left font-mono underline-offset-2 hover:underline">
                {f.to ?? f.path}
              </button>
            )}
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => openPanel("changes", null, narrow())} className="text-muted-foreground hover:text-foreground">
        查看改动（{files.length} 个文件）
      </button>
    </div>
  );
}

// 结束后的一行：点开才看到每一步
function StepsDisclosure({ card, steps, text }: { card: TaskCard; steps: ReturnType<typeof stepProgress>; text: string }) {
  const [open, setOpen] = useState(false);
  const body = useId();
  const failed = card.status !== "completed" && card.status !== "aborted";

  return (
    <div className="text-xs text-muted-foreground">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={body}
        disabled={steps.length === 0}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-sm transition-colors enabled:hover:text-foreground disabled:cursor-default"
      >
        {steps.length > 0 && <ChevronRight aria-hidden className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />}
        <span className={cn(failed && "text-east-red")}>{text}</span>
      </button>
      <div id={body} hidden={!open || steps.length === 0}>
        <ol aria-label="执行步骤" className="mt-2 space-y-1 text-sm">
          {steps.map((s) => (
            <li key={s.id} className="flex items-center gap-2">
              <StepIcon state={s.state} />
              <span className="sr-only">{STEP_LABEL[s.state]}：</span>
              <span className={cn("min-w-0 flex-1 truncate", s.state === "pending" && "text-muted-foreground")}>{s.goal}</span>
              {s.tool && <code className="font-mono text-xs text-muted-foreground">{s.tool}</code>}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

// 推理模型的思考过程（设置里打开才有）：默认折叠，点开是整理后的摘要；只是展示，不进对话上下文
function ReasoningDisclosure({ parts }: { parts: ReasoningPart[] }) {
  const [open, setOpen] = useState(false);
  const body = useId();
  const chars = parts.reduce((n, p) => n + p.text.length, 0);

  return (
    <div className="text-xs text-muted-foreground">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={body}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-sm transition-colors hover:text-foreground"
      >
        <ChevronRight aria-hidden className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        <Brain aria-hidden className="size-3 shrink-0" />
        思考过程 · {chars} 字
      </button>
      <div id={body} hidden={!open} role="region" aria-label="思考过程" className="mt-2 space-y-3 border-l-2 border-border pl-3">
        {parts.map((p, i) => (
          <div key={i} className="space-y-1">
            {parts.length > 1 && <p>{p.label}</p>}
            <p className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words text-sm">{p.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// 多 Agent 协同：默认折叠成一行，点开是每个子 Agent 的角色、模型和进度
function MultiAgents({ agents }: { agents: ReturnType<typeof subAgentViews> }) {
  const [open, setOpen] = useState(false);
  const body = useId();

  return (
    <div className="text-xs text-muted-foreground">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={body}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-sm transition-colors hover:text-foreground"
      >
        <ChevronRight aria-hidden className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        <Users aria-hidden className="size-3 shrink-0" />
        多 Agent 协同 · {agents.length} 个子 Agent
      </button>
      <div id={body} hidden={!open} className="mt-2">
        <SubAgents agents={agents} />
      </div>
    </div>
  );
}
