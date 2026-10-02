// @vitest-environment node
import raw from "../config/model_profiles.json";
import { MODEL_PROFILES, ProfileError, modelName, providerReadiness, validateProfiles } from "@/decision/profiles";

const base = {
  id: "openai/m",
  provider: "openai",
  capabilities: ["code"],
  cost_tier: 2,
  quality_tier: 3,
  latency_tier: 2,
  context_window: 128000,
  enabled: true,
  is_custom: false,
};
const one = (patch: Record<string, unknown>) => ({ profiles: [{ ...base, ...patch }] });

describe("模型能力矩阵", () => {
  it("配置文件通过校验，覆盖 7 家官方 Provider 和自定义占位", () => {
    const providers = new Set(MODEL_PROFILES.map((p) => p.provider));
    for (const p of ["openai", "anthropic", "google", "deepseek", "qwen", "kimi", "ollama"]) expect(providers).toContain(p);
    const custom = MODEL_PROFILES.filter((p) => p.is_custom);
    expect(custom).toHaveLength(1);
    expect(custom[0].enabled).toBe(false);
    expect(MODEL_PROFILES.length).toBe(raw.profiles.length);
  });

  it("每家官方 Provider 至少有一个启用的模型", () => {
    for (const p of ["openai", "anthropic", "google", "deepseek", "qwen", "kimi", "ollama"]) {
      expect(MODEL_PROFILES.some((m) => m.provider === p && m.enabled)).toBe(true);
    }
  });

  it("modelName 去掉 Provider 前缀，保留模型名中的冒号和点", () => {
    const m = MODEL_PROFILES.find((p) => p.id === "ollama/qwen3:8b")!;
    expect(modelName(m)).toBe("qwen3:8b");
    expect(modelName({ id: "custom:relay/openai/gpt-x", provider: "custom:relay" })).toBe("openai/gpt-x");
  });

  it.each([
    [{ cost_tier: 0 }, /cost_tier/],
    [{ quality_tier: 2.5 }, /quality_tier/],
    [{ capabilities: ["telepathy"] }, /capabilities/],
    [{ capabilities: ["code", "code"] }, /重复/],
    [{ provider: "Evil" }, /provider/],
    [{ id: "anthropic/m" }, /id/],
    [{ context_window: 300000 }, /long_context/],
    [{ capabilities: ["long_context"] }, /long_context/],
    [{ is_custom: true }, /is_custom/],
  ])("校验拒绝非法条目 %o", (patch, msg) => {
    expect(() => validateProfiles(one(patch))).toThrow(ProfileError);
    expect(() => validateProfiles(one(patch))).toThrow(msg);
  });

  it("拒绝重复 id", () => {
    expect(() => validateProfiles({ profiles: [base, base] })).toThrow(/重复的 id/);
  });

  it("Provider 就绪判断：只看 Key 是否存在和适配器是否实现", () => {
    expect(providerReadiness("openai", { OPENAI_API_KEY: "x" })).toEqual({ ok: true });
    expect(providerReadiness("openai", {})).toEqual({ ok: false, reason: "缺少 API Key（OPENAI_API_KEY）" });
    expect(providerReadiness("anthropic", { ANTHROPIC_API_KEY: "  " })).toMatchObject({ ok: false });
    // M6：7 家官方适配器全部就绪
    for (const [p, env] of Object.entries({ google: "GEMINI_API_KEY", deepseek: "DEEPSEEK_API_KEY", qwen: "DASHSCOPE_API_KEY", kimi: "MOONSHOT_API_KEY" })) {
      expect(providerReadiness(p, { [env]: "x" })).toEqual({ ok: true });
    }
    expect(providerReadiness("deepseek", { DEEPSEEK_API_KEY: "x" }, new Set(["openai"]))).toEqual({ ok: false, reason: "适配器未实现" });
    // Ollama 不需要 Key，但要显式启用
    expect(providerReadiness("ollama", {})).toEqual({ ok: false, reason: "本机 Ollama 未启用（EG_OLLAMA=1）" });
    expect(providerReadiness("ollama", { EG_OLLAMA: "1" })).toEqual({ ok: true });
    expect(providerReadiness("custom:relay", {})).toMatchObject({ ok: false });
  });
});
