import { useId, useState, type KeyboardEvent } from "react";
import { Plus, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_CUSTOM_MODELS, isValidModelName } from "@/platform";
import type { TestResult } from "@/stores/settings";
import { ResultNote } from "./controls";

// 自定义 Provider 表单的两个子区块：附加请求头、参与路由的其他模型

const MAX_HEADERS = 16;

export function HeadersEditor({ headers, onChange }: { headers: [string, string][]; onChange(h: [string, string][]): void }) {
  const row = (i: number, next: [string, string] | null) =>
    onChange(next ? headers.map((x, k) => (k === i ? next : x)) : headers.filter((_, k) => k !== i));
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm">附加请求头</legend>
      <p className="text-xs text-muted-foreground">以明文保存，不要放凭据；凭据类名称（含 key、token、auth 等）会被拒绝。</p>
      {headers.map(([k, v], i) => (
        <div key={i} className="flex gap-2">
          <Input aria-label={`请求头 ${i + 1} 名称`} value={k} onChange={(e) => row(i, [e.target.value, v])} className="font-mono" />
          <Input aria-label={`请求头 ${i + 1} 的值`} value={v} onChange={(e) => row(i, [k, e.target.value])} className="font-mono" />
          <Button type="button" size="icon" variant="ghost" aria-label={`删除请求头 ${i + 1}`} onClick={() => row(i, null)}>
            <X aria-hidden />
          </Button>
        </div>
      ))}
      {headers.length < MAX_HEADERS && (
        <Button type="button" size="sm" variant="outline" onClick={() => onChange([...headers, ["", ""]])}>
          <Plus aria-hidden />
          添加请求头
        </Button>
      )}
    </fieldset>
  );
}

interface ModelsProps {
  /** 候选列表（datalist）的 id，默认模型输入框也用它 */
  listId: string;
  defaultModel: string;
  models: string[];
  onChange(models: string[]): void;
  suggestions: string[];
  /** 为 null 时显示「获取模型列表」按钮；否则显示不能获取的原因 */
  blocked: string | null;
  onDiscover(): Promise<TestResult>;
}

export function ModelsEditor({ listId, defaultModel, models, onChange, suggestions, blocked, onDiscover }: ModelsProps) {
  const f = useId();
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const full = models.length + 1 >= MAX_CUSTOM_MODELS;
  const add = () => {
    const m = draft.trim();
    if (!isValidModelName(m)) return setNote({ ok: false, message: "模型名不能为空，也不能含空白字符" });
    if (m !== defaultModel && !models.includes(m)) onChange([...models, m]);
    setDraft("");
    setNote(null);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // 回车只添加模型，不提交整张表单
    if (e.key === "Enter") (e.preventDefault(), add());
  };
  const discover = async () => {
    setBusy(true);
    setNote(await onDiscover());
    setBusy(false);
  };

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm">其他模型</legend>
      <p className="text-xs text-muted-foreground">
        默认模型和这里的每个模型都会参与路由。和内置型号同名的（可带 vendor/ 前缀）沿用内置的能力档位，其余按 3 档处理，都可以在能力矩阵里调整。
      </p>
      <datalist id={listId}>
        {suggestions.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      {models.length > 0 && (
        <ul aria-label="其他模型" className="flex flex-wrap gap-2">
          {models.map((m) => (
            <li key={m} className="flex items-center gap-1 rounded-md border border-border pl-2">
              <span className="font-mono text-xs">{m}</span>
              <Button type="button" size="icon" variant="ghost" aria-label={`移除模型 ${m}`} onClick={() => onChange(models.filter((x) => x !== m))}>
                <X aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Input id={`${f}-add`} aria-label="添加模型" list={listId} maxLength={128} disabled={full} placeholder={full ? "已达上限 32 个" : "模型名"}
          value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} className="w-64 font-mono" />
        <Button type="button" size="sm" variant="outline" disabled={full || !draft.trim()} onClick={add}>
          <Plus aria-hidden />
          添加
        </Button>
        {blocked === null && (
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void discover()}>
            <RefreshCw aria-hidden />
            {busy ? "获取中…" : "获取模型列表"}
          </Button>
        )}
      </div>
      {blocked !== null && <p className="text-xs text-muted-foreground">{blocked}</p>}
      <ResultNote result={note} />
    </fieldset>
  );
}
