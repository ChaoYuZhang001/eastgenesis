import { useId, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp, Paperclip, Plus, Sparkles, X } from "lucide-react";
import { ACCEPT, MAX_FILES, readTextFile } from "@/lib/attachments";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ModelSelect, PermissionSelect } from "./ModelSelect";
import { useChat } from "@/stores/chat";
import { useSettings } from "@/stores/settings";
import { MAX_GOAL } from "@/stores/tasks";

// 输入框：文本域 + 一行工具条（附件、权限、模型、发送）。
// 金色只用在火花这类小元素上（BRAND.md 4.3-1、第 7 节）。
export function Composer({ autoFocus = false }: { autoFocus?: boolean }) {
  const id = useId();
  const menuId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const loaded = useSettings((s) => s.loaded);
  const { draft, files, lock, permission, multi, setDraft, addFiles, removeFile, setLock, setPermission, setMulti, send } = useChat();
  const ready = loaded && draft.trim().length > 0;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) send();
  };

  // Enter 发送、Shift+Enter 换行；输入法组合中的 Enter 是在选字，不能当发送
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    e.preventDefault();
    if (ready) send();
  };

  const onPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const picked = [...(e.target.files ?? [])].slice(0, MAX_FILES);
    e.target.value = "";
    const ok = [];
    const bad = [];
    for (const f of picked) {
      const r = await readTextFile(f);
      if (typeof r === "string") bad.push(r);
      else ok.push(r);
    }
    if (ok.length) addFiles(ok);
    setFileError(bad[0] ?? (files.length + ok.length > MAX_FILES ? `最多附带 ${MAX_FILES} 个文件` : null));
    setMenuOpen(false);
  };

  return (
    <form onSubmit={onSubmit} className="w-full">
      <div className="rounded-lg border border-east-red/40 bg-surface-2">
        {files.length > 0 && (
          <ul aria-label="附带的文件" className="flex flex-wrap gap-2 px-3 pt-3">
            {files.map((f) => (
              <li key={f.name} className="flex h-6 items-center gap-1 rounded-sm border border-border px-2 text-xs text-muted-foreground">
                <Paperclip aria-hidden className="size-3" />
                <span className="max-w-40 truncate">{f.name}</span>
                <button type="button" aria-label={`移除 ${f.name}`} onClick={() => removeFile(f.name)} className="text-muted-foreground hover:text-foreground">
                  <X aria-hidden className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="relative">
          <label htmlFor={id} className="sr-only">
            任务描述
          </label>
          {/* 金色只用于火花这类小元素（BRAND.md 4.3-1），是装饰图形 */}
          <Sparkles aria-hidden className="pointer-events-none absolute left-4 top-4 size-5 text-china-gold" />
          <textarea
            id={id}
            rows={1}
            value={draft}
            autoFocus={autoFocus}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            maxLength={MAX_GOAL}
            placeholder="描述你的任务，或选择一个智能体..."
            className="max-h-48 min-h-input w-full resize-none bg-transparent py-4 pl-12 pr-4 text-base text-foreground placeholder:text-muted-foreground"
          />
        </div>

        <div className="flex h-10 items-center gap-2 px-2 pb-2">
          <button
            type="button"
            aria-label="更多选项"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            onClick={() => setMenuOpen((v) => !v)}
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded-md border border-border transition-colors",
              menuOpen ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-surface hover:text-foreground",
            )}
          >
            <Plus aria-hidden className="size-4" />
          </button>
          <PermissionSelect value={permission} onChange={setPermission} />
          <ModelSelect value={lock} onChange={setLock} />
          <span className="flex-1" />
          <Button type="submit" size="icon" disabled={!ready} aria-label="提交任务" className="size-8 shrink-0">
            <ArrowUp aria-hidden />
          </Button>
        </div>

        {menuOpen && (
          <div id={menuId} className="space-y-2 border-t border-border px-3 py-3 text-sm">
            <button type="button" onClick={() => fileRef.current?.click()} className="flex items-center gap-2 text-muted-foreground hover:text-foreground">
              <Paperclip aria-hidden className="size-4" />
              添加文件（纯文本，最多 {MAX_FILES} 个）
            </button>
            <label className="flex items-center gap-2 text-muted-foreground">
              <input type="checkbox" className="size-4 accent-east-red" checked={multi} onChange={(e) => setMulti(e.target.checked)} />
              多 Agent 协同：拆成几个子任务并行执行，再合并成果
            </label>
          </div>
        )}
      </div>

      {/* 隐藏的文件选择器不参与焦点顺序，也不计入首屏交互元素 */}
      <input ref={fileRef} type="file" accept={ACCEPT} multiple tabIndex={-1} aria-hidden className="hidden" onChange={(e) => void onPick(e)} />

      {fileError && (
        <p role="alert" className="px-3 pt-2 text-xs text-muted-foreground">
          {fileError}
        </p>
      )}
    </form>
  );
}
