use serde::Serialize;
#[cfg(any(target_os = "macos", test))]
use serde_json::Value;

#[cfg(any(target_os = "macos", test))]
const MAX_FRAMES: usize = 8;
#[cfg(any(target_os = "macos", test))]
const MAX_SYMBOL_BYTES: usize = 200;
#[cfg(target_os = "macos")]
const MAX_REPORT_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCrashFrame {
  pub symbol: String,
  pub image: String,
}

/// Only projected diagnostics leave this module; the source report also
/// contains device identities, paths, registers and arbitrary process data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCrashSummary {
  pub exception_type: Option<String>,
  pub signal: Option<String>,
  pub thread: Option<String>,
  pub frames: Vec<NativeCrashFrame>,
}

#[cfg(not(target_os = "macos"))]
pub fn find_summary(_start_time_secs: u64) -> Option<NativeCrashSummary> {
  None
}

#[cfg(target_os = "macos")]
pub fn find_summary(start_time_secs: u64) -> Option<NativeCrashSummary> {
  use std::{
    fs,
    io::Read,
    time::{Duration, UNIX_EPOCH},
  };

  let directory = dirs::home_dir()?.join("Library/Logs/DiagnosticReports");
  let started = UNIX_EPOCH.checked_add(Duration::from_secs(start_time_secs))?;
  let entries = fs::read_dir(directory).ok()?;
  let mut newest = None;
  for entry in entries.flatten() {
    let name = entry.file_name();
    let Some(name) = name.to_str() else { continue };
    if !name.starts_with("stella-desktop-") || !name.ends_with(".ips") {
      continue;
    }
    let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
      continue;
    };
    if !metadata.is_file() || metadata.len() > MAX_REPORT_BYTES {
      continue;
    }
    let Ok(created) = metadata.created() else {
      continue;
    };
    if created <= started || newest.as_ref().is_some_and(|(time, _)| created <= *time) {
      continue;
    }
    newest = Some((created, entry.path()));
  }
  let (_, path) = newest?;
  let mut report = String::new();
  fs::File::open(path)
    .ok()?
    .take(MAX_REPORT_BYTES + 1)
    .read_to_string(&mut report)
    .ok()?;
  if u64::try_from(report.len()).map_or(true, |len| len > MAX_REPORT_BYTES) {
    return None;
  }
  parse_summary(&report)
}

#[cfg(any(target_os = "macos", test))]
fn parse_summary(report: &str) -> Option<NativeCrashSummary> {
  // Apple's .ips format is a one-line metadata object followed by the report.
  let (_, body) = report.split_once('\n')?;
  let report: Value = serde_json::from_str(body).ok()?;
  if report.get("procName")?.as_str()? != "stella-desktop" {
    return None;
  }
  let exception = report.get("exception")?;
  let exception_type =
    exception
      .get("type")
      .and_then(Value::as_str)
      .and_then(|value| {
        matches!(
          value,
          "EXC_BAD_ACCESS"
            | "EXC_BAD_INSTRUCTION"
            | "EXC_ARITHMETIC"
            | "EXC_EMULATION"
            | "EXC_SOFTWARE"
            | "EXC_BREAKPOINT"
            | "EXC_CRASH"
            | "EXC_RESOURCE"
            | "EXC_GUARD"
            | "EXC_CORPSE_NOTIFY"
        )
        .then(|| value.to_owned())
      });
  let signal = exception
    .get("signal")
    .and_then(Value::as_str)
    .and_then(|value| {
      matches!(
        value,
        "SIGABRT"
          | "SIGBUS"
          | "SIGFPE"
          | "SIGILL"
          | "SIGKILL"
          | "SIGSEGV"
          | "SIGSYS"
          | "SIGTERM"
          | "SIGTRAP"
      )
      .then(|| value.to_owned())
    });
  let thread_index = usize::try_from(report.get("faultingThread")?.as_u64()?).ok()?;
  let thread = report.get("threads")?.as_array()?.get(thread_index)?;
  let thread_name = thread
    .get("name")
    .or_else(|| thread.get("queue"))
    .and_then(Value::as_str)
    .map(|name| match name {
      "main"
      | "com.apple.main-thread"
      | "com.apple.AppKitThread"
      | "com.apple.CFSocket.private"
      | "tokio-runtime-worker" => name.to_owned(),
      _ => crate::desktop_telemetry::message_digest(name),
    });
  let images = report.get("usedImages")?.as_array()?;
  let frames = thread
    .get("frames")?
    .as_array()?
    .iter()
    .take(MAX_FRAMES)
    .filter_map(|frame| {
      let symbol = safe_symbol(frame.get("symbol")?.as_str()?)?;
      let image_index = usize::try_from(frame.get("imageIndex")?.as_u64()?).ok()?;
      let image = images.get(image_index)?.get("name")?.as_str()?;
      // Never derive a basename from a path: an arbitrary filename can itself
      // contain a document name or a username. Keep only shipped/system images.
      if !matches!(
        image,
        "stella-desktop"
          | "AppKit"
          | "Foundation"
          | "CoreFoundation"
          | "CoreGraphics"
          | "CoreServices"
          | "WebKit"
          | "JavaScriptCore"
          | "HIToolbox"
          | "Security"
          | "libdispatch.dylib"
          | "libsystem_kernel.dylib"
          | "libsystem_pthread.dylib"
          | "libsystem_c.dylib"
          | "libsystem_platform.dylib"
          | "libobjc.A.dylib"
          | "libc++abi.dylib"
          | "libc++.1.dylib"
          | "dyld"
      ) {
        return None;
      }
      Some(NativeCrashFrame {
        symbol,
        image: image.to_owned(),
      })
    })
    .collect();
  Some(NativeCrashSummary {
    exception_type,
    signal,
    thread: thread_name,
    frames,
  })
}

