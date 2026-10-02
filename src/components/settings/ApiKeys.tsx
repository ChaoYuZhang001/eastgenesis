import { useId, useState, type FormEvent, type ReactNode } from "react";
import { KeyRound, PlugZap, Trash2 } from "lucide-react";
import { officialEndpoint } from "@/core/llm/official";
import type { AppError } from "@/lib/ipc";
import { Button } from "@/components/ui/button";
import { Badge, Input } from "@/components/ui/input";
import type { KeyStatus } from "@/platform";
import { useAppStore } from "@/stores/app";
import { useSettings, type TestResult } from "@/stores/settings";
import { ResultNote, SettingsSection } from "./controls";
import { LocalJevSettings } from "./LocalJevSettings";
import { OllamaToggle, RegionSelect } from "./ProviderExtras";

const labelOf = (id: string) => (id === "jev" ? "Jev 决策层" : officialEndpoint(id)?.label ?? id);

function statusText(s: KeyStatus | null) {
  if (!s) return "读取中…";
  if (!s.needs_key) return "本机服务，不需要 Key";
  if (!s.configured) return "未配置";
  return s.source === "env" ? "已配置（来自环境变量）" : "已配置（系统钥匙串）";
}

interface RowProps {
  id: string;
  status: KeyStatus | null;
  onSave(key: string): Promise<AppError | null>;
  onDelete(): Promise<AppError | null>;
  /** 附加设置：地域、本机服务开关 */
  children?: ReactNode;
}

// 一行 Key：密码框提交后立即清空；页面只拿得到「是否已配置」，拿不到 Key 本身
function KeyRow({ id, status, onSave, onDelete, children }: RowProps) {
  const f = useId();
  const kind = useAppStore((s) => s.backendKind);
  const testConnection = useSettings((s) => s.testConnection);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<TestResult | null>(null);
  const label = labelOf(id);

  const run = async (task: () => Promise<TestResult>) => {
    setBusy(true);
    setNote(await task());
    setBusy(false);
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    const k = key;
    setKey("");
    void run(async () => {
      const err = await onSave(k);
      if (err) return { ok: false, message: err.message };
      return { ok: true, message: kind === "tauri" ? "已保存到系统钥匙串" : "已记录为已配置（浏览器模式不保存 Key）" };
    });
  };
  const remove = () =>
    void run(async () => {
      const err = await onDelete();
      return err ? { ok: false, message: err.message } : { ok: true, message: "已从钥匙串删除" };
    });

  return (
    <li className="space-y-2 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">{label}</p>
        <div className="flex flex-wrap gap-2">
          <Badge>
            <KeyRound aria-hidden />
            {statusText(status)}
          </Badge>
        </div>
      </div>
      {status?.needs_key !== false && (
        <form onSubmit={save} className="flex flex-wrap gap-2">
          <label htmlFor={f} className="sr-only">{`${label} API Key`}</label>
          <Input id={f} type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)}
            placeholder={status?.configured ? "输入新 Key 以替换" : "粘贴 API Key"} className="min-w-0 flex-1" />
          <Button type="submit" size="sm" className="h-9" disabled={busy || key.trim() === ""}>保存</Button>
          {status?.source === "keychain" && (
            <Button type="button" size="sm" variant="outline" className="h-9" disabled={busy} onClick={remove} aria-label={`删除 ${label} 的 Key`}>
              <Trash2 aria-hidden />
              删除
            </Button>
          )}
        </form>
      )}
      {status?.source === "env" && <p className="text-xs text-muted-foreground">环境变量里的 Key 只能在系统里修改；在这里保存的 Key 会优先使用。</p>}
      {children}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => testConnection(id))}>
          <PlugZap aria-hidden />
          测试连接
        </Button>
        <ResultNote result={note} />
      </div>
    </li>
  );
}

export function ApiKeys() {
  const { statuses, jev, setKey, deleteKey, setJevKey, deleteJevKey } = useSettings();
  const official = statuses.filter((s) => !s.id.startsWith("custom:"));
  return (
    <div className="space-y-10">
      <SettingsSection title="模型 Provider 的 API Key" description="Key 只保存在系统钥匙串，由 Rust 侧读取并代发请求；保存后界面上不再显示。也可以用环境变量提供。">
        <ul className="space-y-3">
          {official.map((s) => (
            <KeyRow key={s.id} id={s.id} status={s} onSave={(k) => setKey(s.id, k)} onDelete={() => deleteKey(s.id)}>
              {s.id === "ollama" ? <OllamaToggle /> : <RegionSelect provider={s.id} />}
            </KeyRow>
          ))}
        </ul>
      </SettingsSection>
      <SettingsSection title="Jev 决策层 Key" description="和模型 Provider 的 Key 分开保存，只用于路由与规划决策。没有配置时自动降级：先交给下面选的本地决策模型，没有选择再交给规则引擎，任务照常运行。">
        <ul>
          <KeyRow id="jev" status={jev} onSave={setJevKey} onDelete={deleteJevKey} />
        </ul>
      </SettingsSection>
      <LocalJevSettings />
    </div>
  );
}
