//! PDF 词法与对象解析。容错优先：坏字节跳过，结构不完整时尽量取出已读到的部分，不 panic
use std::collections::BTreeMap;
use std::ops::Range;

pub type Dict = BTreeMap<String, Obj>;

#[derive(Debug, Clone, PartialEq)]
pub enum Obj {
    Null,
    Bool(bool),
    Int(i64),
    Real(f64),
    Str(Vec<u8>),
    Name(String),
    Array(Vec<Obj>),
    Dict(Dict),
    Ref(u32, u16),
    /// 流对象：字典 + 原始数据在文件里的字节范围
    Stream(Dict, Range<usize>),
    /// 内容流里的操作符，或文档里的关键字
    Op(String),
}

impl Obj {
    pub fn as_int(&self) -> Option<i64> { match self { Obj::Int(i) => Some(*i), Obj::Real(r) if r.is_finite() => Some(*r as i64), _ => None } }
    pub fn as_f64(&self) -> Option<f64> { match self { Obj::Int(i) => Some(*i as f64), Obj::Real(r) => Some(*r), _ => None } }
    pub fn as_name(&self) -> Option<&str> { if let Obj::Name(n) = self { Some(n) } else { None } }
    pub fn as_dict(&self) -> Option<&Dict> { match self { Obj::Dict(d) | Obj::Stream(d, _) => Some(d), _ => None } }
    pub fn as_array(&self) -> Option<&[Obj]> { if let Obj::Array(a) = self { Some(a) } else { None } }
    pub fn as_str(&self) -> Option<&[u8]> { if let Obj::Str(s) = self { Some(s) } else { None } }
}

const MAX_DEPTH: usize = 64;
/// 单个数组或字典最多保留的元素数，防止畸形文件撑爆内存（多出的仍会被读过去）
const MAX_ITEMS: usize = 100_000;

