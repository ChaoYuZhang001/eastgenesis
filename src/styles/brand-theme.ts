// 由 scripts/brand/sync_theme.mjs 从 docs/BRAND.md 生成，请勿手改。
// 只引用 var(--eg-*)，变量值见 brand-tokens.css。
export const brandTheme = {
  "colors": {
    "east-red": "rgb(var(--eg-east-red-rgb) / <alpha-value>)",
    "china-gold": "rgb(var(--eg-china-gold-rgb) / <alpha-value>)",
    "night": "var(--eg-night)",
    "surface": "var(--eg-surface)",
    "surface-2": "var(--eg-surface-2)",
    "border-dark": "var(--eg-border-dark)",
    "text-on-dark": "var(--eg-text-on-dark)",
    "text-on-dark-muted": "var(--eg-text-on-dark-muted)",
    "paper": "var(--eg-paper)",
    "ink": "var(--eg-ink)",
    "ink-muted": "var(--eg-ink-muted)",
    "selected-bg": "var(--eg-selected-bg)"
  },
  "backgroundImage": {
    "eg-icon": "var(--eg-gradient-icon)",
    "eg-gold": "var(--eg-gradient-gold)",
    "eg-sunrise": "var(--eg-gradient-sunrise)"
  },
  "fontFamily": {
    "sans": "var(--eg-font-sans)",
    "display": "var(--eg-font-display)",
    "mono": "var(--eg-font-mono)"
  },
  "borderRadius": {
    "lg": "var(--eg-radius-lg)",
    "md": "var(--eg-radius-md)",
    "sm": "var(--eg-radius-sm)"
  },
  "width": {
    "sidebar": "var(--eg-sidebar-width)",
    "panel": "var(--eg-panel-width)"
  },
  "height": {
    "input": "var(--eg-input-height)"
  },
  "boxShadow": {
    "focus-ring": "var(--eg-focus-ring)"
  },
  "maxWidth": {
    "sidebar": "var(--eg-sidebar-width)",
    "panel": "var(--eg-panel-width)"
  },
  "minWidth": {
    "sidebar": "var(--eg-sidebar-width)",
    "panel": "var(--eg-panel-width)"
  },
  "minHeight": {
    "input": "var(--eg-input-height)"
  }
} as const;
