//! Reads the member's own calendar events for one day from the stella
//! server, which holds the Microsoft 365 connection. It sends a date and a
//! time zone, never recorded activity, and keeps nothing.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::{
  account::AccountRequest,
  http_client::{DesktopHttpClient, HttpClientOptions},
  logging::{json_cause_logged, request_cause_logged},
};

const FAILURE: &str = "calendar events request failed";
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
/// The contract's bounds (`desktop-time-entries.ts`).
const MAX_EVENTS: usize = 100;
const TITLE_MAX_CHARS: usize = 256;
const TIME_ZONE_MAX_BYTES: usize = 64;

/// The member's own answer to an event. Declined events never arrive.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CalendarResponse {
  Organizer,
  Accepted,
  Tentative,
  NotAnswered,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(
  tag = "timing",
  rename_all = "camelCase",
  rename_all_fields = "camelCase",
  deny_unknown_fields
)]
pub enum CalendarEvent {
  Timed {
    title: String,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    response: CalendarResponse,
  },
  AllDay {
    title: String,
    response: CalendarResponse,
  },
}

impl CalendarEvent {
  fn is_valid(&self) -> bool {
    let (title, range_valid) = match self {
      Self::Timed {
        title, start, end, ..
      } => (title, start < end),
      Self::AllDay { title, .. } => (title, true),
    };
    range_valid
      && title.chars().count() <= TITLE_MAX_CHARS
      && !title.chars().any(char::is_control)
  }
}

/// One day of the member's calendar, or why it is not shown. `Off` is the
/// member's own choice and is answered without asking the server.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(
  tag = "status",
  rename_all = "camelCase",
  rename_all_fields = "camelCase",
  deny_unknown_fields
)]
pub enum CalendarDay {
  #[serde(skip_deserializing)]
  Off,
  Ready {
    events: Vec<CalendarEvent>,
    truncated: bool,
  },
  TurnedOff,
  NotConnected,
  NeedsReconnect,
}

impl CalendarDay {
  fn is_valid(&self) -> bool {
    match self {
      Self::Ready { events, .. } => {
        events.len() <= MAX_EVENTS && events.iter().all(CalendarEvent::is_valid)
      }
      Self::Off | Self::TurnedOff | Self::NotConnected | Self::NeedsReconnect => true,
    }
  }
}

fn client() -> Result<DesktopHttpClient, String> {
  DesktopHttpClient::new(HttpClientOptions {
    redirect: reqwest::redirect::Policy::none(),
    timeout: Some(Duration::from_secs(15)),
  })
  .map_err(request_cause_logged(FAILURE))
}

/// The events of `date` (`YYYY-MM-DD`) in `time_zone`, the member's IANA
/// zone, as the server minimised them.
pub async fn day_events(
  account: &AccountRequest,
  date: &str,
  time_zone: &str,
) -> Result<CalendarDay, String> {
  if time_zone.is_empty() || time_zone.len() > TIME_ZONE_MAX_BYTES {
    return Err(FAILURE.to_string());
  }
  let mut response = crate::http_client::device_proof_request(
    client()?
      .get(format!(
        "{}/v1/desktop/calendar-events",
        account.api_base_url
      ))
      .query(&[("date", date), ("timeZone", time_zone)]),
    &account.device_key,
    Some(&account.credential.key),
    None,
  )?
  .send()
  .await
  .map_err(request_cause_logged(FAILURE))?;
  if !response.status().is_success() {
    return Err(FAILURE.to_string());
  }
  let mut body = Vec::new();
  while let Some(chunk) = response
    .chunk()
    .await
    .map_err(request_cause_logged(FAILURE))?
  {
    if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
      return Err(FAILURE.to_string());
    }
    body.extend_from_slice(&chunk);
  }
  let day: CalendarDay =
    serde_json::from_slice(&body).map_err(json_cause_logged(FAILURE))?;
  if !day.is_valid() {
    return Err(FAILURE.to_string());
  }
  Ok(day)
}

#[cfg(test)]
mod tests {
  use super::*;
  use axum::{Json, Router, extract::OriginalUri, routing::get};

