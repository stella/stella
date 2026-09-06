import { panic } from "better-result";
import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";

/**
 * Column trim: drop the Postgres `fulltext` / `sections` / `document_ast`
 * columns for decisions whose canonical payload already lives in object
 * storage, and remove their pg-fts projection (a canonical row is served
 * by the corpus index, so the tsvector row is dead weight).
 *
 * A row is only trimmed once object storage is proven to hold exactly
 * what is about to be deleted: every object is read back, decompressed
 * and compared against the column it stands in for. That costs the scan
 * both payloads — the columns from Postgres and the objects from the
 * bucket — which is the right trade for a one-off pass whose mistakes
 * are unrecoverable. Batches stay small and keyset-paginated for it.
 * Rows whose columns hold no document skip the comparison: presence is
 * all they need, because there is nothing to lose. The update is
 * compare-and-set against the row state it read, so the run is
 * idempotent and safe to repeat.
 *
 * This is a repair pass over rows written before the write paths settled
 * on the canonical shape, not a standing cleanup: under `canonical` every
 * write that confirms its corpus objects now settles with the columns
 * already empty (`corpusPayloadDisposition`).
 *
 *   CORPUS_STORAGE_MODE=canonical LEGAL_CORPUS_S3_BUCKET=... \
 *     bun run src/scripts/corpus-column-trim.ts \
 *       [--limit N] [--dry-run] [--force] \
 *       [--after ID | --id-from ID] [--id-to ID] [--ranges-file PATH]
 *
 * The candidate predicate is not indexable, so an unbounded walk scans
 * forward until it has collected a page; over an already-trimmed stretch
 * of the id space that scan grows past the statement timeout, and it
 * cannot be resumed past it. `--id-to` caps every scan at an id range the
 * operator chose. `--ranges-file` takes a JSON array of sorted, disjoint
 * `[{ "from": ID, "to": ID }, ...]` spans and walks them in order, which
 * is how a keyspace whose candidates share no ordering with time gets
 * covered: by a list of spans, not by one cursor.
 */
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { caseLawDecisions, caseLawSearchDocuments } from "@/api/db/schema";
import { corpusStorageMode } from "@/api/env-base";
import { payloadCarriesDocument } from "@/api/handlers/case-law/stored-payload";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import {
  enterCaseLawMaintenanceLane,
  openCaseLawReadOnlySession,
} from "@/api/lib/case-law/maintenance-lane";
import {
  timestampCasToken,
  type TimestampCasToken,
  timestampMatchesCasToken,
} from "@/api/lib/db/timestamp-cas";
import {
  readCorpusAst,
  readCorpusSections,
  readCorpusText,
  TRIMMED_CORPUS_PAYLOAD_COLUMNS,
} from "@/api/lib/legal-search/corpus-storage";
import type {
  DecisionSection,
  EmptyAst,
} from "@/api/lib/legal-search/document-types";
import { LIMITS } from "@/api/lib/limits";
import { getCorpusS3, refreshCorpusS3, refreshS3 } from "@/api/lib/s3";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";
import { withTimeout } from "@/api/lib/with-timeout";
import type {
  ColumnTrimRange,
  CorpusObjectState,
} from "@/api/scripts/corpus-column-trim-plan";
import {
  columnTrimGate,
  columnTrimPageRange,
  columnTrimRanges,
  corpusObjectState,
  parseColumnTrimArgs,
  parseColumnTrimRanges,
  planColumnTrim,
} from "@/api/scripts/corpus-column-trim-plan";

const BATCH_SIZE = 50;
const CONCURRENCY = 4;

type TrimRow = {
  id: SafeId<"caseLawDecision">;
  textS3Key: string | null;
  normalizedS3Key: string | null;
  astS3Key: string | null;
  contentHash: string | null;
  /** The payload this run would delete, which it has to hash first. */
  fulltext: string | null;
  sections: DecisionSection[] | null;
  documentAst: DocumentAst | EmptyAst | null;
  updatedAtToken: TimestampCasToken;
};

const parsed = parseColumnTrimArgs(Bun.argv.slice(2));
if (parsed.type === "invalid") {
  console.error(parsed.message);
  process.exit(2);
}
const { limit, rangesFile, dryRun, force } = parsed.args;

