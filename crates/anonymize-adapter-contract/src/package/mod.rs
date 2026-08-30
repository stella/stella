//! Prepared search package encode/decode: header + version validation,
//! digest verification, optional compression, and the postcard payload
//! codec.
//!
//! Layout: `version` owns headers and format-version constants,
//! `digest` owns payload digest verification, `wire` owns the payload
//! codec, and `timing` owns decode-timing diagnostics.

pub(crate) mod digest;
pub(crate) mod format;
pub(crate) mod timing;
pub(crate) mod wire;

use std::borrow::Cow;

use stella_anonymize_core::{PreparedEngineArtifacts, PreparedEngineConfig};

pub use timing::{
  PreparedSearchPackageDecodeTimings, diagnostic_stage_event,
  prepared_search_package_decode_events,
  prepared_search_package_decode_timing_events,
};

use crate::error::Result;
use crate::error::invalid_prepared_search_package;
use crate::types::BindingPreparedSearchConfig;

use digest::{
  prepared_search_compressed_package_digest,
  verify_prepared_search_compressed_package_digest,
  verify_prepared_search_package_digest,
};
use format::{
  BINDING_PACKAGE_SCHEMA_VERSION, CORE_PACKAGE_SCHEMA_VERSION,
  CompressedPackageHeader, MAX_PREPARED_SEARCH_PACKAGE_PAYLOAD_BYTES,
  PREPARED_SEARCH_COMPRESSED_PACKAGE_HEADER,
  PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_HEADER,
  PREPARED_SEARCH_CORE_PACKAGE_HEADER, PREPARED_SEARCH_PACKAGE_DIGEST_BYTES,
  PREPARED_SEARCH_PACKAGE_HEADER, compressed_package_header,
  raw_package_header, raw_package_header_len, write_compressed_package_header,
  write_package_header,
};
use timing::elapsed_us;
use wire::{
  core_package_payload_slices, core_package_view_from_payload,
  decode_core_package_parts, prepared_search_core_package_payload_to_bytes,
  prepared_search_package_payload_to_bytes,
};

