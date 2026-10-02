// 生成杀手场景的测试夹具：tests/fixtures/downloads/ 下 8 个模拟 PDF + 1 个干扰文件，以及 downloads-manifest.json。
// 用法：node tests/fixtures/gen-downloads.mjs   （输出确定，重复运行结果逐字节一致）
// PDF 是真实可解析的：Type0 字体 + UniGB-UCS2-H 编码 + FlateDecode 内容流 + Info 标题，xref 偏移正确。
// 修改时间不进 git：测试把夹具复制到临时目录后，按 manifest 里的 days_ago 设置 mtime。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "downloads");

/** PDF 文本字符串：UTF-16BE 十六进制，带 FEFF 标记 */
const utf16Hex = (s, bom) => (bom ? "FEFF" : "") + [...s].map((c) => c.codePointAt(0).toString(16).padStart(4, "0").toUpperCase()).join("");

/** 一页的内容流：每行一个 Tj，行距 18 */
function pageContent(lines) {
  const ops = ["BT", "/F1 12 Tf", "72 760 Td"];
  lines.forEach((l, i) => ops.push(`${i ? "0 -18 Td " : ""}<${utf16Hex(l, false)}> Tj`));
  ops.push("ET");
  return Buffer.from(ops.join("\n"), "latin1");
}

function buildPdf({ title, author, pages, scanned }) {
  const objs = [];
  const add = (body) => objs.push(Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1")) && objs.length;
  const stream = (dict, data) => Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream", "latin1")]);
  const catalog = add("");
  const pagesId = add("");
  const fontId = add("<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] >>");
  add("<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>");
  const imgId = scanned ? add(stream("/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8", Buffer.from([0, 255, 255, 0]))) : 0;
  const kids = [];
  for (const lines of pages) {
    const data = scanned ? Buffer.from("q 400 0 0 500 100 150 cm /Im1 Do Q", "latin1") : deflateSync(pageContent(lines), { level: 9 });
    const contentId = add(stream(scanned ? "" : "/Filter /FlateDecode", data));
    const res = scanned ? `/XObject << /Im1 ${imgId} 0 R >>` : `/Font << /F1 ${fontId} 0 R >>`;
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << ${res} >> /Contents ${contentId} 0 R >>`));
  }
  objs[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`, "latin1");
  objs[pagesId - 1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`, "latin1");
  const info = [title ? `/Title <${utf16Hex(title, true)}>` : "", author ? `/Author <${utf16Hex(author, true)}>` : "", "/Producer (EastGenesis fixture)"].filter(Boolean).join(" ");
  const infoId = add(`<< ${info} >>`);

  const parts = [Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  const offsets = [];
  let pos = parts[0].length;
  objs.forEach((body, i) => {
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")]);
    offsets.push(pos);
    parts.push(chunk);
    pos += chunk.length;
  });
  const xref = [`xref\n0 ${objs.length + 1}\n`, "0000000000 65535 f \n", ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${infoId} 0 R >>\nstartxref\n${pos}\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}
/** expected：期望的主题；null 表示不该被处理（超过 30 天或不是 PDF） */
export const FILES = [
  { name: "Rust异步编程指南.pdf", days_ago: 2, expected: "技术", title: "Rust 异步编程指南", author: "平台组",
    pages: [["Rust 异步编程指南", "本文介绍 async/await、Future 与 Tokio 运行时的用法。", "包含接口示例和部署配置说明。"], ["第二章 并发模型", "任务调度与超时处理。"]] },
  { name: "2026Q3财务报告.pdf", days_ago: 5, expected: "财务", title: "2026 年第三季度财务报告", author: "财务部",
    pages: [["2026 年第三季度财务报告", "营业收入 1280 万元，同比增长 12%。", "净利润与现金流量表见附表。"]] },
  { name: "软件采购合同.pdf", days_ago: 8, expected: "合同", title: "软件采购合同", author: "法务部",
    pages: [["软件采购合同", "甲方：示例科技有限公司 乙方：示例软件有限公司", "双方就软件许可达成如下条款，违约责任见第八条。"]] },
  { name: "房屋租赁协议.pdf", days_ago: 12, expected: "合同", title: "", author: "",
    pages: [["房屋租赁协议", "出租方（甲方）与承租方（乙方）签订本协议。", "租期一年，押金两个月，签字后生效。"]] },
  { name: "paper_graph_routing.pdf", days_ago: 15, expected: "论文", title: "基于图神经网络的多模型路由研究", author: "张三 李四",
    pages: [["基于图神经网络的多模型路由研究", "摘要：本文提出一种路由方法，实验表明准确率提升。", "关键词：路由；图神经网络", "参考文献 [1] [2]"]] },
  { name: "差旅报销单.pdf", days_ago: 20, expected: "财务", title: "差旅报销单", author: "",
    pages: [["差旅报销单", "报销金额合计 2360 元，含发票 4 张。", "审批人签字后提交财务。"]] },
  { name: "scan_0423.pdf", days_ago: 25, expected: "其他", title: "", author: "", scanned: true, pages: [[]] },
  { name: "旧版API手册.pdf", days_ago: 45, expected: null, title: "旧版 API 手册", author: "平台组",
    pages: [["旧版 API 手册", "接口列表与错误码说明。"]] },
];
/** 干扰文件：最近修改，但不是 PDF */
export const DISTRACTOR = { name: "会议纪要.txt", days_ago: 1, text: "周会纪要：讨论下载文件夹整理方案。\n" };
export const TOPICS = ["技术", "财务", "合同", "论文", "其他"];

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(OUT, { recursive: true });
  for (const f of FILES) writeFileSync(join(OUT, f.name), buildPdf(f));
  writeFileSync(join(OUT, DISTRACTOR.name), DISTRACTOR.text);
  const manifest = {
    note: "杀手场景夹具：测试把 downloads/ 复制到临时 HOME 的 Downloads，再按 days_ago 设置修改时间。expected 为 null 的文件不应被移动",
    topics: TOPICS,
    files: [...FILES.map(({ name, days_ago, expected }) => ({ name, days_ago, expected })), { name: DISTRACTOR.name, days_ago: DISTRACTOR.days_ago, expected: null }],
  };
  writeFileSync(join(HERE, "downloads-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`已生成 ${FILES.length} 个 PDF 和 1 个干扰文件`);
}
