//! A stand-in computer for a checkout's local stack
//! (`bun run agent:up -- --local-runner`): this app's own runner, encrypted
//! journal, harness host, supervisor and holder (the TypeScript sidecar from
//! source), linked to the seeded member through the API's own grant and
//! redemption endpoints with a real device key. Only the installed CLIs are
//! stand-ins: the agent engine's `fake-codex-by-model.ts` and
//! `fake-claude-code-by-model.ts`, whose models are scripted scenarios.
//!
//! Development only: compiled with the `dev-runner-stand-in` feature, which a
//! release build refuses, and it links only to a loopback `http` API.
//!
//! Configured by the environment `agent-session.ts` sets (`STELLA_STAND_IN_*`).
//! The link and device key stay in `<state>`; holders, run folders and the
//! journal in the development app's data folder (`data_folder`).
//! While `<state>/offline` exists the runner is stopped and the host and its
//! holder keep running, as when the app loses its network; removing the file
//! starts a fresh runner. Creating `<state>/relink` links the same computer
//! again with a new device key, as signing in again does, and starts a fresh
//! runner on it; the file is removed once linked. SIGTERM or Ctrl-C stops the
//! runs and the holder.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::watch;

use super::client::{
  Authorized, JournalOpener, Runner, RunnerAuth, RunnerConfig, RunnerParts,
  RunnerTiming, now_ms,
};
use super::harness::{HarnessHost, HarnessReports};
use super::journal::{Journal, JournalBacking, SharedJournal};
use super::sidecar_host::{
  HarnessCredentials, HostSettings, InstallSettled, InstalledHarness, LocalHarnesses,
  SidecarHarnessHost,
};
use super::state::RunnerState;
use crate::device_proof::DeviceKey;
use crate::harness_sidecar::{
  ReconnectBackoff, SidecarLaunch, SidecarSettings, SkillFolderRef,
};
use crate::http_client::{DesktopHttpClient, HttpClientOptions};
use crate::runner_protocol::Harness;

#[cfg(not(debug_assertions))]
compile_error!(
  "the runner stand-in is a development tool and never builds for release"
);

const LOG_TARGET: &str = "desktop_runner::stand_in";
/// The versions the stand-in CLIs report, which the compatibility policy
/// supports.
const CODEX_VERSION: &str = "0.166.0";
const CLAUDE_CODE_VERSION: &str = "2.1.309";
/// The journal's namespace and key: a stand-in's journal holds only scripted
/// runs on a development stack.
const NAMESPACE: &str = "stand-in";
const JOURNAL_KEY: [u8; 32] = [7; 32];
const OFFLINE_FILE: &str = "offline";
const RELINK_FILE: &str = "relink";
const LINK_FILE: &str = "link.json";
const DEVICE_KEY_FILE: &str = "device.pkcs8";
/// Names the data folder, so `agent:reset` can remove it.
const DATA_FOLDER_FILE: &str = "data-folder";
/// A credential this close to its expiry, in hours, is replaced by a new link.
const RELINK_MARGIN_HOURS: i64 = 1;
const POLL: Duration = Duration::from_millis(200);

/// What `agent-session.ts` passes, read once at start.
struct Settings {
  api: String,
  web: String,
  cookie: zeroize::Zeroizing<String>,
  user_id: String,
  organization_id: String,
  state: PathBuf,
  bun: PathBuf,
  codex: PathBuf,
  claude_code: PathBuf,
}

fn variable(name: &str) -> Result<String, String> {
  std::env::var(name)
    .ok()
    .filter(|value| !value.is_empty())
    .ok_or_else(|| format!("{name} is required"))
}