#[derive(Clone, Debug, PartialEq)]
pub struct BindingPreparedSearchPackage {
  pub config: BindingPreparedSearchConfig,
  pub artifacts: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CorePreparedSearchPackage {
  pub config: PreparedEngineConfig,
  pub artifacts: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CorePreparedSearchPackageView<'a> {
  pub config: PreparedEngineConfig,
  pub artifacts: CorePreparedSearchPackageArtifacts<'a>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CorePreparedSearchPackageArtifacts<'a> {
  inner: CorePreparedSearchPackageArtifactsInner<'a>,
}

#[derive(Clone, Debug, PartialEq)]
enum CorePreparedSearchPackageArtifactsInner<'a> {
  Borrowed(&'a [u8]),
  OwnedPayload {
    payload: Vec<u8>,
    artifacts_start: usize,
  },
}

impl<'a> CorePreparedSearchPackageArtifacts<'a> {
  const fn borrowed(bytes: &'a [u8]) -> Self {
    Self {
      inner: CorePreparedSearchPackageArtifactsInner::Borrowed(bytes),
    }
  }

  fn owned_payload(payload: Vec<u8>, artifacts_start: usize) -> Result<Self> {
    if payload.get(artifacts_start..).is_none() {
      return Err(invalid_prepared_search_package("missing artifacts"));
    }
    Ok(Self {
      inner: CorePreparedSearchPackageArtifactsInner::OwnedPayload {
        payload,
        artifacts_start,
      },
    })
  }

  #[must_use]
  pub fn as_bytes(&self) -> &[u8] {
    match &self.inner {
      CorePreparedSearchPackageArtifactsInner::Borrowed(bytes) => bytes,
      CorePreparedSearchPackageArtifactsInner::OwnedPayload {
        payload,
        artifacts_start,
      } => payload.get(*artifacts_start..).unwrap_or_default(),
    }
  }

  #[must_use]
  pub fn into_owned(self) -> Vec<u8> {
    match self.inner {
      CorePreparedSearchPackageArtifactsInner::Borrowed(bytes) => {
        bytes.to_vec()
      }
      CorePreparedSearchPackageArtifactsInner::OwnedPayload {
        mut payload,
        artifacts_start,
      } => {
        // `owned_payload` validated the offset; the guard keeps this
        // panic-free if that invariant ever breaks.
        if payload.get(artifacts_start..).is_none() {
          return Vec::new();
        }
        payload.drain(..artifacts_start);
        payload
      }
    }
  }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DecodedCorePreparedSearchPackage {
  pub config: PreparedEngineConfig,
  pub artifacts: PreparedEngineArtifacts,
  pub package_decode_timings: PreparedSearchPackageDecodeTimings,
  pub artifacts_decode: u64,
  pub artifacts_bytes: usize,
}
pub fn prepared_search_package_to_bytes(
  config: &BindingPreparedSearchConfig,
  artifacts: &[u8],
) -> Result<Vec<u8>> {
  let payload = prepared_search_package_payload_to_bytes(config, artifacts)?;
  Ok(prepared_search_package_raw_payload_to_bytes(
    PREPARED_SEARCH_PACKAGE_HEADER,
    BINDING_PACKAGE_SCHEMA_VERSION,
    &payload,
  ))
}

pub fn prepared_search_package_to_compressed_bytes(
  config: &BindingPreparedSearchConfig,
  artifacts: &[u8],
) -> Result<Vec<u8>> {
  let payload = prepared_search_package_payload_to_bytes(config, artifacts)?;
  prepared_search_package_compress_payload(
    PREPARED_SEARCH_COMPRESSED_PACKAGE_HEADER,
    BINDING_PACKAGE_SCHEMA_VERSION,
    &payload,
  )
}

pub fn prepared_search_core_package_to_bytes(
  config: &PreparedEngineConfig,
  artifacts: &[u8],
) -> Result<Vec<u8>> {
  let payload =
    prepared_search_core_package_payload_to_bytes(config, artifacts)?;
  Ok(prepared_search_package_raw_payload_to_bytes(
    PREPARED_SEARCH_CORE_PACKAGE_HEADER,
    CORE_PACKAGE_SCHEMA_VERSION,
    &payload,
  ))
}

pub fn prepared_search_core_package_to_compressed_bytes(
  config: &PreparedEngineConfig,
  artifacts: &[u8],
) -> Result<Vec<u8>> {
  let payload =
    prepared_search_core_package_payload_to_bytes(config, artifacts)?;
  prepared_search_package_compress_payload(
    PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_HEADER,
    CORE_PACKAGE_SCHEMA_VERSION,
    &payload,
  )
}

#[must_use]
pub fn prepared_search_package_has_core_payload(bytes: &[u8]) -> bool {
  bytes
    .get(..PREPARED_SEARCH_CORE_PACKAGE_HEADER.len())
    .is_some_and(|header| {
      header == PREPARED_SEARCH_CORE_PACKAGE_HEADER
        || header == PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_HEADER
    })
}

pub fn prepared_search_package_digest(bytes: &[u8]) -> Result<[u8; 32]> {
  Ok(prepared_search_package_parts(bytes)?.digest())
}

pub fn prepared_search_package_verify_digest_with_timings(
  bytes: &[u8],
) -> Result<PreparedSearchPackageDecodeTimings> {
  let mut timings = PreparedSearchPackageDecodeTimings::default();
  prepared_search_package_parts(bytes)?.verify_digest(&mut timings)?;
  Ok(timings)
}

pub fn prepared_search_package_from_bytes(
  bytes: &[u8],
) -> Result<BindingPreparedSearchPackage> {
  let parts = prepared_search_package_parts(bytes)?;
  if parts.is_core() {
    return Err(invalid_prepared_search_package(
      "package does not contain a binding payload",
    ));
  }
  let mut timings = PreparedSearchPackageDecodeTimings::default();
  let payload = parts.into_verified_payload(&mut timings)?;
  wire::decode_binding_package(payload.as_ref())
}

pub fn prepared_search_core_package_from_bytes(
  bytes: &[u8],
) -> Result<CorePreparedSearchPackage> {
  let package = prepared_search_core_package_view_from_bytes(bytes)?;
  Ok(CorePreparedSearchPackage {
    config: package.config,
    artifacts: package.artifacts.into_owned(),
  })
}

pub fn prepared_search_core_package_view_from_bytes(
  bytes: &[u8],
) -> Result<CorePreparedSearchPackageView<'_>> {
  Ok(prepared_search_core_package_view_from_bytes_with_timings(bytes)?.0)
}

pub fn prepared_search_core_package_view_from_bytes_with_timings(
  bytes: &[u8],
) -> Result<(
  CorePreparedSearchPackageView<'_>,
  PreparedSearchPackageDecodeTimings,
)> {
  prepared_search_core_package_view_from_bytes_with_policy(
    bytes,
    PackageDigestPolicy::Verify,
  )
}

pub fn prepared_search_core_package_view_trusted_from_bytes_with_timings(
  bytes: &[u8],
) -> Result<(
  CorePreparedSearchPackageView<'_>,
  PreparedSearchPackageDecodeTimings,
)> {
  prepared_search_core_package_view_from_bytes_with_policy(
    bytes,
    PackageDigestPolicy::Trust,
  )
}

fn prepared_search_core_package_view_from_bytes_with_policy(
  bytes: &[u8],
  digest_policy: PackageDigestPolicy,
) -> Result<(
  CorePreparedSearchPackageView<'_>,
  PreparedSearchPackageDecodeTimings,
)> {
  let mut timings = PreparedSearchPackageDecodeTimings::default();
  let parts = prepared_search_package_parts(bytes)?;
  if !parts.is_core() {
    return Err(invalid_prepared_search_package(
      "package does not contain a core payload",
    ));
  }
  let payload = parts.into_payload(&mut timings, digest_policy)?;
  let package = core_package_view_from_payload(payload, &mut timings)?;
  Ok((package, timings))
}

pub fn prepared_search_core_package_decode_from_bytes_with_timings(
  bytes: &[u8],
) -> Result<DecodedCorePreparedSearchPackage> {
  prepared_search_core_package_decode_from_bytes_with_policy(
    bytes,
    PackageDigestPolicy::Verify,
  )
}

pub fn prepared_search_core_package_decode_trusted_from_bytes_with_timings(
  bytes: &[u8],
) -> Result<DecodedCorePreparedSearchPackage> {
  prepared_search_core_package_decode_from_bytes_with_policy(
    bytes,
    PackageDigestPolicy::Trust,
  )
}

fn prepared_search_core_package_decode_from_bytes_with_policy(
  bytes: &[u8],
  digest_policy: PackageDigestPolicy,
) -> Result<DecodedCorePreparedSearchPackage> {
  let mut package_decode_timings =
    PreparedSearchPackageDecodeTimings::default();
  let parts = prepared_search_package_parts(bytes)?;
  if !parts.is_core() {
    return Err(invalid_prepared_search_package(
      "package does not contain a core payload",
    ));
  }
  let payload =
    parts.into_payload(&mut package_decode_timings, digest_policy)?;
  let slices = core_package_payload_slices(payload.as_ref())?;
  package_decode_timings.config_bytes = Some(slices.config.len());
  let (config, config_decode, artifacts, artifacts_decode) =
    decode_core_package_parts(slices.config, slices.artifacts)?;
  package_decode_timings.config_decode = Some(config_decode);
  Ok(DecodedCorePreparedSearchPackage {
    config,
    artifacts,
    package_decode_timings,
    artifacts_decode,
    artifacts_bytes: slices.artifacts.len(),
  })
}
fn prepared_search_package_raw_payload_to_bytes(
  header: [u8; 8],
  version: u32,
  payload: &[u8],
) -> Vec<u8> {
  let digest = blake3::hash(payload);
  let mut bytes = Vec::with_capacity(raw_package_header_len(payload));
  write_package_header(&mut bytes, header, version, digest.as_bytes());
  bytes.extend_from_slice(payload);
  bytes
}

fn prepared_search_package_compress_payload(
  header: [u8; 8],
  schema_version: u32,
  payload: &[u8],
) -> Result<Vec<u8>> {
  let compressed = lz4_flex::block::compress(payload);
  let compression = PackageCompression::Lz4;
  let digest =
    prepared_search_compressed_package_digest(compression, &compressed);
  let mut bytes = Vec::with_capacity(
    raw_package_header_len(&compressed)
      .saturating_add(std::mem::size_of::<u8>())
      .saturating_add(std::mem::size_of::<u64>()),
  );
  write_compressed_package_header(
    &mut bytes,
    header,
    schema_version,
    compression,
    digest.as_bytes(),
  );
  let payload_len = u64::try_from(payload.len())
    .map_err(|_| invalid_prepared_search_package("payload length overflow"))?;
  bytes.extend_from_slice(&payload_len.to_le_bytes());
  bytes.extend_from_slice(&compressed);
  Ok(bytes)
}
enum PreparedSearchPackageParts<'a> {
  Raw {
    core: bool,
    digest: [u8; 32],
    payload: &'a [u8],
  },
  Compressed {
    core: bool,
    compression: PackageCompression,
    digest: [u8; 32],
    uncompressed_len: usize,
    payload: &'a [u8],
  },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PackageCompression {
  Lz4,
  Zstd,
}

impl PackageCompression {
  const fn wire_tag(self) -> u8 {
    match self {
      Self::Lz4 => 1,
      Self::Zstd => 2,
    }
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PackageDigestPolicy {
  Verify,
  Trust,
}

impl<'a> PreparedSearchPackageParts<'a> {
  const fn digest(&self) -> [u8; 32] {
    match self {
      Self::Raw { digest, .. } | Self::Compressed { digest, .. } => *digest,
    }
  }

  const fn is_core(&self) -> bool {
    match self {
      Self::Raw { core, .. } | Self::Compressed { core, .. } => *core,
    }
  }

  fn into_verified_payload(
    self,
    timings: &mut PreparedSearchPackageDecodeTimings,
  ) -> Result<Cow<'a, [u8]>> {
    self.into_payload(timings, PackageDigestPolicy::Verify)
  }

  fn into_payload(
    self,
    timings: &mut PreparedSearchPackageDecodeTimings,
    digest_policy: PackageDigestPolicy,
  ) -> Result<Cow<'a, [u8]>> {
    match self {
      Self::Raw {
        digest, payload, ..
      } => {
        if payload.len() > MAX_PREPARED_SEARCH_PACKAGE_PAYLOAD_BYTES {
          return Err(invalid_prepared_search_package(
            "raw payload length exceeds limit",
          ));
        }
        if digest_policy == PackageDigestPolicy::Verify {
          let verify_start = web_time::Instant::now();
          verify_prepared_search_package_digest(digest, payload)?;
          timings.verify = Some(elapsed_us(verify_start));
        }
        Ok(Cow::Borrowed(payload))
      }
      Self::Compressed {
        compression,
        digest,
        uncompressed_len,
        payload,
        ..
      } => {
        if uncompressed_len > MAX_PREPARED_SEARCH_PACKAGE_PAYLOAD_BYTES {
          return Err(invalid_prepared_search_package(
            "uncompressed payload length exceeds limit",
          ));
        }
        compressed_digest_payload(
          compression,
          digest,
          uncompressed_len,
          payload,
          timings,
          digest_policy,
        )
      }
    }
  }

  fn verify_digest(
    self,
    timings: &mut PreparedSearchPackageDecodeTimings,
  ) -> Result<()> {
    match self {
      Self::Raw {
        digest, payload, ..
      } => {
        if payload.len() > MAX_PREPARED_SEARCH_PACKAGE_PAYLOAD_BYTES {
          return Err(invalid_prepared_search_package(
            "raw payload length exceeds limit",
          ));
        }
        let verify_start = web_time::Instant::now();
        verify_prepared_search_package_digest(digest, payload)?;
        timings.verify = Some(elapsed_us(verify_start));
        Ok(())
      }
      Self::Compressed {
        compression,
        digest,
        payload,
        ..
      } => {
        let verify_start = web_time::Instant::now();
        verify_prepared_search_compressed_package_digest(
          digest,
          compression,
          payload,
        )?;
        timings.verify = Some(elapsed_us(verify_start));
        Ok(())
      }
    }
  }
}

fn compressed_digest_payload<'a>(
  compression: PackageCompression,
  digest: [u8; PREPARED_SEARCH_PACKAGE_DIGEST_BYTES],
  uncompressed_len: usize,
  payload: &'a [u8],
  timings: &mut PreparedSearchPackageDecodeTimings,
  digest_policy: PackageDigestPolicy,
) -> Result<Cow<'a, [u8]>> {
  if digest_policy == PackageDigestPolicy::Trust {
    let decompress_start = web_time::Instant::now();
    let decompressed =
      decompress_package_payload(compression, payload, uncompressed_len)?;
    timings.decompress = Some(elapsed_us(decompress_start));
    return Ok(Cow::Owned(decompressed));
  }

