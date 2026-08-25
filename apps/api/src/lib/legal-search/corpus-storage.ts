import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  persistedDocumentAstSchema,
  type DocumentAst,
} from "@stll/legal-ast/document-ast";

import { CASE_LAW_CORPUS_MIRROR_STATUS } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import {
  PayloadBudgetError,
  zstdCompressAsync,
  zstdCompressBound,
  zstdDecompressToStringBounded,
} from "@/api/lib/compression";
import type { CorpusStorageMode } from "@/api/lib/corpus-storage-mode";
import { CorpusPayloadUnavailableError } from "@/api/lib/errors/tagged-errors";
import { parseCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import type {
  CorpusLocation,
  PackedCorpusLocation,
} from "@/api/lib/legal-search/corpus-location";
import {
  emptyAstSchema,
  EMPTY_AST,
  persistedDecisionSectionsSchema,
} from "@/api/lib/legal-search/document-types";
import type {
  DecisionSection,
  EmptyAst,
} from "@/api/lib/legal-search/document-types";
import { LIMITS } from "@/api/lib/limits";
import {
  deleteCorpusS3ObjectWithSignal,
  isMissingCorpusObjectError,
  putCorpusS3ObjectWithSignal,
  readCorpusS3BytesBounded,
  readCorpusS3Range,
} from "@/api/lib/s3";
import { withTimeout } from "@/api/lib/with-timeout";

/**
 * Canonical corpus payloads (text, sections, AST) live in object
 * storage, not Postgres. Keys are content-addressed under a
 * jurisdiction partition so a re-parse produces a new immutable object
 * and the row's key columns point at the current version. Payloads are
 * zstd-compressed JSON.
 *
 * A row's key column may also hold a packed address (corpus-location.ts):
 * the same bytes as a member of a larger pack object (corpus-pack.ts),
 * read by byte range. Every reader below parses the stored value, so
 * callers pass the column through unchanged whichever form it holds.
 */

const CONTENT_TYPE = "application/zstd";

const CORPUS_IO_TIMEOUT_MS = LIMITS.corpusObjectIoTimeoutMs;

const PAYLOAD_MAX_BYTES = LIMITS.corpusPayloadMaxDecompressedBytes;

/**
 * Ceiling on the transferred (still-compressed) bytes of one payload. A
 * zstd frame can exceed what it decodes to by frame and block overhead, so
 * a frame whose output sits at the decompressed ceiling must still fit the
 * transfer; the bound is zstd's worst case over that ceiling. Both the
 * whole-object read and the packed range read are checked against it.
 */
export const CORPUS_TRANSFER_MAX_BYTES = zstdCompressBound(PAYLOAD_MAX_BYTES);

const persistedCorpusAstSchema = v.nullable(
  v.union([persistedDocumentAstSchema, emptyAstSchema]),
);

export const parsePersistedCorpusSections = (
  value: unknown,
): DecisionSection[] | null => v.parse(persistedDecisionSectionsSchema, value);

export const parsePersistedCorpusAst = (
  value: unknown,
): DocumentAst | EmptyAst | null => v.parse(persistedCorpusAstSchema, value);

/**
 * The single bounded boundary for every corpus object read/write/delete.
 * Bun's S3 convenience methods (`.file(key).bytes()`, `.write`, `.delete`)
 * accept no per-request AbortSignal, so a stalled socket would leave the await
 * pending forever and wedge whichever loop issued it. Racing each operation
 * against a wall-clock ceiling rejects instead. Operations are
 * content-addressed and idempotent, so an abandoned (not cancelled) operation
 * is safe to retry.
 */
const boundedCorpusIo = async <T>(
  label: string,
  operation: (signal: AbortSignal) => Promise<T>,
  {
    signal,
    timeoutMs = CORPUS_IO_TIMEOUT_MS,
  }: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> => await withTimeout(operation, { label, signal, timeoutMs });

type CorpusKeyInput = {
  documentId: string;
  jurisdiction: string;
  contentHash: string;
};

type CorpusKeys = {
  textKey: string;
  sectionsKey: string;
  astKey: string;
};

export const corpusKeys = ({
  documentId,
  jurisdiction,
  contentHash,
}: CorpusKeyInput): CorpusKeys => {
  const base = `legal-corpus/documents/jurisdiction=${jurisdiction}/${documentId}/${contentHash}`;
  return {
    textKey: `${base}/text.zst`,
    sectionsKey: `${base}/sections.json.zst`,
    astKey: `${base}/ast.json.zst`,
  };
};

export type CorpusPayload = {
  text: string | null;
  sections: DecisionSection[] | null;
  ast: DocumentAst | EmptyAst | null;
};

/**
 * Separates the payload's fields inside the hash, so a document whose
 * text ends where the next field begins cannot collide with a different
 * split of the same bytes. NUL cannot occur in a payload: the pipeline
 * strips it from every stored string. Spelled as an escape because a
 * literal NUL in source makes the file binary to half the toolchain —
 * the byte, and therefore every hash, is unchanged.
 */
const FIELD_SEPARATOR = "\u0000";

/** sha256 over the canonical payload; what S3 keys and indexedHash compare. */
export const corpusContentHash = ({
  text,
  sections,
  ast,
}: CorpusPayload): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text ?? "");
  hasher.update(FIELD_SEPARATOR);
  hasher.update(JSON.stringify(sections ?? null));
  hasher.update(FIELD_SEPARATOR);
  hasher.update(JSON.stringify(ast ?? null));
  return hasher.digest("hex");
};

