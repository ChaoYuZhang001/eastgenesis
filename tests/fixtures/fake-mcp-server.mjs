// 测试用的最小 MCP 服务器（stdio，按行分隔的 JSON-RPC）。
import { createInterface } from "node:readline";

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id === undefined) return; // 通知
  const ok = (result) => send({ jsonrpc: "2.0", id: m.id, result });
  if (m.method === "initialize") {
    ok({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1.0.0" } });
  } else if (m.method === "tools/list") {
    ok({
      tools: [
        { name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: true } },
        { name: "env_probe", description: "Report environment" },
      ],
    });
  } else if (m.method === "tools/call") {
    const { name, arguments: a } = m.params ?? {};
    if (name === "echo") ok({ content: [{ type: "text", text: String(a?.text ?? "") }] });
    else if (name === "env_probe") ok({ content: [{ type: "text", text: JSON.stringify({ hasOpenAI: "OPENAI_API_KEY" in process.env, flag: process.env.FAKE_FLAG ?? null }) }] });
    else send({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: `unknown tool ${name}` } });
  } else {
    send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } });
  }
});
