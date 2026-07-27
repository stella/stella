import type { CorpusStorageMode } from "@/api/lib/corpus-storage-mode";

/**
 * Decision logic for the corpus column trim (`corpus-column-trim.ts`),
 * kept apart from the runnable script so it can be exercised without a
 * database or a corpus bucket.
 */

/** How a single corpus object stands relative to the row that names it. */
export const CORPUS_OBJECT_STATES = [
  /** The row records a key and the object is present in the bucket. */
  "verified",
  /** The row records no key, so nothing proves the payload was ever written. */
  "key-missing",
  /** The row records a key but the bucket has no object under it. */
  "object-missing",
] as const;

export type CorpusObjectState = (typeof CORPUS_OBJECT_STATES)[number];

type CorpusObjectStateInput = {
  key: string | null;
  /** Result of the bucket existence check; ignored when `key` is null. */
  exists: boolean;
};

export const corpusObjectState = ({
  key,
  exists,
}: CorpusObjectStateInput): CorpusObjectState => {
  if (key === null) {
    return "key-missing";
  }
  return exists ? "verified" : "object-missing";
};

export type ColumnTrimDecision =
  | { type: "trim" }
  | { type: "skip"; reason: string };

type ColumnTrimInput = {
  text: CorpusObjectState;
  sections: CorpusObjectState;
  ast: CorpusObjectState;
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
 */
export const planColumnTrim = ({
  text,
  sections,
  ast,
}: ColumnTrimInput): ColumnTrimDecision => {
  if (text === "verified" && sections === "verified" && ast === "verified") {
    return { type: "trim" };
  }
  return {
    type: "skip",
    reason: `text=${text} sections=${sections} ast=${ast}`,
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
