import { panic, Result, TaggedError } from "better-result";

import { Temporal } from "@stll/time";

import { envBase } from "@/api/env-base";
import {
  formatCorpusLocation,
  parseCorpusLocation,
} from "@/api/lib/legal-search/corpus-location";
import {
  decodeSourceRawEnvelopeObjects,
  withSourceRawObjects,
} from "@/api/lib/legal-search/ingestion-types";
import type {
  SourceRawObjectRef,
  SourceRawObjects,
} from "@/api/lib/legal-search/ingestion-types";
import {
  createS3ObjectIfAbsent,
  deleteS3ObjectWithSignal,
  listS3ObjectKeys,
  headS3ObjectWithSignal,
  writeS3ObjectWithRetry,
} from "@/api/lib/s3";
import { copyObject } from "@/api/lib/s3-presign";

/**
 * Where a publisher's response is kept, for both corpus families.
 *
 * One implementation rather than one per family: the rule ("store the bytes
 * the publisher served under a key that is their own hash, and never PUT
 * bytes the key already holds") is the same for a decision and for a
 * statute, and a second copy of it would drift the moment either side
 * changed its skip condition. Where the key lives is the difference: a
 * decision's payloads and files live under a prefix of its own, so erasing
 * one decision is deleting one prefix and nothing another decision holds.
 */

export const RAW_SOURCE_FAMILY = {
  CASE_LAW: "case-law",
  LEGISLATION: "legislation",
} as const;

export type RawSourceFamily =
  (typeof RAW_SOURCE_FAMILY)[keyof typeof RAW_SOURCE_FAMILY];

/** The stored document one raw object belongs to. */
export type RawDocumentOwner = {
  family: RawSourceFamily;
  sourceId: string;
  /** The stored document (a decision's row id) the object was served for. */
  documentId: string;
};

/**
 * Every raw object one document owns lives under this prefix, and nothing
 * else does, so erasing the document is deleting the prefix.
 *
 * Per document rather than per source: two decisions served the same bytes
 * each hold their own copy, so erasing one can never remove the other's.
 */
export const rawDocumentPrefix = ({
  family,
  sourceId,
  documentId,
}: RawDocumentOwner): string =>
  `${family}/raw/${sourceId}/documents/${documentId}/`;

/** Payloads sit apart from files, so neither can take the other's key. */
const PAYLOADS_SEGMENT = "payloads/";

/**
 * Whose raw payload is being written. A decision's is its own; a statute's
 * is still addressed per source, since nothing erases one.
 */
export type RawSourcePayloadOwner =
  | { family: typeof RAW_SOURCE_FAMILY.LEGISLATION; sourceId: string }
  | (RawDocumentOwner & { family: typeof RAW_SOURCE_FAMILY.CASE_LAW });

const sha256Of = (data: Uint8Array | string): string =>
  new Bun.CryptoHasher("sha256").update(data).digest("hex");

/** A document's payload key for a payload of this digest. */
export const rawDocumentPayloadKey = (
  owner: RawDocumentOwner,
  sha256: string,
): string => `${rawDocumentPrefix(owner)}${PAYLOADS_SEGMENT}${sha256}`;

/** Where one payload lives: its own digest, under its owner's prefix. */
export const rawSourcePayloadKey = ({
  owner,
  data,
}: {
  owner: RawSourcePayloadOwner;
  data: Uint8Array | string;
}): string => {
  switch (owner.family) {
    case RAW_SOURCE_FAMILY.CASE_LAW:
      return rawDocumentPayloadKey(owner, sha256Of(data));
    case RAW_SOURCE_FAMILY.LEGISLATION:
      return `${owner.family}/raw/${owner.sourceId}/${sha256Of(data)}`;
    default:
      owner satisfies never;
      return panic(`Unhandled raw source owner ${String(owner)}`);
  }
};

/**
 * How long after a writer last saw its document live it may still start a
 * raw write.
 *
 * An erasure cannot wait for writes it does not know about, and a write
 * outside a transaction cannot be fenced by one. So every writer checks the
 * row before it writes, starts no write once this window has closed, and an
 * erasure sweeps the document's prefix again once every write that could
 * have started before it is over; see {@link RAW_SOURCE_ERASURE_SETTLE_MS}.
 */
