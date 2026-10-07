import { useEffect, useRef, useState } from "react";
import { KeyRound, Pencil, PlugZap, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/input";
import { customProfileId, officialMatch } from "@/lib/engine";
import { MAX_PROBED, PROBE_CONCURRENCY, PROBE_TIMEOUT_MS, PROBE_BATCH_TIMEOUT_MS } from "@/lib/discover";
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
  const probeModels = useSettings((s) => s.probeModels);
  const cancelModelProbe = useSettings((s) => s.cancelModelProbe);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setBusy(true);
    const r = await refreshModels(id);
    setError(r.ok ? null : r.message);
    setBusy(false);
  };
  const gone = entry?.unavailable ?? [];
  const summary = entry?.probeSummary;
  const stopped = summary?.stopReason === "cancelled" ? "已停止" : summary?.stopReason === "timeout" ? "单次请求超时，已停止后续检查" : summary?.stopReason === "budget" ? "达到本批等待上限，已停止后续检查" : null;

  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        {entry ? `服务端模型列表：${entry.models.length} 个 · 上次读取 ${timeText(entry.fetchedAt)}` : "还没有读取过服务端模型列表（输入框的模型下拉会用已登记的模型）"}
      </p>
      <p className="text-xs text-muted-foreground">读取目录和测试连接只请求模型列表，不发起推理。目录候选用于手动锁定；已登记的模型按能力档位参与自动路由，无需先做调用检查。</p>
      {entry && (
        <p role="status" className="text-xs text-muted-foreground">
          {probingNow
            ? "正在检查模型调用，可能产生费用；可以停止后续检查…"
            : summary
              ? `上次检查：已发起 ${summary.probed}/${summary.total}，HTTP 成功 ${summary.ok}，404/型号缺失 ${summary.missing}，不确定 ${summary.unknown}，未发起 ${summary.notProbed}${stopped ? ` · ${stopped}` : ""}`
              : entry.probedAt !== undefined ? "有历史调用检查记录，缺少成功与未知数量；不代表所有模型都可用" : "尚未检查推理调用；读取目录不代表模型一定可调用"}
        </p>
      )}
      {entry?.probeSuspicious && <p className="text-xs text-muted-foreground">本批已检查的模型均返回 404/型号缺失，可能是对话地址有误，这次没有隐藏任何模型。</p>}
      {gone.length > 0 && <p className="text-xs text-muted-foreground">{`${gone.length} 个模型返回 404/型号缺失，已从手动模型下拉隐藏；这份目录记录不改变已登记模型的自动路由。`}</p>}
      {gone.length > 0 && !probingNow && (
        <ul aria-label="不可用的模型（404）" className="flex flex-wrap gap-1">
          {gone.map((m) => (
            <li key={m}>
              <Badge className="font-mono">{m}</Badge>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{`调用检查会向服务发送测试文本，每批最多 ${MAX_PROBED} 个模型、${PROBE_CONCURRENCY} 路并发，单次等待 ${PROBE_TIMEOUT_MS / 1000} 秒、整批等待 ${PROBE_BATCH_TIMEOUT_MS / 1000} 秒。请求限制输出 max_tokens=1，实际费用由服务决定；停止不能撤回已发送请求或保证退费。HTTP 成功不证明模型质量、工具能力或完整任务可用。`}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={busy || probingNow} onClick={() => void refresh()}>
          <RefreshCw aria-hidden />
          {busy ? "读取中…" : "刷新模型列表"}
        </Button>
        {probingNow ? (
          <Button size="sm" variant="outline" onClick={() => cancelModelProbe(id)}>停止检查</Button>
        ) : (
          <Button size="sm" variant="outline" disabled={busy || !entry?.models.length} onClick={() => void probeModels(id)}>检查模型调用（可能计费）</Button>
        )}
      </div>
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
    const result = await testConnection(id);
    if (!result.stale) note(id, result);
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
