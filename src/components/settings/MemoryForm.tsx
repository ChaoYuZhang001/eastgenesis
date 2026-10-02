import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_MEMORY_TEXT } from "@/lib/memory";
import type { Memory, MemoryKind } from "@/platform";
import { useMemory } from "@/stores/memory";
import { RadioGroup, ResultNote, type RadioOption } from "./controls";

const KIND_OPTIONS: RadioOption<MemoryKind>[] = [
  { value: "preference", label: "偏好", hint: "每个任务都会带上" },
  { value: "fact", label: "事实", hint: "和目标相关时带上" },
];

/** 添加或编辑一条记忆；initial 为 null 时新建 */
export function MemoryForm({ initial, onDone }: { initial: Memory | null; onDone(saved: boolean): void }) {
  const f = useId();
  const save = useMemory((s) => s.save);
  const [kind, setKind] = useState<MemoryKind>(initial?.kind ?? "preference");
  const [text, setText] = useState(initial?.text ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const r = await save({ ...(initial ? { id: initial.id } : {}), kind, text });
    if (typeof r === "string") {
      setError(r);
      setBusy(false);
      return;
    }
    onDone(true);
  };

  return (
    <form aria-label={initial ? "编辑记忆" : "添加记忆"} onSubmit={(e) => void submit(e)} className="space-y-3 rounded-lg border border-border p-4">
      <RadioGroup legend="类型" value={kind} options={KIND_OPTIONS} onChange={setKind} />
      <div className="space-y-1">
        <label htmlFor={f} className="block text-sm">
          内容
        </label>
        <Input id={f} value={text} maxLength={MAX_MEMORY_TEXT} onChange={(e) => setText(e.target.value)} placeholder="例如：回答时先给结论，再给理由" />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy || text.trim() === ""}>
          保存
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onDone(false)}>
          取消
        </Button>
      </div>
      <ResultNote result={error ? { ok: false, message: error } : null} />
    </form>
  );
}
