import { Bot, Users } from "lucide-react";
import { Badge } from "@/components/ui/input";

// 智能体：通用智能体（默认）和多 Agent 协同（提交任务时勾选）
export function AgentsPage() {
  return (
    <div className="flex min-w-0 flex-1 flex-col pb-8">
      <h1 className="mb-6 font-display text-2xl font-semibold">智能体</h1>
      <ul className="grid max-w-3xl gap-4 sm:grid-cols-2">
        <li className="space-y-2 rounded-lg border border-border bg-surface-2 p-4">
          <p className="flex items-center gap-2 font-medium">
            <Bot aria-hidden className="size-4 text-east-red" />
            通用智能体
            <Badge>默认</Badge>
          </p>
          <p className="text-sm text-muted-foreground">规划步骤 → 按路由选模型 → 调用白名单工具（写入、网络类先请你确认）→ 反思与纠错 → 产出成果。工作台提交的任务默认由它执行。</p>
        </li>
        <li className="space-y-2 rounded-lg border border-border bg-surface-2 p-4">
          <p className="flex items-center gap-2 font-medium">
            <Users aria-hidden className="size-4 text-east-red" />
            多 Agent 协同
          </p>
          <p className="text-sm text-muted-foreground">
            在输入框的「+」菜单里勾选「多 Agent 协同」：协调器把目标拆成 2–4 个互不依赖的子任务，按角色交给子 Agent，最多同时执行 2 个，每个子 Agent 独立路由选模型；需要确认的操作逐个排队请你处理；最后合并成一份成果。回答里的「多 Agent 协同」一行点开可以看每个子 Agent 的模型与进度，专家模式的右侧面板有完整时间线。
          </p>
        </li>
      </ul>
    </div>
  );
}
