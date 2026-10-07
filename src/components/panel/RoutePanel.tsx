import { TriangleAlert } from "lucide-react";
import { CAP_LABEL, TYPE_LABEL, WORK_SURFACE_HINT, WORK_SURFACE_LABEL, routeTraceText, type ChainStage, type DecisionMeta, type ModelProfile, type RouteDecision, type RouteReplayResult, type RouteTrace, type Weights } from "@/decision";
import { Badge } from "@/components/ui/input";
import { BACKEND_LABEL } from "@/lib/timeline";

export const CHAIN_STAGE_LABEL: Record<ChainStage, string> = { primary: "首选", fallback: "备选", rule_fallback: "兜底" };
const WEIGHT_LABEL: Record<keyof Weights, string> = { capability: "能力匹配", quality: "质量", cost: "成本", latency: "延迟" };
const pct = (n: number) => `${Math.round(n * 100)}%`;

/** 路由是否带有可脱敏回放的历史快照；摘要只展示计数和 FNV 摘要，不展示正文或文件内容。 */
export function RouteEvidence({ trace, replay }: { trace?: RouteTrace; replay?: RouteReplayResult | null }) {
  if (!trace?.snapshot) return <span>旧记录：没有历史快照，不能重算</span>;
  const { snapshot } = trace;
  return (
    <div className="space-y-1">
      <p>历史快照已记录（可用于脱敏回放）：{snapshot.profiles.length} 个模型、{snapshot.availability.length} 条可用性</p>
      <details>
        <summary className="cursor-pointer text-muted-foreground">查看快照摘要</summary>
        <p className="mt-1 break-words text-muted-foreground">能力矩阵摘要：{snapshot.profileSetId} · 可用性摘要：{snapshot.availabilitySetId}</p>
        {replay && (
          <p className="mt-1 break-words text-muted-foreground">
            历史链重算：{replay.sourceSnapshotConsistent === false ? "不一致" : "一致"} · 当前重放：{replay.changed ? "已变化" : "未变化"}
            {replay.profileSnapshotChanged ? " · 能力矩阵已变化" : ""}
            {replay.availabilitySnapshotChanged ? " · Provider 可用性已变化" : ""}
          </p>
        )}
      </details>
    </div>
  );
}

// 路由面板：为什么选这个模型、备选链、权重、被排除的模型，以及做决策的是哪一级后端
export function RoutePanel({ route, profiles }: { route: { decision: RouteDecision; meta: DecisionMeta } | null; profiles: readonly ModelProfile[] }) {
  if (!route) return <p className="text-sm text-muted-foreground">还没有路由决策。</p>;
  const { decision: d, meta } = route;
  const c = d.classification;
  const tier = (id: string) => profiles.find((p) => p.id === id)?.cost_tier;

  return (
    <div className="space-y-4 text-sm">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">任务类型</dt>
        <dd>
          {TYPE_LABEL[c.type] ?? c.type}（置信度 {c.confidence.toFixed(2)}）
        </dd>
        <dt className="text-muted-foreground">工作能力</dt>
        <dd>
          {WORK_SURFACE_LABEL[c.surface ?? "chat"]}（{c.surfaceReason ?? WORK_SURFACE_HINT[c.surface ?? "chat"]}）
        </dd>
        <dt className="text-muted-foreground">所需能力</dt>
        <dd>{c.capabilities.length ? c.capabilities.map((k) => CAP_LABEL[k] ?? k).join("、") : "无特殊要求"}</dd>
        <dt className="text-muted-foreground">估算输入</dt>
        <dd>约 {c.estTokens} tokens</dd>
        {c.signals.length > 0 && (
          <>
            <dt className="text-muted-foreground">命中信号</dt>
            <dd className="break-words">{c.signals.join("、")}</dd>
          </>
        )}
        <dt className="text-muted-foreground">决策来源</dt>
        <dd>
          {BACKEND_LABEL[meta.backend]}（第 {meta.level} 级，{meta.latencyMs} ms）
        </dd>
        <dt className="text-muted-foreground">路由策略</dt>
        <dd>{d.trace?.policyVersion ?? "历史记录（无策略版本）"}</dd>
        {d.trace && (
          <>
            <dt className="text-muted-foreground">输入摘要</dt>
            <dd>{routeTraceText(d.trace)}</dd>
            <dt className="text-muted-foreground">路由证据</dt>
            <dd><RouteEvidence trace={d.trace} /></dd>
          </>
        )}
      </dl>

      {meta.degraded && (
        <p className="flex gap-2 text-xs">
          <TriangleAlert aria-hidden className="size-4 shrink-0 text-china-gold" />
          <span>
            已降级：{meta.skipped.map((s) => `${BACKEND_LABEL[s.backend]}（${s.reason}）`).join("；") || "上一级不可用"}
          </span>
        </p>
      )}

      {d.chain.length === 0 ? (
        <p className="flex gap-2 text-xs">
          <TriangleAlert aria-hidden className="size-4 shrink-0 text-china-gold" />
          没有可用模型：{d.reasons.at(-1) ?? "全部被排除"}
        </p>
      ) : (
        <ol aria-label="模型调用链" className="space-y-2">
          {d.chain.map((e) => (
            <li key={e.profileId} className="rounded-md border border-border p-2">
              <p className="flex flex-wrap items-center gap-2">
                <Badge>{CHAIN_STAGE_LABEL[e.stage]}</Badge>
                <span className="break-all font-mono text-xs">{e.profileId}</span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                得分 {e.score.toFixed(2)}
                {tier(e.profileId) !== undefined && ` · 成本档位 ${tier(e.profileId)}/5`}
                {e.reason && ` · ${e.reason}`}
              </p>
            </li>
          ))}
        </ol>
      )}

      <p className="text-xs text-muted-foreground">
        权重：{(Object.keys(WEIGHT_LABEL) as (keyof Weights)[]).map((k) => `${WEIGHT_LABEL[k]} ${pct(d.weights[k])}`).join(" · ")}
      </p>

      {d.excluded.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">被排除的模型（{d.excluded.length}）</summary>
          <ul className="mt-2 space-y-1">
            {d.excluded.map((x) => (
              <li key={x.profileId} className="break-words">
                <span className="font-mono">{x.profileId}</span>：{x.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
