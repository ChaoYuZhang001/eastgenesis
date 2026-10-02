//! 时间格式：修改时间输出为 UTC 的 RFC 3339（精确到秒），不依赖时区库
use std::time::{SystemTime, UNIX_EPOCH};

/// 1970-01-01 以来的秒数；早于 1970 的为负数
fn unix_secs(t: SystemTime) -> i64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => i64::try_from(d.as_secs()).unwrap_or(i64::MAX),
        Err(e) => -i64::try_from(e.duration().as_secs()).unwrap_or(i64::MAX),
    }
}

/// 例如 2026-09-30T08:00:00Z
pub fn rfc3339(t: SystemTime) -> String {
    let secs = unix_secs(t).clamp(-62_135_596_800, 253_402_300_799); // 0001-01-01 至 9999-12-31
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Howard Hinnant 的 civil_from_days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// 距今整天数（向下取整）；修改时间在未来时为 0
pub fn age_days(modified: SystemTime, now: SystemTime) -> u64 {
    now.duration_since(modified).map(|d| d.as_secs() / 86_400).unwrap_or(0)
}

/// 修改时间是否在最近 days 天内（按秒比较，不按日历日）
pub fn within_days(modified: SystemTime, now: SystemTime, days: u64) -> bool {
    match now.duration_since(modified) {
        Ok(d) => d.as_secs() <= days.saturating_mul(86_400),
        Err(_) => true,
    }
}
