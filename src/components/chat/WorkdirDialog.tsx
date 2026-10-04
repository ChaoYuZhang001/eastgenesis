import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { normalizeFolders } from "@/decision/project";
import { toAppError } from "@/lib/ipc";
import { useChat } from "@/stores/chat";

// 「+」› 工作目录 › 选择其他文件夹…：只作为上下文告诉模型文件放在哪；文件工具能访问的目录仍以内置文件服务器的允许列表为准。
// 校验规则同项目的上下文文件夹（绝对路径或 ~/ 开头、不含 ..、不能是整个磁盘或家目录）。
// 系统文件夹对话框要接 tauri-plugin-dialog，还没有接入（Tauri 的 webview 里 window.prompt 不可用）。
export function WorkdirDialog({ onClose }: { onClose: () => void }) {
  const workdir = useChat((s) => s.workdir);
  const setWorkdir = useChat((s) => s.setWorkdir);
  const [value, setValue] = useState(workdir ?? "");
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const err = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) {
      setWorkdir(null);
      return onClose();
    }
    try {
      const [p] = normalizeFolders([value]);
      setWorkdir(p ?? null);
      onClose();
    } catch (x) {
      setError(toAppError(x).message);
    }
  };
  return (
    <Dialog title="工作目录" onClose={onClose}>
      <form aria-label="工作目录" onSubmit={submit} className="space-y-4">
        <div className="space-y-1">
          <label htmlFor={id} className="text-sm">
            文件夹路径
          </label>
          <Input id={id} value={value} onChange={(e) => setValue(e.target.value)} placeholder="例如 ~/Documents/合同" aria-describedby={error ? err : undefined} />
          <p className="text-xs text-muted-foreground">只告诉模型文件放在哪；文件工具能访问的目录仍以「设置 › MCP 服务器」里内置文件服务器的允许目录为准。留空表示不指定。</p>
        </div>
        {error && (
          <p id={err} role="alert" className="text-sm">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" size="sm">
            确定
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
