/// <reference types="vite/client" />

declare module "*/sync_theme.mjs" {
  export function extractTokens(markdown: string): { name: string; value: string }[];
  export function renderCss(tokens: { name: string; value: string }[]): string;
  export function renderTheme(tokens: { name: string; value: string }[]): string;
  export function buildTheme(tokens: { name: string; value: string }[]): Record<string, Record<string, string>>;
}
