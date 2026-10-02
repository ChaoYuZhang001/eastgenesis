import { useAppStore } from "@/stores/app";
import { toAppError } from "@/lib/ipc";
import { createMockBackend, getBackend, setBackend } from "@/platform";

const reset = () => useAppStore.setState({ phase: "booting", init: null, backendKind: null, error: null });

describe("启动流程", () => {
  beforeEach(() => {
    reset();
    setBackend(null);
  });

  it("初始化成功后进入 ready，记录后端类型", async () => {
    await useAppStore.getState().bootstrap(createMockBackend());
    const s = useAppStore.getState();
    expect(s.phase).toBe("ready");
    expect(s.backendKind).toBe("mock");
    expect(s.init?.storage).toBe("memory");
  });

  it("失败时给出统一错误结构，重试可恢复", async () => {
    const b = createMockBackend({ failInit: 1 });
    await useAppStore.getState().bootstrap(b);
    expect(useAppStore.getState().phase).toBe("error");
    expect(useAppStore.getState().error).toEqual({ code: "db_open_failed", message: "（模拟）无法打开数据库", detail: null });

    await useAppStore.getState().bootstrap(b);
    expect(useAppStore.getState().phase).toBe("ready");
    expect(useAppStore.getState().error).toBeNull();
  });

  it("非 Tauri 环境默认走 mock 后端", async () => {
    expect(getBackend().kind).toBe("mock");
    await useAppStore.getState().bootstrap();
    expect(useAppStore.getState().init?.storage).toBe("memory");
  });
});

describe("toAppError", () => {
  it("规整 Error、字符串和 AppError", () => {
    expect(toAppError(new Error("x"))).toEqual({ code: "internal", message: "x", detail: null });
    expect(toAppError("y", "boot_failed")).toEqual({ code: "boot_failed", message: "y", detail: null });
    expect(toAppError({ code: "c", message: "m" })).toEqual({ code: "c", message: "m", detail: null });
  });
});