  let (verify_result, verify_elapsed, decompressed, decompress_elapsed) =
    stella_anonymize_core::exec::scope(|scope| {
      let verify_handle = scope.spawn(|| {
        let verify_start = web_time::Instant::now();
        let result = verify_prepared_search_compressed_package_digest(
          digest,
          compression,
          payload,
        );
        (result, elapsed_us(verify_start))
      });
      let decompress_handle = scope.spawn(|| {
        let decompress_start = web_time::Instant::now();
        let result =
          decompress_package_payload(compression, payload, uncompressed_len);
        (result, elapsed_us(decompress_start))
      });
      let (verify_result, verify_elapsed) =
        join_package_decode_thread(verify_handle)?;
      let (decompressed, decompress_elapsed) =
        join_package_decode_thread(decompress_handle)?;
      Ok((
        verify_result,
        verify_elapsed,
        decompressed,
        decompress_elapsed,
      ))
    })?;
  verify_result?;
  timings.verify = Some(verify_elapsed);
  let decompressed = decompressed.map(Cow::Owned)?;
  timings.decompress = Some(decompress_elapsed);
  Ok(decompressed)
}

fn decompress_package_payload(
  compression: PackageCompression,
  payload: &[u8],
  uncompressed_len: usize,
) -> Result<Vec<u8>> {
  match compression {
    PackageCompression::Lz4 => {
      lz4_flex::block::decompress(payload, uncompressed_len)
        .map_err(|error| invalid_prepared_search_package(error.to_string()))
    }
    PackageCompression::Zstd => {
      decompress_zstd_payload(payload, uncompressed_len)
    }
  }
}

/// zstd decode path. The write path currently emits lz4; the explicit codec tag
/// keeps zstd available to native producers without coupling it to schema
/// versioning. It is gated behind the default `zstd` feature so wasm targets
/// can load lz4 packages without cross-compiling the zstd C library.
#[cfg(feature = "zstd")]
fn decompress_zstd_payload(
  payload: &[u8],
  uncompressed_len: usize,
) -> Result<Vec<u8>> {
  zstd::bulk::decompress(payload, uncompressed_len)
    .map_err(|error| invalid_prepared_search_package(error.to_string()))
}

#[cfg(not(feature = "zstd"))]
fn decompress_zstd_payload(
  _payload: &[u8],
  _uncompressed_len: usize,
) -> Result<Vec<u8>> {
  Err(invalid_prepared_search_package(
    "zstd-compressed prepared packages are not supported in this build",
  ))
}

