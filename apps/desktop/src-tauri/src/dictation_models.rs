//! The stella AI model list a dictation chooses its model from, kept in
//! memory for a short while so a dictation does not wait for the list after
//! the key is released.
//!
//! One list is kept, for one account: a lookup for another account, a list
//! older than [`TTL`], a failed read, a link, unlink or relink and every read
//! the Settings window makes all leave it unused, and the list is read again.
//! A dictation starts its lookup when the key is pressed, so the read runs
//! beside recording; its first request to stella AI takes what that lookup
//! found while it was for the account the request goes to. Nothing here is
//! written to disk.

#![cfg_attr(
  not(dictation),
  allow(dead_code, reason = "only builds with the speech engine transcribe")
)]

use std::{
  future::Future,
  sync::{Mutex, OnceLock, PoisonError},
  time::{Duration, Instant},
};

use crate::dictation_cloud::CloudModels;

/// How long a model list answers dictations without being read again.
pub const TTL: Duration = Duration::from_secs(10 * 60);

/// Monotonic time, as the span since a fixed moment.
pub trait Clock {
  fn now(&self) -> Duration;
}

/// The process's monotonic clock.
pub struct Monotonic;

impl Clock for Monotonic {
  fn now(&self) -> Duration {
    static ORIGIN: OnceLock<Instant> = OnceLock::new();
    ORIGIN.get_or_init(Instant::now).elapsed()
  }
}

/// Why the cache could not answer a lookup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Miss {
  /// Nothing kept: never read, or forgotten since.
  Empty,
  /// Kept for another account.
  OtherAccount,
  /// Older than [`TTL`].
  Expired,
}

/// Where a lookup found its list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
  Cached,
  Fetched(Miss),
}

/// A model list and the account it was read for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Looked {
  pub namespace: String,
  pub models: CloudModels,
  pub source: Source,
}

/// When a dictation's model list was at hand, for the local log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListRead {
  /// The cache answered.
  Cached,
  /// Read at the press, beside recording.
  AtPress,
  /// Read when the first request went out: the press could not read it,
  /// or read it for another account.
  AtRequest,
}

struct Entry {
  namespace: String,
  models: CloudModels,
  stored: Duration,
}

struct State {
  /// Raised by every [`ModelCache::forget`]: a read that started before is
  /// not kept.
  generation: u64,
  entry: Option<Entry>,
}

/// What a read stores under: the list is kept only if nothing forgot the
/// cache while it ran.
#[derive(Debug, Clone, Copy)]
pub struct Ticket {
  generation: u64,
  pub miss: Miss,
}

pub struct ModelCache<C> {
  clock: C,
  state: Mutex<State>,
}

impl<C: Clock> ModelCache<C> {
  pub const fn new(clock: C) -> Self {
    Self {
      clock,
      state: Mutex::new(State {
        generation: 0,
        entry: None,
      }),
    }
  }

  fn state(&self) -> std::sync::MutexGuard<'_, State> {
    self.state.lock().unwrap_or_else(PoisonError::into_inner)
  }

  /// The list kept for `namespace` while it is fresh, otherwise what a read
  /// for it stores under.
  pub fn get(&self, namespace: &str) -> Result<CloudModels, Ticket> {
    let state = self.state();
    let miss = match &state.entry {
      None => Miss::Empty,
      Some(entry) if entry.namespace != namespace => Miss::OtherAccount,
      Some(entry) if self.clock.now().saturating_sub(entry.stored) >= TTL => {
        Miss::Expired
      }
      Some(entry) => return Ok(entry.models.clone()),
    };
    Err(Ticket {
      generation: state.generation,
      miss,
    })
  }

  /// Keeps `models`, read for `namespace`, unless the cache was forgotten
  /// since `ticket` was handed out.
  pub fn store(&self, ticket: Ticket, namespace: &str, models: &CloudModels) {
    let mut state = self.state();
    if state.generation == ticket.generation {
      state.entry = Some(Entry {
        namespace: namespace.to_string(),
        models: models.clone(),
        stored: self.clock.now(),
      });
    }
  }

  /// Drops the list, and any read already running is not kept.
  pub fn forget(&self) {
    let mut state = self.state();
    state.generation = state.generation.wrapping_add(1);
    state.entry = None;
  }
}

/// The list for `namespace`: the kept one while fresh, otherwise `fetch`'s,
/// which is then kept. A failed read forgets what was kept.
pub async fn look_up<C, F>(
  cache: &ModelCache<C>,
  namespace: String,
  fetch: impl FnOnce() -> F,
) -> Result<Looked, String>
where
  C: Clock,
  F: Future<Output = Result<CloudModels, String>>,
{
  let ticket = match cache.get(&namespace) {
    Ok(models) => {
      return Ok(Looked {
        namespace,
        models,
        source: Source::Cached,
      });
    }
    Err(ticket) => ticket,
  };
  match fetch().await {
    Ok(models) => {
      cache.store(ticket, &namespace, &models);
      Ok(Looked {
        namespace,
        models,
        source: Source::Fetched(ticket.miss),
      })
    }
    Err(error) => {
      cache.forget();
      Err(error)
    }
  }
}

