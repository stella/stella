use std::time::Duration;

/// Minted by the app only after verifying the clipboard window and app origin.
pub struct LocalWindowProof {
  _private: (),
}
impl LocalWindowProof {
  pub fn verified_local_window() -> Self {
    Self { _private: () }
  }
}

/// JSON prepared inside the history boundary for the verified webview.
pub struct WebviewPayload(Vec<u8>);
impl WebviewPayload {
  pub(crate) fn from_serializable(
    value: &impl serde::Serialize,
  ) -> Result<Self, String> {
    serde_json::to_vec(value)
      .map(Self)
      .map_err(|_| "clipboard response could not be encoded".to_string())
  }
  pub fn into_ipc_body(self) -> Vec<u8> {
    self.0
  }
}

#[derive(Clone, Copy)]
pub enum HistoryErrorCode {
  InitializationLockPoisoned,
  LockPoisoned,
  FormatReadFailed,
  PersistenceFailed,
  ClipboardUnavailable,
  WatcherUnavailable,
}
#[derive(Clone, Copy)]
pub enum HistorySpan {
  Initialize,
  KeychainRead,
  StoreLoad,
}

pub trait HistoryObserver: Send + Sync {
  fn changed(&self);
  fn error(&self, code: HistoryErrorCode);
  fn timing(&self, span: HistorySpan, duration: Duration, item_count: Option<usize>);
}

#[cfg(test)]
pub(crate) struct TestHistoryObserver;
#[cfg(test)]
impl HistoryObserver for TestHistoryObserver {
  fn changed(&self) {}
  fn error(&self, _code: HistoryErrorCode) {}
  fn timing(
    &self,
    _span: HistorySpan,
    _duration: Duration,
    _item_count: Option<usize>,
  ) {
  }
}
