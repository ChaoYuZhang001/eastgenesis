import { useEffect, useRef, useState } from "react";
import { Brain, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/input";
import { KIND_LABEL } from "@/lib/memory";
import type { Memory } from "@/platform";
import { useMemory } from "@/stores/memory";
import type { TestResult } from "@/stores/settings";
import { EmptyState, ResultNote, SettingsSection } from "./controls";
import { MemoryForm } from "./MemoryForm";

const day = (t: number) => new Date(t).toLocaleDateString("zh-CN");
const short = (s: string) => (s.length > 60 ? `${s.slice(0, 60)}…` : s);
const usage = (m: Memory) => (m.use_count > 0 && m.last_used_at ? `任务里用过 ${m.use_count} 次（最近 ${day(m.last_used_at)}）` : "还没有被任务用过");

// 记忆：逐条查看、添加、修改、删除（两步确认）。只有用户添加或确认的内容才会成为记忆
export function MemorySettings() {
  const { loaded, items, error, load, remove } = useMemory();
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [note, setNote] = useState<TestResult | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const done = (saved: boolean) => {
    setEditing(null);
    if (saved) setNote({ ok: true, message: "已保存" });
  };
  const del = async (id: string) => {
    setConfirmDel(null);
    const e = await remove(id);
    setNote(e ? { ok: false, message: e } : { ok: true, message: "已删除这条记忆" });
    root.current?.querySelector<HTMLElement>("[data-add]")?.focus();
  };

  return (
    <SettingsSection
      title="记忆"
      description="跨任务记住的偏好和事实。只有你在这里添加、或在任务卡片上确认的内容才会记下来；任务开始时带上全部偏好和与目标相关的事实，执行时间线里能看到用了哪几条。"
    >
      <div ref={root} className="space-y-3">
        {editing === "new" ? (
          <MemoryForm initial={null} onDone={done} />
        ) : (
          <Button data-add variant="outline" onClick={() => setEditing("new")}>
            <Plus aria-hidden />
            添加记忆
          </Button>
        )}
        {error && <ResultNote result={{ ok: false, message: error }} />}
        {loaded && items.length === 0 && editing !== "new" && <EmptyState icon={Brain}>暂无记忆。可以在这里添加，或在任务里说「记住……」后确认。</EmptyState>}
        {items.length > 0 && (
          <ul aria-label="记忆列表" className="space-y-3">
            {items.map((m) =>
              editing === m.id ? (
                <li key={m.id}>
                  <MemoryForm initial={m} onDone={done} />
                </li>
              ) : (
                <li key={m.id} aria-label={short(m.text)} className="space-y-2 rounded-lg border border-border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="min-w-0 break-words text-sm">{m.text}</p>
                    <Badge>{KIND_LABEL[m.kind]}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {m.source === "task" ? "任务中确认" : "手动添加"} · {day(m.created_at)} · {usage(m)}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setEditing(m.id)}>
                      <Pencil aria-hidden />
                      编辑
                    </Button>
                    {/* 同一个按钮切换成「确认删除」，焦点不丢 */}
                    <Button size="sm" variant={confirmDel === m.id ? "default" : "outline"} onClick={() => (confirmDel === m.id ? void del(m.id) : setConfirmDel(m.id))}>
                      <Trash2 aria-hidden />
                      {confirmDel === m.id ? "确认删除" : "删除"}
                    </Button>
                    {confirmDel === m.id && (
                      <Button size="sm" variant="outline" onClick={() => setConfirmDel(null)}>
                        取消
                      </Button>
                    )}
                  </div>
                </li>
              ),
            )}
          </ul>
        )}
        <ResultNote result={note} />
      </div>
    </SettingsSection>
  );
}
