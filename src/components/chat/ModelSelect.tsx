import { useMemo, type ReactNode } from "react";
import { ChevronDown, Eye, Lock, Route, ShieldCheck, ShieldOff } from "lucide-react";
import { HealthTracker, PERMISSION_HINT, PERMISSION_LABEL, PERMISSION_MODES, type PermissionMode, type Preference } from "@/decision";
import { PREFERENCE_SOURCE_LABEL, preferenceSource } from "@/decision/project";
import { Menu, MenuItem, MenuLabel, MenuRadio, MenuSeparator, SubMenu } from "@/components/ui/menu";
import { effectiveProfiles, statusAvailability } from "@/lib/engine";
import { hasOption, lockLabel, modelGroups } from "@/lib/model-options";
import { PREFERENCE_LABEL } from "@/lib/sidebar-rows";
import { SAVINGS_HINT, savedText } from "@/lib/savings";
import { useTasksSavings } from "@/lib/use-savings";
import { cn } from "@/lib/utils";
import { useProjects } from "@/stores/projects";
import { useTasks } from "@/stores/tasks";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";

const pill = "relative inline-flex h-8 items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground";

// 权限胶囊：原生 select 覆盖层（键盘、读屏都不用另写），语义和顺序不变。
// 颜色只加在图标上，三档图标形状也不同；档位名不用红字或金字（docs/UI_LAYOUT_V3.md 第 6 节）
const PERMISSION_ICONS: Record<PermissionMode, ReactNode> = {
  readonly: <Eye aria-hidden className="size-4 shrink-0 text-muted-foreground" />,
  confirm: <ShieldCheck aria-hidden className="size-4 shrink-0 text-china-gold" />,
  full: <ShieldOff aria-hidden className="size-4 shrink-0 text-east-red" />,
};

export function PermissionSelect({ value, onChange }: { value: PermissionMode; onChange: (v: PermissionMode) => void }) {
  return (
    <span className={cn(pill, "max-w-32")}>
      {PERMISSION_ICONS[value]}
      <span className={cn("truncate", value !== "readonly" && "text-foreground")}>{PERMISSION_LABEL[value]}</span>
      <ChevronDown aria-hidden className="size-3 shrink-0" />
      <select
        aria-label="权限"
        title={PERMISSION_HINT[value]}
        className="absolute inset-0 cursor-pointer appearance-none bg-transparent text-xs text-foreground opacity-0"
        value={value}
        onChange={(e) => onChange(e.target.value as PermissionMode)}
      >
        {PERMISSION_MODES.map((m) => (
          <option key={m} value={m}>
            {PERMISSION_LABEL[m]}
          </option>
        ))}
      </select>
    </span>
  );
}

const MODE_LABEL = { auto: "自动路由", economy: "省钱模式", best: "最强模式" } as const;

