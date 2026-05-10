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
                    let mut mgr = manager.lock().await;
                    mgr.close_remote_session_public(&session_id, &message).await;
                    return;
                  }
                  RemoteSessionStatus::TakenOver(message) => {
                    let mut mgr = manager.lock().await;
                    mgr
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

        byte_buf.extend_from_slice(&chunk);

        // Process complete SSE frames (terminated by \n\n).
        // Only decode UTF-8 on frame boundaries to avoid corrupting
        // multi-byte characters split across chunks.
        while let Some(pos) = find_double_newline(&byte_buf) {
          let frame_bytes = byte_buf[..pos].to_vec();
          byte_buf = byte_buf[pos + 2..].to_vec();

          let frame = match String::from_utf8(frame_bytes) {
            Ok(s) => s,
            Err(_) => continue,
          };

          for line in frame.lines() {
            if let Some(json_str) = line.strip_prefix("data: ") {
              if let Ok(event) = serde_json::from_str::<SseEvent>(json_str) {
                handle_sse_event(&manager, &session_id, &event).await;
              }
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
      let mut mgr = manager.lock().await;
      mgr
        .mark_session_taken_over_public(session_id, message)
        .await;
    }
    "session-closed" => {
      let mut mgr = manager.lock().await;
      mgr
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
}
