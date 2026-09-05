import { panic } from "better-result";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { caseLawDecisions, legislationDocuments } from "@/api/db/schema";
import {
  BACKFILL_STATUS,
  backfillCorpusIndex,
} from "@/api/handlers/case-law/corpus-index";
import { backfillLegislationCorpusIndex } from "@/api/handlers/legislation/corpus-index";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import {
  timestampCasToken,
  type TimestampCasToken,
  timestampMatchesCasToken,
} from "@/api/lib/db/timestamp-cas";
import { ConcurrentModificationError } from "@/api/lib/errors/tagged-errors";
import { legacyOperationalCorpusGeneration } from "@/api/lib/legal-search/corpus-family";
import { writeCorpusDocument } from "@/api/lib/legal-search/corpus-storage";
import type {
  DecisionSection,
  EmptyAst,
} from "@/api/lib/legal-search/document-types";
import {
  isCorpusS3Stale,
  isS3Stale,
  refreshCorpusS3,
  refreshS3,
} from "@/api/lib/s3";

import { ingestionDb } from "../db";

const BATCH_SIZE = 50;
const CONCURRENCY = 4;

type BackfillRow = {
  id: SafeId<"caseLawDecision">;
  country: string;
  fulltext: string | null;
  sections: DecisionSection[] | null;
  documentAst: DocumentAst | EmptyAst | null;
  updatedAtToken: TimestampCasToken;
};

type LegislationBackfillRow = {
  id: SafeId<"legislationDocument">;
  country: string;
  fulltext: string | null;
  sections: DecisionSection[] | null;
  documentAst: DocumentAst | EmptyAst | null;
  updatedAtToken: TimestampCasToken;
};

type BackfillOptions = {
  caseLawLimit: number | null;
  indexBatchSize: number | null;
  indexReadConcurrency: number | null;
  legislationLimit: number | null;
};

type ParseResult =
  | { ok: true; options: BackfillOptions }
  | { ok: false; message: string };

const logInfo = (message: string): void => {
  void Bun.write(Bun.stdout, `${message}\n`);
};

const logError = (message: string): void => {
  void Bun.write(Bun.stderr, `${message}\n`);
};

const parseLimit = (name: string, value: string | undefined): ParseResult => {
  if (value === undefined) {
    return { ok: false, message: `${name} requires a value` };
  }

  if (!/^\d+$/u.test(value)) {
    return { ok: false, message: `${name} must be a non-negative integer` };
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return { ok: false, message: `${name} is too large` };
  }

  return {
    ok: true,
    options: {
      caseLawLimit: parsed,
      indexBatchSize: null,
      indexReadConcurrency: null,
      legislationLimit: parsed,
    },
  };
};

const parseArgs = (argv: readonly string[]): ParseResult => {
  const options: BackfillOptions = {
    caseLawLimit: null,
    indexBatchSize: null,
    indexReadConcurrency: null,
    legislationLimit: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--limit") {
      const parsed = parseLimit(arg, argv.at(i + 1));
      if (!parsed.ok) {
        return parsed;
      }
      options.caseLawLimit = parsed.options.caseLawLimit;
      options.legislationLimit = parsed.options.legislationLimit;
      i += 1;
      continue;
    }

    if (arg === "--index-batch-size") {
      const parsed = parseLimit(arg, argv.at(i + 1));
      if (!parsed.ok) {
        return parsed;
      }
      const requestedBatch = parsed.options.caseLawLimit ?? 0;
      if (requestedBatch <= 0) {
        return { ok: false, message: `${arg} must be a positive integer` };
      }
      // Cap keeps one batch's payload and CAS fan-out bounded even when an
      // operator asks for more.
      options.indexBatchSize = Math.min(requestedBatch, 1000);
      i += 1;
      continue;
    }
    if (arg === "--index-read-concurrency") {
      const parsed = parseLimit(arg, argv.at(i + 1));
      if (!parsed.ok) {
        return parsed;
      }
      const requestedReads = parsed.options.caseLawLimit ?? 0;
      if (requestedReads <= 0) {
        return { ok: false, message: `${arg} must be a positive integer` };
      }
      // Half the row cap: a passage row issues up to two object reads, so
      // this bounds in-flight requests at twice the value.
      options.indexReadConcurrency = Math.min(requestedReads, 16);
      i += 1;
      continue;
    }
    if (arg === "--case-law-limit") {
      const parsed = parseLimit(arg, argv.at(i + 1));
      if (!parsed.ok) {
        return parsed;
      }
      options.caseLawLimit = parsed.options.caseLawLimit;
      i += 1;
      continue;
    }

    if (arg === "--legislation-limit") {
      const parsed = parseLimit(arg, argv.at(i + 1));
      if (!parsed.ok) {
        return parsed;
      }
      options.legislationLimit = parsed.options.legislationLimit;
      i += 1;
      continue;
    }

    return { ok: false, message: `Unknown option: ${arg ?? "(missing)"}` };
  }

  return { ok: true, options };
};

