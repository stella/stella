//! The runner socket: one outbound WebSocket to the API, `hello`/`welcome`,
//! command handling, resending what the API has not acknowledged, and when
//! to reconnect.
//!
//! One task owns the socket, the journal and the run positions; harness hosts
//! reach it through [`RunSink`]s, so every message is journaled, numbered and
//! sent in one order.

use std::{
  collections::HashMap,
  num::NonZeroU32,
  sync::{Arc, OnceLock},
  time::Duration,
};

use futures_util::{SinkExt, StreamExt, future::BoxFuture};
use tokio::{
  net::TcpStream,
  sync::{mpsc, watch},
  time::Instant,
};
use tokio_tungstenite::{
  Connector, MaybeTlsStream, WebSocketStream,
  tungstenite::{
    self, Message,
    client::IntoClientRequest,
    http::{HeaderName, HeaderValue},
    protocol::{
      CloseFrame, WebSocketConfig, frame::coding::CloseCode as WireCloseCode,
    },
  },
};
use uuid::Uuid;

use super::harness::{
  EmitError, HarnessHost, HarnessReports, RunOutput, RunSink, SinkRequest,
};
use super::journal::{Decision, Journal, RunRecord};
use super::state::{Backoff, RunnerState};
use crate::device_proof::DeviceKey;
use crate::runner_protocol::{
  ActiveRun, CloseCode, DESKTOP_ID_HEADER, DesktopMessage, HELLO_TIMEOUT, Hello,
  MAX_FRAME_BYTES, PATH, PING_INTERVAL, POLICY_VIOLATION_CODE, PROTOCOL,
  RunApprovalRequest, RunEvent, RunFinished, RunRef, RunRejected, ServerMessage,
  Welcome,
};

/// `hello` lists at most this many runs; the contract refuses more.
const MAX_ACTIVE_RUNS: usize = 64;
/// Outputs a host may queue before `emit` waits for the runner.
const SINK_CAPACITY: usize = 256;

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// What a connection attempt authenticates with.
pub(crate) struct Authorized {
  pub(crate) api_base_url: String,
  pub(crate) bearer: zeroize::Zeroizing<String>,
  pub(crate) device_key: DeviceKey,
  /// Names the account the journal belongs to.
  pub(crate) namespace: String,
  /// Held until the upgrade completes, so the bearer is not rotated while
  /// the handshake still uses it.
  #[allow(dead_code, reason = "held only to be dropped after the handshake")]
  pub(crate) lease: Option<Box<dyn Send>>,
}

pub(crate) trait RunnerAuth: Send + Sync + 'static {
  /// The account to connect as, or `None` when no account is linked.
  fn authorize(&self) -> BoxFuture<'_, Result<Option<Authorized>, String>>;
}

/// Opens the journal of one account. Runs on a blocking thread: opening may
/// wait for the keychain.
pub(crate) trait JournalOpener: Send + Sync + 'static {
  fn open(&self, namespace: &str) -> Journal;
}

#[derive(Debug, Clone)]
pub(crate) struct RunnerTiming {
  pub(crate) connect_timeout: Duration,
  /// After `hello`, how long to wait for `welcome`.
  pub(crate) welcome_timeout: Duration,
  /// No frame, ping included, for this long: the socket is gone.
  pub(crate) silence_timeout: Duration,
  pub(crate) backoff_base: Duration,
  pub(crate) backoff_cap: Duration,
  /// Between checks for a linked account while there is none.
  pub(crate) signed_out_retry: Duration,
}

impl Default for RunnerTiming {
  fn default() -> Self {
    Self {
      connect_timeout: Duration::from_secs(15),
      welcome_timeout: HELLO_TIMEOUT,
      silence_timeout: PING_INTERVAL * 3,
      backoff_base: Duration::from_secs(1),
      backoff_cap: Duration::from_secs(5 * 60),
      signed_out_retry: Duration::from_secs(60),
    }
  }
}

pub(crate) struct RunnerConfig {
  pub(crate) desktop_id: Uuid,
  pub(crate) app_version: String,
  pub(crate) timing: RunnerTiming,
  /// Uniform in `[0, 1)`, for backoff jitter.
  pub(crate) random: fn() -> f64,
}

