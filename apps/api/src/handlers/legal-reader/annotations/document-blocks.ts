import { panic } from "better-result";
import { and, eq } from "drizzle-orm";

import type { ReaderDocumentTargetType } from "@stll/api-contract/legal-reader-annotations";
import type { Block } from "@stll/legal-ast/document-ast";

import {
  caseLawSources,
  legislationDocuments,
  legislationSources,
  publishedCaseLawDecisions,
} from "@/api/db/schema";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { readDecisionAnalysisAst } from "@/api/lib/case-law/decision-analysis";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import { readCorpusTombstones } from "@/api/lib/legal-search/corpus-reads";
import { allowsDerivedAi } from "@/api/lib/legal-search/corpus-source";
import { publishedLegislationDocumentFor } from "@/api/lib/legal-search/legislation-redistribution";
import {
  readVersionBlocks,
  versionAstColumns,
} from "@/api/lib/legal-search/legislation-version-blocks";
import { legislationPublicReadDb } from "@/api/lib/legislation-public-read-db";
import {
  brandPersistedCaseLawDecisionId,
  brandPersistedLegislationDocumentId,
} from "@/api/lib/safe-id-boundaries";

type AnnotationTarget = {
  targetId: string;
  targetType: ReaderDocumentTargetType;
};

/**
 * Whether an agent may read or write marks on a document: the public reader
 * shows it and its source permits derived AI use. A source that forbids AI
 * use keeps both its wording and the marks quoting it away from an agent, as
 * the chat prompt does. The block read rides along so a caller that places a
 * mark does not resolve the document twice.
 */
type AnnotationTargetAccess =
  | { status: "not_found" }
  | { status: "withheld" }
  | { status: "available"; readBlocks: () => Promise<readonly Block[]> };

const resolveDecision = async (
  decisionId: string,
): Promise<AnnotationTargetAccess> => {
  const row = await withRedistributableSubject(
    caseLawPublicReadDb,
    "search",
    { kind: "id", id: brandPersistedCaseLawDecisionId(decisionId) },
    async ({ id, tx }) => {
      const [decisionRow] = await tx
        .select({
          astS3Key: publishedCaseLawDecisions.astS3Key,
          contentHash: publishedCaseLawDecisions.contentHash,
          documentAst: publishedCaseLawDecisions.documentAst,
          id: publishedCaseLawDecisions.id,
          source: {
            id: caseLawSources.id,
            descriptor: caseLawSources.descriptor,
          },
        })
        .from(publishedCaseLawDecisions)
        .leftJoin(
          caseLawSources,
          eq(caseLawSources.id, publishedCaseLawDecisions.sourceId),
        )
        .where(eq(publishedCaseLawDecisions.id, id))
        .limit(1);
      return decisionRow;
    },
  );
  if (row === null || row === undefined) {
    return { status: "not_found" };
  }
  const source =
    row.source ?? panic("Case-law decision has no source relation");
  if (!allowsDerivedAi(source.descriptor)) {
    return { status: "withheld" };
  }
  return {
    status: "available",
    // Outside the gate's transaction: the AST lives in object storage.
    readBlocks: async () => {
      // No usable AST is a decision the reader shows as flat text: no blocks.
      const ast = await readDecisionAnalysisAst(row, readCorpusTombstones);
      return ast === null ? [] : ast.blocks;
    },
  };
};

const resolveStatute = async (
  documentId: string,
): Promise<AnnotationTargetAccess> => {
  const [version] = await legislationPublicReadDb(
    async (tx) =>
      await tx
        .select({
          descriptor: legislationSources.descriptor,
          ...versionAstColumns,
        })
        .from(legislationDocuments)
        .innerJoin(
          legislationSources,
          eq(legislationSources.id, legislationDocuments.sourceId),
        )
        .where(
          and(
            eq(
              legislationDocuments.id,
              brandPersistedLegislationDocumentId(documentId),
            ),
            publishedLegislationDocumentFor("search"),
          ),
        )
        .limit(1),
  );
  if (version === undefined) {
    return { status: "not_found" };
  }
  if (!allowsDerivedAi(version.descriptor)) {
    return { status: "withheld" };
  }
  return {
    status: "available",
    readBlocks: async () =>
      await readVersionBlocks({
        surface: "search",
        row: version,
        legislationDb: legislationPublicReadDb,
        step: "readerAnnotations.statuteBlocks",
        purpose: "derived-ai",
      }),
  };
};

export const resolveAnnotationTarget = async ({
  targetId,
  targetType,
}: AnnotationTarget): Promise<AnnotationTargetAccess> => {
  switch (targetType) {
    case "decision":
      return await resolveDecision(targetId);
    case "statute":
      return await resolveStatute(targetId);
    default:
      targetType satisfies never;
      return panic(`Unhandled annotation target type: ${String(targetType)}`);
  }
};
