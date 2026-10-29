//! SSE client for desktop edit session events.
//!
//! Opens a long-lived GET connection to the API's session events
//! endpoint. Parses incoming `data: {...}\n\n` frames and dispatches
//! them to the session manager.

use futures_util::StreamExt;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

use crate::session_manager::SessionManager;
use crate::types::ErrorResponse;

const RECONNECT_DELAY: Duration = Duration::from_secs(5);
const STATUS_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_SSE_FRAME_BYTES: usize = 1024 * 1024;
const TAKEN_OVER_CODE: &str = "desktop_edit_session_taken_over";

#[derive(Debug, serde::Deserialize)]
struct SseEvent {
  #[serde(rename = "type")]
  event_type: String,
  data: serde_json::Value,
}

enum RemoteSessionStatus {
  Closed(String),
  Open,
  Retry,
  TakenOver(String),
}

/// Spawn an SSE listener for a session. Reconnects automatically
/// on disconnect. Returns when the session is removed.
pub fn spawn_sse_listener(
  manager: Arc<Mutex<SessionManager>>,
  session_id: String,
  _api_base_url: String,
) -> tokio::task::JoinHandle<()> {
  tokio::spawn(async move {
    loop {
      let Some((client, current_api_base_url, session_token)) = ({
        let mgr = manager.lock().await;
        mgr.remote_status_probe_details(&session_id)
      }) else {
        return;
      };

      // Replace localhost with 127.0.0.1 to avoid IPv6 resolution
      // issues with reqwest on macOS.
      let base = current_api_base_url.replace("localhost", "127.0.0.1");
      let url = format!(
        "{base}/v1/desktop-edit-sessions/\
         {session_id}/events"
      );

      tracing::info!(session_id = %session_id, "SSE connecting");

      tracing::debug!(session_id = %session_id, "SSE sending request");
      let response = match client
        .get(&url)
        .bearer_auth(&session_token)
        .header("Accept", "text/event-stream")
        .send()
        .await
      {
        Ok(r) => {
          tracing::info!(
            session_id = %session_id,
            status = r.status().as_u16(),
            "SSE got response"
          );
          if !r.status().is_success() {
            let status = r.status().as_u16();
            tracing::warn!(session_id = %session_id, status, "SSE rejected");

            match classify_sse_rejection(status) {
              SseRejection::ProbeStatus => {
                match probe_remote_session_status(&manager, &session_id).await {
                  RemoteSessionStatus::Open | RemoteSessionStatus::Retry => {}
                  RemoteSessionStatus::Closed(message) => {
                    manager
                      .lock()
                      .await
                      .close_remote_session_public(&session_id, &message)
                      .await;
                    return;
                  }
                  RemoteSessionStatus::TakenOver(message) => {
                    manager
                      .lock()
                      .await
                      .mark_session_taken_over_public(&session_id, &message)
                      .await;
                    return;
                  }
                }
              }
              SseRejection::Retry => {}
            }

            tokio::time::sleep(RECONNECT_DELAY).await;
            if !manager.lock().await.session_exists(&session_id) {
              return;
            }
            continue;
          }
          r
        }
        Err(e) => {
          tracing::debug!(
            session_id = %session_id,
            error = %e,
            "SSE connection failed, retrying"
          );
          tokio::time::sleep(RECONNECT_DELAY).await;
          if !manager.lock().await.session_exists(&session_id) {
            return;
          }
          continue;
        }
      };

      tracing::info!(session_id = %session_id, "SSE connected");

      let mut stream = response.bytes_stream();
      let mut byte_buf: Vec<u8> = Vec::new();

      while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
          Ok(c) => c,
          Err(e) => {
            tracing::debug!(
              session_id = %session_id,
              error = %e,
              "SSE stream error"
            );
            break;
          }
        };

        let Some(frames) = drain_sse_frames(&mut byte_buf, &chunk) else {
          tracing::warn!(
            session_id = %session_id,
            max_frame_bytes = MAX_SSE_FRAME_BYTES,
            "SSE frame exceeded the byte limit"
          );
          break;
        };

        // Only decode UTF-8 on frame boundaries to avoid corrupting
        // multi-byte characters split across chunks.
        for frame_bytes in frames {
          let Ok(frame) = String::from_utf8(frame_bytes) else {
            continue;
          };

          for line in frame.lines() {
            if let Some(json_str) = line.strip_prefix("data: ")
              && let Ok(event) = serde_json::from_str::<SseEvent>(json_str)
            {
              handle_sse_event(&manager, &session_id, &event).await;
            }
          }
        }
      }

      tracing::info!(session_id = %session_id, "SSE disconnected, reconnecting");

      if !manager.lock().await.session_exists(&session_id) {
        return;
      }
      tokio::time::sleep(RECONNECT_DELAY).await;
    }
  })
}

