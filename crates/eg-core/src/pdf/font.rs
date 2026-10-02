//! 字体编码：ToUnicode CMap、UCS2/UTF16 编码的 Type0 字体、简单字体（/Differences + WinAnsi）
use super::cmap::CMap;
use super::doc::{utf16be, Doc};
use super::lexer::{Dict, Obj};
use std::collections::HashMap;

/// WinAnsi（CP1252）0x80–0x9F 区段；其余字节按 Latin-1
const CP1252: [char; 32] = [
    '€', '\u{FFFD}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{FFFD}', 'Ž', '\u{FFFD}',
    '\u{FFFD}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{FFFD}', 'ž', 'Ÿ',
];

/// 单字节按 WinAnsi 解码
pub(crate) fn win_ansi(c: u8) -> char {
    if (0x80..=0x9F).contains(&c) { CP1252[usize::from(c - 0x80)] } else { char::from(c) }
}

pub(crate) enum Font {
    /// ToUnicode CMap 与默认码长（Type0 为 2，其余为 1）
    CMap(CMap, usize),
    /// Type0 字体，/Encoding 名含 UCS2 或 UTF16
    Utf16,
    /// 简单字体：/Differences 覆盖的字符码，其余按 WinAnsi
    Simple(HashMap<u8, String>),
    /// 没有 ToUnicode 的 Type0 字体：无法还原文本，不输出
    Opaque,
}

impl Font {
    /// 字符码解码后追加到 out；空白和控制字符由调用方过滤
    pub fn decode(&self, b: &[u8], out: &mut String) {
        match self {
            Font::CMap(m, n) => m.decode(b, *n, out),
            Font::Utf16 => out.push_str(&utf16be(b)),
            Font::Simple(map) => {
                for &c in b {
                    match map.get(&c) { Some(s) => out.push_str(s), None => out.push(win_ansi(c)) }
                }
            }
            Font::Opaque => {}
        }
    }
}

/// 常见字形名转文本；不认识的返回 None
fn glyph(name: &str) -> Option<String> {
    let mut it = name.chars();
    if let (Some(c), None) = (it.next(), it.next()) { return Some(c.to_string()); }
    if let Some(h) = name.strip_prefix("uni") {
        if h.len() == 4 && h.bytes().all(|b| b.is_ascii_hexdigit()) {
            return u32::from_str_radix(h, 16).ok().and_then(char::from_u32).map(String::from);
        }
    }
    let s = match name {
        "space" => " ", "hyphen" => "-", "period" => ".", "comma" => ",", "colon" => ":", "slash" => "/",
        "fi" => "fi", "fl" => "fl", "ff" => "ff", "ffi" => "ffi", "ffl" => "ffl",
        "zero" => "0", "one" => "1", "two" => "2", "three" => "3", "four" => "4",
        "five" => "5", "six" => "6", "seven" => "7", "eight" => "8", "nine" => "9",
        "quoteright" => "’", "quoteleft" => "‘", "endash" => "–", "emdash" => "—", "bullet" => "•",
        _ => return None,
    };
    Some(s.to_string())
}

/// 读取字体字典：先 ToUnicode，再 Type0 的 UCS2/UTF16 编码，最后简单字体的 /Differences
pub(crate) fn load_font(doc: &Doc<'_>, font: &Dict) -> Font {
    let type0 = doc.get(font, "Subtype").and_then(Obj::as_name) == Some("Type0");
    if let Some(data) = doc.get(font, "ToUnicode").and_then(|o| doc.stream_data(o)) {
        let cm = CMap::parse(&data);
        if !cm.is_empty() { return Font::CMap(cm, if type0 { 2 } else { 1 }); }
    }
    if type0 {
        let enc = doc.get(font, "Encoding").and_then(Obj::as_name).unwrap_or("");
        return if enc.contains("UCS2") || enc.contains("UTF16") { Font::Utf16 } else { Font::Opaque };
    }
    let mut map = HashMap::new();
    let diffs = doc.get(font, "Encoding").and_then(Obj::as_dict).and_then(|e| doc.get(e, "Differences")).and_then(Obj::as_array).unwrap_or(&[]);
    let mut code: u32 = 0;
    for o in diffs {
        match o {
            Obj::Int(i) => code = u32::try_from(*i).unwrap_or(u32::MAX),
            Obj::Name(n) => {
                if let (Ok(c), Some(g)) = (u8::try_from(code), glyph(n)) { map.insert(c, g); }
                code = code.saturating_add(1);
            }
            _ => {}
        }
    }
    Font::Simple(map)
}
