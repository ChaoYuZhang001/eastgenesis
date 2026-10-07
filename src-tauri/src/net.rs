//! 执行已由 eg_core::providers::plan_request 校验、加好鉴权头的请求。
//! JSON 请求用同步 ureq；流式请求异步等待网络和取消。不跟随重定向，防止鉴权头被带到别的主机。
use std::collections::HashMap;
use std::future::{poll_fn, Future};
use std::io::Read;
use std::pin::pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::Poll;
use std::time::{Duration, Instant};
use tokio::sync::Notify;

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

/// One waiter per stream. The flag remembers cancellation, while notify_one
/// stores a permit even when cancellation arrives just before an await.
#[derive(Default)]
pub struct StreamCancellation {
    cancelled: AtomicBool,
    wakeup: Notify,
}

impl StreamCancellation {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.wakeup.notify_one();
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    async fn cancelled(&self) {
        while !self.is_cancelled() {
            self.wakeup.notified().await;
        }
    }
}

enum StreamEntry {
    Active(Arc<StreamCancellation>),
    CancelledBeforeStart(Instant),
    Finished(Instant),
}

/// Retain short-lived IDs to handle cancel-before-register and reject reuse.
/// Capacity is fail-closed: a full registry cannot start an untracked stream.
#[derive(Default)]
pub struct StreamRegistry {
    entries: HashMap<String, StreamEntry>,
}

impl StreamRegistry {
    const CAPACITY: usize = 256;

    fn prune(&mut self) {
        let now = Instant::now();
        self.entries.retain(|_, entry| match entry {
            StreamEntry::Active(_) => true,
            StreamEntry::CancelledBeforeStart(expires) | StreamEntry::Finished(expires) => {
                *expires > now
            }
        });
    }

    pub fn register(&mut self, id: &str) -> AppResult<Arc<StreamCancellation>> {
        self.prune();
        let cancelled = match self.entries.get(id) {
            Some(StreamEntry::Active(_) | StreamEntry::Finished(_)) => {
                return Err(AppError::new("duplicate_stream_id", "流式请求标识已使用"));
            }
            Some(StreamEntry::CancelledBeforeStart(_)) => true,
            None if self.entries.len() >= Self::CAPACITY => {
                return Err(AppError::new(
                    "stream_capacity",
                    "流式请求登记已满，请稍后重试",
                ));
            }
            None => false,
        };
        let signal = Arc::new(StreamCancellation::default());
        if cancelled {
            signal.cancel();
        }
        self.entries
            .insert(id.to_owned(), StreamEntry::Active(signal.clone()));
        Ok(signal)
    }

    pub fn cancel(&mut self, id: &str) -> AppResult<()> {
        self.prune();
        match self.entries.get(id) {
            Some(StreamEntry::Active(signal)) => signal.cancel(),
            Some(StreamEntry::CancelledBeforeStart(_) | StreamEntry::Finished(_)) => {}
            None => {
                if self.entries.len() >= Self::CAPACITY {
                    return Err(AppError::new(
                        "stream_capacity",
                        "流式请求登记已满，请稍后重试",
                    ));
                }
                self.entries.insert(
                    id.to_owned(),
                    StreamEntry::CancelledBeforeStart(Instant::now() + STREAM_TOTAL_TIMEOUT),
                );
            }
        }
        Ok(())
    }

    pub fn finish(&mut self, id: &str, signal: &Arc<StreamCancellation>) {
        if matches!(self.entries.get(id), Some(StreamEntry::Active(active)) if Arc::ptr_eq(active, signal))
        {
            self.entries.insert(
                id.to_owned(),
                StreamEntry::Finished(Instant::now() + STREAM_TOTAL_TIMEOUT),
            );
        }
    }
}

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
        .take(MAX_RESPONSE as u64 + 1)
        .read_to_end(&mut buf)
        .map_err(|e| {
            AppError::new("network", "读取响应失败").with_detail(p.scrub(&e.to_string()))
        })?;
    if buf.len() > MAX_RESPONSE {
        return Err(response_too_large());
    }
    let body = std::str::from_utf8(&buf).map_err(|_| response_invalid_utf8())?;
    Ok(ProxyResponse {
        status,
        body: p.scrub(body),
    })
}

/// Execute a Provider request without buffering the response body. The first
/// callback is the HTTP status; subsequent callbacks contain response bytes.
/// Authentication is already attached to `PlannedRequest`, and every chunk is
/// scrubbed before leaving the Rust process.
pub async fn execute_stream<F>(
    p: &PlannedRequest,
    cancelled: &StreamCancellation,
    mut emit: F,
) -> AppResult<()>
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
    .await
}

fn stream_timeout() -> AppError {
    AppError::new("timeout", "Provider 响应超时")
}

fn response_invalid_utf8() -> AppError {
    AppError::new("invalid_response", "Provider 响应不是完整的 UTF-8 文本")
}

fn response_too_large() -> AppError {
    AppError::new(
        "response_too_large",
        "Provider 响应超过 16 MiB 上限，已停止读取",
    )
}

