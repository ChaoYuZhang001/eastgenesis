import { useCallback, useEffect, useState } from "react";
import { ChatView } from "@/components/chat/ChatView";
import { GoalDetail } from "@/components/goal/GoalDetail";
import { ContentPanel } from "@/components/layout/ContentPanel";
import { Dialogs } from "@/components/layout/Dialogs";
import { IconRail } from "@/components/layout/IconRail";
import { SidePanel } from "@/components/panel/SidePanel";
import { ProjectOverview } from "@/components/project/ProjectOverview";
import { SettingsView } from "@/components/settings/SettingsView";
import { Splash } from "@/components/Splash";
import { wasGoalInterruptedByRestart } from "@/decision/goal";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app";
import { useChat } from "@/stores/chat";
import { useGoals } from "@/stores/goals";
import { hydrateGoalCheckpoints, loadHistory, watchHistory } from "@/stores/history";
import { useUsage } from "@/stores/usage";
import { useMcp } from "@/stores/mcp";
import { useMemory } from "@/stores/memory";
import { useProjects } from "@/stores/projects";
import { useSkills } from "@/stores/skills";
import { useSettings } from "@/stores/settings";
import { contentCollapsed, useUi } from "@/stores/ui";

const ROOT_FONT = { sm: "14px", md: "", lg: "18px" } as const;

// V3 布局（docs/UI_LAYOUT_V3.md）：图标栏 60 + 内容栏 240（可收起）+ 主区 + 按需出现的右侧面板
export default function App() {
  const { phase, error, bootstrap } = useAppStore();
  const [splashGone, setSplashGone] = useState(false);
  const hideSplash = useCallback(() => setSplashGone(true), []);
  const rail = useUi((s) => s.rail);
  const main = useUi((s) => s.main);
  const collapsed = useUi(contentCollapsed);
  const panelOpen = useUi((s) => s.panel.open);
  const fontSize = useUi((s) => s.prefs.fontSize);
  const reduceMotion = useUi((s) => s.prefs.reduceMotion);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // 字号：改根元素的字号。Tailwind 的字号和间距都是 rem，整页按比例缩放；中号用浏览器默认（16px）
  useEffect(() => {
    document.documentElement.style.fontSize = ROOT_FONT[fontSize];
  }, [fontSize]);

  // 后端就绪后再读设置、记忆、技能、项目和目标
  useEffect(() => {
    if (phase !== "ready") return;
    let disposed = false;
    void useSettings
      .getState()
      .load()
      .then(() => useChat.getState().setPermission(useSettings.getState().defaultPermission));
    void useUi.getState().loadPrefs();
    void useMemory.getState().load();
    void useSkills.getState().load();
    void useProjects.getState().load();
    const goalsReady = useGoals.getState().load();
    // 内置文件工具（~/Downloads）随应用启动连接；mock 后端没有内置服务器
    void useMcp.getState().startBuiltins();
    // 会话持久化（迁移 5）：读回历史会话和本月的调用记录，之后每轮结束写回
    const historyReady = loadHistory();
    // 启动时只自动打开一个明确的恢复入口：会话优先；没有会话恢复时再打开目标详情。
    // 如果用户已经提交新任务或主动切到别的主区，异步读库完成后不抢走当前焦点。
    void Promise.all([goalsReady, historyReady]).then(() => {
      if (disposed) return;
      hydrateGoalCheckpoints();
      if (useChat.getState().activeId !== null || useUi.getState().main.kind !== "chat") return;
      const goal = useGoals
        .getState()
        .items.filter(wasGoalInterruptedByRestart)
        .sort((a, b) => b.updated_at - a.updated_at)[0];
      if (goal) useUi.getState().open({ kind: "goal", id: goal.id });
    });
    void useUsage.getState().load();
    const stopHistory = watchHistory();
    return () => {
      disposed = true;
      stopHistory();
    };
  }, [phase]);

  const newTask = useCallback(() => {
    useChat.getState().newSession();
    useUi.getState().open({ kind: "chat" });
  }, []);

  // 窗口内快捷键（不注册系统全局快捷键）：⌘N 新任务、⌘B 收起内容栏、⌘, 设置
  useEffect(() => {
    if (phase !== "ready") return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k === "n") newTask();
      else if (k === "b") useUi.getState().toggleCollapsed();
      else if (k === ",") useUi.getState().openSettings();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, newTask]);

  return (
    <div className={cn("flex h-full", reduceMotion && "motion-off")}>
      {!splashGone && <Splash done={phase === "ready"} error={error} onRetry={() => void bootstrap()} onHidden={hideSplash} />}
      {phase === "ready" && (
        <>
          <IconRail onNewTask={newTask} />
          {!collapsed && <ContentPanel onNewTask={newTask} />}
          {rail === "settings" ? (
            <SettingsView />
          ) : main.kind === "goal" ? (
            <GoalDetail id={main.id} />
          ) : main.kind === "project" ? (
            <ProjectOverview id={main.id} />
          ) : (
            <ChatView />
          )}
          {panelOpen && rail !== "settings" && <SidePanel />}
          <Dialogs />
        </>
      )}
    </div>
  );
}
