//! 最小 PDF 解析：顺序扫描对象，读取文档信息、页数和前几页文本。不支持加密文件
mod cmap;
mod doc;
mod filter;
mod font;
mod lexer;
mod text;
#[cfg(test)]
mod tests;

use crate::{AppError, AppResult};
use doc::Doc;
use text::Extractor;

/// 单个文件大小上限
pub const MAX_FILE: usize = 100 << 20;

#[derive(Debug, Clone, PartialEq)]
pub struct PdfInfo {
    pub title: Option<String>,
    pub author: Option<String>,
    pub subject: Option<String>,
    /// 总页数
    pub pages: usize,
    /// 实际读取的页数
    pub pages_read: usize,
    pub text: String,
    /// 页数或字数达到上限，文本不完整
    pub truncated: bool,
}

/// 元数据字段清理：去掉控制字符，最多 200 字，去首尾空白；为空时返回 None
fn clean(s: Option<String>) -> Option<String> {
    let s: String = s?.chars().filter(|c| !c.is_control()).take(200).collect();
    let s = s.trim();
    (!s.is_empty()).then(|| s.to_string())
}

/// 解析 PDF：最多读 max_pages 页、max_chars 个非空白字符
pub fn parse(bytes: &[u8], max_pages: usize, max_chars: usize) -> AppResult<PdfInfo> {
    if bytes.len() > MAX_FILE { return Err(AppError::new("pdf_too_large", "PDF 文件超过 100 MB，无法读取")); }
    let head = &bytes[..bytes.len().min(1024)];
    if !head.windows(5).any(|w| w == b"%PDF-") { return Err(AppError::new("pdf_invalid", "不是有效的 PDF 文件")); }
    let doc = Doc::load(bytes);
    if doc.objs.is_empty() { return Err(AppError::new("pdf_invalid", "不是有效的 PDF 文件")); }
    if doc.encrypted() { return Err(AppError::new("pdf_encrypted", "PDF 已加密，无法读取")); }
    let (pages, total) = doc.pages(max_pages);
    let mut ex = Extractor::new(&doc, max_chars);
    let mut read = 0;
    for (p, res) in &pages {
        if ex.full() { break; }
        ex.page(p, *res);
        read += 1;
    }
    let full = ex.full() && max_chars > 0;
    let text = ex.finish();
    Ok(PdfInfo { title: clean(doc.info("Title")), author: clean(doc.info("Author")), subject: clean(doc.info("Subject")), pages: total, pages_read: read, text, truncated: full || total > read })
}

/// 只读元数据和页数，不提取文本
pub fn metadata(bytes: &[u8]) -> AppResult<PdfInfo> {
    let mut info = parse(bytes, 0, 0)?;
    info.truncated = false;
    Ok(info)
}
