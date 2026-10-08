import { useState } from "react";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import { ProviderKeys } from "./ApiKeys";
import { CapabilityMatrix } from "./CapabilityMatrix";
import { CustomProviders } from "./CustomProviders";
import { McpSettings } from "./McpSettings";
import { MemorySkills } from "./Placeholders";
import { RoutingSettings } from "./RoutingSettings";

export type SettingsSectionId = "models" | "system";
const SECTION_LABEL: Record<SettingsSectionId, string> = { models: "模型与路由", system: "系统与工具" };

const TABS: Record<SettingsSectionId, TabItem[]> = {
  models: [
    { id: "routing", label: "路由策略", content: <RoutingSettings /> },
    { id: "matrix", label: "能力矩阵", content: <CapabilityMatrix /> },
    { id: "custom", label: "自定义 Provider", content: <CustomProviders /> },
  ],
  system: [
    { id: "keys", label: "API Key", content: <ProviderKeys /> },
    { id: "mcp", label: "MCP 服务器", content: <McpSettings /> },
    { id: "memory", label: "记忆与技能库", content: <MemorySkills /> },
  ],
};

// 设置页：侧栏「模型与路由」「系统与工具」各对应一组标签页
export function SettingsPage({ section }: { section: SettingsSectionId }) {
  const items = TABS[section];
  const [tab, setTab] = useState(items[0].id);
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <h1 className="mb-4 font-display text-2xl font-semibold">{SECTION_LABEL[section]}</h1>
      <Tabs label={SECTION_LABEL[section]} items={items} value={tab} onChange={setTab} />
    </div>
  );
}
