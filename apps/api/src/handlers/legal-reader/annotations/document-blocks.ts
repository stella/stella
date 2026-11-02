import { panic } from "better-result";
import { and, eq } from "drizzle-orm";

import type { ReaderDocumentTargetType } from "@stll/api-contract/legal-reader-annotations";
import {
  readerAnchorPiecesOf,
  visibleDecisionBlocks,
} from "@stll/legal-ast/case-law-reader";
import { type Block, hasUsableAst } from "@stll/legal-ast/document-ast";
import type { ReaderTextPiece } from "@stll/legal-ast/reader-text-quote";

import {
  caseLawSources,
  legislationDocuments,
  legislationSources,
  publishedCaseLawDecisions,
} from "@/api/db/schema";
import { corpusStorageMode } from "@/api/env-base";
import { decisionAnnotationTextPieces } from "@/api/handlers/legal-reader/annotations/decision-text-pieces";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { readDecisionAnalysisAst } from "@/api/lib/case-law/decision-analysis";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import {
  readCorpusText,
  readCorpusTombstones,
} from "@/api/lib/legal-search/corpus-reads";
import { allowsDerivedAi } from "@/api/lib/legal-search/corpus-source";
import { readCorpusPayloadOrFallback } from "@/api/lib/legal-search/corpus-storage";
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
 * the chat prompt does. The reads ride along so a caller that places a
 * mark does not resolve the document twice: `readBlocks` is the anchored
 * text an agent writes a mark on, `readTextPieces` every run of text the
 * reader draws marks in, where a stored mark is placed.
 */
type AnnotationTargetAccess =
  | { status: "not_found" }
  | { status: "withheld" }
  | {
      status: "available";
      readBlocks: () => Promise<readonly Block[]>;
      readTextPieces: () => Promise<readonly ReaderTextPiece[]>;
    };

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
          caseNumberType: publishedCaseLawDecisions.caseNumberType,
          contentHash: publishedCaseLawDecisions.contentHash,
          textS3Key: publishedCaseLawDecisions.textS3Key,
          documentAst: publishedCaseLawDecisions.documentAst,
          fulltext: publishedCaseLawDecisions.fulltext,
          id: publishedCaseLawDecisions.id,
          metadata: publishedCaseLawDecisions.metadata,
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
  // Outside the gate's transaction: the payloads live in object storage.
  const readAst = async () =>
    await readDecisionAnalysisAst(row, readCorpusTombstones);
  // The read route serves the plain text only where the AST has nothing to
  // show, and the reader then draws its paragraphs.
  const readFulltext = async (): Promise<string | null> => {
    const { contentHash, textS3Key } = row;
    if (
      corpusStorageMode === "off" ||
      textS3Key === null ||
      contentHash === null
    ) {
      return row.fulltext;
    }
    return await readCorpusPayloadOrFallback({
      documentId: row.id,
      key: textS3Key,
      step: "readerAnnotations.decisionText",
      read: async () => await readCorpusText(textS3Key),
      fallback: () => row.fulltext,
    });
  };
  return {
    status: "available",
    readBlocks: async () => {
      // No usable AST is a decision the reader shows as flat text: no blocks.
      // A mark lands only on text the reader shows, never on a hidden block.
      const ast = await readAst();
      return visibleDecisionBlocks(ast, row.caseNumberType);
    },
    readTextPieces: async () => {
      const ast = await readAst();
      return decisionAnnotationTextPieces({
        ast,
        caseNumberType: row.caseNumberType,
        fulltext: hasUsableAst(ast) ? null : await readFulltext(),
        metadata: row.metadata,
      });
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
  const readBlocks = async () =>
    await readVersionBlocks({
      surface: "search",
      row: version,
      legislationDb: legislationPublicReadDb,
      step: "readerAnnotations.statuteBlocks",
      purpose: "derived-ai",
    });
  return {
    status: "available",
    readBlocks,
    // The statute reader draws marks in its blocks' anchored text alone.
    readTextPieces: async () =>
      (await readBlocks()).flatMap(readerAnchorPiecesOf),
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