/// Decode only complete characters. A successful read retains at most three
/// bytes until the next read; malformed bytes never become replacement text.
/// Return the valid prefix before reporting an invalid sequence so already
/// received text can still reach the partial-output path.
fn decode_stream_utf8(pending: &mut Vec<u8>, incoming: &[u8]) -> (String, bool) {
    pending.extend_from_slice(incoming);
    let (valid, invalid) = match std::str::from_utf8(pending) {
        Ok(_) => (pending.len(), false),
        Err(error) => (error.valid_up_to(), error.error_len().is_some()),
    };
    let text = std::str::from_utf8(&pending[..valid])
        .expect("validated UTF-8 prefix")
        .to_owned();
    pending.drain(..valid);
    if invalid {
        pending.clear();
    }
    (text, invalid)
}

/// Poll cancellation first, then the absolute deadline, then the network.
/// Dropping this future drops send/chunk immediately, including a held socket.
async fn await_stream_io<T>(
    cancelled: &StreamCancellation,
    deadline: Instant,
    io: impl Future<Output = Result<T, reqwest::Error>>,
    p: &PlannedRequest,
    message: &str,
) -> AppResult<Option<T>> {
    let mut cancellation = pin!(cancelled.cancelled());
    let mut timeout = pin!(tokio::time::sleep_until(deadline.into()));
    let mut io = pin!(io);
    poll_fn(|cx| {
        if cancellation.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Ok(None));
        }
        if timeout.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(stream_timeout()));
        }
        let Poll::Ready(result) = io.as_mut().poll(cx) else {
            return Poll::Pending;
        };
        // A concurrent cancel must win even when network readiness was
        // observed during this poll, before any bytes leave Rust.
        if cancelled.is_cancelled() {
            return Poll::Ready(Ok(None));
        }
        if Instant::now() >= deadline {
            return Poll::Ready(Err(stream_timeout()));
        }
        Poll::Ready(result.map(Some).map_err(|e| {
            if e.is_timeout() {
                stream_timeout()
            } else {
                AppError::new("network", message).with_detail(p.scrub(&e.to_string()))
            }
        }))
    })
    .await
}