/**
 * The content hashes of a payload that carries no document.
 *
 * A metadata-first ingest stores the decision's identity and leaves the
 * document to a later fetch, so under dual-write or canonical storage it
 * still writes a corpus payload — an empty one. Those objects are
 * indistinguishable from a real payload by key alone, so the hash is
 * what identifies them: a row still carrying one of these has nothing
 * readable in object storage, whatever its Postgres columns say.
 *
 * Derived rather than written down, so a change to the hash function or
 * to the empty shapes cannot leave a stale constant behind. `null` and
 * `""` text hash alike (the hasher coalesces), so the variants are the
 * cross product of the empty sections shapes (none, or a stored `[]`)
 * with the constant empty AST shapes (the `EMPTY_AST` placeholder, or
 * none at all). A structurally valid AST with no blocks is deliberately
 * NOT here — its envelope carries per-document metadata, so its hash is
 * row-specific and no constant can name it; those rows are recognised
 * structurally instead (see stored-payload.ts).
 */
const EMPTY_SECTION_SHAPES: readonly (DecisionSection[] | null)[] = [null, []];
// A full `DocumentAst` with an empty `blocks` array is NOT representable
// here: it carries per-document `source`/`metadata`, so its hash is
// row-specific and no constant can name it. Such a row (empty text, empty
// blocks, populated envelope) is judged by the Postgres-side structural
// predicate instead; the hash constants cover every payload whose empty
// shape is content-independent.
const EMPTY_AST_SHAPES: readonly (DocumentAst | EmptyAst | null)[] = [
  EMPTY_AST,
  null,
];

export const EMPTY_CORPUS_CONTENT_HASHES: readonly string[] =
  EMPTY_SECTION_SHAPES.flatMap((sections) =>
    EMPTY_AST_SHAPES.map((ast) =>
      corpusContentHash({ text: null, sections, ast }),
    ),
  );

type WriteCorpusInput = CorpusPayload & {
  documentId: string;
  jurisdiction: string;
  /**
   * The corpus write the row currently records ({@link storedCorpusWrite}),
   * or null when it records none. A write whose derived keys and hash equal
   * this record is refused: the objects are content-addressed and a settled
   * record proves they were confirmed, so re-PUTting them buys nothing.
   * Required rather than optional so no call site can forget to state what
   * the row knows.
   */
  stored: WriteCorpusResult | null;
};

type CorpusIoOptions = { signal?: AbortSignal };

