import { create } from "zustand";
import { toAppError, type AppError } from "@/lib/ipc";
import { getBackend, type Backend, type BackendKind, type InitResult } from "@/platform";
import { recordQaStartup } from "@/lib/qa-startup";

export type BootPhase = "booting" | "ready" | "error";

interface AppState {
  phase: BootPhase;
  init: InitResult | null;
  backendKind: BackendKind | null;
  error: AppError | null;
  bootstrap: (backend?: Backend) => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  phase: "booting",
  init: null,
  backendKind: null,
  error: null,
  // 启动页只覆盖真实初始化（打开 SQLite、确认 Rust 侧就绪），不人为延长（BRAND.md 6-4）
  bootstrap: async (backend) => {
    if (get().phase === "ready") return;
    recordQaStartup("bootstrap_started");
    const b = backend ?? getBackend();
    recordQaStartup(b.kind === "tauri" ? "backend_tauri" : "backend_mock");
    set({ phase: "booting", error: null, backendKind: b.kind });
    try {
      const init = await b.init();
      set({ phase: "ready", init });
      recordQaStartup("frontend_ready");
    } catch (e) {
      recordQaStartup("frontend_boot_failed");
      set({ phase: "error", error: toAppError(e, "boot_failed") });
    }
  },
}));
