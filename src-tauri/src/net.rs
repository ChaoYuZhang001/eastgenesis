//! 执行已由 eg_core::providers::plan_request 校验、加好鉴权头的请求。
//! ureq 是同步客户端，由调用方放进 spawn_blocking。不跟随重定向，防止鉴权头被带到别的主机。
use std::io::Read;
use std::time::Duration;

use eg_core::error::{AppError, AppResult};
use eg_core::providers::{PlannedRequest, ProxyResponse, MAX_RESPONSE};

pub fn execute(p: &PlannedRequest) -> AppResult<ProxyResponse> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout(Duration::from_secs(180))
        .redirects(0)
        .build();
    let mut req = agent.request(&p.method, &p.url);
    for (k, v) in &p.headers {
        req = req.set(k, v);
    }
    let res = match &p.body {
        Some(b) => req.send_string(b),
        None => req.call(),
    };
    let resp = match res {
        Ok(r) | Err(ureq::Error::Status(_, r)) => r,
        Err(e) => return Err(AppError::new("network", "无法连接 Provider").with_detail(p.scrub(&e.to_string()))),
    };
    let status = resp.status();
    let mut buf = Vec::new();
    resp.into_reader()
        .take(MAX_RESPONSE as u64)
        .read_to_end(&mut buf)
        .map_err(|e| AppError::new("network", "读取响应失败").with_detail(p.scrub(&e.to_string())))?;
    Ok(ProxyResponse { status, body: p.scrub(&String::from_utf8_lossy(&buf)) })
}
