// Windows release 下不弹控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 内置 MCP 文件服务器：应用以子进程方式自启动（--mcp-files --allow …），不创建窗口，JSON-RPC 走标准输入输出
    let mut args = std::env::args_os().skip(1);
    if args.next().is_some_and(|a| a == "--mcp-files") {
        let rest: Vec<String> = args.map(|a| a.to_string_lossy().into_owned()).collect();
        std::process::exit(eg_core::mcp_files::run_cli(rest));
    }
    eastgenesis_desktop_lib::run()
}
