import { useId, type ReactNode } from "react";
import { Info } from "lucide-react";
import { PERMISSION_HINT, PERMISSION_LABEL, PERMISSION_MODES, type PermissionMode } from "@/decision";
import { Select } from "@/components/ui/input";
import { useAppStore } from "@/stores/app";
import { useChat } from "@/stores/chat";
import { useSettings } from "@/stores/settings";
import { useUi, type FontSize, type SettingsPageId } from "@/stores/ui";
import { DecisionLayerSettings, ProviderKeys } from "./ApiKeys";
import { CapabilityMatrix } from "./CapabilityMatrix";
import { RadioGroup, SettingsSection } from "./controls";
import { CustomProviders } from "./CustomProviders";
import { LicensesPage } from "./LicensesPage";
import { McpSettings } from "./McpSettings";
import { MemorySettings } from "./MemorySettings";
import { pageLabel } from "./registry";
import { RoutingSettings } from "./RoutingSettings";
import { SkillSettings } from "./SkillSettings";
import { UsagePage } from "./UsagePage";

// 设置主区：标题 + 所选子页。子页内容沿用原有组件，只换了组织方式（V3 第 8 节）
export function SettingsView() {
  const page = useUi((s) => s.settingsPage);
  return (
    <main aria-label="设置" className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-surface px-8 py-8">
      <div className="mx-auto w-full max-w-3xl space-y-6 pb-8">
        <h1 className="font-display text-2xl font-semibold">{pageLabel(page)}</h1>
        <SettingsContent page={page} />
      </div>
    </main>
  );
}

export function SettingsContent({ page }: { page: SettingsPageId }) {
  switch (page) {
    case "general":
      return <GeneralPage />;
    case "notifications":
      return <NotificationsPage />;
    case "appearance":
      return <AppearancePage />;
    case "shortcuts":
      return <ShortcutsPage />;
    case "usage":
      return <UsagePage />;
    case "providers":
      return <ProviderKeys />;
    case "custom":
      return <CustomProviders />;
    case "routing":
      return (
        <div className="space-y-10">
          <RoutingSettings />
          <DecisionLayerSettings />
        </div>
      );
    case "matrix":
      return <CapabilityMatrix />;
    case "mcp":
      return <McpSettings />;
    case "skills":
      return <SkillSettings />;
    case "memory":
      return <MemorySettings />;
    case "permissions":
      return <PermissionDefaults />;
    case "version":
      return <VersionPage />;
    case "updates":
      return <Note>开发阶段，没有自动更新。新版本由开发者打包后手动安装。</Note>;
    case "licenses":
      return <LicensesPage />;
  }
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-sm text-muted-foreground">
      <Info aria-hidden className="mt-1 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  const id = useId();
  const hintId = useId();
  return (
    <div className="max-w-xl space-y-1">
      <div className="flex items-center gap-2">
        <input id={id} type="checkbox" aria-describedby={hintId} className="size-4 accent-east-red" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <label htmlFor={id} className="text-sm">
          {label}
        </label>
      </div>
      <p id={hintId} className="text-xs text-muted-foreground">
        {hint}
      </p>
    </div>
  );
}

function GeneralPage() {
  const showReasoning = useSettings((s) => s.showReasoning);
  const setShowReasoning = useSettings((s) => s.setShowReasoning);
  const expert = useUi((s) => s.prefs.expert);
  const setPrefs = useUi((s) => s.setPrefs);
  return (
    <SettingsSection title="显示">
      <Toggle
        label="显示模型思考过程"
        hint="默认关闭。打开后，推理模型的回答下方会多一行可展开的思考摘要，只保留和你的问题有关的中文内容。"
        checked={showReasoning}
        onChange={setShowReasoning}
      />
      <Toggle
        label="专家模式"
        hint="打开后，回答下方「为什么选它」的浮层里多显示内部评分、四项权重和成本档。布局不变。"
        checked={expert}
        onChange={(v) => setPrefs({ expert: v })}
      />
    </SettingsSection>
  );
}

