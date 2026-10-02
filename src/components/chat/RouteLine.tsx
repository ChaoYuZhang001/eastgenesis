import { useId, useState } from "react";
import { ChevronRight, TriangleAlert } from "lucide-react";
import { CHAIN_STAGE_LABEL } from "@/components/panel/RoutePanel";
import { Badge } from "@/components/ui/input";
import { displayModel, fallbackVerb, routeLineText, type RouteSummary } from "@/lib/route-summary";
import { cn } from "@/lib/utils";

// 每条回答下面的一行路由记录：折叠时一行，展开后是任务类型、候选模型、降级记录。
// 不出现内部评分和成本档位（那些只在专家模式的路由面板里）。
export function RouteLine({ summary, durationMs }: { summary: RouteSummary; durationMs: number | null }) {
  const [open, setOpen] = useState(false);
  const body = useId();

  return (
    <div className="text-xs text-muted-foreground">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={body}
        onClick={() => setOpen((v) => !v)}
        className="flex max-w-full items-center gap-1 rounded-sm text-left transition-colors hover:text-foreground"
      >
        <ChevronRight aria-hidden className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="truncate">{routeLineText(summary, durationMs)}</span>
        <span className="shrink-0">· 查看路由决策</span>
      </button>

      <div id={body} hidden={!open} role="region" aria-label="路由决策详情" className="mt-2 space-y-3 rounded-md border border-border p-3">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt>任务类型</dt>
          <dd className="text-foreground">{summary.taskType}</dd>
          <dt>需要的能力</dt>
          <dd className="text-foreground">{summary.needs.length ? summary.needs.join("、") : "无特殊要求"}</dd>
        </dl>

        {summary.locked ? (
          <p className="text-foreground">你手动锁定了 {displayModel(summary.candidates[0]?.profileId ?? "")}，本次跳过路由决策。</p>
        ) : summary.noModel ? (
          <p className="flex gap-2">
            <TriangleAlert aria-hidden className="size-4 shrink-0 text-china-gold" />
            没有可用模型：{summary.noModel}
          </p>
        ) : (
          <div className="space-y-1">
            <p>候选模型</p>
            <ol aria-label="候选模型" className="space-y-1">
              {summary.candidates.map((c) => (
                <li key={c.profileId} className="flex flex-wrap items-center gap-2">
                  <Badge>{CHAIN_STAGE_LABEL[c.stage]}</Badge>
                  <span className="break-all font-mono text-foreground">{displayModel(c.profileId)}</span>
                  <span>{c.why}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {summary.fallbacks.length > 0 && (
          <div className="space-y-1">
            <p>降级记录</p>
            <ul aria-label="降级记录" className="space-y-1">
              {summary.fallbacks.map((f) => (
                <li key={`${f.from}-${f.to}-${f.reason}`} className="break-words text-foreground">
                  {fallbackVerb(f)} {displayModel(f.to)}（{displayModel(f.from)} {f.timeout ? "" : "失败："}{f.reason}）
                  {f.times > 1 && <span className="text-muted-foreground"> ×{f.times} 次调用</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {summary.failures.length > 0 && (
          <div className="space-y-1">
            <p className="flex gap-2">
              <TriangleAlert aria-hidden className="size-4 shrink-0 text-china-gold" />
              降级链上的模型都没有成功
            </p>
            <ul aria-label="失败记录" className="space-y-1">
              {summary.failures.map((f) => (
                <li key={f.profileId} className="break-words text-foreground">
                  {displayModel(f.profileId)}：{f.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        {summary.retries > 0 && <p>超时后重试 {summary.retries} 次</p>}
      </div>
    </div>
  );
}
