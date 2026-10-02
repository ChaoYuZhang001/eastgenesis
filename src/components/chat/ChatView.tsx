import { useEffect, useMemo, useRef } from "react";
import { TriangleAlert } from "lucide-react";
import { Composer } from "./Composer";
import { AssistantTurn } from "./AssistantTurn";
import { useChat } from "@/stores/chat";
import { useSettings } from "@/stores/settings";
import { useTasks } from "@/stores/tasks";

// 空白首屏的三个快捷任务：点一下填进输入框，不直接提交
const QUICK = [
  "整理这个目录里的文件，按类型分好",
  "读一下这份文档，总结要点和待办",
  "帮我查一下这段代码为什么报错",
];

// 对话视图：没有会话时是欢迎语 + 输入框；有会话时上面是对话，输入框落到底部。
// 右侧不常驻面板（docs/UI_LAYOUT_SPEC.md A 节）。
export function ChatView() {
  const activeId = useChat((s) => s.activeId);
  const tasks = useTasks((s) => s.tasks);
  const settingsError = useSettings((s) => s.error);
  const turns = useMemo(() => tasks.filter((t) => t.sessionId === activeId && activeId !== null).sort((a, b) => a.seq - b.seq), [tasks, activeId]);

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface">
      {settingsError && (
        <p role="alert" className="flex items-center gap-2 border-b border-border px-8 py-3 text-sm">
          <TriangleAlert aria-hidden className="size-4 shrink-0 text-china-gold" />
          读取设置失败：{settingsError.message}
        </p>
      )}
      {turns.length === 0 ? <Home /> : <Conversation turns={turns} />}
    </main>
  );
}

function Home() {
  const setDraft = useChat((s) => s.setDraft);
  return (
    // 输入框落在视觉 40% 的位置：上 2 份、下 3 份
    <div className="grid min-h-0 flex-1 grid-rows-[2fr_auto_3fr] overflow-y-auto px-8">
      <div />
      <div className="mx-auto w-full max-w-3xl">
        <h1 className="mb-8 font-display text-3xl font-semibold leading-tight">你好，今天想创造什么？</h1>
        <Composer autoFocus />
        <ul aria-label="快捷任务" className="mt-6 flex flex-wrap gap-2">
          {QUICK.map((q) => (
            <li key={q}>
              <button
                type="button"
                onClick={() => setDraft(q)}
                className="rounded-md border border-border px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
              >
                {q}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div />
    </div>
  );
}

function Conversation({ turns }: { turns: ReturnType<typeof useTasks.getState>["tasks"] }) {
  const ref = useRef<HTMLDivElement>(null);
  const last = turns.at(-1);

  // 新一轮出现时滚到底部；jsdom 没有 scrollTo，用可选调用
  useEffect(() => {
    const el = ref.current;
    el?.scrollTo?.({ top: el.scrollHeight });
  }, [turns.length, last?.status]);

  return (
    <>
      <div ref={ref} className="min-h-0 flex-1 overflow-y-auto px-8 py-8">
        <div className="mx-auto w-full max-w-3xl space-y-6">
          {turns.map((t) => (
            <AssistantTurn key={t.id} card={t} />
          ))}
        </div>
      </div>
      <div className="px-8 pb-6">
        <div className="mx-auto w-full max-w-3xl">
          <Composer />
        </div>
      </div>
    </>
  );
}
