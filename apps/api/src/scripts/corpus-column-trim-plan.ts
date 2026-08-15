import * as v from "valibot";

import {
  namesEmptyCorpusPayload,
  payloadCarriesDocument,
} from "@/api/handlers/case-law/stored-payload";
import type { CorpusStorageMode } from "@/api/lib/corpus-storage-mode";
import type { CorpusPayload } from "@/api/lib/legal-search/corpus-storage";

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
  /**
   * Resume the keyset walk strictly after this decision id. A restart
   * without it re-skips every already-trimmed row from the start of the
   * id space, and once enough rows are trimmed that scan no longer fits a
   * statement timeout: the run dies on its first page forever.
   */
  after: string | null;
  /** Inclusive lower bound of a single bounded walk. */
  idFrom: string | null;
  /** Inclusive upper bound of every walk this run makes. */
  idTo: string | null;
  /** Path to a JSON array of `{ from, to }` ranges to walk in order. */
  rangesFile: string | null;
  dryRun: boolean;
  force: boolean;
};

/**
 * Where a range's walk starts. `at-or-after` is the range's own lower
 * bound, which is inclusive because an operator naming a range means to
 * include the row they named; `after` is a resumed cursor, which is
 * exclusive because that row has already been processed.
 */
export type ColumnTrimLowerBound =
  | { type: "unbounded" }
  | { type: "at-or-after"; id: string }
  | { type: "after"; id: string };

/**
 * One id range a sweep walks.
 *
 * The candidate predicate cannot be satisfied from an index alone, so an
 * unbounded walk scans forward from its cursor until it has collected a
 * page — across an already-trimmed stretch of the id space that is an
 * arbitrarily long scan, and it stops fitting a statement timeout. An
 * upper bound caps the scan at a span the operator chose, whatever the
 * density of candidates inside it, which is also what makes a keyspace
 * whose candidates are scattered (no shared time ordering to walk)
 * tractable: it is covered by a list of spans rather than one cursor.
 */
export type ColumnTrimRange = {
  lower: ColumnTrimLowerBound;
  /** Inclusive; null walks to the end of the id space. */
  upper: string | null;
};

/** A `--ranges-file` entry: an inclusive `[from, to]` id span. */
export type ColumnTrimRangeSpec = { from: string; to: string };

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const isDecisionId = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);

/** Flags whose value is a single decision id. */
const ID_FLAGS: ReadonlySet<string> = new Set([
  "--after",
  "--id-from",
  "--id-to",
]);

/**
 * `--flag=value` and `--flag value` are the same input. Splitting the
 * inline form once keeps every flag below reading its value the same way,
 * rather than each one re-deriving it.
 */
const splitInlineValues = (argv: readonly string[]): string[] =>
  argv.flatMap((argument) => {
    const separator = argument.indexOf("=");
    return argument.startsWith("--") && separator !== -1
      ? [argument.slice(0, separator), argument.slice(separator + 1)]
      : [argument];
  });

/**
 * Bounds that name two lower bounds, or an empty span, are a mistake the
 * run cannot recover from: it would silently walk something other than
 * what was asked for. Rejected here, before anything opens a connection.
 */
const columnTrimArgConflict = ({
  after,
  idFrom,
  idTo,
  rangesFile,
}: ColumnTrimArgs): string | null => {
  if (
    rangesFile !== null &&
    (after !== null || idFrom !== null || idTo !== null)
  ) {
    return "--ranges-file carries its own bounds; drop --after/--id-from/--id-to";
  }
  if (after !== null && idFrom !== null) {
    return "--after and --id-from are both lower bounds; pass one";
  }
  // The two lower bounds compare differently because they mean different
  // things: `--after` is exclusive, so an id equal to `--id-to` spans
  // nothing, while `--id-from` is inclusive, so `--id-from X --id-to X` is
  // the single-row repair a ranges file spells `{ "from": X, "to": X }`.
  if (after !== null && idTo !== null && after >= idTo) {
    return "--after is at or above --id-to, so the range is empty";
  }
  if (idFrom !== null && idTo !== null && idFrom > idTo) {
    return "--id-from is above --id-to, so the range is empty";
  }
  return null;
};

