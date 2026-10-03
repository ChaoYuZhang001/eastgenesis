import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronRight, TriangleAlert } from "lucide-react";
import type { AgentEvent } from "@/agent";
import { CHAIN_STAGE_LABEL, RoutePanel } from "@/components/panel/RoutePanel";
import { Intervention } from "@/components/panel/Intervention";
import { SubAgents } from "@/components/panel/SubAgents";
import { Timeline } from "@/components/panel/Timeline";
import { Badge } from "@/components/ui/input";
import { PREFERENCE_SOURCE_LABEL } from "@/decision/project";
import { effectiveProfiles } from "@/lib/engine";
import { displayModel, fallbackVerb, formatDuration, formatTokens, routeLineText, type RouteSummary } from "@/lib/route-summary";
import { PREFERENCE_LABEL } from "@/lib/sidebar-rows";
import { subAgentViews } from "@/lib/subagents";
import { lastRoute } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import { useSettings } from "@/stores/settings";
import type { TaskCard } from "@/stores/tasks";
import { useUi } from "@/stores/ui";

// 每条回答下面的一行路由记录（docs/UI_LAYOUT_V3.md 5.2）：折叠时只有模型和降级，
// 点开是锚在这一行下方的浮层（不推开下面的内容），两个标签：路由决策 / 执行过程。
// 内部评分、四项权重、成本档只在专家模式（设置 › 个人 › 常规）里显示。
export function RouteLine({ summary, durationMs, card }: { summary: RouteSummary; durationMs: number | null; card?: TaskCard }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"route" | "run">("route");
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const body = useId();
  const close = () => {
    setOpen(false);
    btn.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (box.current?.contains(e.target as Node) || btn.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  return (
    <div className="relative text-xs text-muted-foreground">
      <button
        ref={btn}
        type="button"
        aria-expanded={open}
        aria-controls={body}
        aria-haspopup="dialog"
        onClick={() => {
          if (!open) setTab("route");
          setOpen((v) => !v);
        }}
        className="flex max-w-full items-center gap-1 rounded-sm text-left transition-colors hover:text-foreground"
      >
        <ChevronRight aria-hidden className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="truncate">{routeLineText(summary, durationMs)}</span>
        <span className="shrink-0">· {summary.locked ? "查看路由决策" : "为什么选它 · 查看路由决策"}</span>
      </button>

      {open && (
        <div
          ref={box}
          id={body}
          role="dialog"
          aria-label="路由决策"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              close();
            }
          }}
          className="absolute left-0 right-0 top-full z-30 mt-2 max-h-[60vh] overflow-y-auto rounded-md border border-border bg-popover p-4 text-popover-foreground"
        >
          <div role="tablist" aria-label="路由浮层" className="mb-3 flex gap-1 border-b border-border">
            {(["route", "run"] as const).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                className={cn("border-b-2 px-2 py-2 text-xs", tab === t ? "border-east-red text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
                {t === "route" ? "路由决策" : "执行过程"}
              </button>
            ))}
          </div>
          {tab === "route" ? <RouteTab summary={summary} card={card} /> : <RunTab card={card} durationMs={durationMs} summary={summary} />}
        </div>
      )}
    </div>
  );
}

function RouteTab({ summary, card }: { summary: RouteSummary; card?: TaskCard }) {
  const expert = useUi((s) => s.prefs.expert);
  const overrides = useSettings((s) => s.overrides);
  const custom = useSettings((s) => s.custom);
  const profiles = useMemo(() => effectiveProfiles(overrides, custom), [overrides, custom]);
  const route = card ? lastRoute(card.events) : null;
  return (
    <div role="region" aria-label="路由决策详情" className="space-y-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt>任务类型</dt>
        <dd className="text-foreground">{summary.taskType}</dd>
        <dt>需要的能力</dt>
        <dd className="text-foreground">{summary.needs.length ? summary.needs.join("、") : "无特殊要求"}</dd>
        {card && !summary.locked && (
          <>
            <dt>路由偏好</dt>
            <dd className="text-foreground">
              {PREFERENCE_LABEL[card.preference]}（来自{PREFERENCE_SOURCE_LABEL[card.preferenceSource]}）
            </dd>
          </>
        )}
      </dl>

      {summary.locked ? (
        <p className="text-foreground">你手动锁定了 {displayModel(summary.candidates[0]?.profileId ?? "")}，本次跳过路由决策，不会自动降级。</p>
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
                {fallbackVerb(f)} {displayModel(f.to)}（{displayModel(f.from)} {f.timeout ? "" : "失败："}
                {f.reason}）{f.times > 1 && <span className="text-muted-foreground"> ×{f.times} 次调用</span>}
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

      {card?.status === "running" && (
        <section aria-label="手动干预" className="space-y-2 border-t border-border pt-3">
          <p className="text-foreground">手动干预</p>
          <Intervention task={card} profiles={profiles} />
        </section>
      )}

      {expert && route && (
        <section aria-label="内部评分" className="border-t border-border pt-3">
          <RoutePanel route={route} profiles={profiles} />
        </section>
      )}
    </div>
  );
}

function RunTab({ card, durationMs, summary }: { card?: TaskCard; durationMs: number | null; summary: RouteSummary }) {
  const expert = useUi((s) => s.prefs.expert);
  const overrides = useSettings((s) => s.overrides);
  const custom = useSettings((s) => s.custom);
  const profiles = useMemo(() => effectiveProfiles(overrides, custom), [overrides, custom]);
  const events: readonly AgentEvent[] = card?.events ?? [];
  const agents = useMemo(() => subAgentViews(events), [events]);
  const facts = [durationMs !== null ? `耗时 ${formatDuration(durationMs)}` : null, summary.calls > 0 ? `模型调用 ${summary.calls} 次` : null, summary.calls > 0 ? formatTokens(summary.tokens) : null].filter(Boolean);
  return (
    <div className="space-y-3">
      {facts.length > 0 && <p>{facts.join(" · ")}</p>}
      {agents.length > 0 && <SubAgents agents={agents} />}
      <Timeline events={events} profiles={profiles} showCost={expert} />
    </div>
  );
}