pub(crate) struct RunnerParts {
  pub(crate) config: RunnerConfig,
  pub(crate) auth: Arc<dyn RunnerAuth>,
  pub(crate) journals: Arc<dyn JournalOpener>,
  pub(crate) host: Arc<dyn HarnessHost>,
  pub(crate) reports: Arc<dyn HarnessReports>,
  pub(crate) state: Arc<watch::Sender<RunnerState>>,
  /// Changes on every wake the presence loop sees.
  pub(crate) wakes: watch::Receiver<u64>,
  /// `true` stops the runner.
  pub(crate) stop: watch::Receiver<bool>,
}

/// Why a connection ended, which decides what happens next.
#[derive(Debug, PartialEq)]
enum Ended {
  Stopped,
  SignedOut,
  Woke,
  GoingAway {
    after: Option<Duration>,
  },
  UpgradeRequired {
    minimum: Option<u32>,
    current: Option<u32>,
  },
  Replaced,
  Failed,
}

/// What the API said before closing.
#[derive(Default)]
struct Notices {
  upgrade: Option<(u32, u32)>,
  reconnect_after: Option<Duration>,
}

enum Waited {
  Elapsed,
  Woke,
  Stopped,
}

pub(crate) struct Runner {
  config: RunnerConfig,
  auth: Arc<dyn RunnerAuth>,
  journals: Arc<dyn JournalOpener>,
  host: Arc<dyn HarnessHost>,
  reports: Arc<dyn HarnessReports>,
  state: Arc<watch::Sender<RunnerState>>,
  wakes: watch::Receiver<u64>,
  wakes_closed: bool,
  stop: watch::Receiver<bool>,
  sink_tx: mpsc::Sender<SinkRequest>,
  sink_rx: mpsc::Receiver<SinkRequest>,
  journal: Option<(String, Journal)>,
  /// The expiry of the newest MCP token each run was handed.
  tokens: HashMap<String, chrono::DateTime<chrono::Utc>>,
  backoff: Backoff,
}

impl Runner {
  pub(crate) fn new(parts: RunnerParts) -> Self {
    let (sink_tx, sink_rx) = mpsc::channel(SINK_CAPACITY);
    let backoff = Backoff::new(
      parts.config.timing.backoff_base,
      parts.config.timing.backoff_cap,
    );
    Self {
      config: parts.config,
      auth: parts.auth,
      journals: parts.journals,
      host: parts.host,
      reports: parts.reports,
      state: parts.state,
      wakes: parts.wakes,
      wakes_closed: false,
      stop: parts.stop,
      sink_tx,
      sink_rx,
      journal: None,
      tokens: HashMap::new(),
      backoff,
    }
  }

  /// Connect and stay connected until stopped, replaced, or told to update.
  pub(crate) async fn run(mut self) {
    loop {
      if self.stopping() {
        break;
      }
      self.publish(RunnerState::Connecting {
        attempt: self.backoff.attempt().saturating_add(1),
      });
      let delay = match self.connect_once().await {
        Ended::Stopped => break,
        Ended::SignedOut => {
          self.publish(RunnerState::SignedOut);
          self.config.timing.signed_out_retry
        }
        Ended::Woke => Duration::ZERO,
        Ended::GoingAway { after } => after.unwrap_or_else(|| self.next_delay()),
        Ended::UpgradeRequired { minimum, current } => {
          self.publish(RunnerState::UpgradeRequired {
            minimum_protocol: minimum,
            current_protocol: current,
          });
          self.park().await;
          break;
        }
        Ended::Replaced => {
          self.publish(RunnerState::Replaced);
          self.park().await;
          break;
        }
        Ended::Failed => self.next_delay(),
      };
      let signed_out = *self.state.borrow() == RunnerState::SignedOut;
      if !signed_out {
        self.publish(RunnerState::Retrying {
          attempt: self.backoff.attempt(),
          retry_in_ms: u64::try_from(delay.as_millis()).unwrap_or(u64::MAX),
        });
      }
      match self.wait(delay).await {
        Waited::Elapsed | Waited::Woke => {}
        Waited::Stopped => break,
      }
    }
    self.publish(RunnerState::Off);
  }

