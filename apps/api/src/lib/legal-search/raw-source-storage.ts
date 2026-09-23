import { panic, TaggedError } from "better-result";

import { envBase } from "@/api/env-base";
import {
  formatCorpusLocation,
  parseCorpusLocation,
} from "@/api/lib/legal-search/corpus-location";
import type { SourceRawObjectRef } from "@/api/lib/legal-search/ingestion-types";
import {
  createS3ObjectIfAbsent,
  deleteS3ObjectWithSignal,
  listS3ObjectKeys,
  writeS3ObjectWithRetry,
} from "@/api/lib/s3";

/**
 * Where a publisher's response is kept, for both corpus families.
 *
 * One implementation rather than one per family: the rule ("store the bytes
 * the publisher served under a key that is their own hash, and never PUT
 * bytes the key already holds") is the same for a decision and for a
 * statute, and a second copy of it would drift the moment either side
 * changed its skip condition. The key prefix is the only difference, and it
 * is a parameter.
 */

export const RAW_SOURCE_FAMILY = {
  CASE_LAW: "case-law",
  LEGISLATION: "legislation",
} as const;

export type RawSourceFamily =
  (typeof RAW_SOURCE_FAMILY)[keyof typeof RAW_SOURCE_FAMILY];

export type WriteRawSourcePayloadOptions = {
  family: RawSourceFamily;
  /** The corpus source the payload belongs to; partitions the key space. */
  sourceId: string;
  data: Uint8Array | string;
  contentType: string;
  /** The raw-payload key the row already records, or null for none. */
  storedKey: string | null;
  /** The content type recorded with that key. */
  storedContentType: string | null;
};

const sha256Of = (data: Uint8Array | string): string =>
  new Bun.CryptoHasher("sha256").update(data).digest("hex");

/** Where one payload lives: its own digest, under its source's prefix. */
export const rawSourcePayloadKey = ({
  family,
  sourceId,
  data,
}: Pick<
  WriteRawSourcePayloadOptions,
  "family" | "sourceId" | "data"
>): string => `${family}/raw/${sourceId}/${sha256Of(data)}`;

/**
 * Store one publisher payload and return its object key.
 *
 * The write is retried: failing here holds the ingestion cursor, so letting
 * one transient transport failure through stalls the whole source until the
 * next attempt happens to succeed. The key is the payload's own hash, so a
 * key the row already records names an object with these exact bytes and is
 * not written at all, and any other key is created only if absent: a replay,
 * a late-landing retry or a concurrent writer of the same bytes adds no
 * version. A changed content type on the recorded key still re-uploads: it is
 * stored on the object, not derivable from the key.
 */
export const writeRawSourcePayload = async ({
  family,
  sourceId,
  data,
  contentType,
  storedKey,
  storedContentType,
}: WriteRawSourcePayloadOptions): Promise<string> => {
  const key = rawSourcePayloadKey({ family, sourceId, data });
  if (key !== storedKey) {
    await createS3ObjectIfAbsent({ contentType, data, key });
    return key;
  }
  if (contentType !== storedContentType) {
    await writeS3ObjectWithRetry({ contentType, data, key });
  }
  return key;
};

/** The seam a caller injects in tests, in place of the object-storage write. */
export type WriteRawSourcePayload = typeof writeRawSourcePayload;

type SourceBinaryOwner = {
  family: RawSourceFamily;
  sourceId: string;
  /** The stored document (a decision's row id) the file was served for. */
  documentId: string;
};

type SourceBinaryInput = SourceBinaryOwner & {
  bytes: Uint8Array;
  contentType: string;
};

/**
 * Every publisher file one document owns lives under this prefix, and
 * nothing else does, so erasing the document is deleting the prefix.
 *
 * Per document rather than per source: two decisions served the same file
 * each hold their own copy, so erasing one can never remove the other's.
 */