type StartedCorpusIo<T> = {
  result: Promise<T>;
  settle: () => Promise<void>;
};

type SettleCancellableCorpusIoGroupOptions = {
  controller: AbortController;
  operations: StartedCorpusIo<void>[];
};

/**
 * Keep a handle to the real cancellable operation as well as its bounded
 * result. `withTimeout` must return promptly when a deadline fires, but a
 * caller that will hand the keys to cleanup must first wait for the aborted
 * S3 request to settle: otherwise a late PUT could recreate an object after
 * cleanup deleted it.
 */
const startCancellableCorpusIo = <T>(
  label: string,
  operation: (signal: AbortSignal) => Promise<T>,
  options: CorpusIoOptions,
): StartedCorpusIo<T> => {
  let actual: Promise<T> | undefined;
  const result = boundedCorpusIo(
    label,
    async (operationSignal) => {
      const operationPromise = operation(operationSignal);
      actual = operationPromise;
      return await operationPromise;
    },
    options,
  );

  return {
    result,
    settle: async () => {
      if (actual !== undefined) {
        await Promise.allSettled([actual]);
      }
    },
  };
};

/** A failed sibling cannot return ownership until every aborted I/O settles. */
const settleCancellableCorpusIoGroup = async ({
  controller,
  operations,
}: SettleCancellableCorpusIoGroupOptions): Promise<void> => {
  try {
    await Promise.all(operations.map(async ({ result }) => await result));
  } catch (error) {
    controller.abort(error);
    await Promise.allSettled(
      operations.map(async ({ settle }) => await settle()),
    );
    throw error;
  }
};

export type WriteCorpusResult = CorpusKeys & { contentHash: string };

/** The corpus pointer columns as a decision or legislation row stores them. */
type StoredCorpusWriteColumns = {
  textS3Key: string | null;
  normalizedS3Key: string | null;
  astS3Key: string | null;
  contentHash: string | null;
};

/**
 * The corpus write a row records, in the shape {@link writeCorpusDocument}
 * compares against, or null when the row records none. All four columns
 * travel together — the mirror settles them in one statement — so a partial
 * set means no confirmed write.
 */
export const storedCorpusWrite = (
  row: StoredCorpusWriteColumns,
): WriteCorpusResult | null =>
  row.textS3Key !== null &&
  row.normalizedS3Key !== null &&
  row.astS3Key !== null &&
  row.contentHash !== null
    ? {
        textKey: row.textS3Key,
        sectionsKey: row.normalizedS3Key,
        astKey: row.astS3Key,
        contentHash: row.contentHash,
      }
    : null;

export type CorpusWriteOutcome =
  /** All three objects were PUT under the derived keys. */
  | { type: "written"; written: WriteCorpusResult }
  /** The row already records this exact write; nothing was PUT. */
  | { type: "skipped-unchanged"; written: WriteCorpusResult }
  /**
   * The payload carries no document; nothing was PUT, and the caller
   * settles the row's mirror with null pointers to say so. The payload's
   * hash still travels, for a caller whose index staleness tracking keys
   * off a non-null content hash and must converge on the empty payload
   * rather than skip the row.
   */
  | { type: "skipped-empty"; written: null; contentHash: string };

type PlannedCorpusWrite =
  | { type: "put"; written: WriteCorpusResult }
  | Extract<
      CorpusWriteOutcome,
      { type: "skipped-unchanged" | "skipped-empty" }
    >;

/**
 * The redundancy decision behind {@link writeCorpusDocument}, separated
 * from the S3 I/O so it stays a pure unit and a test double can fake only
 * the PUTs while keeping the real decision.
 *
 * A payload whose hash is one of the empty shapes stores nothing: a
 * metadata-first ingest would otherwise PUT the same constant
 * zero-information objects under a fresh key per row. A payload whose
 * derived keys and hash equal the write the row already records stores
 * nothing either — a settled record proves those exact objects were
 * confirmed. The comparison is over the keys, not the hash alone, because
 * the keys also carry the jurisdiction partition: an equal payload under a
 * moved jurisdiction must still land at its new keys.
 */