  fn publish(&self, state: RunnerState) {
    self.state.send_if_modified(|current| {
      if *current == state {
        return false;
      }
      *current = state;
      true
    });
  }

  fn next_delay(&mut self) -> Duration {
    self.backoff.next_delay((self.config.random)())
  }

  fn stopping(&self) -> bool {
    *self.stop.borrow()
  }

  /// Resolves when the presence loop reports a wake.
  async fn next_wake(wakes: &mut watch::Receiver<u64>, closed: &mut bool) {
    if *closed || wakes.changed().await.is_err() {
      *closed = true;
      std::future::pending::<()>().await;
    }
  }

  /// Resolves once the runner is told to stop, or its owner is gone.
  async fn next_stop(stop: &mut watch::Receiver<bool>) {
    drop(stop.wait_for(|stopped| *stopped).await);
  }

  /// Wait out `delay`, still journaling what hosts produce.
  async fn wait(&mut self, delay: Duration) -> Waited {
    let deadline = tokio::time::sleep(delay);
    tokio::pin!(deadline);
    loop {
      tokio::select! {
        () = &mut deadline => return Waited::Elapsed,
        () = Self::next_wake(&mut self.wakes, &mut self.wakes_closed) => return Waited::Woke,
        () = Self::next_stop(&mut self.stop) => return Waited::Stopped,
        Some(request) = self.sink_rx.recv() => {
          // Nothing to send to without a socket; the journal keeps it.
          let _unsent = self.record_output(request);
        }
      }
    }
  }

  /// Stay closed until stopped, still journaling what hosts produce.
  async fn park(&mut self) {
    loop {
      tokio::select! {
        () = Self::next_stop(&mut self.stop) => return,
        Some(request) = self.sink_rx.recv() => {
          let _unsent = self.record_output(request);
        }
      }
    }
  }

  async fn ensure_journal(&mut self, namespace: &str) {
    if self
      .journal
      .as_ref()
      .is_some_and(|(current, _)| current == namespace)
    {
      return;
    }
    let opener = Arc::clone(&self.journals);
    let owned = namespace.to_owned();
    let journal = match tokio::task::spawn_blocking(move || opener.open(&owned)).await {
      Ok(journal) => journal,
      Err(_join) => {
        tracing::warn!("desktop runner journal could not be opened");
        Journal::open(super::journal::JournalBacking::Memory, now_ms())
      }
    };
    self.tokens.clear();
    self.journal = Some((namespace.to_owned(), journal));
  }

  async fn connect_once(&mut self) -> Ended {
    let authorized = match self.auth.authorize().await {
      Ok(Some(authorized)) => authorized,
      Ok(None) => return Ended::SignedOut,
      Err(_unavailable) => {
        tracing::warn!("desktop runner account unavailable");
        return Ended::Failed;
      }
    };
    self.ensure_journal(&authorized.namespace).await;
    let (request, secure) = match upgrade_request(&authorized, self.config.desktop_id) {
      Ok(request) => request,
      Err(_invalid) => {
        tracing::warn!("desktop runner upgrade request could not be built");
        return Ended::Failed;
      }
    };
    let connector = if secure {
      match tls_connector() {
        Ok(connector) => Some(connector),
        Err(_tls) => {
          tracing::warn!("desktop runner TLS configuration unavailable");
          return Ended::Failed;
        }
      }
    } else {
      None
    };
    let connect = tokio_tungstenite::connect_async_tls_with_config(
      request,
      Some(socket_config()),
      true,
      connector,
    );
    let connect = tokio::time::timeout(self.config.timing.connect_timeout, connect);
    tokio::pin!(connect);
    let connected = loop {
      tokio::select! {
        connected = &mut connect => break connected,
        () = Self::next_stop(&mut self.stop) => return Ended::Stopped,
        Some(request) = self.sink_rx.recv() => {
          // Listed in `hello` and resent after `welcome`.
          let _unsent = self.record_output(request);
        }
      }
    };
    // The handshake is done with the bearer; a rotation may proceed.
    drop(authorized);
    let mut socket = match connected {
      Ok(Ok((socket, _response))) => socket,
      Ok(Err(error)) => {
        log_connect_error(&error);
        return Ended::Failed;
      }
      Err(_elapsed) => {
        tracing::warn!("desktop runner connection timed out");
        return Ended::Failed;
      }
    };
    let hello = DesktopMessage::Hello(self.hello());
    if send(&mut socket, &hello).await.is_err() {
      return Ended::Failed;
    }
    let mut notices = Notices::default();
    match self.await_welcome(&mut socket, &mut notices).await {
      Ok(welcome) => {
        if self.resume(&mut socket, welcome).await.is_err() {
          return Ended::Failed;
        }
      }
      Err(ended) => return ended,
    }
    self.backoff.reset();
    self.publish(RunnerState::Connected);
    self.serve(&mut socket, notices).await
  }

