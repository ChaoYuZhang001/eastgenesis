// 密钥来源。配置里只保存引用（ref），不保存密钥本身。
//   env:NAME                  环境变量（CLI、开发）
//   keychain:provider/<id>    系统钥匙串中模型 Provider 的 Key（桌面端，M5 接入 Rust 侧）
//   keychain:jev              Jev 决策层自己的 Key，和 Provider 的 Key 分开存放
export type SecretRef = { scheme: "env"; name: string } | { scheme: "keychain"; account: string };

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const KEYCHAIN_ACCOUNT = /^(jev|provider\/[a-z0-9][a-z0-9_-]{0,63})$/;

export function parseSecretRef(ref: string): SecretRef {
  const i = ref.indexOf(":");
  const scheme = i > 0 ? ref.slice(0, i) : "";
  const rest = ref.slice(i + 1);
  if (scheme === "env" && ENV_NAME.test(rest)) return { scheme: "env", name: rest };
  if (scheme === "keychain" && KEYCHAIN_ACCOUNT.test(rest)) return { scheme: "keychain", account: rest };
  // 不回显 ref：用户可能误把 Key 本身填进来
  throw new Error("密钥引用格式无效，应为 env:NAME 或 keychain:provider/<id>、keychain:jev");
}

export interface SecretSource {
  /** 取不到时返回 null，不抛错；调用方决定如何提示 */
  get(ref: SecretRef): Promise<string | null>;
}

export class EnvSecretSource implements SecretSource {
  constructor(private readonly env: Record<string, string | undefined>) {}
  async get(ref: SecretRef): Promise<string | null> {
    if (ref.scheme !== "env") return null;
    const v = this.env[ref.name]?.trim();
    return v ? v : null;
  }
}

/** 按顺序尝试多个来源 */
export class ChainSecretSource implements SecretSource {
  constructor(private readonly sources: SecretSource[]) {}
  async get(ref: SecretRef): Promise<string | null> {
    for (const s of this.sources) {
      const v = await s.get(ref);
      if (v) return v;
    }
    return null;
  }
}