/// `url` as an origin, refused unless it is plain `http` on this computer:
/// the stand-in links only to a local stack.
pub(crate) fn loopback_origin(url: &str) -> Result<String, String> {
  let parsed = reqwest::Url::parse(url).map_err(|error| format!("{url}: {error}"))?;
  let bare = parsed.username().is_empty()
    && parsed.password().is_none()
    && parsed.query().is_none()
    && parsed.fragment().is_none()
    && parsed.path() == "/";
  if parsed.scheme() != "http" || !crate::config::is_loopback_host(&parsed) || !bare {
    return Err(format!(
      "{url} is not a local stack; the stand-in links only to http://localhost"
    ));
  }
  let port = parsed
    .port()
    .map(|port| format!(":{port}"))
    .unwrap_or_default();
  Ok(format!(
    "http://{}{port}",
    parsed.host_str().unwrap_or("localhost")
  ))
}

impl Settings {
  fn from_env() -> Result<Self, String> {
    let absolute = |name: &str| -> Result<PathBuf, String> {
      let path = PathBuf::from(variable(name)?);
      if path.is_absolute() {
        Ok(path)
      } else {
        Err(format!("{name} must be an absolute path"))
      }
    };
    Ok(Self {
      api: loopback_origin(&variable("STELLA_STAND_IN_API")?)?,
      web: loopback_origin(&variable("STELLA_STAND_IN_WEB")?)?,
      cookie: zeroize::Zeroizing::new(variable("STELLA_STAND_IN_COOKIE")?),
      user_id: variable("STELLA_STAND_IN_USER_ID")?,
      organization_id: variable("STELLA_STAND_IN_ORGANIZATION_ID")?,
      state: absolute("STELLA_STAND_IN_STATE")?,
      bun: absolute("STELLA_STAND_IN_BUN")?,
      codex: absolute("STELLA_STAND_IN_CODEX")?,
      claude_code: absolute("STELLA_STAND_IN_CLAUDE_CODE")?,
    })
  }
}

/// The credential a link redeemed, and what it was redeemed for.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Link {
  api: String,
  user_id: String,
  organization_id: String,
  desktop_id: uuid::Uuid,
  key: String,
  expires_at: chrono::DateTime<chrono::Utc>,
}

struct Linked {
  link: Link,
  device: DeviceKey,
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
  use std::io::Write;
  use std::os::unix::fs::OpenOptionsExt;
  let mut file = std::fs::OpenOptions::new()
    .write(true)
    .create(true)
    .truncate(true)
    .mode(0o600)
    .open(path)
    .map_err(|error| format!("{}: {error}", path.display()))?;
  file
    .write_all(bytes)
    .map_err(|error| format!("{}: {error}", path.display()))
}

