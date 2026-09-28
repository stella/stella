//! Keeping the window a PIN prompt is parented to alive for as long as the
//! store may use it.
//!
//! A store that shows its own PIN prompt is handed the dialog's native
//! window handle. The handle is only valid while the window exists, and the
//! store holds on to it for the whole native call, which can outlive the
//! flow that started it (the flow gives up after a timeout; the call cannot
//! be interrupted). So the window's lifetime and the native call are tied
//! together here:
//!
//! - a native call starts only while the window is open, and a window closed
//!   before that point turns the signature into [`SigningErrorCode::Cancelled`];
//! - while a call is in flight, closing the window is deferred, and the
//!   deferred close runs once the call returns.

use std::sync::{Arc, Mutex, PoisonError};

use crate::{Signer, SigningError, SigningErrorCode, SigningKeyType};

/// The signature the user gave up on by closing the dialog.
fn window_closed() -> SigningError {
  SigningError::SignatureFailed {
    code: SigningErrorCode::Cancelled,
    detail: "the signing dialog closed before the store was asked".to_string(),
  }
}

/// What the window should do with a request to close it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CloseRequest {
  /// Nothing uses the window: close it now.
  Close,
  /// A native call still uses the window: keep it, it closes when the call
  /// returns.
  Defer,
}

type DeferredClose = Box<dyn Fn() + Send + Sync>;

struct State {
  closed: bool,
  in_flight: bool,
  close_deferred: bool,
}

struct Shared {
  state: Mutex<State>,
  raw_handle: Option<isize>,
  close_later: DeferredClose,
}

/// The window a native prompt is shown over. Cloning shares it.
#[derive(Clone)]
pub struct PromptOwner(Arc<Shared>);

impl PromptOwner {
  /// `raw_handle` is the window's native handle (an `HWND` on Windows),
  /// `None` where the store places its own prompts. `close_later` closes the
  /// window once a deferred close is due; it runs with no lock held.
  pub fn new(
    raw_handle: Option<isize>,
    close_later: impl Fn() + Send + Sync + 'static,
  ) -> Self {
    Self(Arc::new(Shared {
      state: Mutex::new(State {
        closed: false,
        in_flight: false,
        close_deferred: false,
      }),
      raw_handle,
      close_later: Box::new(close_later),
    }))
  }

  /// The window was asked to close, by the user or by the flow.
  pub fn request_close(&self) -> CloseRequest {
    let mut state = self.lock();
    if state.in_flight {
      state.close_deferred = true;
      return CloseRequest::Defer;
    }
    state.closed = true;
    CloseRequest::Close
  }

  /// The window is gone, however it went.
  pub fn closed(&self) {
    self.lock().closed = true;
  }

  /// Run `native` with the window's handle while holding the window open, or
  /// report [`SigningErrorCode::Cancelled`] without running it when the window is
  /// already closed or closing.
  pub fn while_open<T>(
    &self,
    native: impl FnOnce(Option<isize>) -> Result<T, SigningError>,
  ) -> Result<T, SigningError> {
    {
      let mut state = self.lock();
      if state.closed || state.close_deferred || state.in_flight {
        return Err(window_closed());
      }
      state.in_flight = true;
    }
    let _in_flight = InFlight(self);
    native(self.0.raw_handle)
  }

  /// Sign with the signer `signer_for` makes for this window's handle, with
  /// the window held open for the length of the call.
  pub fn sign_digest<S: Signer + ?Sized>(
    &self,
    signer_for: impl FnOnce(Option<isize>) -> Box<S>,
    identity_id: &str,
    digest: &[u8; 32],
    key_type: SigningKeyType,
  ) -> Result<Vec<u8>, SigningError> {
    self.while_open(|raw_handle| {
      signer_for(raw_handle).sign_digest(identity_id, digest, key_type)
    })
  }

  fn lock(&self) -> std::sync::MutexGuard<'_, State> {
    self.0.state.lock().unwrap_or_else(PoisonError::into_inner)
  }
}

/// Marks a native call in flight; its end runs a close deferred meanwhile,
/// whether the call returned or unwound.
struct InFlight<'owner>(&'owner PromptOwner);

impl Drop for InFlight<'_> {
  fn drop(&mut self) {
    let close_now = {
      let mut state = self.0.lock();
      state.in_flight = false;
      let close_now = std::mem::take(&mut state.close_deferred);
      // The window is on its way out: nothing new may start on it.
      state.closed |= close_now;
      close_now
    };
    if close_now {
      (self.0.0.close_later)();
    }
  }
}

#[cfg(test)]
mod tests {
  use std::sync::atomic::{AtomicUsize, Ordering};
  use std::sync::mpsc;
  use std::time::Duration;