// Everything the run needs is settled before it opens a connection: a
// ranges file that turns out to be malformed halfway through a sweep would
// leave the operator with a partial pass and no statement of what it
// covered.
const fileRanges = await (async () => {
  if (rangesFile === null) {
    return null;
  }
  const file = Bun.file(rangesFile);
  if (!(await file.exists())) {
    console.error(`--ranges-file not found: ${rangesFile}`);
    process.exit(2);
  }
  const parsedRanges = parseColumnTrimRanges(await file.text());
  if (parsedRanges.type === "invalid") {
    console.error(parsedRanges.message);
    process.exit(2);
  }
  return parsedRanges.ranges;
})();

const ranges = columnTrimRanges({ args: parsed.args, fileRanges });

const gate = columnTrimGate({ mode: corpusStorageMode, force });
if (gate.type === "refused") {
  console.error(gate.reason);
  process.exit(2);
}

// A dry run only reads, so it takes no lane and cannot block a writer; the
// read-only session makes that a property of the connection, not a promise.
const { ingestionDb } = dryRun
  ? await openCaseLawReadOnlySession()
  : await enterCaseLawMaintenanceLane();

await refreshS3();
await refreshCorpusS3();

const runLabel = [
  dryRun ? "dry run" : "live",
  limit === null ? "no limit" : `limit=${limit}`,
  `ranges=${ranges.length}`,
].join(", ");

console.log(`=== CORPUS COLUMN TRIM (${runLabel}) ===`);

let trimmed = 0;
let skipped = 0;
let failed = 0;
/** Rows whose first attempt threw; re-attempted by id before the summary. */
const failedIds: SafeId<"caseLawDecision">[] = [];

const TRIM_ROW_COLUMNS = {
  id: caseLawDecisions.id,
  textS3Key: caseLawDecisions.textS3Key,
  normalizedS3Key: caseLawDecisions.normalizedS3Key,
  astS3Key: caseLawDecisions.astS3Key,
  contentHash: caseLawDecisions.contentHash,
  fulltext: caseLawDecisions.fulltext,
  sections: caseLawDecisions.sections,
  documentAst: caseLawDecisions.documentAst,
};
let scanned = 0;

// Rows whose payload is in object storage but whose Postgres columns are
// still populated. `contentHash` must be present too: it is the CAS token
// the update below compares against.
const candidateFilter = and(
  isNotNull(caseLawDecisions.textS3Key),
  isNotNull(caseLawDecisions.contentHash),
  or(
    isNotNull(caseLawDecisions.fulltext),
    isNotNull(caseLawDecisions.sections),
    isNotNull(caseLawDecisions.documentAst),
  ),
);

const corpusObjectExists = async (key: string): Promise<boolean> =>
  await withTimeout(async () => await getCorpusS3().file(key).exists(), {
    label: "corpus-column-trim-exists",
    timeoutMs: LIMITS.corpusObjectIoTimeoutMs,
  });

type ObjectCheck = {
  key: string | null;
  /**
   * Reads the object and answers whether it holds what the column
   * holds. Not called where the column holds no document.
   */
  matchesColumn: () => Promise<boolean>;
};

const checkObject = async (
  { key, matchesColumn }: ObjectCheck,
  compareContent: boolean,
): Promise<CorpusObjectState> => {
  if (key === null) {
    return corpusObjectState({
      key,
      exists: false,
      matchesColumn: "not-checked",
    });
  }
  const exists = await corpusObjectExists(key);
  if (!exists || !compareContent) {
    return corpusObjectState({ key, exists, matchesColumn: "not-checked" });
  }
  return corpusObjectState({
    key,
    exists,
    matchesColumn: await matchesColumn(),
  });
};

