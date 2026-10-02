// 模型健康度与熔断。连续失败达到阈值后熔断一段时间；冷却结束进入半开状态降权试探。
// 鉴权、配置错误让整个 Provider 下线，直到用户改了它的配置（resetProvider，例如更新了 Key）。

export type HealthStatus = { ok: true; health: number } | { ok: false; reason: string };

export interface HealthOptions {
  /** 窗口内连续失败多少次熔断，默认 3 */
  threshold?: number;
  /** 两次失败间隔超过这个时长，连续计数重置，默认 60s */
  windowMs?: number;
  /** 熔断时长，默认 60s */
  cooldownMs?: number;
  now?: () => number;
}

interface Entry {
  consecutive: number;
  lastFailAt: number;
  /** 0 表示从未熔断；大于当前时间表示熔断中；小于等于当前时间表示半开 */
  openUntil: number;
}

export class HealthTracker {
  readonly #threshold: number;
  readonly #windowMs: number;
  readonly #cooldownMs: number;
  readonly #now: () => number;
  readonly #models = new Map<string, Entry>();
  readonly #downProviders = new Map<string, string>();

  constructor(o: HealthOptions = {}) {
    this.#threshold = o.threshold ?? 3;
    this.#windowMs = o.windowMs ?? 60_000;
    this.#cooldownMs = o.cooldownMs ?? 60_000;
    this.#now = o.now ?? Date.now;
  }

  #entry(id: string): Entry {
    let e = this.#models.get(id);
    if (!e) {
      e = { consecutive: 0, lastFailAt: 0, openUntil: 0 };
      this.#models.set(id, e);
    }
    return e;
  }

  recordSuccess(id: string): void {
    const e = this.#entry(id);
    e.consecutive = 0;
    e.openUntil = 0;
  }

  recordFailure(id: string): void {
    const e = this.#entry(id);
    const t = this.#now();
    const halfOpen = e.openUntil > 0 && e.openUntil <= t;
    e.consecutive = t - e.lastFailAt <= this.#windowMs ? e.consecutive + 1 : 1;
    e.lastFailAt = t;
    // 半开状态下试探失败，立即重新熔断
    if (halfOpen || e.consecutive >= this.#threshold) e.openUntil = t + this.#cooldownMs;
  }

  markProviderDown(provider: string, reason: string): void {
    this.#downProviders.set(provider, reason);
  }

  /** 清空全部记录（UI 测试在用例之间复位用） */
  reset(): void {
    this.#downProviders.clear();
    this.#models.clear();
  }

  /** 用户改了这个 Provider 的配置（Key、地域、地址、所选模型）：清掉停用记录和它名下模型的熔断记录，下次请求重新尝试 */
  resetProvider(provider: string): void {
    this.#downProviders.delete(provider);
    for (const id of [...this.#models.keys()]) if (id === provider || id.startsWith(`${provider}/`)) this.#models.delete(id);
  }

  status(id: string, provider: string): HealthStatus {
    const down = this.#downProviders.get(provider);
    if (down) return { ok: false, reason: `Provider 已停用：${down}` };
    const e = this.#models.get(id);
    if (!e) return { ok: true, health: 1 };
    const t = this.#now();
    if (e.openUntil > t) {
      return { ok: false, reason: `连续失败 ${e.consecutive} 次，熔断中（约 ${Math.ceil((e.openUntil - t) / 1000)}s 后重试）` };
    }
    if (e.openUntil > 0) return { ok: true, health: 0.5 };
    if (e.consecutive > 0 && t - e.lastFailAt <= this.#windowMs) return { ok: true, health: Math.max(0.3, 1 - 0.25 * e.consecutive) };
    return { ok: true, health: 1 };
  }
}
