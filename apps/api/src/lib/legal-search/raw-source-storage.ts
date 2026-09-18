import { formatCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import type { SourceRawObjectRef } from "@/api/lib/legal-search/ingestion-types";
import { writeS3ObjectWithRetry } from "@/api/lib/s3";

/**
 * Where a publisher's response is kept, for both corpus families.
 *
 * One implementation rather than one per family: the rule ("store the bytes
 * the publisher served under a key that is their own hash, and do not re-PUT
 * an object the row already records") is the same for a decision and for a
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

/**
 * Store one publisher payload and return its object key.
 *
 * The write is retried: failing here holds the ingestion cursor, so letting
 * one transient transport failure through stalls the whole source until the
 * next attempt happens to succeed. The key is the payload's own hash, so a
 * retry that duplicates an attempt which landed late is a no-op — and a key
 * the row already records names an object with these exact bytes, so that PUT
 * is skipped outright. A changed content type still re-uploads: it is stored
 * on the object, not derivable from the key.
 */
const sha256Of = (data: Uint8Array | string): string =>
  new Bun.CryptoHasher("sha256").update(data).digest("hex");

/** Where one payload lives: its own digest, under its source's prefix. */
const rawSourcePayloadKey = ({
  family,
  sourceId,
  sha256,
}: {
  family: RawSourceFamily;
  sourceId: string;
  sha256: string;
}): string => `${family}/raw/${sourceId}/${sha256}`;

export const writeRawSourcePayload = async ({
  family,
  sourceId,
  data,
  contentType,
  storedKey,
  storedContentType,
}: WriteRawSourcePayloadOptions): Promise<string> => {
  const key = rawSourcePayloadKey({
    family,
    sourceId,
    sha256: sha256Of(data),
  });
  if (key === storedKey && contentType === storedContentType) {
    return key;
  }
  await writeS3ObjectWithRetry({ contentType, data, key });
  return key;
};

/** The seam a caller injects in tests, in place of the object-storage write. */
export type WriteRawSourcePayload = typeof writeRawSourcePayload;

type SourceBinaryInput = {
  family: RawSourceFamily;
  sourceId: string;
  bytes: Uint8Array;
  contentType: string;
};

/**
 * The reference one publisher file is addressed by, from its bytes alone.
 *
 * Separate from the write so the address is a function of the payload and
 * not of a response: a caller that has to state what a stored envelope will
 * say, before or without the write, derives it here instead of spelling the
 * key format a second time.
 */
export const sourceBinaryRef = ({
  family,
  sourceId,
  bytes,
  contentType,
}: SourceBinaryInput): SourceRawObjectRef => {
  const sha256 = sha256Of(bytes);
  return {
    location: formatCorpusLocation({
      type: "object",
      key: rawSourcePayloadKey({ family, sourceId, sha256 }),
    }),
    sha256,
    contentType,
    byteLength: bytes.byteLength,
  };
};

/**
 * Store one publisher file beside the decision's raw payload, and answer the
 * reference the envelope names it by.
 *
 * The same content-addressed prefix the payload itself uses, so both live
 * under one source and a file served for two decisions is stored once. The
 * address is written in the corpus location form: standalone today, and a
 * packed address once these files are packed, which changes this function
 * and nothing that reads its result.
 */
export const writeSourceBinary = async ({
  family,
  sourceId,
  bytes,
  contentType,
}: SourceBinaryInput): Promise<SourceRawObjectRef> => {
  await writeRawSourcePayload({
    family,
    sourceId,
    data: bytes,
    contentType,
    storedKey: null,
    storedContentType: null,
  });
  return sourceBinaryRef({ family, sourceId, bytes, contentType });
};