  async fn fixture(api_base_url: String) -> AccountRequest {
    let account = serde_json::from_value(serde_json::json!({
      "apiBaseUrl": api_base_url,
      "webOrigin": "https://example.test",
      "account": {"email": "fixture@example.test", "name": null, "verifiedAt": "2026-01-01T00:00:00Z"},
      "identity": {"userId": "user_fixture", "organizationId": "org_fixture"},
      "credential": {"key": "fixture_key", "expiresAt": "2099-01-01T00:00:00Z"}
    }))
    .unwrap();
    AccountRequest::fixture(account).await
  }

  fn timed(title: &str, start: &str, end: &str) -> serde_json::Value {
    serde_json::json!({
      "timing": "timed", "title": title, "start": start, "end": end,
      "response": "accepted",
    })
  }

  async fn answer(value: serde_json::Value) -> Result<CalendarDay, String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let account = fixture(format!("http://{}", listener.local_addr().unwrap())).await;
    let router = Router::new().route(
      "/v1/desktop/calendar-events",
      get(move |OriginalUri(uri): OriginalUri| {
        assert_eq!(
          uri.query(),
          Some("date=2026-10-02&timeZone=Europe%2FPrague")
        );
        let value = value.clone();
        async move { Json(value) }
      }),
    );
    let server = tokio::spawn(async move {
      axum::serve(listener, router).await.unwrap();
    });
    let day = day_events(&account, "2026-10-02", "Europe/Prague").await;
    server.abort();
    day
  }

  #[tokio::test]
  async fn a_ready_day_keeps_timed_and_all_day_events() {
    let day = answer(serde_json::json!({
      "status": "ready",
      "truncated": false,
      "events": [
        timed("Hearing", "2026-10-02T08:00:00Z", "2026-10-02T09:30:00Z"),
        {"timing": "allDay", "title": "Trial in Brno", "response": "tentative"},
      ],
    }))
    .await
    .unwrap();
    let CalendarDay::Ready { events, truncated } = day else {
      panic!("Expected a ready day");
    };
    assert!(!truncated);
    assert_eq!(events.len(), 2);
    assert!(matches!(
      &events[1],
      CalendarEvent::AllDay {
        response: CalendarResponse::Tentative,
        ..
      }
    ));
  }

  #[tokio::test]
  async fn unavailable_states_pass_through_and_off_never_arrives() {
    for (status, expected) in [
      ("turnedOff", CalendarDay::TurnedOff),
      ("notConnected", CalendarDay::NotConnected),
      ("needsReconnect", CalendarDay::NeedsReconnect),
    ] {
      assert_eq!(
        answer(serde_json::json!({ "status": status }))
          .await
          .unwrap(),
        expected
      );
    }
    assert!(
      answer(serde_json::json!({ "status": "off" }))
        .await
        .is_err()
    );
  }

  #[tokio::test]
  async fn malformed_or_oversized_answers_are_refused() {
    let too_many = (0..=MAX_EVENTS)
      .map(|_| timed("Call", "2026-10-02T08:00:00Z", "2026-10-02T09:00:00Z"))
      .collect::<Vec<_>>();
    for value in [
      serde_json::json!({ "status": "ready", "truncated": true, "events": too_many }),
      serde_json::json!({ "status": "ready", "truncated": false, "events": [
        timed("Backwards", "2026-10-02T09:00:00Z", "2026-10-02T08:00:00Z"),
      ]}),
      serde_json::json!({ "status": "ready", "truncated": false, "events": [
        timed(&"x".repeat(TITLE_MAX_CHARS + 1), "2026-10-02T08:00:00Z", "2026-10-02T09:00:00Z"),
      ]}),
      serde_json::json!({ "status": "ready", "truncated": false, "events": [
        timed("Line\nbreak", "2026-10-02T08:00:00Z", "2026-10-02T09:00:00Z"),
      ]}),
      // An attendee list is never part of the answer.
      serde_json::json!({ "status": "ready", "truncated": false, "events": [{
        "timing": "allDay", "title": "Board", "response": "accepted",
        "attendees": ["someone@example.test"],
      }]}),
      serde_json::json!({ "status": "ready", "truncated": false, "events": [{
        "timing": "allDay", "title": "Board", "response": "declined",
      }]}),
    ] {
      assert!(answer(value).await.is_err());
    }
  }

  #[test]
  fn an_off_day_serializes_for_the_window() {
    assert_eq!(
      serde_json::to_value(CalendarDay::Off).unwrap(),
      serde_json::json!({ "status": "off" })
    );
  }
}
