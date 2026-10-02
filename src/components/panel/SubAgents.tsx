import { Circle } from "lucide-react";
import { Badge } from "@/components/ui/input";
import { StatusBadge } from "@/components/task/status";
import type { SubAgentView } from "@/lib/subagents";

// 子 Agent 并行状态：角色、子任务、模型和当前步骤；状态一律图标 + 文字
export function SubAgents({ agents }: { agents: readonly SubAgentView[] }) {
  if (agents.length === 0) {
    return <p className="text-sm text-muted-foreground">这个任务没有子 Agent。提交任务时勾选「多 Agent 协同」，这里会并列显示每个子 Agent 的模型与进度。</p>;
  }
  return (
    <ul aria-label="子 Agent" className="space-y-2">
      {agents.map((a) => (
        <li key={a.id} aria-label={a.role} className="space-y-1 rounded-md border border-border p-2 text-sm">
          <p className="flex items-center justify-between gap-2">
            <span className="truncate font-medium">{a.role}</span>
            {a.status === "pending" ? (
              <Badge>
                <Circle aria-hidden />
                等待中
              </Badge>
            ) : (
              <StatusBadge status={a.status} />
            )}
          </p>
          <p className="line-clamp-2 break-words text-xs text-muted-foreground">{a.goal}</p>
          <p className="truncate text-xs text-muted-foreground">
            {a.profileId ?? "等待路由"}
            {a.step && ` · ${a.step}`}
          </p>
        </li>
      ))}
    </ul>
  );
}