async fn execute_stream_with_budget<F>(
    p: &PlannedRequest,
    cancelled: &StreamCancellation,
    mut emit: F,
    read_timeout: Duration,
    total_timeout: Duration,
) -> AppResult<()>
where
    F: FnMut(StreamPart) -> AppResult<()>,
{
    let deadline = Instant::now() + total_timeout;
    if cancelled.is_cancelled() {
        return Ok(());
    }
    let client = reqwest::ClientBuilder::new()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(read_timeout)
        .timeout(total_timeout)
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
    let Some(mut resp) =
        await_stream_io(cancelled, deadline, req.send(), p, "无法连接 Provider").await?
    else {
        return Ok(());
    };
    if cancelled.is_cancelled() {
        return Ok(());
    }
    if Instant::now() >= deadline {
        return Err(stream_timeout());
    }
    emit(StreamPart::Headers(resp.status().as_u16()))?;
    let mut pending = String::new();
    let mut utf8_tail = Vec::new();
    let mut remaining = MAX_RESPONSE;
    loop {
        if cancelled.is_cancelled() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(stream_timeout());
        }
        // Reaching the byte budget is not EOF. Await the real body terminal
        // under the same cancellation/deadline rules; any additional body
        // bytes are an explicit failure and never enter decoding or IPC.
        let Some(chunk) =
            await_stream_io(cancelled, deadline, resp.chunk(), p, "读取响应失败").await?
        else {
            return Ok(());
        };
        let Some(chunk) = chunk else {
            if cancelled.is_cancelled() {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(stream_timeout());
            }
            if !utf8_tail.is_empty() {
                return Err(response_invalid_utf8());
            }
            let safe = p.scrub_stream(&mut pending, "", true);
            if !safe.is_empty() {
                if cancelled.is_cancelled() {
                    return Ok(());
                }
                if Instant::now() >= deadline {
                    return Err(stream_timeout());
                }
                emit(StreamPart::Chunk(safe.into_bytes()))?;
            }
            if cancelled.is_cancelled() {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(stream_timeout());
            }
            return Ok(());
        };
        let n = chunk.len().min(remaining);
        remaining -= n;
        // Provider responses are text (JSON or SSE); incremental redaction
        // runs after decoding, retaining only a possible secret prefix.
        let (text, invalid_utf8) = decode_stream_utf8(&mut utf8_tail, &chunk[..n]);
        let safe = p.scrub_stream(&mut pending, &text, false);
        if !safe.is_empty() {
            if cancelled.is_cancelled() {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(stream_timeout());
            }
            emit(StreamPart::Chunk(safe.into_bytes()))?;
        }
        if cancelled.is_cancelled() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(stream_timeout());
        }
        if chunk.len() > n {
            return Err(response_too_large());
        }
        if invalid_utf8 {
            return Err(response_invalid_utf8());
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
    use std::sync::Mutex;
    use std::thread;

    static LOOPBACK_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn loopback_test_guard() -> std::sync::MutexGuard<'static, ()> {
        // The lock only serializes independent sockets; it protects no state
        // that another test could corrupt. Preserve the original failure
        // without turning every subsequent test into a PoisonError.
        LOOPBACK_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn execute_stream<F>(
        p: &PlannedRequest,
        cancelled: &StreamCancellation,
        emit: F,
    ) -> AppResult<()>
    where
        F: FnMut(StreamPart) -> AppResult<()>,
    {
        execute_stream_with_budget(
            p,
            cancelled,
            emit,
            STREAM_READ_TIMEOUT,
            STREAM_TOTAL_TIMEOUT,
        )
    }

    fn execute_stream_with_budget<F>(
        p: &PlannedRequest,
        cancelled: &StreamCancellation,
        emit: F,
        read_timeout: Duration,
        total_timeout: Duration,
    ) -> AppResult<()>
    where
        F: FnMut(StreamPart) -> AppResult<()>,
    {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(super::execute_stream_with_budget(
                p,
                cancelled,
                emit,
                read_timeout,
                total_timeout,
            ))
    }

    fn loopback_request(port: u16) -> PlannedRequest {
        loopback_request_with_secret(port, None)
    }

    fn loopback_request_with_secret(port: u16, secret: Option<&str>) -> PlannedRequest {
        let keys = KeyService::new(MemoryStore::default(), Default::default());
        let mut custom = CustomProviderStore::in_memory();
        let provider = CustomProvider {
            id: "custom:loopback".into(),
            label: "Loopback".into(),
            // Production deliberately skips keys on loopback providers.
            // Build an authenticated synthetic plan first, then route only
            // the test's socket destination to the local TCP fixture.
            base_url: if secret.is_some() {
                "https://synthetic-redaction.example/v1".into()
            } else {
                format!("http://127.0.0.1:{port}/v1")
            },
            default_model: "loopback-model".into(),
            headers: BTreeMap::new(),
            protocol: Protocol::Openai,
            models: vec![],
        };
        save_custom(&mut custom, &keys, &provider, secret).unwrap();
        let req = ProxyRequest {
            target: provider.id,
            method: "POST".into(),
            url: format!("{}/chat/completions", provider.base_url),
            body: Some(r#"{"stream":true}"#.into()),
        };
        let mut plan = plan_request(&req, &keys, &custom).unwrap();
        plan.url = format!("http://127.0.0.1:{port}/v1/chat/completions");
        plan
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
            read_request(&mut stream).unwrap();
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
            read_request(&mut stream).unwrap();
            let header = b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
            let _ = stream.write_all(header);
            let _ = stream.write_all(format!("{:X}\r\n", body.len()).as_bytes());
            let _ = stream.write_all(&body);
            let _ = stream.write_all(b"\r\nZZ\r\n");
            let _ = stream.flush();
        });
        (port, handle)
    }

    /// HTTP chunk boundaries plus callback acknowledgements force separate
    /// body reads even when a loaded runner batches otherwise adjacent writes.
    /// A disconnect is reported to the test, rather than panicking on the
    /// server and masking the client's actual timeout/error with join failure.
    fn serve_gated_chunks(
        chunks: Vec<Vec<u8>>,
        delay: Duration,
    ) -> (
        u16,
        std::sync::mpsc::Sender<()>,
        thread::JoinHandle<std::io::Result<()>>,
    ) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (release, acknowledgement) = std::sync::mpsc::channel();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept()?;
            stream.set_write_timeout(Some(Duration::from_secs(5)))?;
            read_request(&mut stream)?;
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n")?;
            for chunk in chunks {
                if !delay.is_zero() {
                    thread::sleep(delay);
                }
                stream.write_all(format!("{:X}\r\n", chunk.len()).as_bytes())?;
                stream.write_all(&chunk)?;
                stream.write_all(b"\r\n")?;
                stream.flush()?;
                acknowledgement
                    .recv_timeout(Duration::from_secs(5))
                    .map_err(|_| {
                        std::io::Error::new(
                            std::io::ErrorKind::TimedOut,
                            "fixture did not receive a body acknowledgement",
                        )
                    })?;
            }
            stream.write_all(b"0\r\n\r\n")?;
            stream.flush()
        });
        (port, release, handle)
    }

    /// Keep the response body unavailable until the client call has returned.
    /// A timed sleep can finish while a loaded runner deschedules the client,
    /// turning the intended idle-read case into an already buffered success.
    fn serve_held_body(
        body: Vec<u8>,
    ) -> (u16, std::sync::mpsc::Sender<()>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (release, held) = std::sync::mpsc::channel();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            read_request(&mut stream).unwrap();
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()
            );
            let _ = stream.write_all(header.as_bytes());
            let _ = stream.flush();
            // The one-second fallback bounds a broken-client test, not the
            // production timeout. Normal cleanup releases immediately.
            let _ = held.recv_timeout(Duration::from_secs(1));
            let _ = stream.write_all(&body);
            let _ = stream.flush();
        });
        (port, release, handle)
    }

    fn read_request(stream: &mut TcpStream) -> std::io::Result<()> {
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut buf = [0_u8; 4096];
        let mut received = Vec::new();
        // Consume the short fixture request body before closing a response;
        // closing with unread POST bytes can reset the socket on macOS.
        while received.len() < 8192 {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "fixture request was incomplete",
                    )
                })?;
            stream.set_read_timeout(Some(remaining))?;
            let n = stream.read(&mut buf)?;
            if n == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "fixture request was incomplete",
                ));
            }
            received.extend_from_slice(&buf[..n]);
            if let Some(end) = received.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                let length = String::from_utf8_lossy(&received[..end])
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
                if received.len() >= end + 4 + length {
                    return Ok(());
                }
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "fixture request exceeded its bound",
        ))
    }

    #[derive(Clone, Copy)]
    enum HeldPhase {
        BeforeHeaders,
        Body,
        AfterFirstChunk,
    }

    /// Only report a client EOF/reset. There is no release/cleanup signal;
    /// the two-second fixture bound never counts as an observed peer close.
    fn serve_observed_hold(
        phase: HeldPhase,
    ) -> (
        u16,
        std::sync::mpsc::Receiver<()>,
        std::sync::mpsc::Sender<()>,
        std::sync::mpsc::Receiver<Instant>,
        thread::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (ready_tx, ready) = std::sync::mpsc::channel();
        let (late, late_rx) = std::sync::mpsc::channel();
        let (closed_tx, closed) = std::sync::mpsc::channel();
        let handle = thread::spawn(move || {
            let fixture_deadline = Instant::now() + Duration::from_secs(2);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(e)
                        if e.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < fixture_deadline =>
                    {
                        thread::sleep(Duration::from_millis(2))
                    }
                    _ => return,
                }
            };
            // Accepted sockets may inherit nonblocking mode on macOS.
            // The request read below relies on bounded blocking reads.
            stream.set_nonblocking(false).unwrap();
            read_request(&mut stream).unwrap();
            // The short timeout belongs to peer-close observation, after
            // request framing is complete; it must not truncate a POST.
            stream
                .set_read_timeout(Some(Duration::from_millis(10)))
                .unwrap();
            if !matches!(phase, HeldPhase::BeforeHeaders) {
                stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 1048576\r\nConnection: close\r\n\r\n").unwrap();
            }
            if matches!(phase, HeldPhase::AfterFirstChunk) {
                stream.write_all(b"data: first\n\n").unwrap();
            }
            stream.flush().unwrap();
            let _ = ready_tx.send(());
            let mut buf = [0_u8; 4096];
            while Instant::now() < fixture_deadline {
                if late_rx.try_recv().is_ok() {
                    let _ = stream.write_all(b"data: late-after-cancel\n\n");
                    let _ = stream.flush();
                }
                match stream.read(&mut buf) {
                    Ok(0) => {
                        let _ = closed_tx.send(Instant::now());
                        return;
                    }
                    Err(e)
                        if matches!(
                            e.kind(),
                            std::io::ErrorKind::ConnectionReset
                                | std::io::ErrorKind::ConnectionAborted
                        ) =>
                    {
                        let _ = closed_tx.send(Instant::now());
                        return;
                    }
                    Ok(_) => {}
                    Err(e)
                        if matches!(
                            e.kind(),
                            std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                        ) => {}
                    Err(_) => return,
                }
            }
        });
        (port, ready, late, closed, handle)
    }

    #[test]
    fn held_fixture_waits_for_complete_request_before_responding() {
        let _guard = loopback_test_guard();
        let (port, ready, _late, closed, server) = serve_observed_hold(HeldPhase::AfterFirstChunk);
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let body = br#"{"stream":true}"#;
        client
            .write_all(
                format!(
            "POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\n\r\n",
            body.len()
        )
                .as_bytes(),
            )
            .unwrap();
        client.flush().unwrap();
        client
            .set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        let mut byte = [0_u8; 1];
        let error = client
            .read(&mut byte)
            .expect_err("fixture responded before the POST body arrived");
        assert!(matches!(
            error.kind(),
            std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
        ));
        client.write_all(body).unwrap();
        client.flush().unwrap();
        ready.recv_timeout(Duration::from_secs(1)).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        assert_eq!(client.read(&mut byte).unwrap(), 1);
        assert_eq!(byte, [b'H']);
        client.shutdown(std::net::Shutdown::Both).unwrap();
        closed.recv_timeout(Duration::from_secs(1)).unwrap();
        server.join().unwrap();
    }

    fn assert_prompt_close(cancelled_at: Instant, finished_at: Instant, peer_at: Option<Instant>) {
        let peer_at = peer_at.expect("fixture must observe client EOF/reset before cleanup");
        assert!(
            finished_at.duration_since(cancelled_at) < Duration::from_millis(500),
            "cancelled worker returned too late"
        );
        assert!(
            peer_at.duration_since(cancelled_at) < Duration::from_millis(500),
            "cancelled socket closed too late"
        );
        eprintln!(
            "cancel worker={}ms peer_close={}ms",
            finished_at.duration_since(cancelled_at).as_millis(),
            peer_at.duration_since(cancelled_at).as_millis()
        );
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
    fn execute_json_checks_actual_response_limit_and_valid_utf8() {
        let _guard = loopback_test_guard();
        for size in [MAX_RESPONSE - 1, MAX_RESPONSE, MAX_RESPONSE + 1] {
            let mut body = vec![b'x'; size];
            body[0] = b'"';
            body[size - 1] = b'"';
            let (port, server) = serve_once(200, body);
            let result = execute(&loopback_request(port));
            server.join().unwrap();
            if size > MAX_RESPONSE {
                assert_eq!(result.unwrap_err().code, "response_too_large");
            } else {
                let response = result.unwrap();
                assert_eq!(response.status, 200);
                assert_eq!(response.body.len(), size);
                assert!(serde_json::from_str::<String>(&response.body).is_ok());
            }
        }
        for body in [b"{\"ok\":true}\xe4\xb8".to_vec(), vec![0xff]] {
            let (port, server) = serve_once(200, body);
            let result = execute(&loopback_request(port));
            server.join().unwrap();
            let error = result.unwrap_err();
            assert_eq!(error.code, "invalid_response");
            assert!(error.detail.is_none());
        }
    }

    #[test]
    fn execute_json_preserves_unicode_scrubbing_and_rejects_truncated_transport() {
        let _guard = loopback_test_guard();
        let secret = "synthetic-loopback-secret-0123456789";
        let body = format!("{{\"message\":\"中文 🌍 {secret}\"}}").into_bytes();
        let (port, server) = serve_once(200, body);
        let result = execute(&loopback_request_with_secret(port, Some(secret)));
        server.join().unwrap();
        assert_eq!(result.unwrap().body, "{\"message\":\"中文 🌍 [REDACTED]\"}");

        let (port, server) = serve_response(200, b"{\"ok\":".to_vec(), Duration::ZERO, Some(100));
        let result = execute(&loopback_request(port));
        server.join().unwrap();
        assert_eq!(result.unwrap_err().code, "network");
    }

    #[test]
    fn execute_stream_emits_status_and_response_bytes() {
        let _guard = loopback_test_guard();
        let body = b"data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\ndata: [DONE]\n\n"
            .to_vec();
        let expected = body.clone();
        let (port, server) = serve_once(200, body);
        let plan = loopback_request(port);
        let mut parts = Vec::new();
        execute_stream(&plan, &StreamCancellation::default(), |part| {
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
    fn execute_stream_decodes_utf8_across_acknowledged_body_chunks() {
        let _guard = loopback_test_guard();
        let chunks = vec![
            b"data: A \xe4".to_vec(),
            b"\xb8\xad B \xf0\x9f".to_vec(),
            b"\x8c\x8d C \xe6\x96".to_vec(),
            b"\x87\n\n".to_vec(),
        ];
        let (port, release, server) = serve_gated_chunks(chunks, Duration::ZERO);
        let mut parts = Vec::new();
        let result = execute_stream(
            &loopback_request(port),
            &StreamCancellation::default(),
            |part| {
                if matches!(part, StreamPart::Chunk(_)) {
                    let _ = release.send(());
                }
                parts.push(part);
                Ok(())
            },
        );
        drop(release);
        let server_result = server.join().unwrap();
        result.unwrap();
        server_result.unwrap();
        let (_, actual) = collect_parts(parts);
        assert_eq!(
            String::from_utf8(actual).unwrap(),
            "data: A 中 B 🌍 C 文\n\n"
        );
    }

    #[test]
    fn execute_stream_rejects_incomplete_or_invalid_utf8_preserving_valid_prefix() {
        let _guard = loopback_test_guard();
        for tail in [vec![0xe4, 0xb8], vec![0xff], vec![0xf0, 0x9f, b'x']] {
            let prefix = b"data: valid partial\n\n";
            let mut body = prefix.to_vec();
            body.extend(tail);
            let (port, server) = serve_once(200, body);
            let mut parts = Vec::new();
            let result = execute_stream(
                &loopback_request(port),
                &StreamCancellation::default(),
                |part| {
                    parts.push(part);
                    Ok(())
                },
            );
            server.join().unwrap();
            let error = result.expect_err("malformed UTF-8 must not finish successfully");
            assert_eq!(error.code, "invalid_response");
            assert!(
                error.detail.is_none(),
                "invalid response bytes must not enter errors"
            );
            let (status, actual) = collect_parts(parts);
            assert_eq!(status, 200);
            assert_eq!(actual, prefix);
        }
    }

    #[test]
    fn execute_stream_accepts_real_eof_at_and_below_response_limit() {
        let _guard = loopback_test_guard();
        for size in [MAX_RESPONSE - 1, MAX_RESPONSE] {
            let (port, server) = serve_once(200, vec![b'x'; size]);
            let mut received = 0;
            let result = execute_stream(
                &loopback_request(port),
                &StreamCancellation::default(),
                |part| {
                    if let StreamPart::Chunk(bytes) = part {
                        assert!(bytes.iter().all(|byte| *byte == b'x'));
                        received += bytes.len();
                    }
                    Ok(())
                },
            );
            server.join().unwrap();
            result.unwrap();
            assert_eq!(received, size);
        }
    }

    #[test]
    fn execute_stream_rejects_one_byte_over_response_limit_preserving_budgeted_output() {
        let _guard = loopback_test_guard();
        // Known Content-Length and unknown chunked length must both reject
        // actual extra bytes; the latter cannot be decided from headers.
        for gated in [false, true] {
            let (port, release, server) = if gated {
                let (port, release, server) =
                    serve_gated_chunks(vec![vec![b'x'; MAX_RESPONSE], vec![b'y']], Duration::ZERO);
                (port, Some(release), server)
            } else {
                let (port, server) = serve_once(200, vec![b'x'; MAX_RESPONSE + 1]);
                (
                    port,
                    None,
                    thread::spawn(move || {
                        server.join().unwrap();
                        Ok(())
                    }),
                )
            };
            let mut received = 0;
            let result = execute_stream(
                &loopback_request(port),
                &StreamCancellation::default(),
                |part| {
                    if let StreamPart::Chunk(bytes) = part {
                        assert!(bytes.iter().all(|byte| *byte == b'x'));
                        received += bytes.len();
                        if received == MAX_RESPONSE {
                            if let Some(release) = &release {
                                let _ = release.send(());
                            }
                        }
                    }
                    Ok(())
                },
            );
            drop(release);
            // The overflow frame deliberately receives no acknowledgement;
            // its sender may observe the client close instead of final EOF.
            let _ = server.join().unwrap();
            assert_eq!(result.unwrap_err().code, "response_too_large");
            assert_eq!(received, MAX_RESPONSE);
        }
    }

    #[test]
    fn execute_stream_never_replaces_a_character_cut_by_eof_or_response_limit() {
        let _guard = loopback_test_guard();
        for complete_character in [false, true] {
            let mut body = vec![b'x'; MAX_RESPONSE - 2];
            body.extend([0xe4, 0xb8]);
            if complete_character {
                body.push(0xad);
            }
            let (port, server) = serve_once(200, body);
            let mut received = 0;
            let result = execute_stream(
                &loopback_request(port),
                &StreamCancellation::default(),
                |part| {
                    if let StreamPart::Chunk(bytes) = part {
                        assert!(bytes.iter().all(|byte| *byte == b'x'));
                        received += bytes.len();
                    }
                    Ok(())
                },
            );
            server.join().unwrap();
            assert_eq!(
                result.unwrap_err().code,
                if complete_character {
                    "response_too_large"
                } else {
                    "invalid_response"
                }
            );
            assert_eq!(received, MAX_RESPONSE - 2);
        }
    }

    #[test]
    fn execute_stream_cancels_while_waiting_for_eof_at_response_limit() {
        let _guard = loopback_test_guard();
        let (port, release, server) =
            serve_gated_chunks(vec![vec![b'x'; MAX_RESPONSE]], Duration::ZERO);
        let signal = Arc::new(StreamCancellation::default());
        let controller_signal = signal.clone();
        let (at_limit_tx, at_limit_rx) = std::sync::mpsc::channel();
        let controller = thread::spawn(move || {
            let at_limit = at_limit_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            thread::sleep(Duration::from_millis(25));
            controller_signal.cancel();
            at_limit
        });
        let mut received = 0;
        let result = execute_stream_with_budget(
            &loopback_request(port),
            &signal,
            |part| {
                if let StreamPart::Chunk(bytes) = part {
                    received += bytes.len();
                    if received == MAX_RESPONSE {
                        at_limit_tx.send(Instant::now()).unwrap();
                    }
                }
                Ok(())
            },
            Duration::from_secs(2),
            Duration::from_secs(5),
        );
        let finished_at = Instant::now();
        drop(release);
        let _ = server.join().unwrap();
        let at_limit = controller.join().unwrap();
        result.unwrap();
        assert_eq!(received, MAX_RESPONSE);
        assert!(
            finished_at.duration_since(at_limit) >= Duration::from_millis(20),
            "byte budget must not manufacture EOF"
        );
        assert!(finished_at.duration_since(at_limit) < Duration::from_secs(1));
    }

    #[test]
    fn execute_stream_scrubs_secret_across_utf8_and_response_body_boundaries() {
        let _guard = loopback_test_guard();
        let secret = "synthetic-loopback-secret-0123456789";
        let (port, release, server) = serve_gated_chunks(
            vec![
                b"data: \xe4".to_vec(),
                b"\xb8\xad synthetic-loopback-".to_vec(),
                b"secret-0123456789 done\n\n".to_vec(),
            ],
            Duration::ZERO,
        );
        let plan = loopback_request_with_secret(port, Some(secret));
        let mut actual = Vec::new();
        let result = execute_stream(&plan, &StreamCancellation::default(), |part| {
            if let StreamPart::Chunk(bytes) = part {
                assert!(!String::from_utf8_lossy(&bytes).contains(secret));
                actual.extend(bytes);
                let _ = release.send(());
            }
            Ok(())
        });
        drop(release);
        let server_result = server.join().unwrap();
        result.unwrap();
        server_result.unwrap();
        assert_eq!(
            String::from_utf8(actual).unwrap(),
            "data: 中 [REDACTED] done\n\n"
        );
    }

    #[test]
    fn execute_stream_delivers_headers_before_delayed_body() {
        let _guard = loopback_test_guard();
        let body = b"data: first\n\n".to_vec();
        let (port, server) = serve_response(200, body.clone(), Duration::from_millis(25), None);
        let plan = loopback_request(port);
        let started = Instant::now();
        let mut headers_at = None;
        let mut chunk_at = None;
        let mut actual = Vec::new();
        execute_stream(&plan, &StreamCancellation::default(), |part| {
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
        let _guard = loopback_test_guard();
        // Delaying the headers callback deterministically models a client
        // descheduled after receipt. Neither case may release the idle body.
        for callback_delay in [Duration::ZERO, Duration::from_millis(150)] {
            let body = b"data: eventually\n\n".to_vec();
            let (port, release, server) = serve_held_body(body);
            let plan = loopback_request(port);
            let mut parts = Vec::new();
            let result = execute_stream_with_budget(
                &plan,
                &StreamCancellation::default(),
                |part| {
                    if matches!(part, StreamPart::Headers(_)) && !callback_delay.is_zero() {
                        thread::sleep(callback_delay);
                    }
                    parts.push(part);
                    Ok(())
                },
                Duration::from_millis(20),
                Duration::from_millis(200),
            );
            // Release and join before assertions even if the client fails.
            let _ = release.send(());
            server.join().unwrap();
            let error = result.expect_err("an idle response should hit the read timeout");
            assert_eq!(error.code, "timeout");
            assert!(parts
                .iter()
                .any(|part| matches!(part, StreamPart::Headers(200))));
            assert!(
                !parts
                    .iter()
                    .any(|part| matches!(part, StreamPart::Chunk(_))),
                "the held response must not deliver body bytes before the timeout"
            );
        }
    }

    #[test]
    fn execute_stream_keeps_http_error_status_for_policy_layer() {
        let _guard = loopback_test_guard();
        let body = br#"{"error":{"message":"upstream unavailable"}}"#.to_vec();
        let (port, server) = serve_once(503, body.clone());
        let plan = loopback_request(port);
        let mut parts = Vec::new();
        execute_stream(&plan, &StreamCancellation::default(), |part| {
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
        let _guard = loopback_test_guard();
        let body = b"data: partial\n\n".to_vec();
        let (port, server) = serve_malformed_chunked(body);
        let plan = loopback_request(port);
        let mut parts = Vec::new();
        let error = execute_stream(&plan, &StreamCancellation::default(), |part| {
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
        let _guard = loopback_test_guard();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let plan = loopback_request(listener.local_addr().unwrap().port());
        let cancelled = StreamCancellation::default();
        // Signal before a cancellation future exists. It must remain observed.
        cancelled.cancel();
        let started = Instant::now();
        let mut parts = Vec::new();
        execute_stream(&plan, &cancelled, |part| {
            parts.push(part);
            Ok(())
        })
        .unwrap();
        assert!(parts.is_empty(), "pre-cancelled stream must emit no events");
        assert!(started.elapsed() < Duration::from_millis(500));
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn execute_stream_stops_after_callback_cancels() {
        let _guard = loopback_test_guard();
        let (port, server) = serve_once(200, vec![b'x'; 64 * 1024]);
        let plan = loopback_request(port);
        let cancelled = StreamCancellation::default();
        let mut parts = Vec::new();
        execute_stream(&plan, &cancelled, |part| {
            if matches!(part, StreamPart::Chunk(_)) {
                cancelled.cancel();
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

    #[test]
    fn execute_stream_cancels_pending_headers_and_closes_socket() {
        let _guard = loopback_test_guard();
        let (port, ready, _late, closed, server) = serve_observed_hold(HeldPhase::BeforeHeaders);
        let plan = loopback_request(port);
        let signal = Arc::new(StreamCancellation::default());
        let controller_signal = signal.clone();
        let controller = thread::spawn(move || {
            ready.recv_timeout(Duration::from_secs(1)).unwrap();
            thread::sleep(Duration::from_millis(25));
            let at = Instant::now();
            controller_signal.cancel();
            at
        });
        let mut parts = Vec::new();
        let result = execute_stream_with_budget(
            &plan,
            &signal,
            |part| {
                parts.push(part);
                Ok(())
            },
            Duration::from_millis(800),
            Duration::from_secs(1),
        );
        let finished_at = Instant::now();
        let cancelled_at = controller.join().unwrap();
        let peer_at = closed.recv_timeout(Duration::from_millis(500)).ok();
        server.join().unwrap();
        result.unwrap();
        assert!(
            parts.is_empty(),
            "cancel before headers must emit no late status/body"
        );
        assert_prompt_close(cancelled_at, finished_at, peer_at);
    }

    #[test]
    fn execute_stream_cancels_idle_body_and_closes_socket() {
        let _guard = loopback_test_guard();
        let (port, _ready, _late, closed, server) = serve_observed_hold(HeldPhase::Body);
        let plan = loopback_request(port);
        let signal = Arc::new(StreamCancellation::default());
        let controller_signal = signal.clone();
        let (headers_tx, headers_rx) = std::sync::mpsc::channel();
        let controller = thread::spawn(move || {
            headers_rx.recv_timeout(Duration::from_secs(1)).unwrap();
            thread::sleep(Duration::from_millis(25));
            let at = Instant::now();
            controller_signal.cancel();
            at
        });
        let mut parts = Vec::new();
        let result = execute_stream_with_budget(
            &plan,
            &signal,
            |part| {
                if matches!(part, StreamPart::Headers(_)) {
                    headers_tx.send(()).unwrap();
                }
                parts.push(part);
                Ok(())
            },
            Duration::from_millis(800),
            Duration::from_secs(1),
        );
        let finished_at = Instant::now();
        let cancelled_at = controller.join().unwrap();
        let peer_at = closed.recv_timeout(Duration::from_millis(500)).ok();
        server.join().unwrap();
        result.unwrap();
        assert_eq!(
            parts.len(),
            1,
            "idle cancellation must retain headers without body"
        );
        assert_prompt_close(cancelled_at, finished_at, peer_at);
    }

    #[test]
    fn execute_stream_cancels_after_partial_output_without_late_chunk() {
        let _guard = loopback_test_guard();
        let (port, _ready, late, closed, server) = serve_observed_hold(HeldPhase::AfterFirstChunk);
        let plan = loopback_request(port);
        let signal = StreamCancellation::default();
        let mut cancelled_at = None;
        let mut body = Vec::new();
        let result = execute_stream_with_budget(
            &plan,
            &signal,
            |part| {
                if let StreamPart::Chunk(bytes) = part {
                    assert!(cancelled_at.is_none(), "no chunk may follow cancellation");
                    body.extend(bytes);
                    cancelled_at = Some(Instant::now());
                    signal.cancel();
                    // Deliberately make more bytes ready after signalling cancel.
                    let _ = late.send(());
                }
                Ok(())
            },
            Duration::from_millis(800),
            Duration::from_secs(1),
        );
        let finished_at = Instant::now();
        let peer_at = closed.recv_timeout(Duration::from_millis(500)).ok();
        server.join().unwrap();
        result.unwrap();
        assert_eq!(body, b"data: first\n\n");
        assert_prompt_close(cancelled_at.unwrap(), finished_at, peer_at);
    }

    #[test]
    fn execute_stream_total_deadline_caps_headers_and_idle_body() {
        let _guard = loopback_test_guard();
        for phase in [HeldPhase::BeforeHeaders, HeldPhase::Body] {
            let (port, _ready, _late, closed, server) = serve_observed_hold(phase);
            let plan = loopback_request(port);
            let started = Instant::now();
            let mut parts = Vec::new();
            let result = execute_stream_with_budget(
                &plan,
                &StreamCancellation::default(),
                |part| {
                    parts.push(part);
                    Ok(())
                },
                Duration::from_millis(800),
                Duration::from_millis(120),
            );
            let finished = started.elapsed();
            let peer_at = closed.recv_timeout(Duration::from_millis(500)).ok();
            server.join().unwrap();
            assert_eq!(result.unwrap_err().code, "timeout");
            assert!(
                finished >= Duration::from_millis(100) && finished < Duration::from_millis(500)
            );
            assert!(peer_at.unwrap().duration_since(started) < Duration::from_millis(500));
            assert!(!parts
                .iter()
                .any(|part| matches!(part, StreamPart::Chunk(_))));
        }
    }

    #[test]
    fn execute_stream_allows_valid_stream_longer_than_read_timeout() {
        let _guard = loopback_test_guard();
        let chunk = b"data: continuing\n\n";
        // These independent experiment budgets allow scheduling margin while
        // the full response still outlives one idle-read budget. Production
        // remains read=60s / total=180s.
        let (port, release, server) =
            serve_gated_chunks(vec![chunk.to_vec(); 5], Duration::from_millis(250));
        let started = Instant::now();
        let mut parts = Vec::new();
        let result = execute_stream_with_budget(
            &loopback_request(port),
            &StreamCancellation::default(),
            |part| {
                if matches!(part, StreamPart::Chunk(_)) {
                    let _ = release.send(());
                }
                parts.push(part);
                Ok(())
            },
            Duration::from_secs(1),
            Duration::from_secs(5),
        );
        drop(release);
        let server_result = server.join().unwrap();
        // Surface a client timeout before a resulting server BrokenPipe.
        result.unwrap();
        server_result.unwrap();
        let (_, body) = collect_parts(parts);
        assert_eq!(body, chunk.repeat(5));
        assert!(
            started.elapsed() >= Duration::from_millis(1250),
            "valid response must outlive one read budget"
        );
    }

    #[test]
    fn stream_registry_remembers_precancel_and_rejects_reuse_with_bounded_records() {
        let mut registry = StreamRegistry::default();
        registry.cancel("early").unwrap();
        let signal = registry.register("early").unwrap();
        assert!(signal.is_cancelled());
        assert!(
            matches!(registry.entries.get("early"), Some(StreamEntry::Active(_))),
            "pending cancellation is consumed once"
        );
        assert!(matches!(registry.register("early"), Err(e) if e.code == "duplicate_stream_id"));
        registry.finish("early", &Arc::new(StreamCancellation::default()));
        assert!(
            matches!(registry.entries.get("early"), Some(StreamEntry::Active(_))),
            "unrelated cleanup cannot remove a current stream"
        );
        registry.finish("early", &signal);
        registry.cancel("early").unwrap();
        assert!(matches!(registry.register("early"), Err(e) if e.code == "duplicate_stream_id"));
        for i in 1..StreamRegistry::CAPACITY {
            registry.cancel(&format!("pending-{i}")).unwrap();
        }
        assert!(matches!(registry.cancel("overflow"), Err(e) if e.code == "stream_capacity"));
        assert!(matches!(registry.register("overflow"), Err(e) if e.code == "stream_capacity"));
        registry.entries.insert(
            "early".into(),
            StreamEntry::Finished(Instant::now() - Duration::from_secs(1)),
        );
        registry.prune();
        assert!(registry.register("after-expiry").is_ok());
    }
}