export const RAW_SOURCE_WRITE_WINDOW_MS = 10 * 60 * 1000;

/**
 * When an erasure's last sweep may run: past the write window, plus far more
 * than one bounded write takes (a few attempts of seconds each), so a write
 * that started inside the window has landed or failed by then.
 */
export const RAW_SOURCE_ERASURE_SETTLE_MS = 6 * RAW_SOURCE_WRITE_WINDOW_MS;

class RawSourceWriteWindowClosedError extends TaggedError(
  "RawSourceWriteWindowClosedError",
)<{ message: string }> {}

/** The deadline a writer's raw writes must start by. */
export type RawSourceWriteWindow = { readonly closesAtMs: number };

/**
 * Open before the read that proves the document live, so every write it
 * guards starts within the window of that read.
 */
export const openRawSourceWriteWindow = (): RawSourceWriteWindow => ({
  closesAtMs:
    Temporal.Now.instant().epochMilliseconds + RAW_SOURCE_WRITE_WINDOW_MS,
});

const assertWriteWindowOpen = (window: RawSourceWriteWindow): void => {
  if (Temporal.Now.instant().epochMilliseconds >= window.closesAtMs) {
    throw new RawSourceWriteWindowClosedError({
      message: "Raw source write window closed before the write started",
    });
  }
};

type RawSourcePayloadWrite = {
  data: Uint8Array | string;
  contentType: string;
  /** The raw-payload key the row already records, or null for none. */
  storedKey: string | null;
  /** The content type recorded with that key. */
  storedContentType: string | null;
};

export type WriteRawSourcePayloadOptions = RawSourcePayloadWrite &
  (
    | {
        owner: Extract<
          RawSourcePayloadOwner,
          { family: typeof RAW_SOURCE_FAMILY.LEGISLATION }
        >;
      }
    | {
        owner: Extract<
          RawSourcePayloadOwner,
          { family: typeof RAW_SOURCE_FAMILY.CASE_LAW }
        >;
        window: RawSourceWriteWindow;
      }
  );

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
export const writeRawSourcePayload = async (
  options: WriteRawSourcePayloadOptions,
): Promise<string> => {
  const { owner, data, contentType, storedKey, storedContentType } = options;
  const key = rawSourcePayloadKey({ owner, data });
  if (key === storedKey && contentType === storedContentType) {
    return key;
  }
  if ("window" in options) {
    assertWriteWindowOpen(options.window);
  }
  if (key !== storedKey) {
    await createS3ObjectIfAbsent({ contentType, data, key });
    return key;
  }
  await writeS3ObjectWithRetry({ contentType, data, key });
  return key;
};

/** The seam a caller injects in tests, in place of the object-storage write. */
export type WriteRawSourcePayload = typeof writeRawSourcePayload;

type SourceBinaryInput = RawDocumentOwner & {
  bytes: Uint8Array;
  contentType: string;
};

/** A file's key within its document, from its digest. */
const sourceBinaryKey = (owner: RawDocumentOwner, sha256: string): string =>
  `${rawDocumentPrefix(owner)}${sha256}`;

/**
 * The reference one publisher file is addressed by, from its owner and its
 * bytes alone.
 *
 * Separate from the write so the address is a function of the payload and
 * not of a response: a caller that has to state what a stored envelope will
 * say, before or without the write, derives it here instead of spelling the
 * key format a second time. The address is written in the corpus location
 * form: standalone today, and a packed address once these files are packed,
 * which changes this function and nothing that reads its result.
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
      key: sourceBinaryKey(owner, sha256),
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
 * worker, writes nothing.
 */
export const writeSourceBinary = async ({
  window,
  ...input
}: SourceBinaryInput & {
  window: RawSourceWriteWindow;
}): Promise<SourceRawObjectRef> => {
  const ref = sourceBinaryRef(input);
  const location = parseCorpusLocation(ref.location);
  if (location.type !== "object") {
    return panic(`Unexpected source binary location ${ref.location}`);
  }
  assertWriteWindowOpen(window);
  await createS3ObjectIfAbsent({
    contentType: input.contentType,
    data: input.bytes,
    key: location.key,
  });
  return ref;
};

