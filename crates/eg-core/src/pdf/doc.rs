//! PDF 文档结构：顺序扫描 `N G obj`，不依赖 xref 表；合并所有 trailer，展开对象流，遍历页面树
use super::filter::{self, MAX_STREAM, MAX_TOTAL};
use super::lexer::{is_delim, is_ws, Dict, Lexer, Obj};
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::ops::Range;

static NULL: Obj = Obj::Null;
/// 间接引用最多连续跟随的次数，防止循环引用
const MAX_HOPS: usize = 32;
/// 单个对象流最多读取的对象数
const MAX_OBJSTM: usize = 100_000;
/// 页面树最大深度和最多访问的节点数
const MAX_TREE_DEPTH: usize = 32;
const MAX_VISITS: usize = 10_000;

/// 页面字典，以及沿页面树继承下来的 /Resources
pub(crate) type Page<'s> = (&'s Dict, Option<&'s Dict>);

pub(crate) struct Doc<'a> {
    pub buf: &'a [u8],
    pub objs: HashMap<u32, Obj>,
    pub trailer: Dict,
    /// 剩余可解压字节数，所有流共享
    left: Cell<usize>,
}

/// 顺序扫描的结果
struct Scan {
    objs: HashMap<u32, Obj>,
    /// 流数据范围，按出现顺序
    streams: Vec<Range<usize>>,
    /// XRef 流的字典（新式 trailer），附带出现位置
    xref: Vec<(usize, Dict)>,
}

fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || from >= hay.len() { return None; }
    hay[from..].windows(needle.len()).position(|w| w == needle).map(|i| i + from)
}

/// 从 `obj` 关键字往回认 `N G`：返回 (对象号, 对象号起始位置)
fn header_before(buf: &[u8], kw: usize) -> Option<(u32, usize)> {
    let ws_back = |mut i: usize| { while i > 0 && is_ws(buf[i - 1]) { i -= 1; } i };
    let digits_back = |mut i: usize| { while i > 0 && buf[i - 1].is_ascii_digit() { i -= 1; } i };
    let a = ws_back(kw);
    if a == kw { return None; }
    let g = digits_back(a);
    if g == a || a - g > 5 { return None; }
    let b = ws_back(g);
    if b == g { return None; }
    let n = digits_back(b);
    if n == b || b - n > 10 { return None; }
    if n > 0 && !is_ws(buf[n - 1]) && !is_delim(buf[n - 1]) { return None; }
    let num: u32 = std::str::from_utf8(&buf[n..b]).ok()?.parse().ok()?;
    Some((num, n))
}

/// 所有 `N G obj`：(对象号, 对象号起始位置, `obj` 之后的位置)
fn candidates(buf: &[u8]) -> Vec<(u32, usize, usize)> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(k) = find(buf, b"obj", from) {
        from = k + 3;
        if buf.get(k + 3).is_some_and(|&c| !is_ws(c) && !is_delim(c)) { continue; }
        if let Some((num, start)) = header_before(buf, k) { out.push((num, start, k + 3)); }
    }
    out
}

/// 逐个解析候选对象：每个对象最多读到下一个候选的起点；落在流数据里的候选跳过；同号的后者覆盖前者
fn scan(buf: &[u8]) -> Scan {
    let cands = candidates(buf);
    let mut s = Scan { objs: HashMap::new(), streams: Vec::new(), xref: Vec::new() };
    let mut skip_to = 0;
    for (i, &(num, start, body)) in cands.iter().enumerate() {
        if start < skip_to { continue; }
        let end = cands.get(i + 1).map_or(buf.len(), |c| c.1).max(body);
        let mut lx = Lexer::new(&buf[..end], body, true);
        let obj = match lx.next_obj() {
            None | Some(Obj::Op(_)) => continue,
            Some(Obj::Dict(d)) => {
                lx.skip_ws();
                if !lx.at(b"stream") { Obj::Dict(d) } else {
                    let r = stream_range(buf, &d, lx.pos + 6);
                    skip_to = r.end;
                    s.streams.push(r.clone());
                    if d.get("Type").and_then(Obj::as_name) == Some("XRef") { s.xref.push((start, d.clone())); }
                    Obj::Stream(d, r)
                }
            }
            Some(o) => o,
        };
        s.objs.insert(num, obj);
    }
    s
}

/// 流数据范围：`stream` 后跳过 CR、LF；/Length 是直接整数且其后（跳过空白）紧跟 endstream 时采用，否则搜索 endstream
fn stream_range(buf: &[u8], d: &Dict, mut start: usize) -> Range<usize> {
    if buf.get(start) == Some(&b'\r') { start += 1; }
    if buf.get(start) == Some(&b'\n') { start += 1; }
    start = start.min(buf.len());
    if let Some(len) = d.get("Length").and_then(Obj::as_int).and_then(|l| usize::try_from(l).ok()) {
        if let Some(end) = start.checked_add(len).filter(|&e| e <= buf.len()) {
            let mut lx = Lexer::new(buf, end, false);
            lx.skip_ws();
            if lx.at(b"endstream") { return start..end; }
        }
    }
    match find(buf, b"endstream", start) {
        Some(mut e) => {
            if e > start && buf[e - 1] == b'\n' { e -= 1; }
            if e > start && buf[e - 1] == b'\r' { e -= 1; }
            start..e
        }
        None => start..buf.len(),
    }
}

