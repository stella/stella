import { Result } from "better-result";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
import type { EmptyAst } from "@/api/handlers/case-law/ingestion/adapter";
import type { DecisionSection } from "@/api/handlers/case-law/types";
import { captureError } from "@/api/lib/analytics/capture";
import { zstdCompress, zstdDecompressToString } from "@/api/lib/compression";
import { CorpusPayloadUnavailableError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { getCorpusS3 } from "@/api/lib/s3";
import { withTimeout } from "@/api/lib/with-timeout";

/**
 * Canonical corpus payloads (text, sections, AST) live in object
 * storage, not Postgres. Keys are content-addressed under a
 * jurisdiction partition so a re-parse produces a new immutable object
 * and the row's key columns point at the current version. Payloads are
 * zstd-compressed JSON.
 */

const CONTENT_TYPE = "application/zstd";

const CORPUS_IO_TIMEOUT_MS = LIMITS.corpusObjectIoTimeoutMs;

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
  operation: () => Promise<T>,
  timeoutMs: number = CORPUS_IO_TIMEOUT_MS,
): Promise<T> => await withTimeout(operation, { label, timeoutMs });

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
};

export type WriteCorpusResult = CorpusKeys & { contentHash: string };

export const writeCorpusDocument = async ({
  documentId,
  jurisdiction,
  text,
  sections,
  ast,
}: WriteCorpusInput): Promise<WriteCorpusResult> => {
  const contentHash = corpusContentHash({ text, sections, ast });
  const keys = corpusKeys({ documentId, jurisdiction, contentHash });
  const s3 = getCorpusS3();

  await Promise.all([
    boundedCorpusIo(
      "corpus-write-text",
      async () =>
        await s3.write(keys.textKey, zstdCompress(text ?? ""), {
          type: CONTENT_TYPE,
        }),
    ),
    boundedCorpusIo(
      "corpus-write-sections",
      async () =>
        await s3.write(
          keys.sectionsKey,
          zstdCompress(JSON.stringify(sections ?? null)),
          { type: CONTENT_TYPE },
        ),
    ),
    boundedCorpusIo(
      "corpus-write-ast",
      async () =>
        await s3.write(keys.astKey, zstdCompress(JSON.stringify(ast ?? null)), {
          type: CONTENT_TYPE,
        }),
    ),
  ]);

  return { ...keys, contentHash };
};

type ReadCorpusTextOptions = {
  /**
   * Override the bounded corpus GET. Defaults to the corpus bucket read; a
   * caller (or a test proving the ceiling fires) can supply a different byte
   * source without bypassing the wall-clock bound.
   */
  read?: () => Promise<Uint8Array>;
  timeoutMs?: number;
};

export const readCorpusText = async (
  key: string,
  { read, timeoutMs = CORPUS_IO_TIMEOUT_MS }: ReadCorpusTextOptions = {},
): Promise<string> => {
  const bytes = await boundedCorpusIo(
    "corpus-read-text",
    read ?? (async () => await getCorpusS3().file(key).bytes()),
    timeoutMs,
  );
  return zstdDecompressToString(bytes);
};

export const readCorpusSections = async (
  key: string,
): Promise<DecisionSection[] | null> => {
  const bytes = await boundedCorpusIo(
    "corpus-read-sections",
    async () => await getCorpusS3().file(key).bytes(),
  );
  // eslint-disable-next-line typescript/no-unsafe-assignment -- decompressed corpus JSON written by this module
  const parsed: DecisionSection[] | null = JSON.parse(
    zstdDecompressToString(bytes),
  );
  return parsed;
};

export const readCorpusAst = async (
  key: string,
): Promise<DocumentAst | EmptyAst | null> => {
  const bytes = await boundedCorpusIo(
    "corpus-read-ast",
    async () => await getCorpusS3().file(key).bytes(),
  );
  // eslint-disable-next-line typescript/no-unsafe-assignment -- decompressed corpus JSON written by this module
  const parsed: DocumentAst | EmptyAst | null = JSON.parse(
    zstdDecompressToString(bytes),
  );
  return parsed;
};

type CorpusReadWithFallbackInput<T> = {
  documentId: string;
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

/**
 * Delete all corpus objects for a decision version (GDPR erasure).
 * Keys are individually nullable: a partially ingested decision may have
 * only some payloads written, and every present object must still go.
 */
export const deleteCorpusDocument = async (keys: {
  textKey: string | null;
  sectionsKey: string | null;
  astKey: string | null;
}): Promise<void> => {
  const s3 = getCorpusS3();
  const present = [keys.textKey, keys.sectionsKey, keys.astKey].filter(
    (key): key is string => key !== null,
  );
  await Promise.all(
    present.map(
      async (key) =>
        await boundedCorpusIo(
          "corpus-delete",
          async () => await s3.delete(key),
        ),
    ),
  );
};
