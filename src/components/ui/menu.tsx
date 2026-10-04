import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

// 菜单：WAI-ARIA Menu Button 模式。上下方向键移动、Home/End 到头尾、Enter/空格选中、→ 打开子菜单、← 和 Esc 返回，
// 点外面关闭，关闭后焦点回到触发按钮。不另引 Radix，依赖保持不变（MEMORY.md 记录）。

interface MenuCtx {
  close(): void;
}

const MARGIN = 8;
const GAP = 4;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));

/**
 * 弹出层用 fixed 定位在视口里：放在滚动容器里的菜单用 absolute 会被容器的 overflow 裁掉（输入框、内容栏都在滚动容器里）。
 * 放不下就翻面（上 ↔ 下、右 ↔ 左），最后夹在视口内。
 */
export function placePopup(anchor: DOMRect, pop: DOMRect, side: "top" | "bottom" | "right", align: "start" | "end"): { left: number; top: number; flipped: boolean } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let flipped = false;
  let left: number;
  let top: number;
  if (side === "right") {
    left = anchor.right + GAP;
    if (left + pop.width > vw - MARGIN) {
      if (anchor.left - GAP - pop.width >= MARGIN) {
        left = anchor.left - GAP - pop.width;
        flipped = true;
      } else left = vw - MARGIN - pop.width;
    }
    top = clamp(anchor.top, MARGIN, vh - MARGIN - pop.height);
  } else {
    left = clamp(align === "start" ? anchor.left : anchor.right - pop.width, MARGIN, vw - MARGIN - pop.width);
    const above = anchor.top - GAP - pop.height;
    const below = anchor.bottom + GAP;
    if (side === "top") {
      top = above;
      if (above < MARGIN && below + pop.height <= vh - MARGIN) {
        top = below;
        flipped = true;
      }
    } else {
      top = below;
      if (below + pop.height > vh - MARGIN && above >= MARGIN) {
        top = above;
        flipped = true;
      }
    }
    top = clamp(top, MARGIN, vh - MARGIN - pop.height);
  }
  return { left: Math.max(MARGIN, left), top, flipped };
}

/** 打开期间窗口尺寸变了、页面滚动了，位置就不准了：直接关掉（菜单自己内部的滚动不算） */
function useCloseOnMove(open: boolean, inside: RefObject<HTMLElement>, onMove: () => void) {
  useEffect(() => {
    if (!open) return;
    const scroll = (e: Event) => {
      if (e.target instanceof Node && inside.current?.contains(e.target)) return;
      onMove();
    };
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", scroll, true);
    return () => {
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open, inside, onMove]);
}

type Pos = { left: number; top: number; flipped: boolean } | null;
const popupStyle = (pos: Pos) => ({ position: "fixed" as const, left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? ("visible" as const) : ("hidden" as const), maxHeight: `calc(100vh - ${MARGIN * 2}px)` });
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
  const [pos, setPos] = useState<Pos>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = useCallback(() => {
    setOpen(false);
    btn.current?.focus();
  }, []);
  const dismiss = useCallback(() => setOpen(false), []);

  useOutside(open, [btn, menu], dismiss);
  useCloseOnMove(open, menu, dismiss);
  // 先按隐藏状态渲染、量好尺寸再放到位（在绘制之前），用户看不到跳动
  useLayoutEffect(() => {
    if (!open || !btn.current || !menu.current) return setPos(null);
    setPos(placePopup(btn.current.getBoundingClientRect(), menu.current.getBoundingClientRect(), side, align));
  }, [open, side, align]);
  // 隐藏的元素拿不到焦点：放到位以后再聚焦第一项
  useEffect(() => {
    if (open && pos) focusables(menu.current)[0]?.focus();
  }, [open, pos]);

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
          data-side={pos?.flipped ? (side === "top" ? "bottom" : "top") : side}
          style={popupStyle(pos)}
          className={cn("z-40 overflow-y-auto rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground", width)}
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
  // 放不下就翻到左边：菜单靠窗口右边时（例如输入框右下角的路由下拉），向右展开会超出窗口
  const [pos, setPos] = useState<Pos>(null);
  const item = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (!open || !item.current || !menu.current) return setPos(null);
    setPos(placePopup(item.current.getBoundingClientRect(), menu.current.getBoundingClientRect(), "right", "start"));
  }, [open]);
  useEffect(() => {
    if (open && pos) focusables(menu.current)[0]?.focus();
  }, [open, pos]);
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
          data-side={pos?.flipped ? "left" : "right"}
          style={popupStyle(pos)}
          className={cn("z-50 overflow-y-auto rounded-md border border-border bg-popover p-1 text-sm", width)}
        >
          <Ctx.Provider value={parent}>{children}</Ctx.Provider>
        </div>
      )}
    </div>
  );
}
