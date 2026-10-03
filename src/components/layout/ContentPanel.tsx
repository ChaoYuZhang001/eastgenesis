import { useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Archive, ArchiveRestore, ChevronRight, Ellipsis, Folder, FolderPlus, MessageSquare, Pause, Pencil, Play, Search, SquarePen, Trash2 } from "lucide-react";
import { GoalStatusIcon } from "@/components/goal/GoalStatus";
import { SETTINGS_GROUPS } from "@/components/settings/registry";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/menu";
import { brand } from "@/brand/assets";
import { canTransition, type Goal } from "@/decision/goal";
import type { Project } from "@/decision/project";
import { HISTORY_LABEL, goalSummary, historyBucket, matches, projectSummary, recentItems, sessionSummary, type HistoryBucket } from "@/lib/sidebar-rows";
import { SAVINGS_HINT, savedPercent, savedText } from "@/lib/savings";
import { useTasksSavings } from "@/lib/use-savings";
import { cn } from "@/lib/utils";
import { useChat, type Session } from "@/stores/chat";
import { useGoals } from "@/stores/goals";
import { useProjects } from "@/stores/projects";
import { useSettings } from "@/stores/settings";
import { useTasks } from "@/stores/tasks";
import { useDialogs } from "@/stores/dialogs";
import { useUi } from "@/stores/ui";

// 内容栏（docs/UI_LAYOUT_V3.md 1.2–1.4）：顶行 Logo + 搜索；新任务；随图标栏切换的列表。
// 列表行高 48、两行（名称 + 路由摘要）；悬停或键盘聚焦时出现「更多操作」，右键打开同一个菜单。
export function ContentPanel({ onNewTask }: { onNewTask: () => void }) {
  const rail = useUi((s) => s.rail);
  return (
    <aside aria-label="内容栏" className="flex w-sidebar shrink-0 flex-col border-r border-border bg-surface-2">
      <TopRow />
      <div className="px-3 pb-3">
        <button
          type="button"
          onClick={onNewTask}
          className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-border text-sm text-foreground transition-colors hover:bg-surface"
        >
          <SquarePen aria-hidden className="size-4" />
          新任务
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {rail === "home" && <HomeList />}
        {rail === "projects" && <ProjectsList />}
        {rail === "history" && <HistoryList />}
        {rail === "settings" && <SettingsNav />}
      </div>
    </aside>
  );
}

// 顶行：组合 Logo 显示宽 160（BRAND.md 8.2-3 的下限）；搜索按钮点开后下方出现搜索框
function TopRow() {
  const search = useUi((s) => s.search);
  const setSearch = useUi((s) => s.setSearch);
  const btn = useRef<HTMLButtonElement>(null);
  const close = () => {
    setSearch({ open: false, query: "" });
    btn.current?.focus();
  };
  return (
    <>
      <div className="flex h-20 shrink-0 items-center justify-between px-4">
        <img src={brand.assets.logoDarkTransparent} alt={brand.product} className="w-40 select-none" draggable={false} />
        <button
          ref={btn}
          type="button"
          aria-label="搜索"
          aria-expanded={search.open}
          onClick={() => (search.open ? close() : setSearch({ open: true }))}
          className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
        >
          <Search aria-hidden className="size-4" />
        </button>
      </div>
      {search.open && (
        <div className="px-3 pb-3">
          <input
            autoFocus
            type="search"
            aria-label="搜索内容栏"
            placeholder="搜索"
            value={search.query}
            onChange={(e) => setSearch({ query: e.target.value })}
            onKeyDown={(e) => e.key === "Escape" && close()}
            onBlur={() => !search.query && setSearch({ open: false })}
            className="h-8 w-full rounded-md border border-border bg-surface px-2 text-xs text-foreground placeholder:text-muted-foreground"
          />
        </div>
      )}
    </>
  );
}

