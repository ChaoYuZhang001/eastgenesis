//! tools/list 的工具定义：输入参数的 JSON Schema 和行为标注（readOnlyHint / destructiveHint）。
//! 内置服务器在登记时设为采信标注：只读工具不弹确认；写入、移动、删除标为破坏性，每次都要确认。
use serde_json::{json, Value};

const PATH: &str = "绝对路径或以 ~/ 开头的路径，例如 ~/Downloads/a.pdf";

fn path_prop(desc: &str) -> Value { json!({ "type": "string", "description": desc }) }

fn tool(name: &str, desc: &str, props: Value, required: &[&str], ann: Value) -> Value {
    json!({
        "name": name,
        "description": desc,
        "inputSchema": { "type": "object", "properties": props, "required": required, "additionalProperties": false },
        "annotations": ann,
    })
}
fn read_only() -> Value { json!({ "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false }) }
fn writes(destructive: bool, idempotent: bool) -> Value {
    json!({ "readOnlyHint": false, "destructiveHint": destructive, "idempotentHint": idempotent, "openWorldHint": false })
}

pub fn tools() -> Value {
    json!([
        tool("list_directory", "列出目录内容（不递归），按修改时间从新到旧排列。可按扩展名和最近修改天数过滤；结果较多时用 offset 翻页",
            json!({
                "path": path_prop("目录，例如 ~/Downloads"),
                "extension": { "type": "string", "description": "只列这个扩展名的文件，不区分大小写，例如 pdf" },
                "modified_within_days": { "type": "integer", "minimum": 0, "description": "只列最近 N 天内修改过的条目" },
                "include_hidden": { "type": "boolean", "description": "是否包含以 . 开头的条目，默认否" },
                "offset": { "type": "integer", "minimum": 0, "description": "翻页起点，填上一次返回的 next_offset" }
            }), &["path"], read_only()),
        tool("read_file", "读取 UTF-8 文本文件，最多返回前 6000 个字符。PDF 请用 read_pdf",
            json!({ "path": path_prop(PATH) }), &["path"], read_only()),
        tool("write_file", "写入 UTF-8 文本文件（最大 1 MB）。默认不覆盖已有文件，overwrite 为 true 时覆盖。执行前需要用户确认",
            json!({ "path": path_prop(PATH), "content": { "type": "string", "description": "文件内容" },
                    "overwrite": { "type": "boolean", "description": "文件已存在时是否覆盖，默认否" } }),
            &["path", "content"], writes(true, false)),
        tool("create_directory", "创建目录（含缺少的上级目录），已存在时不报错。执行前需要用户确认",
            json!({ "path": path_prop("要创建的目录，例如 ~/Downloads/合同") }), &["path"], writes(false, true)),
        tool("move_file", "移动或重命名文件、目录。dst 是已存在的目录时移入其中；目标已存在时不覆盖。执行前需要用户确认",
            json!({ "src": path_prop("要移动的文件或目录"), "dst": path_prop("新路径，或已存在的目标目录") }),
            &["src", "dst"], writes(true, false)),
        tool("delete_file", "删除单个文件（不删除目录）。删除后无法恢复，执行前需要用户两次确认",
            json!({ "path": path_prop(PATH) }), &["path"], writes(true, false)),
        tool("get_file_info", "查看文件或目录的类型、大小和修改时间",
            json!({ "path": path_prop(PATH) }), &["path"], read_only()),
        tool("read_pdf", "读取 PDF 的标题、作者、页数和前几页文本。扫描件没有可提取的文本，加密 PDF 无法读取",
            json!({ "path": path_prop(PATH),
                    "max_pages": { "type": "integer", "minimum": 1, "maximum": 20, "description": "最多读取的页数，默认 3" },
                    "max_chars": { "type": "integer", "minimum": 1, "maximum": 6000, "description": "最多返回的字符数，默认 2000" } }),
            &["path"], read_only()),
        tool("get_pdf_metadata", "只读取 PDF 的标题、作者、主题和页数，不提取正文",
            json!({ "path": path_prop(PATH) }), &["path"], read_only()),
    ])
}
