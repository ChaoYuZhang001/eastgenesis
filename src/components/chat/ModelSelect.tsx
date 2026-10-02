import { useMemo, type ReactNode } from "react";
import { ChevronDown, Cpu, ShieldCheck } from "lucide-react";
import { HealthTracker, PERMISSION_HINT, PERMISSION_LABEL, PERMISSION_MODES, type PermissionMode } from "@/decision";
import { effectiveProfiles, statusAvailability } from "@/lib/engine";
import { hasOption, lockLabel, modelGroups } from "@/lib/model-options";
import { cn } from "@/lib/utils";
import { useSettings } from "@/stores/settings";

// 输入框里的两个下拉：模型和权限。都用原生 select（键盘、读屏、移动端都不用另写），
// 外面套一层胶囊样式，select 本身透明铺满，点哪里都能展开。
function Pill({ icon, text, children, width }: { icon: ReactNode; text: string; children: ReactNode; width: string }) {
  return (
    <span className={cn("relative inline-flex h-8 items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground", width)}>
      {icon}
      <span className="truncate">{text}</span>
      <ChevronDown aria-hidden className="size-3 shrink-0" />
      {children}
    </span>
  );
}

const overlay = "absolute inset-0 cursor-pointer appearance-none bg-transparent text-xs text-foreground opacity-0";

export function ModelSelect({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const custom = useSettings((s) => s.custom);
  const statuses = useSettings((s) => s.statuses);
  const overrides = useSettings((s) => s.overrides);
  const prefs = useSettings((s) => s.providerPrefs);
  const cache = useSettings((s) => s.modelCache);

  const groups = useMemo(() => {
    const profiles = effectiveProfiles(overrides, custom);
    // 下拉里只看 Key 和启用状态，不看熔断：熔断是临时的，用新的 HealthTracker 绕开
    const available = statusAvailability(statuses, custom, new HealthTracker(), prefs);
    return modelGroups(profiles, custom, available, cache);
  }, [overrides, custom, statuses, prefs, cache]);

  // 锁定的模型被删掉或停用时，回到自动路由
  const locked = hasOption(groups, value) ? value : null;

  return (
    <Pill icon={<Cpu aria-hidden className="size-3 shrink-0" />} text={lockLabel(groups, locked)} width="max-w-40">
      <select
        aria-label="模型"
        className={overlay}
        value={locked ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        title={locked ? "已锁定模型，本次跳过路由决策" : "自动路由：由决策层选模型"}
      >
        <option value="">自动路由</option>
        {groups.map((g) => (
          <optgroup key={g.provider} label={g.label}>
            {g.options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </Pill>
  );
}

export function PermissionSelect({ value, onChange }: { value: PermissionMode; onChange: (v: PermissionMode) => void }) {
  return (
    <Pill icon={<ShieldCheck aria-hidden className="size-3 shrink-0" />} text={PERMISSION_LABEL[value]} width="max-w-32">
      <select aria-label="权限" title={PERMISSION_HINT[value]} className={overlay} value={value} onChange={(e) => onChange(e.target.value as PermissionMode)}>
        {PERMISSION_MODES.map((m) => (
          <option key={m} value={m}>
            {PERMISSION_LABEL[m]}
          </option>
        ))}
      </select>
    </Pill>
  );
}