  fn hello(&self) -> Hello {
    let mut active_runs: Vec<ActiveRun> = self
      .records()
      .filter(|record| record.is_held())
      .map(|record| ActiveRun {
        run_id: record.run_id.clone(),
        last_seq: record.last_seq,
      })
      .collect();
    if active_runs.len() > MAX_ACTIVE_RUNS {
      tracing::warn!(
        held = active_runs.len(),
        "desktop runner holds more runs than hello lists"
      );
      active_runs.truncate(MAX_ACTIVE_RUNS);
    }
    Hello {
      protocol: PROTOCOL,
      app_version: self.config.app_version.clone(),
      sidecar_version: self.host.sidecar_version(),
      harnesses: self.reports.reports(),
      active_runs,
    }
  }

  fn records(&self) -> impl Iterator<Item = &RunRecord> {
    self
      .journal
      .iter()
      .flat_map(|(_, journal)| journal.records())
  }

  async fn await_welcome(
    &mut self,
    socket: &mut Socket,
    notices: &mut Notices,
  ) -> Result<Welcome, Ended> {
    let deadline = tokio::time::sleep(self.config.timing.welcome_timeout);
    tokio::pin!(deadline);
    loop {
      tokio::select! {
        () = &mut deadline => {
          tracing::warn!("desktop runner received no welcome");
          close(socket, WireCloseCode::Normal).await;
          return Err(Ended::Failed);
        }
        frame = socket.next() => match frame {
          Some(Ok(Message::Text(text))) => match parse(&text) {
            Some(ServerMessage::Welcome(welcome)) => return Ok(welcome),
            Some(other) => {
              if !notices.note(&other) {
                // The API sends nothing else before `welcome`.
                close(socket, WireCloseCode::Protocol).await;
                return Err(Ended::Failed);
              }
            }
            None => {
              close(socket, WireCloseCode::Protocol).await;
              return Err(Ended::Failed);
            }
          },
          Some(Ok(Message::Close(frame))) => return Err(closed(frame.as_ref(), notices)),
          Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => {
            if socket.flush().await.is_err() {
              return Err(Ended::Failed);
            }
          }
          Some(Ok(Message::Binary(_))) => {
            close(socket, WireCloseCode::Unsupported).await;
            return Err(Ended::Failed);
          }
          Some(Err(error)) => return Err(read_failed(socket, &error).await),
          None => return Err(Ended::Failed),
        },
        Some(request) = self.sink_rx.recv() => {
          // Sent with the rest of the outbox once `welcome` says where from.
          let _unsent = self.record_output(request);
        }
        () = Self::next_stop(&mut self.stop) => {
          close(socket, WireCloseCode::Normal).await;
          return Err(Ended::Stopped);
        }
      }
    }
  }