export const sourceBinaryPrefix = ({
  family,
  sourceId,
  documentId,
}: SourceBinaryOwner): string =>
  `${family}/raw/${sourceId}/documents/${documentId}/`;

/**
 * The reference one publisher file is addressed by, from its owner and its
 * bytes alone.
 *
 * Separate from the write so the address is a function of the payload and
 * not of a response: a caller that has to state what a stored envelope will
 * say, before or without the write, derives it here instead of spelling the
 * key format a second time.
 */
export const sourceBinaryRef = ({
  bytes,
  contentType,
  ...owner
}: SourceBinaryInput): SourceRawObjectRef => {
  const sha256 = sha256Of(bytes);
  return {
    location: formatCorpusLocation({
      type: "object",
      key: `${sourceBinaryPrefix(owner)}${sha256}`,
    }),
    sha256,
    contentType,
    byteLength: bytes.byteLength,
  };
};

/**
 * Store one publisher file, and answer the reference the envelope names it by.
 *
 * Content-addressed within its document and created only if absent, so
 * observing the same file again, by a crawl, a replay or a concurrent
 * worker, writes nothing. The address is written in the corpus location
 * form: standalone today, and a packed address once these files are packed,
 * which changes this function and nothing that reads its result.
 */
export const writeSourceBinary = async (
  input: SourceBinaryInput,
): Promise<SourceRawObjectRef> => {
  const ref = sourceBinaryRef(input);
  const location = parseCorpusLocation(ref.location);
  if (location.type !== "object") {
    return panic(`Unexpected source binary location ${ref.location}`);
  }
  await createS3ObjectIfAbsent({
    contentType: input.contentType,
    data: input.bytes,
    key: location.key,
  });
  return ref;
};

class SourceBinaryErasureIncompleteError extends TaggedError(
  "SourceBinaryErasureIncompleteError",
)<{ message: string; prefix: string }> {}

/** Deletes an erasure keeps in flight at once. */
const SOURCE_BINARY_DELETE_CONCURRENCY = 8;

const deleteKeys = async (
  keys: readonly string[],
  signal: AbortSignal,
): Promise<void> => {
  if (keys.length === 0) {
    return;
  }
  await Promise.all(
    keys
      .slice(0, SOURCE_BINARY_DELETE_CONCURRENCY)
      .map(async (key) => await deleteS3ObjectWithSignal(key, signal)),
  );
  await deleteKeys(keys.slice(SOURCE_BINARY_DELETE_CONCURRENCY), signal);
};

/** Keys one listing round of an erasure deletes. */
const SOURCE_BINARY_ERASE_PAGE = 100;
/** Rounds before an erasure gives up and stays a retry target. */
const SOURCE_BINARY_ERASE_MAX_ROUNDS = 10;

/**
 * Delete every publisher file one document owns, including those an earlier
 * envelope named and a later one replaced.
 *
 * Throws when a listing or a delete fails, or when the prefix outlasts the
 * round bound, so the caller keeps the erasure as a retry target rather than
 * recording one it did not finish.
 */
export const eraseSourceBinaries = async ({
  signal,
  ...owner
}: SourceBinaryOwner & { signal: AbortSignal }): Promise<void> => {
  const prefix = sourceBinaryPrefix(owner);
  const eraseRound = async (round: number): Promise<void> => {
    const keys = await listS3ObjectKeys({
      bucket: envBase.S3_BUCKET,
      prefix,
      maxKeys: SOURCE_BINARY_ERASE_PAGE,
      signal,
    });
    await deleteKeys(keys, signal);
    if (keys.length <= SOURCE_BINARY_ERASE_PAGE) {
      return;
    }
    if (round >= SOURCE_BINARY_ERASE_MAX_ROUNDS) {
      throw new SourceBinaryErasureIncompleteError({
        message: `Source files remain under ${prefix}`,
        prefix,
      });
    }
    await eraseRound(round + 1);
  };
  await eraseRound(1);
};