/// 合并 trailer：传统 `trailer <<…>>`（不在流数据里）和 XRef 流字典，按出现位置排序，后出现的键覆盖前面的
fn merge_trailers(buf: &[u8], s: &Scan) -> Dict {
    let mut all = s.xref.clone();
    let mut from = 0;
    while let Some(i) = find(buf, b"trailer", from) {
        from = i + 7;
        if s.streams.iter().any(|r| r.contains(&i)) { continue; }
        if let Some(Obj::Dict(d)) = Lexer::new(buf, i + 7, true).next_obj() { all.push((i, d)); }
    }
    all.sort_by_key(|x| x.0);
    let mut out = Dict::new();
    for (_, d) in all { out.extend(d); }
    out
}

/// 对象流：头部是 n 对「对象号 相对 /First 的偏移」；每个对象最多读到下一个更大的偏移
fn parse_objstm(data: &[u8], n: usize, first: usize) -> Vec<(u32, Obj)> {
    let mut lx = Lexer::new(&data[..first.min(data.len())], 0, false);
    let mut pairs = Vec::new();
    for _ in 0..n.min(MAX_OBJSTM) {
        let (Some(a), Some(b)) = (lx.next_obj(), lx.next_obj()) else { break };
        let num = a.as_int().and_then(|v| u32::try_from(v).ok());
        let off = b.as_int().and_then(|v| usize::try_from(v).ok());
        let (Some(num), Some(off)) = (num, off) else { break };
        pairs.push((num, first.saturating_add(off)));
    }
    let mut starts: Vec<usize> = pairs.iter().map(|p| p.1).collect();
    starts.sort_unstable();
    let mut out = Vec::new();
    for (num, at) in pairs {
        if at >= data.len() { continue; }
        let end = starts.get(starts.partition_point(|&x| x <= at)).copied().unwrap_or(data.len()).min(data.len());
        match Lexer::new(&data[..end], at, true).next_obj() {
            None | Some(Obj::Op(_)) => {}
            Some(o) => out.push((num, o)),
        }
    }
    out
}

