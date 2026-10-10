use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::{
  collections::{BTreeSet, HashMap, VecDeque},
  io::Cursor,
  sync::{Mutex, OnceLock},
};

#[cfg(target_os = "macos")]
use icns::{IconFamily, PixelFormat};
#[cfg(target_os = "macos")]
use std::{
  fs::File,
  io::BufReader,
  path::{Component, Path, PathBuf},
};

const MAX_SOURCE_APP_ICON_DATA_URL_BYTES: usize = 48 * 1024;
pub(crate) const MAX_SOURCE_APP_VISUALS: usize = 128;
const SOURCE_APP_ICON_SIZE: u32 = 48;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardSourceAppVisual {
  pub color: Option<String>,
  pub icon_data_url: Option<String>,
  pub key: String,
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

#[derive(Default)]
struct NativeAppVisualCache {
  entries: HashMap<String, Option<ClipboardSourceAppVisual>>,
  order: VecDeque<String>,
}

impl NativeAppVisualCache {
  fn insert(&mut self, key: String, visual: Option<ClipboardSourceAppVisual>) {
    if self.entries.contains_key(&key) {
      self.entries.insert(key, visual);
      return;
    }
    if self.entries.len() >= MAX_SOURCE_APP_VISUALS
      && let Some(oldest) = self.order.pop_front()
    {
      self.entries.remove(&oldest);
    }
    self.order.push_back(key.clone());
    self.entries.insert(key, visual);
  }
}

/// Shared process-local cache: app metadata only, never clipboard content.
/// Failed lookups are cached too so sampling never retries a missing icon.
fn native_app_visual_cache() -> &'static Mutex<NativeAppVisualCache> {
  static CACHE: OnceLock<Mutex<NativeAppVisualCache>> = OnceLock::new();
  CACHE.get_or_init(|| Mutex::new(NativeAppVisualCache::default()))
}

pub(crate) fn foreground_app_visual(
  foreground: &crate::foreground_app::ForegroundApp,
) -> Option<ClipboardSourceAppVisual> {
  let key = foreground
    .identifier
    .clone()
    .unwrap_or_else(|| foreground.name.clone());
  let Ok(mut cache) = native_app_visual_cache().lock() else {
    return None;
  };
  if let Some(visual) = cache.entries.get(&key) {
    return visual.clone();
  }
  #[cfg(target_os = "macos")]
  let visual = foreground
    .bundle_path
    .as_deref()
    .and_then(|bundle_path| macos_source_app_icon(Path::new(bundle_path)))
    .map(source_app_visual)
    .and_then(|visual| source_app_visual_metadata(key.clone(), visual));
  #[cfg(target_os = "windows")]
  let visual = source_app_visual_metadata(
    key.clone(),
    windows_icons::get_icon_by_process_id(foreground.process_id)
      .ok()
      .map_or((None, None), source_app_visual),
  );
  #[cfg(not(any(target_os = "macos", target_os = "windows")))]
  let visual = {
    let _ = &key;
    None
  };
  cache.insert(key, visual.clone());
  visual
}

pub(crate) fn cached_app_visuals<'a>(
  identifiers: impl Iterator<Item = &'a str>,
) -> Vec<ClipboardSourceAppVisual> {
  let Ok(cache) = native_app_visual_cache().lock() else {
    return Vec::new();
  };
  #[cfg(target_os = "macos")]
  let mut cache = cache;
  let keys: BTreeSet<_> = identifiers.collect();
  keys
    .into_iter()
    .filter_map(|key| {
      #[cfg(target_os = "macos")]
      if !cache.entries.contains_key(key) {
        use objc2_app_kit::NSWorkspace;
        use objc2_foundation::NSString;
        // Resolve an installed bundle through the OS; identifiers are never paths.
        let visual = crate::foreground_app::normalized_identifier(key)
          .ok()
          .and_then(|_| {
            NSWorkspace::sharedWorkspace()
              .URLForApplicationWithBundleIdentifier(&NSString::from_str(key))
          })
          .and_then(|url| url.path())
          .and_then(|path| macos_source_app_icon(Path::new(&path.to_string())))
          .map(source_app_visual)
          .and_then(|visual| source_app_visual_metadata(key.to_string(), visual));
        cache.insert(key.to_string(), visual);
      }
      cache.entries.get(key).and_then(Clone::clone)
    })
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn native_visual_cache_keeps_misses_and_evicts_only_the_oldest_app() {
    let mut cache = NativeAppVisualCache::default();
    for index in 0..MAX_SOURCE_APP_VISUALS {
      cache.insert(format!("app-{index}"), None);
    }
    assert_eq!(cache.entries.len(), MAX_SOURCE_APP_VISUALS);
    assert_eq!(cache.entries.get("app-0"), Some(&None));
    // Updating an existing entry does not duplicate its eviction position.
    cache.insert("app-0".to_string(), None);
    cache.insert("new-app".to_string(), None);
    assert_eq!(cache.entries.len(), MAX_SOURCE_APP_VISUALS);
    assert!(!cache.entries.contains_key("app-0"));
    assert!(cache.entries.contains_key("app-1"));
    assert!(cache.entries.contains_key("new-app"));
    assert_eq!(cache.order.len(), cache.entries.len());
  }

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
