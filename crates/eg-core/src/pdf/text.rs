//! 内容流文本提取：跟踪 Tf 和文本显示操作符，按 Td/TD/T*/Tm 推断换行，展开 Form XObject
use super::doc::Doc;
use super::font::{load_font, win_ansi, Font};
use super::lexer::{Dict, Lexer, Obj};
use std::collections::HashMap;

/// 操作数栈上限
const MAX_OPERANDS: usize = 1000;
/// Form XObject 最大嵌套深度
const MAX_FORM_DEPTH: usize = 4;
/// 一次提取最多展开的 Form XObject 数，防止反复引用同一表单
const MAX_FORMS: usize = 256;
/// TJ 数组里小于该值的位移（千分之一字号）视为词间空格
const TJ_SPACE: f64 = -180.0;

pub(crate) struct Extractor<'d, 'a> {
    doc: &'d Doc<'a>,
    out: String,
    /// 已输出的非空白字符数
    count: usize,
    max: usize,
    /// 字体按字典地址缓存；Doc 在提取期间只读借用，地址稳定
    fonts: HashMap<usize, Font>,
    cur: Option<usize>,
    last_y: Option<f64>,
    forms: usize,
}

impl<'d, 'a> Extractor<'d, 'a> {
    pub fn new(doc: &'d Doc<'a>, max: usize) -> Self {
        Extractor { doc, out: String::new(), count: 0, max, fonts: HashMap::new(), cur: None, last_y: None, forms: 0 }
    }
    pub fn full(&self) -> bool { self.count >= self.max }
    /// 提取一页；页与页之间换行
    pub fn page(&mut self, page: &Dict, res: Option<&Dict>) {
        let data = self.doc.contents(page);
        self.cur = None;
        self.last_y = None;
        self.run(&data, res, 0);
        self.newline();
    }
    pub fn finish(mut self) -> String {
        let n = self.out.trim_end().len();
        self.out.truncate(n);
        self.out
    }
    fn run(&mut self, data: &[u8], res: Option<&Dict>, depth: usize) {
        let mut lx = Lexer::new(data, 0, false);
        let mut ops: Vec<Obj> = Vec::new();
        while !self.full() {
            let Some(o) = lx.next_obj() else { break };
            let op = match o {
                Obj::Op(op) => op,
                o => { if ops.len() < MAX_OPERANDS { ops.push(o); } continue; }
            };
            match op.as_str() {
                // 内容流里落单的结束符：跳过，不清空操作数
                "{" | "}" | ")" | ">" | "]" => continue,
                "Tf" => { if let Some(n) = ops.iter().rev().find_map(Obj::as_name) { self.set_font(res, n); } }
                "Tj" => { if let Some(s) = ops.last().and_then(Obj::as_str) { self.show(s); } }
                "'" | "\"" => { self.newline(); if let Some(s) = ops.last().and_then(Obj::as_str) { self.show(s); } }
                "TJ" => {
                    for o in ops.last().and_then(Obj::as_array).unwrap_or(&[]) {
                        match o {
                            Obj::Str(s) => self.show(s),
                            o => { if o.as_f64().is_some_and(|v| v < TJ_SPACE) { self.space(); } }
                        }
                    }
                }
                "Td" | "TD" => self.moved(ops.last().and_then(Obj::as_f64)),
                "T*" => self.newline(),
                "Tm" => { if let Some(y) = ops.last().and_then(Obj::as_f64) { self.moved_to(y); } }
                "Do" => { if let Some(n) = ops.last().and_then(Obj::as_name) { self.form(res, n, depth); } }
                "ID" => lx.skip_inline_image(),
                _ => {}
            }
            ops.clear();
        }
    }
    /// Td/TD：纵向位移超过半个单位视为换行
    fn moved(&mut self, dy: Option<f64>) {
        let Some(dy) = dy else { return };
        if dy.abs() > 0.5 { self.newline(); }
        self.last_y = self.last_y.map(|y| y + dy);
    }
    /// Tm：与上一次的纵坐标相同时加空格，否则换行
    fn moved_to(&mut self, y: f64) {
        if self.last_y.is_none_or(|p| (p - y).abs() > 0.5) { self.newline(); } else { self.space(); }
        self.last_y = Some(y);
    }
    /// Tf：在资源字典 /Font 里按名字找字体，按字典地址缓存
    fn set_font(&mut self, res: Option<&Dict>, name: &str) {
        let doc = self.doc;
        let fd = res.and_then(|r| doc.get(r, "Font")).and_then(Obj::as_dict).and_then(|f| doc.get(f, name)).and_then(Obj::as_dict);
        let Some(fd) = fd else { self.cur = None; return };
        let key = fd as *const Dict as usize;
        self.fonts.entry(key).or_insert_with(|| load_font(doc, fd));
        self.cur = Some(key);
    }
    /// 用当前字体解码字符串；没有字体时按 WinAnsi
    fn show(&mut self, s: &[u8]) {
        let mut tmp = String::new();
        match self.cur.and_then(|k| self.fonts.get(&k)) {
            Some(f) => f.decode(s, &mut tmp),
            None => tmp.extend(s.iter().map(|&c| win_ansi(c))),
        }
        self.push(&tmp);
    }
    /// Do：只展开 /Subtype /Form 的 XObject；表单有自己的 /Resources 时用它，否则沿用外层
    fn form(&mut self, res: Option<&Dict>, name: &str, depth: usize) {
        if depth >= MAX_FORM_DEPTH || self.forms >= MAX_FORMS { return; }
        let doc = self.doc;
        let Some(xo) = res.and_then(|r| doc.get(r, "XObject")).and_then(Obj::as_dict).and_then(|x| doc.get(x, name)) else { return };
        let Obj::Stream(d, _) = xo else { return };
        if doc.get(d, "Subtype").and_then(Obj::as_name) != Some("Form") { return; }
        self.forms += 1;
        let Some(data) = doc.stream_data(xo) else { return };
        let inner = doc.get(d, "Resources").and_then(Obj::as_dict).or(res);
        // 表单在 q/Q 中执行：字体状态不外泄
        let saved = self.cur;
        self.run(&data, inner, depth + 1);
        self.cur = saved;
    }
    /// 追加文本：空白折叠为单个空格，丢弃控制字符和 U+FFFD
    fn push(&mut self, s: &str) {
        for c in s.chars() {
            if self.full() { return; }
            if c.is_whitespace() { self.space(); continue; }
            if c.is_control() || c == '\u{FFFD}' { continue; }
            self.out.push(c);
            self.count += 1;
        }
    }
    /// 不在开头、空格后或换行后重复加空格
    fn space(&mut self) {
        if !self.out.is_empty() && !self.out.ends_with(|c: char| c == ' ' || c == '\n') { self.out.push(' '); }
    }
    /// 去掉行尾空格后换行；开头或已换行时不重复
    fn newline(&mut self) {
        if self.out.ends_with(' ') { self.out.pop(); }
        if !self.out.is_empty() && !self.out.ends_with('\n') { self.out.push('\n'); }
    }
}
