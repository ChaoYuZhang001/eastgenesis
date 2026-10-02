import { useId, type ReactNode } from "react";
import { CircleCheck, CircleX, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// 设置页共用的小控件

export function SettingsSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-4">
      <div className="space-y-1">
        <h2 id={id} className="text-base font-medium">
          {title}
        </h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

export interface RadioOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/** 原生 radio（方向键切换由浏览器处理），外观是分段按钮；选中态靠底色 + 描边 + 字重，不只靠颜色 */
export function RadioGroup<T extends string>({ legend, value, options, onChange }: { legend: string; value: T; options: RadioOption<T>[]; onChange: (v: T) => void }) {
  const name = useId();
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const on = o.value === value;
          return (
            <label key={o.value} className="relative cursor-pointer">
              <input type="radio" name={name} value={o.value} checked={on} onChange={() => onChange(o.value)} className="peer sr-only" />
              <span
                className={cn(
                  "block rounded-md border px-3 py-2 text-sm peer-focus-visible:shadow-focus-ring",
                  on ? "border-east-red bg-accent font-medium text-foreground" : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {o.label}
                {o.hint && <span className="block text-xs font-normal text-muted-foreground">{o.hint}</span>}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** 空状态：虚线框 + 图标 + 文字 */
export function EmptyState({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
      <Icon aria-hidden className="size-4 shrink-0" />
      {children}
    </p>
  );
}

/** 操作结果：图标 + 文字（错误态不能只靠红色，BRAND.md 4.3-4）。测试连接还会带实测耗时、模型列表和服务返回的说明 */
export function ResultNote({ result }: { result: { ok: boolean; message: string; latencyMs?: number; models?: string[]; detail?: string } | null }) {
  if (!result) return <p aria-live="polite" className="sr-only" />;
  const Icon = result.ok ? CircleCheck : CircleX;
  return (
    <div role={result.ok ? "status" : "alert"} className="space-y-1 text-xs">
      <p className="flex items-center gap-2">
        <Icon aria-hidden className={cn("size-4 shrink-0", !result.ok && "text-east-red")} />
        {result.message}
        {result.latencyMs !== undefined && <span className="text-muted-foreground">· 实测 {result.latencyMs} ms</span>}
      </p>
      {result.detail && <p className="break-words pl-6 text-muted-foreground">服务返回：{result.detail}</p>}
      {result.models && result.models.length > 0 && (
        <details className="pl-6">
          <summary className="cursor-pointer text-muted-foreground">模型列表（{result.models.length}）</summary>
          <p className="mt-1 break-all font-mono text-muted-foreground">{result.models.join("、")}</p>
        </details>
      )}
    </div>
  );
}