/** Where a stored raw key sits relative to one decision. */
export const RAW_KEY_OWNERSHIP = {
  /** Under the decision's own prefix. */
  OWN: "own",
  /**
   * The source-wide, content-addressed layout every key had before keys
   * were per decision. Such an object may be shared with another decision.
   */
  LEGACY: "legacy",
  /** Anything else: another decision's prefix, another source, a pack. */
  FOREIGN: "foreign",
} as const;

export type RawKeyOwnership =
  (typeof RAW_KEY_OWNERSHIP)[keyof typeof RAW_KEY_OWNERSHIP];

const SHA256_HEX = /^[0-9a-f]{64}$/u;

/** Where a source's objects in the older, source-wide layout sit. */
export const legacyCaseLawRawPrefix = (sourceId: string): string =>
  `${RAW_SOURCE_FAMILY.CASE_LAW}/raw/${sourceId}/`;

/** A key of the source-wide layout: a digest directly under the source. */
export const isLegacyCaseLawRawKey = (key: string, sourceId: string): boolean =>
  key.startsWith(legacyCaseLawRawPrefix(sourceId)) &&
  SHA256_HEX.test(key.slice(legacyCaseLawRawPrefix(sourceId).length));

export const classifyCaseLawRawKey = (
  key: string,
  owner: Omit<RawDocumentOwner, "family">,
): RawKeyOwnership => {
  if (
    key.startsWith(
      rawDocumentPrefix({ ...owner, family: RAW_SOURCE_FAMILY.CASE_LAW }),
    )
  ) {
    return RAW_KEY_OWNERSHIP.OWN;
  }
  return isLegacyCaseLawRawKey(key, owner.sourceId)
    ? RAW_KEY_OWNERSHIP.LEGACY
    : RAW_KEY_OWNERSHIP.FOREIGN;
};

/** One file an envelope names from outside its document, to be copied in. */
export type RawObjectCopy = {
  fromKey: string;
  /** The reference the envelope names the copy by. */
  ref: SourceRawObjectRef;
};

export type HomedRawPayload = {
  payload: Uint8Array | string;
  copies: RawObjectCopy[];
};

class RawSourceObjectUnhomeableError extends TaggedError(
  "RawSourceObjectUnhomeableError",
)<{ message: string; location: string }> {}

/**
 * The payload a decision stores, with every file it names addressed under
 * the decision's own prefix, and the copies that make those addresses true.
 *
 * An envelope that arrives already naming files, rather than with the bytes
 * of them, is one read back from storage: a replay, or a row written before
 * files were per decision. Stored as it came, it would name files another
 * decision's erasure could remove, and its own erasure could not. Pure: the
 * new address is a function of the digest the reference already states, so
 * whether anything needs copying is known before any read.
 */
export const homeRawPayloadObjects = ({
  payload,
  owner,
}: {
  payload: Uint8Array | string;
  owner: RawDocumentOwner;
}): HomedRawPayload => {
  if (typeof payload !== "string") {
    return { payload, copies: [] };
  }
  const named = Object.entries(decodeSourceRawEnvelopeObjects(payload));
  const copies: RawObjectCopy[] = [];
  const homed: Record<string, SourceRawObjectRef> = {};
  for (const [part, ref] of named) {
    if (classifyCaseLawRawKey(ref.location, owner) === RAW_KEY_OWNERSHIP.OWN) {
      homed[part] = ref;
      continue;
    }
    if (ref.location.startsWith("pack:") || !SHA256_HEX.test(ref.sha256)) {
      throw new RawSourceObjectUnhomeableError({
        message: `Envelope names a file that cannot be copied: ${ref.location}`,
        location: ref.location,
      });
    }
    const own = {
      ...ref,
      location: formatCorpusLocation({
        type: "object",
        key: sourceBinaryKey(owner, ref.sha256),
      }),
    };
    homed[part] = own;
    copies.push({ fromKey: ref.location, ref: own });
  }
  return copies.length === 0
    ? { payload, copies }
    : {
        payload: withSourceRawObjects(
          payload,
          homed satisfies SourceRawObjects,
        ),
        copies,
      };
};

