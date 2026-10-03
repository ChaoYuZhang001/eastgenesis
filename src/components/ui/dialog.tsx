import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

// 确认对话框：只有两个按钮，「取消」默认聚焦，Esc 等于取消（docs/UI_LAYOUT_V3.md 1.4）。
// 焦点困在对话框里；关闭后焦点回到打开前的元素。
export function ConfirmDialog({ title, body, confirm, onConfirm, onCancel, busy }: { title: string; body?: ReactNode; confirm: string; onConfirm: () => void; onCancel: () => void; busy?: boolean }) {
  const titleId = useId();
  const bodyId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => prev?.focus?.();
  }, []);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-night/60 p-4">
      <div
        ref={boxRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={body ? bodyId : undefined}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
          if (e.key === "Tab") {
            const els = boxRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled)");
            if (!els?.length) return;
            const first = els[0];
            const last = els[els.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
        className="w-full max-w-md space-y-4 rounded-lg border border-border bg-surface-2 p-6"
      >
        <h2 id={titleId} className="text-base font-medium">
          {title}
        </h2>
        {body && (
          <div id={bodyId} className="text-sm text-muted-foreground">
            {body}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button ref={cancelRef} variant="outline" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button size="sm" disabled={busy} onClick={onConfirm}>
            {confirm}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** 普通对话框：表单类（新建 / 编辑项目） */
export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const titleId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    boxRef.current?.querySelector<HTMLElement>("input, textarea, select, button")?.focus();
    return () => prev?.focus?.();
  }, []);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-night/60 p-4">
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
        className="w-full max-w-lg space-y-4 rounded-lg border border-border bg-surface-2 p-6"
      >
        <h2 id={titleId} className="text-base font-medium">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
