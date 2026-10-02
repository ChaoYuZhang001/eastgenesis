// 选择后端：Tauri 窗口里走真实命令；浏览器（pnpm dev:web）和测试走内存 mock。
// 浏览器模式可用查询参数演示各种状态：?mock=fail-init、?mock=fail-requests、?mock=slow、?mock=jev（可组合，逗号分隔）。
import { isTauri } from "@/lib/ipc";
import { createMockBackend, type MockOptions } from "./mock-backend";
import { createTauriBackend } from "./tauri-backend";
import type { Backend } from "./types";

export * from "./types";
export { createMockBackend, type MockOptions } from "./mock-backend";
export { proxiedFetch, ProxyError, PROXY_PLACEHOLDER_KEY } from "./proxy-fetch";
export { BackendTransport, connectBackendServer } from "./mcp-transport";
export { DEMO_TOOLS } from "./mock-llm";

export function mockOptionsFromQuery(search: string): MockOptions {
  const flags = new Set((new URLSearchParams(search).get("mock") ?? "").split(",").map((s) => s.trim()));
  return {
    ...(flags.has("fail-init") && { failInit: 1 }),
    ...(flags.has("fail-requests") && { failRequests: true }),
    ...(flags.has("slow") && { initDelayMs: 1200 }),
    ...(flags.has("jev") && { jevConfigured: true }),
  };
}

let current: Backend | null = null;

export function getBackend(): Backend {
  if (!current) {
    const forceMock = import.meta.env.MODE === "web";
    current = isTauri() && !forceMock ? createTauriBackend() : createMockBackend(typeof location === "undefined" ? {} : mockOptionsFromQuery(location.search));
  }
  return current;
}

/** 测试用：替换或重置当前后端 */
export function setBackend(b: Backend | null): void {
  current = b;
}
