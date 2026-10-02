// 成果文本里不重复路由信息：路由说明只放在每条回答下方的折叠行里。
// 模型偶尔仍会自己写一段「路由记录」，这里在交给用户前把那一段去掉。

const MARK = /^\s*(?:#{1,6}\s*|[-*]\s+)?(?:\*\*|__)?\s*路由记录\s*(?:\*\*|__)?\s*(?:[:：]|$)/;
const HEADING = /^\s*#{1,6}\s/;
const BOLD_TITLE = /^\s*(?:\*\*|__)[^*_]+(?:\*\*|__)\s*[:：]?\s*$/;

/** 去掉成果里的「路由记录」段落：标题式的删到下一个标题，段落式的删到空行 */
export function stripRouteRecord(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let skip: "none" | "section" | "paragraph" = "none";
  for (const line of lines) {
    if (skip === "section" && (HEADING.test(line) || BOLD_TITLE.test(line)) && !MARK.test(line)) skip = "none";
    else if (skip === "paragraph" && line.trim() === "") {
      skip = "none";
      out.push(line);
      continue;
    }
    if (skip !== "none") continue;
    if (MARK.test(line)) {
      const titleOnly = HEADING.test(line) || /^\s*(?:\*\*|__)?\s*路由记录\s*(?:\*\*|__)?\s*[:：]?\s*$/.test(line);
      skip = titleOnly ? "section" : "paragraph";
      continue;
    }
    out.push(line);
  }
  // 删掉段落后可能留下的分隔线和多余空行
  const joined = out.join("\n").replace(/\n(?:\s*---+\s*\n)+\s*$/, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return joined || text.trim();
}
