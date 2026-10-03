import { useMemo } from "react";
import type { AgentEvent } from "@/agent";
import { displayModel } from "@/lib/route-summary";
import { useTasks } from "@/stores/tasks";
import { ChartColumn } from "lucide-react";
import { EmptyState, SettingsSection } from "./controls";

// 使用情况：按模型统计调用次数和 tokens。现在的数据来自本次启动以来的任务（内存），重启后清零；
// 调用记录持久化和按价目表估算的金额在价格表接入后补上（docs/UI_LAYOUT_V3.md 5.1）
interface Row {
  model: string;
  calls: number;
  tokens: number;
}

export function usageByModel(events: readonly AgentEvent[][]): Row[] {
  const by = new Map<string, Row>();
  for (const list of events) {
    for (const outer of list) {
      const e = outer.type === "subagent" ? outer.event : outer;
      if (e.type !== "llm") continue;
      const r = by.get(e.profileId) ?? { model: e.profileId, calls: 0, tokens: 0 };
      r.calls++;
      r.tokens += e.usage ? e.usage.inputTokens + e.usage.outputTokens : 0;
      by.set(e.profileId, r);
    }
  }
  return [...by.values()].sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model));
}

export function UsagePage() {
  const tasks = useTasks((s) => s.tasks);
  const rows = useMemo(() => usageByModel(tasks.map((t) => t.events)), [tasks]);
  return (
    <SettingsSection title="本次启动以来" description="按模型统计调用次数和 tokens；重启后清零。">
      {rows.length === 0 ? (
        <EmptyState icon={ChartColumn}>还没有模型调用。</EmptyState>
      ) : (
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
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.model} className="border-t border-border">
                <td className="break-all py-2 font-mono text-xs">{displayModel(r.model)}</td>
                <td className="py-2 tabular-nums">{r.calls}</td>
                <td className="py-2 tabular-nums">{r.tokens > 0 ? r.tokens.toLocaleString("zh-CN") : "未知"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SettingsSection>
  );
}