export const planCorpusDocumentWrite = ({
  documentId,
  jurisdiction,
  text,
  sections,
  ast,
  stored,
}: WriteCorpusInput): PlannedCorpusWrite => {
  const contentHash = corpusContentHash({ text, sections, ast });
  if (EMPTY_CORPUS_CONTENT_HASHES.includes(contentHash)) {
    return { type: "skipped-empty", written: null, contentHash };
  }
  const written = {
    ...corpusKeys({ documentId, jurisdiction, contentHash }),
    contentHash,
  };
  const unchanged =
    stored?.contentHash === contentHash &&
    stored.textKey === written.textKey &&
    stored.sectionsKey === written.sectionsKey &&
    stored.astKey === written.astKey;
  return unchanged
    ? { type: "skipped-unchanged", written }
    : { type: "put", written };
};

type CorpusMirrorState =
  | { status: typeof CASE_LAW_CORPUS_MIRROR_STATUS.PENDING }
  | {
      status: typeof CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED;
      written: WriteCorpusResult | null;
    };

type CorpusMirrorColumns =
  | {
      corpusMirrorStatus: typeof CASE_LAW_CORPUS_MIRROR_STATUS.PENDING;
      textS3Key: null;
      normalizedS3Key: null;
      astS3Key: null;
      contentHash: null;
    }
  | {
      corpusMirrorStatus: typeof CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED;
      textS3Key: string | null;
      normalizedS3Key: string | null;
      astS3Key: string | null;
      contentHash: string | null;
    };

/**
 * The only application-level constructor for the decision mirror columns.
 * Its discriminated input prevents a pending state from carrying pointers;
 * the database CHECK enforces the same invariant for every SQL writer.
 */
export const corpusMirrorColumns = (
  state: CorpusMirrorState,
): CorpusMirrorColumns => {
  switch (state.status) {
    case CASE_LAW_CORPUS_MIRROR_STATUS.PENDING:
      return {
        corpusMirrorStatus: state.status,
        textS3Key: null,
        normalizedS3Key: null,
        astS3Key: null,
        contentHash: null,
      };
    case CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED:
      return {
        corpusMirrorStatus: state.status,
        textS3Key: state.written?.textKey ?? null,
        normalizedS3Key: state.written?.sectionsKey ?? null,
        astS3Key: state.written?.astKey ?? null,
        contentHash: state.written?.contentHash ?? null,
      };
    default: {
      const unhandled: never = state;
      return unhandled;
    }
  }
};

/** The three Postgres columns a decision's canonical payload occupies. */
export type CorpusPayloadColumns = {
  fulltext: string | null;
  sections: DecisionSection[] | null;
  documentAst: DocumentAst | EmptyAst | null;
};

/**
 * Absent: how a corpus-served decision carries its payload columns.
 *
 * One definition, because four writers produce this state — the ingestion
 * pipeline's mirror settlement, the deferred-document store, the corpus
 * backfill and the operator column trim — and a hand-kept copy in any of
 * them would let a column survive a cutover in one path and not another.
 */
export const TRIMMED_CORPUS_PAYLOAD_COLUMNS = {
  fulltext: null,
  sections: null,
  documentAst: null,
} as const satisfies CorpusPayloadColumns;

/** What a settling write does with the Postgres payload columns. */
export const CORPUS_PAYLOAD_DISPOSITIONS = [
  /** Keep them: they are still what a read falls back to. */
  "retain",
  /** Null them: object storage is confirmed to hold the payload. */
  "trim",
] as const;

export type CorpusPayloadDisposition =
  (typeof CORPUS_PAYLOAD_DISPOSITIONS)[number];

type CorpusPayloadDispositionOptions = {
  mode: CorpusStorageMode;
  /**
   * The corpus write this settlement records, or null where nothing was
   * written. Only a confirmed write may drop the columns: until object
   * storage holds the payload, the columns are the whole of it.
   */
  written: WriteCorpusResult | null;
};

