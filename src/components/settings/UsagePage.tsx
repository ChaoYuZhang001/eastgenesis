import { useMemo } from "react";
import { ChartColumn } from "lucide-react";
import type { AgentEvent } from "@/agent";
import { displayModel } from "@/lib/route-summary";
import { PRICES, PRICES_CHECKED, SAVINGS_HINT, callCost, savedText } from "@/lib/savings";
import { useTasks } from "@/stores/tasks";
import { monthStart, savingsOfCalls, useUsage } from "@/stores/usage";
import { EmptyState, SettingsSection } from "./controls";

// 使用情况（docs/UI_LAYOUT_V3.md 第 8 节「个人 › 使用情况」）：按模型的调用、tokens、按官方标价估算的花费，
// 和「全部交给最强模式」相比省了多少。数据来自本次启动以来的任务（内存），重启后清零；调用记录持久化还没做。
export interface UsageRow {
  model: string;
  calls: number;
  tokens: number;
  /** 有单价且有用量时的估算花费；没有单价为 null */
  cost: number | null;
  /** 没有返回用量的调用数 */
  noUsage: number;
}

export function usageByModel(events: readonly AgentEvent[][]): UsageRow[] {
  const by = new Map<string, UsageRow>();
  for (const list of events) {
    for (const outer of list) {
      const e = outer.type === "subagent" ? outer.event : outer;
      if (e.type !== "llm") continue;
      const r = by.get(e.profileId) ?? { model: e.profileId, calls: 0, tokens: 0, cost: PRICES[e.profileId] ? 0 : null, noUsage: 0 };
      r.calls++;
      if (e.usage) {
        r.tokens += e.usage.inputTokens + e.usage.outputTokens;
        const c = callCost(e.profileId, e.usage.inputTokens, e.usage.outputTokens);
        if (c !== null && r.cost !== null) r.cost += c;
      } else r.noUsage++;
      by.set(e.profileId, r);
    }
  }
  return [...by.values()].sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model));
}

const money = (n: number) => (n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);

/** 持久化的调用记录按模型汇总（本月） */
export function usageRowsOfCalls(calls: readonly { profile_id: string; input_tokens: number; output_tokens: number }[]): UsageRow[] {
  const by = new Map<string, UsageRow>();
  for (const c of calls) {
    const r = by.get(c.profile_id) ?? { model: c.profile_id, calls: 0, tokens: 0, cost: PRICES[c.profile_id] ? 0 : null, noUsage: 0 };
    r.calls++;
    r.tokens += c.input_tokens + c.output_tokens;
    const cost = callCost(c.profile_id, c.input_tokens, c.output_tokens);
    if (cost !== null && r.cost !== null) r.cost += cost;
    by.set(c.profile_id, r);
  }
  return [...by.values()].sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model));
}

export function UsagePage() {
  const calls = useUsage((s) => s.calls);
  const error = useUsage((s) => s.error);
  const tasks = useTasks((s) => s.tasks);
  const rows = useMemo(() => usageRowsOfCalls(calls), [calls]);
  // 服务没返回 token 用量的调用不会记进调用记录：从本月任务的事件里另外数出来，如实写明
  const noUsage = useMemo(() => {
    const start = monthStart();
    return usageByModel(tasks.filter((t) => t.startedAt >= start).map((t) => t.events)).reduce((n, r) => n + r.noUsage, 0);
  }, [tasks]);
  const total = { ...savingsOfCalls(calls), noUsage };
  const saved = savedText(total);
  const month = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long" });
  return (
    <div className="space-y-10">
      {error && (
        <p role="alert" className="text-sm">
          读取调用记录失败：{error}
        </p>
      )}
      <SettingsSection title={month} description={`${SAVINGS_HINT}；价目表核对于 ${PRICES_CHECKED}。按本地时区自然月统计，调用记录保存在本机。`}>
        {rows.length === 0 ? (
          <EmptyState icon={ChartColumn}>还没有模型调用。</EmptyState>
        ) : (
          <>
            <dl aria-label="合计" className="grid max-w-xl grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
              <dt className="text-muted-foreground">实际花费</dt>
              <dd>{total.priced ? `约 ${money(total.actual)}` : "没有可计价的调用"}</dd>
              <dt className="text-muted-foreground">按最强模式</dt>
              <dd>{total.priced ? `约 ${money(total.baseline)}` : "—"}</dd>
              <dt className="text-muted-foreground">节省</dt>
              <dd>{saved ?? (total.priced ? "和最强模式相同" : "—")}</dd>
            </dl>
            {(total.unpriced > 0 || total.noUsage > 0) && (
              <p className="text-xs text-muted-foreground">
                {[total.unpriced && `${total.unpriced} 次调用没有单价`, total.noUsage && `${total.noUsage} 次调用没有返回 token 用量`].filter(Boolean).join("，")}，未计入金额。
              </p>
            )}
            <table aria-label="按模型统计" className="w-full max-w-xl text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="py-1 font-normal">
                    模型
                  </th>
                  <th scope="col" className="py-1 font-normal">
                    调用
                  </th>
                  <th scope="col" className="py-1 font-normal">
                    tokens
                  </th>
                  <th scope="col" className="py-1 font-normal">
                    估算花费
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.model} className="border-t border-border">
                    <td className="break-all py-2 font-mono text-xs">{displayModel(r.model)}</td>
                    <td className="py-2 tabular-nums">{r.calls}</td>
                    <td className="py-2 tabular-nums">{r.tokens > 0 ? r.tokens.toLocaleString("zh-CN") : "未知"}</td>
                    <td className="py-2 tabular-nums">{r.cost === null ? "没有单价" : r.tokens > 0 ? money(r.cost) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </SettingsSection>
    </div>
  );
}
