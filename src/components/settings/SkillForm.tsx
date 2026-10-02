import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { MAX_SKILL_DESC, MAX_SKILL_NAME, formatStepLines, keepStepArgs, parseStepLines } from "@/lib/skill";
import type { Skill, SkillInput } from "@/platform";
import { useSkills } from "@/stores/skills";
import { ResultNote } from "./controls";

/** 添加、编辑技能，或把完成的任务保存为技能；步骤每行一个，「子目标 | 工具名」，工具名可省略 */
export function SkillForm({ initial, label, onDone }: { initial: SkillInput; label: string; onDone(saved: Skill | null): void }) {
  const nameId = useId();
  const descId = useId();
  const stepsId = useId();
  const hintId = useId();
  const save = useSkills((s) => s.save);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [steps, setSteps] = useState(formatStepLines(initial.steps));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const r = await save({ ...(initial.id ? { id: initial.id } : {}), name, description, steps: keepStepArgs(parseStepLines(steps), initial.steps), source: initial.source });
    if (typeof r === "string") {
      setError(r);
      setBusy(false);
      return;
    }
    onDone(r);
  };

  return (
    <form aria-label={label} onSubmit={(e) => void submit(e)} className="space-y-3 rounded-lg border border-border p-4">
      <div className="space-y-1">
        <label htmlFor={nameId} className="block text-sm">
          名称
        </label>
        <Input id={nameId} value={name} maxLength={MAX_SKILL_NAME} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="space-y-1">
        <label htmlFor={descId} className="block text-sm">
          说明（可选）
        </label>
        <Input id={descId} value={description} maxLength={MAX_SKILL_DESC} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="space-y-1">
        <label htmlFor={stepsId} className="block text-sm">
          步骤
        </label>
        <Textarea id={stepsId} aria-describedby={hintId} value={steps} rows={5} spellCheck={false} onChange={(e) => setSteps(e.target.value)} />
        <p id={hintId} className="text-xs text-muted-foreground">
          每行一步，写成「子目标 | 工具名」，不用工具时只写子目标。只读步骤会保留上次的参数，「再…一次」时直接执行；写入类步骤不保存参数。
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy || name.trim() === "" || steps.trim() === ""}>
          保存
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onDone(null)}>
          取消
        </Button>
      </div>
      <ResultNote result={error ? { ok: false, message: error } : null} />
    </form>
  );
}