fn join_package_decode_thread<T>(
  handle: stella_anonymize_core::exec::JoinHandle<'_, T>,
) -> Result<T> {
  handle.join().map_err(|_| {
    invalid_prepared_search_package("package decode thread panicked")
  })
}
fn prepared_search_package_parts(
  bytes: &[u8],
) -> Result<PreparedSearchPackageParts<'_>> {
  let header = bytes
    .get(..PREPARED_SEARCH_PACKAGE_HEADER.len())
    .ok_or_else(|| invalid_prepared_search_package("truncated header"))?;
  if header == PREPARED_SEARCH_PACKAGE_HEADER {
    let raw = raw_package_header(
      bytes,
      BINDING_PACKAGE_SCHEMA_VERSION,
      PREPARED_SEARCH_PACKAGE_HEADER.len(),
    )?;
    return Ok(PreparedSearchPackageParts::Raw {
      core: false,
      digest: raw.digest,
      payload: raw.payload,
    });
  }
  if header == PREPARED_SEARCH_CORE_PACKAGE_HEADER {
    let raw = raw_package_header(
      bytes,
      CORE_PACKAGE_SCHEMA_VERSION,
      PREPARED_SEARCH_CORE_PACKAGE_HEADER.len(),
    )?;
    return Ok(PreparedSearchPackageParts::Raw {
      core: true,
      digest: raw.digest,
      payload: raw.payload,
    });
  }
  if header == PREPARED_SEARCH_COMPRESSED_PACKAGE_HEADER {
    let compressed = compressed_package_header(
      bytes,
      BINDING_PACKAGE_SCHEMA_VERSION,
      PREPARED_SEARCH_COMPRESSED_PACKAGE_HEADER.len(),
    )?;
    return compressed_package_parts(false, compressed);
  }
  if header == PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_HEADER {
    let compressed = compressed_package_header(
      bytes,
      CORE_PACKAGE_SCHEMA_VERSION,
      PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_HEADER.len(),
    )?;
    return compressed_package_parts(true, compressed);
  }
  Err(invalid_prepared_search_package("unexpected header"))
}

fn compressed_package_parts(
  core: bool,
  compressed: CompressedPackageHeader<'_>,
) -> Result<PreparedSearchPackageParts<'_>> {
  let len_end = std::mem::size_of::<u64>();
  let len_bytes = compressed
    .payload
    .get(..len_end)
    .ok_or_else(|| invalid_prepared_search_package("truncated length"))?;
  let len_array = <[u8; 8]>::try_from(len_bytes)
    .map_err(|_| invalid_prepared_search_package("malformed length"))?;
  let uncompressed_len = usize::try_from(u64::from_le_bytes(len_array))
    .map_err(|_| invalid_prepared_search_package("length overflow"))?;
  let payload = compressed
    .payload
    .get(len_end..)
    .ok_or_else(|| invalid_prepared_search_package("missing payload"))?;
  Ok(PreparedSearchPackageParts::Compressed {
    core,
    compression: compressed.compression,
    digest: compressed.digest,
    uncompressed_len,
    payload,
  })
}

#[cfg(test)]
mod tests {
  #![allow(clippy::unwrap_used)]

  use stella_anonymize_core::{
    DiagnosticStage, PatternSlice, PreparedEngineArtifacts, SearchMatch,
    process_deny_list_matches,
  };

  #[cfg(feature = "zstd")]
  use super::format::PREPARED_SEARCH_PACKAGE_ZSTD_LEVEL;
  use super::format::{
    BINDING_PACKAGE_SCHEMA_VERSION, CORE_PACKAGE_SCHEMA_VERSION,
    MAX_PREPARED_SEARCH_PACKAGE_PAYLOAD_BYTES,
    PREPARED_SEARCH_COMPRESSED_PACKAGE_HEADER,
    PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_HEADER,
    PREPARED_SEARCH_CORE_PACKAGE_HEADER, PREPARED_SEARCH_PACKAGE_DIGEST_BYTES,
    PREPARED_SEARCH_PACKAGE_HEADER, write_compressed_package_header,
  };
  use super::wire::{
    prepared_search_core_package_payload_to_bytes,
    prepared_search_package_payload_to_bytes,
  };
  use super::{
    CorePreparedSearchPackageArtifactsInner, PackageCompression,
    PreparedSearchPackageDecodeTimings, diagnostic_stage_event,
    prepared_search_compressed_package_digest,
    prepared_search_core_package_decode_from_bytes_with_timings,
    prepared_search_core_package_decode_trusted_from_bytes_with_timings,
    prepared_search_core_package_from_bytes,
    prepared_search_core_package_to_bytes,
    prepared_search_core_package_to_compressed_bytes,
    prepared_search_core_package_view_from_bytes_with_timings,
    prepared_search_core_package_view_trusted_from_bytes_with_timings,
    prepared_search_package_compress_payload,
    prepared_search_package_decode_events,
    prepared_search_package_decode_timing_events,
    prepared_search_package_digest, prepared_search_package_from_bytes,
    prepared_search_package_has_core_payload,
    prepared_search_package_raw_payload_to_bytes,
    prepared_search_package_to_bytes,
    prepared_search_package_to_compressed_bytes,
    prepared_search_package_verify_digest_with_timings,
  };
  use crate::config::prepared_search_config_from_binding;
  use crate::error::ContractError;
  use crate::types::{
    BindingCountryMatchData, BindingCountryVariant, BindingDenyListFilterData,
    BindingDenyListMatchData, BindingLegalFormData,
    BindingPreparedSearchConfig, BindingSearchPattern,
  };

  #[test]
  fn prepared_package_schema_versions_track_the_current_payload_shape() {
    assert_eq!(BINDING_PACKAGE_SCHEMA_VERSION, 14);
    assert_eq!(CORE_PACKAGE_SCHEMA_VERSION, 14);
  }

  #[test]
  fn prepared_package_readers_reject_previous_schema_payloads() {
    const PREVIOUS_SCHEMA_VERSION: u32 = 11;
    let binding_payload = prepared_search_package_payload_to_bytes(
      &package_test_config(),
      b"artifacts",
    )
    .unwrap();
    let binding = prepared_search_package_raw_payload_to_bytes(
      PREPARED_SEARCH_PACKAGE_HEADER,
      PREVIOUS_SCHEMA_VERSION,
      &binding_payload,
    );
    assert_invalid_package_reason(
      prepared_search_package_from_bytes(&binding).unwrap_err(),
      "unsupported schema version",
    );

    let core_config =
      prepared_search_config_from_binding(package_test_config()).unwrap();
    let core_payload =
      prepared_search_core_package_payload_to_bytes(&core_config, b"artifacts")
        .unwrap();
    let core_package = prepared_search_package_raw_payload_to_bytes(
      PREPARED_SEARCH_CORE_PACKAGE_HEADER,
      PREVIOUS_SCHEMA_VERSION,
      &core_payload,
    );
    assert_invalid_package_reason(
      prepared_search_core_package_from_bytes(&core_package).unwrap_err(),
      "unsupported schema version",
    );
  }

  #[test]
  fn prepared_search_package_roundtrips_config_and_artifacts() {
    let config = BindingPreparedSearchConfig {
      false_positive_filters: Some(BindingDenyListFilterData::default()),
      ..package_test_config()
    };
    let artifacts = b"prepared-artifacts";

    let bytes = prepared_search_package_to_bytes(&config, artifacts).unwrap();
    let package = prepared_search_package_from_bytes(&bytes).unwrap();

    assert_eq!(package.config, config);
    assert_eq!(package.artifacts, artifacts);
  }