/// [`look_up`] after forgetting what was kept: the list as it is now.
pub async fn read_again<C, F>(
  cache: &ModelCache<C>,
  namespace: String,
  fetch: impl FnOnce() -> F,
) -> Result<Looked, String>
where
  C: Clock,
  F: Future<Output = Result<CloudModels, String>>,
{
  cache.forget();
  look_up(cache, namespace, fetch).await
}

/// The list a dictation's first request uses: the one its press looked up,
/// while that was for `namespace`, the account the request goes to;
/// otherwise a lookup for that account now.
pub async fn at_request<C, F>(
  cache: &ModelCache<C>,
  pressed: Option<Result<Looked, String>>,
  namespace: String,
  fetch: impl FnOnce() -> F,
) -> Result<(Looked, ListRead), String>
where
  C: Clock,
  F: Future<Output = Result<CloudModels, String>>,
{
  if let Some(Ok(looked)) = pressed
    && looked.namespace == namespace
  {
    let read = match looked.source {
      Source::Cached => ListRead::Cached,
      Source::Fetched(_) => ListRead::AtPress,
    };
    return Ok((looked, read));
  }
  let looked = look_up(cache, namespace, fetch).await?;
  let read = match looked.source {
    Source::Cached => ListRead::Cached,
    Source::Fetched(_) => ListRead::AtRequest,
  };
  Ok((looked, read))
}

/// The cache every dictation shares.
pub fn shared() -> &'static ModelCache<Monotonic> {
  static CACHE: ModelCache<Monotonic> = ModelCache::new(Monotonic);
  &CACHE
}

/// Forgets the shared list: the account was linked, unlinked or relinked.
pub fn forget() {
  shared().forget();
}

#[cfg(test)]
mod tests {
  use std::{
    cell::Cell,
    sync::{
      Arc,
      atomic::{AtomicU64, AtomicUsize, Ordering},
    },
  };

  use super::*;

  /// A clock the test moves by hand.
  #[derive(Clone, Default)]
  struct Hand(Arc<AtomicU64>);

  impl Hand {
    fn advance(&self, by: Duration) {
      let millis = u64::try_from(by.as_millis()).expect("fits");
      self.0.fetch_add(millis, Ordering::SeqCst);
    }
  }

  impl Clock for Hand {
    fn now(&self) -> Duration {
      Duration::from_millis(self.0.load(Ordering::SeqCst))
    }
  }

  fn list(model: &str) -> CloudModels {
    serde_json::from_value(serde_json::json!({
      "models": [{ "id": model, "displayName": model }],
      "defaultModelId": model,
      "unavailable": null,
    }))
    .expect("a model list")
  }

