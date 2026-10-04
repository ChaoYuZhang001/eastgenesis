// 本月的模型调用记录（usage_calls，迁移 5）：「本月省了多少」和使用情况页按它统计，跨重启累计。
// 金额不入库，显示时按当前价目表计算（docs/UI_LAYOUT_V3.md 5.1）。
import { create } from "zustand";
import type { UsageCall } from "@/decision/session";
import { toAppError } from "@/lib/ipc";
import { EMPTY_SAVINGS, callCost, type Savings } from "@/lib/savings";
import { getBackend } from "@/platform";

/** 本地时区本月 1 日 0 点 */
export const monthStart = (now = Date.now()) => {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
};

interface UsageState {
  loaded: boolean;
  calls: UsageCall[];
  error: string | null;
  load(): Promise<void>;
  /** 新记的调用（history.ts 写进数据库后调用），本月的并进来 */
  add(calls: readonly UsageCall[]): void;
}

export const useUsage = create<UsageState>((set, get) => ({
  loaded: false,
  calls: [],
  error: null,
  async load() {
    try {
      set({ calls: await getBackend().listUsage(monthStart()), loaded: true, error: null });
    } catch (e) {
      set({ loaded: true, error: toAppError(e).message });
    }
  },
  add(calls) {
    const start = monthStart();
    const have = new Set(get().calls.map((c) => c.id));
    const next = calls.filter((c) => c.created_at >= start && !have.has(c.id));
    if (next.length) set((s) => ({ calls: [...s.calls, ...next] }));
  },
}));

/** 调用记录 → 节省（和 savingsOf 同一口径：缺单价的调用单独计数，不估） */
export function savingsOfCalls(calls: readonly UsageCall[]): Savings {
  const s: Savings = { ...EMPTY_SAVINGS };
  for (const c of calls) {
    const actual = callCost(c.profile_id, c.input_tokens, c.output_tokens);
    const base = c.baseline_profile_id ? callCost(c.baseline_profile_id, c.input_tokens, c.output_tokens) : null;
    if (actual === null || base === null) {
      s.unpriced++;
      continue;
    }
    s.actual += actual;
    s.baseline += base;
    s.priced++;
  }
  return s;
}
