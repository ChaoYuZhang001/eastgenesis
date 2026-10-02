import { useId } from "react";
import { TYPE_LABEL, weightsFor, type LatencyPref, type Preference, type TaskType, type Weights } from "@/decision";
import { Select } from "@/components/ui/input";
import { DEFAULT_REQUEST_TIMEOUT_S, REQUEST_TIMEOUT_OPTIONS } from "@/lib/engine";
import { useSettings } from "@/stores/settings";
import { RadioGroup, SettingsSection, type RadioOption } from "./controls";

const PREFERENCES: RadioOption<Preference>[] = [
  { value: "economy", label: "省钱", hint: "成本权重最高" },
  { value: "balanced", label: "平衡", hint: "质量与成本兼顾" },
  { value: "best", label: "最强", hint: "质量优先" },
];
const LATENCIES: RadioOption<LatencyPref>[] = [
  { value: "fast", label: "快速响应", hint: "延迟权重 ×2" },
  { value: "normal", label: "正常", hint: "延迟权重 ×1" },
  { value: "patient", label: "可以等", hint: "延迟权重 ×0.4" },
];
const COST_CAPS = [
  { value: 5, label: "不限" },
  { value: 4, label: "不超过 4 档" },
  { value: 3, label: "不超过 3 档" },
  { value: 2, label: "不超过 2 档" },
  { value: 1, label: "只用最便宜的（1 档）" },
];
const SAMPLE_TYPES: TaskType[] = ["qa", "code", "reasoning"];
const WEIGHT_COLS: [keyof Weights, string][] = [
  ["capability", "能力匹配"],
  ["quality", "质量"],
  ["cost", "成本"],
  ["latency", "延迟"],
];

// 路由策略：偏好、延迟、成本上限、请求超时，并直接展示它们换算出的打分权重（路由可视化）
export function RoutingSettings() {
  const routing = useSettings((s) => s.routing);
  const setRouting = useSettings((s) => s.setRouting);
  const timeoutS = useSettings((s) => s.timeoutS);
  const setTimeoutS = useSettings((s) => s.setTimeoutS);
  const capId = useId();
  const timeoutId = useId();
  const showReasoning = useSettings((s) => s.showReasoning);
  const setShowReasoning = useSettings((s) => s.setShowReasoning);
  const reasoningId = useId();

  return (
    <SettingsSection title="路由策略" description="每个任务按下面的权重给候选模型打分，得分最高的做首选，其余按分数排成备选链。">
      <RadioGroup legend="偏好" value={routing.preference} options={PREFERENCES} onChange={(preference) => setRouting({ preference })} />
      <RadioGroup legend="延迟" value={routing.latency} options={LATENCIES} onChange={(latency) => setRouting({ latency })} />
      <div className="max-w-xs space-y-1">
        <label htmlFor={capId} className="text-sm">
          成本上限
        </label>
        <Select id={capId} value={routing.maxCostTier} onChange={(e) => setRouting({ maxCostTier: Number(e.target.value) })}>
          {COST_CAPS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">硬性约束：降级时也不会选超过上限的模型。</p>
      </div>
      <div className="max-w-xs space-y-1">
        <label htmlFor={timeoutId} className="text-sm">
          请求超时
        </label>
        <Select id={timeoutId} value={timeoutS} onChange={(e) => setTimeoutS(Number(e.target.value))}>
          {REQUEST_TIMEOUT_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s} 秒{s === DEFAULT_REQUEST_TIMEOUT_S ? "（默认）" : ""}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">单次模型请求超过这个时间就算超时：先等 2 秒重试一次，再失败才降级到下一个模型。中转站响应慢时可以调大。</p>
      </div>
      <div className="max-w-xl space-y-1">
        <div className="flex items-center gap-2">
          <input id={reasoningId} type="checkbox" className="size-4 accent-east-red" checked={showReasoning} onChange={(e) => setShowReasoning(e.target.checked)} />
          <label htmlFor={reasoningId} className="text-sm">
            显示模型思考过程
          </label>
        </div>
        <p className="text-xs text-muted-foreground">默认关闭。打开后，推理模型的回答下方会多一行可展开的思考摘要，只保留和你的问题有关的中文内容。</p>
      </div>

      <table className="w-full max-w-xl text-left text-sm">
        <caption className="mb-2 text-left text-xs text-muted-foreground">当前设置下的打分权重（按任务类型）</caption>
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="py-1 font-normal">
              任务类型
            </th>
            {WEIGHT_COLS.map(([k, label]) => (
              <th key={k} scope="col" className="py-1 font-normal">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SAMPLE_TYPES.map((t) => {
            const w = weightsFor(routing.preference, routing.latency, t);
            return (
              <tr key={t} className="border-t border-border">
                <th scope="row" className="py-1 font-normal">
                  {TYPE_LABEL[t]}
                </th>
                {WEIGHT_COLS.map(([k]) => (
                  <td key={k} className="py-1 tabular-nums">
                    {Math.round(w[k] * 100)}%
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </SettingsSection>
  );
}
