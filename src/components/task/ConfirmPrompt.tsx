import { useId } from "react";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ConfirmRequest } from "@/agent/types";

const RISK_LABEL = { low: "低", medium: "中", high: "高" } as const;
const MAX_ARGS = 2000;

// 权限确认：写入、网络、执行类工具调用前停下来等用户（M4 gateAction）。参数在运行时里已脱敏。
export function ConfirmPrompt({ req, onRespond }: { req: ConfirmRequest; onRespond: (approved: boolean) => void }) {
  const id = useId();
  const args = JSON.stringify(req.args, null, 2);
  return (
    <div role="group" aria-labelledby={id} className="space-y-3 rounded-md border border-east-red/60 p-4">
      <p id={id} className="flex items-center gap-2 text-sm font-medium">
        <ShieldAlert aria-hidden className="size-4 text-east-red" />
        {req.second ? "再次确认：删除后无法恢复，确定执行 " : "执行工具 "}
        <code className="font-mono">{req.tool}</code>
        {req.second ? "？" : " 前需要你的确认"}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {req.agent && (
          <>
            <dt>子 Agent</dt>
            <dd className="text-foreground">{req.agent}</dd>
          </>
        )}
        <dt>风险</dt>
        <dd className="text-foreground">{RISK_LABEL[req.risk]}</dd>
        <dt>步骤</dt>
        <dd className="text-foreground">{req.step.goal}</dd>
        {req.reasons.length > 0 && (
          <>
            <dt>原因</dt>
            <dd className="text-foreground">{req.reasons.join("；")}</dd>
          </>
        )}
      </dl>
      {args !== "{}" && (
        <pre aria-label="调用参数（已脱敏）" className="max-h-40 overflow-auto rounded-sm bg-surface p-2 font-mono text-xs">
          {args.length > MAX_ARGS ? `${args.slice(0, MAX_ARGS)}…` : args}
        </pre>
      )}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => onRespond(true)}>
          批准
        </Button>
        <Button size="sm" variant="outline" onClick={() => onRespond(false)}>
          拒绝
        </Button>
      </div>
    </div>
  );
}