impl<'a> Doc<'a> {
    pub fn load(buf: &'a [u8]) -> Doc<'a> {
        let s = scan(buf);
        let trailer = merge_trailers(buf, &s);
        let mut doc = Doc { buf, objs: s.objs, trailer, left: Cell::new(MAX_TOTAL) };
        if !doc.encrypted() { doc.expand_objstm(); }
        doc
    }
    /// 展开对象流：只补直接定义里没有的对象号；按文件顺序处理，后出现的对象流覆盖前面的
    fn expand_objstm(&mut self) {
        let mut list: Vec<(usize, u32, usize, usize)> = self.objs.iter().filter_map(|(&num, o)| {
            let Obj::Stream(d, r) = o else { return None };
            if d.get("Type").and_then(Obj::as_name) != Some("ObjStm") { return None; }
            let n = usize::try_from(self.resolve(d.get("N")?).as_int()?).ok()?;
            let first = usize::try_from(self.resolve(d.get("First")?).as_int()?).ok()?;
            Some((r.start, num, n, first))
        }).collect();
        list.sort_unstable();
        let direct: HashSet<u32> = self.objs.keys().copied().collect();
        let mut found = Vec::new();
        for (_, num, n, first) in list {
            let Some(data) = self.objs.get(&num).and_then(|o| self.stream_data(o)) else { continue };
            found.extend(parse_objstm(&data, n, first));
        }
        for (k, o) in found { if !direct.contains(&k) { self.objs.insert(k, o); } }
    }
    /// 跟随间接引用；找不到对象或跳数用完时返回 Null
    pub fn resolve<'s>(&'s self, mut o: &'s Obj) -> &'s Obj {
        for _ in 0..MAX_HOPS {
            let Obj::Ref(n, _) = o else { return o };
            match self.objs.get(n) { Some(t) => o = t, None => return &NULL }
        }
        &NULL
    }
    /// 取字典的键并解引用；Null 视为没有
    pub fn get<'s>(&'s self, d: &'s Dict, key: &str) -> Option<&'s Obj> {
        match self.resolve(d.get(key)?) { Obj::Null => None, o => Some(o) }
    }
    /// 解码流数据；所有流共享 MAX_TOTAL 的解压额度
    pub fn stream_data(&self, o: &Obj) -> Option<Vec<u8>> {
        let Obj::Stream(d, r) = self.resolve(o) else { return None };
        let raw = self.buf.get(r.clone())?;
        let out = filter::decode(d, raw, MAX_STREAM.min(self.left.get()))?;
        self.left.set(self.left.get().saturating_sub(out.len()));
        Some(out)
    }

    /// 文档目录：trailer 的 /Root；没有时取对象号最大的 /Type /Catalog
    fn catalog(&self) -> Option<&Dict> {
        if let Some(d) = self.trailer.get("Root").and_then(|o| self.resolve(o).as_dict()) { return Some(d); }
        self.objs.iter().filter(|(_, o)| o.as_dict().and_then(|d| d.get("Type")).and_then(Obj::as_name) == Some("Catalog"))
            .max_by_key(|(n, _)| **n).and_then(|(_, o)| o.as_dict())
    }
    /// 按页面树顺序取前 max 页（带继承的 /Resources）；返回 (页面, 总页数)
    pub fn pages(&self, max: usize) -> (Vec<Page<'_>>, usize) {
        let mut out: Vec<Page<'_>> = Vec::new();
        let root = self.catalog().and_then(|c| c.get("Pages"));
        let root_dict = root.and_then(|o| self.resolve(o).as_dict());
        let declared = root_dict.and_then(|d| self.get(d, "Count")).and_then(Obj::as_int).and_then(|c| usize::try_from(c).ok());
        let mut seen: HashSet<u32> = HashSet::new();
        if let Some(Obj::Ref(n, _)) = root { seen.insert(*n); }
        let mut stack: Vec<(&Dict, Option<&Dict>, usize)> = root_dict.map(|d| (d, None, 0)).into_iter().collect();
        let mut visits = 0;
        while let Some((node, inherited, depth)) = stack.pop() {
            if out.len() >= max || visits >= MAX_VISITS { break; }
            visits += 1;
            let res = self.get(node, "Resources").and_then(Obj::as_dict).or(inherited);
            let Some(kids) = self.get(node, "Kids").and_then(Obj::as_array) else { out.push((node, res)); continue };
            if depth >= MAX_TREE_DEPTH { continue; }
            for k in kids.iter().rev() {
                if let Obj::Ref(n, _) = k { if !seen.insert(*n) { continue; } }
                if let Some(d) = self.resolve(k).as_dict() { stack.push((d, res, depth + 1)); }
            }
        }
        let total = declared.unwrap_or_else(|| self.count_pages()).max(out.len());
        (out, total)
    }
    /// 没有 /Count 时按 /Type /Page 对象计数
    fn count_pages(&self) -> usize {
        self.objs.values().filter(|o| o.as_dict().and_then(|d| d.get("Type")).and_then(Obj::as_name) == Some("Page")).count()
    }

    /// 页面内容：/Contents 是单个流或流数组；数组按顺序用换行拼接
    pub fn contents(&self, page: &Dict) -> Vec<u8> {
        match self.get(page, "Contents") {
            Some(Obj::Array(a)) => {
                let mut out = Vec::new();
                for o in a { if let Some(d) = self.stream_data(o) { out.extend_from_slice(&d); out.push(b'\n'); } }
                out
            }
            Some(o) => self.stream_data(o).unwrap_or_default(),
            None => Vec::new(),
        }
    }
    /// 文档信息字典（/Info）里的文本字段，去掉首尾空白；为空时返回 None
    pub fn info(&self, key: &str) -> Option<String> {
        let info = self.trailer.get("Info").and_then(|o| self.resolve(o).as_dict())?;
        let s = text_string(self.get(info, key)?.as_str()?);
        let s = s.trim();
        (!s.is_empty()).then(|| s.to_string())
    }
    /// trailer 里有非 null 的 /Encrypt 即视为加密
    pub fn encrypted(&self) -> bool { self.trailer.get("Encrypt").is_some_and(|o| !matches!(o, Obj::Null)) }
}

/// UTF-16BE 转字符串：奇数长度末位补 0，无效码元替换为 U+FFFD
pub(crate) fn utf16be(b: &[u8]) -> String {
    let units = b.chunks(2).map(|c| u16::from_be_bytes([c[0], c.get(1).copied().unwrap_or(0)]));
    char::decode_utf16(units).map(|r| r.unwrap_or('\u{FFFD}')).collect()
}

/// PDF 文本字符串：FE FF 开头按 UTF-16BE，EF BB BF 开头按 UTF-8，否则按 Latin-1
pub(crate) fn text_string(b: &[u8]) -> String {
    if let Some(r) = b.strip_prefix(b"\xFE\xFF") { return utf16be(r); }
    if let Some(r) = b.strip_prefix(b"\xEF\xBB\xBF") { return String::from_utf8_lossy(r).into_owned(); }
    b.iter().map(|&c| char::from(c)).collect()
}
