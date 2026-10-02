//! PDF 解析单元测试：手写最小 PDF，覆盖过滤器、字体编码、文档结构、页面树和文本布局
use super::cmap::CMap;
use super::doc::Doc;
use super::filter;
use super::lexer::{Dict, Lexer, Obj};
use super::*;
use miniz_oxide::deflate::{compress_to_vec, compress_to_vec_zlib};

const CATALOG: &[u8] = b"<< /Type /Catalog /Pages 2 0 R >>";
const HELV: &[u8] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
const HELLO: &[u8] = b"BT /F1 12 Tf 72 720 Td (Hello World) Tj ET";
const TRAILER: Option<&str> = Some("<< /Root 1 0 R /Info 7 0 R >>");

/// 拼一个 PDF：对象按顺序写出；trailer 为 None 时不写
fn pdf(objs: &[(u32, Vec<u8>)], trailer: Option<&str>) -> Vec<u8> {
    let mut out = b"%PDF-1.7\n".to_vec();
    for (n, body) in objs {
        out.extend_from_slice(format!("{n} 0 obj\n").as_bytes());
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    }
    if let Some(t) = trailer { out.extend_from_slice(format!("trailer\n{t}\n").as_bytes()); }
    out.extend_from_slice(b"%%EOF\n");
    out
}
fn stream_dict(dict: &str, data: &[u8]) -> Vec<u8> {
    let mut out = format!("{dict}\nstream\n").into_bytes();
    out.extend_from_slice(data);
    out.extend_from_slice(b"\nendstream");
    out
}
fn stream(extra: &str, data: &[u8]) -> Vec<u8> { stream_dict(&format!("<< /Length {} {extra} >>", data.len()), data) }
fn hex(b: &[u8]) -> Vec<u8> { b.iter().flat_map(|x| format!("{x:02X}").into_bytes()).collect() }
/// 测试用 ASCII85 编码（不用 z 缩写），以 ~> 结尾
fn a85(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    for chunk in data.chunks(4) {
        let mut buf = [0u8; 4];
        buf[..chunk.len()].copy_from_slice(chunk);
        let mut v = u32::from_be_bytes(buf);
        let mut d = [0u8; 5];
        for x in d.iter_mut().rev() { *x = (v % 85) as u8 + b'!'; v /= 85; }
        out.extend_from_slice(&d[..chunk.len() + 1]);
    }
    out.extend_from_slice(b"~>");
    out
}
/// 1 目录、2 页面树、3 页面（字体 F1=5、表单 X1=8）、4 内容、5 字体
fn page_objs(content: Vec<u8>, font: &[u8]) -> Vec<(u32, Vec<u8>)> {
    vec![
        (1, CATALOG.to_vec()),
        (2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec()),
        (3, b"<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /X1 8 0 R >> >> /Contents 4 0 R >>".to_vec()),
        (4, content),
        (5, font.to_vec()),
    ]
}
fn one_page(content: Vec<u8>, font: &[u8], more: Vec<(u32, Vec<u8>)>) -> Vec<u8> {
    let mut o = page_objs(content, font);
    o.extend(more);
    pdf(&o, TRAILER)
}
fn ok(r: AppResult<PdfInfo>) -> PdfInfo { match r { Ok(v) => v, Err(e) => panic!("解析失败：{} {}", e.code, e.message) } }
fn err(r: AppResult<PdfInfo>) -> String { match r { Ok(_) => panic!("应当失败"), Err(e) => e.code } }
fn text_of(b: &[u8]) -> String { ok(parse(b, 3, 2000)).text }

#[test]
fn plain_and_compressed_content() {
    assert_eq!(text_of(&one_page(stream("", HELLO), HELV, vec![])), "Hello World");
    let z = compress_to_vec_zlib(HELLO, 6);
    assert_eq!(text_of(&one_page(stream("/Filter /FlateDecode", &z), HELV, vec![])), "Hello World");
    // 没有 zlib 头的原始 deflate 也能解
    let raw = compress_to_vec(HELLO, 6);
    assert_eq!(text_of(&one_page(stream("/Filter /FlateDecode", &raw), HELV, vec![])), "Hello World");
}

