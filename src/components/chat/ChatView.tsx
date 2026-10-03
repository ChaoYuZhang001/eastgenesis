import { useEffect, useMemo, useRef } from "react";
import { PanelRightOpen, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSessionArtifacts } from "@/components/panel/SidePanel";
import { useUi } from "@/stores/ui";
import { Composer } from "./Composer";
import { AssistantTurn } from "./AssistantTurn";
import { useChat } from "@/stores/chat";
import { useSettings } from "@/stores/settings";
import { useTasks } from "@/stores/tasks";

// 空白首屏的三个快捷建议（V3 2.1）：外观是文字链接，语义是按钮；点了只填进输入框并聚焦，不提交
const QUICK = ["整理这个文件夹的文件", "读一下这份文档，总结要点", "帮我查一下这段代码为什么报错"];

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
      {turns.length > 0 && <PanelToggle />}
      {turns.length === 0 ? <Home /> : <Conversation turns={turns} />}
    </main>
  );
}

// 右侧面板入口：只在当前会话有文件、改动或命令输出时出现，所以首屏没有它（V3 7.1）
function PanelToggle() {
  const { files, commands } = useSessionArtifacts();
  const open = useUi((s) => s.panel.open);
  const openPanel = useUi((s) => s.openPanel);
  const close = useUi((s) => s.closePanel);
  if (!files.length && !commands.length) return null;
  return (
    <div className="flex justify-end px-4 pt-3">
      <Button size="icon" variant="ghost" className="size-8" aria-label={open ? "关闭面板" : "打开面板"} aria-expanded={open}
        onClick={() => (open ? close() : openPanel(files.length ? "files" : "terminal", null, window.innerWidth < 1180))}>
        <PanelRightOpen aria-hidden />
      </Button>
    </div>
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
        <ul aria-label="快捷任务" className="mt-6 flex flex-wrap gap-x-4 gap-y-2">
          {QUICK.map((q) => (
            <li key={q}>
              <button
                type="button"
                onClick={() => {
                  setDraft(q);
                  document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
                }}
                className="rounded-sm text-left text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
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