function Group({ id, label, count, open, onToggle, children }: { id: string; label: string; count: number; open: boolean; onToggle: () => void; children: ReactNode }) {
  const body = `group-${id}`;
  return (
    <section className="mb-2">
      <h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={body}
          onClick={onToggle}
          className="flex h-8 w-full items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronRight aria-hidden className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
          <span>{label}</span>
          {!open && <span className="ml-auto tabular-nums">{count}</span>}
        </button>
      </h2>
      <div id={body} hidden={!open}>
        {children}
      </div>
    </section>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <p className="px-2 py-2 text-xs text-muted-foreground">{children}</p>;

interface RowProps {
  icon: ReactNode;
  name: string;
  summary: string;
  summaryTitle?: string;
  selected?: boolean;
  nested?: boolean;
  expanded?: boolean;
  onOpen: () => void;
  menu?: ReactNode;
  menuLabel?: string;
}

// 一行：图标 + 两行文字；右侧「更多操作」只在悬停或键盘聚焦时出现（不计入首屏控件）
function Row({ icon, name, summary, summaryTitle, selected, nested, expanded, onOpen, menu, menuLabel }: RowProps) {
  const [hot, setHot] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const openMenu = () => wrap.current?.querySelector<HTMLButtonElement>("[aria-haspopup=menu]")?.click();
  const onContext = (e: MouseEvent) => {
    if (!menu) return;
    e.preventDefault();
    setHot(true);
    requestAnimationFrame(openMenu);
  };
  const onKey = (e: KeyboardEvent) => {
    if (menu && (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))) {
      e.preventDefault();
      setHot(true);
      requestAnimationFrame(openMenu);
    }
  };
  return (
    <div
      ref={wrap}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={(e) => !wrap.current?.contains(document.activeElement) && !e.buttons && setHot(false)}
      onFocus={() => setHot(true)}
      onBlur={(e) => !wrap.current?.contains(e.relatedTarget as Node) && setHot(false)}
      onContextMenu={onContext}
      className={cn("group relative flex items-center rounded-md", selected ? "bg-accent text-foreground" : "hover:bg-surface")}
    >
      <button
        type="button"
        aria-current={selected ? "page" : undefined}
        aria-expanded={expanded}
        onClick={onOpen}
        onKeyDown={onKey}
        title={name}
        className={cn("flex h-12 min-w-0 flex-1 items-start gap-2 rounded-md py-2 pr-2 text-left", nested ? "pl-8" : "pl-2")}
      >
        <span className={cn("grid h-5 w-4 shrink-0 place-items-center [&_svg]:size-4", !selected && "text-muted-foreground")}>{icon}</span>
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-sm", !selected && "text-foreground")}>{name}</span>
          <span title={summaryTitle} className="block truncate text-xs text-muted-foreground">
            {summary}
          </span>
        </span>
      </button>
      {menu && hot && (
        <div className="absolute right-1 top-1">
          <Menu label={menuLabel ?? `${name} 的更多操作`} title="更多操作" align="end" width="w-48"
            trigger={<Ellipsis aria-hidden className="size-4" />}
            triggerClassName="grid size-6 place-items-center rounded-sm text-muted-foreground hover:bg-surface-2 hover:text-foreground">
            {menu}
          </Menu>
        </div>
      )}
    </div>
  );
}

function useLists() {
  const sessions = useChat((s) => s.sessions);
  const projects = useProjects((s) => s.items);
  const goals = useGoals((s) => s.items);
  const tasks = useTasks((s) => s.tasks);
  const query = useUi((s) => s.search.query);
  return { sessions, projects, goals, tasks, query };
}

function SessionRow({ session, nested }: { session: Session; nested?: boolean }) {
  const activeId = useChat((s) => s.activeId);
  const main = useUi((s) => s.main);
  const open = useUi((s) => s.open);
  const select = useChat((s) => s.select);
  const tasks = useTasks((s) => s.tasks);
  const mine = useMemo(() => tasks.filter((t) => t.sessionId === session.id), [tasks, session.id]);
  const saved = savedText(useTasksSavings(mine));
  return (
    <Row
      icon={<MessageSquare aria-hidden />}
      name={session.title}
      summary={[sessionSummary(mine), saved].filter(Boolean).join(" · ")}
      summaryTitle={saved ? SAVINGS_HINT : undefined}
      selected={main.kind === "chat" && activeId === session.id}
      nested={nested}
      onOpen={() => {
        select(session.id);
        open({ kind: "chat" });
      }}
    />
  );
}

function GoalRow({ goal, nested }: { goal: Goal; nested?: boolean }) {
  const main = useUi((s) => s.main);
  const open = useUi((s) => s.open);
  const { start, pause } = useGoals();
  const ask = useDialogs((s) => s.ask);
  const tasks = useTasks((s) => s.tasks);
  const mine = useMemo(() => tasks.filter((t) => t.goalId === goal.id), [tasks, goal.id]);
  const saved = savedText(useTasksSavings(mine));
  const canPause = canTransition(goal.status, "paused");
  const canStart = canTransition(goal.status, "running");
  const canAbandon = canTransition(goal.status, "abandoned");
  return (
    <Row
      icon={<GoalStatusIcon goal={goal} />}
      name={goal.description}
      summary={[goalSummary(goal), saved].filter(Boolean).join(" · ")}
      summaryTitle={saved ? SAVINGS_HINT : undefined}
      selected={main.kind === "goal" && main.id === goal.id}
      nested={nested}
      onOpen={() => open({ kind: "goal", id: goal.id })}
      menuLabel="目标的更多操作"
      menu={
        <>
          {canStart && (
            <MenuItem icon={<Play aria-hidden />} onSelect={() => void start(goal.id)}>
              {goal.status === "idle" ? "开始" : "继续"}
            </MenuItem>
          )}
          {canPause && (
            <MenuItem icon={<Pause aria-hidden />} onSelect={() => void pause(goal.id)}>
              暂停
            </MenuItem>
          )}
          {canAbandon && (
            <MenuItem icon={<Archive aria-hidden />} onSelect={() => ask({ kind: "abandon-goal", id: goal.id })}>
              放弃目标…
            </MenuItem>
          )}
          <MenuItem icon={<Trash2 aria-hidden />} onSelect={() => ask({ kind: "delete-goal", id: goal.id })}>
            删除目标…
          </MenuItem>
        </>
      }
    />
  );
}

function ProjectMenu({ project }: { project: Project }) {
  const { archive, unarchive, requestDelete } = useProjects();
  const ask = useDialogs((s) => s.ask);
  return (
    <>
      <MenuItem icon={<Pencil aria-hidden />} onSelect={() => ask({ kind: "edit-project", id: project.id })}>
        编辑项目…
      </MenuItem>
      {project.archived ? (
        <MenuItem icon={<ArchiveRestore aria-hidden />} onSelect={() => void unarchive(project.id)}>
          取消归档
        </MenuItem>
      ) : (
        <MenuItem icon={<Archive aria-hidden />} onSelect={() => void archive(project.id)}>
          归档
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem icon={<Trash2 aria-hidden />} onSelect={() => void requestDelete(project.id)}>
        删除项目…
      </MenuItem>
    </>
  );
}

// 工作台里的项目行：点了展开并设为当前项目（新任务归入它），不切换主区
/** 项目本月的节省比例：本次启动以来、属于这个项目、本月开始的任务 */
function useProjectPercent(projectId: string): number | null {
  const tasks = useTasks((s) => s.tasks);
  const mine = useMemo(() => {
    const d = new Date();
    const month = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    return tasks.filter((t) => t.projectId === projectId && t.startedAt >= month);
  }, [tasks, projectId]);
  return savedPercent(useTasksSavings(mine));
}

function ProjectRow({ project, children, count }: { project: Project; children: ReactNode; count: number }) {
  const expanded = useUi((s) => s.expanded.includes(project.id));
  const toggle = useUi((s) => s.toggleExpanded);
  const current = useUi((s) => s.currentProjectId);
  const setCurrent = useUi((s) => s.setCurrentProject);
  const global = useSettings((s) => s.routing.preference);
  const sum = projectSummary(project, global);
  const pct = useProjectPercent(project.id);
  const pctText = pct === null || pct === 0 ? null : pct > 0 ? `省 ${pct}%` : `多花 ${-pct}%`;
  return (
    <li>
      <Row
        icon={<Folder aria-hidden />}
        name={project.name}
        summary={[sum.text, pctText].filter(Boolean).join(" · ")}
        summaryTitle={pctText ? `${sum.title}；本月${pctText}，${SAVINGS_HINT}` : sum.title}
        selected={current === project.id}
        expanded={expanded}
        onOpen={() => {
          toggle(project.id);
          setCurrent(project.id);
        }}
        menuLabel="项目的更多操作"
        menu={<ProjectMenu project={project} />}
      />
      {expanded && (
        <div role="group" aria-label={`${project.name} 里的目标和任务`}>
          {count === 0 ? <p className="py-2 pl-8 pr-2 text-xs text-muted-foreground">还没有目标和任务</p> : children}
        </div>
      )}
    </li>
  );
}

const SHOW = 5;
function HomeList() {
  const { sessions, projects, goals, query } = useLists();
  const groups = useUi((s) => s.prefs.groups);
  const toggleGroup = useUi((s) => s.toggleGroup);
  const setRail = useUi((s) => s.setRail);
  const live = projects.filter((p) => !p.archived && matches(p.name, query));
  const recent = recentItems(
    sessions.filter((s) => matches(s.title, query)),
    goals.filter((g) => matches(g.description, query)),
  );
  return (
    <>
      <Group id="projects" label="项目" count={live.length} open={groups.projects} onToggle={() => toggleGroup("projects")}>
        {live.length === 0 ? (
          <Empty>{query ? "没有匹配的项目" : "还没有项目"}</Empty>
        ) : (
          <ul>
            {live.map((p) => {
              const items = recentItems(
                sessions.filter((s) => s.projectId === p.id),
                goals.filter((g) => g.project_id === p.id),
                Infinity,
              );
              return (
                <ProjectRow key={p.id} project={p} count={items.length}>
                  {items.slice(0, SHOW).map((it) => (it.kind === "goal" ? <GoalRow key={it.goal.id} goal={it.goal} nested /> : <SessionRow key={it.session.id} session={it.session} nested />))}
                  {items.length > SHOW && (
                    <button type="button" onClick={() => setRail("history")} className="h-8 w-full rounded-md pl-8 text-left text-xs text-muted-foreground hover:text-foreground">
                      全部 {items.length} 条
                    </button>
                  )}
                </ProjectRow>
              );
            })}
          </ul>
        )}
      </Group>
      <Group id="recent" label="最近" count={recent.length} open={groups.recent} onToggle={() => toggleGroup("recent")}>
        <nav aria-label="会话列表">
          {recent.length === 0 ? (
            <Empty>{query ? "没有匹配的会话" : "还没有会话"}</Empty>
          ) : (
            <ul>
              {recent.map((it) => (
                <li key={it.kind === "goal" ? it.goal.id : it.session.id}>{it.kind === "goal" ? <GoalRow goal={it.goal} /> : <SessionRow session={it.session} />}</li>
              ))}
            </ul>
          )}
          {sessions.length + goals.length > 20 && !query && (
            <button type="button" onClick={() => setRail("history")} className="h-8 w-full rounded-md px-2 text-left text-xs text-muted-foreground hover:text-foreground">
              查看全部
            </button>
          )}
        </nav>
      </Group>
    </>
  );
}

// 「项目」视图：新建项目；点项目行在主区打开概览
function ProjectsList() {
  const { projects, query } = useLists();
  const groups = useUi((s) => s.prefs.groups);
  const toggleGroup = useUi((s) => s.toggleGroup);
  const main = useUi((s) => s.main);
  const open = useUi((s) => s.open);
  const global = useSettings((s) => s.routing.preference);
  const ask = useDialogs((s) => s.ask);
  const shown = projects.filter((p) => matches(p.name, query));
  const live = shown.filter((p) => !p.archived);
  const archived = shown.filter((p) => p.archived);
  const row = (p: Project) => {
    const sum = projectSummary(p, global);
    return (
      <li key={p.id}>
        <Row
          icon={p.archived ? <Archive aria-hidden /> : <Folder aria-hidden />}
          name={p.name}
          summary={sum.text}
          summaryTitle={sum.title}
          selected={main.kind === "project" && main.id === p.id}
          onOpen={() => open({ kind: "project", id: p.id })}
          menuLabel="项目的更多操作"
          menu={<ProjectMenu project={p} />}
        />
      </li>
    );
  };
  return (
    <nav aria-label="项目列表">
      <button
        type="button"
        onClick={() => ask({ kind: "new-project" })}
        className="mb-2 flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
      >
        <FolderPlus aria-hidden className="size-4" />
        新建项目
      </button>
      {live.length === 0 ? <Empty>{query ? "没有匹配的项目" : "还没有项目"}</Empty> : <ul>{live.map(row)}</ul>}
      <Group id="archived" label="已归档" count={archived.length} open={groups.archived} onToggle={() => toggleGroup("archived")}>
        {archived.length === 0 ? <Empty>没有归档的项目</Empty> : <ul>{archived.map(row)}</ul>}
      </Group>
    </nav>
  );
}

// 「历史」视图：全部会话和目标，按今天 / 昨天 / 7 天内 / 更早分组
function HistoryList() {
  const { sessions, goals, query } = useLists();
  const items = recentItems(
    sessions.filter((s) => matches(s.title, query)),
    goals.filter((g) => matches(g.description, query)),
    Infinity,
  );
  const now = Date.now();
  const buckets = (Object.keys(HISTORY_LABEL) as HistoryBucket[]).map((b) => ({ b, list: items.filter((it) => historyBucket(it.at, now) === b) })).filter((x) => x.list.length);
  return (
    <nav aria-label="历史">
      {buckets.length === 0 && <Empty>{query ? "没有匹配的记录" : "还没有会话"}</Empty>}
      {buckets.map(({ b, list }) => (
        <section key={b} aria-label={HISTORY_LABEL[b]} className="mb-2">
          <h2 className="px-2 py-2 text-xs text-muted-foreground">{HISTORY_LABEL[b]}</h2>
          <ul>
            {list.map((it) => (
              <li key={it.kind === "goal" ? it.goal.id : it.session.id}>{it.kind === "goal" ? <GoalRow goal={it.goal} /> : <SessionRow session={it.session} />}</li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}

// 「设置」视图：4 个分类 + 子页（V3 第 8 节）
function SettingsNav() {
  const page = useUi((s) => s.settingsPage);
  const openSettings = useUi((s) => s.openSettings);
  const query = useUi((s) => s.search.query);
  return (
    <nav aria-label="设置分类">
      {SETTINGS_GROUPS.map((g) => {
        const pages = g.pages.filter((p) => matches(p.label, query) || matches(g.label, query));
        if (!pages.length) return null;
        return (
          <section key={g.id} aria-label={g.label} className="mb-3">
            <h2 className="px-2 py-2 text-xs text-muted-foreground">{g.label}</h2>
            <ul>
              {pages.map((p) => {
                const selected = p.id === page;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      aria-current={selected ? "page" : undefined}
                      onClick={() => openSettings(p.id)}
                      className={cn("flex h-8 w-full items-center rounded-md px-2 text-left text-sm transition-colors", selected ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-surface hover:text-foreground")}
                    >
                      {p.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </nav>
  );
}