  /// Trim what the API stored, forget runs it no longer holds, and resend
  /// the rest in position order.
  async fn resume(&mut self, socket: &mut Socket, welcome: Welcome) -> Result<(), ()> {
    let resume: HashMap<String, u32> = welcome
      .resume
      .into_iter()
      .map(|point| (point.run_id, point.ack_seq))
      .collect();
    let held: Vec<RunRecord> = self
      .records()
      .filter(|record| record.is_held())
      .cloned()
      .collect();
    let mut resend = Vec::new();
    for mut record in held {
      let Some(&ack_seq) = resume.get(&record.run_id) else {
        // The API dropped the run: stop it here too and forget it.
        if !record.cancelled {
          self.host.cancel(&record.run_id);
        }
        self.tokens.remove(&record.run_id);
        self.forget(&record.run_id);
        continue;
      };
      record.acknowledge(ack_seq);
      if record.is_done() {
        self.forget(&record.run_id);
        continue;
      }
      resend.extend(record.outbox.iter().cloned());
      self.store(record)?;
    }
    for message in resend {
      send(socket, &message).await?;
    }
    Ok(())
  }

  async fn serve(&mut self, socket: &mut Socket, mut notices: Notices) -> Ended {
    let silence = tokio::time::sleep(self.config.timing.silence_timeout);
    tokio::pin!(silence);
    loop {
      tokio::select! {
        frame = socket.next() => {
          silence.as_mut().reset(Instant::now() + self.config.timing.silence_timeout);
          match frame {
            Some(Ok(Message::Text(text))) => {
              let Some(message) = parse(&text) else {
                close(socket, WireCloseCode::Protocol).await;
                return Ended::Failed;
              };
              if notices.note(&message) {
                continue;
              }
              if self.handle(socket, message).await.is_err() {
                close(socket, WireCloseCode::Error).await;
                return Ended::Failed;
              }
            }
            Some(Ok(Message::Close(frame))) => return closed(frame.as_ref(), &notices),
            Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => {
              if socket.flush().await.is_err() {
                return Ended::Failed;
              }
            }
            Some(Ok(Message::Binary(_))) => {
              close(socket, WireCloseCode::Unsupported).await;
              return Ended::Failed;
            }
            Some(Err(error)) => return read_failed(socket, &error).await,
            None => return Ended::Failed,
          }
        }
        Some(request) = self.sink_rx.recv() => {
          if let Some(message) = self.record_output(request)
            && send(socket, &message).await.is_err()
          {
            return Ended::Failed;
          }
        }
        () = &mut silence => {
          tracing::warn!("desktop runner socket went silent");
          return Ended::Failed;
        }
        () = Self::next_wake(&mut self.wakes, &mut self.wakes_closed) => {
          // After a sleep the socket is most likely gone; start over now.
          close(socket, WireCloseCode::Away).await;
          return Ended::Woke;
        }
        () = Self::next_stop(&mut self.stop) => {
          close(socket, WireCloseCode::Normal).await;
          return Ended::Stopped;
        }
      }
    }
  }