#[cfg(any(target_os = "macos", test))]
fn safe_symbol(value: &str) -> Option<String> {
  if value.is_empty()
    || value.len() > MAX_SYMBOL_BYTES
    || !value
      .bytes()
      .all(|c| c.is_ascii_alphanumeric() || b"_:[]()+-<> ,*&~".contains(&c))
  {
    return None;
  }
  // An address can be disguised as a valid identifier; UUIDs use only the
  // otherwise permitted hexadecimal digits and hyphens.
  if value.contains("0x")
    || value
      .split(|c: char| !(c.is_ascii_hexdigit() || c == '-'))
      .any(|part| uuid::Uuid::parse_str(part).is_ok())
  {
    return None;
  }
  // Demangled signatures may contain values; retain only the function name.
  if value.contains("::")
    && let Some((function, _)) = value.split_once('(')
  {
    return safe_symbol(function);
  }
  if value.contains(' ') {
    let objc = value
      .strip_prefix("-[")
      .or_else(|| value.strip_prefix("+["))
      .and_then(|symbol| symbol.strip_suffix(']'))
      .and_then(|symbol| symbol.split_once(' '))
      .is_some_and(|(class, selector)| {
        !class.is_empty()
          && class
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_()".contains(&c))
          && !selector.is_empty()
          && selector
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_:".contains(&c))
      });
    if objc {
      return Some(value.to_owned());
    }
    return None;
  }
  if value.contains(['(', ')']) {
    return None;
  }
  Some(value.to_owned())
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn fixture() -> Value {
    json!({
      "procName": "stella-desktop",
      "procPath": "/Volumes/Example/Stella.app/Contents/MacOS/stella-desktop",
      "exception": {"type": "EXC_BREAKPOINT", "signal": "SIGTRAP", "codes": "0x00000001"},
      "faultingThread": 0,
      "threads": [{"queue": "com.apple.main-thread", "frames": [{"symbol": "-[NSStatusBar statusItemWithLength:]", "imageIndex": 0}], "threadState": {"register": "0x123456"}}],
      "usedImages": [{"name": "AppKit", "path": "/Volumes/Example/AppKit", "uuid": "00000000-0000-0000-0000-000000000001"}],
      "hostname": "example-host"
    })
  }

  fn parse_fixture(value: &Value) -> NativeCrashSummary {
    parse_summary(&format!("{{\"app_name\":\"stella-desktop\"}}\n{value}"))
      .expect("synthetic report parses")
  }

  #[test]
  fn projects_only_the_exception_and_faulting_stack() {
    assert_eq!(
      safe_symbol("std::terminate(char const*)").as_deref(),
      Some("std::terminate")
    );
    assert_eq!(
      safe_symbol("std::terminate(alice)").as_deref(),
      Some("std::terminate")
    );
    let summary = parse_fixture(&fixture());
    assert_eq!(summary.exception_type.as_deref(), Some("EXC_BREAKPOINT"));
    assert_eq!(summary.signal.as_deref(), Some("SIGTRAP"));
    assert_eq!(summary.thread.as_deref(), Some("com.apple.main-thread"));
    assert_eq!(
      summary.frames,
      vec![NativeCrashFrame {
        symbol: "-[NSStatusBar statusItemWithLength:]".into(),
        image: "AppKit".into()
      }]
    );
    let serialized = serde_json::to_string(&summary).unwrap();
    for private in [
      "Volumes",
      "Example",
      "uuid",
      "register",
      "0x",
      "hostname",
      "example-host",
    ] {
      assert!(!serialized.contains(private), "leaked {private}");
    }
  }

  #[test]
  fn strips_identifiers_that_can_contain_private_data() {
    for private in [
      "/Volumes/Example/alice",
      "C:\\Example\\alice",
      "alice@example.test",
      "example-host.invalid",
      "00000000-0000-0000-0000-000000000001",
      "0x123456789",
      "symbol /Volumes/Example/alice",
      "Attorney client notes",
      "private document (alice)",
    ] {
      let mut report = fixture();
      report["threads"][0]["name"] = json!(private);
      report["threads"][0]["frames"][0]["symbol"] = json!(private);
      report["exception"]["type"] = json!(private);
      report["exception"]["signal"] = json!(private);
      let summary = parse_fixture(&report);
      assert!(summary.frames.is_empty());
      assert!(summary.exception_type.is_none());
      assert!(summary.signal.is_none());
      assert_eq!(
        summary.thread,
        Some(crate::desktop_telemetry::message_digest(private))
      );
      assert!(!serde_json::to_string(&summary).unwrap().contains(private));
      report["threads"][0]["frames"][0]["symbol"] = json!("abort");
      report["usedImages"][0]["name"] = json!(private);
      assert!(parse_fixture(&report).frames.is_empty());
    }
  }

  #[test]
  fn bounds_stack_and_rejects_invalid_report_shapes() {
    let mut report = fixture();
    report["threads"][0]["frames"] =
      json!(vec![json!({"symbol": "abort", "imageIndex": 0}); 20]);
    assert_eq!(parse_fixture(&report).frames.len(), MAX_FRAMES);
    report["faultingThread"] = json!(999);
    assert!(parse_summary(&format!("{{}}\n{report}")).is_none());
    report["faultingThread"] = json!(0);
    report["procName"] = json!("other-app");
    assert!(parse_summary(&format!("{{}}\n{report}")).is_none());
    assert!(parse_summary("not a crash report").is_none());
  }
}
