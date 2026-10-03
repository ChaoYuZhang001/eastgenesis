import { useId, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp, File, Folder, FolderOpen, HardDrive, Lightbulb, Paperclip, Plug, Plus, Settings2, Sparkles, Target, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Menu, MenuCheckbox, MenuItem, MenuLabel, MenuRadio, MenuSeparator, SubMenu } from "@/components/ui/menu";
import { ACCEPT, MAX_FILES, readTextFile } from "@/lib/attachments";
import { useChat } from "@/stores/chat";
import { useGoals } from "@/stores/goals";
import { useMcp } from "@/stores/mcp";
import { useProjects } from "@/stores/projects";
import { useSettings } from "@/stores/settings";
import { MAX_GOAL } from "@/stores/tasks";
import { useUi } from "@/stores/ui";
import { PermissionSelect, RoutingSelect } from "./ModelSelect";

// 输入框（docs/UI_LAYOUT_V3.md 第 3 节）：可选的标签行 + 文本区 + 底行四个元素（添加 · 权限 · 自动路由 · 发送）。
// 金色只用在火花这类小元素上（BRAND.md 4.3-1）。
export function Composer({ autoFocus = false }: { autoFocus?: boolean }) {
  const id = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const loaded = useSettings((s) => s.loaded);
  const chat = useChat();
  const { draft, files, lock, permission, multi, preference, mode, workdir, setDraft, addFiles, removeFile, setLock, setPermission, setMulti, setPreference, setMode, setWorkdir, send } = chat;
  const currentId = useUi((s) => s.currentProjectId);
  const setCurrent = useUi((s) => s.setCurrentProject);
  const open = useUi((s) => s.open);
  const project = useProjects((s) => (currentId ? s.items.find((p) => p.id === currentId) ?? null : null));
  const saveGoal = useGoals((s) => s.save);
  const ready = loaded && draft.trim().length > 0;

  const placeholder =
    mode === "goal" ? "描述要持续追求的目标..." : mode === "plan" ? "描述任务，先出计划再执行..." : project ? `在「${project.name}」里描述你的任务...` : "描述你的任务...";

  // 目标模式：新建目标并打开详情页（M9 只建目标；多轮执行在 M10 接上）
  const submit = async () => {
    if (!ready) return;
    if (mode === "goal") {
      const r = await saveGoal({ description: draft, project_id: project && !project.archived ? project.id : null, ...(preference && { routing_preference: preference }) });
      if (typeof r === "string") return setFileError(r);
      setDraft("");
      setMode("quick");
      open({ kind: "goal", id: r.id });
      return;
    }
    send({ projectId: project && !project.archived ? project.id : null });
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit();
  };

  // ⌘↩ / Ctrl+Enter 发送，Enter 换行（V3 第 3 节）；输入法组合中的 Enter 是在选字，不能当发送
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    e.preventDefault();
    void submit();
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
  };

  const chips = [
    project && { key: "project", icon: Folder, text: project.name, title: `新任务归入项目「${project.name}」`, remove: () => setCurrent(null), label: `移除项目 ${project.name}` },
    workdir && { key: "workdir", icon: FolderOpen, text: workdir.split("/").filter(Boolean).pop() ?? workdir, title: workdir, remove: () => setWorkdir(null), label: `移除工作目录 ${workdir}` },
    ...files.map((f) => ({ key: `file-${f.name}`, icon: Paperclip, text: f.name, title: f.name, remove: () => removeFile(f.name), label: `移除 ${f.name}` })),
    mode === "goal" && { key: "goal", icon: Target, text: "目标", title: "提交后新建目标", remove: () => setMode("quick"), label: "移除目标模式" },
    mode === "plan" && { key: "plan", icon: Lightbulb, text: "计划模式", title: "先出计划，确认后再执行", remove: () => setMode("quick"), label: "移除计划模式" },
    multi && { key: "multi", icon: Users, text: "多 Agent", title: "拆成几个子任务并行执行，再合并成果", remove: () => setMulti(false), label: "移除多 Agent 协同" },
  ].filter(Boolean) as { key: string; icon: typeof Folder; text: string; title: string; remove: () => void; label: string }[];

  return (
    <form onSubmit={onSubmit} className="w-full">
      <div className="rounded-lg border border-east-red/40 bg-surface-2 focus-within:shadow-focus-ring">
        {chips.length > 0 && (
          <ul aria-label="这次任务的设置" className="flex flex-wrap gap-2 px-2 pt-2">
            {chips.map((c) => (
              <li key={c.key} title={c.title} className="flex h-6 max-w-56 items-center gap-1 rounded-sm border border-border px-2 text-xs text-muted-foreground">
                <c.icon aria-hidden className="size-3 shrink-0" />
                <span className="truncate">{c.text}</span>
                <button type="button" aria-label={c.label} onClick={c.remove} className="text-muted-foreground hover:text-foreground">
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
            placeholder={placeholder}
            className="max-h-48 min-h-input w-full resize-none bg-transparent py-4 pl-12 pr-4 text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:shadow-none"
          />
        </div>

        <div className="flex h-10 items-center gap-2 px-2 pb-2">
          <AddMenu onPickFiles={() => fileRef.current?.click()} />
          <PermissionSelect value={permission} onChange={setPermission} />
          <span className="flex-1" />
          <RoutingSelect lock={lock} preference={preference} onLock={setLock} onPreference={setPreference} />
          <Button type="submit" size="icon" disabled={!ready} aria-label="提交任务" title="发送（⌘↩ / Ctrl+Enter）" className="size-8 shrink-0">
            <ArrowUp aria-hidden />
          </Button>
        </div>
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

// 「+」菜单（V3 第 4 节）。工作目录只告诉模型文件放在哪；文件工具能访问的目录仍以内置文件服务器的允许列表为准，
// 选择系统文件夹需要 tauri-plugin-dialog，没接入前用项目的上下文文件夹或手填。
function AddMenu({ onPickFiles }: { onPickFiles: () => void }) {
  const { mode, multi, workdir, servers, setMode, setMulti, setWorkdir, setServers } = useChat();
  const currentId = useUi((s) => s.currentProjectId);
  const openSettings = useUi((s) => s.openSettings);
  const project = useProjects((s) => (currentId ? s.items.find((p) => p.id === currentId) ?? null : null));
  const conns = useMcp((s) => s.conns);
  const registry = useMcp((s) => s.registry);
  const ids = [...new Set([...(registry?.servers ?? []).map((s) => s.id), ...Object.keys(conns)])];
  const running = ids.filter((id) => conns[id]?.status === "running");
  const picked = servers ?? running;
  const toggleServer = (id: string, on: boolean) => {
    const next = on ? [...new Set([...picked, id])] : picked.filter((x) => x !== id);
    setServers(running.every((r) => next.includes(r)) && next.every((n) => running.includes(n)) ? null : next);
  };
  const folders = project?.context_folders ?? [];
  const askFolder = () => {
    const v = window.prompt("工作目录（绝对路径，可以用 ~/ 开头）", workdir ?? "");
    if (v === null) return;
    const t = v.trim();
    if (!t) return setWorkdir(null);
    if (!t.startsWith("/") && !t.startsWith("~/")) return window.alert("请填绝对路径，或以 ~/ 开头");
    setWorkdir(t);
  };

  return (
    <Menu
      label="添加"
      side="top"
      width="w-64"
      triggerClassName="grid size-8 shrink-0 place-items-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-surface hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground"
      trigger={<Plus aria-hidden className="size-4" />}
    >
      <MenuLabel>添加</MenuLabel>
      <SubMenu icon={<Paperclip aria-hidden />} label="文件和文件夹">
        <MenuItem icon={<File aria-hidden />} onSelect={onPickFiles} hint={`纯文本，最多 ${MAX_FILES} 个`}>
          文件…
        </MenuItem>
        <MenuItem icon={<Folder aria-hidden />} onSelect={askFolder} hint="设为这次任务的工作目录">
          文件夹…
        </MenuItem>
      </SubMenu>
      <SubMenu icon={<FolderOpen aria-hidden />} label="工作目录" hint={workdir ?? "没有指定"}>
        {folders.length > 0 && <MenuLabel>项目的上下文文件夹</MenuLabel>}
        {folders.map((f) => (
          <MenuRadio key={f} checked={workdir === f} onSelect={() => setWorkdir(f)}>
            {f}
          </MenuRadio>
        ))}
        {workdir && !folders.includes(workdir) && (
          <MenuRadio checked onSelect={() => {}}>
            {workdir}
          </MenuRadio>
        )}
        {workdir && <MenuItem onSelect={() => setWorkdir(null)}>不指定</MenuItem>}
        <MenuItem onSelect={askFolder}>选择其他文件夹…</MenuItem>
      </SubMenu>
      <MenuCheckbox icon={<Target aria-hidden />} checked={mode === "goal"} onChange={(on) => setMode(on ? "goal" : "quick")} hint="设置持续追求的目标">
        目标
      </MenuCheckbox>
      <MenuCheckbox icon={<Lightbulb aria-hidden />} checked={mode === "plan"} onChange={(on) => setMode(on ? "plan" : "quick")} hint="先出计划，你确认后再执行">
        计划模式
      </MenuCheckbox>
      <MenuCheckbox icon={<Users aria-hidden />} checked={multi} onChange={setMulti} hint="拆成几个子任务并行，再合并成果">
        多 Agent 协同
      </MenuCheckbox>
      <MenuSeparator />
      <SubMenu icon={<Plug aria-hidden />} label="插件" hint={`${picked.length} 个服务器可用`}>
        {ids.length === 0 && <MenuLabel>还没有登记 MCP 服务器</MenuLabel>}
        {ids.map((id) => {
          const ok = conns[id]?.status === "running";
          return (
            <MenuCheckbox key={id} icon={id === "files" ? <HardDrive aria-hidden /> : <Plug aria-hidden />} checked={ok && picked.includes(id)} disabled={!ok}
              onChange={(on) => toggleServer(id, on)} hint={ok ? (id === "files" ? "内置" : undefined) : "未连接"}>
              {id === "files" ? "文件系统" : id}
            </MenuCheckbox>
          );
        })}
        <MenuSeparator />
        <MenuItem icon={<Settings2 aria-hidden />} onSelect={() => openSettings("mcp")}>
          管理插件…
        </MenuItem>
      </SubMenu>
    </Menu>
  );
}

