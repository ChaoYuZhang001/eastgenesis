import { useMemo, useState } from "react";
import { BookmarkPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ResultNote } from "@/components/settings/controls";
import { SkillForm } from "@/components/settings/SkillForm";
import { MAX_SKILL_DESC, MAX_SKILL_NAME, MAX_SKILL_STEPS, recipeFromEvents } from "@/lib/skill";
import type { TaskCard } from "@/stores/tasks";

// 完成的任务：把实际做完的步骤（子目标 + 工具名，只读步骤带参数）保存为技能，保存前可以修改
export function SaveSkill({ card }: { card: TaskCard }) {
  const steps = useMemo(() => recipeFromEvents(card.events), [card.events]);
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  if (steps.length === 0) return null;

  if (open) {
    const initial = {
      name: card.goal.slice(0, MAX_SKILL_NAME),
      description: card.goal.length > MAX_SKILL_NAME ? card.goal.slice(0, MAX_SKILL_DESC) : "",
      steps: steps.slice(0, MAX_SKILL_STEPS),
      source: "task" as const,
    };
    return <SkillForm initial={initial} label="保存为技能" onDone={(s) => (setOpen(false), setSaved(s ? `已保存到技能库：「${s.name}」` : null))} />;
  }
  return (
    <div className="space-y-2">
      <Button size="sm" variant="outline" onClick={() => (setOpen(true), setSaved(null))}>
        <BookmarkPlus aria-hidden />
        保存为技能
      </Button>
      {saved && <ResultNote result={{ ok: true, message: saved }} />}
    </div>
  );
}