/**
 * Whether a write that has just settled a decision's corpus mirror may
 * drop the Postgres payload columns.
 *
 * Under `canonical` the columns are not a second copy, they are a stale
 * one: reads are served from object storage, so a write path that keeps
 * persisting them leaves the row in a state the deployed mode does not
 * describe, and an external pass that nulls them can only ever chase the
 * writers. Asking it here — once, off the storage mode and the write's
 * own result — is what makes the write paths converge on their own.
 *
 * Failure semantics are unchanged: a corpus write that did not confirm
 * carries `written: null`, and the columns stay exactly as the row
 * transaction wrote them.
 */
export const corpusPayloadDisposition = ({
  mode,
  written,
}: CorpusPayloadDispositionOptions): CorpusPayloadDisposition => {
  switch (mode) {
    case "off":
    case "dual-write":
      return "retain";
    case "canonical":
      return written === null ? "retain" : "trim";
    default: {
      const unhandled: never = mode;
      return panic(`Unhandled corpus storage mode: ${String(unhandled)}`);
    }
  }
};

export const writeCorpusDocument = async (
  input: WriteCorpusInput,
  { signal }: CorpusIoOptions = {},
): Promise<CorpusWriteOutcome> => {
  const plan = planCorpusDocumentWrite(input);
  if (plan.type !== "put") {
    return plan;
  }
  const { text, sections, ast } = input;
  const { written } = plan;
  const keys = {
    textKey: written.textKey,
    sectionsKey: written.sectionsKey,
    astKey: written.astKey,
  };
  const writeController = new AbortController();
  const groupSignal =
    signal === undefined
      ? writeController.signal
      : AbortSignal.any([writeController.signal, signal]);
  const writeOptions = { signal: groupSignal };

  const writes = [
    startCancellableCorpusIo(
      "corpus-write-text",
      async (writeSignal) =>
        await putCorpusS3ObjectWithSignal(
          keys.textKey,
          await zstdCompressAsync(text ?? ""),
          CONTENT_TYPE,
          writeSignal,
        ),
      writeOptions,
    ),
    startCancellableCorpusIo(
      "corpus-write-sections",
      async (writeSignal) =>
        await putCorpusS3ObjectWithSignal(
          keys.sectionsKey,
          await zstdCompressAsync(JSON.stringify(sections ?? null)),
          CONTENT_TYPE,
          writeSignal,
        ),
      writeOptions,
    ),
    startCancellableCorpusIo(
      "corpus-write-ast",
      async (writeSignal) =>
        await putCorpusS3ObjectWithSignal(
          keys.astKey,
          await zstdCompressAsync(JSON.stringify(ast ?? null)),
          CONTENT_TYPE,
          writeSignal,
        ),
      writeOptions,
    ),
  ];

  await settleCancellableCorpusIoGroup({
    controller: writeController,
    operations: writes,
  });

  return { type: "written", written };
};

type BoundedObjectReader = (options: {
  key: string;
  maxBytes: number;
  signal: AbortSignal;
}) => Promise<Uint8Array>;

type RangeReader = (options: {
  key: string;
  offset: number;
  length: number;
  signal: AbortSignal;
}) => Promise<Uint8Array>;

type ReadCorpusBytesAtOptions = {
  location: CorpusLocation;
  /** Ceiling on the transferred (still-compressed) bytes. */
  maxBytes: number;
  signal: AbortSignal;
  /** Test seams; production reads through the corpus bucket client. */
  readObject?: BoundedObjectReader;
  readRange?: RangeReader;
};

/**
 * The bytes a corpus location names, transferred under `maxBytes`.
 *
 * An object location is a bounded whole-object GET. A packed location is a
 * range GET of exactly the member; its declared length is checked against
 * the ceiling before any request is made.
 */
