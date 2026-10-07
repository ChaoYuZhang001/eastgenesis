// @vitest-environment node
import golden from "./fixtures/golden_tasks.json";
import { MODEL_PROFILES } from "@/decision/profiles";
import { route } from "@/decision/router";
import { WORK_SURFACES, type Attachment, type Capability, type WorkSurface } from "@/decision/types";

const allAvailable = () => ({ ok: true as const, health: 1 });
const profiles = new Map(MODEL_PROFILES.map((profile) => [profile.id, profile]));
const tasks = golden.tasks as Array<{
  id: string;
  category: "chat" | "work" | "codex" | "cross_surface";
  input: string;
  attachments?: Attachment[];
  expected_surface: WorkSurface;
  expected_type: string;
  hard_capabilities: Capability[];
  acceptable_providers: string[];
  required_surfaces?: WorkSurface[];
  route_reason: string;
}>;

describe("30 条统一工作台黄金任务", () => {
  it("覆盖 Chat、Work、Codex 和跨能力链，并保持匿名标注结构", () => {
    expect(golden.schemaVersion).toBe(1);
    expect(tasks).toHaveLength(30);
    expect(new Set(tasks.map((task) => task.id)).size).toBe(30);
    expect(Object.fromEntries([...new Set(tasks.map((task) => task.category))].map((category) => [category, tasks.filter((task) => task.category === category).length]))).toEqual({
      chat: 6,
      work: 7,
      codex: 8,
      cross_surface: 9,
    });
    for (const task of tasks) {
      expect(WORK_SURFACES).toContain(task.expected_surface);
      expect(task.input.length).toBeGreaterThan(0);
      expect(task.route_reason.length).toBeGreaterThan(0);
      if (task.required_surfaces) {
        expect(task.required_surfaces).toContain(task.expected_surface);
        expect(task.required_surfaces.every((surface) => WORK_SURFACES.includes(surface))).toBe(true);
      }
    }
  });

  it("每条任务的类型、能力面和硬能力都能由当前规则稳定重放", () => {
    for (const task of tasks) {
      const decision = route(
        { text: task.input, ...(task.attachments ? { attachments: task.attachments } : {}) },
        { profiles: MODEL_PROFILES, availability: allAvailable },
      );
      expect(decision.classification.type, task.id).toBe(task.expected_type);
      expect(decision.classification.surface, task.id).toBe(task.expected_surface);
      for (const capability of task.hard_capabilities as Capability[]) {
        expect(decision.classification.capabilities, `${task.id}/${capability}`).toContain(capability);
        expect(profiles.get(decision.primary!.profileId)?.capabilities, `${task.id}/${capability}`).toContain(capability);
      }
    }
  });

  it("路由可解释、主 Provider 在允许范围内，前三候选至少跨两家 Provider", () => {
    for (const task of tasks) {
      const decision = route(
        { text: task.input, ...(task.attachments ? { attachments: task.attachments } : {}) },
        { profiles: MODEL_PROFILES, availability: allAvailable },
      );
      expect(decision.primary, task.id).not.toBeNull();
      expect(task.acceptable_providers, task.id).toContain(decision.primary!.provider);
      expect(new Set(decision.chain.slice(0, 3).map((entry) => entry.provider)).size, task.id).toBeGreaterThanOrEqual(2);
      expect(decision.reasons.join("\n"), task.id).toMatch(/任务类型/);
      expect(decision.reasons.join("\n"), task.id).toMatch(/工作能力/);
      expect(JSON.stringify(decision.trace), task.id).not.toContain(task.input);
    }
  });
});