  /// Act on one command. `Err` means the socket should be dropped: the
  /// journal could not record something, or a reply could not be sent.
  async fn handle(
    &mut self,
    socket: &mut Socket,
    message: ServerMessage,
  ) -> Result<(), ()> {
    match message {
      ServerMessage::RunStart(start) => {
        let run_id = start.run_id.clone();
        let decision = match self.journal_get(&run_id) {
          // Answered before (maybe before a restart): answer the same again.
          Some(record) => record.decision,
          None => {
            let expires_at = parse_instant(&start.mcp.expires_at);
            let sink = RunSink::new(run_id.clone(), self.sink_tx.clone());
            let decision = match self.host.start(start, sink) {
              Ok(()) => Decision::Accepted,
              Err(reason) => Decision::Rejected { reason },
            };
            if self
              .store(RunRecord::new(run_id.clone(), decision, now_ms()))
              .is_err()
            {
              if decision == Decision::Accepted {
                self.host.cancel(&run_id);
              }
              return Err(());
            }
            if let (Decision::Accepted, Some(expires_at)) = (decision, expires_at) {
              self.tokens.insert(run_id.clone(), expires_at);
            }
            decision
          }
        };
        let answer = match decision {
          Decision::Accepted => DesktopMessage::RunAccepted(RunRef { run_id }),
          Decision::Rejected { reason } => {
            DesktopMessage::RunRejected(RunRejected { run_id, reason })
          }
        };
        send(socket, &answer).await
      }
      ServerMessage::RunInput(input) => {
        let Some(mut record) = self.accepted(&input.run_id) else {
          return Ok(());
        };
        if !record.inputs.insert(input.input_id.clone()) {
          return Ok(());
        }
        self.store(record)?;
        self.host.input(input);
        Ok(())
      }
      ServerMessage::RunApproval(approval) => {
        let Some(mut record) = self.accepted(&approval.run_id) else {
          return Ok(());
        };
        if !record.approvals.insert(approval.request_id.clone()) {
          return Ok(());
        }
        self.store(record)?;
        self.host.approval(approval);
        Ok(())
      }
      ServerMessage::RunInterrupt(RunRef { run_id }) => {
        let Some(mut record) = self.accepted(&run_id) else {
          return Ok(());
        };
        if record.interrupted {
          return Ok(());
        }
        record.interrupted = true;
        self.store(record)?;
        self.host.interrupt(&run_id);
        Ok(())
      }
      ServerMessage::RunCancel(RunRef { run_id }) => {
        let Some(mut record) = self.accepted(&run_id) else {
          return Ok(());
        };
        if record.cancelled {
          return Ok(());
        }
        record.cancelled = true;
        self.store(record)?;
        self.host.cancel(&run_id);
        Ok(())
      }
      ServerMessage::RunToken(refresh) => {
        if self.accepted(&refresh.run_id).is_none() {
          return Ok(());
        }
        let Some(expires_at) = parse_instant(&refresh.expires_at) else {
          return Ok(());
        };
        if self
          .tokens
          .get(&refresh.run_id)
          .is_some_and(|newest| *newest >= expires_at)
        {
          return Ok(());
        }
        self.tokens.insert(refresh.run_id.clone(), expires_at);
        self.host.token(refresh);
        Ok(())
      }
      ServerMessage::Ack(ack) => {
        let Some(mut record) = self.journal_get(&ack.run_id).cloned() else {
          return Ok(());
        };
        record.acknowledge(ack.seq.get());
        if record.is_done() {
          self.tokens.remove(&record.run_id);
          self.forget(&record.run_id);
          return Ok(());
        }
        self.store(record)
      }
      // Answered by the caller; a second `welcome` never comes.
      ServerMessage::Welcome(_)
      | ServerMessage::UpgradeRequired(_)
      | ServerMessage::Reconnect(_) => Err(()),
    }
  }

  fn journal_get(&self, run_id: &str) -> Option<&RunRecord> {
    self
      .journal
      .as_ref()
      .and_then(|(_, journal)| journal.get(run_id))
  }

  /// A run this desktop accepted and has not finished.
  fn accepted(&self, run_id: &str) -> Option<RunRecord> {
    self
      .journal_get(run_id)
      .filter(|record| record.decision == Decision::Accepted && !record.finished)
      .cloned()
  }

  fn store(&mut self, record: RunRecord) -> Result<(), ()> {
    let Some((_, journal)) = self.journal.as_mut() else {
      return Err(());
    };
    journal.put(record).map_err(|error| {
      tracing::warn!(error = %error, "desktop runner journal write failed");
    })
  }

  fn forget(&mut self, run_id: &str) {
    if let Some((_, journal)) = self.journal.as_mut()
      && let Err(error) = journal.remove(run_id)
    {
      tracing::warn!(error = %error, "desktop runner journal removal failed");
    }
  }

  /// Number, journal and answer one output; the message to send, if any.
  fn record_output(&mut self, request: SinkRequest) -> Option<DesktopMessage> {
    let SinkRequest {
      run_id,
      output,
      reply,
    } = request;
    let recorded = self.journal_output(run_id, output);
    let (answer, message) = match recorded {
      Ok((seq, message)) => (Ok(seq), Some(message)),
      Err(error) => (Err(error), None),
    };
    // A host that stopped waiting no longer needs the position.
    let _unwaited = reply.send(answer);
    message
  }

