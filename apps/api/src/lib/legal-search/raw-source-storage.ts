import { writeS3ObjectWithRetry } from "@/api/lib/s3";

/**
 * Where a publisher's verbatim response is kept, for both corpus families.
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
 * Store one verbatim publisher payload and return its object key.
 *
 * The write is retried: failing here holds the ingestion cursor, so letting
 * one transient transport failure through stalls the whole source until the
 * next attempt happens to succeed. The key is the payload's own hash, so a
 * retry that duplicates an attempt which landed late is a no-op — and a key
 * the row already records names an object with these exact bytes, so that PUT
 * is skipped outright. A changed content type still re-uploads: it is stored
 * on the object, not derivable from the key.
 */
export const writeRawSourcePayload = async ({
  family,
  sourceId,
  data,
  contentType,
  storedKey,
  storedContentType,
}: WriteRawSourcePayloadOptions): Promise<string> => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  const key = `${family}/raw/${sourceId}/${hasher.digest("hex")}`;
  if (key === storedKey && contentType === storedContentType) {
    return key;
  }
  await writeS3ObjectWithRetry({ contentType, data, key });
  return key;
};

/** The seam a caller injects in tests, in place of the object-storage write. */
export type WriteRawSourcePayload = typeof writeRawSourcePayload;
