import { panic } from "better-result";
import { and, eq } from "drizzle-orm";

import {
  DECISION_ANCHOR_REDIRECT_MAX_ANCHORS,
  DECISION_ANCHOR_RESOLUTION,
  resolveDecisionAnchor,
} from "@stll/api-contract/case-law-anchor-redirects";
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
import type { SafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { readDecisionAnalysisAst } from "@/api/lib/case-law/decision-analysis";
import { readDecisionAnchorRedirects } from "@/api/lib/case-law/decision-anchor-redirects";
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
 * `resolveHeldAnchors` maps a block anchor an earlier version of the
 * document held to the anchor holding its text now, for anchors the current
 * blocks lack and a reparse moved; anything else is left out.
 */
type AnnotationTargetAccess =
  | { status: "not_found" }
  | { status: "withheld" }
  | {
      status: "available";
      readBlocks: () => Promise<readonly Block[]>;
      readTextPieces: () => Promise<readonly ReaderTextPiece[]>;
      resolveHeldAnchors: (
        anchors: readonly string[],
        currentAnchors: ReadonlySet<string>,
      ) => Promise<ReadonlyMap<string, string>>;
    };

/** A document whose anchors a reparse never moves holds nothing to resolve. */
const NO_HELD_ANCHORS = async (): Promise<ReadonlyMap<string, string>> =>
  await Promise.resolve(new Map());

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
    resolveHeldAnchors: async (anchors, currentAnchors) =>
      await resolveMovedDecisionAnchors({
        decisionId: row.id,
        anchors,
        currentAnchors,
      }),
  };
};

type ResolveMovedDecisionAnchorsOptions = {
  decisionId: SafeId<"caseLawDecision">;
  anchors: readonly string[];
  currentAnchors: ReadonlySet<string>;
};

/** Held anchors a reparse moved, to the anchor holding their text now. */
const resolveMovedDecisionAnchors = async ({
  decisionId,
  anchors,
  currentAnchors,
}: ResolveMovedDecisionAnchorsOptions): Promise<
  ReadonlyMap<string, string>
> => {
  const unknown = [
    ...new Set(anchors.filter((anchor) => !currentAnchors.has(anchor))),
  ].slice(0, DECISION_ANCHOR_REDIRECT_MAX_ANCHORS);
  if (unknown.length === 0) {
    return new Map();
  }
  const items = await withRedistributableSubject(
    caseLawPublicReadDb,
    "search",
    { kind: "id", id: decisionId },
    async ({ id, tx }) =>
      await readDecisionAnchorRedirects(tx, {
        decisionId: id,
        anchors: unknown,
      }),
  );
  const moved = new Map<string, string>();
  // Null: the decision is gone or not public, so it has no redirect to read.
  if (items === null) {
    return moved;
  }
  for (const { anchor, redirect } of items) {
    const resolution = resolveDecisionAnchor({
      anchor,
      currentAnchors,
      redirect,
    });
    if (resolution.type === DECISION_ANCHOR_RESOLUTION.MOVED) {
      moved.set(anchor, resolution.anchorId);
    }
  }
  return moved;
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
  const readStatuteBlocks = async () =>
    await readVersionBlocks({
      surface: "search",
      row: version,
      legislationDb: legislationPublicReadDb,
      step: "readerAnnotations.statuteBlocks",
      purpose: "derived-ai",
    });
  return {
    status: "available",
    readBlocks: readStatuteBlocks,
    // The statute reader draws marks in its blocks' anchored text alone.
    readTextPieces: async () =>
      (await readStatuteBlocks()).flatMap(readerAnchorPiecesOf),
    // Statute anchors name provisions, which a reparse does not renumber.
    resolveHeldAnchors: NO_HELD_ANCHORS,
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