/// Appends `chunk` and returns the SSE frames (terminated by `\n\n`) it
/// completed, leaving the unterminated remainder in `buffer`. The byte limit
/// applies to each frame and to the remainder, never to a chunk that carries
/// several frames; `None` means one of them exceeded it.
fn drain_sse_frames(buffer: &mut Vec<u8>, chunk: &[u8]) -> Option<Vec<Vec<u8>>> {
  buffer.extend_from_slice(chunk);
  let mut frames = Vec::new();
  while let Some(pos) = find_double_newline(buffer) {
    if pos > MAX_SSE_FRAME_BYTES {
      return None;
    }
    frames.push(buffer[..pos].to_vec());
    buffer.drain(..pos + 2);
  }
  // A frame at the limit may wait for the second byte of its delimiter.
  let pending_delimiter = usize::from(buffer.last() == Some(&b'\n'));
  (buffer.len() <= MAX_SSE_FRAME_BYTES + pending_delimiter).then_some(frames)
}

#[derive(Debug, PartialEq, Eq)]
enum SseRejection {
  ProbeStatus,
  Retry,
}

fn classify_sse_rejection(status: u16) -> SseRejection {
  match status {
    401 | 403 | 404 | 409 => SseRejection::ProbeStatus,
    _ => SseRejection::Retry,
  }
}

async fn probe_remote_session_status(
  manager: &Arc<Mutex<SessionManager>>,
  session_id: &str,
) -> RemoteSessionStatus {
  let Some((client, api_base_url, session_token)) = ({
    let mgr = manager.lock().await;
    mgr.remote_status_probe_details(session_id)
  }) else {
    return RemoteSessionStatus::Retry;
  };

  let base = api_base_url.replace("localhost", "127.0.0.1");
  let url = format!("{base}/v1/desktop-edit-sessions/{session_id}/status");

  let response = match client
    .get(&url)
    .bearer_auth(&session_token)
    .timeout(STATUS_PROBE_TIMEOUT)
    .send()
    .await
  {
    Ok(response) => response,
    Err(error) => {
      tracing::debug!(
        session_id,
        error = %error,
        "SSE status probe failed"
      );
      return RemoteSessionStatus::Retry;
    }
  };

  let status = response.status();
  if status.is_success() {
    return RemoteSessionStatus::Open;
  }

  let error_body: Option<ErrorResponse> = response.json().await.ok();

  if status.as_u16() == 409 {
    if error_body.as_ref().and_then(|error| error.code.as_deref())
      == Some(TAKEN_OVER_CODE)
    {
      return RemoteSessionStatus::TakenOver(
        error_body
          .and_then(|error| error.message)
          .unwrap_or_else(|| "Desktop editing moved to another device.".to_string()),
      );
    }

    return RemoteSessionStatus::Closed(
      error_body
        .and_then(|error| error.message)
        .unwrap_or_else(|| "Desktop edit session was closed.".to_string()),
    );
  }

  if status.as_u16() == 404 {
    return RemoteSessionStatus::Closed(
      error_body
        .and_then(|error| error.message)
        .unwrap_or_else(|| "Desktop edit session was closed.".to_string()),
    );
  }

  if matches!(status.as_u16(), 401 | 403) {
    tracing::warn!(
      session_id,
      status = status.as_u16(),
      "SSE status probe returned authorization error; preserving local session"
    );
  }

  RemoteSessionStatus::Retry
}

async fn handle_sse_event(
  manager: &Arc<Mutex<SessionManager>>,
  session_id: &str,
  event: &SseEvent,
) {
  tracing::info!(session_id, event_type = %event.event_type, "SSE event");

  match event.event_type.as_str() {
    "takeover-requested" => {
      let requested_by = event.data["requestedBy"].as_str().unwrap_or("Another user");
      let mgr = manager.lock().await;
      mgr.show_takeover_request(session_id, requested_by);
    }
    "session-taken-over" => {
      let message = event.data["message"]
        .as_str()
        .unwrap_or("Desktop editing moved to another device.");
      manager
        .lock()
        .await
        .mark_session_taken_over_public(session_id, message)
        .await;
    }
    "session-closed" => {
      manager
        .lock()
        .await
        .close_remote_session_public(session_id, "Desktop edit session was closed.")
        .await;
    }
    _ => {
      tracing::debug!(event_type = %event.event_type, "unknown SSE event");
    }
  }
}

