// 内置文件服务器的允许目录（M10-3）：默认 ~/Downloads、用户加的目录、校验规则、移除默认项被拒。
// 浏览器模式的校验规则必须和 eg-core file_roots::validate_root 一致（Rust 侧另有 cargo 测试）。
import { createMockBackend, setBackend } from "@/platform";
import { MAX_ROOTS, validateRoot } from "@/platform/mock-mcp";
import { useFileRoots } from "@/stores/file-roots";

beforeEach(() => {
  setBackend(createMockBackend());
  useFileRoots.setState({ loaded: false, items: [], error: null, busy: null });
});

describe("允许目录：校验规则", () => {
  it("规整路径；拒绝空、相对路径、..、整个磁盘和整个家目录", () => {
    expect(validateRoot("  ~/Documents/合同  ")).toBe("~/Documents/合同");
    expect(validateRoot("~/a//b/")).toBe("~/a/b");
    expect(validateRoot("/data/项目")).toBe("/data/项目");
    for (const bad of ["", "  ", "Documents", "~/Documents/../Secrets", "/tmp/../etc", "/", "~", "/Users/apple", "/home/apple"]) {
      expect(() => validateRoot(bad), bad).toThrow();
    }
  });

  it("路径里的控制字符和超长路径都被拒绝", () => {
    expect(() => validateRoot("/tmp/a\u0007")).toThrow();
    expect(() => validateRoot(`/tmp/${"a".repeat(1200)}`)).toThrow();
  });
});

describe("允许目录：store", () => {
  it("默认只有 ~/Downloads（不可移除），加上去的目录排在后面", async () => {
    await useFileRoots.getState().load();
    expect(useFileRoots.getState().items).toEqual([{ path: "~/Downloads", fixed: true }]);
    expect(await useFileRoots.getState().add("~/Documents/合同")).toBeNull();
    expect(useFileRoots.getState().items).toEqual([
      { path: "~/Downloads", fixed: true },
      { path: "~/Documents/合同", fixed: false },
    ]);
    expect(useFileRoots.getState().error).toBeNull();
  });

  it("同一个目录加两次不会重复；不合法的路径返回说明且列表不变", async () => {
    await useFileRoots.getState().load();
    await useFileRoots.getState().add("~/Documents/合同");
    await useFileRoots.getState().add("  ~/Documents/合同 ");
    expect(useFileRoots.getState().items).toHaveLength(2);
    const err = await useFileRoots.getState().add("/");
    expect(typeof err).toBe("string");
    expect(useFileRoots.getState().items).toHaveLength(2);
  });

  it("移除用户加的目录；默认目录移除被拒；不在列表里的返回说明", async () => {
    await useFileRoots.getState().load();
    await useFileRoots.getState().add("/data/项目");
    expect(await useFileRoots.getState().remove("/data/项目")).toBeNull();
    expect(useFileRoots.getState().items).toEqual([{ path: "~/Downloads", fixed: true }]);
    expect(await useFileRoots.getState().remove("~/Downloads")).toMatch(/默认目录/);
    expect(await useFileRoots.getState().remove("/data/项目")).toMatch(/不在允许列表/);
  });

  it("数量到上限时拒绝继续添加", async () => {
    await useFileRoots.getState().load();
    for (let i = 0; i < MAX_ROOTS - 1; i++) expect(await useFileRoots.getState().add(`/data/dir-${i}`)).toBeNull();
    expect(useFileRoots.getState().items).toHaveLength(MAX_ROOTS);
    expect(await useFileRoots.getState().add("/data/one-more")).toMatch(/最多/);
  });

  it("读取失败时把说明放进 error，不抛给界面", async () => {
    const backend = createMockBackend();
    setBackend({ ...backend, fileRootsList: () => Promise.reject({ code: "config_read_failed", message: "无法读取允许访问的目录", detail: null }) });
    await useFileRoots.getState().load();
    expect(useFileRoots.getState().error).toBe("无法读取允许访问的目录");
    expect(useFileRoots.getState().items).toEqual([]);
  });
});
