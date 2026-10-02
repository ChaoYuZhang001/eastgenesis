// 浏览器模式的技能库：内存 Map，规则与桌面端（lib/db-skill.ts）相同。
import { MAX_SKILLS, SKILL_ID, invalidSkillId, newSkillId, normalizeSkill, skillFull, skillNotFound } from "@/lib/skill";
import type { Backend, Skill } from "./types";

type SkillBackend = Pick<Backend, "listSkills" | "saveSkill" | "deleteSkill" | "touchSkills">;
const copy = (s: Skill): Skill => ({ ...s, steps: s.steps.map((x) => ({ ...x })) });

export function createMockSkills(now: () => number = Date.now): SkillBackend {
  const items = new Map<string, Skill>();
  return {
    // 更新时间相同时后加入的在前，与 SQL 的 ORDER BY updated_at DESC, created_at DESC 一致
    listSkills: async () => [...items.values()].reverse().sort((a, b) => b.updated_at - a.updated_at).map(copy),
    async saveSkill(s) {
      if (s.id !== undefined && !SKILL_ID.test(s.id)) throw invalidSkillId();
      const v = normalizeSkill(s);
      const t = now();
      if (s.id) {
        const cur = items.get(s.id);
        if (!cur) throw skillNotFound();
        const next: Skill = { ...cur, name: v.name, description: v.description, steps: v.steps, updated_at: t };
        items.set(s.id, next);
        return copy(next);
      }
      if (items.size >= MAX_SKILLS) throw skillFull();
      const created: Skill = { id: newSkillId(), ...v, created_at: t, updated_at: t, use_count: 0, last_used_at: null };
      items.set(created.id, created);
      return copy(created);
    },
    async deleteSkill(id) {
      if (!SKILL_ID.test(id)) throw invalidSkillId();
      items.delete(id);
    },
    async touchSkills(ids) {
      const t = now();
      for (const id of ids) {
        const s = items.get(id);
        if (s) items.set(id, { ...s, use_count: s.use_count + 1, last_used_at: t });
      }
    },
  };
}
