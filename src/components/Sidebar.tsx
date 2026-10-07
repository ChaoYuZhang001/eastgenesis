import { useState } from "react";
import { Circle, Database, FlaskConical, Plus, Search, Settings, SlidersHorizontal } from "lucide-react";
import { brand } from "@/brand/assets";
import { Badge, Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app";
import { useChat, visibleSessions } from "@/stores/chat";
import { useUi } from "@/stores/ui";

// 左侧边栏：品牌标识、新建会话、会话列表，底部是设置、专家模式和后端状态。
// 首屏的固定控件只有这几个，右侧不常驻任何面板（docs/UI_LAYOUT_SPEC.md A 节）。
export function Sidebar() {
  const openSettings = useUi((s) => s.openSettings);
  const expert = useUi((s) => s.prefs.expert);
  const setPrefs = useUi((s) => s.setPrefs);
  const { sessions, activeId, query, setQuery, newSession, select } = useChat();
  const list = visibleSessions(sessions, query);

  return (
    <aside aria-label="侧边栏" className="flex w-sidebar shrink-0 flex-col border-r border-border bg-surface-2">
      {/* 深色底用 logo-dark-transparent；显示宽度 176px，不小于 160px 的建议下限（BRAND.md 8.2-3） */}
      <div className="px-5 pb-4 pt-8">
        <img src={brand.assets.logoDarkTransparent} alt={brand.product} className="w-32 select-none" draggable={false} />
      </div>

      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={newSession}
          className="flex w-full items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-foreground transition-colors hover:bg-surface"
        >
          <Plus aria-hidden className="size-4 shrink-0" />
          新任务
        </button>
      </div>

      <div className="relative px-3 pb-2">
        <Search aria-hidden className="pointer-events-none absolute left-6 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
        <Input aria-label="搜索会话" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索会话" className="h-8 pl-7 text-xs" />
      </div>

      <nav aria-label="会话列表" className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {list.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">{sessions.length ? "没有匹配的会话" : "还没有会话"}</p>
        ) : (
          <ul className="space-y-1">
            {list.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  aria-current={s.id === activeId ? "page" : undefined}
                  onClick={() => select(s.id)}
                  title={s.title}
                  className={cn(
                    "block w-full truncate rounded-md px-3 py-2 text-left text-sm transition-colors",
                    s.id === activeId ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-surface hover:text-foreground",
                  )}
                >
                  {s.title}
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>

      <div className="border-t border-border px-3 py-3">
        <button
          type="button"
          onClick={() => openSettings("providers")}
          className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
        >
          <Settings aria-hidden className="size-4" />
          设置
        </button>
        <button
          type="button"
          aria-pressed={expert}
          onClick={() => setPrefs({ expert: !expert })}
          title="专家模式：显示任务画布、执行时间线和完整路由数据"
          className={cn(
            "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
            expert ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-surface hover:text-foreground",
          )}
        >
          <SlidersHorizontal aria-hidden className={cn("size-4", expert && "text-east-red")} />
          专家模式
        </button>
        <BackendStatus />
      </div>
    </aside>
  );
}

// 后端状态：一个点加一行字，展开后是存储和模式细节。点用金色，出错用红色，不用绿色（BRAND.md 4.3-3）
function BackendStatus() {
  const [open, setOpen] = useState(false);
  const init = useAppStore((s) => s.init);
  const kind = useAppStore((s) => s.backendKind);
  const persisted = init?.storage === "sqlite";
  // 桌面端只写「离线可用」：存储在本机，不依赖云端服务；浏览器模式仍注明是模拟后端
  const label = kind === "mock" ? "模拟后端" : init ? "离线可用" : "后端未就绪";

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
      >
        {/* 正常时不放状态点，只有没就绪时用红点提醒 */}
        {!init && <Circle aria-hidden className="size-2 fill-current text-east-red" />}
        {label}
      </button>
      {open && (
        <div className="space-y-2 px-3 pb-2 text-xs text-muted-foreground">
          {kind === "mock" && (
            <Badge title="浏览器模式：Rust 命令由内存 mock 实现，不调用真实 API">
              <FlaskConical aria-hidden />
              模拟后端
            </Badge>
          )}
          <p className="flex items-center gap-2">
            <Database aria-hidden className="size-3" />
            {init ? (persisted ? `SQLite · 结构版本 ${init.schemaVersion ?? "未知"}` : "内存存储（不持久化）") : "未初始化"}
          </p>
        </div>
      )}
    </div>
  );
}