class RawSourceObjectCopyError extends TaggedError("RawSourceObjectCopyError")<{
  message: string;
  fromKey: string;
}> {}

/**
 * The copy's source is absent or is not the bytes the envelope states: no
 * later attempt copies it either, as opposed to a transport failure.
 */
export const isUnmovableRawObjectError = (error: unknown): boolean =>
  error instanceof RawSourceObjectCopyError ||
  error instanceof RawSourceObjectUnhomeableError;

/**
 * Copy one object into its document, server-side: nothing passes through
 * this process, whatever its size.
 *
 * The source is addressed by its own digest, so the name is the check: a
 * source whose name is not the digest the reference states, whose length is
 * not the one it states, or that is not stored at all cannot be copied, on
 * this attempt or any later one. An object already at the destination holds
 * the same bytes, since that key is the same digest, and is not copied again.
 */
export const copyRawObject = async ({
  copy: { fromKey, ref },
  window,
  signal,
}: {
  copy: RawObjectCopy;
  window: RawSourceWriteWindow;
  signal: AbortSignal;
}): Promise<void> => {
  if (!fromKey.endsWith(`/${ref.sha256}`)) {
    throw new RawSourceObjectCopyError({
      message: `A copy source is not named by its digest: ${fromKey}`,
      fromKey,
    });
  }
  const source = await headS3ObjectWithSignal(fromKey, signal);
  if (source === null || source.contentLength !== ref.byteLength) {
    throw new RawSourceObjectCopyError({
      message: `A copy source is not stored as its reference states: ${fromKey}`,
      fromKey,
    });
  }
  const location = parseCorpusLocation(ref.location);
  if (location.type !== "object") {
    return panic(`Unexpected raw object location ${ref.location}`);
  }
  if ((await headS3ObjectWithSignal(location.key, signal)) !== null) {
    return;
  }
  assertWriteWindowOpen(window);
  const copied = await copyObject(fromKey, location.key);
  if (Result.isError(copied)) {
    throw copied.error;
  }
};

class RawDocumentErasureIncompleteError extends TaggedError(
  "RawDocumentErasureIncompleteError",
)<{ message: string; prefix: string }> {}

/** Deletes an erasure keeps in flight at once. */
const RAW_DELETE_CONCURRENCY = 8;

/** Delete keys, a bounded number at a time. Deleting an absent key succeeds. */
export const deleteRawKeys = async (
  keys: readonly string[],
  signal: AbortSignal,
): Promise<void> => {
  if (keys.length === 0) {
    return;
  }
  await Promise.all(
    keys
      .slice(0, RAW_DELETE_CONCURRENCY)
      .map(async (key) => await deleteS3ObjectWithSignal(key, signal)),
  );
  await deleteRawKeys(keys.slice(RAW_DELETE_CONCURRENCY), signal);
};

/** Keys one listing round of an erasure deletes. */
const RAW_ERASE_PAGE = 100;
/** Rounds before an erasure gives up and stays a retry target. */
const RAW_ERASE_MAX_ROUNDS = 10;

/**
 * Delete every raw object one document owns: its payloads, including those
 * an earlier observation stored and a later one replaced, and its files.
 *
 * Throws when a listing or a delete fails, or when the prefix outlasts the
 * round bound, so the caller keeps the erasure as a retry target rather than
 * recording one it did not finish.
 */
export const eraseRawDocument = async ({
  signal,
  ...owner
}: RawDocumentOwner & { signal: AbortSignal }): Promise<void> => {
  const prefix = rawDocumentPrefix(owner);
  const eraseRound = async (round: number): Promise<void> => {
    const keys = await listS3ObjectKeys({
      bucket: envBase.S3_BUCKET,
      prefix,
      maxKeys: RAW_ERASE_PAGE,
      signal,
    });
    await deleteRawKeys(keys, signal);
    if (keys.length <= RAW_ERASE_PAGE) {
      return;
    }
    if (round >= RAW_ERASE_MAX_ROUNDS) {
      throw new RawDocumentErasureIncompleteError({
        message: `Raw objects remain under ${prefix}`,
        prefix,
      });
    }
    await eraseRound(round + 1);
  };
  await eraseRound(1);
};