const backfillRow = async (
  row: BackfillRow,
): Promise<"written" | "skipped" | "failed"> => {
  try {
    // The batch snapshot can go stale while earlier rows in it write.
    // Re-check the compare-and-set precondition first, so a row whose
    // recording below would be refused does not pay the object PUTs.
    const fresh = await ingestionDb((tx) =>
      tx
        .select({ id: caseLawDecisions.id })
        .from(caseLawDecisions)
        .where(
          and(
            eq(caseLawDecisions.id, row.id),
            isNull(caseLawDecisions.textS3Key),
            timestampMatchesCasToken(
              caseLawDecisions.updatedAt,
              row.updatedAtToken,
            ),
          ),
        )
        .limit(1),
    );
    if (fresh.length === 0) {
      return "skipped";
    }

    const outcome = await writeCorpusDocument({
      documentId: row.id,
      jurisdiction: row.country,
      text: row.fulltext,
      sections: row.sections,
      ast: row.documentAst,
      // The scan admits only rows with no recorded corpus write.
      stored: null,
    });
    if (outcome.type === "skipped-empty") {
      // Nothing readable to store; null pointers already represent it.
      return "skipped";
    }
    const result = outcome.written;

    const recorded = await ingestionDb((tx) =>
      tx
        .update(caseLawDecisions)
        .set({
          textS3Key: result.textKey,
          normalizedS3Key: result.sectionsKey,
          astS3Key: result.astKey,
          contentHash: result.contentHash,
        })
        // Compare-and-set on the selected row state: a concurrent
        // ingestion refresh may have written newer keys, and an
        // unconditional update would point the row back at the stale
        // backfill payload.
        .where(
          and(
            eq(caseLawDecisions.id, row.id),
            isNull(caseLawDecisions.textS3Key),
            timestampMatchesCasToken(
              caseLawDecisions.updatedAt,
              row.updatedAtToken,
            ),
          ),
        )
        .returning({ id: caseLawDecisions.id }),
    );

    // A refused CAS is not success: the objects exist but the row still
    // points nowhere, and only the recording makes the work durable.
    return recorded.length > 0 ? "written" : "skipped";
  } catch (error) {
    captureError(error, {
      decisionId: row.id,
      step: "caseLawCorpusStorageBackfill",
    });
    return "failed";
  }
};

const backfillLegislationRow = async (
  row: LegislationBackfillRow,
): Promise<"written" | "skipped" | "failed"> => {
  try {
    // Same shape as the case-law pass: refuse the PUTs when the recording
    // compare-and-set below would already refuse the row.
    const fresh = await ingestionDb((tx) =>
      tx
        .select({ id: legislationDocuments.id })
        .from(legislationDocuments)
        .where(
          and(
            eq(legislationDocuments.id, row.id),
            isNull(legislationDocuments.textS3Key),
            timestampMatchesCasToken(
              legislationDocuments.updatedAt,
              row.updatedAtToken,
            ),
          ),
        )
        .limit(1),
    );
    if (fresh.length === 0) {
      return "skipped";
    }

    const outcome = await writeCorpusDocument({
      documentId: row.id,
      jurisdiction: row.country,
      text: row.fulltext,
      sections: row.sections,
      ast: row.documentAst,
      // The scan admits only rows with no recorded corpus write.
      stored: null,
    });
    if (outcome.type === "skipped-empty") {
      // Nothing readable to store; null pointers already represent it.
      return "skipped";
    }
    const result = outcome.written;

    const recorded = await ingestionDb((tx) =>
      tx
        .update(legislationDocuments)
        .set({
          textS3Key: result.textKey,
          normalizedS3Key: result.sectionsKey,
          astS3Key: result.astKey,
          contentHash: result.contentHash,
        })
        // Compare-and-set on the selected row state: a concurrent
        // ingestion refresh may have written newer keys, and an
        // unconditional update would point the row back at the stale
        // backfill payload.
        .where(
          and(
            eq(legislationDocuments.id, row.id),
            isNull(legislationDocuments.textS3Key),
            timestampMatchesCasToken(
              legislationDocuments.updatedAt,
              row.updatedAtToken,
            ),
          ),
        )
        .returning({ id: legislationDocuments.id }),
    );

    return recorded.length > 0 ? "written" : "skipped";
  } catch (error) {
    captureError(error, {
      documentId: row.id,
      step: "legislationCorpusStorageBackfill",
    });
    return "failed";
  }
};

type BackfillResult = {
  written: number;
  skipped: number;
  failed: number;
};

