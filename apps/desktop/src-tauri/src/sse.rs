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

const RECONNECT_DELAY: Duration = Duration::from_secs(5);

#[derive(Debug, serde::Deserialize)]
struct SseEvent {
  #[serde(rename = "type")]
  event_type: String,
  data: serde_json::Value,
}

/// Spawn an SSE listener for a session. Reconnects automatically
/// on disconnect. Returns when the session is removed.
pub fn spawn_sse_listener(
  manager: Arc<Mutex<SessionManager>>,
  session_id: String,
  api_base_url: String,
) -> tokio::task::JoinHandle<()> {
  tokio::spawn(async move {
    loop {
      // SSE endpoint authenticates by session ID + open status only
      // (no token needed; it was validated on open_docx).
      // Replace localhost with 127.0.0.1 to avoid IPv6 resolution
      // issues with reqwest on macOS.
      let base = api_base_url.replace("localhost", "127.0.0.1");
      let url = format!(
        "{base}/v1/desktop-edit-sessions/\
         {session_id}/events"
      );

      tracing::info!(session_id = %session_id, "SSE connecting");

      let client = reqwest::Client::builder()
        .http1_only()
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
      tracing::debug!(session_id = %session_id, "SSE sending request");
      let response = match client
        .get(&url)
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
            if status == 404 || status == 409 || status == 401 {
              let mut mgr = manager.lock().await;
              if status == 409 {
                mgr
                  .mark_session_taken_over_public(
                    &session_id,
                    "Desktop editing moved to another device.",
                  )
                  .await;
              } else {
                mgr
                  .close_remote_session_public(
                    &session_id,
                    "Desktop edit session was closed.",
                  )
                  .await;
              }
            }
            return;
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
