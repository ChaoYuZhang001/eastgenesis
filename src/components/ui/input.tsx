import * as React from "react";
import { cn } from "@/lib/utils";

// shadcn/ui 风格的输入控件；聚焦用 --eg-focus-ring（globals.css 的 :focus-visible）
export const fieldClass =
  "h-9 w-full rounded-md border border-input bg-surface-2 px-3 text-sm text-foreground placeholder:text-muted-foreground disabled:opacity-50";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(fieldClass, className)} {...props} />
));
Input.displayName = "Input";

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...props }, ref) => (
  <select ref={ref} className={cn(fieldClass, "pr-8", className)} {...props} />
));
Select.displayName = "Select";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(fieldClass, "h-auto min-h-24 py-2", className)} {...props} />
));
Textarea.displayName = "Textarea";

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn("inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border border-border px-2 text-xs text-muted-foreground [&_svg]:size-3", className)}
      {...props}
    />
  );
}
