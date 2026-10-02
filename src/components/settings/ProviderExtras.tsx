import { useId } from "react";
import { officialEndpoint } from "@/core/llm/official";
import { Select } from "@/components/ui/input";
import { useSettings } from "@/stores/settings";

// Key 行里的附加设置：地域（通义千问、Kimi）和本机 Ollama 开关

export function RegionSelect({ provider }: { provider: string }) {
  const id = useId();
  const e = officialEndpoint(provider);
  const value = useSettings((s) => s.providerPrefs.regions[provider]) ?? e?.regions[0].id;
  const setRegion = useSettings((s) => s.setRegion);
  if (!e || e.regions.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={id} className="text-sm text-muted-foreground">地域</label>
      <Select id={id} value={value} onChange={(ev) => setRegion(provider, ev.target.value)} className="w-56">
        {e.regions.map((r) => (
          <option key={r.id} value={r.id}>{r.label}</option>
        ))}
      </Select>
      <p className="text-xs text-muted-foreground">Key 按地域签发，不能混用；切换地域后请换成对应地域的 Key。从下一个任务起生效。</p>
    </div>
  );
}

export function OllamaToggle() {
  const id = useId();
  const on = useSettings((s) => s.providerPrefs.ollama);
  const setOn = useSettings((s) => s.setOllamaEnabled);
  const base = officialEndpoint("ollama")?.regions[0].baseUrl;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <input id={id} type="checkbox" className="size-4 accent-east-red" checked={on} onChange={(e) => setOn(e.target.checked)} />
        <label htmlFor={id} className="text-sm">让路由使用本机 Ollama</label>
      </div>
      <p className="text-xs text-muted-foreground">
        {`连接 ${base}。本机没有运行 Ollama 时请保持关闭，否则路由可能选中它；需要其他地址或端口时，添加一个自定义 Provider。`}
      </p>
    </div>
  );
}
