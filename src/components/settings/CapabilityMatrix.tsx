import { useMemo } from "react";
import { Check, RotateCcw } from "lucide-react";
import { CAP_LABEL, CAPABILITIES, sortCaps, type Capability, type ModelProfile } from "@/decision";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { customReference, effectiveProfiles, type ProfileOverride } from "@/lib/engine";
import { cn } from "@/lib/utils";
import { useSettings } from "@/stores/settings";
import { SettingsSection } from "./controls";

const TIERS = [1, 2, 3, 4, 5];
const CONTEXTS = [8_000, 32_000, 128_000, 200_000, 400_000, 1_000_000, 2_000_000];
const ctxLabel = (n: number) => (n >= 1_000_000 ? `${Number((n / 1_000_000).toFixed(2))}M` : `${Math.round(n / 1000)}K`);
type TierKey = "cost_tier" | "quality_tier" | "latency_tier";
const TIER_COLS: [TierKey, string, string][] = [
  ["cost_tier", "成本", "1 最便宜"],
  ["quality_tier", "质量", "5 最强"],
  ["latency_tier", "延迟", "1 最快"],
];

// 能力矩阵：路由打分用的内置档位（估值）可以按实际体验调整；只保存和内置值不同的字段
export function CapabilityMatrix() {
  const overrides = useSettings((s) => s.overrides);
  const custom = useSettings((s) => s.custom);
  const setOverride = useSettings((s) => s.setOverride);
  const profiles = useMemo(() => effectiveProfiles(overrides, custom), [overrides, custom]);
  const change = (p: ModelProfile, patch: ProfileOverride) => setOverride(p.id, patch);
  const toggleCap = (p: ModelProfile, c: Capability) =>
    change(p, { capabilities: sortCaps(p.capabilities.includes(c) ? p.capabilities.filter((x) => x !== c) : [...p.capabilities, c]) });

  return (
    <SettingsSection title="能力矩阵" description="档位是估值，不是实测数据。调整后立即用于新的路由决策。自定义 Provider 的模型和内置型号同名时，默认沿用内置档位并标出参照来源；其余能力未知，默认全部为 3 档、不声明能力。">
      <div className="overflow-x-auto">
        <table className="w-full min-w-max text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="py-2 pr-3 font-normal">模型</th>
              <th scope="col" className="py-2 pr-3 font-normal">启用</th>
              <th scope="col" className="py-2 pr-3 font-normal">能力</th>
              {TIER_COLS.map(([k, label, hint]) => (
                <th key={k} scope="col" className="py-2 pr-3 font-normal">
                  {label}
                  <span className="block">{hint}</span>
                </th>
              ))}
              <th scope="col" className="py-2 pr-3 font-normal">上下文</th>
              <th scope="col" className="py-2 font-normal"><span className="sr-only">操作</span></th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => (
              <tr key={p.id} className="border-t border-border align-top">
                <th scope="row" className="py-2 pr-3 text-xs font-normal">
                  <span className="font-mono">{p.id}</span>
                  {customReference(p) && <span className="block text-muted-foreground">{`默认值参照 ${customReference(p)}`}</span>}
                </th>
                <td className="py-2 pr-3">
                  <input type="checkbox" aria-label={`启用 ${p.id}`} checked={p.enabled} onChange={(e) => change(p, { enabled: e.target.checked })} className="size-4 accent-east-red" />
                </td>
                <td className="py-2 pr-3">
                  <div role="group" aria-label={`${p.id} 的能力`} className="flex max-w-64 flex-wrap gap-1">
                    {CAPABILITIES.map((c) => {
                      const on = p.capabilities.includes(c);
                      return (
                        <button key={c} type="button" aria-pressed={on} onClick={() => toggleCap(p, c)}
                          className={cn("inline-flex h-6 items-center gap-1 rounded-sm border px-2 text-xs", on ? "border-east-red/60 bg-accent text-foreground" : "border-border text-muted-foreground")}>
                          {on && <Check aria-hidden className="size-3" />}
                          {CAP_LABEL[c]}
                        </button>
                      );
                    })}
                  </div>
                </td>
                {TIER_COLS.map(([k, label]) => (
                  <td key={k} className="py-2 pr-3">
                    <Select aria-label={`${p.id} ${label}档位`} value={p[k]} onChange={(e) => change(p, { [k]: Number(e.target.value) })} className="w-16">
                      {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
                    </Select>
                  </td>
                ))}
                <td className="py-2 pr-3">
                  <Select aria-label={`${p.id} 上下文窗口`} value={p.context_window} onChange={(e) => change(p, { context_window: Number(e.target.value) })} className="w-24">
                    {[...new Set([...CONTEXTS, p.context_window])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{ctxLabel(n)}</option>)}
                  </Select>
                </td>
                <td className="py-2">
                  {overrides[p.id] && (
                    <Button size="sm" variant="ghost" aria-label={`恢复默认：${p.id}`} onClick={() => setOverride(p.id, null)}>
                      <RotateCcw aria-hidden />
                      恢复默认
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SettingsSection>
  );
}