/// The saved link when it is for this stack and member and not about to
/// expire.
fn saved_link(settings: &Settings) -> Option<Linked> {
  let link: Link =
    serde_json::from_slice(&std::fs::read(settings.state.join(LINK_FILE)).ok()?)
      .ok()?;
  let device =
    DeviceKey::from_pkcs8(&std::fs::read(settings.state.join(DEVICE_KEY_FILE)).ok()?)
      .ok()?;
  (link.api == settings.api
    && link.user_id == settings.user_id
    && link.organization_id == settings.organization_id
    && link.expires_at - chrono::TimeDelta::hours(RELINK_MARGIN_HOURS)
      > chrono::Utc::now())
  .then_some(Linked { link, device })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Redeemed {
  key: String,
  expires_at: chrono::DateTime<chrono::Utc>,
}

/// Link a new device key as the browser approval does: `/grant` under the
/// member's web session, then `/redeem-link` with the device's proof. A new
/// link is a new computer with a new desktop id; a relink (`computer`) keeps
/// the computer's.
async fn link(settings: &Settings, computer: Option<uuid::Uuid>) -> Result<Linked, String> {
  let pkcs8 = DeviceKey::generate()?;
  let device = DeviceKey::from_pkcs8(&pkcs8)?;
  let jkt = device.thumbprint()?;
  let correlation = uuid::Uuid::new_v4().to_string();
  let verifier = hex::encode(Sha256::digest(uuid::Uuid::new_v4().as_bytes()));
  let verifier_hash = hex::encode(Sha256::digest(verifier.as_bytes()));
  let client = DesktopHttpClient::new(HttpClientOptions {
    timeout: Some(Duration::from_secs(20)),
    ..HttpClientOptions::default()
  })
  .map_err(|error| error.to_string())?;
  let granted = client
    .post(format!("{}/v1/desktop-registry/grant", settings.api))
    .header("cookie", settings.cookie.as_str())
    .header("origin", &settings.web)
    .json(&serde_json::json!({
      "correlationId": correlation,
      "deviceJkt": jkt,
      "verifierHash": verifier_hash,
    }))
    .send()
    .await
    .map_err(|error| format!("grant: {error}"))?;
  let status = granted.status();
  if !status.is_success() {
    let body = granted.text().await.unwrap_or_default();
    return Err(format!("grant refused: {status} {body}"));
  }
  let (protocol_header, protocol) = crate::account::link_protocol_header();
  let builder = client
    .post(format!("{}/v1/desktop-registry/redeem-link", settings.api))
    .header(protocol_header, protocol)
    .json(&serde_json::json!({
      "correlationId": correlation,
      "verifier": verifier,
      "expectedUserId": settings.user_id,
      "expectedOrganizationId": settings.organization_id,
      "deviceJkt": jkt,
    }));
  let redeemed = crate::http_client::device_proof_request(
    builder,
    &device,
    None,
    Some(&correlation),
  )?
  .send()
  .await
  .map_err(|error| format!("redeem: {error}"))?;
  let status = redeemed.status();
  if !status.is_success() {
    let body = redeemed.text().await.unwrap_or_default();
    return Err(format!("redemption refused: {status} {body}"));
  }
  let redeemed: Redeemed = redeemed
    .json()
    .await
    .map_err(|error| format!("redemption answered without a credential: {error}"))?;
  let link = Link {
    api: settings.api.clone(),
    user_id: settings.user_id.clone(),
    organization_id: settings.organization_id.clone(),
    desktop_id: computer.unwrap_or_else(uuid::Uuid::new_v4),
    key: redeemed.key,
    expires_at: redeemed.expires_at,
  };
  write_private(&settings.state.join(DEVICE_KEY_FILE), &pkcs8)?;
  write_private(
    &settings.state.join(LINK_FILE),
    &serde_json::to_vec(&link).map_err(|error| error.to_string())?,
  )?;
  Ok(Linked { link, device })
}

struct StandInAuth(Arc<Linked>);

impl RunnerAuth for StandInAuth {
  fn authorize(&self) -> BoxFuture<'_, Result<Option<Authorized>, String>> {
    Box::pin(async move {
      Ok(Some(Authorized {
        api_base_url: self.0.link.api.clone(),
        bearer: zeroize::Zeroizing::new(self.0.link.key.clone()),
        device_key: self.0.device.clone(),
        namespace: NAMESPACE.to_owned(),
        lease: None,
      }))
    })
  }
}

struct StandInJournals(PathBuf);

impl JournalOpener for StandInJournals {
  fn open(&self, namespace: &str) -> Journal {
    Journal::open(
      JournalBacking::Encrypted {
        directory: self.0.join(namespace),
        key: JOURNAL_KEY,
      },
      now_ms(),
    )
  }
}

/// Codex and Claude Code "installed" as the agent engine's stand-in scripts,
/// each with its own home folder and no credentials of its own.
struct StandInHarnesses {
  codex: PathBuf,
  claude_code: PathBuf,
  homes: PathBuf,
}

impl LocalHarnesses for StandInHarnesses {
  fn installed(&self, harness: Harness) -> Option<InstalledHarness> {
    let (executable, version, home) = match harness {
      Harness::Codex => (&self.codex, CODEX_VERSION, "codex"),
      Harness::ClaudeCode => (&self.claude_code, CLAUDE_CODE_VERSION, "claude-code"),
      Harness::Opencode => return None,
    };
    Some(InstalledHarness {
      version: version.to_owned(),
      executable: executable.clone(),
      config_dir: self.homes.join(home),
      tool_path: Vec::new(),
      lease: Box::new(()),
    })
  }