  fn journal_output(
    &mut self,
    run_id: String,
    output: RunOutput,
  ) -> Result<(NonZeroU32, DesktopMessage), EmitError> {
    let mut record = self.accepted(&run_id).ok_or(EmitError::RunClosed)?;
    let seq = record
      .last_seq
      .checked_add(1)
      .and_then(NonZeroU32::new)
      .ok_or(EmitError::RunClosed)?;
    let finished = matches!(output, RunOutput::Finished { .. });
    let message = match output {
      RunOutput::Event(chunk) => {
        DesktopMessage::RunEvent(RunEvent { run_id, seq, chunk })
      }
      RunOutput::ApprovalRequest {
        request_id,
        kind,
        summary,
      } => DesktopMessage::RunApprovalRequest(RunApprovalRequest {
        run_id,
        seq,
        request_id,
        kind,
        summary,
      }),
      RunOutput::Finished {
        outcome,
        harness_session_id,
      } => DesktopMessage::RunFinished(RunFinished {
        run_id,
        seq,
        outcome,
        harness_session_id,
      }),
    };
    if encode(&message).is_none() {
      return Err(EmitError::TooLarge);
    }
    record.outbox.push(message.clone());
    record.last_seq = seq.get();
    record.finished = finished;
    self.store(record).map_err(|()| EmitError::Storage)?;
    Ok((seq, message))
  }
}

impl Notices {
  /// Record a notice the API sends ahead of a close; `false` for anything else.
  fn note(&mut self, message: &ServerMessage) -> bool {
    match message {
      ServerMessage::UpgradeRequired(upgrade) => {
        self.upgrade = Some((upgrade.minimum_protocol, upgrade.current_protocol));
        true
      }
      ServerMessage::Reconnect(reconnect) => {
        self.reconnect_after =
          Some(Duration::from_millis(u64::from(reconnect.after_ms)));
        true
      }
      _ => false,
    }
  }
}

fn closed(frame: Option<&CloseFrame>, notices: &Notices) -> Ended {
  let code = frame.map(|frame| u16::from(frame.code));
  match code.and_then(CloseCode::from_code) {
    Some(CloseCode::GoingAway) => Ended::GoingAway {
      after: notices.reconnect_after,
    },
    Some(CloseCode::UpgradeRequired) => Ended::UpgradeRequired {
      minimum: notices.upgrade.map(|(minimum, _)| minimum),
      current: notices.upgrade.map(|(_, current)| current),
    },
    Some(CloseCode::Superseded) => Ended::Replaced,
    // The credential no longer authorizes this desktop; it must link again.
    Some(CloseCode::CredentialRevoked) => Ended::SignedOut,
    None if code == Some(POLICY_VIOLATION_CODE) => {
      // The reason is one of the contract's fixed values.
      let reason = frame.map(|frame| frame.reason.as_str()).unwrap_or_default();
      tracing::warn!(reason, "the API refused a desktop runner frame");
      Ended::Failed
    }
    _ => {
      tracing::info!(code = ?code, "desktop runner socket closed");
      Ended::Failed
    }
  }
}

fn parse(text: &str) -> Option<ServerMessage> {
  serde_json::from_str(text)
    .map_err(|error| {
      // serde would quote the frame it failed on.
      crate::logging::log_json_error(
        &error,
        "desktop runner received an unreadable frame",
      );
    })
    .ok()
}

/// The frame for `message`, or `None` above the frame limit.
fn encode(message: &DesktopMessage) -> Option<String> {
  serde_json::to_string(message)
    .ok()
    .filter(|text| text.len() <= MAX_FRAME_BYTES)
}

async fn send(socket: &mut Socket, message: &DesktopMessage) -> Result<(), ()> {
  let Some(text) = encode(message) else {
    // Outputs are measured before they are journaled; a hello never nears it.
    tracing::warn!("desktop runner refused to send a frame over the limit");
    return Err(());
  };
  socket.send(Message::text(text)).await.map_err(|error| {
    log_socket_error(&error);
  })
}

async fn close(socket: &mut Socket, code: WireCloseCode) {
  let frame = CloseFrame {
    code,
    reason: "".into(),
  };
  // The socket is being dropped either way.
  let _closing = socket.close(Some(frame)).await;
}

fn socket_config() -> WebSocketConfig {
  WebSocketConfig::default()
    .max_message_size(Some(MAX_FRAME_BYTES))
    .max_frame_size(Some(MAX_FRAME_BYTES))
}

