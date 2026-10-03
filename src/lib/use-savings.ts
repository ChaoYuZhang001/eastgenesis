// 组件里用的节省统计：把可用性（Key、启用状态，不看熔断）和能力矩阵接到 savings.ts 的纯函数上
import { useMemo } from "react";
import { HealthTracker, type RouteDecision } from "@/decision";
import { effectiveProfiles, statusAvailability } from "@/lib/engine";
import { lastRoute } from "@/lib/timeline";
import { useSettings } from "@/stores/settings";
import type { TaskCard } from "@/stores/tasks";
import { addSavings, baselineFor, EMPTY_SAVINGS, savingsOf, type Savings } from "./savings";

function useBaseline() {
  const statuses = useSettings((s) => s.statuses);
  const custom = useSettings((s) => s.custom);
  const overrides = useSettings((s) => s.overrides);
  const prefs = useSettings((s) => s.providerPrefs);
  return useMemo(() => {
    const profiles = effectiveProfiles(overrides, custom);
    // 基准只看 Key 和启用状态，不看熔断：熔断是临时的，基准应该稳定
    const availability = statusAvailability(statuses, custom, new HealthTracker(), prefs);
    const cache = new Map<RouteDecision, string | null>();
    return (d: RouteDecision | null) => {
      if (!d) return null;
      if (!cache.has(d)) cache.set(d, baselineFor(d, profiles, availability));
      return cache.get(d)!;
    };
  }, [statuses, custom, overrides, prefs]);
}

/** 一个任务的节省；锁定模型时基准仍是「最强模式」排第一的模型 */
export function useTaskSavings(card: TaskCard | undefined): Savings {
  const baseline = useBaseline();
  return useMemo(() => {
    if (!card) return EMPTY_SAVINGS;
    const r = lastRoute(card.events);
    return savingsOf(card.events, baseline(r?.decision ?? null));
  }, [card, baseline]);
}

/** 几个任务合起来（会话、项目、目标、本次启动以来） */
export function useTasksSavings(cards: readonly TaskCard[]): Savings {
  const baseline = useBaseline();
  return useMemo(
    () => cards.reduce((acc, c) => addSavings(acc, savingsOf(c.events, baseline(lastRoute(c.events)?.decision ?? null))), EMPTY_SAVINGS),
    [cards, baseline],
  );
}
