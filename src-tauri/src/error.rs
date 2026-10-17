use serde::Serialize;

/// Error returned to the renderer. Messages are content-free: they never carry prompts,
/// tool payloads, tokens, or process output.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BridgeError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}

impl BridgeError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            status: None,
        }
    }

    pub fn with_status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }
}

impl From<std::io::Error> for BridgeError {
    fn from(error: std::io::Error) -> Self {
        let code = match error.kind() {
            std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => "CONTROL_TIMEOUT",
            _ => "CONTROL_UNAVAILABLE",
        };
        Self::new(code, "control engine is unavailable")
    }
}

pub type BridgeResult<T> = Result<T, BridgeError>;
