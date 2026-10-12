use crate::{config::APP_DATA_DIR_NAME, desktop_telemetry::*, local_store::StoreKey};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use std::{collections::HashMap, io::Cursor, sync::Arc, time::Instant};
use stella_desktop_clipboard_history::boundary::{
  HistoryErrorCode, HistoryObserver, HistorySpan,
};
pub use stella_desktop_clipboard_history::clipboard::*;
use tauri::{AppHandle, Emitter};
#[cfg(target_os = "macos")]
use {
  icns::{IconFamily, PixelFormat},
  std::{
    fs::File,
    io::BufReader,
    path::{Component, Path, PathBuf},
  },
};
const SOURCE_APP_ICON_SIZE: u32 = 48;
const MAX_SOURCE_APP_ICON_DATA_URL_BYTES: usize = 48 * 1024;
struct DesktopHistoryObserver {
  app: AppHandle,
  telemetry: DesktopTelemetry,
}
impl HistoryObserver for DesktopHistoryObserver {
  fn changed(&self) {
    let _ = self.app.emit("clipboard-history-changed", ());
  }
  fn error(&self, code: HistoryErrorCode) {
    let operation = match code {
      HistoryErrorCode::InitializationLockPoisoned
      | HistoryErrorCode::ClipboardUnavailable
      | HistoryErrorCode::WatcherUnavailable => {
        DesktopTelemetryOperation::ClipboardWatcherStart
      }
      HistoryErrorCode::LockPoisoned
      | HistoryErrorCode::FormatReadFailed
      | HistoryErrorCode::PersistenceFailed => {
        DesktopTelemetryOperation::ClipboardWatcherRead
      }
    };
    let code = match code {
      HistoryErrorCode::LockPoisoned | HistoryErrorCode::InitializationLockPoisoned => {
        DesktopTelemetryErrorCode::LockPoisoned
      }
      HistoryErrorCode::FormatReadFailed => DesktopTelemetryErrorCode::FormatReadFailed,
      HistoryErrorCode::PersistenceFailed => {
        DesktopTelemetryErrorCode::PersistenceFailed
      }
      HistoryErrorCode::ClipboardUnavailable => {
        DesktopTelemetryErrorCode::ClipboardUnavailable
      }
      HistoryErrorCode::WatcherUnavailable => {
        DesktopTelemetryErrorCode::WatcherUnavailable
      }
    };
    self.telemetry.capture(DesktopErrorReport {
      window: DesktopTelemetryWindow::Clipboard,
      operation,
      code,
    });
  }
  fn timing(
    &self,
    span: HistorySpan,
    duration: std::time::Duration,
    item_count: Option<usize>,
  ) {
    let span = match span {
      HistorySpan::Initialize => DesktopTelemetrySpan::ClipboardInitialize,
      HistorySpan::KeychainRead => DesktopTelemetrySpan::ClipboardKeychainRead,
      HistorySpan::StoreLoad => DesktopTelemetrySpan::ClipboardStoreLoad,
    };
    self.telemetry.capture_timing(DesktopTimingReport {
      window: DesktopTelemetryWindow::Clipboard,
      span,
      duration,
      open_kind: None,
      item_count,
      payload_bytes: None,
    });
  }
}
pub fn history_observer(
  app: AppHandle,
  telemetry: DesktopTelemetry,
) -> Arc<dyn HistoryObserver> {
  Arc::new(DesktopHistoryObserver { app, telemetry })
}
struct DesktopSourceAppProvider(AppHandle);
impl MainThreadRunner for DesktopSourceAppProvider {
  fn current_source_app(&self) -> Option<ClipboardSourceCapture> {
    frontmost_source_app(&self.0)
  }
}
pub fn initialize_and_watch(
  manager: ClipboardAppState,
  app: AppHandle,
  telemetry: DesktopTelemetry,
) {
  let started = Instant::now();
  let observer = history_observer(app.clone(), telemetry);
  let store_path = dirs::data_dir().map(|dir| {
    dir
      .join(APP_DATA_DIR_NAME)
      .join("clipboard-history.json.enc")
  });
  let (key, keychain_read) = if crate::local_store::debug_build_is_memory_only(
    "STELLA_ENABLE_DEBUG_CLIPBOARD_PERSISTENCE",
  ) {
    (StoreKey::MemoryOnly, None)
  } else if let Some(path) = &store_path {
    let key_started = Instant::now();
    let key = crate::local_store::resolve_key(
      crate::keychain::LocalDataKey::ClipboardHistory,
      path.is_file(),
    );
    (key, Some(key_started.elapsed()))
  } else {
    observer.error(HistoryErrorCode::PersistenceFailed);
    (StoreKey::MemoryOnly, None)
  };
  let loaded = match store_path {
    Some(path) => stella_desktop_clipboard_history::clipboard::load_persisted(
      key,
      path,
      observer.as_ref(),
    ),
    None => (
      ClipboardLoad::memory_only(),
      ClipboardInitTimings::default(),
    ),
  };
  let (load, mut timings) = loaded;
  timings.keychain_read = keychain_read;
  stella_desktop_clipboard_history::clipboard::initialize_and_watch(
    manager,
    Arc::new(DesktopSourceAppProvider(app.clone())),
    observer,
    (load, timings),
    started,
  );
}
fn dominant_icon_color(icon: &image::RgbaImage) -> Option<String> {
  let mut buckets = HashMap::<(u8, u8, u8), (u64, u64, u64, u64)>::new();
  for pixel in icon.pixels() {
    let [red, green, blue, alpha] = pixel.0;
    if alpha < 48 {
      continue;
    }
    let maximum = red.max(green).max(blue);
    let minimum = red.min(green).min(blue);
    let chroma = maximum - minimum;
    let weight = u64::from(alpha) * u64::from(chroma.saturating_add(24));
    let bucket = (red / 32, green / 32, blue / 32);
    let entry = buckets.entry(bucket).or_default();
    entry.0 += weight;
    entry.1 += u64::from(red) * weight;
    entry.2 += u64::from(green) * weight;
    entry.3 += u64::from(blue) * weight;
  }
  let (_, (weight, red, green, blue)) =
    buckets.into_iter().max_by_key(|(_, values)| values.0)?;
  if weight == 0 {
    return None;
  }
  Some(format!(
    "#{:02x}{:02x}{:02x}",
    red / weight,
    green / weight,
    blue / weight
  ))
}