// 自动路由下拉（docs/UI_LAYOUT_V3.md 第 5 节）：自动（推荐）/ 省钱 / 最强 / 手动锁定。
// 自动 = 任务层不设偏好，按 目标 > 项目 > 全局 取值；锁定 = 整个任务用这个模型、不再自动降级。打分算法不变。
export function RoutingSelect({ lock, preference, onLock, onPreference }: { lock: string | null; preference: Preference | null; onLock: (v: string | null) => void; onPreference: (v: Preference | null) => void }) {
  const custom = useSettings((s) => s.custom);
  const statuses = useSettings((s) => s.statuses);
  const overrides = useSettings((s) => s.overrides);
  const prefs = useSettings((s) => s.providerPrefs);
  const cache = useSettings((s) => s.modelCache);
  const global = useSettings((s) => s.routing.preference);
  const currentId = useUi((s) => s.currentProjectId);
  const openSettings = useUi((s) => s.openSettings);
  const project = useProjects((s) => (currentId ? s.items.find((p) => p.id === currentId) ?? null : null));
  const month = useMonthTasks();
  const monthSavings = useTasksSavings(month);

  const groups = useMemo(() => {
    const profiles = effectiveProfiles(overrides, custom);
    // 下拉里只看 Key 和启用状态，不看熔断：熔断是临时的，用新的 HealthTracker 绕开
    const available = statusAvailability(statuses, custom, new HealthTracker(), prefs);
    return modelGroups(profiles, custom, available, cache);
  }, [overrides, custom, statuses, prefs, cache]);

  // 锁定的模型被删掉或停用时，回到自动路由
  const locked = hasOption(groups, lock) ? lock : null;
  const auto = preferenceSource(null, null, project, global);
  const text = locked ? `锁定 · ${lockLabel(groups, locked)}` : preference === "economy" ? MODE_LABEL.economy : preference === "best" ? MODE_LABEL.best : MODE_LABEL.auto;

  return (
    <Menu
      label="路由"
      title={locked ? "已锁定模型：整个任务都用它，跳过路由决策，不自动降级" : `路由模式：${text}`}
      side="top"
      align="end"
      width="w-72"
      triggerClassName={cn(pill, "max-w-40 hover:text-foreground")}
      trigger={
        <>
          {locked ? <Lock aria-hidden className="size-4 shrink-0" /> : <Route aria-hidden className="size-4 shrink-0" />}
          <span className="truncate">{text}</span>
          <ChevronDown aria-hidden className="size-3 shrink-0" />
        </>
      }
    >
      <MenuLabel>路由模式</MenuLabel>
      <MenuRadio checked={!locked && !preference} onSelect={() => { onLock(null); onPreference(null); }}
        hint={`Jev 决策 · 当前按「${PREFERENCE_LABEL[auto.preference]}（来自${PREFERENCE_SOURCE_LABEL[auto.source]}）」`}>
        自动（推荐）
      </MenuRadio>
      <MenuRadio checked={!locked && preference === "economy"} onSelect={() => onPreference("economy")} hint="同样能做好时选更便宜的">
        省钱模式
      </MenuRadio>
      <MenuRadio checked={!locked && preference === "best"} onSelect={() => onPreference("best")} hint="质量优先，不看价格">
        最强模式
      </MenuRadio>
      <MenuSeparator />
      <SubMenu label="手动锁定" hint={locked ? lockLabel(groups, locked) : "整个任务只用一个模型"} width="w-72">
        <MenuLabel>锁定后整个任务都用它，不自动降级</MenuLabel>
        {groups.length === 0 && <MenuLabel>没有可用的模型：先在设置里配置 Key 或中转站</MenuLabel>}
        {groups.map((g) => (
          <div key={g.provider} role="group" aria-label={g.label}>
            <MenuLabel>{g.label}</MenuLabel>
            {g.options.map((o) => (
              <MenuRadio key={o.id} checked={locked === o.id} onSelect={() => onLock(o.id)}>
                {o.label}
              </MenuRadio>
            ))}
          </div>
        ))}
      </SubMenu>
      <MenuSeparator />
      <MenuItem onSelect={() => openSettings("usage")} hint={monthHint(monthSavings.unpriced, monthSavings.priced)}>
        <span title={SAVINGS_HINT}>{monthText(monthSavings)}</span>
      </MenuItem>
    </Menu>
  );
}

/** 本月（本地时区自然月）开始的任务；调用记录没持久化之前只有本次启动以来的 */
function useMonthTasks() {
  const tasks = useTasks((s) => s.tasks);
  return useMemo(() => {
    const d = new Date();
    const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    return tasks.filter((t) => t.startedAt >= start);
  }, [tasks]);
}

function monthText(s: ReturnType<typeof useTasksSavings>): string {
  const t = savedText(s);
  if (!t) return s.priced ? "本月和最强模式花费相同" : "本月还没有可计价的调用";
  return t.startsWith("省") ? `本月省了约 ${t.slice(2)}` : `本月多花了约 ${t.slice(3)}`;
}

function monthHint(unpriced: number, priced: number): string {
  const parts = ["本次启动以来，重启后清零"];
  if (unpriced) parts.push(`${unpriced} 次调用没有单价，未计入`);
  else if (!priced) parts.push("按官方标价估算");
  return parts.join("；");
}
