import { useEffect, useMemo, useRef } from "react";
import { Check, CircleCheck, CircleX, Dot, TriangleAlert, type LucideIcon } from "lucide-react";
import type { AgentEvent } from "@/agent";
import type { ModelProfile } from "@/decision";
import { Badge } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { STAGE_LABEL, toTimeline, type Stage, type Tone } from "@/lib/timeline";

const FLOW: Stage[] = ["analysis", "routing", "tool", "model", "reflect"];
const TONE_ICON: Record<Tone, LucideIcon> = { neutral: Dot, ok: CircleCheck, warn: TriangleAlert, error: CircleX };
const TONE_TEXT: Partial<Record<Tone, string>> = { warn: "注意：", error: "错误：" };

// 执行时间线：任务分析 → 路由决策 → 工具调用 → 模型输出 → 反思，逐条展示用了哪个模型、成本和耗时
export function Timeline({ events, profiles }: { events: readonly AgentEvent[]; profiles: readonly ModelProfile[] }) {
  const items = useMemo(() => toTimeline(events, profiles), [events, profiles]);
  const reached = new Set(items.map((i) => i.stage));
  const end = useRef<HTMLLIElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "nearest" });
  }, [items.length]);

  return (
    <div className="space-y-3">
      <ol aria-label="阶段" className="flex flex-wrap items-center gap-1 text-xs">
        {FLOW.map((s) => (
          <li key={s} className={cn("flex h-6 items-center gap-1 rounded-sm px-2", reached.has(s) ? "bg-accent text-foreground" : "text-muted-foreground")}>
            {reached.has(s) && <Check aria-hidden className="size-3" />}
            {STAGE_LABEL[s]}
            <span className="sr-only">{reached.has(s) ? "（已经过）" : "（未到达）"}</span>
          </li>
        ))}
      </ol>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">提交任务后，这里实时显示每一步的决策。</p>
      ) : (
        <ol role="log" aria-label="执行时间线" className="space-y-2">
          {items.map((it) => {
            const Icon = TONE_ICON[it.tone];
            return (
              <li key={it.key} className="flex gap-2 text-sm">
                {/* h-5 与 text-sm 的行高一致，图标和第一行文字对齐 */}
                <span aria-hidden className="flex h-5 shrink-0 items-center">
                  <Icon className={cn("size-4", it.tone === "warn" && "text-china-gold", it.tone === "error" && "text-east-red", it.tone === "neutral" && "text-muted-foreground")} />
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <Badge>{STAGE_LABEL[it.stage]}</Badge>
                    <span className="break-words">
                      {TONE_TEXT[it.tone] && <span className="sr-only">{TONE_TEXT[it.tone]}</span>}
                      {it.title}
                    </span>
                  </p>
                  {it.detail && <p className="line-clamp-3 break-words text-xs text-muted-foreground">{it.detail}</p>}
                  {(it.costTier !== undefined || it.tokens !== undefined || it.latencyMs !== undefined) && (
                    <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                      {it.costTier !== undefined && <span>成本档位 {it.costTier}/5</span>}
                      {it.tokens !== undefined && <span>{it.tokens} tokens</span>}
                      {it.latencyMs !== undefined && <span>{it.latencyMs} ms</span>}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
          <li ref={end} aria-hidden className="h-0" />
        </ol>
      )}
    </div>
  );
}
