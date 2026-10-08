import { useEffect, useState, type FormEvent } from "react";
import { FolderOpen, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toAppError } from "@/lib/ipc";
import { getBackend } from "@/platform";
import { useFileRoots } from "@/stores/file-roots";
import { useMcp } from "@/stores/mcp";
import { ResultNote } from "./controls";

// 内置文件服务器的允许目录（docs/UI_LAYOUT_V3.md 第 10 节第 11 条）：默认 ~/Downloads 不能移除，
// 其余由用户在这里添加。改完自动重启内置服务器（子进程的允许目录是启动参数）。
// 只有内置文件服务器需要这个开关；其它 MCP 服务器能访问什么由它自己决定。
export function FileRoots() {
  const { items, loaded, error, busy, load, add, remove } = useFileRoots();
  const restart = useMcp((s) => s.restart);
  const builtin = useMcp((s) => s.registry?.servers.find((x) => x.builtin)?.id ?? null);
  const [value, setValue] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);

  useEffect(() => void load(), [load]);

  const restartBuiltin = async (): Promise<string | null> => {
    if (!builtin) return null;
    try {
      await restart(builtin);
    } catch (e) {
      return toAppError(e).message;
    }
    const connection = useMcp.getState().conns[builtin];
    return connection?.status === "failed" ? connection.error ?? "内置文件服务器重启失败，请稍后重试" : null;
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!v) return;
    const err = await add(v);
    if (err) return setNote(err);
    setValue("");
    setNote(await restartBuiltin());
  };
  const choose = async () => {
    const picker = getBackend().pickDirectory;
    if (!picker) {
      setNote("浏览器模式没有系统文件夹选择器，请直接填写路径");
      return;
    }
    setChoosing(true);
    setNote(null);
    try {
      const selected = await picker(value.trim() || undefined);
      if (!selected) return;
      const err = await add(selected);
      if (err) return setNote(err);
      setValue("");
      setNote(await restartBuiltin());
    } catch (e) {
      setNote(toAppError(e).message);
    } finally {
      setChoosing(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm">
        内置文件服务器（<code className="font-mono">files</code>）只能访问下面这些目录，其它路径一律拒绝。默认目录来自应用本身，不能移除。
      </p>
      {error && <ResultNote result={{ ok: false, message: error }} />}
      {loaded && (
        <ul aria-label="允许访问的目录" className="space-y-2">
          {items.map((r) => (
            <li key={r.path} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2">
              <FolderOpen aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 break-all font-mono text-xs">{r.path}</span>
              {r.fixed ? (
                <span className="shrink-0 text-xs text-muted-foreground">默认</span>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  aria-label={`移除 ${r.path}`}
                  onClick={async () => {
                    const err = await remove(r.path);
                    setNote(err);
                    if (!err) setNote(await restartBuiltin());
                  }}
                >
                  <Trash2 aria-hidden />
                  移除
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form aria-label="添加允许访问的目录" onSubmit={(e) => void submit(e)} className="flex flex-wrap gap-2">
        <label htmlFor="file-root-path" className="sr-only">要加入允许列表的文件夹</label>
        <Input
          id="file-root-path"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="例如 ~/Documents/合同"
          className="min-w-0 flex-1"
        />
        <Button type="submit" size="sm" variant="secondary" disabled={!value.trim() || busy !== null}>
          <Plus aria-hidden />
          加入
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => void choose()} disabled={choosing || busy !== null}>
          <FolderOpen aria-hidden />
          {choosing ? "选择中…" : "选择…"}
        </Button>
      </form>
      {note && <ResultNote result={{ ok: false, message: note }} />}
      <p className="text-xs text-muted-foreground">
        改完会自动重启内置文件服务器，重连之后生效。单个任务的「工作目录」只是告诉模型文件放在哪，不会自动加入这里。
      </p>
    </div>
  );
}