const nextBatchSize = (
  limit: number | null,
  attempted: number,
  size: number = BATCH_SIZE,
): number => {
  if (limit === null) {
    return size;
  }
  return Math.min(size, Math.max(0, limit - attempted));
};

// Long backfills outlive temporary AWS credentials; refresh the shared
// clients between batches once they approach the STS expiry window.
const refreshStaleS3 = async (): Promise<void> => {
  if (isS3Stale()) {
    await refreshS3();
  }
  if (isCorpusS3Stale()) {
    await refreshCorpusS3();
  }
};

const backfillCaseLaw = async (
  limit: number | null,
): Promise<BackfillResult> => {
  let lastId: SafeId<"caseLawDecision"> | null = null;
  let written = 0;
  let skipped = 0;
  let failed = 0;

  while (true) {
    const batchSize = nextBatchSize(limit, written + skipped + failed);
    if (batchSize === 0) {
      break;
    }
    await refreshStaleS3();

    const idFilter: SQL | undefined =
      lastId === null ? undefined : gt(caseLawDecisions.id, lastId);
    const where = idFilter
      ? and(isNull(caseLawDecisions.textS3Key), idFilter)
      : isNull(caseLawDecisions.textS3Key);

    const rows: BackfillRow[] = await ingestionDb((tx) =>
      tx
        .select({
          id: caseLawDecisions.id,
          country: caseLawDecisions.country,
          fulltext: caseLawDecisions.fulltext,
          sections: caseLawDecisions.sections,
          documentAst: caseLawDecisions.documentAst,
          updatedAtToken: timestampCasToken(caseLawDecisions.updatedAt),
        })
        .from(caseLawDecisions)
        .where(where)
        .orderBy(asc(caseLawDecisions.id))
        .limit(batchSize),
    );

    if (rows.length === 0) {
      break;
    }

    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const outcomes = await Promise.all(
        rows.slice(i, i + CONCURRENCY).map(backfillRow),
      );
      for (const outcome of outcomes) {
        if (outcome === "written") {
          written += 1;
        } else if (outcome === "skipped") {
          skipped += 1;
        } else {
          failed += 1;
        }
      }
    }

    lastId = rows.at(-1)?.id ?? lastId;
    logInfo(
      `  case-law written=${written} skipped=${skipped} failed=${failed}`,
    );
  }

  return { written, skipped, failed };
};

const backfillLegislation = async (
  limit: number | null,
): Promise<BackfillResult> => {
  let lastId: SafeId<"legislationDocument"> | null = null;
  let written = 0;
  let skipped = 0;
  let failed = 0;

  while (true) {
    const batchSize = nextBatchSize(limit, written + skipped + failed);
    if (batchSize === 0) {
      break;
    }
    await refreshStaleS3();

    const idFilter: SQL | undefined =
      lastId === null ? undefined : gt(legislationDocuments.id, lastId);
    const where = idFilter
      ? and(isNull(legislationDocuments.textS3Key), idFilter)
      : isNull(legislationDocuments.textS3Key);

    const rows: LegislationBackfillRow[] = await ingestionDb((tx) =>
      tx
        .select({
          id: legislationDocuments.id,
          country: legislationDocuments.country,
          fulltext: legislationDocuments.fulltext,
          sections: legislationDocuments.sections,
          documentAst: legislationDocuments.documentAst,
          updatedAtToken: timestampCasToken(legislationDocuments.updatedAt),
        })
        .from(legislationDocuments)
        .where(where)
        .orderBy(asc(legislationDocuments.id))
        .limit(batchSize),
    );

    if (rows.length === 0) {
      break;
    }

    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const outcomes = await Promise.all(
        rows.slice(i, i + CONCURRENCY).map(backfillLegislationRow),
      );
      for (const outcome of outcomes) {
        if (outcome === "written") {
          written += 1;
        } else if (outcome === "skipped") {
          skipped += 1;
        } else {
          failed += 1;
        }
      }
    }

    lastId = rows.at(-1)?.id ?? lastId;
    logInfo(
      `  legislation written=${written} skipped=${skipped} failed=${failed}`,
    );
  }

  return { written, skipped, failed };
};

type IndexBackfillResult = {
  indexed: number;
};

