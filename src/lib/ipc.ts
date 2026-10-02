// IPC 约定：命令名 snake_case，参数与返回值为 JSON，错误统一为 { code, message, detail }。
// 与 crates/eg-core/src/error.rs 中的 AppError 保持一致。

export interface AppError {
  code: string;
  message: string;
  detail?: string | null;
}

export interface AppInfo {
  name: string;
  version: string;
  db_path_hint: string;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function isAppError(e: unknown): e is AppError {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as AppError).code === "string" &&
    typeof (e as AppError).message === "string"
  );
}

/** 把任意异常规整为 AppError，保证 UI 永远拿到同一种结构 */
export function toAppError(e: unknown, fallbackCode = "internal"): AppError {
  if (isAppError(e)) return { code: e.code, message: e.message, detail: e.detail ?? null };
  if (e instanceof Error) return { code: fallbackCode, message: e.message, detail: null };
  return { code: fallbackCode, message: String(e), detail: null };
}

export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw toAppError({ code: "not_in_tauri", message: `命令 ${cmd} 需要在桌面应用中运行` });
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toAppError(e);
  }
}

export const commands = {
  getAppInfo: () => call<AppInfo>("get_app_info"),
};
