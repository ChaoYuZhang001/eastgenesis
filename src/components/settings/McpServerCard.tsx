import { CircleCheck, CircleSlash, CircleX, LoaderCircle, Play, RotateCw, Square, Unplug, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { McpServerView } from "@/platform";
import { useMcp, type McpConn } from "@/stores/mcp";
import { FileRoots } from "./FileRoots";
import { McpSecrets, McpTools } from "./McpDetails";

type UiStatus = "stopped" | "starting" | "running" | "failed" | "detached";

// 状态一律「图标形状 + 文字」，不靠颜色区分（BRAND.md 4.3）
const STATUS: Record<UiStatus, { label: string; icon: LucideIcon }> = {
  stopped: { label: "未启动", icon: CircleSlash },
  starting: { label: "启动中…", icon: LoaderCircle },
  running: { label: "运行中", icon: CircleCheck },
  failed: { label: "出错", icon: CircleX },
  detached: { label: "运行中（未连接）", icon: Unplug },
};

function uiStatus(s: McpServerView, c: McpConn | undefined): UiStatus {
  if (c) return c.status;
  return s.running ? "detached" : "stopped";
}

const allowText = (a: McpServerView["allow_tools"]) =>
  a === "*" ? "全部工具（\"*\"）" : a.length === 0 ? "未填写 allowTools：一个工具都不会注册" : a.join("、");
const quote = (a: string) => (/\s/.test(a) ? JSON.stringify(a) : a);

export function McpServerCard({ server: s }: { server: McpServerView }) {
  const conn = useMcp((st) => st.conns[s.id]);
  const start = useMcp((st) => st.start);
  const stop = useMcp((st) => st.stop);
  const status = uiStatus(s, conn);
  const { label, icon: Icon } = STATUS[status];
  const missing = s.refs.filter((r) => !r.configured);
  const envMissing = missing.some((r) => r.source === "env");
  // 运行期间改了 mcp.json 的白名单或信任设置：要重启才生效
  const stale = conn?.config && (JSON.stringify(conn.config.allow_tools) !== JSON.stringify(s.allow_tools) || conn.config.trust_annotations !== s.trust_annotations);

  return (
    <li aria-label={s.id} className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p className="font-mono font-medium">{s.id}</p>
          <p className="break-all font-mono text-xs text-muted-foreground">{[s.command, ...s.args].map(quote).join(" ")}</p>
          {s.cwd && <p className="break-all text-xs text-muted-foreground">工作目录：{s.cwd}</p>}
          {Object.keys(s.env).length > 0 && (
            <p className="break-all text-xs text-muted-foreground">环境变量：{Object.entries(s.env).map(([k, v]) => `${k}=${v}`).join("  ")}</p>
          )}
          <p className="text-xs text-muted-foreground">工具白名单：{allowText(s.allow_tools)}</p>
          <p className="text-xs text-muted-foreground">
            {s.trust_annotations ? "采信服务器的只读标注：只读工具可直接执行" : "不采信服务器的标注：每个工具都按有副作用处理，执行前确认"}
          </p>
        </div>
        <Badge className={cn(status === "running" && "text-foreground", status === "failed" && "border-east-red/60")}>
          <Icon aria-hidden className={cn(status === "starting" && "animate-spin", status === "failed" && "text-east-red")} />
          {label}
        </Badge>
      </div>

      {s.builtin && <FileRoots />}
      <McpSecrets server={s.id} refs={s.refs} />

      <div className="flex flex-wrap gap-2">
        {(status === "stopped" || status === "failed") && (
          <Button size="sm" variant="secondary" disabled={missing.length > 0} onClick={() => void start(s.id)}>
            <Play aria-hidden />
            {status === "failed" ? "重新启动" : "启动"}
          </Button>
        )}
        {status === "detached" && (
          <Button size="sm" variant="secondary" onClick={() => void start(s.id)}>
            <RotateCw aria-hidden />
            重新连接
          </Button>
        )}
        {(status === "running" || status === "detached" || (status === "failed" && s.running)) && (
          <Button size="sm" variant="outline" onClick={() => void stop(s.id)}>
            <Square aria-hidden />
            停止
          </Button>
        )}
        {status === "starting" && (
          <Button size="sm" variant="secondary" disabled>
            <LoaderCircle aria-hidden className="animate-spin" />
            启动中…
          </Button>
        )}
      </div>
      {missing.length > 0 && status !== "running" && (
        <p className="text-xs text-muted-foreground">
          {envMissing ? "有引用的环境变量没有设置：请在系统里设置后重新打开应用，或改用 ${keychain:NAME}。" : "先保存上面引用的密钥，才能启动。"}
        </p>
      )}
      {stale && <p className="text-xs text-muted-foreground">mcp.json 里的白名单或信任设置已改动，重启这个服务器后生效。</p>}
      {conn?.error && (
        <p role="alert" className="flex items-start gap-2 break-all text-xs">
          <CircleX aria-hidden className="size-4 shrink-0 text-east-red" />
          {conn.error}
        </p>
      )}
      {conn?.status === "running" && <McpTools conn={conn} server={s.id} />}
      {s.stderr_tail && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">服务器输出（stderr，已脱敏）</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface-2 p-2 font-mono">{s.stderr_tail}</pre>
        </details>
      )}
    </li>
  );
}
