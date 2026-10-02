import { useId, useState, type FormEvent } from "react";
import { Ban, KeyRound, Terminal, Trash2, Wrench } from "lucide-react";
import { SIDE_LABEL } from "@/decision";
import { Button } from "@/components/ui/button";
import { Badge, Input } from "@/components/ui/input";
import type { McpRefStatus } from "@/platform";
import { useAppStore } from "@/stores/app";
import type { McpConn } from "@/stores/mcp";
import { useMcp } from "@/stores/mcp";
import type { TestResult } from "@/stores/settings";
import { ResultNote } from "./controls";

// MCP 服务器卡片的两块明细：mcp.json 引用的密钥、已注册与未注册的工具

/** 钥匙串条目：密码框只进不出，保存后立即清空 */
function SecretRow({ server, item }: { server: string; item: McpRefStatus }) {
  const f = useId();
  const kind = useAppStore((s) => s.backendKind);
  const setSecret = useMcp((s) => s.setSecret);
  const deleteSecret = useMcp((s) => s.deleteSecret);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<TestResult | null>(null);

  const run = async (task: () => Promise<string | null>, ok: string) => {
    setBusy(true);
    const e = await task();
    setNote(e ? { ok: false, message: e } : { ok: true, message: ok });
    setBusy(false);
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    const v = value;
    setValue("");
    void run(() => setSecret(server, item.name, v), kind === "tauri" ? "已保存到系统钥匙串" : "已记录为已保存（浏览器模式不保存值）");
  };

  return (
    <li className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs">{item.name}</span>
        <Badge>
          <KeyRound aria-hidden />
          {item.configured ? "已保存（系统钥匙串）" : "未保存"}
        </Badge>
      </div>
      <form onSubmit={save} className="flex flex-wrap gap-2">
        <label htmlFor={f} className="sr-only">{`${server} 的 ${item.name}`}</label>
        <Input id={f} type="password" autoComplete="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)}
          placeholder={item.configured ? "输入新值以替换" : "粘贴密钥"} className="min-w-0 flex-1" />
        <Button type="submit" size="sm" className="h-9" disabled={busy || value.trim() === ""}>保存</Button>
        {item.configured && (
          <Button type="button" size="sm" variant="outline" className="h-9" disabled={busy} aria-label={`删除 ${server} 的 ${item.name}`}
            onClick={() => void run(() => deleteSecret(server, item.name), "已从钥匙串删除")}>
            <Trash2 aria-hidden />
            删除
          </Button>
        )}
      </form>
      <ResultNote result={note} />
    </li>
  );
}

export function McpSecrets({ server, refs }: { server: string; refs: McpRefStatus[] }) {
  if (refs.length === 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">引用的密钥（值不会显示，也不会写进 mcp.json）：</p>
      <ul aria-label={`${server} 引用的密钥`} className="space-y-3">
        {refs.map((r) =>
          r.source === "keychain" ? (
            <SecretRow key={`k:${r.name}`} server={server} item={r} />
          ) : (
            <li key={`e:${r.name}`} className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{r.name}</span>
              <Badge>
                <Terminal aria-hidden />
                {r.configured ? "环境变量已设置" : "环境变量未设置"}
              </Badge>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

/** 注册给智能体的工具及其副作用；不在白名单或名称无效的工具单独列出 */
export function McpTools({ conn, server }: { conn: McpConn; server: string }) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        已注册给智能体的工具（{conn.tools.length}）{conn.serverInfo && ` · ${conn.serverInfo}`}：
      </p>
      {conn.tools.length === 0 && <p className="text-xs text-muted-foreground">没有工具在白名单内。</p>}
      <ul aria-label={`${server} 已注册的工具`} className="space-y-1">
        {conn.tools.map((t) => (
          <li key={t.name} className="flex flex-wrap items-center gap-2 text-xs">
            <Wrench aria-hidden className="size-3 shrink-0" />
            <span className="break-all font-mono">{t.name}</span>
            <Badge>{t.sideEffect === "none" ? SIDE_LABEL.none : `${SIDE_LABEL[t.sideEffect]}，执行前确认`}</Badge>
          </li>
        ))}
      </ul>
      {conn.skipped.length > 0 && (
        <ul aria-label={`${server} 未注册的工具`} className="space-y-1">
          {conn.skipped.map((t, i) => (
            <li key={`${i}:${t.name}`} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Ban aria-hidden className="size-3 shrink-0" />
              <span className="break-all font-mono">{t.name}</span>
              <span>{t.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
