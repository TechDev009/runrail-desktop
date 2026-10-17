//! Minimal HTTP/1.1 client for the authenticated loopback control endpoint.
//!
//! Only `http://127.0.0.1:<port>` style endpoints are accepted. Responses are bounded, chunked
//! transfer encoding is decoded incrementally, and server-sent events are parsed without losing
//! partial lines across socket reads.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

use crate::error::{BridgeError, BridgeResult};

const MAX_HEADER_BYTES: usize = 32 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

fn invalid(message: &str) -> BridgeError {
    BridgeError::new("CONTROL_INVALID_RESPONSE", message)
}

fn endpoint_invalid(message: &str) -> BridgeError {
    BridgeError::new("CONTROL_ENDPOINT_INVALID", message)
}

/// Parses `http://host:port` and resolves it, rejecting anything but loopback.
pub fn loopback_address(url: &str) -> BridgeResult<SocketAddr> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| endpoint_invalid("control endpoint must use HTTP loopback"))?;
    if rest.is_empty() || rest.contains(['/', '#', '?', '@']) {
        return Err(endpoint_invalid("control endpoint is invalid"));
    }
    let (host, port) = rest
        .rsplit_once(':')
        .ok_or_else(|| endpoint_invalid("control endpoint port is missing"))?;
    let port = port
        .parse::<u16>()
        .ok()
        .filter(|port| *port != 0)
        .ok_or_else(|| endpoint_invalid("control endpoint port is invalid"))?;
    let host = match host {
        "127.0.0.1" | "localhost" => "127.0.0.1",
        "[::1]" => "::1",
        _ => return Err(endpoint_invalid("control endpoint must be loopback")),
    };
    let address = (host, port)
        .to_socket_addrs()
        .map_err(|_| endpoint_invalid("control endpoint could not be resolved"))?
        .find(|address| address.ip().is_loopback())
        .ok_or_else(|| endpoint_invalid("control endpoint must be loopback"))?;
    Ok(address)
}

pub fn connect(address: SocketAddr) -> BridgeResult<TcpStream> {
    let stream = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT)?;
    let _ = stream.set_nodelay(true);
    Ok(stream)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponseHead {
    pub status: u16,
    pub chunked: bool,
    pub content_length: Option<usize>,
    pub content_type: String,
}

/// Parses a response head. Returns `None` while the head is incomplete, otherwise the head and
/// the number of bytes it consumed.
pub fn parse_head(bytes: &[u8]) -> BridgeResult<Option<(ResponseHead, usize)>> {
    let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") else {
        if bytes.len() > MAX_HEADER_BYTES {
            return Err(invalid("control response headers are too large"));
        }
        return Ok(None);
    };
    let text = std::str::from_utf8(&bytes[..end]).map_err(|_| invalid("control response headers are invalid"))?;
    let mut lines = text.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| invalid("control response status is invalid"))?;
    let mut head = ResponseHead {
        status,
        chunked: false,
        content_length: None,
        content_type: String::new(),
    };
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match name.trim().to_ascii_lowercase().as_str() {
            "transfer-encoding" => head.chunked = value.to_ascii_lowercase().contains("chunked"),
            "content-length" => {
                head.content_length = Some(value.parse().map_err(|_| invalid("control response length is invalid"))?)
            }
            "content-type" => head.content_type = value.to_ascii_lowercase(),
            _ => {}
        }
    }
    Ok(Some((head, end + 4)))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChunkState {
    Size,
    Data(usize),
    DataEnd,
    Trailer,
    Done,
}

/// Incremental decoder for `Transfer-Encoding: chunked`.
#[derive(Debug)]
pub struct ChunkDecoder {
    state: ChunkState,
    line: Vec<u8>,
    data_end_seen: usize,
}

impl Default for ChunkDecoder {
    fn default() -> Self {
        Self {
            state: ChunkState::Size,
            line: Vec::new(),
            data_end_seen: 0,
        }
    }
}

impl ChunkDecoder {
    pub fn is_done(&self) -> bool {
        self.state == ChunkState::Done
    }

