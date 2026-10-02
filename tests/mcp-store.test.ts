import { createMockBackend, setBackend, type Backend } from "@/platform";
import { activeMcpTools, useMcp } from "@/stores/mcp";
import { useSettings } from "@/stores/settings";
import { useTasks } from "@/stores/tasks";

// MCP 连接 store：浏览器模式的内存登记表（echo 只放行 echo；notes 放行全部、不信任标注、需要钥匙串密钥）
let b: Backend;
beforeEach(() => {
  b = createMockBackend();
  setBackend(b);
  useMcp.setState({ registry: null, loadError: null, conns: {} });
});

const conn = (id: string) => useMcp.getState().conns[id];

describe("MCP 连接", () => {
  it("启动后只注册白名单内的工具，信任标注时只读工具不需要确认；停止后工具移除", async () => {
    await useMcp.getState().refresh();
    expect(useMcp.getState().registry?.servers.map((s) => s.id)).toEqual(["echo", "notes"]);
    await useMcp.getState().start("echo");
    expect(conn("echo").status).toBe("running");
    expect(conn("echo").tools.map((t) => [t.name, t.sideEffect])).toEqual([["mcp__echo__echo", "none"]]);
    expect(conn("echo").skipped).toEqual([{ name: "shout", reason: "不在白名单" }]);
    expect(conn("echo").serverInfo).toBe("mock-echo 0.0.0");
    const out = await activeMcpTools()[0].run({ text: "hi" }, { signal: new AbortController().signal });
    expect(out).toMatchObject({ ok: true, content: "hi" });
    expect(useMcp.getState().registry?.servers[0].running).toBe(true);
    await useMcp.getState().stop("echo");
    expect(conn("echo")).toBeUndefined();
    expect(activeMcpTools()).toEqual([]);
    expect(useMcp.getState().registry?.servers[0].running).toBe(false);
  });

  it("缺少钥匙串密钥时启动失败并说明原因；保存后可启动，不信任标注的工具都要确认", async () => {
    await useMcp.getState().start("notes");
    expect(conn("notes")).toMatchObject({ status: "failed", error: "钥匙串里还没有 NOTES_TOKEN，请先在设置页保存" });
    expect(await useMcp.getState().setSecret("notes", "NOTES_TOKEN", "value-1")).toBeNull();
    expect(useMcp.getState().registry?.servers[1].refs[0].configured).toBe(true);
    await useMcp.getState().start("notes");
    expect(conn("notes").tools.map((t) => [t.name, t.sideEffect])).toEqual([
      ["mcp__notes__list_notes", "external"],
      ["mcp__notes__wipe_notes", "destructive"],
    ]);
    expect(await useMcp.getState().setSecret("notes", "OTHER", "value-1")).toBe("mcp.json 里这个服务器没有引用这个钥匙串条目");
    await useMcp.getState().stop("notes");
  });

  it("界面重新加载后留下的进程：先停掉再重新连接", async () => {
    await b.mcpStart("echo"); // 模拟上次会话留下、没有连接的进程
    await useMcp.getState().refresh();
    expect(useMcp.getState().registry?.servers[0].running).toBe(true);
    await useMcp.getState().start("echo");
    expect(conn("echo").status).toBe("running");
    expect(activeMcpTools().map((t) => t.name)).toEqual(["mcp__echo__echo"]);
    await useMcp.getState().stop("echo");
  });

  it("已连接服务器的白名单工具进入任务的规划提示", async () => {
    const bodies: string[] = [];
    setBackend({ ...b, providerRequest: (r) => (bodies.push(r.body ?? ""), b.providerRequest(r)) });
    await useSettings.getState().load();
    await useMcp.getState().start("echo");
    const id = useTasks.getState().submit("调研量子纠缠的研究进展")!;
    await vi.waitFor(() => expect(useTasks.getState().tasks.find((t) => t.id === id)?.status).toBe("completed"));
    expect(bodies.some((x) => x.includes("mcp__echo__echo"))).toBe(true);
    expect(bodies.some((x) => x.includes("shout"))).toBe(false);
    await useMcp.getState().stop("echo");
  });

  it("服务器意外退出：标为出错，工具不再提供给任务", async () => {
    await useMcp.getState().start("echo");
    await b.mcpStop("echo"); // 绕过 store 直接停进程，模拟崩溃
    await vi.waitFor(() => expect(conn("echo").status).toBe("failed"));
    expect(conn("echo").error).toContain("MCP 服务器已退出");
    expect(activeMcpTools()).toEqual([]);
  });
});
