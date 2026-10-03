import { useId, useState, type FormEvent } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Select, Textarea } from "@/components/ui/input";
import { MAX_PROJECT_DESC, MAX_PROJECT_NAME, MAX_INSTRUCTIONS, type Project } from "@/decision/project";
import type { Preference } from "@/decision";
import { PREFERENCE_LABEL } from "@/lib/sidebar-rows";
import { useProjects } from "@/stores/projects";

// 新建和编辑共用（docs/UI_LAYOUT_V3.md 2.5）。保存失败时，把 store 返回的中文原文显示出来，不另起文案。
// 上下文文件夹：桌面端的系统文件夹对话框需要 tauri-plugin-dialog，这里先手填绝对路径（以 / 或 ~/ 开头），由 normalizeFolders 校验。
export function ProjectDialog({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const save = useProjects((s) => s.save);
  const ids = { name: useId(), desc: useId(), ins: useId(), pref: useId(), folder: useId(), err: useId() };
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [instructions, setInstructions] = useState(project?.instructions ?? "");
  const [pref, setPref] = useState<Preference | "">(project?.routing_preference ?? "");
  const [folders, setFolders] = useState<string[]>(project?.context_folders ?? []);
  const [folder, setFolder] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const r = await save({ ...(project && { id: project.id }), name, description, instructions, routing_preference: pref || null, context_folders: folders });
    setBusy(false);
    if (typeof r === "string") setError(r);
    else onClose();
  };
  const addFolder = () => {
    const f = folder.trim();
    if (f && !folders.includes(f)) setFolders([...folders, f]);
    setFolder("");
  };

  return (
    <Dialog title={project ? "编辑项目" : "新建项目"} onClose={onClose}>
      <form aria-label={project ? "编辑项目" : "新建项目"} onSubmit={(e) => void submit(e)} className="space-y-4">
        <div className="space-y-1">
          <label htmlFor={ids.name} className="text-sm">
            名称
          </label>
          <Input id={ids.name} required maxLength={MAX_PROJECT_NAME} value={name} onChange={(e) => setName(e.target.value)} aria-describedby={error ? ids.err : undefined} />
        </div>
        <div className="space-y-1">
          <label htmlFor={ids.desc} className="text-sm">
            描述
          </label>
          <Textarea id={ids.desc} maxLength={MAX_PROJECT_DESC} value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-16" />
        </div>
        <div className="space-y-1">
          <label htmlFor={ids.ins} className="text-sm">
            项目指令
          </label>
          <Textarea id={ids.ins} maxLength={MAX_INSTRUCTIONS} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="这个项目下每个目标和任务都会带上，例如「回答用简体中文，先给结论」" />
        </div>
        <div className="space-y-1">
          <label htmlFor={ids.pref} className="text-sm">
            路由偏好
          </label>
          <Select id={ids.pref} value={pref} onChange={(e) => setPref(e.target.value as Preference | "")}>
            <option value="">沿用全局设置</option>
            {(Object.keys(PREFERENCE_LABEL) as Preference[]).map((p) => (
              <option key={p} value={p}>
                {PREFERENCE_LABEL[p]}
              </option>
            ))}
          </Select>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm">上下文文件夹</legend>
          {folders.length > 0 && (
            <ul aria-label="上下文文件夹" className="space-y-1">
              {folders.map((f) => (
                <li key={f} className="flex items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs" title={f}>
                    {f}
                  </span>
                  <button type="button" aria-label={`移除 ${f}`} onClick={() => setFolders(folders.filter((x) => x !== f))} className="text-muted-foreground hover:text-foreground">
                    <X aria-hidden className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <label htmlFor={ids.folder} className="sr-only">
              添加文件夹
            </label>
            <Input id={ids.folder} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="例如 ~/Documents/合同" className="min-w-0 flex-1"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addFolder();
                }
              }} />
            <Button type="button" size="sm" variant="outline" className="h-9" onClick={addFolder} disabled={!folder.trim()}>
              <Plus aria-hidden />
              添加
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">只是记录这个项目相关的文件夹；文件工具能访问哪些目录仍由内置文件服务器的允许列表决定。</p>
        </fieldset>
        {error && (
          <p id={ids.err} role="alert" className="text-sm">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" size="sm" disabled={busy}>
            保存
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
