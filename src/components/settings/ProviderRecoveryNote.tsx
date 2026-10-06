import { adapterRecoveryContract, type AdapterRecoveryContract } from "@/core/llm";
import type { CustomProtocol } from "@/platform";
import { Badge } from "@/components/ui/input";

type RecoveryProtocol = CustomProtocol;

const protocolText: Record<RecoveryProtocol, string> = {
  openai: "OpenAI 兼容",
  anthropic: "Anthropic Messages",
};

const terminalText: Record<AdapterRecoveryContract["streamTerminal"], string> = {
  sse_done: "SSE [DONE]",
  message_stop: "message_stop",
};

/**
 * 将自动路由真正依赖的适配器恢复契约显式展示在 Provider 设置里。
 * “可恢复”只代表 EastGenesis 能识别终止、取消、部分输出和错误；端点是否连通仍需单独测试。
 */
export function ProviderRecoveryNote({ protocol }: { protocol: RecoveryProtocol }) {
  const contract = adapterRecoveryContract(protocol === "anthropic" ? "anthropic" : "openai");
  if (!contract) return null;

  return (
    <div role="note" className="space-y-1 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>自动路由：可恢复</Badge>
        <span>{`协议：${protocolText[protocol]} · 流结束：${terminalText[contract.streamTerminal]}`}</span>
      </div>
      <p>取消可中止；错误会归一后尝试候选；已经输出正文时停止静默切换。端点连通性仍需“测试连接”。</p>
    </div>
  );
}
