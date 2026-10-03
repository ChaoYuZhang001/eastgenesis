import { useEffect, useMemo, useState } from "react";
import { FileText, GitCompare, Terminal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ACTION_LABEL, artifactsOf, changesOf } from "@/lib/artifacts";
import { cn } from "@/lib/utils";
import { useChat } from "@/stores/chat";
import { previewFile } from "@/stores/mcp";
import { useTasks } from "@/stores/tasks";
import { useUi, type PanelTab } from "@/stores/ui";

// 右侧面板（docs/UI_LAYOUT_V3.md 第 7 节）：默认不出现；当前会话有文件、改动或命令输出时，你点了入口才打开。
// Agent 写文件时不会自动弹出。内容一律当作不可信文本：不渲染 HTML、不加载外部资源、链接不可点。
const TABS: { id: PanelTab; label: string; icon: typeof FileText }[] = [
  { id: "files", label: "文件", icon: FileText },
  { id: "changes", label: "改动", icon: GitCompare },
  { id: "terminal", label: "终端输出", icon: Terminal },
];

export function useSessionArtifacts() {
  const activeId = useChat((s) => s.activeId);
  const tasks = useTasks((s) => s.tasks);
  return useMemo(() => {
    const events = tasks.filter((t) => t.sessionId === activeId && activeId !== null).sort((a, b) => a.seq - b.seq).flatMap((t) => t.events);
    return artifactsOf(events);
  }, [tasks, activeId]);
}

export function SidePanel() {
  const panel = useUi((s) => s.panel);
  const close = useUi((s) => s.closePanel);
  const openPanel = useUi((s) => s.openPanel);
  const { files, commands } = useSessionArtifacts();
  const changes = changesOf(files);
  const available = TABS.filter((t) => (t.id === "files" ? files.length > 0 : t.id === "changes" ? changes.length > 0 : commands.length > 0));
  const tab = available.some((t) => t.id === panel.tab) ? panel.tab : available[0]?.id ?? panel.tab;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const title = tab === "files" ? (panel.path ?? "文件") : tab === "changes" ? "改动" : "终端输出";
  return (
    <aside aria-label="右侧面板" className="flex w-panel shrink-0 flex-col border-l border-border bg-surface-2">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <p className="min-w-0 flex-1 truncate text-sm font-medium" title={title}>
          {title}
        </p>
        <Button size="icon" variant="ghost" className="size-8" aria-label="关闭面板" onClick={close}>
          <X aria-hidden />
        </Button>
      </div>
      {available.length > 1 && (
        <div role="tablist" aria-label="面板内容" className="flex gap-1 border-b border-border px-2">
          {available.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={t.id === tab} onClick={() => openPanel(t.id, t.id === "files" ? panel.path : null)}
              className={cn("border-b-2 px-2 py-2 text-xs", t.id === tab ? "border-east-red text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
              {t.label}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-4 text-sm">
        {available.length === 0 && <p className="text-muted-foreground">这个会话还没有文件、改动或命令输出。</p>}
        {tab === "files" && files.length > 0 && <FilesTab selected={panel.path} files={files.map((f) => f.path)} onPick={(p) => openPanel("files", p)} />}
        {tab === "changes" && changes.length > 0 && (
          <ul aria-label="改动" className="space-y-2">
            {changes.map((c) => (
              <li key={`${c.action}-${c.path}`} className="space-y-1">
                <p className="text-xs text-muted-foreground">{ACTION_LABEL[c.action]}</p>
                <p className="break-all font-mono text-xs">
                  {c.path}
                  {c.to ? ` → ${c.to}` : ""}
                </p>
              </li>
            ))}
            <li className="pt-2 text-xs text-muted-foreground">修改前的内容没有保存，所以这里只列出改了哪些文件，不显示逐行差异。</li>
          </ul>
        )}
        {tab === "terminal" && commands.length > 0 && (
          <ul aria-label="命令输出" className="space-y-4">
            {commands.map((c, i) => (
              <li key={i} className="space-y-1">
                <p className="break-all font-mono text-xs">$ {c.command}</p>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface p-2 font-mono text-xs">{c.output.slice(-4000)}</pre>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function FilesTab({ files, selected, onPick }: { files: string[]; selected: string | null; onPick: (p: string) => void }) {
  const path = selected && files.includes(selected) ? selected : files[0]!;
  const [state, setState] = useState<{ path: string; ok: boolean; text: string } | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    setState(null);
    void previewFile(path, ctrl.signal)
      .then((r) => !ctrl.signal.aborted && setState({ path, ...r }))
      .catch((e) => !ctrl.signal.aborted && setState({ path, ok: false, text: e instanceof Error ? e.message : "读取失败" }));
    return () => ctrl.abort();
  }, [path]);
  return (
    <div className="space-y-3">
      {files.length > 1 && (
        <ul aria-label="文件" className="space-y-1">
          {files.map((f) => (
            <li key={f}>
              <button type="button" aria-current={f === path ? "true" : undefined} onClick={() => onPick(f)}
                className={cn("w-full truncate rounded-sm px-2 py-1 text-left font-mono text-xs", f === path ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")} title={f}>
                {f}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!state ? (
        <p className="text-muted-foreground">读取中…</p>
      ) : state.ok ? (
        <pre aria-label="文件内容" className="whitespace-pre-wrap break-all font-mono text-xs">{state.text.slice(0, 20000)}</pre>
      ) : (
        <p role="alert">{state.text}</p>
      )}
    </div>
  );
}