#[test]
fn ascii_filters_and_chains() {
    let mut h = hex(HELLO);
    h.push(b'>');
    assert_eq!(text_of(&one_page(stream("/Filter /AHx", &h), HELV, vec![])), "Hello World");
    let mut hz = hex(&compress_to_vec_zlib(HELLO, 6));
    hz.push(b'>');
    assert_eq!(text_of(&one_page(stream("/Filter [/AHx /Fl]", &hz), HELV, vec![])), "Hello World");
    assert_eq!(text_of(&one_page(stream("/Filter /A85", &a85(HELLO)), HELV, vec![])), "Hello World");
    // 图像类过滤器不解，页面没有文本但不报错
    assert_eq!(text_of(&one_page(stream("/Filter /DCTDecode", HELLO), HELV, vec![])), "");
}

#[test]
fn filter_units() {
    assert_eq!(filter::decode(&Dict::new(), b"x", 0), None);
    assert_eq!(filter::decode(&Dict::new(), b"abc", 2), Some(b"ab".to_vec()));
    assert_eq!(filter::ascii85(b"<~9jqo^~>"), b"Man ".to_vec());
    assert_eq!(filter::ascii85(b"\n<~9jqo^~>"), b"Man ".to_vec());
    assert_eq!(filter::ascii85(b"9jqo~>"), b"Man".to_vec());
    assert_eq!(filter::ascii85(b"z~>"), vec![0u8; 4]);
    assert_eq!(filter::ascii85(&a85(b"Hello, PDF!")), b"Hello, PDF!".to_vec());
    assert_eq!(filter::ascii_hex(b"48 65 6C6C6F>junk"), b"Hello".to_vec());
}
#[test]
fn flate_limits_and_truncation() {
    let big = vec![b'a'; 1000];
    let z = compress_to_vec_zlib(&big, 6);
    assert_eq!(filter::flate(&z, 10), vec![b'a'; 10]);
    assert_eq!(filter::flate(&z, 1 << 20), big);
    // 数据被截断（缺 adler32 和尾部）：接受已解出的前缀
    let text = b"The quick brown fox jumps over the lazy dog. ".repeat(20);
    let z = compress_to_vec_zlib(&text, 6);
    let part = filter::flate(&z[..z.len() - 6], 1 << 20);
    assert!(!part.is_empty() && text.starts_with(&part));
    assert!(filter::flate(b"", 100).is_empty());
}

#[test]
fn cmap_ranges() {
    let cm = CMap::parse(b"1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfrange <0003> <0005> <0041> endbfrange");
    let mut s = String::new();
    cm.decode(&[0, 3, 0, 4, 0, 5], 2, &mut s);
    assert_eq!(s, "ABC");
    // 没有 codespacerange 时按映射键推断码长；查不到的码跳过
    let cm = CMap::parse(b"1 beginbfrange <0001> <0002> [<0058> <0059>] endbfrange");
    let mut s = String::new();
    cm.decode(&[0, 1, 0, 2, 0, 9], 2, &mut s);
    assert_eq!(s, "XY");
    assert!(CMap::parse(b"garbage").is_empty());
}

const CN_CMAP: &[u8] = b"1 begincodespacerange <0000> <FFFF> endcodespacerange 4 beginbfchar <0001> <5408> <0002> <540C> <0003> <7F16> <0004> <53F7> endbfchar";

#[test]
fn type0_fonts() {
    let font = b"<< /Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /Identity-H /ToUnicode 6 0 R >>";
    let b = one_page(stream("", b"BT /F1 12 Tf <0001000200030004> Tj ET"), font, vec![(6, stream("", CN_CMAP))]);
    assert_eq!(text_of(&b), "合同编号");
    let ucs = b"<< /Type /Font /Subtype /Type0 /BaseFont /STSong /Encoding /UniGB-UCS2-H >>";
    assert_eq!(text_of(&one_page(stream("", b"BT /F1 12 Tf <5408540C> Tj ET"), ucs, vec![])), "合同");
    // 没有 ToUnicode 的 Identity-H 无法还原文本：不输出乱码
    let opaque = b"<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H >>";
    assert_eq!(text_of(&one_page(stream("", b"BT /F1 12 Tf <00010002> Tj ET"), opaque, vec![])), "");
}