/// Find the position of `\n\n` in a byte slice.
fn find_double_newline(buf: &[u8]) -> Option<usize> {
  buf.windows(2).position(|w| w == b"\n\n")
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn sse_auth_or_missing_responses_probe_status_before_cleanup() {
    assert_eq!(classify_sse_rejection(401), SseRejection::ProbeStatus);
    assert_eq!(classify_sse_rejection(403), SseRejection::ProbeStatus);
    assert_eq!(classify_sse_rejection(404), SseRejection::ProbeStatus);
    assert_eq!(classify_sse_rejection(409), SseRejection::ProbeStatus);
  }

  #[test]
  fn sse_unexpected_errors_retry_without_cleanup() {
    assert_eq!(classify_sse_rejection(422), SseRejection::Retry);
    assert_eq!(classify_sse_rejection(500), SseRejection::Retry);
  }

  #[test]
  fn sse_frame_buffer_accepts_the_exact_limit() {
    let mut buffer = vec![b'x'; MAX_SSE_FRAME_BYTES - 1];
    assert_eq!(drain_sse_frames(&mut buffer, b"x"), Some(Vec::new()));
    assert_eq!(buffer.len(), MAX_SSE_FRAME_BYTES);
  }

  #[test]
  fn sse_frame_buffer_rejects_growth_past_the_limit() {
    let mut buffer = vec![b'x'; MAX_SSE_FRAME_BYTES];
    assert_eq!(drain_sse_frames(&mut buffer, b"x"), None);
  }

  #[test]
  fn sse_frame_buffer_accepts_an_exact_limit_frame_whose_delimiter_is_split() {
    let frame = vec![b'x'; MAX_SSE_FRAME_BYTES];
    let mut buffer = Vec::new();
    assert_eq!(drain_sse_frames(&mut buffer, &frame), Some(Vec::new()));
    assert_eq!(drain_sse_frames(&mut buffer, b"\n"), Some(Vec::new()));
    assert_eq!(drain_sse_frames(&mut buffer, b"\n"), Some(vec![frame]));
    assert!(buffer.is_empty());
  }

  #[test]
  fn sse_frame_buffer_rejects_a_frame_past_the_limit_awaiting_its_delimiter() {
    let mut buffer = vec![b'x'; MAX_SSE_FRAME_BYTES + 1];
    assert_eq!(drain_sse_frames(&mut buffer, b"\n"), None);
  }

  #[test]
  fn sse_frame_buffer_rejects_a_terminated_frame_past_the_limit() {
    let mut chunk = vec![b'x'; MAX_SSE_FRAME_BYTES + 1];
    chunk.extend_from_slice(b"\n\n");
    assert_eq!(drain_sse_frames(&mut Vec::new(), &chunk), None);
  }

  #[test]
  fn sse_frame_buffer_accepts_one_chunk_of_frames_each_within_the_limit() {
    let frame = vec![b'x'; MAX_SSE_FRAME_BYTES - 1];
    let mut chunk = Vec::new();
    for _ in 0..3 {
      chunk.extend_from_slice(&frame);
      chunk.extend_from_slice(b"\n\n");
    }
    chunk.extend_from_slice(b"partial");
    let mut buffer = Vec::new();
    assert_eq!(
      drain_sse_frames(&mut buffer, &chunk),
      Some(vec![frame.clone(), frame.clone(), frame])
    );
    assert_eq!(buffer, b"partial");
  }

  #[test]
  fn sse_frame_buffer_completes_a_frame_split_across_chunks() {
    let mut buffer = Vec::new();
    assert_eq!(
      drain_sse_frames(&mut buffer, b"data: {\"a\""),
      Some(Vec::new())
    );
    assert_eq!(
      drain_sse_frames(&mut buffer, b":1}\n\ndata: "),
      Some(vec![b"data: {\"a\":1}".to_vec()])
    );
    assert_eq!(buffer, b"data: ");
  }
}
