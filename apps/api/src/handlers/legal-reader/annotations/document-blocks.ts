import { panic } from "better-result";
import { and, eq } from "drizzle-orm";

import type { ReaderAnnotationTargetType } from "@stll/api-contract/legal-reader-annotations";
import type { Block } from "@stll/legal-ast/document-ast";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { readDecisionAnalysisAst } from "@/api/lib/case-law/decision-analysis";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import { readCorpusTombstones } from "@/api/lib/legal-search/corpus-reads";
import { allowsDerivedAi } from "@/api/lib/legal-search/corpus-source";
import { publishedLegislationDocument } from "@/api/lib/legal-search/legislation-redistribution";
import {
  readVersionBlocks,
  versionAstColumns,
} from "@/api/lib/legal-search/legislation-version-blocks";
import { legislationPublicReadDb } from "@/api/lib/legislation-public-read-db";
import {
  brandPersistedCaseLawDecisionId,
  brandPersistedLegislationDocumentId,
} from "@/api/lib/safe-id-boundaries";

/**
 * What an agent may mark on: the blocks of a document the public reader
 * shows and whose source permits derived AI use. A source that forbids it
 * never reached the model's context, so a mark placed "from" it would be
 * one the model could only have guessed.
 */
export type AnnotationTargetBlocks =
  | { status: "available"; blocks: readonly Block[] }
  | { status: "not_found" }
  | { status: "withheld" }
  | { status: "unstructured" };

const withBlocks = (blocks: readonly Block[]): AnnotationTargetBlocks =>
  blocks.length === 0
    ? { status: "unstructured" }
    : { status: "available", blocks };

const DECISION_AST_COLUMNS = {
  astS3Key: true,
  contentHash: true,
  documentAst: true,
  id: true,
} as const;

const readDecisionBlocks = async (
  decisionId: string,
): Promise<AnnotationTargetBlocks> => {
  const row = await withRedistributableSubject(
    caseLawPublicReadDb,
    { kind: "id", id: brandPersistedCaseLawDecisionId(decisionId) },
    async ({ id, tx }) =>
      await tx.query.caseLawDecisions.findFirst({
        where: { id: { eq: id } },
        columns: DECISION_AST_COLUMNS,
        with: { source: { columns: { descriptor: true } } },
      }),
  );
  if (row === null || row === undefined) {
    return { status: "not_found" };
  }
  const source =
    row.source ?? panic("Case-law decision has no source relation");
  if (!allowsDerivedAi(source.descriptor)) {
    return { status: "withheld" };
  }
  // Outside the gate's transaction: the AST lives in object storage.
  const ast = await readDecisionAnalysisAst(row, readCorpusTombstones);
  return withBlocks(ast?.blocks ?? []);
};

const readStatuteBlocks = async (
  documentId: string,
): Promise<AnnotationTargetBlocks> => {
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
            publishedLegislationDocument,
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
  return withBlocks(
    await readVersionBlocks({
      row: version,
      legislationDb: legislationPublicReadDb,
      step: "readerAnnotations.statuteBlocks",
      purpose: "derived-ai",
    }),
  );
};

export const readAnnotationTargetBlocks = async ({
  targetId,
  targetType,
}: {
  targetId: string;
  targetType: ReaderAnnotationTargetType;
}): Promise<AnnotationTargetBlocks> => {
  switch (targetType) {
    case "decision":
      return await readDecisionBlocks(targetId);
    case "statute":
      return await readStatuteBlocks(targetId);
    default:
      targetType satisfies never;
      return panic(`Unhandled annotation target type: ${String(targetType)}`);
  }
};