#[test]
fn differences_and_info() {
    let font = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /Differences [65 /B /C 200 /uni5408] >> >>";
    let info = (7, b"<< /Title <FEFF5408540C> /Author (Alice) >>".to_vec());
    let i = ok(parse(&one_page(stream("", b"BT /F1 12 Tf (ABx\\310) Tj ET"), font, vec![info]), 3, 2000));
    assert_eq!(i.text, "BCx合");
    assert_eq!((i.title.as_deref(), i.author.as_deref(), i.subject.as_deref()), (Some("合同"), Some("Alice"), None));
    assert_eq!((i.pages, i.pages_read, i.truncated), (1, 1, false));
}
#[test]
fn invalid_and_encrypted() {
    assert_eq!(err(parse(b"hello", 3, 100)), "pdf_invalid");
    assert_eq!(err(parse(b"%PDF-1.7\n", 3, 100)), "pdf_invalid");
    let enc = pdf(&page_objs(stream("", HELLO), HELV), Some("<< /Root 1 0 R /Encrypt 9 0 R >>"));
    assert_eq!(err(parse(&enc, 3, 100)), "pdf_encrypted");
    assert_eq!(err(metadata(&enc)), "pdf_encrypted");
}

#[test]
fn object_streams() {
    let page: &[u8] = b"<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>";
    let header = format!("3 0 5 {} ", page.len() + 1);
    let parts: [&[u8]; 4] = [header.as_bytes(), page, b" ", HELV];
    let data = parts.concat();
    let objs = vec![
        (1, CATALOG.to_vec()),
        (2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec()),
        (4, stream("", HELLO)),
        (10, stream(&format!("/Type /ObjStm /N 2 /First {}", header.len()), &data)),
    ];
    assert_eq!(text_of(&pdf(&objs, Some("<< /Root 1 0 R >>"))), "Hello World");
}

#[test]
fn xref_stream_trailer_and_catalog_fallback() {
    let mut objs = page_objs(stream("", HELLO), HELV);
    objs.push((7, b"<< /Title (XRef Doc) >>".to_vec()));
    objs.push((9, stream("/Type /XRef /Root 1 0 R /Info 7 0 R /Size 10", b"\x00\x01")));
    let i = ok(parse(&pdf(&objs, None), 3, 2000));
    assert_eq!((i.title.as_deref(), i.text.as_str()), (Some("XRef Doc"), "Hello World"));
    // 没有任何 trailer：按 /Type /Catalog 找目录
    let i = ok(parse(&pdf(&page_objs(stream("", HELLO), HELV), None), 3, 2000));
    assert_eq!((i.title, i.text.as_str(), i.pages), (None, "Hello World", 1));
}
#[test]
fn bad_length_redefinition_and_fake_headers() {
    // /Length 越界、间接引用或为负：改为搜索 endstream
    for len in ["9999", "9 0 R", "-1"] {
        let content = stream_dict(&format!("<< /Length {len} >>"), HELLO);
        assert_eq!(text_of(&one_page(content, HELV, vec![(9, b"3".to_vec())])), "Hello World", "Length {len}");
    }
    // 同号对象后出现的覆盖前面的（增量更新）
    let mut objs = page_objs(stream("", b"BT (Old) Tj ET"), HELV);
    objs.push((4, stream("", b"BT (New) Tj ET")));
    assert_eq!(text_of(&pdf(&objs, TRAILER)), "New");
    // 流数据里像对象头的文本不当作对象
    let b = one_page(stream("", b"BT /F1 12 Tf (A 12 0 obj B) Tj ET"), HELV, vec![]);
    assert_eq!(text_of(&b), "A 12 0 obj B");
    assert!(!Doc::load(&b).objs.contains_key(&12));
}

/// 三页文档：每页内容是 `Page N`，没有字体
fn three_pages() -> Vec<u8> {
    let mut objs = vec![(1, CATALOG.to_vec()), (2, b"<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>".to_vec())];
    for i in 0..3u32 {
        objs.push((3 + i, format!("<< /Type /Page /Parent 2 0 R /Contents {} 0 R >>", 6 + i).into_bytes()));
        objs.push((6 + i, stream("", format!("BT (Page {}) Tj ET", i + 1).as_bytes())));
    }
    pdf(&objs, Some("<< /Root 1 0 R >>"))
}

