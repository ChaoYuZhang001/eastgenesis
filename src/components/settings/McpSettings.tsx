import { useEffect } from "react";
import { CircleAlert, FileJson, RefreshCw, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMcp } from "@/stores/mcp";
import { EmptyState, ResultNote, SettingsSection } from "./controls";
import { McpServerCard } from "./McpServerCard";

/** mcp.json 示例：命令写绝对路径；密钥写成引用，不写明文 */
const EXAMPLE = JSON.stringify(
  {
    mcpServers: {
      fs: {
        command: "/opt/homebrew/bin/npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/<用户名>/Documents"],
        env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin" },
        allowTools: ["list_directory", "read_text_file"],
      },
      search: {
        command: "/usr/local/bin/my-search-mcp",
        env: { SEARCH_API_KEY: "${keychain:SEARCH_API_KEY}" },
        allowTools: "*",
        trustAnnotations: false,
      },
    },
  },
  null,
  2,
);

// MCP 服务器：登记表只读展示，界面只能启停、保存引用的密钥，不能添加或修改服务器
export function McpSettings() {
  const registry = useMcp((s) => s.registry);
  const loadError = useMcp((s) => s.loadError);
  const refresh = useMcp((s) => s.refresh);
  useEffect(() => void refresh(), [refresh]);

  return (
    <SettingsSection
      title="MCP 服务器"
      description="服务器登记在 mcp.json 里，只能由你自己编辑，这里只能查看和启停。只有 allowTools 白名单里的工具会注册给智能体，有副作用的工具执行前需要确认。"
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <p className="flex min-w-0 items-center gap-2 text-sm">
            <FileJson aria-hidden className="size-4 shrink-0" />
            <span className="break-all font-mono text-xs">{registry?.path_hint ?? "读取中…"}</span>
          </p>
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
            <RefreshCw aria-hidden />
            重新读取
          </Button>
        </div>
        {loadError && <ResultNote result={{ ok: false, message: loadError }} />}
        {registry && registry.servers.length === 0 && registry.errors.length === 0 && (
          <EmptyState icon={Server}>还没有登记的 MCP 服务器。按下面的示例编辑 mcp.json，保存后点「重新读取」。</EmptyState>
        )}
        {registry && registry.servers.length > 0 && (
          <ul aria-label="已登记的 MCP 服务器" className="space-y-3">
            {registry.servers.map((s) => (
              <McpServerCard key={s.id} server={s} />
            ))}
          </ul>
        )}
        {registry && registry.errors.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm">没能登记的条目：</p>
            <ul aria-label="没能登记的条目" className="space-y-1">
              {registry.errors.map((e, i) => (
                <li key={`${i}:${e.id}`} className="flex items-start gap-2 break-all text-xs">
                  <CircleAlert aria-hidden className="size-4 shrink-0 text-east-red" />
                  <span className="font-mono">{e.id}</span>
                  <span>{e.message}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">mcp.json 示例与写法</summary>
          <div className="mt-2 space-y-2 text-xs text-muted-foreground">
            <p>command 写绝对路径：从程序坞打开的应用不继承终端的 PATH。npx、uvx 这类启动器还要在 env 里给出 PATH，才能找到 node、uv。</p>
            <p>密钥写成 {"${keychain:NAME}"}（保存在系统钥匙串，在这里填写）或 {"${env:NAME}"}，明文密钥会被拒绝。模型 Provider 和 Jev 的 Key 不会提供给 MCP 服务器。</p>
            <p>allowTools 不写时一个工具都不注册；启动后这里会列出服务器实际提供的工具名，方便对照填写。</p>
            <pre className="overflow-auto rounded-md bg-surface-2 p-3 font-mono text-foreground">{EXAMPLE}</pre>
          </div>
        </details>
      </div>
    </SettingsSection>
  );
}
