import { useId } from "react";
import { Lightbulb } from "lucide-react";
import type { Plan } from "@/agent/types";
import { Button } from "@/components/ui/button";

// 计划模式（docs/UI_LAYOUT_V3.md 第 4 节）：规划完成后停下来，列出计划，你点「开始执行」才执行第一步；「取消」后一步都不执行。
// 计划里每一步要用的工具照常经过权限确认，批准计划不等于批准每一次写入。
export function PlanPrompt({ plan, onRespond }: { plan: Plan; onRespond: (approved: boolean) => void }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="space-y-3 rounded-md border border-border p-4">
      <p id={id} className="flex items-center gap-2 text-sm font-medium">
        <Lightbulb aria-hidden className="size-4 text-china-gold" />
        计划（{plan.steps.length} 步），确认后开始执行
      </p>
      <ol aria-label="计划步骤" className="list-decimal space-y-1 pl-6 text-sm">
        {plan.steps.map((s) => (
          <li key={s.id}>
            {s.goal}
            {s.tool && <code className="ml-2 font-mono text-xs text-muted-foreground">{s.tool}</code>}
          </li>
        ))}
      </ol>
      {plan.more && <p className="text-xs text-muted-foreground">做完这几步后会根据结果继续规划，后面的步骤不再单独确认计划。</p>}
      <p className="text-xs text-muted-foreground">写入、删除这类操作执行前仍会单独请你确认。</p>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => onRespond(true)}>
          开始执行
        </Button>
        <Button size="sm" variant="outline" onClick={() => onRespond(false)}>
          取消
        </Button>
      </div>
    </div>
  );
}
