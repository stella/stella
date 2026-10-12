//! Private persistence and verified-webview representations of clipboard content.

use super::*;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WireClipboardSourcePage {
  /// Display name; `origin` also identifies page icons stored by older installs.
  pub host: String,
  pub origin: String,
  pub url: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WireClipboardSourceApp {
  pub identifier: Option<String>,
  pub name: String,
  /// The web page a browser copied from, when the browser advertised it.
  #[serde(default)]
  pub page: Option<WireClipboardSourcePage>,
  /// Key of the visual the webview should render for this source, resolved
  /// by the manager when the item is prepared for the webview (see
  /// `ClipboardManager::webview_item`). Persisted items carry `None`.
  #[serde(default)]
  pub visual_key: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WireClipboardSourceAppVisual {
  pub color: Option<String>,
  pub icon_data_url: Option<String>,
  pub key: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WireClipboardSourceAppExclusion {
  pub identifier: String,
  pub name: String,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum WireClipboardItem {
  Text {
    #[serde(rename = "copiedAt", alias = "copied_at")]
    copied_at: DateTime<Utc>,
    #[serde(rename = "groupId", alias = "group_id")]
    group_id: Option<String>,
    /// When the clip joined its group. Groups list clips in this order, so
    /// copying a clip again never reshuffles a group.
    #[serde(default, rename = "groupedAt", alias = "grouped_at")]
    grouped_at: Option<DateTime<Utc>>,
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(rename = "plainText", alias = "plain_text")]
    plain_text: String,
    #[serde(
      default,
      rename = "retentionClass",
      alias = "retention_class",
      skip_serializing_if = "ClipboardItemRetentionClass::is_history"
    )]
    retention_class: ClipboardItemRetentionClass,
    #[serde(default, rename = "sourceApp", alias = "source_app")]
    source_app: Option<WireClipboardSourceApp>,
  },
  FormattedText {
    #[serde(rename = "copiedAt", alias = "copied_at")]
    copied_at: DateTime<Utc>,
    #[serde(rename = "groupId", alias = "group_id")]
    group_id: Option<String>,
    /// When the clip joined its group. Groups list clips in this order, so
    /// copying a clip again never reshuffles a group.
    #[serde(default, rename = "groupedAt", alias = "grouped_at")]
    grouped_at: Option<DateTime<Utc>>,
    html: String,
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(rename = "plainText", alias = "plain_text")]
    plain_text: String,
    #[serde(
      default,
      rename = "retentionClass",
      alias = "retention_class",
      skip_serializing_if = "ClipboardItemRetentionClass::is_history"
    )]
    retention_class: ClipboardItemRetentionClass,
    /// The source app's RTF, written back verbatim on paste so RTF-first
    /// targets receive the original formatting. Never crosses IPC (see
    /// `for_webview`) and is dropped once the clip is edited.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rtf: Option<String>,
    #[serde(default, rename = "sourceApp", alias = "source_app")]
    source_app: Option<WireClipboardSourceApp>,
  },
  Image {
    #[serde(rename = "blobId", skip_serializing_if = "String::is_empty")]
    blob_id: String,
    #[serde(rename = "byteSize")]
    byte_size: usize,
    #[serde(skip_serializing_if = "String::is_empty")]
    checksum: String,
    #[serde(rename = "copiedAt", alias = "copied_at")]
    copied_at: DateTime<Utc>,
    #[serde(rename = "groupId", alias = "group_id")]
    group_id: Option<String>,
    /// When the clip joined its group. Groups list clips in this order, so
    /// copying a clip again never reshuffles a group.
    #[serde(default, rename = "groupedAt", alias = "grouped_at")]
    grouped_at: Option<DateTime<Utc>>,
    height: u32,
    id: String,
    #[serde(skip)]
    image: Option<Arc<[u8]>>,
    #[serde(default)]
    name: Option<String>,
    #[serde(skip)]
    preview: Option<Arc<[u8]>>,
    #[serde(
      default,
      rename = "retentionClass",
      alias = "retention_class",
      skip_serializing_if = "ClipboardItemRetentionClass::is_history"
    )]
    retention_class: ClipboardItemRetentionClass,
    #[serde(default, rename = "sourceApp", alias = "source_app")]
    source_app: Option<WireClipboardSourceApp>,
    width: u32,
  },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WireClipboardGroup {
  #[serde(default)]
  pub color: ClipboardGroupColor,
  pub id: String,
  pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WireClipboardSnapshot {
  pub capture_status: ClipboardCaptureStatus,
  pub group_limit: usize,
  pub groups: Vec<WireClipboardGroup>,
  pub items: Vec<WireClipboardItem>,
  pub persistence: ClipboardPersistenceStatus,
  pub retention: ClipboardRetention,
  pub screen_capture: ClipboardScreenCapture,
  pub source_app_exclusion_limit: usize,
  pub source_app_exclusions: Vec<WireClipboardSourceAppExclusion>,
  pub source_app_visuals: Vec<WireClipboardSourceAppVisual>,
  pub welcome_status: ClipboardWelcomeStatus,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WirePersistedClipboardState {
  pub capture_status: ClipboardCaptureStatus,
  #[serde(default)]
  pub groups: Vec<WireClipboardGroup>,
  pub items: Vec<WireClipboardItem>,
  /// Blobs no longer referenced by items. Persisting this journal before
  /// deletion makes cleanup replayable after I/O failures or a crash.
  #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
  pub pending_image_blob_ids: BTreeSet<String>,
  #[serde(default)]
  pub retention: ClipboardRetention,
  #[serde(default)]
  pub source_app_exclusions: Vec<WireClipboardSourceAppExclusion>,
  #[serde(default)]
  pub source_app_visuals: Vec<WireClipboardSourceAppVisual>,
}

impl From<&ClipboardSourcePage> for WireClipboardSourcePage {
  fn from(value: &ClipboardSourcePage) -> Self {
    let ClipboardSourcePage { host, origin, url } = value;
    Self {
      host: host.clone(),
      origin: origin.clone(),
      url: url.clone(),
    }
  }
}

impl From<WireClipboardSourcePage> for ClipboardSourcePage {
  fn from(value: WireClipboardSourcePage) -> Self {
    let WireClipboardSourcePage { host, origin, url } = value;
    Self { host, origin, url }
  }
}

impl From<&ClipboardSourceApp> for WireClipboardSourceApp {
  fn from(value: &ClipboardSourceApp) -> Self {
    let ClipboardSourceApp {
      identifier,
      name,
      page,
      visual_key,
    } = value;
    Self {
      identifier: identifier.clone(),
      name: name.clone(),
      page: page.as_ref().map(Into::into),
      visual_key: visual_key.clone(),
    }
  }
}

impl From<WireClipboardSourceApp> for ClipboardSourceApp {
  fn from(value: WireClipboardSourceApp) -> Self {
    let WireClipboardSourceApp {
      identifier,
      name,
      page,
      visual_key,
    } = value;
    Self {
      identifier,
      name,
      page: page.map(Into::into),
      visual_key,
    }
  }
}

impl From<&ClipboardSourceAppVisual> for WireClipboardSourceAppVisual {
  fn from(value: &ClipboardSourceAppVisual) -> Self {
    let ClipboardSourceAppVisual {
      color,
      icon_data_url,
      key,
    } = value;
    Self {
      color: color.clone(),
      icon_data_url: icon_data_url.clone(),
      key: key.clone(),
    }
  }
}

impl From<WireClipboardSourceAppVisual> for ClipboardSourceAppVisual {
  fn from(value: WireClipboardSourceAppVisual) -> Self {
    let WireClipboardSourceAppVisual {
      color,
      icon_data_url,
      key,
    } = value;
    Self {
      color,
      icon_data_url,
      key,
    }
  }
}

impl From<&ClipboardSourceAppExclusion> for WireClipboardSourceAppExclusion {
  fn from(value: &ClipboardSourceAppExclusion) -> Self {
    let ClipboardSourceAppExclusion { identifier, name } = value;
    Self {
      identifier: identifier.clone(),
      name: name.clone(),
    }
  }
}

impl From<WireClipboardSourceAppExclusion> for ClipboardSourceAppExclusion {
  fn from(value: WireClipboardSourceAppExclusion) -> Self {
    let WireClipboardSourceAppExclusion { identifier, name } = value;
    Self { identifier, name }
  }
}

impl From<&ClipboardItem> for WireClipboardItem {
  fn from(value: &ClipboardItem) -> Self {
    match value {
      ClipboardItem::Text {
        copied_at,
        group_id,
        grouped_at,
        id,
        name,
        plain_text,
        retention_class,
        source_app,
      } => Self::Text {
        copied_at: *copied_at,
        group_id: group_id.clone(),
        grouped_at: *grouped_at,
        id: id.clone(),
        name: name.clone(),
        plain_text: plain_text.clone(),
        retention_class: *retention_class,
        source_app: source_app.as_ref().map(Into::into),
      },
      ClipboardItem::FormattedText {
        copied_at,
        group_id,
        grouped_at,
        html,
        id,
        name,
        plain_text,
        retention_class,
        rtf,
        source_app,
      } => Self::FormattedText {
        copied_at: *copied_at,
        group_id: group_id.clone(),
        grouped_at: *grouped_at,
        html: html.clone(),
        id: id.clone(),
        name: name.clone(),
        plain_text: plain_text.clone(),
        retention_class: *retention_class,
        rtf: rtf.clone(),
        source_app: source_app.as_ref().map(Into::into),
      },
      ClipboardItem::Image {
        blob_id,
        byte_size,
        checksum,
        copied_at,
        group_id,
        grouped_at,
        height,
        id,
        image,
        name,
        preview,
        retention_class,
        source_app,
        width,
      } => Self::Image {
        blob_id: blob_id.clone(),
        byte_size: *byte_size,
        checksum: checksum.clone(),
        copied_at: *copied_at,
        group_id: group_id.clone(),
        grouped_at: *grouped_at,
        height: *height,
        id: id.clone(),
        image: image.clone(),
        name: name.clone(),
        preview: preview.clone(),
        retention_class: *retention_class,
        source_app: source_app.as_ref().map(Into::into),
        width: *width,
      },
    }
  }
}

impl From<WireClipboardItem> for ClipboardItem {
  fn from(value: WireClipboardItem) -> Self {
    match value {
      WireClipboardItem::Text {
        copied_at,
        group_id,
        grouped_at,
        id,
        name,
        plain_text,
        retention_class,
        source_app,
      } => Self::Text {
        copied_at,
        group_id,
        grouped_at,
        id,
        name,
        plain_text,
        retention_class,
        source_app: source_app.map(Into::into),
      },
      WireClipboardItem::FormattedText {
        copied_at,
        group_id,
        grouped_at,
        html,
        id,
        name,
        plain_text,
        retention_class,
        rtf,
        source_app,
      } => Self::FormattedText {
        copied_at,
        group_id,
        grouped_at,
        html,
        id,
        name,
        plain_text,
        retention_class,
        rtf,
        source_app: source_app.map(Into::into),
      },
      WireClipboardItem::Image {
        blob_id,
        byte_size,
        checksum,
        copied_at,
        group_id,
        grouped_at,
        height,
        id,
        image,
        name,
        preview,
        retention_class,
        source_app,
        width,
      } => Self::Image {
        blob_id,
        byte_size,
        checksum,
        copied_at,
        group_id,
        grouped_at,
        height,
        id,
        image,
        name,
        preview,
        retention_class,
        source_app: source_app.map(Into::into),
        width,
      },
    }
  }
}

impl From<&ClipboardGroup> for WireClipboardGroup {
  fn from(value: &ClipboardGroup) -> Self {
    let ClipboardGroup { color, id, name } = value;
    Self {
      color: color.clone(),
      id: id.clone(),
      name: name.clone(),
    }
  }
}

impl From<WireClipboardGroup> for ClipboardGroup {
  fn from(value: WireClipboardGroup) -> Self {
    let WireClipboardGroup { color, id, name } = value;
    Self { color, id, name }
  }
}

impl From<&ClipboardSnapshot> for WireClipboardSnapshot {
  fn from(value: &ClipboardSnapshot) -> Self {
    let ClipboardSnapshot {
      capture_status,
      group_limit,
      groups,
      items,
      persistence,
      retention,
      screen_capture,
      source_app_exclusion_limit,
      source_app_exclusions,
      source_app_visuals,
      welcome_status,
    } = value;
    Self {
      capture_status: *capture_status,
      group_limit: *group_limit,
      groups: groups.iter().map(Into::into).collect(),
      items: items.iter().map(Into::into).collect(),
      persistence: *persistence,
      retention: *retention,
      screen_capture: *screen_capture,
      source_app_exclusion_limit: *source_app_exclusion_limit,
      source_app_exclusions: source_app_exclusions.iter().map(Into::into).collect(),
      source_app_visuals: source_app_visuals.iter().map(Into::into).collect(),
      welcome_status: *welcome_status,
    }
  }
}

impl From<&PersistedClipboardState> for WirePersistedClipboardState {
  fn from(value: &PersistedClipboardState) -> Self {
    let PersistedClipboardState {
      capture_status,
      groups,
      items,
      pending_image_blob_ids,
      retention,
      source_app_exclusions,
      source_app_visuals,
    } = value;
    Self {
      capture_status: *capture_status,
      groups: groups.iter().map(Into::into).collect(),
      items: items.iter().map(Into::into).collect(),
      pending_image_blob_ids: pending_image_blob_ids.clone(),
      retention: *retention,
      source_app_exclusions: source_app_exclusions.iter().map(Into::into).collect(),
      source_app_visuals: source_app_visuals.iter().map(Into::into).collect(),
    }
  }
}

impl From<WirePersistedClipboardState> for PersistedClipboardState {
  fn from(value: WirePersistedClipboardState) -> Self {
    let WirePersistedClipboardState {
      capture_status,
      groups,
      items,
      pending_image_blob_ids,
      retention,
      source_app_exclusions,
      source_app_visuals,
    } = value;
    Self {
      capture_status,
      groups: groups.into_iter().map(Into::into).collect(),
      items: items.into_iter().map(Into::into).collect(),
      pending_image_blob_ids,
      retention,
      source_app_exclusions: source_app_exclusions
        .into_iter()
        .map(Into::into)
        .collect(),
      source_app_visuals: source_app_visuals.into_iter().map(Into::into).collect(),
    }
  }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WireEditorContext {
  pub group_limit: usize,
  pub groups: Vec<WireClipboardGroup>,
  pub item: WireClipboardItem,
  pub source_app_visual: Option<WireClipboardSourceAppVisual>,
}
