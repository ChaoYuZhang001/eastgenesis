import { MemorySettings } from "./MemorySettings";
import { SkillSettings } from "./SkillSettings";

// 「记忆与技能库」标签页

export function MemorySkills() {
  return (
    <div className="space-y-10">
      <MemorySettings />
      <SkillSettings />
    </div>
  );
}
