import type { SettingsPageId } from "@/stores/ui";

// 设置页分类（docs/UI_LAYOUT_V3.md 第 8 节）：内容栏按这个顺序列出，主区显示所选子页
export interface SettingsPageDef {
  id: SettingsPageId;
  label: string;
}
export interface SettingsGroup {
  id: string;
  label: string;
  pages: SettingsPageDef[];
}

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    id: "personal",
    label: "个人",
    pages: [
      { id: "general", label: "常规" },
      { id: "notifications", label: "通知" },
      { id: "appearance", label: "外观" },
      { id: "shortcuts", label: "键盘快捷键" },
      { id: "usage", label: "使用情况" },
    ],
  },
  {
    id: "models",
    label: "模型与路由",
    pages: [
      { id: "providers", label: "Provider 管理" },
      { id: "custom", label: "自定义中转站" },
      { id: "routing", label: "路由偏好" },
      { id: "matrix", label: "能力矩阵" },
    ],
  },
  {
    id: "agent",
    label: "Agent",
    pages: [
      { id: "mcp", label: "MCP 服务器" },
      { id: "skills", label: "技能库" },
      { id: "memory", label: "记忆" },
      { id: "permissions", label: "权限默认值" },
    ],
  },
  {
    id: "about",
    label: "关于",
    pages: [
      { id: "version", label: "版本" },
      { id: "updates", label: "检查更新" },
      { id: "licenses", label: "许可证" },
    ],
  },
];

export const SETTINGS_PAGES: readonly SettingsPageDef[] = SETTINGS_GROUPS.flatMap((g) => g.pages);
export const pageLabel = (id: SettingsPageId) => SETTINGS_PAGES.find((p) => p.id === id)?.label ?? id;
export const groupOf = (id: SettingsPageId) => SETTINGS_GROUPS.find((g) => g.pages.some((p) => p.id === id))!;