  /// Counts reads and answers each with `model`.
  fn reader<'a>(
    reads: &'a Cell<usize>,
    model: &'a str,
  ) -> impl FnOnce() -> std::future::Ready<Result<CloudModels, String>> + 'a {
    move || {
      reads.set(reads.get() + 1);
      std::future::ready(Ok(list(model)))
    }
  }

  fn failing(
    reads: &Cell<usize>,
  ) -> impl FnOnce() -> std::future::Ready<Result<CloudModels, String>> + '_ {
    move || {
      reads.set(reads.get() + 1);
      std::future::ready(Err("models read failed".to_string()))
    }
  }

  #[tokio::test]
  async fn a_kept_list_answers_without_a_read_until_it_expires() {
    let clock = Hand::default();
    let cache = ModelCache::new(clock.clone());
    let reads = Cell::new(0);
    let first = look_up(&cache, "a".into(), reader(&reads, "scribe"))
      .await
      .unwrap();
    assert_eq!(first.source, Source::Fetched(Miss::Empty));
    clock.advance(TTL - Duration::from_secs(1));
    let hit = look_up(&cache, "a".into(), reader(&reads, "other"))
      .await
      .unwrap();
    assert_eq!(hit.source, Source::Cached);
    assert_eq!(hit.models, list("scribe"));
    assert_eq!(reads.get(), 1);
    clock.advance(Duration::from_secs(1));
    let expired = look_up(&cache, "a".into(), reader(&reads, "chirp"))
      .await
      .unwrap();
    assert_eq!(expired.source, Source::Fetched(Miss::Expired));
    assert_eq!(expired.models, list("chirp"));
    assert_eq!(reads.get(), 2);
  }

  #[tokio::test]
  async fn another_account_never_gets_the_kept_list() {
    let cache = ModelCache::new(Hand::default());
    let reads = Cell::new(0);
    look_up(&cache, "a".into(), reader(&reads, "scribe"))
      .await
      .unwrap();
    let other = look_up(&cache, "b".into(), reader(&reads, "chirp"))
      .await
      .unwrap();
    assert_eq!(other.source, Source::Fetched(Miss::OtherAccount));
    assert_eq!(
      (other.namespace.as_str(), other.models),
      ("b", list("chirp"))
    );
    // The list kept is now the second account's.
    let back = look_up(&cache, "a".into(), reader(&reads, "scribe"))
      .await
      .unwrap();
    assert_eq!(back.source, Source::Fetched(Miss::OtherAccount));
    assert_eq!(reads.get(), 3);
  }

  #[tokio::test]
  async fn a_link_change_or_a_failed_read_forgets_the_list() {
    let cache = ModelCache::new(Hand::default());
    let reads = Cell::new(0);
    look_up(&cache, "a".into(), reader(&reads, "scribe"))
      .await
      .unwrap();
    // A relink keeps the account's namespace; the list is read again.
    cache.forget();
    let relinked = look_up(&cache, "a".into(), reader(&reads, "scribe"))
      .await
      .unwrap();
    assert_eq!(relinked.source, Source::Fetched(Miss::Empty));
    let kept = look_up(&cache, "a".into(), failing(&reads)).await.unwrap();
    assert_eq!(kept.source, Source::Cached);
    assert_eq!(reads.get(), 2);
    // A failed read leaves nothing kept.
    cache.forget();
    assert!(look_up(&cache, "a".into(), failing(&reads)).await.is_err());
    assert!(matches!(
      cache.get("a"),
      Err(Ticket {
        miss: Miss::Empty,
        ..
      })
    ));
  }

  #[tokio::test]
  async fn a_read_running_while_the_cache_is_forgotten_is_not_kept() {
    let cache = ModelCache::new(Hand::default());
    let ticket = cache.get("a").unwrap_err();
    // The account changes while the read is out.
    cache.forget();
    cache.store(ticket, "a", &list("scribe"));
    assert!(cache.get("a").is_err());
  }

  #[tokio::test]
  async fn the_settings_window_reads_the_list_as_it_is_now() {
    let cache = ModelCache::new(Hand::default());
    let reads = Cell::new(0);
    look_up(&cache, "a".into(), reader(&reads, "scribe"))
      .await
      .unwrap();
    let again = read_again(&cache, "a".into(), reader(&reads, "chirp"))
      .await
      .unwrap();
    assert_eq!(again.models, list("chirp"));
    // Dictation takes the list Settings read.
    let next = look_up(&cache, "a".into(), failing(&reads)).await.unwrap();
    assert_eq!((next.source, next.models), (Source::Cached, list("chirp")));
    assert_eq!(reads.get(), 2);
  }

  #[tokio::test]
  async fn the_press_reads_the_list_beside_recording_and_the_first_request_takes_it() {
    let cache = Arc::new(ModelCache::new(Hand::default()));
    let reads = Arc::new(AtomicUsize::new(0));
    let (answer, answered) = tokio::sync::oneshot::channel::<CloudModels>();
    // The press: the read starts at once and is still out.
    let pressed = {
      let cache = Arc::clone(&cache);
      let reads = Arc::clone(&reads);
      tokio::spawn(async move {
        look_up(&cache, "a".into(), || {
          reads.fetch_add(1, Ordering::SeqCst);
          async move { answered.await.map_err(|_closed| "closed".to_string()) }
        })
        .await
      })
    };
    tokio::task::yield_now().await;
    assert_eq!(
      reads.load(Ordering::SeqCst),
      1,
      "the read started at the press"
    );
    // Recording goes on; the read answers before the first request.
    answer.send(list("scribe")).unwrap();
    let pressed = pressed.await.unwrap();
    let late = Cell::new(0);
    let (looked, read) =
      at_request(&cache, Some(pressed), "a".into(), reader(&late, "other"))
        .await
        .unwrap();
    assert_eq!((read, looked.models), (ListRead::AtPress, list("scribe")));
    assert_eq!(late.get(), 0, "no read after the press");
  }

  #[tokio::test]
  async fn a_kept_list_answers_the_press_without_a_read() {
    let cache = ModelCache::new(Hand::default());
    let reads = Cell::new(0);
    look_up(&cache, "a".into(), reader(&reads, "scribe"))
      .await
      .unwrap();
    let pressed = look_up(&cache, "a".into(), failing(&reads)).await;
    let (_, read) = at_request(&cache, Some(pressed), "a".into(), failing(&reads))
      .await
      .unwrap();
    assert_eq!((read, reads.get()), (ListRead::Cached, 1));
  }

  #[tokio::test]
  async fn the_first_request_reads_again_for_another_account_or_a_failed_press() {
    let cache = ModelCache::new(Hand::default());
    let reads = Cell::new(0);
    let pressed = look_up(&cache, "a".into(), reader(&reads, "scribe")).await;
    // The account changed between the press and the first request.
    let (looked, read) =
      at_request(&cache, Some(pressed), "b".into(), reader(&reads, "chirp"))
        .await
        .unwrap();
    assert_eq!(
      (read, looked.namespace.as_str(), looked.models),
      (ListRead::AtRequest, "b", list("chirp"))
    );
    let failed = Err("models read failed".to_string());
    cache.forget();
    let (_, read) =
      at_request(&cache, Some(failed), "b".into(), reader(&reads, "chirp"))
        .await
        .unwrap();
    assert_eq!((read, reads.get()), (ListRead::AtRequest, 3));
  }
}