  use super::*;
  use crate::SigningIdentity;

  const HWND: isize = 0x1234;

  fn is_cancelled<T>(result: &Result<T, SigningError>) -> bool {
    matches!(result, Err(error) if error.code() == SigningErrorCode::Cancelled)
  }

  /// A store whose signature blocks until the test lets it finish, the way a
  /// PIN prompt blocks until the user answers it.
  struct PromptingSigner {
    raw_handle: Option<isize>,
    started: mpsc::Sender<()>,
    answered: mpsc::Receiver<()>,
  }

  impl Signer for PromptingSigner {
    fn list_identities(&self) -> Result<Vec<SigningIdentity>, SigningError> {
      Ok(Vec::new())
    }

    fn sign_digest(
      &self,
      _identity_id: &str,
      _digest: &[u8; 32],
      _key_type: SigningKeyType,
    ) -> Result<Vec<u8>, SigningError> {
      assert_eq!(self.raw_handle, Some(HWND));
      self.started.send(()).unwrap();
      self.answered.recv().unwrap();
      Ok(vec![1, 2, 3])
    }
  }

  fn counting_owner() -> (PromptOwner, Arc<AtomicUsize>) {
    let closes = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&closes);
    let owner = PromptOwner::new(Some(HWND), move || {
      counted.fetch_add(1, Ordering::SeqCst);
    });
    (owner, closes)
  }

  #[test]
  fn a_window_closed_while_the_signature_is_prepared_cancels_before_the_store_runs() {
    let (owner, closes) = counting_owner();

    assert_eq!(owner.request_close(), CloseRequest::Close);
    let mut reached_the_store = false;
    let result = owner.while_open(|_| {
      reached_the_store = true;
      Ok(())
    });

    assert!(is_cancelled(&result));
    assert!(!reached_the_store);
    assert_eq!(closes.load(Ordering::SeqCst), 0, "the window closed itself");
  }

  #[test]
  fn a_destroyed_window_cancels_before_the_store_runs() {
    let (owner, _) = counting_owner();

    owner.closed();

    assert!(is_cancelled(&owner.while_open(|_| Ok(()))));
  }

  /// The flow gives up on a PIN prompt after its timeout and closes the
  /// dialog; the prompt, still parented to it, keeps the dialog alive until
  /// it is answered.
  #[test]
  fn a_close_during_the_pin_prompt_waits_for_the_prompt() {
    let (owner, closes) = counting_owner();
    let (started_tx, started) = mpsc::channel();
    let (answer, answered_rx) = mpsc::channel();
    let signing_owner = owner.clone();
    let signing = std::thread::spawn(move || {
      signing_owner.sign_digest(
        |raw_handle| {
          Box::new(PromptingSigner {
            raw_handle,
            started: started_tx,
            answered: answered_rx,
          })
        },
        "id",
        &[0; 32],
        SigningKeyType::Rsa,
      )
    });
    started.recv().unwrap();
    // The flow's timeout: it stops waiting, the call does not stop.
    assert!(started.recv_timeout(Duration::from_millis(20)).is_err());

    assert_eq!(owner.request_close(), CloseRequest::Defer);
    assert_eq!(owner.request_close(), CloseRequest::Defer);
    assert_eq!(closes.load(Ordering::SeqCst), 0, "closed under the prompt");

    answer.send(()).unwrap();
    assert_eq!(signing.join().unwrap().unwrap(), vec![1, 2, 3]);
    assert_eq!(closes.load(Ordering::SeqCst), 1);
    // The deferred close is the window's last: nothing else may start on it.
    assert_eq!(owner.request_close(), CloseRequest::Close);
    assert!(is_cancelled(&owner.while_open(|_| Ok(()))));
  }

  #[test]
  fn a_close_after_the_signature_closes_at_once() {
    let (owner, closes) = counting_owner();

    assert_eq!(owner.while_open(Ok).unwrap(), Some(HWND));

    assert_eq!(owner.request_close(), CloseRequest::Close);
    assert_eq!(closes.load(Ordering::SeqCst), 0);
  }

  #[test]
  fn a_store_that_fails_still_releases_the_window() {
    let (owner, closes) = counting_owner();

    let result: Result<(), _> = owner.while_open(|_| {
      assert_eq!(owner.request_close(), CloseRequest::Defer);
      Err(SigningError::SignatureFailed {
        code: SigningErrorCode::PinIncorrect,
        detail: String::new(),
      })
    });

    assert!(
      matches!(result, Err(error) if error.code() == SigningErrorCode::PinIncorrect)
    );
    assert_eq!(closes.load(Ordering::SeqCst), 1);
  }
}
