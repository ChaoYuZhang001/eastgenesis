import { useEffect, useRef, useState } from "react";
import { BookOpen, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/input";
import type { Skill, SkillInput } from "@/platform";
import type { TestResult } from "@/stores/settings";
import { useSkills } from "@/stores/skills";
import { EmptyState, ResultNote, SettingsSection } from "./controls";
import { SkillForm } from "./SkillForm";

const day = (t: number) => new Date(t).toLocaleDateString("zh-CN");
const EMPTY: SkillInput = { name: "", description: "", steps: [] };
const usage = (s: Skill) => (s.use_count > 0 && s.last_used_at ? `规划参考过 ${s.use_count} 次（最近 ${day(s.last_used_at)}）` : "还没有被规划参考过");
const toInput = (s: Skill): SkillInput => ({ id: s.id, name: s.name, description: s.description, steps: s.steps, source: s.source });

// 技能库：逐个查看、添加、修改、删除（两步确认）。完成的任务可以在卡片上保存为技能
export function SkillSettings() {
  const { loaded, items, error, load, remove } = useSkills();
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [note, setNote] = useState<TestResult | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const done = (saved: Skill | null) => {
    setEditing(null);
    if (saved) setNote({ ok: true, message: `已保存技能「${saved.name}」` });
  };
  const del = async (id: string) => {
    setConfirmDel(null);
    const e = await remove(id);
    setNote(e ? { ok: false, message: e } : { ok: true, message: "已删除这个技能" });
    root.current?.querySelector<HTMLElement>("[data-add]")?.focus();
  };

  return (
    <SettingsSection
      title="技能库"
      description="沉淀下来的可复用流程。规划时按目标挑出最相关的一两个作参考，不强制照做，执行时间线里能看到参考了哪个。完成的任务可以在卡片上「保存为技能」。"
    >
      <div ref={root} className="space-y-3">
        {editing === "new" ? (
          <SkillForm initial={EMPTY} label="添加技能" onDone={done} />
        ) : (
          <Button data-add variant="outline" onClick={() => setEditing("new")}>
            <Plus aria-hidden />
            添加技能
          </Button>
        )}
        {error && <ResultNote result={{ ok: false, message: error }} />}
        {loaded && items.length === 0 && editing !== "new" && <EmptyState icon={BookOpen}>暂无技能。任务完成后可以在卡片上保存为技能，也可以在这里添加。</EmptyState>}
        {items.length > 0 && (
          <ul aria-label="技能列表" className="space-y-3">
            {items.map((s) =>
              editing === s.id ? (
                <li key={s.id}>
                  <SkillForm initial={toInput(s)} label="编辑技能" onDone={done} />
                </li>
              ) : (
                <li key={s.id} aria-label={s.name} className="space-y-2 rounded-lg border border-border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 space-y-1">
                      <p className="font-medium">{s.name}</p>
                      {s.description && <p className="break-words text-sm text-muted-foreground">{s.description}</p>}
                    </div>
                    <Badge>{s.steps.length} 步</Badge>
                  </div>
                  <ol aria-label={`${s.name} 的步骤`} className="list-decimal space-y-1 pl-6 text-sm">
                    {s.steps.map((x, i) => (
                      <li key={i} className="break-words">
                        {x.goal}
                        {x.tool && <code className="ml-2 font-mono text-xs text-muted-foreground">{x.tool}</code>}
                      </li>
                    ))}
                  </ol>
                  <p className="text-xs text-muted-foreground">
                    {s.source === "task" ? "从任务保存" : "手动添加"} · {day(s.created_at)} · {usage(s)}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setEditing(s.id)}>
                      <Pencil aria-hidden />
                      编辑
                    </Button>
                    {/* 同一个按钮切换成「确认删除」，焦点不丢 */}
                    <Button size="sm" variant={confirmDel === s.id ? "default" : "outline"} onClick={() => (confirmDel === s.id ? void del(s.id) : setConfirmDel(s.id))}>
                      <Trash2 aria-hidden />
                      {confirmDel === s.id ? "确认删除" : "删除"}
                    </Button>
                    {confirmDel === s.id && (
                      <Button size="sm" variant="outline" onClick={() => setConfirmDel(null)}>
                        取消
                      </Button>
                    )}
                  </div>
                </li>
              ),
            )}
          </ul>
        )}
        <ResultNote result={note} />
      </div>
    </SettingsSection>
  );
}
