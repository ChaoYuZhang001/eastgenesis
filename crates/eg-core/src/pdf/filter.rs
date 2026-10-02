//! PDF 流过滤器：只解文本相关的 FlateDecode / ASCIIHexDecode / ASCII85Decode，图像类过滤器直接跳过
use super::lexer::{Dict, Obj};
use miniz_oxide::inflate::{decompress_to_vec_with_limit, decompress_to_vec_zlib_with_limit};

/// 单个流解压上限（约 16MB），防压缩炸弹
pub(crate) const MAX_STREAM: usize = 16 << 20;
/// 整份文档解压总量上限（约 64MB）
pub(crate) const MAX_TOTAL: usize = 64 << 20;

/// miniz_oxide 出错时返回的缓冲区没有按已写长度截断，尾部是补零
fn trim_nul(mut v: Vec<u8>) -> Vec<u8> {
    let n = v.iter().rposition(|&b| b != 0).map_or(0, |i| i + 1);
    v.truncate(n);
    v
}

/// zlib 包装的 deflate；校验和不符或超限时接受已解出的部分；没有 zlib 头时按原始 deflate 再试一次
pub(crate) fn flate(input: &[u8], max: usize) -> Vec<u8> {
    if input.is_empty() { return Vec::new(); }
    let max = max.max(1);
    match decompress_to_vec_zlib_with_limit(input, max) {
        Ok(v) => v,
        Err(e) => {
            let part = trim_nul(e.output);
            if !part.is_empty() { return part; }
            match decompress_to_vec_with_limit(input, max) { Ok(v) => v, Err(e) => trim_nul(e.output) }
        }
    }
}

pub(crate) fn ascii_hex(input: &[u8]) -> Vec<u8> {
    let end = input.iter().position(|&b| b == b'>').unwrap_or(input.len());
    super::lexer::decode_hex(&input[..end])
}

/// ASCII85：`z` 表示四个零字节，`~>` 结束，其他字符跳过
pub(crate) fn ascii85(input: &[u8]) -> Vec<u8> {
    let body = input.trim_ascii_start();
    let body = body.strip_prefix(b"<~").unwrap_or(body);
    let mut out = Vec::with_capacity(body.len() / 5 * 4 + 4);
    let (mut acc, mut n) = (0u32, 0usize);
    for &b in body {
        match b {
            b'~' => break,
            b'z' if n == 0 => out.extend_from_slice(&[0; 4]),
            b'!'..=b'u' => {
                acc = acc.wrapping_mul(85).wrapping_add(u32::from(b - b'!'));
                n += 1;
                if n == 5 { out.extend_from_slice(&acc.to_be_bytes()); acc = 0; n = 0; }
            }
            _ => {}
        }
    }
    if n > 1 {
        for _ in n..5 { acc = acc.wrapping_mul(85).wrapping_add(84); }
        out.extend_from_slice(&acc.to_be_bytes()[..n - 1]);
    }
    out
}

/// 按 /Filter 依次解码；遇到不支持的过滤器返回 None；cap 为本次允许的最大输出
pub(crate) fn decode(dict: &Dict, raw: &[u8], cap: usize) -> Option<Vec<u8>> {
    if cap == 0 { return None; }
    let names: Vec<&str> = match dict.get("Filter") {
        None | Some(Obj::Null) => Vec::new(),
        Some(Obj::Name(n)) => vec![n.as_str()],
        Some(Obj::Array(a)) => a.iter().map(Obj::as_name).collect::<Option<Vec<_>>>()?,
        Some(_) => return None,
    };
    let mut data: Option<Vec<u8>> = None;
    for n in names {
        let input = data.as_deref().unwrap_or(raw);
        let next = match n {
            "FlateDecode" | "Fl" => flate(input, cap),
            "ASCIIHexDecode" | "AHx" => ascii_hex(input),
            "ASCII85Decode" | "A85" => ascii85(input),
            _ => return None,
        };
        data = Some(next);
    }
    let mut data = data.unwrap_or_else(|| raw[..raw.len().min(cap)].to_vec());
    data.truncate(cap);
    Some(data)
}
