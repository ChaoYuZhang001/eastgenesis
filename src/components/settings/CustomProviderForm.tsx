import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { TriangleAlert } from "lucide-react";
import { isAppError } from "@/lib/ipc";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { customModels, type CustomProtocol, type CustomProvider, type SavedProvider } from "@/platform";
import { useSettings, type TestResult } from "@/stores/settings";
import { ResultNote } from "./controls";
import { HeadersEditor, ModelsEditor } from "./CustomProviderFields";

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|-+$/g, "").slice(0, 64);
/** 近似 Rust 侧的规整（小写主机、去掉末尾斜杠），只用来提前提示「Key 会被清除」 */
function normUrl(s: string) {
  try {
    const u = new URL(s.trim());
    return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, "");
  } catch {
    return s.trim();
  }
}

const PROTOCOLS: Record<CustomProtocol, { label: string; auth: string; path: string }> = {
  openai: { label: "OpenAI 兼容（Chat Completions）", auth: "Key 以 Authorization: Bearer 发送", path: "/chat/completions" },
  anthropic: { label: "Anthropic 兼容（Messages）", auth: "Key 以 x-api-key 发送，并附带 anthropic-version", path: "/messages" },
};

// 添加 / 编辑自定义 Provider。Key 走 Rust 命令写入钥匙串，表单提交后立即清空。
export function CustomProviderForm({ initial, onDone }: { initial: CustomProvider | null; onDone: (saved: SavedProvider | null) => void }) {
  const f = useId();
  const form = useRef<HTMLFormElement>(null);
  const saveCustom = useSettings((s) => s.saveCustom);
  const discoverModels = useSettings((s) => s.discoverModels);
  // 打开表单时把焦点移进来（键盘和读屏用户不用再找）
  useEffect(() => form.current?.querySelector<HTMLInputElement>("input:not(:disabled)")?.focus(), []);
  const [label, setLabel] = useState(initial?.label ?? "");
  const [slug, setSlug] = useState(initial?.id.replace(/^custom:/, "") ?? "");
  const [slugTouched, setSlugTouched] = useState(initial !== null);
  const [baseUrl, setBaseUrl] = useState(initial?.base_url ?? "");
  const [protocol, setProtocol] = useState<CustomProtocol>(initial?.protocol ?? "openai");
  const [model, setModel] = useState(initial?.default_model ?? "");
  const [models, setModels] = useState<string[]>(initial ? customModels(initial).slice(1) : []);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [headers, setHeaders] = useState<[string, string][]>(Object.entries(initial?.headers ?? {}));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const urlChanged = initial !== null && normUrl(baseUrl) !== initial.base_url;
  const keyWillClear = urlChanged && apiKey.trim() === "";
  // 读取模型列表用的是已保存的地址、协议和 Key：表单里改过就要先保存
  const blocked = !initial
    ? "保存后可以从服务读取模型列表。"
    : urlChanged || protocol !== (initial.protocol ?? "openai")
      ? "地址或协议改过，保存后再读取模型列表。"
      : null;

  const onDiscover = async (): Promise<TestResult> => {
    if (!initial) return { ok: false, message: "请先保存这个 Provider" };
    const r = await discoverModels(initial.id);
    if (!r.ok) return r;
    setSuggestions(r.models);
    return { ok: true, message: `读取到 ${r.models.length} 个模型，填写模型名时会给出候选` };
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const p: CustomProvider = {
      id: `custom:${slug}`,
      label,
      base_url: baseUrl,
      default_model: model,
      headers: Object.fromEntries(headers.filter(([k]) => k.trim() !== "")),
      protocol,
      models,
    };
    const r = await saveCustom(p, apiKey);
    setBusy(false);
    setApiKey("");
    if (isAppError(r)) return setError(r.message);
    onDone(r);
  };

  const p = PROTOCOLS[protocol];
  return (
    <form ref={form} onSubmit={onSubmit} aria-label={initial ? `编辑 ${initial.label}` : "添加自定义 Provider"} className="space-y-4 rounded-lg border border-border p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor={`${f}-label`} className="text-sm">名称</label>
          <Input id={`${f}-label`} required maxLength={64} value={label}
            onChange={(e) => { setLabel(e.target.value); if (!slugTouched) setSlug(slugify(e.target.value)); }} />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${f}-id`} className="text-sm">ID</label>
          <div className="flex items-center gap-1">
            <span aria-hidden className="font-mono text-sm text-muted-foreground">custom:</span>
            <Input id={`${f}-id`} required disabled={initial !== null} maxLength={64} aria-describedby={`${f}-id-hint`}
              value={slug} onChange={(e) => { setSlug(e.target.value); setSlugTouched(true); }} className="font-mono" />
          </div>
          <p id={`${f}-id-hint`} className="text-xs text-muted-foreground">小写字母、数字、_ 或 -；保存后不能修改</p>
        </div>
        <div className="space-y-1 sm:col-span-2">
          <label htmlFor={`${f}-url`} className="text-sm">Base URL</label>
          <Input id={`${f}-url`} required type="url" placeholder="https://example.com/v1" aria-describedby={`${f}-url-hint`}
            value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="font-mono" />
          <p id={`${f}-url-hint`} className="text-xs text-muted-foreground">
            {`须为 https（本机地址可用 http）。请求发到「Base URL + ${p.path}」，通常填到 /v1 为止${protocol === "anthropic" ? "；Anthropic SDK 的 base_url 不含 /v1，这里要加上" : ""}。`}
          </p>
        </div>
        <div className="space-y-1">
          <label htmlFor={`${f}-protocol`} className="text-sm">协议</label>
          <Select id={`${f}-protocol`} value={protocol} aria-describedby={`${f}-protocol-hint`} onChange={(e) => setProtocol(e.target.value as CustomProtocol)}>
            {(Object.keys(PROTOCOLS) as CustomProtocol[]).map((k) => (
              <option key={k} value={k}>{PROTOCOLS[k].label}</option>
            ))}
          </Select>
          <p id={`${f}-protocol-hint`} className="text-xs text-muted-foreground">{p.auth}</p>
        </div>
        <div className="space-y-1">
          <label htmlFor={`${f}-model`} className="text-sm">默认模型</label>
          <Input id={`${f}-model`} required maxLength={128} list={`${f}-models`} value={model} onChange={(e) => setModel(e.target.value)} className="font-mono" />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${f}-key`} className="text-sm">API Key</label>
          <Input id={`${f}-key`} type="password" autoComplete="off" aria-describedby={keyWillClear ? `${f}-key-warn` : undefined}
            placeholder={initial ? "留空则保持原 Key" : "本机服务可留空"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          {keyWillClear && (
            <p id={`${f}-key-warn`} className="flex gap-2 text-xs">
              <TriangleAlert aria-hidden className="size-4 shrink-0 text-china-gold" />
              Base URL 变了：为防止 Key 发到新地址，保存时会清除原 Key，请重新填写。
            </p>
          )}
        </div>
      </div>

      <ModelsEditor listId={`${f}-models`} defaultModel={model.trim()} models={models} onChange={setModels}
        suggestions={suggestions} blocked={blocked} onDiscover={onDiscover} />
      <HeadersEditor headers={headers} onChange={setHeaders} />

      <ResultNote result={error ? { ok: false, message: error } : null} />
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>{busy ? "保存中…" : "保存"}</Button>
        <Button type="button" variant="outline" onClick={() => onDone(null)}>取消</Button>
      </div>
    </form>
  );
}