  #[test]
  fn binding_packages_preserve_full_institutional_heads() {
    let config = BindingPreparedSearchConfig {
      legal_form_data: Some(BindingLegalFormData {
        suffixes: vec![String::from("Society")],
        detection_only_suffixes: vec![String::from("Court")],
        institutional_heads: vec![
          String::from("Court"),
          String::from("Society"),
        ],
        ..BindingLegalFormData::default()
      }),
      ..BindingPreparedSearchConfig::default()
    };
    let packages = [
      prepared_search_package_to_bytes(&config, b"artifacts").unwrap(),
      prepared_search_package_to_compressed_bytes(&config, b"artifacts")
        .unwrap(),
    ];

    for bytes in packages {
      let package = prepared_search_package_from_bytes(&bytes).unwrap();
      assert_eq!(package.config, config);
    }
  }

  #[test]
  fn prepared_search_package_rejects_invalid_bytes() {
    let error = prepared_search_package_from_bytes(b"not-valid").unwrap_err();

    assert!(
      matches!(error, ContractError::InvalidPreparedSearchPackage { .. }),
      "invalid package bytes should fail before config construction"
    );
  }

  #[test]
  fn prepared_search_package_rejects_digest_mismatch() {
    let config = BindingPreparedSearchConfig::default();
    let mut bytes =
      prepared_search_package_to_bytes(&config, b"artifact").unwrap();
    let last = bytes.last_mut().unwrap();
    *last ^= 0x01;

    let error = prepared_search_package_from_bytes(&bytes).unwrap_err();

    assert!(
      matches!(error, ContractError::InvalidPreparedSearchPackage { .. }),
      "corrupted package payload should fail digest verification"
    );
  }

  #[test]
  fn prepared_search_package_digest_reads_header_without_verifying_payload() {
    let config = BindingPreparedSearchConfig::default();
    let mut bytes =
      prepared_search_package_to_bytes(&config, b"artifact").unwrap();
    let digest = prepared_search_package_digest(&bytes).unwrap();

    let last = bytes.last_mut().unwrap();
    *last ^= 0x01;

    assert_eq!(prepared_search_package_digest(&bytes).unwrap(), digest);
    assert!(
      prepared_search_package_verify_digest_with_timings(&bytes).is_err(),
      "header digest identity must not replace payload verification"
    );
  }

  #[test]
  fn prepared_search_package_verify_digest_reports_timing() {
    let config = BindingPreparedSearchConfig::default();
    let bytes =
      prepared_search_package_to_compressed_bytes(&config, b"artifact")
        .unwrap();

    let timings =
      prepared_search_package_verify_digest_with_timings(&bytes).unwrap();

    assert!(
      timings.verify.is_some(),
      "digest verification timing should be reported"
    );
  }

  #[test]
  fn prepared_search_package_decode_events_report_ordered_stages() {
    let events = prepared_search_package_decode_events(
      10,
      PreparedSearchPackageDecodeTimings {
        verify: Some(2),
        decompress: None,
        config_decode: Some(3),
        config_bytes: Some(64),
      },
      128,
    );

    let stages = events.iter().map(|event| event.stage).collect::<Vec<_>>();

    assert_eq!(
      stages,
      vec![
        DiagnosticStage::PreparePackageDecode,
        DiagnosticStage::PreparePackageVerify,
        DiagnosticStage::PreparePackageConfigDecode,
      ]
    );
    assert_eq!(
      events.first().unwrap(),
      &diagnostic_stage_event(
        DiagnosticStage::PreparePackageDecode,
        None,
        Some(10),
        Some(128),
      )
    );
    assert_eq!(
      events.last().unwrap().input_bytes,
      Some(64),
      "config decode should report encoded config bytes"
    );
  }

  #[test]
  fn prepared_search_package_decode_timing_events_skip_missing_timings() {
    let events = prepared_search_package_decode_timing_events(
      PreparedSearchPackageDecodeTimings::default(),
      128,
    );

    assert!(events.is_empty());
  }
  #[test]
  fn prepared_search_compressed_package_roundtrips_config_and_artifacts() {
    let config = package_test_config();
    let artifacts = b"prepared-artifacts";

    let bytes =
      prepared_search_package_to_compressed_bytes(&config, artifacts).unwrap();
    let package = prepared_search_package_from_bytes(&bytes).unwrap();

    assert_eq!(
      package_version(&bytes, PREPARED_SEARCH_COMPRESSED_PACKAGE_HEADER),
      BINDING_PACKAGE_SCHEMA_VERSION
    );
    assert_eq!(package.config, config);
    assert_eq!(package.artifacts, artifacts);
  }

  #[test]
  #[cfg(feature = "zstd")]
  fn prepared_search_compressed_package_reads_explicit_zstd_codec() {
    let config = package_test_config();
    let artifacts = b"prepared-artifacts";
    let payload =
      prepared_search_package_payload_to_bytes(&config, artifacts).unwrap();
    let bytes = zstd_compressed_package(
      PREPARED_SEARCH_COMPRESSED_PACKAGE_HEADER,
      BINDING_PACKAGE_SCHEMA_VERSION,
      &payload,
    );

    let package = prepared_search_package_from_bytes(&bytes).unwrap();

    assert_eq!(package.config, config);
    assert_eq!(package.artifacts, artifacts);
  }

  #[test]
  fn prepared_search_compressed_package_rejects_wrong_schema_version() {
    let payload = prepared_search_package_payload_to_bytes(
      &package_test_config(),
      b"prepared-artifacts",
    )
    .unwrap();
    let bytes = prepared_search_package_compress_payload(
      PREPARED_SEARCH_COMPRESSED_PACKAGE_HEADER,
      BINDING_PACKAGE_SCHEMA_VERSION.saturating_add(1),
      &payload,
    )
    .unwrap();
    let error = prepared_search_package_from_bytes(&bytes).unwrap_err();
    assert!(error.to_string().contains("unsupported schema version"));
  }

  #[test]
  fn prepared_search_raw_package_rejects_wrong_schema_version() {
    let payload = prepared_search_package_payload_to_bytes(
      &package_test_config(),
      b"prepared-artifacts",
    )
    .unwrap();
    let bytes = prepared_search_package_raw_payload_to_bytes(
      PREPARED_SEARCH_PACKAGE_HEADER,
      BINDING_PACKAGE_SCHEMA_VERSION.saturating_add(1),
      &payload,
    );
    let error = prepared_search_package_from_bytes(&bytes).unwrap_err();
    assert!(error.to_string().contains("unsupported schema version"));
  }

  #[test]
  fn prepared_search_compressed_package_rejects_digest_mismatch() {
    let config = BindingPreparedSearchConfig::default();
    let mut bytes =
      prepared_search_package_to_compressed_bytes(&config, b"artifact")
        .unwrap();
    let last = bytes.last_mut().unwrap();
    *last ^= 0x01;

    let error = prepared_search_package_from_bytes(&bytes).unwrap_err();

    assert!(
      matches!(error, ContractError::InvalidPreparedSearchPackage { .. }),
      "corrupted compressed package should fail digest verification"
    );
  }