    /// Decodes `input`, appending payload bytes to `output`.
    pub fn push(&mut self, mut input: &[u8], output: &mut Vec<u8>) -> BridgeResult<()> {
        while !input.is_empty() {
            match self.state {
                ChunkState::Done => return Ok(()),
                ChunkState::Size | ChunkState::Trailer => {
                    let byte = input[0];
                    input = &input[1..];
                    if byte != b'\n' {
                        if self.line.len() >= 1024 {
                            return Err(invalid("chunked response is invalid"));
                        }
                        self.line.push(byte);
                        continue;
                    }
                    let line = std::mem::take(&mut self.line);
                    let line = line.strip_suffix(b"\r").unwrap_or(&line);
                    if self.state == ChunkState::Trailer {
                        if line.is_empty() {
                            self.state = ChunkState::Done;
                        }
                        continue;
                    }
                    let text = std::str::from_utf8(line).map_err(|_| invalid("chunked response is invalid"))?;
                    let size_text = text.split(';').next().unwrap_or_default().trim();
                    let size = usize::from_str_radix(size_text, 16).map_err(|_| invalid("chunked response size is invalid"))?;
                    self.state = if size == 0 { ChunkState::Trailer } else { ChunkState::Data(size) };
                }
                ChunkState::Data(remaining) => {
                    let take = remaining.min(input.len());
                    output.extend_from_slice(&input[..take]);
                    input = &input[take..];
                    self.state = if take == remaining {
                        self.data_end_seen = 0;
                        ChunkState::DataEnd
                    } else {
                        ChunkState::Data(remaining - take)
                    };
                }
                ChunkState::DataEnd => {
                    let byte = input[0];
                    input = &input[1..];
                    match (self.data_end_seen, byte) {
                        (0, b'\r') => self.data_end_seen = 1,
                        (0 | 1, b'\n') => self.state = ChunkState::Size,
                        _ => return Err(invalid("chunked response is invalid")),
                    }
                }
            }
        }
        Ok(())
    }
}

/// Response body reader state: chunked, fixed length, or until close.
enum BodyMode {
    Chunked(ChunkDecoder),
    Length(usize),
    UntilClose,
}

/// Performs one request and returns `(status, body)`. The per-read timeout bounds idle time, and
/// `max_bytes` bounds the decoded body.
pub fn request(
    address: SocketAddr,
    token: &str,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    read_timeout: Duration,
    max_bytes: usize,
) -> BridgeResult<(u16, Vec<u8>)> {
    let mut stream = connect(address)?;
    stream.set_read_timeout(Some(read_timeout))?;
    stream.set_write_timeout(Some(Duration::from_secs(30)))?;
    let payload = body.unwrap_or_default();
    let head = format!(
        "{method} {path} HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {token}\r\nAccept: application/json\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
        payload.len()
    );
    stream.write_all(head.as_bytes())?;
    if !payload.is_empty() {
        stream.write_all(payload)?;
    }
    let mut buffer = vec![0_u8; 16 * 1024];
    let mut pending = Vec::new();
    let (head, consumed) = loop {
        let count = stream.read(&mut buffer)?;
        if count == 0 {
            return Err(invalid("control response ended before headers"));
        }
        pending.extend_from_slice(&buffer[..count]);
        if let Some(parsed) = parse_head(&pending)? {
            break parsed;
        }
    };
    let mut mode = if head.chunked {
        BodyMode::Chunked(ChunkDecoder::default())
    } else if let Some(length) = head.content_length {
        if length > max_bytes {
            return Err(BridgeError::new("CONTROL_RESPONSE_LIMIT", "control response is too large"));
        }
        BodyMode::Length(length)
    } else {
        BodyMode::UntilClose
    };
    let until_close = matches!(mode, BodyMode::UntilClose);
    let mut output = Vec::new();
    let mut feed =|bytes: &[u8], output: &mut Vec<u8>| -> BridgeResult<bool> {
        match &mut mode {
            BodyMode::Chunked(decoder) => {
                decoder.push(bytes, output)?;
                Ok(decoder.is_done())
            }
            BodyMode::Length(length) => {
                let take = (*length - output.len()).min(bytes.len());
                output.extend_from_slice(&bytes[..take]);
                Ok(output.len() >= *length)
            }
            BodyMode::UntilClose => {
                output.extend_from_slice(bytes);
                Ok(false)
            }
        }
    };
    let mut complete = feed(&pending[consumed..], &mut output)?;
    while !complete {
        if output.len() > max_bytes {
            return Err(BridgeError::new("CONTROL_RESPONSE_LIMIT", "control response is too large"));
        }
        let count = stream.read(&mut buffer)?;
        if count == 0 {
            if until_close {
                break;
            }
            return Err(invalid("control response was truncated"));
        }
        complete = feed(&buffer[..count], &mut output)?;
    }
    if output.len() > max_bytes {
        return Err(BridgeError::new("CONTROL_RESPONSE_LIMIT", "control response is too large"));
    }
    Ok((head.status, output))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub event: String,
    pub id: Option<String>,
    pub data: String,
}

/// Incremental `text/event-stream` parser. Keeps partial lines between pushes and bounds both
/// line and event size.
#[derive(Debug)]
pub struct SseParser {
    line: Vec<u8>,
    event: String,
    id: Option<String>,
    data: String,
    has_data: bool,
    max_event_bytes: usize,
}

impl SseParser {
    pub fn new(max_event_bytes: usize) -> Self {
        Self {
            line: Vec::new(),
            event: String::new(),
            id: None,
            data: String::new(),
            has_data: false,
            max_event_bytes,
        }
    }

