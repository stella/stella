import type { CorpusPayload } from "@/api/handlers/case-law/corpus-storage";
import {
  namesEmptyCorpusPayload,
  payloadCarriesDocument,
} from "@/api/handlers/case-law/stored-payload";
import type { CorpusStorageMode } from "@/api/lib/corpus-storage-mode";

/**
 * Decision logic for the corpus column trim (`corpus-column-trim.ts`),
 * kept apart from the runnable script so it can be exercised without a
 * database or a corpus bucket.
 */

/** How a single corpus object stands relative to the row that names it. */
export const CORPUS_OBJECT_STATES = [
  /** Present, and holding what the row's column holds. */
  "verified",
  /** The row records no key, so nothing proves the payload was ever written. */
  "key-missing",
  /** The row records a key but the bucket has no object under it. */
  "object-missing",
  /** Present, and holding something other than what the column holds. */
  "content-mismatch",
] as const;

export type CorpusObjectState = (typeof CORPUS_OBJECT_STATES)[number];

type CorpusObjectStateInput = {
  key: string | null;
  /** Result of the bucket lookup; ignored when `key` is null. */
  exists: boolean;
  /**
   * Whether the object holds what the column holds, or "not-checked"
   * where the column holds nothing worth proving — the only case
   * presence alone settles. Spelled out rather than optional so an
   * omitted comparison cannot silently pass a destructive gate.
   */
  matchesColumn: boolean | "not-checked";
};

export const corpusObjectState = ({
  key,
  exists,
  matchesColumn,
}: CorpusObjectStateInput): CorpusObjectState => {
  if (key === null) {
    return "key-missing";
  }
  if (!exists) {
    return "object-missing";
  }
  return matchesColumn === true || matchesColumn === "not-checked"
    ? "verified"
    : "content-mismatch";
};

export type ColumnTrimDecision =
  | { type: "trim" }
  | { type: "skip"; reason: string };

type ColumnTrimInput = {
  text: CorpusObjectState;
  sections: CorpusObjectState;
  ast: CorpusObjectState;
  /** What the Postgres columns hold, which is what the trim deletes. */
  columnPayload: CorpusPayload;
  /** The row's stored corpus content hash, for the empty-constant test. */
  contentHash: string | null;
};

/**
 * Nulling the Postgres columns destroys the only other copy, so every
 * object the trim relies on must be proven present first — sections
 * included, since `sections` is nulled alongside `fulltext` and
 * `document_ast`. `writeCorpusDocument` always writes all three objects
 * (a null payload is stored as the JSON literal `null`), so a row backed
 * by object storage carries all three keys; a missing one means the row
 * was never written by the corpus writer. Keys are content-addressed,
 * which makes an existence check a sufficient verification.
 *
 * Present is not the same as holding this row's document. A
 * metadata-first ingest writes all three objects before the document
 * exists, so a row can pass every existence check while object storage
 * holds nothing; and the shapes it writes are not all constants — a
 * DocumentAst envelope with no blocks carries the decision's own
 * metadata, so no fixed hash can name it. Enumerating the empty shapes
 * therefore cannot close this: what the trim needs is the positive
 * proof, that object storage holds exactly what it is about to delete.
 *
 * That proof is the objects' own content, compared against the columns.
 * The row's content hash cannot stand in for it: the hash was taken of
 * the payload as written, and the columns come back through jsonb,
 * which normalises key order — re-hashing a read never reproduces the
 * hash of the write. Comparing the decompressed objects is the same
 * question asked where it can be answered, and it fails every way of
 * holding nothing and every way of holding some other version alike.
 * A mismatch leaves the row to the repair pass
 * (`backfill-corpus-storage.ts --include-stale-empty`).
 *
 * Columns that hold no document are exempt from the content check:
 * there is nothing to lose, so presence is all they need.
 */
export const planColumnTrim = ({
  text,
  sections,
  ast,
  columnPayload,
  contentHash,
}: ColumnTrimInput): ColumnTrimDecision => {
  // A row that holds no document anywhere must keep its columns: the
  // fetch queue recognises a verbatim empty copy by the surviving
  // Postgres AST artifact, so trimming it would strand the row —
  // unreadable, yet excluded from fetching. Pure-constant empties are
  // exempt (the queue admits their hashes directly).
  if (
    !payloadCarriesDocument(columnPayload) &&
    !namesEmptyCorpusPayload(contentHash)
  ) {
    return {
      type: "skip",
      reason:
        "columns hold no document and the corpus hash is row-specific; " +
        "trimming would strand the row for the fetch queue",
    };
  }
  const states = { text, sections, ast };
  const unusable = Object.entries(states).filter(([, state]) =>
    payloadCarriesDocument(columnPayload)
      ? state !== "verified"
      : state === "key-missing" || state === "object-missing",
  );

  if (unusable.length === 0) {
    return { type: "trim" };
  }

  const detail = `text=${text} sections=${sections} ast=${ast}`;
  return {
    type: "skip",
    reason: unusable.some(([, state]) => state === "content-mismatch")
      ? `object storage does not hold what the columns hold (${detail}); ` +
        "empty copies are repaired by backfill-corpus-storage " +
        "--include-stale-empty, version skew by the next ingest refresh " +
        "of the row (the mirror rewrites the objects); re-run the trim after"
      : detail,
  };
};

export type ColumnTrimGate =
  | { type: "allowed" }
  | { type: "refused"; reason: string };

type ColumnTrimGateInput = {
  mode: CorpusStorageMode;
  force: boolean;
};

/**
 * Outside `canonical` mode the Postgres columns are still what reads fall
 * back to, so trimming them would silently empty documents.
 */
export const columnTrimGate = ({
  mode,
  force,
}: ColumnTrimGateInput): ColumnTrimGate => {
  if (mode === "canonical" || force) {
    return { type: "allowed" };
  }
  return {
    type: "refused",
    reason:
      `CORPUS_STORAGE_MODE is "${mode}": reads still fall back to the Postgres ` +
      "columns, so trimming them would drop the served payload. Pass --force to override.",
  };
};

export type ColumnTrimArgs = {
  /** null = no cap; process every candidate row. */
  limit: number | null;
  dryRun: boolean;
  force: boolean;
};

export type ParsedColumnTrimArgs =
  | { type: "parsed"; args: ColumnTrimArgs }
  | { type: "invalid"; message: string };

const parseLimit = (raw: string | undefined): number | null => {
  if (raw === undefined || !/^\d+$/u.test(raw)) {
    return null;
  }
  const parsed = Number(raw);
  return parsed > 0 ? parsed : null;
};

export const parseColumnTrimArgs = (
  argv: readonly string[],
): ParsedColumnTrimArgs => {
  let limit: number | null = null;
  let dryRun = false;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === undefined) {
      continue;
    }
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--force") {
      force = true;
      continue;
    }
    if (argument === "--limit" || argument.startsWith("--limit=")) {
      const raw = argument.startsWith("--limit=")
        ? argument.slice("--limit=".length)
        : argv[++i];
      const parsed = parseLimit(raw);
      if (parsed === null) {
        return {
          type: "invalid",
          message: "--limit requires a positive integer",
        };
      }
      limit = parsed;
      continue;
    }
    return { type: "invalid", message: `Unknown argument: ${argument}` };
  }

  return { type: "parsed", args: { limit, dryRun, force } };
};
