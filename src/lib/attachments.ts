// 输入框附带的文件：只支持纯文本类文件，在前端读成文本后作为参考资料交给模型（不可信数据）。
// 不读二进制（图片、PDF 等）：当前适配器没有走多模态通道，读了也只是乱码。
import type { Attachment } from "@/decision";

export const MAX_FILE_BYTES = 100 * 1024;
export const MAX_FILES = 3;

/** 允许的扩展名：常见纯文本与代码 */
export const TEXT_EXTS = [
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "conf", "log", "xml", "html", "css",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "rb", "php",
  "sh", "bash", "zsh", "sql", "graphql", "vue", "svelte",
] as const;
const CODE_EXTS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "rb", "php", "sh", "bash", "zsh", "sql", "graphql", "vue", "svelte", "json", "yaml", "yml", "toml"]);

export const ACCEPT = TEXT_EXTS.map((e) => `.${e}`).join(",");

export interface AttachedFile {
  name: string;
  text: string;
  bytes: number;
}

export const fileExt = (name: string) => name.toLowerCase().split(".").pop() ?? "";

/** 给路由分类用的附件描述（影响任务类型和上下文窗口过滤） */
export function toAttachments(files: readonly AttachedFile[]): Attachment[] {
  return files.map((f) => ({ kind: CODE_EXTS.has(fileExt(f.name)) ? "code" : "text", name: f.name, chars: f.text.length }));
}

/** 读文件：不认识的扩展名、太大或看着是二进制都拒绝，返回原因 */
export async function readTextFile(file: File): Promise<AttachedFile | string> {
  if (!(TEXT_EXTS as readonly string[]).includes(fileExt(file.name))) return `只支持纯文本文件：${file.name} 的类型不在支持范围内`;
  if (file.size > MAX_FILE_BYTES) return `${file.name} 超过 ${Math.floor(MAX_FILE_BYTES / 1024)} KB，请先截取需要的部分`;
  let text: string;
  try {
    text = await file.text();
  } catch {
    return `读取 ${file.name} 失败`;
  }
  // \u0000 或替换字符说明不是文本
  if (/[\u0000�]/.test(text)) return `${file.name} 看起来不是纯文本文件`;
  if (!text.trim()) return `${file.name} 是空文件`;
  return { name: file.name, text, bytes: file.size };
}
