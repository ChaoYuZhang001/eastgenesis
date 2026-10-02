//! ToUnicode CMap：bfchar、bfrange 把字符码映射到 Unicode；codespacerange 给出字符码的字节数
use super::lexer::{Lexer, Obj};
use std::collections::HashMap;

/// 单个 bfrange 最多展开的字符码数
const MAX_RANGE: u32 = 65_536;
/// 最多写入的映射条目数（含覆盖），防止恶意 CMap 拖慢解析
const MAX_ENTRIES: usize = 200_000;
/// 操作数栈上限
const MAX_STACK: usize = 1000;

#[derive(Debug, Default)]
pub(crate) struct CMap {
    /// (字符码字节数, 字符码) → Unicode 文本
    map: HashMap<(u8, u32), String>,
    /// 字符码可能的字节数，升序
    lens: Vec<u8>,
    /// 已写入的条目数
    used: usize,
}

/// 字节串按大端转成字符码
fn code(b: &[u8]) -> u32 { b.iter().fold(0u32, |a, &x| (a << 8) | u32::from(x)) }

/// 目标串拆成 UTF-16 码元；只有一个字节时按 Latin-1
fn units(b: &[u8]) -> Vec<u16> {
    if b.len() == 1 { return vec![u16::from(b[0])]; }
    b.chunks(2).map(|c| u16::from_be_bytes([c[0], c.get(1).copied().unwrap_or(0)])).collect()
}

/// UTF-16 码元转字符串，无效码元替换为 U+FFFD
fn text(u: &[u16]) -> String { char::decode_utf16(u.iter().copied()).map(|r| r.unwrap_or('\u{FFFD}')).collect() }

impl CMap {
    pub fn parse(data: &[u8]) -> CMap {
        let mut cm = CMap::default();
        let mut lx = Lexer::new(data, 0, false);
        let mut stack: Vec<Obj> = Vec::new();
        while let Some(o) = lx.next_obj() {
            let op = match o {
                Obj::Op(op) => op,
                o => { if stack.len() < MAX_STACK { stack.push(o); } continue; }
            };
            match op.as_str() {
                "endcodespacerange" => {
                    for p in stack.chunks_exact(2) {
                        if let (Some(a), Some(b)) = (p[0].as_str(), p[1].as_str()) { if a.len() == b.len() { cm.add_len(a.len()); } }
                    }
                }
                "endbfchar" => {
                    for p in stack.chunks_exact(2) {
                        if let (Some(src), Some(dst)) = (p[0].as_str(), p[1].as_str()) { cm.insert(src, dst); }
                    }
                }
                "endbfrange" => {
                    for t in stack.chunks_exact(3) {
                        if let (Some(lo), Some(hi)) = (t[0].as_str(), t[1].as_str()) { cm.range(lo, hi, &t[2]); }
                    }
                }
                _ => {}
            }
            stack.clear();
        }
        if cm.lens.is_empty() {
            let mut l: Vec<u8> = cm.map.keys().map(|k| k.0).collect();
            l.sort_unstable();
            l.dedup();
            cm.lens = l;
        }
        cm
    }
    fn add_len(&mut self, n: usize) {
        let Ok(n) = u8::try_from(n) else { return };
        if !(1..=4).contains(&n) { return; }
        if let Err(i) = self.lens.binary_search(&n) { self.lens.insert(i, n); }
    }
    fn full(&self) -> bool { self.used >= MAX_ENTRIES }
    /// n 由调用方保证在 1..=4
    fn put(&mut self, n: usize, c: u32, s: String) {
        if self.full() { return; }
        self.used += 1;
        self.map.insert((n as u8, c), s);
    }
    fn insert(&mut self, src: &[u8], dst: &[u8]) {
        if (1..=4).contains(&src.len()) { self.put(src.len(), code(src), text(&units(dst))); }
    }
    /// bfrange：目标是串时逐个递增最后一个码元；目标是数组时逐个对应
    fn range(&mut self, lo: &[u8], hi: &[u8], dst: &Obj) {
        if lo.len() != hi.len() || !(1..=4).contains(&lo.len()) { return; }
        let (a, b) = (code(lo), code(hi));
        if b < a || b - a >= MAX_RANGE { return; }
        match dst {
            Obj::Str(s) => {
                let mut u = units(s);
                let Some(last) = u.len().checked_sub(1) else { return };
                for c in a..=b {
                    if self.full() { return; }
                    self.put(lo.len(), c, text(&u));
                    u[last] = u[last].wrapping_add(1);
                }
            }
            Obj::Array(arr) => {
                for (c, d) in (a..=b).zip(arr) { if let Some(d) = d.as_str() { self.put(lo.len(), c, text(&units(d))); } }
            }
            _ => {}
        }
    }
    /// 解码字符码追加到 out：每个位置先试最短码长；都查不到时前进 default_len（在码长列表里时）或最短码长
    pub fn decode(&self, bytes: &[u8], default_len: usize, out: &mut String) {
        let fallback = [default_len.clamp(1, 4) as u8];
        let lens: &[u8] = if self.lens.is_empty() { &fallback } else { &self.lens };
        let step = if lens.iter().any(|&n| usize::from(n) == default_len) { default_len } else { usize::from(lens[0]) };
        let mut i = 0;
        while i < bytes.len() {
            let hit = lens.iter().find_map(|&n| {
                let b = bytes.get(i..i + usize::from(n))?;
                self.map.get(&(n, code(b))).map(|s| (usize::from(n), s))
            });
            match hit {
                Some((n, s)) => { out.push_str(s); i += n; }
                None => i += step,
            }
        }
    }
    pub fn is_empty(&self) -> bool { self.map.is_empty() }
}
