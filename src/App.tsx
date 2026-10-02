import { useCallback, useEffect, useState } from "react";
import { ChatView } from "@/components/chat/ChatView";
import { RightPanel } from "@/components/panel/RightPanel";
import { SettingsShell } from "@/components/settings/SettingsShell";
import { Sidebar } from "@/components/Sidebar";
import { Splash } from "@/components/Splash";
import { TaskCanvas } from "@/components/task/TaskCanvas";
import { useAppStore } from "@/stores/app";
import { useMcp } from "@/stores/mcp";
import { useMemory } from "@/stores/memory";
import { useSkills } from "@/stores/skills";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";

// 默认两区：左侧会话列表 + 中央对话。右侧执行面板和任务画布只在专家模式出现（docs/UI_LAYOUT_SPEC.md）
export default function App() {
  const { phase, error, bootstrap } = useAppStore();
  const view = useUi((s) => s.view);
  const expert = useUi((s) => s.expert);
  const [splashGone, setSplashGone] = useState(false);
  const hideSplash = useCallback(() => setSplashGone(true), []);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // 后端就绪后再读设置（Key 状态、路由偏好、能力矩阵调整）、记忆和技能库
  useEffect(() => {
    if (phase !== "ready") return;
    void useSettings.getState().load();
    void useMemory.getState().load();
    void useSkills.getState().load();
    // 内置文件工具（~/Downloads）随应用启动连接；mock 后端没有内置服务器
    void useMcp.getState().startBuiltins();
  }, [phase]);

  return (
    <div className="flex h-full">
      {!splashGone && <Splash done={phase === "ready"} error={error} onRetry={() => void bootstrap()} onHidden={hideSplash} />}
      {phase === "ready" && (
        <>
          <Sidebar />
          {view === "chat" ? expert ? <TaskCanvas /> : <ChatView /> : <SettingsShell view={view} />}
          {view === "chat" && expert && <RightPanel />}
        </>
      )}
    </div>
  );
}