/// The client configuration every `wss` connection uses: the system's
/// certificate verification, as the desktop's HTTP client does.
fn tls_connector() -> Result<Connector, String> {
  static CONFIG: OnceLock<Result<Arc<rustls::ClientConfig>, String>> = OnceLock::new();
  CONFIG
    .get_or_init(|| {
      use rustls_platform_verifier::BuilderVerifierExt;
      let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
      rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .and_then(BuilderVerifierExt::with_platform_verifier)
        .map(|builder| Arc::new(builder.with_no_client_auth()))
        .map_err(|error| error.to_string())
    })
    .clone()
    .map(Connector::Rustls)
}

/// The upgrade request, and whether it goes over TLS. The DPoP proof is
/// fresh for every attempt and names the API's public URL, path only.
fn upgrade_request(
  authorized: &Authorized,
  desktop_id: Uuid,
) -> Result<(tungstenite::handshake::client::Request, bool), String> {
  let public = format!("{}{PATH}", authorized.api_base_url.trim_end_matches('/'));
  let (socket_url, secure) = if let Some(rest) = public.strip_prefix("https://") {
    (format!("wss://{rest}"), true)
  } else if let Some(rest) = public.strip_prefix("http://") {
    (format!("ws://{rest}"), false)
  } else {
    return Err("the API base URL is not http(s)".to_owned());
  };
  let target = reqwest::Url::parse(&public).map_err(|error| error.to_string())?;
  let proof = authorized.device_key.proof(
    &reqwest::Request::new(reqwest::Method::GET, target),
    Some(authorized.bearer.as_str()),
    None,
  )?;
  let mut request = socket_url
    .into_client_request()
    .map_err(|error| error.to_string())?;
  let headers = request.headers_mut();
  let value =
    |text: &str| HeaderValue::from_str(text).map_err(|error| error.to_string());
  let mut authorization = value(&format!("Bearer {}", authorized.bearer.as_str()))?;
  authorization.set_sensitive(true);
  headers.insert(tungstenite::http::header::AUTHORIZATION, authorization);
  headers.insert(HeaderName::from_static("dpop"), value(&proof)?);
  headers.insert(
    HeaderName::from_static(DESKTOP_ID_HEADER),
    value(&desktop_id.to_string())?,
  );
  for (name, identity) in crate::http_client::identity_headers() {
    headers.insert(name, identity);
  }
  Ok((request, secure))
}

/// A read failed; a frame over the limit is answered with 1009 first.
async fn read_failed(socket: &mut Socket, error: &tungstenite::Error) -> Ended {
  log_socket_error(error);
  if matches!(error, tungstenite::Error::Capacity(_)) {
    close(socket, WireCloseCode::Size).await;
  }
  Ended::Failed
}

fn log_connect_error(error: &tungstenite::Error) {
  match error {
    tungstenite::Error::Http(response) => {
      tracing::warn!(status = %response.status(), "desktop runner socket refused");
    }
    other => log_socket_error(other),
  }
}

/// Logs the kind only: frames and URLs may carry run data or tokens.
fn log_socket_error(error: &tungstenite::Error) {
  let kind = match error {
    tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed => {
      "closed"
    }
    tungstenite::Error::Io(_) => "io",
    tungstenite::Error::Tls(_) => "tls",
    tungstenite::Error::Capacity(_) => "capacity",
    tungstenite::Error::Protocol(_) => "protocol",
    tungstenite::Error::WriteBufferFull(_) => "write_buffer_full",
    tungstenite::Error::Utf8(_) => "utf8",
    tungstenite::Error::AttackAttempt => "attack_attempt",
    tungstenite::Error::Url(_) => "url",
    tungstenite::Error::Http(_) => "http",
    tungstenite::Error::HttpFormat(_) => "http_format",
  };
  tracing::warn!(kind, "desktop runner socket failed");
}

fn parse_instant(value: &str) -> Option<chrono::DateTime<chrono::Utc>> {
  chrono::DateTime::parse_from_rfc3339(value)
    .ok()
    .map(|instant| instant.with_timezone(&chrono::Utc))
}

pub(crate) fn now_ms() -> i64 {
  chrono::Utc::now().timestamp_millis()
}
