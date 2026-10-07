import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Tauri 约定：固定端口，不清屏，便于看到 Rust 侧日志
export default defineConfig(({ command }) => ({
  plugins: [react()],
  // Undefined env properties can retain a dynamic-import chunk. Give Rollup a
  // literal build-time value so ordinary bundles exclude the QA observer.
  define: command === "build" ? {
    "import.meta.env.VITE_QA_GOAL_OBSERVER": JSON.stringify(
      process.env.VITE_QA_GOAL_OBSERVER === "1" ? "1" : "0",
    ),
  } : undefined,
  clearScreen: false,
  resolve: {
    alias: {
      "@": r("./src"),
      "@brand": r("./assets/brand"),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/target/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "safari15",
    sourcemap: false,
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    css: false,
  },
}));
