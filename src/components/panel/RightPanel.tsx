import { useId, useMemo, type ReactNode } from "react";
import { Activity, Hand, PanelRightClose, PanelRightOpen, Route, Users, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { effectiveProfiles } from "@/lib/engine";
import { subAgentViews } from "@/lib/subagents";
import { lastRoute } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import { useSettings } from "@/stores/settings";
import { useTasks } from "@/stores/tasks";
import { useUi } from "@/stores/ui";
import { Intervention } from "./Intervention";
import { RoutePanel } from "./RoutePanel";
import { SubAgents } from "./SubAgents";
import { Timeline } from "./Timeline";

function Section({ title, icon: Icon, children }: { title: string; icon: LucideIcon; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-3 border-b border-border px-4 py-4 last:border-b-0">
      <h2 id={id} className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Icon aria-hidden className="size-4" />
        {title}
      </h2>
      {children}
    </section>
  );
}

// 右侧执行时间线与路由面板（w-panel = 320px，可折叠）：透明度优先，每一步的决策都摊开给用户看
export function RightPanel() {
  const { panelOpen, togglePanel } = useUi();
  const task = useTasks((s) => s.tasks.find((t) => t.id === s.activeId) ?? null);
  const overrides = useSettings((s) => s.overrides);
  const custom = useSettings((s) => s.custom);
  const profiles = useMemo(() => effectiveProfiles(overrides, custom), [overrides, custom]);
  const events = task?.events ?? [];
  const route = lastRoute(events);
  const agents = useMemo(() => subAgentViews(events), [events]);
  const body = useId();

  return (
    <aside aria-label="执行面板" className={cn("flex shrink-0 flex-col border-l border-border bg-surface-2", panelOpen ? "w-panel" : "w-12")}>
      <div className={cn("flex h-12 items-center border-b border-border", panelOpen ? "justify-between px-4" : "justify-center")}>
        {panelOpen && <p className="truncate text-sm font-medium">{task ? task.goal : "执行时间线"}</p>}
        <Button size="icon" variant="ghost" className="size-8 shrink-0" aria-label="执行面板" aria-expanded={panelOpen} aria-controls={body} onClick={togglePanel}>
          {panelOpen ? <PanelRightClose aria-hidden /> : <PanelRightOpen aria-hidden />}
        </Button>
      </div>
      <div id={body} hidden={!panelOpen} className="min-h-0 flex-1 overflow-y-auto">
        <Section title="执行时间线" icon={Activity}>
          <Timeline events={events} profiles={profiles} />
        </Section>
        <Section title="路由决策" icon={Route}>
          <RoutePanel route={route} profiles={profiles} />
        </Section>
        <Section title="子 Agent 并行状态" icon={Users}>
          <SubAgents agents={agents} />
        </Section>
        <Section title="手动干预" icon={Hand}>
          <Intervention task={task} profiles={profiles} />
        </Section>
      </div>
    </aside>
  );
}
