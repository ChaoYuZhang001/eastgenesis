// 设置 › MCP 服务器 › 内置文件服务器的允许目录（M10-3）：
// 默认目录不能移除、加入了要重启内置服务器、界面上的说明和错误提示。
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { McpServerCard } from "@/components/settings/McpServerCard";
import { useFileRoots } from "@/stores/file-roots";
import { useMcp } from "@/stores/mcp";
import { LONG, resetStores } from "./ui-helpers";
import type { McpServerView } from "@/platform";

const BUILTIN: McpServerView = {
  id: "files",
  command: "EastGenesis",
  args: ["--mcp-files", "--allow", "~/Downloads"],
  env: {},
  cwd: null,
  allow_tools: ["list_directory", "read_file"],
  trust_annotations: true,
  refs: [],
  running: false,
  stderr_tail: null,
  builtin: true,
};

beforeEach(() => resetStores());

describe("允许目录：设置页", () => {
  it("内置服务器卡片列出允许目录：默认项标「默认」且没有移除按钮", async () => {
    // 允许目录是渲染后异步读回来的：包在 act 里，用例结束前不再有状态更新
    await act(async () => {
      render(<McpServerCard server={BUILTIN} />);
    });
    const list = await screen.findByRole("list", { name: "允许访问的目录" }, LONG);
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("~/Downloads");
    expect(rows[0]).toHaveTextContent("默认");
    expect(within(rows[0]).queryByRole("button", { name: /移除/ })).not.toBeInTheDocument();
  });

  it("加入一个目录后出现在列表里，并重启内置文件服务器（启动参数变了）", async () => {
    const backend = resetStores();
    const started: string[] = [];
    const origStart = backend.mcpStart.bind(backend);
    backend.mcpStart = async (id) => {
      started.push(id);
      return origStart(id);
    };
    useMcp.setState({ registry: { path_hint: "~/mcp.json", servers: [BUILTIN], errors: [] } });

    // 允许目录是渲染后异步读回来的：包在 act 里，用例结束前不再有状态更新
    await act(async () => {
      render(<McpServerCard server={BUILTIN} />);
    });
    fireEvent.change(await screen.findByLabelText("要加入允许列表的文件夹", {}, LONG), { target: { value: "~/Documents/合同" } });
    fireEvent.click(screen.getByRole("button", { name: "加入" }));

    const list = await screen.findByRole("list", { name: "允许访问的目录" }, LONG);
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(2), LONG);
    expect(within(list).getByText("~/Documents/合同")).toBeInTheDocument();
    // 改完要重启：否则子进程还用着旧的 --allow
    await waitFor(() => expect(started).toEqual(["files"]), LONG);
  });

  it("不合法的路径显示错误，列表不变；移除用户加的目录后又重启一次", async () => {
    const backend = resetStores();
    const started: string[] = [];
    const origStart = backend.mcpStart.bind(backend);
    backend.mcpStart = async (id) => {
      started.push(id);
      return origStart(id);
    };
    useMcp.setState({ registry: { path_hint: "~/mcp.json", servers: [BUILTIN], errors: [] } });
    await useFileRoots.getState().load();
    await useFileRoots.getState().add("/data/项目");

    // 允许目录是渲染后异步读回来的：包在 act 里，用例结束前不再有状态更新
    await act(async () => {
      render(<McpServerCard server={BUILTIN} />);
    });
    const list = await screen.findByRole("list", { name: "允许访问的目录" }, LONG);
    fireEvent.change(screen.getByLabelText("要加入允许列表的文件夹"), { target: { value: "~/Documents/../Secrets" } });
    fireEvent.click(screen.getByRole("button", { name: "加入" }));
    const alert = await screen.findByRole("alert", {}, LONG);
    expect(alert).toHaveTextContent("..");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);

    fireEvent.click(within(list).getByRole("button", { name: "移除 /data/项目" }));
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(1), LONG);
    await waitFor(() => expect(started).toEqual(["files"]), LONG);
  });

  it("默认目录没有移除按钮（不能把自己关在门外）", async () => {
    resetStores();
    // 允许目录是渲染后异步读回来的：包在 act 里，用例结束前不再有状态更新
    await act(async () => {
      render(<McpServerCard server={BUILTIN} />);
    });
    const list = await screen.findByRole("list", { name: "允许访问的目录" }, LONG);
    expect(within(list).queryByRole("button", { name: "移除 ~/Downloads" })).not.toBeInTheDocument();
    // 直接调后端也会被拒（Rust 侧同一条规则）
    let err: string | null = null;
    await act(async () => {
      err = await useFileRoots.getState().remove("~/Downloads");
    });
    expect(err).toMatch(/默认目录/);
  });
});