  fn credentials(
    &self,
    _harness: Harness,
  ) -> BoxFuture<'_, Option<HarnessCredentials>> {
    Box::pin(async { None })
  }

  fn on_install_settled(&self, _settled: InstallSettled) {}

  fn skill_folders(&self) -> Vec<SkillFolderRef> {
    Vec::new()
  }
}

/// Settles on SIGTERM or Ctrl-C.
async fn terminated() {
  let Ok(mut term) =
    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
  else {
    let _interrupted = tokio::signal::ctrl_c().await;
    return;
  };
  tokio::select! {
    _ = term.recv() => {}
    _ = tokio::signal::ctrl_c() => {}
  }
}

/// Settles once `file` exists (`true`) or no longer does (`false`).
async fn file_becomes(file: &Path, wanted: bool) {
  while file.exists() != wanted {
    tokio::time::sleep(POLL).await;
  }
}

/// What the stand-in does once its runner stopped.
enum Next {
  /// Start a fresh runner once it is online.
  Continue,
  /// Link this computer again, then start a fresh runner.
  Relink,
  /// Stop the runs and the holder, and exit.
  Stop,
}

/// Where the host keeps holders, run folders, the journal and the CLIs'
/// homes: the development app's data folder, the only place its private
/// files may go, one folder per checkout state.
fn data_folder(state: &Path) -> Result<PathBuf, String> {
  let data = dirs::data_dir().ok_or("this computer has no data folder")?;
  let checkout = hex::encode(Sha256::digest(state.as_os_str().as_encoded_bytes()));
  Ok(
    data
      .join(crate::config::APP_DATA_DIR_NAME)
      .join("runner-stand-in")
      .join(&checkout[..16]),
  )
}

async fn serve(settings: Settings) -> Result<(), String> {
  let data = data_folder(&settings.state)?;
  tracing::info!(target: LOG_TARGET, data = %data.display(), "data folder");
  // `agent:reset` removes it with the link.
  write_private(
    &settings.state.join(DATA_FOLDER_FILE),
    data.as_os_str().as_encoded_bytes(),
  )?;
  let homes = data.join("harness-homes");
  for folder in [homes.join("codex"), homes.join("claude-code")] {
    crate::local_store::create_private_dir(&folder)
      .map_err(|error| format!("{}: {error}", folder.display()))?;
  }
  let linked = match saved_link(&settings) {
    Some(linked) => linked,
    None => {
      tracing::info!(target: LOG_TARGET, "linking a new computer");
      link(&settings, None).await?
    }
  };
  let desktop_id = linked.link.desktop_id;
  tracing::info!(target: LOG_TARGET, %desktop_id, "linked");
  let mut linked = Arc::new(linked);
  let host = SidecarHarnessHost::new(
    HostSettings {
      sidecar: SidecarSettings {
        launch: SidecarLaunch::from_source(settings.bun.clone()),
        holder_root: data.join("agent-holder"),
        socket_dir: None,
        sidecar_version: env!("CARGO_PKG_VERSION").to_owned(),
        app_version: env!("CARGO_PKG_VERSION").to_owned(),
        // Set from the account the runner connects for.
        api_origin: String::new(),
        hello_timeout: Duration::from_secs(10),
        start_timeout: Duration::from_secs(30),
        shutdown_grace: Duration::from_secs(10),
        backoff: ReconnectBackoff::DEFAULT,
      },
      workspaces: data.join("agent-runs"),
      package_cache: data.join("agent-package-cache"),
      probe_interval: super::sidecar_host::PROBE_INTERVAL,
    },
    Arc::new(StandInHarnesses {
      codex: settings.codex.clone(),
      claude_code: settings.claude_code.clone(),
      homes,
    }),
  );
  let host_dyn: Arc<dyn HarnessHost> = Arc::new(host.clone());
  let reports: Arc<dyn HarnessReports> = Arc::new(host.clone());
  let journal = Arc::new(SharedJournal::default());
  let state = Arc::new(watch::channel(RunnerState::Off).0);
  let mut observed = state.subscribe();
  tokio::spawn(async move {
    while observed.changed().await.is_ok() {
      let current = observed.borrow().clone();
      tracing::info!(target: LOG_TARGET, state = ?current, "runner state");
    }
  });
  let offline = settings.state.join(OFFLINE_FILE);
  let relink = settings.state.join(RELINK_FILE);
  let (_wake, wakes) = watch::channel(0_u64);
  let termination = terminated();
  tokio::pin!(termination);
  loop {
    tokio::select! {
      () = file_becomes(&offline, false) => {}
      () = &mut termination => break,
    }
    let (stop, stopped) = watch::channel(false);
    let runner = Runner::new(RunnerParts {
      config: RunnerConfig {
        desktop_id,
        app_version: env!("CARGO_PKG_VERSION").to_owned(),
        timing: RunnerTiming::default(),
        random: || 0.5,
      },
      auth: Arc::new(StandInAuth(Arc::clone(&linked))),
      journals: Arc::new(StandInJournals(data.join("journal"))),
      journal: Arc::clone(&journal),
      host: Arc::clone(&host_dyn),
      reports: Arc::clone(&reports),
      state: Arc::clone(&state),
      wakes: wakes.clone(),
      stop: stopped,
    });
    tracing::info!(target: LOG_TARGET, "runner starting");
    let task = tokio::spawn(runner.run());
    let next = tokio::select! {
      () = file_becomes(&offline, true) => Next::Continue,
      () = file_becomes(&relink, true) => Next::Relink,
      () = &mut termination => Next::Stop,
    };
    tracing::info!(target: LOG_TARGET, "runner stopping");
    stop.send_replace(true);
    if task.await.is_err() {
      tracing::warn!(target: LOG_TARGET, "the runner task failed");
    }
    match next {
      Next::Stop => break,
      Next::Continue => {}
      Next::Relink => {
        tracing::info!(target: LOG_TARGET, %desktop_id, "linking this computer again");
        linked = Arc::new(link(&settings, Some(desktop_id)).await?);
        std::fs::remove_file(&relink)
          .map_err(|error| format!("{}: {error}", relink.display()))?;
      }
    }
  }
  tracing::info!(target: LOG_TARGET, "stopping the runs and the holder");
  host.stop_holders().await;
  Ok(())
}

