import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { createIngestionDb } from "@/api/db";
import { rlsDb } from "@/api/db/root";
import { caseLawDecisions, legislationDocuments } from "@/api/db/schema";
import { writeCorpusDocument } from "@/api/handlers/case-law/corpus-storage";
import type { EmptyAst } from "@/api/handlers/case-law/ingestion/adapter";
import type { DecisionSection } from "@/api/handlers/case-law/types";
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";
import { refreshCorpusS3, refreshS3 } from "@/api/lib/s3";

const BATCH_SIZE = 50;
const CONCURRENCY = 4;

type BackfillRow = {
  id: SafeId<"caseLawDecision">;
  country: string;
  fulltext: string | null;
  sections: DecisionSection[] | null;
  documentAst: DocumentAst | EmptyAst | null;
};

type LegislationBackfillRow = {
  id: SafeId<"legislationDocument">;
  country: string;
  fulltext: string | null;
  sections: DecisionSection[] | null;
  documentAst: DocumentAst | EmptyAst | null;
};

type BackfillOptions = {
  caseLawLimit: number | null;
  legislationLimit: number | null;
};

type ParseResult =
  | { ok: true; options: BackfillOptions }
  | { ok: false; message: string };

const ingestionDb = createIngestionDb(rlsDb);

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
    options: { caseLawLimit: parsed, legislationLimit: parsed },
  };
};

const parseArgs = (argv: readonly string[]): ParseResult => {
  const options: BackfillOptions = {
    caseLawLimit: null,
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

const backfillRow = async (row: BackfillRow): Promise<boolean> => {
  try {
    const result = await writeCorpusDocument({
      documentId: row.id,
      jurisdiction: row.country,
      text: row.fulltext,
      sections: row.sections,
      ast: row.documentAst,
    });

    await ingestionDb((tx) =>
      tx
        .update(caseLawDecisions)
        .set({
          textS3Key: result.textKey,
          normalizedS3Key: result.sectionsKey,
          astS3Key: result.astKey,
          contentHash: result.contentHash,
        })
        .where(eq(caseLawDecisions.id, row.id)),
    );

    return true;
  } catch (error) {
    captureError(error, {
      decisionId: row.id,
      step: "caseLawCorpusStorageBackfill",
    });
    return false;
  }
};

const backfillLegislationRow = async (
  row: LegislationBackfillRow,
): Promise<boolean> => {
  try {
    const result = await writeCorpusDocument({
      documentId: row.id,
      jurisdiction: row.country,
      text: row.fulltext,
      sections: row.sections,
      ast: row.documentAst,
    });

    await ingestionDb((tx) =>
      tx
        .update(legislationDocuments)
        .set({
          textS3Key: result.textKey,
          normalizedS3Key: result.sectionsKey,
          astS3Key: result.astKey,
          contentHash: result.contentHash,
        })
        .where(eq(legislationDocuments.id, row.id)),
    );

    return true;
  } catch (error) {
    captureError(error, {
      documentId: row.id,
      step: "legislationCorpusStorageBackfill",
    });
    return false;
  }
};

type BackfillResult = {
  written: number;
  failed: number;
};

const nextBatchSize = (limit: number | null, attempted: number): number => {
  if (limit === null) {
    return BATCH_SIZE;
  }
  return Math.min(BATCH_SIZE, Math.max(0, limit - attempted));
};

const backfillCaseLaw = async (
  limit: number | null,
): Promise<BackfillResult> => {
  let lastId: SafeId<"caseLawDecision"> | null = null;
  let written = 0;
  let failed = 0;

  while (true) {
    const batchSize = nextBatchSize(limit, written + failed);
    if (batchSize === 0) {
      break;
    }

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
        if (outcome) {
          written += 1;
        } else {
          failed += 1;
        }
      }
    }

    lastId = rows.at(-1)?.id ?? lastId;
    logInfo(`  case-law written=${written} failed=${failed}`);
  }

  return { written, failed };
};

const backfillLegislation = async (
  limit: number | null,
): Promise<BackfillResult> => {
  let lastId: SafeId<"legislationDocument"> | null = null;
  let written = 0;
  let failed = 0;

  while (true) {
    const batchSize = nextBatchSize(limit, written + failed);
    if (batchSize === 0) {
      break;
    }

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
        if (outcome) {
          written += 1;
        } else {
          failed += 1;
        }
      }
    }

    lastId = rows.at(-1)?.id ?? lastId;
    logInfo(`  legislation written=${written} failed=${failed}`);
  }

  return { written, failed };
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
    `Done. Case-law wrote ${caseLaw.written}, ${caseLaw.failed} failed. Legislation wrote ${legislation.written}, ${legislation.failed} failed.`,
  );
  return caseLaw.failed === 0 && legislation.failed === 0 ? 0 : 1;
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
    `Done. Wrote ${caseLaw.written} decisions, ${caseLaw.failed} failed.`,
  );
  return caseLaw.failed === 0 ? 0 : 1;
};