    pub fn push(&mut self, bytes: &[u8], events: &mut Vec<SseEvent>) -> BridgeResult<()> {
        for &byte in bytes {
            if byte != b'\n' {
                if self.line.len() >= self.max_event_bytes {
                    return Err(BridgeError::new("CONTROL_EVENT_LIMIT", "event frame is too large"));
                }
                self.line.push(byte);
                continue;
            }
            let mut line = std::mem::take(&mut self.line);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.line_complete(&line, events)?;
            self.line = line;
            self.line.clear();
        }
        Ok(())
    }

    fn line_complete(&mut self, line: &[u8], events: &mut Vec<SseEvent>) -> BridgeResult<()> {
        if line.is_empty() {
            if self.has_data {
                events.push(SseEvent {
                    event: if self.event.is_empty() { "message".into() } else { std::mem::take(&mut self.event) },
                    id: self.id.take(),
                    data: std::mem::take(&mut self.data),
                });
            }
            self.event.clear();
            self.id = None;
            self.data.clear();
            self.has_data = false;
            return Ok(());
        }
        if line[0] == b':' {
            return Ok(());
        }
        let text = std::str::from_utf8(line).map_err(|_| BridgeError::new("CONTROL_INVALID_EVENT", "event frame is not UTF-8"))?;
        let (field, value) = match text.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (text, ""),
        };
        match field {
            "event" => self.event = value.to_string(),
            "id" => self.id = Some(value.to_string()),
            "data" => {
                if self.has_data {
                    self.data.push('\n');
                }
                self.data.push_str(value);
                self.has_data = true;
                if self.data.len() > self.max_event_bytes {
                    return Err(BridgeError::new("CONTROL_EVENT_LIMIT", "event frame is too large"));
                }
            }
            _ => {}
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_decoder_handles_split_input() {
        let body = b"5\r\nhello\r\n7;ext=1\r\n, world\r\n0\r\nTrailer: x\r\n\r\n";
        for split in 1..body.len() {
            let mut decoder = ChunkDecoder::default();
            let mut output = Vec::new();
            decoder.push(&body[..split], &mut output).unwrap();
            decoder.push(&body[split..], &mut output).unwrap();
            assert_eq!(output, b"hello, world", "split at {split}");
            assert!(decoder.is_done());
        }
        let mut decoder = ChunkDecoder::default();
        let mut output = Vec::new();
        for byte in body.iter() {
            decoder.push(std::slice::from_ref(byte), &mut output).unwrap();
        }
        assert_eq!(output, b"hello, world");
        assert!(decoder.is_done());
    }

    #[test]
    fn chunk_decoder_rejects_garbage() {
        let mut decoder = ChunkDecoder::default();
        let mut output = Vec::new();
        assert!(decoder.push(b"zz\r\n", &mut output).is_err());
        let mut decoder = ChunkDecoder::default();
        assert!(decoder.push(b"2\r\nabX", &mut output).is_err());
    }

    #[test]
    fn sse_parser_keeps_partial_lines_and_names() {
        let stream = b": keep-alive\n\nevent: runrail.event\nid: 3\ndata: {\"seq\":3}\n\nevent: runrail.live\r\nid: live-1\r\ndata: {\"a\":\r\ndata: 1}\r\n\r\n";
        for split in 1..stream.len() {
            let mut parser = SseParser::new(1024);
            let mut events = Vec::new();
            parser.push(&stream[..split], &mut events).unwrap();
            parser.push(&stream[split..], &mut events).unwrap();
            assert_eq!(events.len(), 2, "split at {split}");
            assert_eq!(events[0], SseEvent { event: "runrail.event".into(), id: Some("3".into()), data: "{\"seq\":3}".into() });
            assert_eq!(events[1].event, "runrail.live");
            assert_eq!(events[1].id.as_deref(), Some("live-1"));
            assert_eq!(events[1].data, "{\"a\":\n1}");
        }
    }

    #[test]
    fn sse_parser_bounds_events() {
        let mut parser = SseParser::new(16);
        let mut events = Vec::new();
        assert!(parser.push(b"data: 0123456789abcdefXYZ\n", &mut events).is_err());
    }

    #[test]
    fn head_parser_reads_status_and_encoding() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nTransfer-Encoding: chunked\r\n\r\nrest";
        let (head, consumed) = parse_head(raw).unwrap().unwrap();
        assert_eq!(head.status, 200);
        assert!(head.chunked);
        assert!(head.content_type.starts_with("text/event-stream"));
        assert_eq!(&raw[consumed..], b"rest");
        assert!(parse_head(b"HTTP/1.1 200 OK\r\n").unwrap().is_none());
    }

    #[test]
    fn loopback_only() {
        assert!(loopback_address("http://127.0.0.1:4000").is_ok());
        assert!(loopback_address("http://localhost:4000").is_ok());
        assert!(loopback_address("http://10.0.0.1:4000").is_err());
        assert!(loopback_address("http://127.0.0.1:0").is_err());
        assert!(loopback_address("http://127.0.0.1:4000/x").is_err());
        assert!(loopback_address("https://127.0.0.1:4000").is_err());
        assert!(loopback_address("http://user@127.0.0.1:4000").is_err());
    }
}