const trimRow = async (row: TrimRow): Promise<void> => {
  try {
    const columnPayload = {
      text: row.fulltext,
      sections: row.sections,
      ast: row.documentAst,
    };
    // Every object whose column this run nulls has to be checked,
    // sections included: `writeCorpusDocument` writes a sections object
    // for every payload it stores, so its absence means the row is not
    // actually backed by object storage. Where the columns hold a document,
    // presence is not
    // enough and the object's content is compared with the column's;
    // `Bun.deepEquals` rather than a serialization, because the columns
    // come back through jsonb with their keys reordered.
    const compareContent = payloadCarriesDocument(columnPayload);
    const [text, sections, ast] = await Promise.all([
      checkObject(
        {
          key: row.textS3Key,
          matchesColumn: async () =>
            row.textS3Key !== null &&
            (await readCorpusText(row.textS3Key)) === (row.fulltext ?? ""),
        },
        compareContent,
      ),
      checkObject(
        {
          key: row.normalizedS3Key,
          matchesColumn: async () =>
            row.normalizedS3Key !== null &&
            Bun.deepEquals(
              await readCorpusSections(row.normalizedS3Key),
              row.sections ?? null,
            ),
        },
        compareContent,
      ),
      checkObject(
        {
          key: row.astS3Key,
          matchesColumn: async () =>
            row.astS3Key !== null &&
            Bun.deepEquals(
              await readCorpusAst(row.astS3Key),
              row.documentAst ?? null,
            ),
        },
        compareContent,
      ),
    ]);

    const decision = planColumnTrim({
      text,
      sections,
      ast,
      columnPayload,
      contentHash: row.contentHash,
    });

    if (decision.type === "skip") {
      skipped += 1;
      console.log(`  skip ${row.id}: ${decision.reason}`);
      return;
    }

    if (dryRun) {
      trimmed += 1;
      return;
    }

    const applied = await ingestionDb(async (tx) => {
      const updated = await tx
        .update(caseLawDecisions)
        .set(TRIMMED_CORPUS_PAYLOAD_COLUMNS)
        // Compare-and-set on the row state this scan read: a concurrent
        // ingestion refresh may have replaced the payload, in which case
        // the columns it just wrote are canonical and must survive.
        .where(
          and(
            eq(caseLawDecisions.id, row.id),
            sql`${caseLawDecisions.contentHash} IS NOT DISTINCT FROM ${row.contentHash}`,
            timestampMatchesCasToken(
              caseLawDecisions.updatedAt,
              row.updatedAtToken,
            ),
          ),
        )
        .returning({ id: caseLawDecisions.id });

      if (updated.length === 0) {
        return false;
      }

      // The tsvector projection only serves pg-fts, which cannot rank a
      // row whose text columns are gone.
      await tx
        .delete(caseLawSearchDocuments)
        .where(eq(caseLawSearchDocuments.decisionId, row.id));

      return true;
    });

    if (applied) {
      trimmed += 1;
      return;
    }

    skipped += 1;
    console.log(`  skip ${row.id}: row changed under the scan`);
  } catch (error) {
    failed += 1;
    failedIds.push(row.id);
    captureError(error, { decisionId: row.id, step: "corpusColumnTrim" });
  }
};

const trimInChunks = async (rows: TrimRow[]): Promise<void> => {
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- bounded concurrency: drain one CONCURRENCY-sized chunk before starting the next
    await Promise.all(rows.slice(i, i + CONCURRENCY).map(trimRow));
  }
};

/**
 * The id predicate for one page. The lower bound is inclusive only for a
 * range's own start — an operator naming an id means to include it —
 * and exclusive for every resumed cursor, whose row is already done.
 */
const rangeFilter = ({ lower, upper }: ColumnTrimRange): SQL | undefined => {
  const lowerFilter = ((): SQL | undefined => {
    switch (lower.type) {
      case "unbounded":
        return undefined;
      case "at-or-after":
        return gte(
          caseLawDecisions.id,
          brandPersistedCaseLawDecisionId(lower.id),
        );
      case "after":
        return gt(
          caseLawDecisions.id,
          brandPersistedCaseLawDecisionId(lower.id),
        );
      default: {
        lower satisfies never;
        return panic(`Unhandled column trim lower bound: ${String(lower)}`);
      }
    }
  })();
  return and(
    lowerFilter,
    upper === null
      ? undefined
      : lte(caseLawDecisions.id, brandPersistedCaseLawDecisionId(upper)),
  );
};

const rangeLabel = ({ lower, upper }: ColumnTrimRange): string =>
  `from=${lower.type === "unbounded" ? "start" : lower.id} to=${upper ?? "end"}`;