export const readCorpusBytesAt = async ({
  location,
  maxBytes,
  signal,
  readObject = readCorpusS3BytesBounded,
  readRange = readCorpusS3Range,
}: ReadCorpusBytesAtOptions): Promise<Uint8Array> => {
  switch (location.type) {
    case "object":
      return await readObject({ key: location.key, maxBytes, signal });
    case "packed": {
      if (location.length > maxBytes) {
        throw new PayloadBudgetError({
          message: `Packed corpus member declares ${location.length} bytes, past the ${maxBytes}-byte ceiling`,
        });
      }
      return await readRange({
        key: location.packKey,
        offset: location.offset,
        length: location.length,
        signal,
      });
    }
    default: {
      const unhandled: never = location;
      return panic(`Unhandled corpus location: ${String(unhandled)}`);
    }
  }
};

/** Test seams for the two byte sources; production reads through the corpus bucket client. */
type CorpusByteSourceSeams = {
  readObject?: BoundedObjectReader;
  readRange?: RangeReader;
};

type ReadStoredCorpusBytesOptions = CorpusByteSourceSeams & {
  storedKey: string;
  signal: AbortSignal;
};

const readStoredCorpusBytes = async ({
  storedKey,
  signal,
  ...seams
}: ReadStoredCorpusBytesOptions): Promise<Uint8Array> =>
  await readCorpusBytesAt({
    location: parseCorpusLocation(storedKey),
    maxBytes: CORPUS_TRANSFER_MAX_BYTES,
    signal,
    ...seams,
  });

type ReadCorpusTextOptions = CorpusByteSourceSeams & {
  timeoutMs?: number;
};

/**
 * Every reader takes the row's key column as stored: a plain object key or a
 * packed address (see {@link parseCorpusLocation}). The seams replace only
 * the byte source behind that routing, never the routing or the wall-clock
 * bound.
 */
export const readCorpusText = async (
  storedKey: string,
  { timeoutMs = CORPUS_IO_TIMEOUT_MS, ...seams }: ReadCorpusTextOptions = {},
): Promise<string> => {
  const bytes = await boundedCorpusIo(
    "corpus-read-text",
    async (signal) =>
      await readStoredCorpusBytes({ storedKey, signal, ...seams }),
    { timeoutMs },
  );
  return await zstdDecompressToStringBounded(bytes, PAYLOAD_MAX_BYTES);
};

export const readCorpusSections = async (
  storedKey: string,
): Promise<DecisionSection[] | null> => {
  const bytes = await boundedCorpusIo(
    "corpus-read-sections",
    async (signal) => await readStoredCorpusBytes({ storedKey, signal }),
  );
  const parsed: unknown = JSON.parse(
    await zstdDecompressToStringBounded(bytes, PAYLOAD_MAX_BYTES),
  );
  return parsePersistedCorpusSections(parsed);
};

export const readCorpusAst = async (
  storedKey: string,
): Promise<DocumentAst | EmptyAst | null> => {
  const bytes = await boundedCorpusIo(
    "corpus-read-ast",
    async (signal) => await readStoredCorpusBytes({ storedKey, signal }),
  );
  const parsed: unknown = JSON.parse(
    await zstdDecompressToStringBounded(bytes, PAYLOAD_MAX_BYTES),
  );
  return parsePersistedCorpusAst(parsed);
};

type ReadCorpusAtAuthoritativePointerOptions<T> = {
  storedKey: string;
  read: (storedKey: string) => Promise<T>;
  rereadStoredKey: () => Promise<string | null>;
};

/**
 * Recover the one legitimate read/repoint race. Only a confirmed absent
 * object permits one authoritative pointer reread and one replacement read.
 */
export const readCorpusAtAuthoritativePointer = async <T>({
  storedKey,
  read,
  rereadStoredKey,
}: ReadCorpusAtAuthoritativePointerOptions<T>): Promise<T> => {
  const first = await Result.tryPromise({
    try: async () => await read(storedKey),
    catch: (cause) => cause,
  });
  if (first.isOk()) {
    return first.value;
  }
  if (!isMissingCorpusObjectError(first.error)) {
    // eslint-disable-next-line no-throw-literal -- preserve the storage boundary's structured rejection
    throw first.error;
  }
  const replacement = await rereadStoredKey();
  if (replacement === null || replacement === storedKey) {
    // eslint-disable-next-line no-throw-literal -- unchanged authority preserves the original confirmed absence
    throw first.error;
  }
  return await read(replacement);
};

