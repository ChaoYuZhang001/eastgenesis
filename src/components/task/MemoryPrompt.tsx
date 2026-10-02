import { useState } from "react";
import { Brain, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ResultNote } from "@/components/settings/controls";
import { KIND_LABEL, type MemoryProposal } from "@/lib/memory";
import { useTasks } from "@/stores/tasks";

// 目标里明确要求记住某件事时，在卡片上请用户确认；不确认就不保存
export function MemoryPrompt({ taskId, proposal }: { taskId: string; proposal: MemoryProposal }) {
  const accept = useTasks((s) => s.acceptProposal);
  const dismiss = useTasks((s) => s.dismissProposal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    const e = await accept(taskId);
    // 成功后卡片移除这个提议，组件随之卸载，不再更新状态
    if (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <section aria-label="记忆提议" className="space-y-2 rounded-md border border-border p-3">
      <p className="flex items-center gap-2 text-sm">
        <Brain aria-hidden className="size-4 shrink-0" />
        要把这条{KIND_LABEL[proposal.kind]}记下来吗？以后的任务会参考它。
      </p>
      <p className="break-words rounded-sm bg-surface px-2 py-1 text-sm">{proposal.text}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => void save()}>
          <Check aria-hidden />
          记住
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => dismiss(taskId)}>
          <X aria-hidden />
          不用
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">记下后可以在「系统与工具 → 记忆与技能库」里修改或删除。</p>
      {error && <ResultNote result={{ ok: false, message: error }} />}
    </section>
  );
}