const backfillCaseLawIndex = async (
  limit: number | null,
  bulk: { indexBatchSize: number | null; indexReadConcurrency: number | null },
): Promise<IndexBackfillResult> => {
  const generation = legacyOperationalCorpusGeneration("case_law");
  let indexed = 0;

  while (true) {
    const batchSize = nextBatchSize(
      limit,
      indexed,
      bulk.indexBatchSize ?? undefined,
    );
    if (batchSize === 0) {
      break;
    }
    await refreshStaleS3();

    const result = await backfillCorpusIndex(
      ingestionDb,
      batchSize,
      generation,
      bulk.indexReadConcurrency === null
        ? {}
        : { readConcurrency: bulk.indexReadConcurrency },
    );
    switch (result.status) {
      case BACKFILL_STATUS.ADVANCED:
        indexed += result.indexed;
        if (result.indexed > 0) {
          logInfo(`  case-law indexed=${indexed}`);
        }
        break;
      case BACKFILL_STATUS.COMPLETE:
        return { indexed };
      case BACKFILL_STATUS.BUSY:
        throw new ConcurrentModificationError({
          message:
            "Case-law corpus index backfill is already running for this generation; retry after the active writer finishes.",
        });
      default: {
        result satisfies never;
        return panic(`Unhandled result: ${String(result)}`);
      }
    }
  }

  return { indexed };
};

const backfillLegislationIndex = async (
  limit: number | null,
  bulk: { indexBatchSize: number | null; indexReadConcurrency: number | null },
): Promise<IndexBackfillResult> => {
  const generation = legacyOperationalCorpusGeneration("legislation");
  let indexed = 0;

  while (true) {
    const batchSize = nextBatchSize(
      limit,
      indexed,
      bulk.indexBatchSize ?? BATCH_SIZE,
    );
    if (batchSize === 0) {
      break;
    }
    await refreshStaleS3();

    const count = await backfillLegislationCorpusIndex(
      ingestionDb,
      batchSize,
      generation,
      bulk.indexReadConcurrency === null
        ? {}
        : { readConcurrency: bulk.indexReadConcurrency },
    );
    if (count === 0) {
      break;
    }

    indexed += count;
    logInfo(`  legislation indexed=${indexed}`);
  }

  return { indexed };
};

export const runLegalCorpusStorageBackfill = async (
  argv: readonly string[] = [],
): Promise<number> => {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    logError(parsed.message);
    return 64;
  }

  await refreshS3();
  await refreshCorpusS3();

  logInfo("=== BACKFILL LEGAL CORPUS STORAGE ===");
  logInfo(
    `Limits: case-law=${parsed.options.caseLawLimit ?? "all"} legislation=${parsed.options.legislationLimit ?? "all"}`,
  );

  const caseLaw = await backfillCaseLaw(parsed.options.caseLawLimit);

  const legislation = await backfillLegislation(
    parsed.options.legislationLimit,
  );

  logInfo(
    `Done. Case-law wrote ${caseLaw.written}, skipped ${caseLaw.skipped}, ${caseLaw.failed} failed. Legislation wrote ${legislation.written}, skipped ${legislation.skipped}, ${legislation.failed} failed.`,
  );
  return caseLaw.failed === 0 && legislation.failed === 0 ? 0 : 1;
};

export const runLegalCorpusIndexBackfill = async (
  argv: readonly string[] = [],
): Promise<number> => {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    logError(parsed.message);
    return 64;
  }

  await refreshS3();
  await refreshCorpusS3();

  logInfo("=== BACKFILL LEGAL CORPUS INDEX ===");
  logInfo(
    `Limits: case-law=${parsed.options.caseLawLimit ?? "all"} legislation=${parsed.options.legislationLimit ?? "all"}`,
  );

  try {
    const caseLaw = await backfillCaseLawIndex(parsed.options.caseLawLimit, {
      indexBatchSize: parsed.options.indexBatchSize,
      indexReadConcurrency: parsed.options.indexReadConcurrency,
    });
    const legislation = await backfillLegislationIndex(
      parsed.options.legislationLimit,
      {
        indexBatchSize: parsed.options.indexBatchSize,
        indexReadConcurrency: parsed.options.indexReadConcurrency,
      },
    );

    logInfo(
      `Done. Case-law indexed ${caseLaw.indexed}. Legislation indexed ${legislation.indexed}.`,
    );
    return 0;
  } catch (error) {
    captureError(error, { step: "legalCorpusIndexBackfill" });
    logError(error instanceof Error ? error.message : String(error));
    return 1;
  }
};

export const runCaseLawCorpusStorageBackfill = async (
  argv: readonly string[] = [],
): Promise<number> => {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    logError(parsed.message);
    return 64;
  }

  await refreshS3();
  await refreshCorpusS3();

  logInfo("=== BACKFILL CASE-LAW CORPUS STORAGE ===");
  logInfo(`Limit: case-law=${parsed.options.caseLawLimit ?? "all"}`);

  const caseLaw = await backfillCaseLaw(parsed.options.caseLawLimit);

  logInfo(
    `Done. Wrote ${caseLaw.written} decisions, skipped ${caseLaw.skipped}, ${caseLaw.failed} failed.`,
  );
  return caseLaw.failed === 0 ? 0 : 1;
};