  #[test]
  fn prepared_search_compressed_package_digest_authenticates_codec() {
    let payload = b"same-compressed-payload";
    assert_ne!(
      prepared_search_compressed_package_digest(
        PackageCompression::Lz4,
        payload,
      ),
      prepared_search_compressed_package_digest(
        PackageCompression::Zstd,
        payload,
      ),
      "compression codecs must have distinct cache identities",
    );

    let mut bytes = prepared_search_package_to_compressed_bytes(
      &package_test_config(),
      b"artifacts",
    )
    .unwrap();
    let codec_offset = PREPARED_SEARCH_COMPRESSED_PACKAGE_HEADER
      .len()
      .saturating_add(std::mem::size_of::<u32>());
    *bytes.get_mut(codec_offset).unwrap() = PackageCompression::Zstd.wire_tag();

    let error =
      prepared_search_package_verify_digest_with_timings(&bytes).unwrap_err();

    assert_invalid_package_reason(error, "digest mismatch");
  }

  #[test]
  fn prepared_search_compressed_package_rejects_oversized_payload_len() {
    let bytes = compressed_package_with_len(
      PREPARED_SEARCH_COMPRESSED_PACKAGE_HEADER,
      BINDING_PACKAGE_SCHEMA_VERSION,
      oversized_payload_len(),
    );
    let error = prepared_search_package_from_bytes(&bytes).unwrap_err();

    assert_invalid_package_reason(
      error,
      "uncompressed payload length exceeds limit",
    );
  }

  #[test]
  fn prepared_search_core_compressed_package_rejects_oversized_payload_len() {
    let bytes = compressed_package_with_len(
      PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_HEADER,
      CORE_PACKAGE_SCHEMA_VERSION,
      oversized_payload_len(),
    );
    let error = prepared_search_core_package_from_bytes(&bytes).unwrap_err();

    assert_invalid_package_reason(
      error,
      "uncompressed payload length exceeds limit",
    );
  }

  #[test]
  fn prepared_search_package_rejects_oversized_raw_payload() {
    // Unlike the compressed formats, a raw package has no separate declared
    // length field to reject on cheaply: the whole trailing byte slice is
    // the payload, so the cap must be checked against its actual length
    // before it is hashed and postcard-decoded.
    let payload_len = usize::try_from(oversized_payload_len()).unwrap();
    let bytes = prepared_search_package_raw_payload_to_bytes(
      PREPARED_SEARCH_PACKAGE_HEADER,
      BINDING_PACKAGE_SCHEMA_VERSION,
      &vec![0u8; payload_len],
    );

    let error = prepared_search_package_from_bytes(&bytes).unwrap_err();

    assert_invalid_package_reason(error, "raw payload length exceeds limit");
  }

  #[test]
  fn prepared_search_core_package_rejects_oversized_raw_payload() {
    let payload_len = usize::try_from(oversized_payload_len()).unwrap();
    let bytes = prepared_search_package_raw_payload_to_bytes(
      PREPARED_SEARCH_CORE_PACKAGE_HEADER,
      CORE_PACKAGE_SCHEMA_VERSION,
      &vec![0u8; payload_len],
    );

    let error = prepared_search_core_package_from_bytes(&bytes).unwrap_err();

    assert_invalid_package_reason(error, "raw payload length exceeds limit");
  }

  #[test]
  fn prepared_search_package_verify_digest_rejects_oversized_raw_payload() {
    // `verify_digest` is the shared path used by
    // `prepared_search_package_verify_digest_with_timings`; it must apply
    // the same cap independently of `into_payload`, since `Raw` used to
    // share a match arm with compressed packages.
    let payload_len = usize::try_from(oversized_payload_len()).unwrap();
    let bytes = prepared_search_package_raw_payload_to_bytes(
      PREPARED_SEARCH_PACKAGE_HEADER,
      BINDING_PACKAGE_SCHEMA_VERSION,
      &vec![0u8; payload_len],
    );

    let error =
      prepared_search_package_verify_digest_with_timings(&bytes).unwrap_err();

    assert_invalid_package_reason(error, "raw payload length exceeds limit");
  }

  #[test]
  fn prepared_search_core_package_roundtrips_config_and_artifacts() {
    let config =
      prepared_search_config_from_binding(package_test_config()).unwrap();
    let mut compact_config = config.clone();
    compact_config.search.literal_patterns.clear();
    let artifacts = b"prepared-artifacts";

    let bytes =
      prepared_search_core_package_to_bytes(&config, artifacts).unwrap();
    let package = prepared_search_core_package_from_bytes(&bytes).unwrap();
    let binding_error = prepared_search_package_from_bytes(&bytes).unwrap_err();

    assert!(prepared_search_package_has_core_payload(&bytes));
    assert_eq!(package.config, compact_config);
    assert_eq!(package.artifacts, artifacts);
    assert!(
      matches!(
        binding_error,
        ContractError::InvalidPreparedSearchPackage { .. }
      ),
      "binding package loader should reject core payloads"
    );
  }

  #[test]
  fn prepared_search_core_compressed_package_roundtrips_config_and_artifacts() {
    let config =
      prepared_search_config_from_binding(package_test_config()).unwrap();
    let mut compact_config = config.clone();
    compact_config.search.literal_patterns.clear();
    let artifacts = b"prepared-artifacts";

    let bytes =
      prepared_search_core_package_to_compressed_bytes(&config, artifacts)
        .unwrap();
    let package = prepared_search_core_package_from_bytes(&bytes).unwrap();

    assert!(prepared_search_package_has_core_payload(&bytes));
    assert_eq!(
      package_version(&bytes, PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_HEADER),
      CORE_PACKAGE_SCHEMA_VERSION
    );
    assert_eq!(package.config, compact_config);
    assert_eq!(package.artifacts, artifacts);
  }

  #[test]
  #[cfg(feature = "zstd")]
  fn prepared_search_core_compressed_package_reads_explicit_zstd_codec() {
    let config =
      prepared_search_config_from_binding(package_test_config()).unwrap();
    let mut compact_config = config.clone();
    compact_config.search.literal_patterns.clear();
    let artifacts = b"prepared-artifacts";
    let payload =
      prepared_search_core_package_payload_to_bytes(&config, artifacts)
        .unwrap();
    let bytes = zstd_compressed_package(
      PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_HEADER,
      CORE_PACKAGE_SCHEMA_VERSION,
      &payload,
    );

    let package = prepared_search_core_package_from_bytes(&bytes).unwrap();

    assert!(prepared_search_package_has_core_payload(&bytes));
    assert_eq!(package.config, compact_config);
    assert_eq!(package.artifacts, artifacts);
  }

