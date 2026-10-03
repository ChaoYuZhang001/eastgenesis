import { CircleUser, Folder, History, House, Settings, SquarePen, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app";
import { RAIL_LABEL, useUi, type Rail } from "@/stores/ui";

// 图标栏（docs/UI_LAYOUT_V3.md 1.1）：宽 60，五个导航项 + 底部头像占位。
// 名称必须显示：红色图标在选中底上只有 3.06:1，只够图形用（BRAND.md 4.3）
const NAV: { rail: Rail | "new"; icon: LucideIcon; label: string }[] = [
  { rail: "home", icon: House, label: RAIL_LABEL.home },
  { rail: "new", icon: SquarePen, label: "新任务" },
  { rail: "projects", icon: Folder, label: RAIL_LABEL.projects },
  { rail: "history", icon: History, label: RAIL_LABEL.history },
  { rail: "settings", icon: Settings, label: RAIL_LABEL.settings },
];

export function IconRail({ onNewTask }: { onNewTask: () => void }) {
  const rail = useUi((s) => s.rail);
  const clickRail = useUi((s) => s.clickRail);
  const mock = useAppStore((s) => s.backendKind === "mock");

  return (
    <nav aria-label="主导航" className="flex w-[60px] shrink-0 flex-col items-center border-r border-border bg-surface-2 py-3">
      <ul className="flex flex-col items-center gap-1">
        {NAV.map(({ rail: r, icon: Icon, label }) => {
          const selected = r === rail;
          return (
            <li key={r}>
              <button
                type="button"
                aria-current={selected ? "page" : undefined}
                onClick={() => (r === "new" ? onNewTask() : clickRail(r))}
                className={cn(
                  "flex size-12 flex-col items-center justify-center gap-1 rounded-md transition-colors",
                  selected ? "bg-selected-bg text-foreground" : "text-muted-foreground hover:bg-surface hover:text-foreground",
                )}
              >
                <Icon aria-hidden className={cn("size-5", selected && "text-east-red")} />
                <span className="text-xs leading-none">{label}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-auto flex flex-col items-center gap-2">
        {/* 浏览器模式如实标明不是真实后端；不可点，不计入首屏控件 */}
        {mock && (
          <span title="浏览器模式：Rust 命令由内存模拟实现，不调用真实 API" className="text-xs text-muted-foreground">
            模拟
          </span>
        )}
        {/* 本机应用没有账户，头像只作占位（第 10 节第 9 条） */}
        <CircleUser aria-hidden className="size-8 text-muted-foreground" />
      </div>
    </nav>
  );
}
