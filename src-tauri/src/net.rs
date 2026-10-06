//! 执行已由 eg_core::providers::plan_request 校验、加好鉴权头的请求。
//! ureq 是同步客户端，由调用方放进 spawn_blocking。不跟随重定向，防止鉴权头被带到别的主机。
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use eg_core::error::{AppError, AppResult};
use eg_core::providers::{PlannedRequest, ProxyResponse, MAX_RESPONSE};

/// Raw bytes from a Provider response. The Tauri command adds status/error
/// envelopes before forwarding these chunks through an IPC Channel.
pub enum StreamPart {
    Headers(u16),
    Chunk(Vec<u8>),
}

const STREAM_READ_TIMEOUT: Duration = Duration::from_secs(60);
const STREAM_TOTAL_TIMEOUT: Duration = Duration::from_secs(180);

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
        Err(e) => {
            return Err(
                AppError::new("network", "无法连接 Provider").with_detail(p.scrub(&e.to_string()))
            )
        }
    };
    let status = resp.status();
    let mut buf = Vec::new();
    resp.into_reader()
        .take(MAX_RESPONSE as u64)
        .read_to_end(&mut buf)
        .map_err(|e| {
            AppError::new("network", "读取响应失败").with_detail(p.scrub(&e.to_string()))
        })?;
    Ok(ProxyResponse {
        status,
        body: p.scrub(&String::from_utf8_lossy(&buf)),
    })
}

/// Execute a Provider request without buffering the response body. The first
/// callback is the HTTP status; subsequent callbacks contain response bytes.
/// Authentication is already attached to `PlannedRequest`, and every chunk is
/// scrubbed before leaving the Rust process.
pub fn execute_stream<F>(p: &PlannedRequest, cancelled: &AtomicBool, mut emit: F) -> AppResult<()>
where
    F: FnMut(StreamPart) -> AppResult<()>,
{
    execute_stream_with_budget(
        p,
        cancelled,
        &mut emit,
        STREAM_READ_TIMEOUT,
        STREAM_TOTAL_TIMEOUT,
    )
}

