//! 内置 MCP 文件服务器的独立程序：eg-mcp-files --allow <目录> [--allow <目录> …]，JSON-RPC 走标准输入输出
fn main() {
    std::process::exit(eg_core::mcp_files::run_cli(std::env::args().skip(1).collect()));
}