/**
 * Why a range's walk stopped. A range that ran out of candidates is
 * covered; one the scan cap cut short is not, and the two must not print
 * the same word: an operator reading `done` takes the span as repaired and
 * moves on, and the ranges behind it were never queried at all.
 */
const RANGE_OUTCOMES = ["exhausted", "capped"] as const;
type RangeOutcome = (typeof RANGE_OUTCOMES)[number];

/** Ranges the scan cap stopped the sweep before reaching. */
let unwalkedRanges = 0;
let sweepOutcome: RangeOutcome = "exhausted";

for (const [index, range] of ranges.entries()) {
  const position = `range=${index + 1}/${ranges.length}`;
  const rangeStart = { trimmed, skipped, failed };
  // The cursor rides on every progress line, so a supervisor that lost a
  // run can resume this range from the last id it saw.
  let lastId: SafeId<"caseLawDecision"> | null = null;
  let outcome: RangeOutcome = "exhausted";

  while (true) {
    const remaining = limit === null ? BATCH_SIZE : limit - scanned;
    if (remaining <= 0) {
      outcome = "capped";
      break;
    }

    const idFilter = rangeFilter(
      columnTrimPageRange({ range, cursor: lastId }),
    );

    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- keyset page per iteration; the page is the batch
    const rows: TrimRow[] = await ingestionDb((tx) =>
      tx
        .select({
          ...TRIM_ROW_COLUMNS,
          updatedAtToken: timestampCasToken(caseLawDecisions.updatedAt),
        })
        .from(caseLawDecisions)
        .where(idFilter ? and(candidateFilter, idFilter) : candidateFilter)
        .orderBy(asc(caseLawDecisions.id))
        .limit(Math.min(BATCH_SIZE, remaining)),
    );

    if (rows.length === 0) {
      break;
    }

    await trimInChunks(rows);

    scanned += rows.length;
    lastId = rows.at(-1)?.id ?? lastId;
    console.log(
      `  ${position} trimmed=${trimmed} skipped=${skipped} failed=${failed} cursor=${lastId}`,
    );
  }

  console.log(
    `  ${position} ${outcome === "exhausted" ? "done" : "capped"} ${rangeLabel(range)} trimmed=${trimmed - rangeStart.trimmed} skipped=${skipped - rangeStart.skipped} failed=${failed - rangeStart.failed} cursor=${lastId ?? "none"}`,
  );

  if (outcome === "capped") {
    // Walking on would print `done` against ranges this run never queried.
    sweepOutcome = "capped";
    unwalkedRanges = ranges.length - index - 1;
    break;
  }
}

// A failed row sits behind the published cursor, so a supervisor resuming
// from a progress line would never revisit it, and a later clean run would
// mask it. Re-attempt each one by id — indexed lookups, no prefix scan —
// so a transient failure heals inside the run; only rows failing twice
// reach the summary, printed with ids an operator can act on directly.
if (failedIds.length > 0) {
  console.log(`retrying ${failedIds.length} failed row(s) by id`);
  const retryIds = [...failedIds];
  failedIds.length = 0;
  failed = 0;
  const retryRows: TrimRow[] = await ingestionDb((tx) =>
    tx
      .select({
        ...TRIM_ROW_COLUMNS,
        updatedAtToken: timestampCasToken(caseLawDecisions.updatedAt),
      })
      .from(caseLawDecisions)
      .where(and(candidateFilter, inArray(caseLawDecisions.id, retryIds))),
  );
  await trimInChunks(retryRows);
  for (const id of failedIds) {
    console.log(`failed-row=${id}`);
  }
}

// The scan cap is an operator's choice, not a failure, but the summary has
// to say the sweep is partial: "Done" against an unfinished range list is
// the one line most likely to be read on its own.
console.log(
  sweepOutcome === "exhausted"
    ? `Done. Trimmed ${trimmed} decisions, skipped ${skipped}, ${failed} failed.`
    : `Stopped at --limit. Trimmed ${trimmed} decisions, skipped ${skipped}, ${failed} failed; ${unwalkedRanges} range(s) not walked. Re-run to continue.`,
);

// Non-zero on partial failure so a caller can tell an incomplete pass from
// a clean one; re-running picks up whatever was left behind.
process.exit(failed === 0 ? 0 : 1);
