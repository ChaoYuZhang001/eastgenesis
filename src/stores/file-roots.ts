// 内置文件服务器允许访问的目录（docs/UI_LAYOUT_V3.md 第 10 节第 11 条）：
// 默认只有 ~/Downloads；用户选的目录由 Rust 侧校验并写进 file-roots.json，这里是它的界面状态。
// 改完必须重启内置文件服务器才生效（子进程启动参数在启动时就固定了），所以修改后会自动重启。
import { create } from "zustand";
import { toAppError } from "@/lib/ipc";
import { getBackend, type FileRoot } from "@/platform";

interface FileRootsState {
  loaded: boolean;
  items: FileRoot[];
  error: string | null;
  /** 正在保存/移除的路径，界面据此禁用按钮 */
  busy: string | null;
  load(): Promise<void>;
  add(path: string): Promise<string | null>;
  remove(path: string): Promise<string | null>;
}

/** 重启内置文件服务器：它按启动时的 --allow 参数工作，改了必须重启 */
export const BUILTIN_ID = "files";

export const useFileRoots = create<FileRootsState>((set) => {
  const run = async (f: () => Promise<FileRoot[]>): Promise<FileRoot[] | string> => {
    try {
      return await f();
    } catch (e) {
      return toAppError(e).message;
    }
  };
  return {
    loaded: false,
    items: [],
    error: null,
    busy: null,
    async load() {
      const r = await run(() => getBackend().fileRootsList());
      if (typeof r === "string") set({ loaded: true, error: r });
      else set({ loaded: true, items: r, error: null });
    },
    async add(path) {
      set({ busy: path });
      const r = await run(() => getBackend().fileRootsAdd(path));
      set({ busy: null });
      if (typeof r === "string") return r;
      set({ items: r, error: null });
      return null;
    },
    async remove(path) {
      set({ busy: path });
      const r = await run(() => getBackend().fileRootsRemove(path));
      set({ busy: null });
      if (typeof r === "string") return r;
      set({ items: r, error: null });
      return null;
    },
  };
});