  #[test]
  fn prepared_search_core_compressed_package_reports_decode_timings() {
    let config =
      prepared_search_config_from_binding(package_test_config()).unwrap();
    let artifacts = b"prepared-artifacts";

    let bytes =
      prepared_search_core_package_to_compressed_bytes(&config, artifacts)
        .unwrap();
    let (package, timings) =
      prepared_search_core_package_view_from_bytes_with_timings(&bytes)
        .unwrap();

    assert!(matches!(
      &package.artifacts.inner,
      CorePreparedSearchPackageArtifactsInner::OwnedPayload { .. }
    ));
    assert!(
      timings.verify.is_some(),
      "compressed package digest timing should be reported"
    );
    assert!(
      timings.decompress.is_some(),
      "compressed package decompression timing should be reported"
    );
    assert!(
      timings.config_decode.is_some(),
      "core config decode timing should be reported"
    );
  }

  #[test]
  fn prepared_search_core_compressed_package_decodes_config_and_artifacts() {
    let config =
      prepared_search_config_from_binding(package_test_config()).unwrap();
    let artifact_set = PreparedEngineArtifacts::default();
    let artifact_bytes = artifact_set.to_bytes().unwrap();

    let bytes = prepared_search_core_package_to_compressed_bytes(
      &config,
      &artifact_bytes,
    )
    .unwrap();
    let decoded =
      prepared_search_core_package_decode_from_bytes_with_timings(&bytes)
        .unwrap();

    assert_eq!(decoded.config.search.literal_patterns, Vec::new());
    assert_eq!(decoded.artifacts, artifact_set);
    assert_eq!(decoded.artifacts_bytes, artifact_bytes.len());
    assert!(
      decoded.package_decode_timings.verify.is_some(),
      "compressed package digest timing should be reported"
    );
    assert!(
      decoded.package_decode_timings.decompress.is_some(),
      "compressed package decompression timing should be reported"
    );
    assert!(
      decoded.package_decode_timings.config_decode.is_some(),
      "core config decode timing should be reported"
    );
  }

  #[test]
  fn prepared_search_core_trusted_decode_skips_package_digest() {
    let config =
      prepared_search_config_from_binding(package_test_config()).unwrap();
    let artifact_set = PreparedEngineArtifacts::default();
    let artifact_bytes = artifact_set.to_bytes().unwrap();

    let mut bytes = prepared_search_core_package_to_compressed_bytes(
      &config,
      &artifact_bytes,
    )
    .unwrap();
    let digest_start = PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_HEADER
      .len()
      .saturating_add(std::mem::size_of::<u32>())
      .saturating_add(std::mem::size_of::<u8>());
    let digest_byte = bytes.get_mut(digest_start).unwrap();
    *digest_byte ^= 0xff;

    let verified =
      prepared_search_core_package_decode_from_bytes_with_timings(&bytes);
    assert!(
      verified.is_err(),
      "verified decode must reject a package digest mismatch"
    );

    let trusted =
      prepared_search_core_package_decode_trusted_from_bytes_with_timings(
        &bytes,
      )
      .unwrap();
    assert_eq!(trusted.config.search.literal_patterns, Vec::new());
    assert_eq!(trusted.artifacts, artifact_set);
    assert_eq!(trusted.artifacts_bytes, artifact_bytes.len());
    assert!(
      trusted.package_decode_timings.verify.is_none(),
      "trusted decode should not spend time verifying the package digest"
    );
    assert!(
      trusted.package_decode_timings.decompress.is_some(),
      "trusted decode still has to decompress compressed packages"
    );

    let (trusted_view, trusted_view_timings) =
      prepared_search_core_package_view_trusted_from_bytes_with_timings(&bytes)
        .unwrap();
    assert_eq!(trusted_view.config.search.literal_patterns, Vec::new());
    assert_eq!(trusted_view.artifacts.as_bytes(), artifact_bytes.as_slice());
    assert!(
      trusted_view_timings.verify.is_none(),
      "trusted view decode should not spend time verifying the package digest"
    );
    assert!(
      trusted_view_timings.decompress.is_some(),
      "trusted view decode still has to decompress compressed packages"
    );
  }

  #[test]
  fn prepared_search_core_package_compacts_deny_list_originals() {
    let binding_config = BindingPreparedSearchConfig {
      deny_list_data: Some(BindingDenyListMatchData {
        labels: vec![
          vec![String::from("person")],
          vec![String::from("matter")],
        ],
        custom_labels: vec![Vec::new(), vec![String::from("matter")]],
        originals: vec![String::from("VAT"), String::from("Secret Code")],
        sources: vec![
          vec![String::from("deny-list")],
          vec![String::from("custom-deny-list")],
        ],
        filters: None,
        ..BindingDenyListMatchData::default()
      }),
      ..BindingPreparedSearchConfig::default()
    };
    let config = prepared_search_config_from_binding(binding_config).unwrap();

    let bytes =
      prepared_search_core_package_to_compressed_bytes(&config, b"artifact")
        .unwrap();
    let package = prepared_search_core_package_from_bytes(&bytes).unwrap();
    let data = package.config.detectors.deny_list_data.unwrap();

    assert!(data.originals.is_empty());
    assert_eq!(data.pattern_meta.len(), 2);
    let first = data.pattern_meta.first().unwrap();
    let second = data.pattern_meta.get(1).unwrap();
    assert!(first.has_alphanumeric);
    assert!(first.short_upper_acronym);
    assert!(second.has_alphanumeric);
    assert!(!second.short_upper_acronym);
  }

  #[test]
  fn prepared_search_core_package_preserves_compact_surname_evidence() {
    let binding_config = BindingPreparedSearchConfig {
      deny_list_data: Some(BindingDenyListMatchData {
        labels: vec![
          vec![String::from("person")],
          vec![String::from("person")],
        ],
        custom_labels: vec![Vec::new(), Vec::new()],
        originals: vec![String::from("Ctibor"), String::from("Příkladný")],
        sources: vec![
          vec![String::from("first-name")],
          vec![String::from("surname")],
        ],
        filters: Some(BindingDenyListFilterData::default()),
        ..BindingDenyListMatchData::default()
      }),
      ..BindingPreparedSearchConfig::default()
    };
    let config = prepared_search_config_from_binding(binding_config).unwrap();

    let bytes =
      prepared_search_core_package_to_compressed_bytes(&config, b"artifact")
        .unwrap();
    let package = prepared_search_core_package_from_bytes(&bytes).unwrap();
    let data = package.config.detectors.deny_list_data.unwrap();

    assert!(data.originals.is_empty());
    assert_eq!(data.pattern_meta.len(), 2);

    let entities = process_deny_list_matches(
      &[
        SearchMatch::Literal {
          pattern: 0,
          start: 0,
          end: 6,
        },
        SearchMatch::Literal {
          pattern: 1,
          start: 7,
          end: 19,
        },
      ],
      PatternSlice { start: 0, end: 2 },
      "Ctibor PŘÍKLADNÝ podepsal smlouvu.",
      &data,
    )
    .unwrap();

    assert_eq!(entities.len(), 1);
    assert_eq!(
      entities.first().map(|entity| entity.text.as_str()),
      Some("Ctibor PŘÍKLADNÝ")
    );
  }