pub fn is_ws(b: u8) -> bool { matches!(b, 0 | 9 | 10 | 12 | 13 | 32) }
pub fn is_delim(b: u8) -> bool { matches!(b, b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%') }
pub fn hex_digit(b: u8) -> Option<u8> {
    match b { b'0'..=b'9' => Some(b - b'0'), b'a'..=b'f' => Some(b - b'a' + 10), b'A'..=b'F' => Some(b - b'A' + 10), _ => None }
}
/// 文档结构关键字：解析数组、字典时遇到就停，避免吞掉下一个对象
fn is_structural(op: &str) -> bool { matches!(op, "obj" | "endobj" | "stream" | "endstream" | "xref" | "trailer" | "startxref") }

pub struct Lexer<'a> {
    pub buf: &'a [u8],
    pub pos: usize,
    allow_ref: bool,
}

impl<'a> Lexer<'a> {
    /// allow_ref：文档主体里识别 `N G R` 间接引用；内容流里不识别
    pub fn new(buf: &'a [u8], pos: usize, allow_ref: bool) -> Self { Lexer { buf, pos: pos.min(buf.len()), allow_ref } }
    fn peek(&self) -> Option<u8> { self.buf.get(self.pos).copied() }
    pub fn at(&self, s: &[u8]) -> bool { self.buf.get(self.pos..).is_some_and(|r| r.starts_with(s)) }
    pub fn skip_ws(&mut self) {
        while let Some(b) = self.peek() {
            if is_ws(b) {
                self.pos += 1;
            } else if b == b'%' {
                while self.peek().is_some_and(|c| c != b'\n' && c != b'\r') { self.pos += 1; }
            } else {
                break;
            }
        }
    }
    /// 读下一个对象；读到结尾返回 None。每次调用至少前进一个字节
    pub fn next_obj(&mut self) -> Option<Obj> { self.obj(0) }

    fn obj(&mut self, depth: usize) -> Option<Obj> {
        self.skip_ws();
        let b = self.peek()?;
        Some(match b {
            b'(' => { self.pos += 1; Obj::Str(self.lit_str()) }
            b'<' if self.at(b"<<") => {
                self.pos += 2;
                if depth >= MAX_DEPTH { return Some(Obj::Null); }
                Obj::Dict(self.dict(depth + 1))
            }
            b'<' => { self.pos += 1; Obj::Str(self.hex_str()) }
            b'[' => {
                self.pos += 1;
                if depth >= MAX_DEPTH { return Some(Obj::Null); }
                Obj::Array(self.array(depth + 1))
            }
            b'/' => { self.pos += 1; Obj::Name(self.name()) }
            // 花括号（PostScript 函数）和多余的结束符都当作单字符操作符，由调用方忽略
            b'{' | b'}' | b')' | b'>' | b']' => { self.pos += 1; Obj::Op((b as char).to_string()) }
            _ => self.word(),
        })
    }

    /// 数字、true/false/null，或操作符
    fn word(&mut self) -> Obj {
        let start = self.pos;
        while self.peek().is_some_and(|c| !is_ws(c) && !is_delim(c)) { self.pos += 1; }
        if self.pos == start { self.pos += 1; }
        let end = self.pos.min(self.buf.len());
        let raw = &self.buf[start..end];
        if raw.iter().all(|c| c.is_ascii_digit() || matches!(c, b'+' | b'-' | b'.')) {
            let s = std::str::from_utf8(raw).unwrap_or("");
            if let Ok(i) = s.parse::<i64>() {
                if self.allow_ref && i >= 0 {
                    if let Some(r) = self.maybe_ref(i) { return r; }
                }
                return Obj::Int(i);
            }
            if let Ok(f) = s.parse::<f64>() { return Obj::Real(f); }
        }
        match raw {
            b"true" => Obj::Bool(true),
            b"false" => Obj::Bool(false),
            b"null" => Obj::Null,
            _ => Obj::Op(String::from_utf8_lossy(&raw[..raw.len().min(32)]).into_owned()),
        }
    }
    /// `N G R` 间接引用；不匹配时回退到 N 之后
    fn maybe_ref(&mut self, num: i64) -> Option<Obj> {
        let save = self.pos;
        let r = self.ref_tail(num);
        if r.is_none() { self.pos = save; }
        r
    }
    fn ref_tail(&mut self, num: i64) -> Option<Obj> {
        self.skip_ws();
        let g = self.uint_word()?;
        self.skip_ws();
        let after = self.buf.get(self.pos + 1).copied();
        if self.peek() != Some(b'R') || after.is_some_and(|c| !is_ws(c) && !is_delim(c)) { return None; }
        self.pos += 1;
        Some(Obj::Ref(u32::try_from(num).ok()?, u16::try_from(g).ok()?))
    }
    /// 纯数字的词，后面必须是空白、分隔符或结尾
    fn uint_word(&mut self) -> Option<u64> {
        let start = self.pos;
        while self.peek().is_some_and(|c| c.is_ascii_digit()) { self.pos += 1; }
        if self.pos == start || self.peek().is_some_and(|c| !is_ws(c) && !is_delim(c)) { return None; }
        std::str::from_utf8(&self.buf[start..self.pos]).ok()?.parse().ok()
    }
    /// 字面字符串：支持嵌套括号、转义和八进制
    fn lit_str(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        let mut depth = 0usize;
        while let Some(b) = self.peek() {
            self.pos += 1;
            match b {
                b'(' => { depth += 1; out.push(b); }
                b')' => { if depth == 0 { break; } depth -= 1; out.push(b); }
                b'\\' => {
                    let Some(e) = self.peek() else { break };
                    self.pos += 1;
                    match e {
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'b' => out.push(8),
                        b'f' => out.push(12),
                        b'0'..=b'7' => {
                            let mut v = u32::from(e - b'0');
                            for _ in 0..2 {
                                match self.peek() {
                                    Some(d @ b'0'..=b'7') => { v = v * 8 + u32::from(d - b'0'); self.pos += 1; }
                                    _ => break,
                                }
                            }
                            out.push(v as u8); // 超过一个字节的高位按规范丢弃
                        }
                        // 反斜杠加换行是续行，不产生字符
                        b'\r' => { if self.peek() == Some(b'\n') { self.pos += 1; } }
                        b'\n' => {}
                        _ => out.push(e),
                    }
                }
                _ => out.push(b),
            }
        }
        out
    }
    /// 十六进制字符串，读到 `>` 为止
    fn hex_str(&mut self) -> Vec<u8> {
        let start = self.pos;
        while self.peek().is_some_and(|c| c != b'>') { self.pos += 1; }
        let out = decode_hex(&self.buf[start..self.pos]);
        if self.peek() == Some(b'>') { self.pos += 1; }
        out
    }
    /// 名称（不含开头的 `/`）；`#xx` 转义还原为字节，过长的部分丢弃
    fn name(&mut self) -> String {
        let mut out = Vec::new();
        while let Some(b) = self.peek() {
            if is_ws(b) || is_delim(b) { break; }
            self.pos += 1;
            let mut byte = b;
            if b == b'#' {
                let hi = self.peek().and_then(hex_digit);
                let lo = self.buf.get(self.pos + 1).copied().and_then(hex_digit);
                if let (Some(h), Some(l)) = (hi, lo) { self.pos += 2; byte = (h << 4) | l; }
            }
            if out.len() < 256 { out.push(byte); }
        }
        String::from_utf8_lossy(&out).into_owned()
    }
    /// 数组：读到 `]` 结束；遇到结构关键字回退并结束，其余操作符忽略
    fn array(&mut self, depth: usize) -> Vec<Obj> {
        let mut out = Vec::new();
        loop {
            let save = self.pos;
            match self.obj(depth) {
                None => break,
                Some(Obj::Op(op)) if op == "]" => break,
                Some(Obj::Op(op)) if is_structural(&op) => { self.pos = save; break; }
                Some(Obj::Op(_)) => {}
                Some(o) => { if out.len() < MAX_ITEMS { out.push(o); } }
            }
        }
        out
    }
    /// 字典：读到 `>>` 结束；键不是名称就跳过；值缺失记为 Null
    fn dict(&mut self, depth: usize) -> Dict {
        let mut out = Dict::new();
        loop {
            self.skip_ws();
            if self.at(b">>") { self.pos += 2; break; }
            let save = self.pos;
            let key = match self.obj(depth) {
                None => break,
                Some(Obj::Name(n)) => n,
                Some(Obj::Op(op)) if is_structural(&op) => { self.pos = save; break; }
                Some(Obj::Op(op)) if op == ">" => break,
                Some(_) => continue,
            };
            self.skip_ws();
            if self.at(b">>") { out.insert(key, Obj::Null); continue; }
            let save = self.pos;
            match self.obj(depth) {
                None => { out.insert(key, Obj::Null); break; }
                Some(Obj::Op(op)) if is_structural(&op) => { self.pos = save; out.insert(key, Obj::Null); break; }
                Some(v) => { if out.len() < MAX_ITEMS { out.insert(key, v); } }
            }
        }
        out
    }
    /// 内联图像：在 `ID` 之后调用，跳到 `EI` 之后。图像数据是任意字节，按「前后都是空白的 EI」定位
    pub fn skip_inline_image(&mut self) {
        if self.peek().is_some_and(is_ws) { self.pos += 1; }
        let buf = self.buf;
        let mut i = self.pos;
        while i + 1 < buf.len() {
            let before_ok = i == 0 || is_ws(buf[i - 1]);
            if buf[i] == b'E' && buf[i + 1] == b'I' && before_ok && buf.get(i + 2).is_none_or(|&c| is_ws(c)) {
                self.pos = i + 2;
                return;
            }
            i += 1;
        }
        self.pos = buf.len();
    }
}

/// 十六进制文本转字节：跳过非十六进制字符，奇数个数字时末位补 0
pub fn decode_hex(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len() / 2);
    let mut hi: Option<u8> = None;
    for &b in input {
        let Some(v) = hex_digit(b) else { continue };
        match hi.take() {
            Some(h) => out.push((h << 4) | v),
            None => hi = Some(v),
        }
    }
    if let Some(h) = hi { out.push(h << 4); }
    out
}
