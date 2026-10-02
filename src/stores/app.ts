import { create } from "zustand";
import { toAppError, type AppError } from "@/lib/ipc";
import { getBackend, type Backend, type BackendKind, type InitResult } from "@/platform";

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
    const b = backend ?? getBackend();
    set({ phase: "booting", error: null, backendKind: b.kind });
    try {
      const init = await b.init();
      set({ phase: "ready", init });
    } catch (e) {
      set({ phase: "error", error: toAppError(e, "boot_failed") });
    }
  },
}));