fn execute_stream_with_budget<F>(
    p: &PlannedRequest,
    cancelled: &AtomicBool,
    mut emit: F,
    read_timeout: Duration,
    total_timeout: Duration,
) -> AppResult<()>
where
    F: FnMut(StreamPart) -> AppResult<()>,
{
    let deadline = Instant::now() + total_timeout;
    // Keep the buffered JSON path on ureq, but use reqwest for streams. ureq
    // 2.12.1 applies its socket read timeout twice while constructing a
    // response reader; on Darwin that can return EINVAL for a valid stream.
    // reqwest's blocking client applies this to each connect/read/write
    // operation; the explicit deadline below remains the whole-stream cap.
    let client = reqwest::blocking::ClientBuilder::new()
        .connect_timeout(Duration::from_secs(15))
        .timeout(read_timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| {
            AppError::new("network", "无法创建 Provider 客户端")
                .with_detail(p.scrub(&e.to_string()))
        })?;
    let mut req = match p.method.as_str() {
        "GET" => client.get(&p.url),
        "POST" => client.post(&p.url),
        _ => return Err(AppError::new("proxy_method", "只允许 GET 和 POST")),
    };
    for (k, v) in &p.headers {
        req = req.header(k, v);
    }
    if let Some(body) = &p.body {
        req = req.body(body.clone());
    }
    let mut resp = req.send().map_err(|e| {
        if e.is_timeout() {
            AppError::new("timeout", "Provider 响应超时")
        } else {
            AppError::new("network", "无法连接 Provider").with_detail(p.scrub(&e.to_string()))
        }
    })?;
    emit(StreamPart::Headers(resp.status().as_u16()))?;
    if cancelled.load(Ordering::Relaxed) {
        return Ok(());
    }
    let mut reader = (&mut resp).take(MAX_RESPONSE as u64);
    let mut pending = String::new();
    let mut buf = [0_u8; 16 * 1024];
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(AppError::new("timeout", "Provider 响应超时"));
        }
        let n = reader.read(&mut buf).map_err(|e| {
            let reqwest_timeout = e
                .get_ref()
                .and_then(|source| source.downcast_ref::<reqwest::Error>())
                .map(|error| error.is_timeout())
                .unwrap_or(false);
            if e.kind() == std::io::ErrorKind::TimedOut || reqwest_timeout {
                AppError::new("timeout", "Provider 响应超时")
            } else {
                AppError::new("network", "读取响应失败").with_detail(p.scrub(&e.to_string()))
            }
        })?;
        if n == 0 {
            let safe = p.scrub_stream(&mut pending, "", true);
            if !safe.is_empty() {
                emit(StreamPart::Chunk(safe.into_bytes()))?;
            }
            return Ok(());
        }
        // Provider responses are text (JSON or SSE); incremental redaction
        // retains only a suffix that could still be a secret prefix. Lossy
        // conversion matches the old proxy behavior for malformed bytes.
        let safe = p.scrub_stream(&mut pending, &String::from_utf8_lossy(&buf[..n]), false);
        if !safe.is_empty() {
            emit(StreamPart::Chunk(safe.into_bytes()))?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use eg_core::providers::{
        plan_request, save_custom, CustomProvider, CustomProviderStore, Protocol, ProxyRequest,
    };
    use eg_core::secrets::{KeyService, MemoryStore};
    use std::collections::BTreeMap;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::AtomicBool;
    use std::sync::Mutex;
    use std::thread;

    static LOOPBACK_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn loopback_request(port: u16) -> PlannedRequest {
        let keys = KeyService::new(MemoryStore::default(), Default::default());
        let mut custom = CustomProviderStore::in_memory();
        let provider = CustomProvider {
            id: "custom:loopback".into(),
            label: "Loopback".into(),
            base_url: format!("http://127.0.0.1:{port}/v1"),
            default_model: "loopback-model".into(),
            headers: BTreeMap::new(),
            protocol: Protocol::Openai,
            models: vec![],
        };
        save_custom(&mut custom, &keys, &provider, None).unwrap();
        let req = ProxyRequest {
            target: provider.id,
            method: "POST".into(),
            url: format!("http://127.0.0.1:{port}/v1/chat/completions"),
            body: Some(r#"{"stream":true}"#.into()),
        };
        plan_request(&req, &keys, &custom).unwrap()
    }

    fn serve_once(status: u16, body: Vec<u8>) -> (u16, thread::JoinHandle<()>) {
        serve_response(status, body, Duration::ZERO, None)
    }

    fn serve_response(
        status: u16,
        body: Vec<u8>,
        body_delay: Duration,
        advertised_length: Option<usize>,
    ) -> (u16, thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            read_request(&mut stream);
            let reason = match status {
                200 => "OK",
                503 => "Service Unavailable",
                _ => "Test",
            };
            let header = format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                advertised_length.unwrap_or(body.len())
            );
            let _ = stream.write_all(header.as_bytes());
            let _ = stream.flush();
            if !body_delay.is_zero() {
                thread::sleep(body_delay);
            }
            let _ = stream.write_all(&body);
            let _ = stream.flush();
        });
        (port, handle)
    }

    fn serve_malformed_chunked(body: Vec<u8>) -> (u16, thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            read_request(&mut stream);
            let header = b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
            let _ = stream.write_all(header);
            let _ = stream.write_all(format!("{:X}\r\n", body.len()).as_bytes());
            let _ = stream.write_all(&body);
            let _ = stream.write_all(b"\r\nZZ\r\n");
            let _ = stream.flush();
        });
        (port, handle)
    }

    fn read_request(stream: &mut TcpStream) {
        let mut buf = [0_u8; 4096];
        let _ = stream.read(&mut buf);
    }

    fn collect_parts(parts: Vec<StreamPart>) -> (u16, Vec<u8>) {
        let mut iter = parts.into_iter();
        let status = match iter.next().unwrap() {
            StreamPart::Headers(status) => status,
            StreamPart::Chunk(_) => panic!("stream emitted body before status"),
        };
        let body = iter
            .filter_map(|part| match part {
                StreamPart::Headers(_) => None,
                StreamPart::Chunk(bytes) => Some(bytes),
            })
            .flatten()
            .collect();
        (status, body)
    }

    #[test]
    fn execute_stream_emits_status_and_response_bytes() {
        let _guard = LOOPBACK_TEST_LOCK.lock().unwrap();
        let body = b"data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\ndata: [DONE]\n\n"
            .to_vec();
        let expected = body.clone();
        let (port, server) = serve_once(200, body);
        let plan = loopback_request(port);
        let mut parts = Vec::new();
        execute_stream(&plan, &AtomicBool::new(false), |part| {
            parts.push(part);
            Ok(())
        })
        .unwrap();
        server.join().unwrap();
        let (status, actual) = collect_parts(parts);
        assert_eq!(status, 200);
        assert_eq!(actual, expected);
    }

    #[test]
    fn execute_stream_delivers_headers_before_delayed_body() {
        let _guard = LOOPBACK_TEST_LOCK.lock().unwrap();
        let body = b"data: first\n\n".to_vec();
        let (port, server) = serve_response(200, body.clone(), Duration::from_millis(25), None);
        let plan = loopback_request(port);
        let started = Instant::now();
        let mut headers_at = None;
        let mut chunk_at = None;
        let mut actual = Vec::new();
        execute_stream(&plan, &AtomicBool::new(false), |part| {
            match part {
                StreamPart::Headers(_) => headers_at = Some(Instant::now()),
                StreamPart::Chunk(bytes) => {
                    chunk_at = Some(Instant::now());
                    actual.extend(bytes);
                }
            }
            Ok(())
        })
        .unwrap();
        server.join().unwrap();
        let headers_at = headers_at.expect("headers event");
        let chunk_at = chunk_at.expect("body chunk event");
        assert_eq!(actual, body);
        assert!(headers_at.duration_since(started) < chunk_at.duration_since(started));
        assert!(chunk_at.duration_since(headers_at) >= Duration::from_millis(10));
    }

    #[test]
    fn execute_stream_maps_idle_read_timeout_without_losing_headers() {
        let _guard = LOOPBACK_TEST_LOCK.lock().unwrap();
        let body = b"data: eventually\n\n".to_vec();
        let (port, server) = serve_response(200, body, Duration::from_millis(100), None);
        let plan = loopback_request(port);
        let mut parts = Vec::new();
        let error = execute_stream_with_budget(
            &plan,
            &AtomicBool::new(false),
            |part| {
                parts.push(part);
                Ok(())
            },
            Duration::from_millis(20),
            Duration::from_millis(200),
        )
        .expect_err("an idle response should hit the read timeout");
        server.join().unwrap();
        assert_eq!(error.code, "timeout");
        assert!(parts
            .iter()
            .any(|part| matches!(part, StreamPart::Headers(200))));
    }

    #[test]
    fn execute_stream_keeps_http_error_status_for_policy_layer() {
        let _guard = LOOPBACK_TEST_LOCK.lock().unwrap();
        let body = br#"{"error":{"message":"upstream unavailable"}}"#.to_vec();
        let (port, server) = serve_once(503, body.clone());
        let plan = loopback_request(port);
        let mut parts = Vec::new();
        execute_stream(&plan, &AtomicBool::new(false), |part| {
            parts.push(part);
            Ok(())
        })
        .unwrap();
        server.join().unwrap();
        let (status, actual) = collect_parts(parts);
        assert_eq!(status, 503);
        assert_eq!(actual, body);
    }

    #[test]
    fn execute_stream_surfaces_truncated_body_as_network_failure() {
        let _guard = LOOPBACK_TEST_LOCK.lock().unwrap();
        let body = b"data: partial\n\n".to_vec();
        let (port, server) = serve_malformed_chunked(body);
        let plan = loopback_request(port);
        let mut parts = Vec::new();
        let error = execute_stream(&plan, &AtomicBool::new(false), |part| {
            parts.push(part);
            Ok(())
        })
        .expect_err("a malformed chunked response must fail");
        server.join().unwrap();
        assert_eq!(error.code, "network");
        assert!(parts
            .iter()
            .any(|part| matches!(part, StreamPart::Headers(200))));
        assert!(parts
            .iter()
            .any(|part| matches!(part, StreamPart::Chunk(_))));
    }

    #[test]
    fn execute_stream_honors_cancellation_before_reading_body() {
        let _guard = LOOPBACK_TEST_LOCK.lock().unwrap();
        let (port, server) = serve_once(200, vec![b'x'; 64 * 1024]);
        let plan = loopback_request(port);
        let cancelled = AtomicBool::new(true);
        let mut parts = Vec::new();
        execute_stream(&plan, &cancelled, |part| {
            parts.push(part);
            Ok(())
        })
        .unwrap();
        server.join().unwrap();
        assert_eq!(parts.len(), 1, "cancelled stream must emit status only");
        assert!(matches!(parts[0], StreamPart::Headers(200)));
    }

    #[test]
    fn execute_stream_stops_after_callback_cancels() {
        let _guard = LOOPBACK_TEST_LOCK.lock().unwrap();
        let (port, server) = serve_once(200, vec![b'x'; 64 * 1024]);
        let plan = loopback_request(port);
        let cancelled = AtomicBool::new(false);
        let mut parts = Vec::new();
        execute_stream(&plan, &cancelled, |part| {
            if matches!(part, StreamPart::Chunk(_)) {
                cancelled.store(true, Ordering::Relaxed);
            }
            parts.push(part);
            Ok(())
        })
        .unwrap();
        server.join().unwrap();
        let chunks = parts
            .iter()
            .filter(|part| matches!(part, StreamPart::Chunk(_)))
            .count();
        assert_eq!(
            chunks, 1,
            "cancellation after first chunk must stop the read loop"
        );
    }
}
