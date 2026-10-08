import { useState, type DragEvent } from "react";
import { TriangleAlert } from "lucide-react";
import { TaskInput } from "@/components/TaskInput";
import { useSettings } from "@/stores/settings";
import { useTasks } from "@/stores/tasks";
import { TaskCard } from "./TaskCard";

// 中央任务画布：问候语 + 输入框 + 任务卡片列表（可拖拽排序、折叠、关闭）
export function TaskCanvas() {
  const { tasks, activeId, move } = useTasks();
  const settingsError = useSettings((s) => s.error);
  // 拖拽状态放在组件里，不依赖 DataTransfer 内容（jsdom 与部分 WebView 对它支持不全）
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");

  const moveTo = (id: string, toIndex: number) => {
    const n = tasks.length;
    const to = Math.max(0, Math.min(toIndex, n - 1));
    if (tasks.findIndex((t) => t.id === id) === to) return;
    move(id, to);
    setAnnounce(`已移到第 ${to + 1} 位，共 ${n} 个任务`);
  };

  const onDragStart = (id: string, e: DragEvent) => {
    setDragId(id);
    const dt = e.dataTransfer;
    if (!dt) return;
    dt.effectAllowed = "move";
    // 部分 WebKit 需要 setData 才会开始拖拽
    dt.setData("text/plain", id);
    const card = (e.currentTarget as HTMLElement).closest("article");
    if (card && typeof dt.setDragImage === "function") dt.setDragImage(card, 16, 16);
  };
  const onDragOver = (id: string, e: DragEvent) => {
    if (!dragId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (overId !== id) setOverId(id);
  };
  const onDrop = (id: string, e: DragEvent) => {
    e.preventDefault();
    if (dragId && dragId !== id) moveTo(dragId, tasks.findIndex((t) => t.id === id));
    setDragId(null);
    setOverId(null);
  };
  const onDragEnd = () => {
    setDragId(null);
    setOverId(null);
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-surface">
      <div className="mx-auto flex w-full max-w-4xl flex-col items-center px-8 pb-8 pt-16">
        <h1 className="w-4/5 font-display text-4xl font-semibold leading-tight">
          你好，
          <br />
          今天想创造什么？
        </h1>
        <div className="mt-8 flex w-full justify-center">
          <TaskInput />
        </div>
        {settingsError && (
          <p role="alert" className="mt-4 flex w-4/5 items-center gap-2 text-sm">
            <TriangleAlert aria-hidden className="size-4 shrink-0 text-china-gold" />
            读取设置失败：{settingsError.message}
          </p>
        )}

        <section aria-labelledby="task-list-title" className="mt-10 w-full space-y-3">
          <h2 id="task-list-title" className="sr-only">
            任务
          </h2>
          {tasks.map((t, i) => (
            <TaskCard
              key={t.id}
              card={t}
              index={i}
              count={tasks.length}
              active={t.id === activeId}
              dragging={t.id === dragId}
              dropTarget={t.id === overId && t.id !== dragId}
              onMove={moveTo}
              onDragStart={onDragStart}
              onDragOver={onDragOver}
              onDrop={onDrop}
              onDragEnd={onDragEnd}
            />
          ))}
        </section>
        <p aria-live="polite" className="sr-only">
          {announce}
        </p>
      </div>
    </main>
  );
}
