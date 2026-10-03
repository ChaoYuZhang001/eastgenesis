import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

// 菜单：WAI-ARIA Menu Button 模式。上下方向键移动、Home/End 到头尾、Enter/空格选中、→ 打开子菜单、← 和 Esc 返回，
// 点外面关闭，关闭后焦点回到触发按钮。不另引 Radix，依赖保持不变（MEMORY.md 记录）。

interface MenuCtx {
  close(): void;
}
const Ctx = createContext<MenuCtx>({ close: () => {} });

const ITEM = "[role^=menuitem]:not([aria-disabled=true])";
function focusables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(`:scope > ${ITEM}, :scope > [role=group] > ${ITEM}, :scope > div > ${ITEM}`)).filter((el) => el.closest("[role=menu]") === root);
}

function onMenuKey(e: KeyboardEvent<HTMLElement>, root: HTMLElement | null, close: () => void) {
  const items = focusables(root);
  const i = items.indexOf(document.activeElement as HTMLElement);
  const go = (n: number) => {
    e.preventDefault();
    items[(n + items.length) % items.length]?.focus();
  };
  if (e.key === "ArrowDown") go(i + 1);
  else if (e.key === "ArrowUp") go(i < 0 ? items.length - 1 : i - 1);
  else if (e.key === "Home") go(0);
  else if (e.key === "End") go(items.length - 1);
  else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    close();
  } else if (e.key === "Tab") close();
}

export interface MenuProps {
  /** 触发按钮的可访问名称 */
  label: string;
  /** 触发按钮里显示的内容 */
  trigger: ReactNode;
  triggerClassName?: string;
  /** 菜单的可访问名称，默认同 label */
  menuLabel?: string;
  /** 向上弹出（输入框里的菜单）还是向下 */
  side?: "top" | "bottom";
  align?: "start" | "end";
  /** 宽度类名，如 w-64 */
  width?: string;
  title?: string;
  children: ReactNode;
}

export function Menu({ label, trigger, triggerClassName, menuLabel, side = "bottom", align = "start", width = "w-64", title, children }: MenuProps) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = useCallback(() => {
    setOpen(false);
    btn.current?.focus();
  }, []);

  useOutside(open, [btn, menu], () => setOpen(false));
  useLayoutEffect(() => {
    if (open) focusables(menu.current)[0]?.focus();
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={btn}
        type="button"
        aria-label={label}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open && (
        <div
          ref={menu}
          id={id}
          role="menu"
          aria-label={menuLabel ?? label}
          onKeyDown={(e) => onMenuKey(e, menu.current, close)}
          className={cn(
            "absolute z-40 rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground",
            width,
            side === "top" ? "bottom-full mb-2" : "top-full mt-2",
            align === "start" ? "left-0" : "right-0",
          )}
        >
          <Ctx.Provider value={{ close }}>{children}</Ctx.Provider>
        </div>
      )}
    </div>
  );
}

function useOutside(active: boolean, refs: RefObject<HTMLElement>[], onOutside: () => void) {
  useEffect(() => {
    if (!active) return;
    const h = (e: PointerEvent) => {
      if (refs.some((r) => r.current?.contains(e.target as Node))) return;
      onOutside();
    };
    document.addEventListener("pointerdown", h);
    return () => document.removeEventListener("pointerdown", h);
  }, [active, refs, onOutside]);
}

const itemClass = "flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-2 text-left outline-none hover:bg-surface focus-visible:bg-surface aria-disabled:cursor-default aria-disabled:opacity-50";

export interface MenuItemProps {
  icon?: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  /** 选中后不关菜单（勾选项默认不关） */
  keepOpen?: boolean;
  destructive?: boolean;
}

export function MenuItem({ icon, children, hint, onSelect, disabled, keepOpen, destructive }: MenuItemProps) {
  const { close } = useContext(Ctx);
  const run = () => {
    if (disabled) return;
    onSelect?.();
    if (!keepOpen) close();
  };
  return (
    <button type="button" role="menuitem" tabIndex={-1} aria-disabled={disabled || undefined} onClick={run} className={cn(itemClass, destructive && "text-foreground")}>
      {icon && <span className="grid size-4 shrink-0 place-items-center [&_svg]:size-4">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{children}</span>
        {hint && <span className="block truncate text-xs text-muted-foreground">{hint}</span>}
      </span>
    </button>
  );
}

export function MenuCheckbox({ icon, children, hint, checked, onChange, disabled }: Omit<MenuItemProps, "onSelect" | "keepOpen"> & { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      tabIndex={-1}
      aria-disabled={disabled || undefined}
      onClick={() => !disabled && onChange(!checked)}
      className={cn(itemClass, checked && "text-foreground")}
    >
      {icon && <span className="grid size-4 shrink-0 place-items-center [&_svg]:size-4">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{children}</span>
        {hint && <span className="block truncate text-xs text-muted-foreground">{hint}</span>}
      </span>
      {checked && <Check aria-hidden className="size-4 shrink-0" />}
    </button>
  );
}

export function MenuRadio({ icon, children, hint, checked, onSelect, disabled }: Omit<MenuItemProps, "keepOpen"> & { checked: boolean }) {
  const { close } = useContext(Ctx);
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      tabIndex={-1}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (disabled) return;
        onSelect?.();
        close();
      }}
      className={cn(itemClass, checked && "text-foreground")}
    >
      {icon && <span className="grid size-4 shrink-0 place-items-center [&_svg]:size-4">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{children}</span>
        {hint && <span className="block truncate text-xs text-muted-foreground">{hint}</span>}
      </span>
      {checked && <Check aria-hidden className="size-4 shrink-0" />}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <p className="px-2 pb-1 pt-2 text-xs text-muted-foreground">{children}</p>;
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-border" />;
}

/** 子菜单：→ 或点击打开，← 或 Esc 回到上级项；显示在右侧（输入框菜单向上展开，子菜单底对齐） */
export function SubMenu({ icon, label, hint, children, width = "w-64" }: { icon?: ReactNode; label: string; hint?: ReactNode; children: ReactNode; width?: string }) {
  const parent = useContext(Ctx);
  const [open, setOpen] = useState(false);
  const item = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (open) focusables(menu.current)[0]?.focus();
  }, [open]);
  const back = () => {
    setOpen(false);
    item.current?.focus();
  };
  return (
    <div className="relative">
      <button
        ref={item}
        type="button"
        role="menuitem"
        tabIndex={-1}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            setOpen(true);
          }
        }}
        className={itemClass}
      >
        {icon && <span className="grid size-4 shrink-0 place-items-center [&_svg]:size-4">{icon}</span>}
        <span className="min-w-0 flex-1">
          <span className="block truncate">{label}</span>
          {hint && <span className="block truncate text-xs text-muted-foreground">{hint}</span>}
        </span>
        <ChevronRight aria-hidden className="size-4 shrink-0" />
      </button>
      {open && (
        <div
          ref={menu}
          id={id}
          role="menu"
          aria-label={label}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              back();
              return;
            }
            onMenuKey(e, menu.current, parent.close);
          }}
          className={cn("absolute bottom-0 left-full z-50 ml-1 rounded-md border border-border bg-popover p-1 text-sm", width)}
        >
          <Ctx.Provider value={parent}>{children}</Ctx.Provider>
        </div>
      )}
    </div>
  );
}
