import { ArrowLeft, Box, Hexagon, Wrench, type LucideIcon } from "lucide-react";
import { AgentsPage } from "@/components/AgentsPage";
import { cn } from "@/lib/utils";
import { SETTINGS_VIEWS, VIEW_LABEL, useUi, type SettingsView } from "@/stores/ui";
import { SettingsPage } from "./SettingsPage";

const ICON: Record<SettingsView, LucideIcon> = { models: Box, system: Wrench, agents: Hexagon };

// 设置外壳：左边是分区导航，右边是内容。首屏不显示这些入口，只有点了侧边栏「设置」才进来。
export function SettingsShell({ view }: { view: SettingsView }) {
  const setView = useUi((s) => s.setView);

  return (
    <main className="flex min-w-0 flex-1 bg-surface">
      <div className="flex w-56 shrink-0 flex-col border-r border-border px-3 py-6">
        <button
          type="button"
          onClick={() => setView("chat")}
          className="mb-4 flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
        >
          <ArrowLeft aria-hidden className="size-4" />
          返回对话
        </button>
        <nav aria-label="设置分区">
          <ul className="space-y-1">
            {SETTINGS_VIEWS.map((v) => {
              const Icon = ICON[v];
              const selected = v === view;
              return (
                <li key={v}>
                  <button
                    type="button"
                    aria-current={selected ? "page" : undefined}
                    onClick={() => setView(v)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                      selected ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-surface-2 hover:text-foreground",
                    )}
                  >
                    <Icon aria-hidden className={cn("size-4", selected && "text-east-red")} />
                    {VIEW_LABEL[v]}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto px-8 pt-8">
        {view === "agents" ? <AgentsPage /> : <SettingsPage key={view} section={view} />}
      </div>
    </main>
  );
}
