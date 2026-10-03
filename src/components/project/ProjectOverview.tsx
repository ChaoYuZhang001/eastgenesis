import { useEffect, useState } from "react";
import { Archive, ArchiveRestore, ChevronRight, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PREFERENCE_SOURCE_LABEL, preferenceSource } from "@/decision/project";
import { PREFERENCE_LABEL, goalSummary, recentItems } from "@/lib/sidebar-rows";
import { cn } from "@/lib/utils";
import { getBackend } from "@/platform";
import { useChat } from "@/stores/chat";
import { useGoals } from "@/stores/goals";
import { useProjects } from "@/stores/projects";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { useDialogs } from "@/stores/dialogs";
import { GoalStatusIcon } from "@/components/goal/GoalStatus";

// 项目概览（docs/UI_LAYOUT_V3.md 2.5）：名称、描述、生效偏好和来源、项目指令、上下文文件夹、目标与会话、记忆条数。
// 已归档的项目只读：界面不提供新建入口，主按钮是「取消归档」。
export function ProjectOverview({ id }: { id: string }) {
  const project = useProjects((s) => s.items.find((p) => p.id === id) ?? null);
  const loaded = useProjects((s) => s.loaded);
  const { unarchive } = useProjects();
  const goals = useGoals((s) => s.items);
  const sessions = useChat((s) => s.sessions);
  const select = useChat((s) => s.select);
  const global = useSettings((s) => s.routing.preference);
  const open = useUi((s) => s.open);
  const setCurrent = useUi((s) => s.setCurrentProject);
  const ask = useDialogs((s) => s.ask);
  const [memories, setMemories] = useState<number | null>(null);
  const [showIns, setShowIns] = useState(false);

  useEffect(() => {
    let live = true;
    void getBackend()
      .projectUsage(id)
      .then((u) => live && setMemories(u.memories))
      .catch(() => live && setMemories(null));
    return () => {
      live = false;
    };
  }, [id, project?.updated_at]);

  if (!project) {
    return (
      <main aria-label="项目" className="flex min-w-0 flex-1 items-center justify-center bg-surface p-8 text-sm text-muted-foreground">
        {loaded ? "这个项目已被删除或不存在。" : "读取中…"}
      </main>
    );
  }
  const pref = preferenceSource(null, null, project, global);
  const items = recentItems(
    sessions.filter((s) => s.projectId === id),
    goals.filter((g) => g.project_id === id),
    Infinity,
  );

  return (
    <main aria-label="项目" className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-surface px-8 py-8">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <header className="flex items-start gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <h1 className="flex items-center gap-2 break-words text-xl font-semibold">
              {project.name}
              {project.archived && (
                <span className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground">
                  <Archive aria-hidden className="size-3" />
                  已归档
                </span>
              )}
            </h1>
            {project.description && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{project.description}</p>}
          </div>
          {project.archived ? (
            <Button size="sm" onClick={() => void unarchive(project.id)}>
              <ArchiveRestore aria-hidden />
              取消归档
            </Button>
          ) : (
            <>
              <Button size="sm" variant="outline" onClick={() => ask({ kind: "edit-project", id: project.id })}>
                <Pencil aria-hidden />
                编辑
              </Button>
              <Button size="sm" onClick={() => {
                setCurrent(project.id);
                useChat.getState().newSession();
                open({ kind: "chat" });
              }}>
                在这个项目里新建任务
              </Button>
            </>
          )}
        </header>

        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted-foreground">路由偏好</dt>
          <dd>
            {PREFERENCE_LABEL[pref.preference]}（来自{PREFERENCE_SOURCE_LABEL[pref.source]}）
          </dd>
          <dt className="text-muted-foreground">上下文文件夹</dt>
          <dd>
            {project.context_folders.length ? (
              <ul className="space-y-1">
                {project.context_folders.map((f) => (
                  <li key={f} className="break-all font-mono text-xs">
                    {f}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-muted-foreground">没有设置</span>
            )}
          </dd>
          <dt className="text-muted-foreground">记忆</dt>
          <dd>{memories === null ? "读取中…" : `${memories} 条`}</dd>
        </dl>

        {project.instructions && (
          <section>
            <button type="button" aria-expanded={showIns} onClick={() => setShowIns((v) => !v)} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
              <ChevronRight aria-hidden className={cn("size-4 transition-transform", showIns && "rotate-90")} />
              项目指令
            </button>
            {showIns && <p className="mt-2 whitespace-pre-wrap rounded-md bg-surface-2 p-3 text-sm">{project.instructions}</p>}
          </section>
        )}

        <section aria-label="目标与会话" className="space-y-2">
          <h2 className="text-sm font-medium">目标与会话</h2>
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有目标和会话。</p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {items.map((it) =>
                it.kind === "goal" ? (
                  <li key={it.goal.id}>
                    <button type="button" onClick={() => open({ kind: "goal", id: it.goal.id })} className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm hover:bg-surface-2">
                      <GoalStatusIcon goal={it.goal} />
                      <span className="min-w-0 flex-1 truncate">{it.goal.description}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{goalSummary(it.goal)}</span>
                    </button>
                  </li>
                ) : (
                  <li key={it.session.id}>
                    <button type="button" onClick={() => {
                      select(it.session.id);
                      open({ kind: "chat" });
                    }} className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm hover:bg-surface-2">
                      <span className="min-w-0 flex-1 truncate">{it.session.title}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">会话</span>
                    </button>
                  </li>
                ),
              )}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