#[test]
fn page_and_char_limits() {
    let b = three_pages();
    let i = ok(parse(&b, 1, 2000));
    assert_eq!((i.pages, i.pages_read, i.truncated, i.text.as_str()), (3, 1, true, "Page 1"));
    assert_eq!(text_of(&b), "Page 1\nPage 2\nPage 3");
    let m = ok(metadata(&b));
    assert_eq!((m.pages, m.pages_read, m.truncated, m.text.as_str()), (3, 0, false, ""));
    let i = ok(parse(&one_page(stream("", b"BT (ABCDEFGHIJ) Tj ET"), HELV, vec![]), 3, 5));
    assert_eq!((i.text.as_str(), i.truncated), ("ABCDE", true));
}
#[test]
fn form_xobjects() {
    let form = stream("/Type /XObject /Subtype /Form /Resources << /Font << /F1 5 0 R >> >>", b"BT /F1 12 Tf (Inside Form) Tj ET");
    assert_eq!(text_of(&one_page(stream("", b"/X1 Do"), HELV, vec![(8, form)])), "Inside Form");
    // 同一表单反复引用：最多展开 MAX_FORMS 次
    let form = stream("/Type /XObject /Subtype /Form", b"BT (x) Tj ET");
    let many = "/X1 Do ".repeat(300);
    assert_eq!(text_of(&one_page(stream("", many.as_bytes()), HELV, vec![(8, form)])), "x".repeat(256));
    // 表单引用自己：最多嵌套 MAX_FORM_DEPTH 层
    let form = stream("/Type /XObject /Subtype /Form /Resources << /XObject << /X1 8 0 R >> >>", b"BT (y) Tj ET /X1 Do");
    assert_eq!(text_of(&one_page(stream("", b"/X1 Do"), HELV, vec![(8, form)])), "yyyy");
    // 图像 XObject 不展开
    let image = stream("/Type /XObject /Subtype /Image /Width 1 /Height 1", b"BT (z) Tj ET");
    assert_eq!(text_of(&one_page(stream("", b"/X1 Do"), HELV, vec![(8, image)])), "");
}

fn layout(content: &[u8]) -> String { text_of(&one_page(stream("", content), HELV, vec![])) }

#[test]
fn text_layout() {
    assert_eq!(layout(b"BT [(Hello) -250 (World)] TJ ET"), "Hello World");
    assert_eq!(layout(b"BT [(Hel) -50 (lo)] TJ ET"), "Hello");
    assert_eq!(layout(b"BT 1 0 0 1 72 720 Tm (Line1) Tj 1 0 0 1 72 700 Tm (Line2) Tj ET"), "Line1\nLine2");
    assert_eq!(layout(b"BT 1 0 0 1 72 720 Tm (A) Tj 1 0 0 1 90 720 Tm (B) Tj ET"), "A B");
    assert_eq!(layout(b"BT (A) Tj 0 -14 Td (B) Tj ET"), "A\nB");
    assert_eq!(layout(b"BT (A) Tj T* (B) Tj ET"), "A\nB");
    assert_eq!(layout(b"BT (A) Tj (B) ' ET"), "A\nB");
    // 空白折叠为一个空格，控制字符丢弃
    assert_eq!(layout(b"BT (a \\t\\n b\\001c) Tj ET"), "a bc");
    // 内联图像数据里的字节不当作文本
    assert_eq!(layout(b"BT (A) Tj ET BI /W 1 /H 1 ID (Leak) Tj abcEIx EI BT (B) Tj ET"), "AB");
}
fn lex(s: &[u8], refs: bool) -> Option<Obj> { Lexer::new(s, 0, refs).next_obj() }

#[test]
fn lexer_objects() {
    assert_eq!(lex(b"1 0 R", true), Some(Obj::Ref(1, 0)));
    assert_eq!(lex(b"1 0 R", false), Some(Obj::Int(1)));
    assert_eq!(lex(b"-3.5", false), Some(Obj::Real(-3.5)));
    assert_eq!(lex(b"(a(b)c)", false), Some(Obj::Str(b"a(b)c".to_vec())));
    assert_eq!(lex(br"(a\nb\101\\\))", false), Some(Obj::Str(b"a\nbA\\)".to_vec())));
    assert_eq!(lex(b"<4>", false), Some(Obj::Str(vec![0x40])));
    assert_eq!(lex(b"/A#20B", false), Some(Obj::Name("A B".into())));
    let want = Dict::from([("K".to_string(), Obj::Array(vec![Obj::Int(1), Obj::Int(2)])), ("V".to_string(), Obj::Null)]);
    assert_eq!(lex(b"<< /K [1 2] /V null >>", true), Some(Obj::Dict(want)));
    for op in [b")", b"]", b"}"] { assert_eq!(lex(op, false), Some(Obj::Op((op[0] as char).to_string()))); }
    assert_eq!(lex(b"  % comment\n", false), None);
}

#[test]
fn lexer_deep_nesting_terminates() {
    let deep = vec![b'['; 100_000];
    let mut lx = Lexer::new(&deep, 0, false);
    assert!(matches!(lx.next_obj(), Some(Obj::Array(_))));
    assert_eq!(lx.next_obj(), None);
}
