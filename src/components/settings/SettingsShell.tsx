import { ArrowLeft, Box, Wrench, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { SettingsPage, type SettingsSectionId } from "./SettingsPage";

const SETTINGS_VIEWS: SettingsSectionId[] = ["models", "system"];
const VIEW_LABEL: Record<SettingsSectionId, string> = { models: "模型与路由", system: "系统与工具" };
const ICON: Record<SettingsSectionId, LucideIcon> = { models: Box, system: Wrench };

// 设置外壳：左边是分区导航，右边是内容。首屏不显示这些入口，只有点了侧边栏「设置」才进来。
export function SettingsShell({ view }: { view: SettingsSectionId }) {
  const openSettings = useUi((s) => s.openSettings);

  return (
    <main className="flex min-w-0 flex-1 bg-surface">
      <div className="flex w-56 shrink-0 flex-col border-r border-border px-3 py-6">
        <button
          type="button"
          onClick={() => useUi.getState().setRail("home")}
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
                    onClick={() => openSettings(v === "models" ? "providers" : "mcp")}
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
        <SettingsPage key={view} section={view} />
      </div>
    </main>
  );
}