/// Runs the stand-in computer until SIGTERM; its exit code.
pub(crate) fn main() -> i32 {
  let _logging = tracing_subscriber::fmt()
    .with_env_filter(
      std::env::var("RUST_LOG")
        .unwrap_or_else(|_| "stella_desktop_lib=info,warn".into()),
    )
    .try_init();
  let settings = match Settings::from_env() {
    Ok(settings) => settings,
    Err(error) => {
      tracing::error!(target: LOG_TARGET, "{error}");
      return 2;
    }
  };
  let runtime = match tokio::runtime::Builder::new_multi_thread()
    .enable_all()
    .build()
  {
    Ok(runtime) => runtime,
    Err(error) => {
      tracing::error!(target: LOG_TARGET, "no async runtime: {error}");
      return 1;
    }
  };
  match runtime.block_on(serve(settings)) {
    Ok(()) => 0,
    Err(error) => {
      tracing::error!(target: LOG_TARGET, "{error}");
      1
    }
  }
}

#[cfg(test)]
mod tests {
  use super::loopback_origin;

  #[test]
  fn links_only_to_a_plain_http_stack_on_this_computer() {
    assert_eq!(
      loopback_origin("http://localhost:3097").as_deref(),
      Ok("http://localhost:3097")
    );
    assert_eq!(
      loopback_origin("http://127.0.0.1:3097/").as_deref(),
      Ok("http://127.0.0.1:3097")
    );
    for refused in [
      "https://api.stll.app",
      "http://api.stll.app",
      "https://localhost:3097",
      "http://localhost.stll.app:3097",
      "http://user@localhost:3097",
      "http://localhost:3097/v1",
      "http://localhost:3097?next=x",
      "localhost:3097",
    ] {
      assert!(loopback_origin(refused).is_err(), "{refused} was accepted");
    }
  }
}
