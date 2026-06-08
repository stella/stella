import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { createIngestionDb } from "@/api/db";
import { rlsDb } from "@/api/db/root";
import { caseLawDecisions } from "@/api/db/schema";
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

const ingestionDb = createIngestionDb(rlsDb);

const logInfo = (message: string): void => {
  void Bun.write(Bun.stdout, `${message}\n`);
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

export const runCaseLawCorpusStorageBackfill = async (): Promise<number> => {
  await refreshS3();
  await refreshCorpusS3();

  logInfo("=== BACKFILL CASE-LAW CORPUS STORAGE ===");

  let lastId: SafeId<"caseLawDecision"> | null = null;
  let written = 0;
  let failed = 0;

  while (true) {
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
        .limit(BATCH_SIZE),
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
    logInfo(`  written=${written} failed=${failed}`);
  }

  logInfo(`Done. Wrote ${written} decisions, ${failed} failed.`);
  return failed === 0 ? 0 : 1;
};
