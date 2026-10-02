import { useId } from "react";
import { Select } from "@/components/ui/input";
import { LOCAL_JEV_TIMEOUT_MS } from "@/decision";
import { effectiveProfiles } from "@/lib/engine";
import { localJevCandidates } from "@/lib/local-decision";
import { useSettings } from "@/stores/settings";
import { SettingsSection } from "./controls";

// 第 2 级决策：本地决策模型。只列本机服务的模型，任务内容不离开本机
export function LocalJevSettings() {
  const id = useId();
  const hint = useId();
  const { custom, overrides, providerPrefs, setLocalJev } = useSettings();
  const options = localJevCandidates(effectiveProfiles(overrides, custom), custom);
  const value = providerPrefs.localJev ?? "";
  const stale = value !== "" && !options.some((p) => p.id === value);
  return (
    <SettingsSection title="本地决策模型" description="第 2 级决策：没有 Jev Key、Jev 不可用或把握不够时，先由本机模型判断，再交给规则引擎。任务内容不离开本机。">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={id} className="text-sm">决策模型</label>
          <Select id={id} aria-describedby={hint} value={value} onChange={(e) => setLocalJev(e.target.value || null)} className="w-72">
            <option value="">不使用（直接用规则引擎）</option>
            {stale && <option value={value}>{`${value}（已不可用）`}</option>}
            {options.map((p) => (
              <option key={p.id} value={p.id}>{p.id}</option>
            ))}
          </Select>
        </div>
        <p id={hint} className="text-xs text-muted-foreground">
          {`可选 Ollama 的模型，或地址在本机的自定义 Provider 的模型；和「让路由使用本机 Ollama」互不影响，请先确认本机服务在运行。建议选小而快、不做长推理的模型：每次判断最多等 ${LOCAL_JEV_TIMEOUT_MS / 1000} 秒，超时、出错或把握不够都交给规则引擎，路由面板会注明原因。`}
        </p>
      </div>
    </SettingsSection>
  );
}
