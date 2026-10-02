import { act, fireEvent, render, screen } from "@testing-library/react";
import { Splash } from "@/components/Splash";

describe("启动页", () => {
  afterEach(() => vi.useRealTimers());

  it("使用深色底标志与白色字标，显示场景文案", () => {
    render(<Splash done={false} />);
    expect(screen.getByAltText("EastGenesis 标志").getAttribute("src")).toContain("mark-for-dark-bg");
    expect(screen.getByAltText("EastGenesis Desktop").getAttribute("src")).toContain("wordmark-light");
    expect(screen.getByText("从想法，到成果")).toBeInTheDocument();
    expect(screen.getByTestId("splash")).toHaveAttribute("aria-busy", "true");
  });

  it("完成后 250ms 淡出并通知隐藏", () => {
    vi.useFakeTimers();
    const onHidden = vi.fn();
    const { rerender } = render(<Splash done={false} onHidden={onHidden} />);
    rerender(<Splash done onHidden={onHidden} />);
    expect(screen.getByTestId("splash").style.opacity).toBe("0");
    act(() => vi.advanceTimersByTime(249));
    expect(onHidden).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onHidden).toHaveBeenCalledOnce();
  });

  it("出错时配图标和文字，可重试", () => {
    const onRetry = vi.fn();
    render(<Splash done={false} error={{ code: "boot_failed", message: "数据库被占用" }} onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("启动失败：数据库被占用");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