fn source_app_visual(icon: image::RgbaImage) -> (Option<String>, Option<String>) {
  let icon = image::DynamicImage::ImageRgba8(icon)
    .thumbnail(SOURCE_APP_ICON_SIZE, SOURCE_APP_ICON_SIZE)
    .to_rgba8();
  let color = dominant_icon_color(&icon);
  let mut png = Cursor::new(Vec::new());
  let icon_data_url = image::DynamicImage::ImageRgba8(icon)
    .write_to(&mut png, image::ImageFormat::Png)
    .ok()
    .and_then(|()| {
      let value = format!(
        "data:image/png;base64,{}",
        STANDARD.encode(png.into_inner())
      );
      (value.len() <= MAX_SOURCE_APP_ICON_DATA_URL_BYTES).then_some(value)
    });
  (icon_data_url, color)
}

fn source_app_visual_metadata(
  key: String,
  (icon_data_url, color): (Option<String>, Option<String>),
) -> Option<ClipboardSourceAppVisual> {
  if icon_data_url.is_none() && color.is_none() {
    return None;
  }
  Some(ClipboardSourceAppVisual {
    color,
    icon_data_url,
    key,
  })
}

#[cfg(target_os = "macos")]
fn macos_bundle_icon_path(bundle_path: &Path) -> Option<PathBuf> {
  let info = plist::Value::from_file(bundle_path.join("Contents/Info.plist")).ok()?;
  let icon_name = info.as_dictionary()?.get("CFBundleIconFile")?.as_string()?;
  let mut components = Path::new(icon_name).components();
  let Component::Normal(file_name) = components.next()? else {
    return None;
  };
  if components.next().is_some() {
    return None;
  }
  let mut icon_path = bundle_path.join("Contents/Resources").join(file_name);
  if icon_path.extension().is_none() {
    icon_path.set_extension("icns");
  }
  icon_path.is_file().then_some(icon_path)
}

#[cfg(target_os = "macos")]
fn macos_source_app_icon(bundle_path: &Path) -> Option<image::RgbaImage> {
  let icon_path = macos_bundle_icon_path(bundle_path)?;
  let family = IconFamily::read(BufReader::new(File::open(icon_path).ok()?)).ok()?;
  let mut icon_types = family.available_icons();
  icon_types.sort_by_key(|icon_type| {
    let width = icon_type.pixel_width();
    (
      width < SOURCE_APP_ICON_SIZE,
      width.abs_diff(SOURCE_APP_ICON_SIZE),
    )
  });
  icon_types.into_iter().find_map(|icon_type| {
    let icon = family.get_icon_with_type(icon_type).ok()?;
    let icon = icon.convert_to(PixelFormat::RGBA);
    image::RgbaImage::from_raw(icon.width(), icon.height(), icon.into_data().into_vec())
  })
}

/// The foreground app as a clipboard source, with its icon and accent.
fn frontmost_source_app(app: &AppHandle) -> Option<ClipboardSourceCapture> {
  let foreground = crate::foreground_app::current(app)?;
  let key = foreground
    .identifier
    .clone()
    .unwrap_or_else(|| foreground.name.clone());
  #[cfg(target_os = "macos")]
  let visual = foreground
    .bundle_path
    .as_deref()
    .and_then(|bundle_path| macos_source_app_icon(Path::new(bundle_path)))
    .map(source_app_visual)
    .and_then(|visual| source_app_visual_metadata(key, visual));
  #[cfg(target_os = "windows")]
  let visual = source_app_visual_metadata(
    key,
    windows_icons::get_icon_by_process_id(foreground.process_id)
      .ok()
      .map_or((None, None), source_app_visual),
  );
  #[cfg(not(any(target_os = "macos", target_os = "windows")))]
  let visual = {
    let _ = key;
    None
  };
  Some(ClipboardSourceCapture {
    app: ClipboardSourceApp {
      identifier: foreground.identifier,
      name: foreground.name,
      page: None,
      visual_key: None,
    },
    visual,
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn source_app_visual_uses_the_icon_color_and_a_bounded_png() {
    let icon = image::RgbaImage::from_pixel(
      SOURCE_APP_ICON_SIZE,
      SOURCE_APP_ICON_SIZE,
      image::Rgba([30, 120, 220, 255]),
    );

    let (icon_data_url, color) = source_app_visual(icon);

    assert_eq!(color.as_deref(), Some("#1e78dc"));
    let icon_data_url = icon_data_url.unwrap();
    assert!(icon_data_url.starts_with("data:image/png;base64,"));
    assert!(icon_data_url.len() <= MAX_SOURCE_APP_ICON_DATA_URL_BYTES);
  }
}