  #[test]
  fn prepared_search_core_compressed_package_rejects_wrong_schema_version() {
    let config =
      prepared_search_config_from_binding(package_test_config()).unwrap();
    let payload =
      prepared_search_core_package_payload_to_bytes(&config, b"artifacts")
        .unwrap();
    let bytes = prepared_search_package_compress_payload(
      PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_HEADER,
      CORE_PACKAGE_SCHEMA_VERSION.saturating_add(1),
      &payload,
    )
    .unwrap();
    let error = prepared_search_core_package_from_bytes(&bytes).unwrap_err();
    assert!(error.to_string().contains("unsupported schema version"));
  }

  #[test]
  fn prepared_search_core_raw_package_rejects_wrong_schema_version() {
    let config =
      prepared_search_config_from_binding(package_test_config()).unwrap();
    let payload =
      prepared_search_core_package_payload_to_bytes(&config, b"artifacts")
        .unwrap();
    let bytes = prepared_search_package_raw_payload_to_bytes(
      PREPARED_SEARCH_CORE_PACKAGE_HEADER,
      CORE_PACKAGE_SCHEMA_VERSION.saturating_add(1),
      &payload,
    );
    let error = prepared_search_core_package_from_bytes(&bytes).unwrap_err();
    assert!(error.to_string().contains("unsupported schema version"));
  }

  #[test]
  fn prepared_search_package_rejects_unknown_compression_codec() {
    let mut bytes = prepared_search_package_to_compressed_bytes(
      &package_test_config(),
      b"artifacts",
    )
    .unwrap();
    let codec_offset = PREPARED_SEARCH_COMPRESSED_PACKAGE_HEADER
      .len()
      .saturating_add(std::mem::size_of::<u32>());
    *bytes.get_mut(codec_offset).unwrap() = u8::MAX;

    let error = prepared_search_package_from_bytes(&bytes).unwrap_err();
    assert!(error.to_string().contains("unsupported compression codec"));
  }

  #[test]
  #[cfg(not(feature = "zstd"))]
  fn prepared_search_package_rejects_zstd_when_feature_is_disabled() {
    let payload = [1_u8];
    let digest = prepared_search_compressed_package_digest(
      PackageCompression::Zstd,
      &payload,
    );
    let mut bytes = Vec::new();
    write_compressed_package_header(
      &mut bytes,
      PREPARED_SEARCH_COMPRESSED_PACKAGE_HEADER,
      BINDING_PACKAGE_SCHEMA_VERSION,
      PackageCompression::Zstd,
      digest.as_bytes(),
    );
    bytes.extend_from_slice(&0_u64.to_le_bytes());
    bytes.extend_from_slice(&payload);

    let error = prepared_search_package_from_bytes(&bytes).unwrap_err();
    assert!(
      error
        .to_string()
        .contains("zstd-compressed prepared packages are not supported")
    );
  }

  #[test]
  fn prepared_search_package_rejects_legacy_magic() {
    let mut bytes =
      prepared_search_package_to_bytes(&package_test_config(), b"artifacts")
        .unwrap();
    bytes.get_mut(..8).unwrap().copy_from_slice(b"ANONPKG1");

    let error = prepared_search_package_from_bytes(&bytes).unwrap_err();
    assert!(error.to_string().contains("unexpected header"));
  }

  fn package_test_config() -> BindingPreparedSearchConfig {
    BindingPreparedSearchConfig {
      literal_patterns: vec![BindingSearchPattern {
        kind: String::from("literal"),
        pattern: String::from("Acme"),
        distance: None,
        case_insensitive: None,
        whole_words: None,
        lazy: None,
        prefilter_any: None,
        prefilter_case_insensitive: None,
        prefilter_regex: None,
        prefilter_window_bytes: None,
        prepared_artifact_policy: None,
      }],
      country_data: Some(BindingCountryMatchData {
        labels: vec![String::from("country"), String::from("country")],
        iso_codes: vec![String::from("CH"), String::from("US")],
        variants: vec![
          BindingCountryVariant::Name,
          BindingCountryVariant::Alias,
        ],
      }),
      ..BindingPreparedSearchConfig::default()
    }
  }

  #[cfg(feature = "zstd")]
  fn zstd_compressed_package(
    header: [u8; 8],
    version: u32,
    payload: &[u8],
  ) -> Vec<u8> {
    let compressed =
      zstd::bulk::compress(payload, PREPARED_SEARCH_PACKAGE_ZSTD_LEVEL)
        .unwrap();
    let digest = prepared_search_compressed_package_digest(
      PackageCompression::Zstd,
      &compressed,
    );
    let mut bytes = Vec::new();
    write_compressed_package_header(
      &mut bytes,
      header,
      version,
      PackageCompression::Zstd,
      digest.as_bytes(),
    );
    let payload_len = u64::try_from(payload.len()).unwrap();
    bytes.extend_from_slice(&payload_len.to_le_bytes());
    bytes.extend_from_slice(&compressed);
    bytes
  }

  fn package_version(bytes: &[u8], header: [u8; 8]) -> u32 {
    let version_start = header.len();
    let version_end = version_start.saturating_add(std::mem::size_of::<u32>());
    let version_bytes = bytes.get(version_start..version_end).unwrap();
    u32::from_le_bytes(<[u8; 4]>::try_from(version_bytes).unwrap())
  }

  fn compressed_package_with_len(
    header: [u8; 8],
    version: u32,
    uncompressed_len: u64,
  ) -> Vec<u8> {
    let digest = [0; PREPARED_SEARCH_PACKAGE_DIGEST_BYTES];
    let mut bytes = Vec::new();
    write_compressed_package_header(
      &mut bytes,
      header,
      version,
      PackageCompression::Lz4,
      &digest,
    );
    bytes.extend_from_slice(&uncompressed_len.to_le_bytes());
    bytes
  }

  fn oversized_payload_len() -> u64 {
    u64::try_from(MAX_PREPARED_SEARCH_PACKAGE_PAYLOAD_BYTES)
      .unwrap()
      .checked_add(1)
      .unwrap()
  }

  fn assert_invalid_package_reason(error: ContractError, expected: &str) {
    assert!(
      matches!(
        error,
        ContractError::InvalidPreparedSearchPackage { reason }
          if reason == expected
      ),
      "expected invalid package reason: {expected}"
    );
  }
}
