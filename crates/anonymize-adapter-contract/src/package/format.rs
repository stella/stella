//! Prepared-package wire headers.
//!
//! Raw and compressed packages share one schema version per payload family.
//! Compression is an independent tag, so changing or adding a codec never
//! consumes a schema version. Legacy `*1` package magics are intentionally not
//! accepted.

use crate::error::{Result, invalid_prepared_search_package};

use super::PackageCompression;

pub(crate) const BINDING_PACKAGE_SCHEMA_VERSION: u32 = 12;
pub(crate) const CORE_PACKAGE_SCHEMA_VERSION: u32 = 12;

pub(crate) const PREPARED_SEARCH_PACKAGE_HEADER: [u8; 8] = *b"ANONPKG2";
pub(crate) const PREPARED_SEARCH_COMPRESSED_PACKAGE_HEADER: [u8; 8] =
  *b"ANONPKZ2";
pub(crate) const PREPARED_SEARCH_CORE_PACKAGE_HEADER: [u8; 8] = *b"ANONCPK2";
pub(crate) const PREPARED_SEARCH_CORE_COMPRESSED_PACKAGE_HEADER: [u8; 8] =
  *b"ANONCPZ2";

pub(crate) const PREPARED_SEARCH_PACKAGE_DIGEST_BYTES: usize = 32;
#[cfg(all(test, feature = "zstd"))]
pub(crate) const PREPARED_SEARCH_PACKAGE_ZSTD_LEVEL: i32 = 1;
pub(crate) const MAX_PREPARED_SEARCH_PACKAGE_PAYLOAD_BYTES: usize =
  256 * 1024 * 1024;

const COMPRESSION_LZ4: u8 = PackageCompression::Lz4.wire_tag();
const COMPRESSION_ZSTD: u8 = PackageCompression::Zstd.wire_tag();

pub(crate) const fn raw_package_header_len(payload: &[u8]) -> usize {
  PREPARED_SEARCH_PACKAGE_HEADER
    .len()
    .saturating_add(std::mem::size_of::<u32>())
    .saturating_add(PREPARED_SEARCH_PACKAGE_DIGEST_BYTES)
    .saturating_add(payload.len())
}

pub(crate) fn write_package_header(
  bytes: &mut Vec<u8>,
  header: [u8; 8],
  schema_version: u32,
  digest: &[u8; PREPARED_SEARCH_PACKAGE_DIGEST_BYTES],
) {
  bytes.extend_from_slice(&header);
  bytes.extend_from_slice(&schema_version.to_le_bytes());
  bytes.extend_from_slice(digest);
}

pub(crate) fn write_compressed_package_header(
  bytes: &mut Vec<u8>,
  header: [u8; 8],
  schema_version: u32,
  compression: PackageCompression,
  digest: &[u8; PREPARED_SEARCH_PACKAGE_DIGEST_BYTES],
) {
  bytes.extend_from_slice(&header);
  bytes.extend_from_slice(&schema_version.to_le_bytes());
  bytes.push(compression.wire_tag());
  bytes.extend_from_slice(digest);
}

#[derive(Clone, Copy)]
pub(crate) struct RawPackageHeader<'a> {
  pub(crate) digest: [u8; PREPARED_SEARCH_PACKAGE_DIGEST_BYTES],
  pub(crate) payload: &'a [u8],
}

#[derive(Clone, Copy)]
pub(crate) struct CompressedPackageHeader<'a> {
  pub(crate) compression: PackageCompression,
  pub(crate) digest: [u8; PREPARED_SEARCH_PACKAGE_DIGEST_BYTES],
  pub(crate) payload: &'a [u8],
}

pub(crate) fn raw_package_header(
  bytes: &[u8],
  expected_schema_version: u32,
  header_len: usize,
) -> Result<RawPackageHeader<'_>> {
  let (version_end, version) = read_schema_version(bytes, header_len)?;
  if version != expected_schema_version {
    return Err(invalid_prepared_search_package(
      "unsupported schema version",
    ));
  }
  let (digest, payload) = read_digest_and_payload(bytes, version_end)?;
  Ok(RawPackageHeader { digest, payload })
}

pub(crate) fn compressed_package_header(
  bytes: &[u8],
  expected_schema_version: u32,
  header_len: usize,
) -> Result<CompressedPackageHeader<'_>> {
  let (version_end, version) = read_schema_version(bytes, header_len)?;
  if version != expected_schema_version {
    return Err(invalid_prepared_search_package(
      "unsupported schema version",
    ));
  }
  let compression = match bytes.get(version_end).copied() {
    Some(COMPRESSION_LZ4) => PackageCompression::Lz4,
    Some(COMPRESSION_ZSTD) => PackageCompression::Zstd,
    Some(_) => {
      return Err(invalid_prepared_search_package(
        "unsupported compression codec",
      ));
    }
    None => {
      return Err(invalid_prepared_search_package(
        "truncated compression codec",
      ));
    }
  };
  let digest_start = version_end.saturating_add(std::mem::size_of::<u8>());
  let (digest, payload) = read_digest_and_payload(bytes, digest_start)?;
  Ok(CompressedPackageHeader {
    compression,
    digest,
    payload,
  })
}

fn read_schema_version(bytes: &[u8], start: usize) -> Result<(usize, u32)> {
  let end = start.saturating_add(std::mem::size_of::<u32>());
  let version_bytes = bytes
    .get(start..end)
    .ok_or_else(|| invalid_prepared_search_package("truncated version"))?;
  let version_array = <[u8; 4]>::try_from(version_bytes)
    .map_err(|_| invalid_prepared_search_package("malformed version"))?;
  Ok((end, u32::from_le_bytes(version_array)))
}

fn read_digest_and_payload(
  bytes: &[u8],
  digest_start: usize,
) -> Result<([u8; PREPARED_SEARCH_PACKAGE_DIGEST_BYTES], &[u8])> {
  let digest_end =
    digest_start.saturating_add(PREPARED_SEARCH_PACKAGE_DIGEST_BYTES);
  let digest_bytes = bytes
    .get(digest_start..digest_end)
    .ok_or_else(|| invalid_prepared_search_package("truncated digest"))?;
  let digest =
    <[u8; PREPARED_SEARCH_PACKAGE_DIGEST_BYTES]>::try_from(digest_bytes)
      .map_err(|_| invalid_prepared_search_package("malformed digest"))?;
  let payload = bytes
    .get(digest_end..)
    .ok_or_else(|| invalid_prepared_search_package("missing payload"))?;
  Ok((digest, payload))
}
