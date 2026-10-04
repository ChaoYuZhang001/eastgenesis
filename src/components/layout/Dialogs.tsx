import { useEffect, useState } from "react";
import { WorkdirDialog } from "@/components/chat/WorkdirDialog";
import { ProjectDialog } from "@/components/project/ProjectDialog";
import { ConfirmDialog } from "@/components/ui/dialog";
import { useChat } from "@/stores/chat";
import { deleteSession } from "@/stores/history";
import { useTasks } from "@/stores/tasks";
import { useDialogs } from "@/stores/dialogs";
import { stopGoal } from "@/lib/goal-run";
import { useGoals } from "@/stores/goals";
import { useProjects } from "@/stores/projects";
import { useUi } from "@/stores/ui";

// 项目删除的二次确认、项目新建 / 编辑、目标放弃 / 删除（docs/UI_LAYOUT_V3.md 1.4）
export function Dialogs() {
  const current = useDialogs((s) => s.current);
  const done = useDialogs((s) => s.done);
  const pending = useProjects((s) => s.pendingDelete);
  const { cancelDelete, confirmDelete } = useProjects();
  const projects = useProjects((s) => s.items);
  const { abandon, remove } = useGoals();
  const removeSessions = useChat((s) => s.removeSessions);
  const sessions = useChat((s) => s.sessions);
  const current_ = useUi((s) => s.currentProjectId);
  const setCurrent = useUi((s) => s.setCurrentProject);
  const main = useUi((s) => s.main);
  const open = useUi((s) => s.open);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => setNote(null), [current, pending]);

  if (pending) {
    const linked = sessions.filter((s) => s.projectId === pending.id);
    // 会话数：已存进数据库的（后端数）和本次启动还没写回的，取大的
    const n = Math.max(pending.usage.sessions ?? 0, linked.length);
    const parts = [pending.usage.goals && `${pending.usage.goals} 个目标`, n && `${n} 个会话`, pending.usage.memories && `${pending.usage.memories} 条记忆`].filter(Boolean);
    return (
      <ConfirmDialog
        title={`删除「${pending.name}」？`}
        body={
          <>
            {parts.length ? `会一并删除 ${parts.join("、")}。` : "这个项目下没有目标、会话和记忆。"}
            {note && <span role="alert" className="mt-2 block text-foreground">{note}</span>}
          </>
        }
        confirm="删除"
        busy={busy}
        onCancel={cancelDelete}
        onConfirm={async () => {
          setBusy(true);
          const id = pending.id;
          // 这个项目下正在跑的目标先停下（循环会取消当前那一轮的任务），再删项目
          for (const g of useGoals.getState().items) if (g.project_id === id && g.status === "running") stopGoal(g.id);
          const r = await confirmDelete();
          setBusy(false);
          if (typeof r === "string") return setNote(r);
          removeSessions(linked.map((s) => s.id));
          if (current_ === id) setCurrent(null);
          if (main.kind === "project" && main.id === id) open({ kind: "chat" });
        }}
      />
    );
  }
  if (!current) return null;
  if (current.kind === "new-project" || current.kind === "edit-project") {
    const project = current.kind === "edit-project" ? projects.find((p) => p.id === current.id) ?? null : null;
    return <ProjectDialog project={project} onClose={done} />;
  }
  if (current.kind === "workdir") return <WorkdirDialog onClose={done} />;
  if (current.kind === "delete-session") {
    const sid = current.id;
    return (
      <ConfirmDialog
        title="删除这个会话？"
        body={
          <>
            它会从列表里移除，记录仍保存在本机。
            {note && <span role="alert" className="mt-2 block text-foreground">{note}</span>}
          </>
        }
        confirm="删除"
        busy={busy}
        onCancel={done}
        onConfirm={async () => {
          setBusy(true);
          const err = await deleteSession(sid);
          setBusy(false);
          if (err) return setNote(err);
          // 进行中的回合先停掉，再从界面上移除
          for (const t of useTasks.getState().tasks) if (t.sessionId === sid && t.status === "running") useTasks.getState().cancel(t.id);
          useTasks.setState((s) => ({ tasks: s.tasks.filter((t) => t.sessionId !== sid) }));
          removeSessions([sid]);
          done();
        }}
      />
    );
  }
  const goal = current.id;
  const abandonIt = current.kind === "abandon-goal";
  return (
    <ConfirmDialog
      title={abandonIt ? "放弃这个目标？" : "删除这个目标？"}
      body={
        <>
          {abandonIt ? "已完成的轮次会保留，之后不能再继续。" : "它会从列表里移除，记录仍保存在本机。"}
          {note && <span role="alert" className="mt-2 block text-foreground">{note}</span>}
        </>
      }
      confirm={abandonIt ? "放弃" : "删除"}
      busy={busy}
      onCancel={done}
      onConfirm={async () => {
        setBusy(true);
        const err = abandonIt ? await abandon(goal) : await remove(goal);
        setBusy(false);
        if (err) return setNote(err);
        if (!abandonIt && main.kind === "goal" && main.id === goal) open({ kind: "chat" });
        done();
      }}
    />
  );
}
