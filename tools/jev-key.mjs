// 读取 Jev Key：环境变量 TYPESAFE_API_KEY，其次是仓库根目录的 .env.local（已在 .gitignore）。调用方不得打印它。
import { readFileSync } from "node:fs";

export function loadJevKey() {
  const fromEnv = process.env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    const m = /^\s*TYPESAFE_API_KEY\s*=\s*(\S+)\s*$/m.exec(text);
    return m ? m[1].replace(/^["']|["']$/g, "") : "";
  } catch {
    return "";
  }
}

/** 返回把文本里的 Key 逐字抹掉的函数 */
export function redactor(key) {
  return (s) => (key ? String(s).split(key).join("[REDACTED]") : String(s));
}
