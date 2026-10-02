import { useId, useState } from "react";
import { Lock, LockOpen, SkipForward } from "lucide-react";
import type { ModelProfile } from "@/decision";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { profileOptions, statusAvailability } from "@/lib/engine";
import { useSettings } from "@/stores/settings";
import { health } from "@/stores/health";
import { useTasks, type TaskCard } from "@/stores/tasks";

// 手动干预：强制下一次模型调用用某个模型（next），或整次任务锁定某个模型（lock，不再自动降级）
export function Intervention({ task, profiles }: { task: TaskCard | null; profiles: readonly ModelProfile[] }) {
  const id = useId();
  const statuses = useSettings((s) => s.statuses);
  const custom = useSettings((s) => s.custom);
  const prefs = useSettings((s) => s.providerPrefs);
  const setOverride = useTasks((s) => s.setOverride);
  const [picked, setPicked] = useState("");
  // 熔断状态不是响应式的，每次渲染重新算（profile 只有几十个）
  const options = profileOptions(profiles, statusAvailability(statuses, custom, health, prefs));
  const choice = options.find((o) => o.id === picked) ?? options.find((o) => o.ok) ?? null;
  const running = task?.status === "running";
  const can = running && choice?.ok === true;

  const apply = (mode: "next" | "lock") => task && choice && setOverride(task.id, { mode, profileId: choice.id });

  return (
    <div className="space-y-3 text-sm">
      <div className="space-y-1">
        <label htmlFor={id} className="text-xs text-muted-foreground">
          模型
        </label>
        <Select id={id} value={choice?.id ?? ""} onChange={(e) => setPicked(e.target.value)} disabled={!running || options.length === 0}>
          {options.map((o) => (
            <option key={o.id} value={o.id} disabled={!o.ok}>
              {o.ok ? o.id : `${o.id}（${o.reason}）`}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={!can} onClick={() => apply("next")}>
          <SkipForward aria-hidden />
          下一步使用
        </Button>
        <Button size="sm" variant="secondary" disabled={!can} onClick={() => apply("lock")}>
          <Lock aria-hidden />
          锁定
        </Button>
        {task?.override && (
          <Button size="sm" variant="outline" onClick={() => setOverride(task.id, null)}>
            <LockOpen aria-hidden />
            解除
          </Button>
        )}
      </div>
      <p aria-live="polite" className="text-xs text-muted-foreground">
        {!task
          ? "选择一个进行中的任务后可以手动干预。"
          : !running
            ? "任务已结束，手动干预只对进行中的任务生效。"
            : task.override?.mode === "lock"
              ? `已锁定 ${task.override.profileId}：之后的模型调用都用它，不自动降级。`
              : task.override?.mode === "next"
                ? `下一次模型调用使用 ${task.override.profileId}，之后恢复自动路由。`
                : "当前由路由自动选择模型。"}
      </p>
    </div>
  );
}
