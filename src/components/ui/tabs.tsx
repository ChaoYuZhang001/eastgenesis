import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// 无障碍标签页：role=tablist/tab/tabpanel，左右方向键、Home/End 切换（WAI-ARIA Tabs 模式）
export interface TabItem {
  id: string;
  label: string;
  content: ReactNode;
}

export function Tabs({ items, value, onChange, label }: { items: TabItem[]; value: string; onChange: (id: string) => void; label: string }) {
  const base = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = items.find((t) => t.id === value) ?? items[0];

  const onKey = (e: KeyboardEvent, i: number) => {
    const n = items.length;
    const next = e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    onChange(items[next].id);
    refs.current[next]?.focus();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" aria-label={label} className="flex gap-1 border-b border-border">
        {items.map((t, i) => {
          const selected = t.id === current.id;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`${base}-panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(t.id)}
              onKeyDown={(e) => onKey(e, i)}
              className={cn(
                "border-b-2 px-3 py-2 text-sm transition-colors",
                selected ? "border-east-red text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={`${base}-panel-${current.id}`} aria-labelledby={`${base}-tab-${current.id}`} tabIndex={0} className="min-h-0 flex-1 overflow-auto py-6">
        {current.content}
      </div>
    </div>
  );
}
