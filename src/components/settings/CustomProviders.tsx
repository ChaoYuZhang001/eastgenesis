import { useEffect, useRef, useState } from "react";
import { KeyRound, Pencil, PlugZap, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/input";
import { customProfileId, officialMatch } from "@/lib/engine";
import { customModels, type CustomProvider, type SavedProvider } from "@/platform";
import { useSettings, type TestResult } from "@/stores/settings";
import { ResultNote, SettingsSection } from "./controls";
import { CustomProviderForm } from "./CustomProviderForm";
import { ProviderRecoveryNote } from "./ProviderRecoveryNote";

/** 参与路由的模型及其路由 ID；沿用内置能力档位的标出参照来源（透明度优先） */
function ModelRoutes({ c }: { c: CustomProvider }) {
  const models = customModels(c);
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">参与路由的模型（{models.length}）：</p>
      <ul aria-label={`${c.label} 参与路由的模型`} className="space-y-1">
        {models.map((m) => {
          const ref = officialMatch(m);
          return (
            <li key={m} className="break-all text-xs text-muted-foreground">
              <span className="font-mono">{customProfileId(c.id, m)}</span>
              {ref && <span>{` · 能力参照 ${ref.id}`}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const timeText = (t: number) => new Date(t).toLocaleString("zh-CN", { hour12: false });

/** 服务端模型列表的本地缓存状态：输入框的模型下拉用的就是它，可以手动刷新 */
function ModelCacheNote({ id }: { id: string }) {
  const entry = useSettings((s) => s.modelCache[id]);
  const probingNow = useSettings((s) => s.probingIds.includes(id));
  const refreshModels = useSettings((s) => s.refreshModels);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setBusy(true);
    const r = await refreshModels(id, true);
    setError(r.ok ? null : r.message);
    setBusy(false);
  };
  const gone = entry?.unavailable ?? [];

  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        {entry ? `服务端模型列表：${entry.models.length} 个 · 上次读取 ${timeText(entry.fetchedAt)}` : "还没有读取过服务端模型列表（输入框的模型下拉会用已登记的模型）"}
      </p>
      {entry && (
        <p role="status" className="text-xs text-muted-foreground">
          {probingNow
            ? "正在逐个探测模型是否可用（每个只发 1 个 token 的请求）…"
            : entry.probeSuspicious
              ? "探测时所有模型都返回 404，可能是对话地址有误，这次没有隐藏任何模型"
              : entry.probedAt !== undefined
                ? gone.length
                  ? `探测完成：${gone.length} 个模型返回 404，已从输入框的模型下拉隐藏`
                  : "探测完成：没有返回 404 的模型"
                : "还没有探测过模型是否可用"}
        </p>
      )}
      {gone.length > 0 && !probingNow && (
        <ul aria-label="不可用的模型（404）" className="flex flex-wrap gap-1">
          {gone.map((m) => (
            <li key={m}>
              <Badge className="font-mono">{m}</Badge>
            </li>
          ))}
        </ul>
      )}
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void refresh()}>
        <RefreshCw aria-hidden />
        {busy ? "读取中…" : "刷新模型列表"}
      </Button>
      {error && <ResultNote result={{ ok: false, message: error }} />}
    </div>
  );
}

// 自定义 Provider 管理：添加、编辑、删除（两步确认）、测试连接
export function CustomProviders() {
  const custom = useSettings((s) => s.custom);
  const statuses = useSettings((s) => s.statuses);
  const deleteCustom = useSettings((s) => s.deleteCustom);
  const testConnection = useSettings((s) => s.testConnection);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, TestResult>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const prev = useRef<string | null>(null);

  // 表单关闭后把焦点还给打开它的按钮
  useEffect(() => {
    if (editing === null && prev.current) {
      const sel = prev.current === "new" ? "[data-add]" : `[data-edit="${prev.current}"]`;
      (root.current?.querySelector<HTMLElement>(sel) ?? root.current?.querySelector<HTMLElement>("[data-add]"))?.focus();
    }
    prev.current = editing;
  }, [editing]);

  const note = (id: string, r: TestResult) => setNotes((n) => ({ ...n, [id]: r }));
  const configured = (id: string) => statuses.find((s) => s.id === id)?.configured ?? false;
  const onDone = (saved: SavedProvider | null) => {
    setEditing(null);
    if (saved) note(saved.provider.id, { ok: true, message: saved.key_cleared ? "已保存。Base URL 变了，原 Key 已清除，请编辑后重新填写。" : "已保存" });
  };
  const test = async (id: string) => {
    setTesting(id);
    note(id, await testConnection(id));
    setTesting(null);
  };
  const del = async (id: string, label: string) => {
    setConfirmDel(null);
    const e = await deleteCustom(id);
    if (e) return note(id, { ok: false, message: e.message });
    setAnnounce(`已删除 ${label}`);
    root.current?.querySelector<HTMLElement>("[data-add]")?.focus();
  };

  return (
    <SettingsSection title="自定义 Provider" description="接入第三方中转站或 OpenAI / Anthropic 兼容端点。登记的每个模型都参与路由，能力档位可在能力矩阵里调整。">
      <div ref={root} className="space-y-3">
        {editing === "new" ? (
          <CustomProviderForm initial={null} onDone={onDone} />
        ) : (
          <Button data-add variant="outline" onClick={() => setEditing("new")}>
            <Plus aria-hidden />
            添加自定义 Provider
          </Button>
        )}
        {custom.length === 0 && editing !== "new" && <p className="text-sm text-muted-foreground">还没有自定义 Provider。</p>}
        <ul className="space-y-3">
          {custom.map((c) =>
            editing === c.id ? (
              <li key={c.id}>
                <CustomProviderForm initial={c} onDone={onDone} />
              </li>
            ) : (
              <li key={c.id} aria-label={c.label} className="space-y-3 rounded-lg border border-border p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <p className="font-medium">{c.label}</p>
                    <p className="break-all font-mono text-xs text-muted-foreground">{c.base_url}</p>
                    <p className="text-xs text-muted-foreground">{c.protocol === "anthropic" ? "Anthropic 兼容（Messages）" : "OpenAI 兼容（Chat Completions）"}</p>
                    <ProviderRecoveryNote protocol={c.protocol ?? "openai"} />
                    <ModelRoutes c={c} />
                    <ModelCacheNote id={c.id} />
                    {Object.keys(c.headers).length > 0 && <p className="text-xs text-muted-foreground">附加请求头：{Object.keys(c.headers).join("、")}</p>}
                  </div>
                  <Badge>
                    <KeyRound aria-hidden />
                    {configured(c.id) ? "Key 已配置" : "未配置 Key"}
                  </Badge>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" disabled={testing === c.id} onClick={() => test(c.id)}>
                    <PlugZap aria-hidden />
                    {testing === c.id ? "测试中…" : "测试连接"}
                  </Button>
                  <Button data-edit={c.id} size="sm" variant="secondary" onClick={() => setEditing(c.id)}>
                    <Pencil aria-hidden />
                    编辑
                  </Button>
                  {/* 同一个按钮切换成「确认删除」，焦点不丢 */}
                  <Button
                    size="sm"
                    variant={confirmDel === c.id ? "default" : "outline"}
                    onClick={() => (confirmDel === c.id ? void del(c.id, c.label) : (setConfirmDel(c.id), setAnnounce(`再按一次确认删除 ${c.label}`)))}
                  >
                    <Trash2 aria-hidden />
                    {confirmDel === c.id ? "确认删除" : "删除"}
                  </Button>
                  {confirmDel === c.id && (
                    <Button size="sm" variant="outline" onClick={(e) => ((e.currentTarget.previousElementSibling as HTMLElement | null)?.focus(), setConfirmDel(null))}>
                      取消
                    </Button>
                  )}
                </div>
                <ResultNote result={notes[c.id] ?? null} />
              </li>
            ),
          )}
        </ul>
        <p aria-live="polite" className="sr-only">
          {announce}
        </p>
      </div>
    </SettingsSection>
  );
}