type CorpusReadWithFallbackInput<T> = {
  documentId: string;
  /** The row's key column as stored (object key or packed address). */
  key: string;
  /** Telemetry label for the degraded (fallback-served) path. */
  step: string;
  read: () => Promise<T>;
  /**
   * The Postgres copy that would serve this request instead. `null` means
   * the columns were never written (canonical storage) or have since been
   * trimmed, so there is nothing to degrade to. Evaluated only when the
   * object read fails, since it usually costs a query.
   */
  fallback: () => Promise<T | null> | T | null;
};

/**
 * Read a corpus object, degrading to the row's Postgres copy when object
 * storage fails — but only when that copy exists. Without it the payload is
 * simply gone for the duration of the outage, and returning an empty
 * document would render as a valid, bodyless decision.
 */
export const readCorpusPayloadOrFallback = async <T>({
  documentId,
  key,
  step,
  read,
  fallback,
}: CorpusReadWithFallbackInput<T>): Promise<T | null> => {
  const payload = await Result.tryPromise(read);
  if (Result.isOk(payload)) {
    return payload.value;
  }

  const postgresCopy = await fallback();
  if (postgresCopy === null) {
    throw new CorpusPayloadUnavailableError({
      message: `Corpus object is unreadable and the row has no Postgres copy: ${key}`,
      documentId,
      key,
      cause: payload.error,
    });
  }

  captureError(payload.error, { documentId, step });
  return postgresCopy;
};

export type CorpusDeleteOutcome =
  /** Every present pointer named a standalone object; each DELETE settled. */
  | { type: "deleted"; keys: string[] }
  /**
   * At least one pointer addresses a range inside a shared object; that
   * object is left in place. Standalone siblings were deleted.
   */
  | {
      type: "shared-object-retained";
      deletedKeys: string[];
      retained: PackedCorpusLocation[];
    };

type DeleteCorpusDocumentOptions = CorpusIoOptions & {
  /** Test seam; production deletes through the corpus bucket client. */
  deleteObject?: (key: string, signal: AbortSignal) => Promise<void>;
};

/**
 * Delete all corpus objects for a decision version (GDPR erasure).
 * Keys are individually nullable: a partially ingested decision may have
 * only some payloads written, and every present object must still go.
 */
export const deleteCorpusDocument = async (
  keys: {
    textKey: string | null;
    sectionsKey: string | null;
    astKey: string | null;
  },
  {
    signal,
    deleteObject = deleteCorpusS3ObjectWithSignal,
  }: DeleteCorpusDocumentOptions = {},
): Promise<CorpusDeleteOutcome> => {
  const objectKeys: string[] = [];
  const retained: PackedCorpusLocation[] = [];
  for (const storedKey of [keys.textKey, keys.sectionsKey, keys.astKey]) {
    if (storedKey === null) {
      continue;
    }
    const location = parseCorpusLocation(storedKey);
    if (location.type === "packed") {
      retained.push(location);
    } else {
      objectKeys.push(location.key);
    }
  }
  const deleteController = new AbortController();
  const groupSignal =
    signal === undefined
      ? deleteController.signal
      : AbortSignal.any([deleteController.signal, signal]);
  const operations = objectKeys.map((key) =>
    startCancellableCorpusIo(
      "corpus-delete",
      async (deleteSignal) => await deleteObject(key, deleteSignal),
      { signal: groupSignal },
    ),
  );
  await settleCancellableCorpusIoGroup({
    controller: deleteController,
    operations,
  });
  return retained.length === 0
    ? { type: "deleted", keys: objectKeys }
    : { type: "shared-object-retained", deletedKeys: objectKeys, retained };
};