export const parseColumnTrimArgs = (
  rawArgv: readonly string[],
): ParsedColumnTrimArgs => {
  const argv = splitInlineValues(rawArgv);
  let limit: number | null = null;
  let after: string | null = null;
  let idFrom: string | null = null;
  let idTo: string | null = null;
  let rangesFile: string | null = null;
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
    // Every remaining flag takes a value, and none of them takes one that
    // begins with `--`. Swallowing the next option token as a value would
    // change what the run does without saying so: `--ranges-file
    // --dry-run` would consume the dry run and leave a mutating pass. Read
    // the value once, here, so a flag added later cannot miss the check.
    const next = argv[++i];
    const value = next?.startsWith("--") === true ? undefined : next;
    if (argument === "--limit") {
      const parsed = parseLimit(value);
      if (parsed === null) {
        return {
          type: "invalid",
          message: "--limit requires a positive integer",
        };
      }
      limit = parsed;
      continue;
    }
    if (argument === "--ranges-file") {
      if (value === undefined || value === "") {
        return { type: "invalid", message: "--ranges-file requires a path" };
      }
      rangesFile = value;
      continue;
    }
    if (ID_FLAGS.has(argument)) {
      if (!isDecisionId(value)) {
        return {
          type: "invalid",
          message: `${argument} requires a decision id (UUID)`,
        };
      }
      switch (argument) {
        case "--id-from":
          idFrom = value;
          break;
        case "--id-to":
          idTo = value;
          break;
        default:
          after = value;
      }
      continue;
    }
    return { type: "invalid", message: `Unknown argument: ${argument}` };
  }

  const args = { limit, after, idFrom, idTo, rangesFile, dryRun, force };
  const conflict = columnTrimArgConflict(args);
  return conflict === null
    ? { type: "parsed", args }
    : { type: "invalid", message: conflict };
};

export type ParsedColumnTrimRanges =
  | { type: "parsed"; ranges: ColumnTrimRangeSpec[] }
  | { type: "invalid"; message: string };

const decisionIdSchema = v.pipe(
  v.string("must be a decision id (UUID)"),
  v.regex(UUID, "must be a lowercase decision id (UUID)"),
);

/**
 * Strict, so a key the run does not read cannot look like it was honoured:
 * an operator who writes a per-range `"limit"` should be told it does
 * nothing rather than watch the sweep ignore it.
 */
const columnTrimRangesSchema = v.pipe(
  v.array(
    v.strictObject({ from: decisionIdSchema, to: decisionIdSchema }),
    "must be an array of ranges",
  ),
  v.minLength(1, "must name at least one range"),
);

/**
 * Read the `--ranges-file` payload.
 *
 * Ranges must be sorted and disjoint. Overlapping ranges would trim the
 * same rows twice — harmless, but the run's counts would then mean
 * nothing — and unsorted ranges usually mean the file was assembled from
 * two sources, in which case its coverage is not what the operator
 * believes. Both are refused rather than normalised, so the file the
 * operator reads is the file the run walked.
 *
 * Ids compare as text: the canonical lowercase form has its separators at
 * fixed positions and its digits in ASCII order, so text ordering is the
 * ordering Postgres gives the `uuid` column.
 */
export const parseColumnTrimRanges = (raw: string): ParsedColumnTrimRanges => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    // A boundary parse, not control flow: the file is operator input and
    // JSON.parse has no non-throwing form.
    return { type: "invalid", message: "--ranges-file must contain JSON" };
  }

  const shape = v.safeParse(columnTrimRangesSchema, decoded);
  if (!shape.success) {
    return {
      type: "invalid",
      message: `--ranges-file must be a non-empty array of { "from": ID, "to": ID }: ${shape.issues[0].message}`,
    };
  }

  const ranges: ColumnTrimRangeSpec[] = [];
  for (const [index, { from, to }] of shape.output.entries()) {
    if (from > to) {
      return {
        type: "invalid",
        message: `--ranges-file[${index}] has "from" above "to"`,
      };
    }
    const previous = ranges.at(-1);
    if (previous !== undefined && previous.to >= from) {
      return {
        type: "invalid",
        message: `--ranges-file[${index}] overlaps or precedes its predecessor; ranges must be sorted and disjoint`,
      };
    }
    ranges.push({ from, to });
  }

  return { type: "parsed", ranges };
};

type ColumnTrimRangesOptions = {
  args: ColumnTrimArgs;
  /** Parsed `--ranges-file` content, or null where the flag was absent. */
  fileRanges: readonly ColumnTrimRangeSpec[] | null;
};

/** The ranges one run walks, in order. */
export const columnTrimRanges = ({
  args: { after, idFrom, idTo },
  fileRanges,
}: ColumnTrimRangesOptions): ColumnTrimRange[] => {
  if (fileRanges !== null) {
    return fileRanges.map(({ from, to }) => ({
      lower: { type: "at-or-after", id: from },
      upper: to,
    }));
  }
  if (after !== null) {
    return [{ lower: { type: "after", id: after }, upper: idTo }];
  }
  return [
    {
      lower:
        idFrom === null
          ? { type: "unbounded" }
          : { type: "at-or-after", id: idFrom },
      upper: idTo,
    },
  ];
};

type ColumnTrimPageRangeOptions = {
  range: ColumnTrimRange;
  /** Last id this range's walk consumed, or null before its first page. */
  cursor: string | null;
};

/**
 * The range the next page queries: the range itself until a row has been
 * read, then strictly after the last id the previous page consumed. The
 * upper bound rides along, so every page of a bounded range stays bounded.
 */
export const columnTrimPageRange = ({
  range,
  cursor,
}: ColumnTrimPageRangeOptions): ColumnTrimRange =>
  cursor === null
    ? range
    : { lower: { type: "after", id: cursor }, upper: range.upper };
