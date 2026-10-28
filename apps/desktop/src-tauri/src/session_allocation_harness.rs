//! Allocation fixtures replace file I/O and the remote server, not checkpoint logic.
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Files {
  bytes: Vec<u8>,
  reads: AtomicUsize,
}

impl SessionFileSystem for Files {
  fn fingerprint(&self, _: &Path) -> std::io::Result<FileFingerprint> {
    Ok(FileFingerprint {
      size: self.bytes.len() as u64,
      modified: std::time::UNIX_EPOCH,
      identity: 1,
    })
  }

  fn read<'a>(
    &'a self,
    _: &'a Path,
  ) -> futures_util::future::BoxFuture<'a, std::io::Result<Vec<u8>>> {
    self.reads.fetch_add(1, Ordering::Relaxed);
    Box::pin(async { Ok(self.bytes.clone()) })
  }
}

pub struct Fixture {
  runtime: tokio::runtime::Runtime,
  manager: Arc<Mutex<SessionManager>>,
  files: Arc<Files>,
  root: PathBuf,
}

impl Fixture {
  pub fn new(size: usize) -> Self {
    assert_eq!(crate::i18n::set_active_locale("en"), Some("en"));
    // Runtime shutdown initializes Tokio's per-thread parker. Warm it before
    // profiling so teardown can prove every operation-owned block is freed.
    drop(
      tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap(),
    );
    let runtime = tokio::runtime::Builder::new_current_thread()
      .enable_all()
      .build()
      .unwrap();
    let runtime_guard = runtime.enter();
    let files = Arc::new(Files {
      bytes: vec![b'x'; size],
      reads: AtomicUsize::new(0),
    });
    let mut manager = SessionManager::new();
    let root =
      std::env::temp_dir().join(format!("stella-alloc-{}", uuid::Uuid::new_v4()));
    manager.store_path = root.join("sessions.json");
    manager.edit_root = root.join("editing");
    manager.file_system = files.clone();
    let sha = hash_bytes(&files.bytes);
    manager.sessions.insert(
      "allocation".into(),
      DesktopSession {
        api_base_url: "http://127.0.0.1".into(),
        base_version_number: 1,
        entity_id: "entity".into(),
        file_type: DesktopEditFileType::Docx,
        file_name: "allocation.docx".into(),
        file_path: "allocation.docx".into(),
        id: "allocation".into(),
        key: "allocation".into(),
        last_checkpoint_at: None,
        last_checkpoint_sha: Some(sha.clone()),
        last_error: None,
        last_local_sha: sha,
        pending_finalize: false,
        property_id: "property".into(),
        session_token: "fixture-token".into(),
        status: SessionStatus::Ready,
        takeover_detected: false,
        workspace_id: "matter".into(),
        generation: uuid::Uuid::new_v4(),
        last_observed_file: Some(
          files.fingerprint(Path::new("allocation.docx")).unwrap(),
        ),
        changed_during_remote_save: false,
        checkpoint_in_flight: false,
        finalize_in_flight: false,
        local_open_seen: false,
        closed_recheck_count: 0,
        retry_notice_shown: false,
        watcher: None,
        checkpoint_timer: None,
        open_probe_timer: None,
        sse_listener: None,
      },
    );
    drop(runtime_guard);
    Self {
      runtime,
      manager: Arc::new(Mutex::new(manager)),
      files,
      root,
    }
  }

  pub fn retry(&self) {
    self
      .runtime
      .block_on(retry_session(self.manager.clone(), "allocation"));
  }

  pub fn reads(&self) -> usize {
    self.files.reads.load(Ordering::Relaxed)
  }

  pub fn invalidate_observation(&self) {
    self.runtime.block_on(async {
      self
        .manager
        .lock()
        .await
        .sessions
        .get_mut("allocation")
        .unwrap()
        .last_observed_file = None;
    });
  }

  pub fn reset_reads(&self) {
    self.files.reads.store(0, Ordering::Relaxed);
  }

  pub fn start_upload(&self) -> std::thread::JoinHandle<()> {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    self.runtime.block_on(async {
      let mut manager = self.manager.lock().await;
      let session = manager.sessions.get_mut("allocation").unwrap();
      session.api_base_url = format!("http://{address}");
      session.last_observed_file = None;
      session.last_checkpoint_sha = Some("different".into());
    });
    let manager = self.manager.clone();
    let (ready, wait) = std::sync::mpsc::sync_channel(0);
    let server = std::thread::spawn(move || {
      // Thread startup allocations occur before the profiler starts.
      ready.send(()).unwrap();
      let (mut stream, _) = listener.accept().unwrap();
      stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
      let mut header = [0u8; 16 * 1024];
      let mut used = 0;
      let end = loop {
        let count = stream.read(&mut header[used..]).unwrap();
        assert_ne!(count, 0);
        used += count;
        if let Some(end) = header[..used]
          .windows(4)
          .position(|bytes| bytes == b"\r\n\r\n")
        {
          break end + 4;
        }
        assert!(
          used < header.len(),
          "request headers exceed fixture capacity"
        );
      };
      let headers = std::str::from_utf8(&header[..end]).unwrap();
      let length: usize = headers
        .lines()
        .find_map(|line| {
          let (name, value) = line.split_once(':')?;
          name
            .eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse().unwrap())
        })
        .expect("multipart body must declare its length");
      let mut remaining = length - (used - end);
      while remaining > 0 {
        let capacity = remaining.min(header.len());
        let count = stream.read(&mut header[..capacity]).unwrap();
        assert_ne!(count, 0);
        remaining -= count;
      }
      assert!(manager.try_lock().is_ok(), "manager held across upload");
      let body = r#"{"checkpointedAt":"2026-01-01T00:00:00Z","noop":false}"#;
      write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    });
    wait.recv().unwrap();
    server
  }
}

impl Drop for Fixture {
  fn drop(&mut self) {
    if self.root.exists() {
      std::fs::remove_dir_all(&self.root).unwrap();
    }
  }
}