function NotificationsPage() {
  return (
    <SettingsSection title="应用内提示">
      <Note>任务完成、失败或需要你确认时，提示出现在对应的回答里；目标等你确认时，目标详情页顶部有提示条。系统通知需要单独的插件，目前没有接入。</Note>
    </SettingsSection>
  );
}

const FONT_SIZES: { value: FontSize; label: string; hint: string }[] = [
  { value: "sm", label: "小", hint: "14px" },
  { value: "md", label: "中", hint: "16px（默认）" },
  { value: "lg", label: "大", hint: "18px" },
];

function AppearancePage() {
  const prefs = useUi((s) => s.prefs);
  const setPrefs = useUi((s) => s.setPrefs);
  return (
    <SettingsSection title="外观" description="产品界面只有深色主题（BRAND.md 第 7 节）。">
      <RadioGroup legend="字号" value={prefs.fontSize} options={FONT_SIZES} onChange={(fontSize) => setPrefs({ fontSize })} />
      <Toggle
        label="减少动态效果"
        hint="关闭转动、呼吸和展开过渡。系统里打开了「减少动态效果」时，应用也会自动关闭这些效果。"
        checked={prefs.reduceMotion}
        onChange={(reduceMotion) => setPrefs({ reduceMotion })}
      />
    </SettingsSection>
  );
}

const SHORTCUTS: [string, string][] = [
  ["⌘N / Ctrl+N", "新任务"],
  ["⌘B / Ctrl+B", "收起或展开内容栏"],
  ["⌘, / Ctrl+,", "打开设置"],
  ["⌘↩ / Ctrl+Enter", "发送输入框里的任务（Enter 换行）"],
  ["Esc", "关闭浮层、菜单和右侧面板"],
];

function ShortcutsPage() {
  return (
    <SettingsSection title="键盘快捷键" description="只在应用窗口聚焦时有效，不注册系统全局快捷键。">
      <table className="w-full max-w-xl text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="py-1 font-normal">
              按键
            </th>
            <th scope="col" className="py-1 font-normal">
              作用
            </th>
          </tr>
        </thead>
        <tbody>
          {SHORTCUTS.map(([k, v]) => (
            <tr key={k} className="border-t border-border">
              <td className="py-2 font-mono text-xs">{k}</td>
              <td className="py-2">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </SettingsSection>
  );
}

function PermissionDefaults() {
  const id = useId();
  const value = useSettings((s) => s.defaultPermission);
  const setDefaultPermission = useSettings((s) => s.setDefaultPermission);
  const setPermission = useChat((s) => s.setPermission);
  return (
    <SettingsSection title="新任务的默认权限" description="输入框里的权限胶囊从这一档开始，单个任务仍可临时改。三档的含义不变。">
      <div className="max-w-xs space-y-1">
        <label htmlFor={id} className="text-sm">
          默认档位
        </label>
        <Select
          id={id}
          value={value}
          onChange={(e) => {
            const v = e.target.value as PermissionMode;
            setDefaultPermission(v);
            setPermission(v);
          }}
        >
          {PERMISSION_MODES.map((m) => (
            <option key={m} value={m}>
              {PERMISSION_LABEL[m]}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">{PERMISSION_HINT[value]}</p>
      </div>
    </SettingsSection>
  );
}

function VersionPage() {
  const init = useAppStore((s) => s.init);
  const kind = useAppStore((s) => s.backendKind);
  const rows: [string, string][] = [
    ["应用", init?.info.name ?? "EastGenesis Desktop"],
    ["版本", init?.info.version ?? "未知"],
    ["后端", kind === "mock" ? "浏览器模拟（不调用真实 API，数据不保存）" : kind === "tauri" ? "桌面（本机运行）" : "未就绪"],
    ["存储", init ? (init.storage === "sqlite" ? "SQLite（本机）" : "内存存储（不持久化）") : "未初始化"],
    ["数据库结构版本", init?.schemaVersion != null ? String(init.schemaVersion) : "无"],
  ];
  return (
    <dl aria-label="版本信息" className="grid max-w-xl grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
