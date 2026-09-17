/**
 * One decision's text as anchored passages, read through the public gate.
 *
 * A decision reaches a model as passages rather than as a document: each
 * passage carries the anchor a reader scrolls to, so whatever the model rests
 * on can be pointed at in the text. Over the caller's budget the passages are
 * ranked against what is being asked instead of truncated, because reading
 * order spends the whole budget on the decision's opening.
 *
 * Shared because more than one surface needs the same reading: the question
 * columns answer over these passages, and so does a citation check. The
 * redistribution and derived-AI gates stay with the caller: this module reads
 * the text and says nothing about who may send it where.
 */

import { Result } from "better-result";

import { parseUsableDocumentAst } from "@stll/legal-ast/document-ast";

import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import type { ResearchPassage } from "@/api/lib/case-law/research-answers";
import { selectPassagesWithinBudget } from "@/api/lib/case-law/research-answers";
import { getCorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import { readServingCorpusIndexGenerationTx } from "@/api/lib/legal-search/corpus-index-generation-store";
import {
  corpusFreeTextClause,
  quoteCorpusValue,
} from "@/api/lib/legal-search/corpus-query";
import type { CorpusSourceDescriptor } from "@/api/lib/legal-search/corpus-source";
import {
  parsePersistedCorpusAst,
  readCorpusAst,
  readCorpusPayloadOrFallback,
  readCorpusText,
} from "@/api/lib/legal-search/corpus-storage";
import { corpusIndexRoute } from "@/api/lib/legal-search/index-naming";

export type DecisionTextSource =
  | { kind: "passages"; passages: ResearchPassage[]; retrieved: boolean }
  | { kind: "none" };

/** The columns a passage read needs, plus the source's reuse terms. */
export type DecisionPassageRow = {
  id: SafeId<"caseLawDecision">;
  caseNumber: string;
  court: string;
  country: string;
  language: string;
  decisionType: string | null;
  documentAst: unknown;
  astS3Key: string | null;
  textS3Key: string | null;
  contentHash: string | null;
  fulltext: string | null;
  source: { descriptor: CorpusSourceDescriptor | null } | null;
};

export const readDecisionPassageRow = async (
  tx: CaseLawPublicReadTransaction,
  decisionId: SafeId<"caseLawDecision">,
): Promise<DecisionPassageRow | null> => {
  const row = await tx.query.caseLawDecisions.findFirst({
    where: { id: { eq: decisionId } },
    columns: {
      id: true,
      caseNumber: true,
      court: true,
      country: true,
      language: true,
      decisionType: true,
      documentAst: true,
      astS3Key: true,
      textS3Key: true,
      contentHash: true,
      fulltext: true,
    },
    // `descriptor` decides redistribution and derived-AI use; never returned.
    with: { source: { columns: { descriptor: true } } },
  });
  return row ?? null;
};

export type ResolveDecisionPassagesOptions = {
  caseLawDb: CaseLawPublicReadDb;
  decision: DecisionPassageRow;
  /** Characters the selected passages may add up to. */
  budgetChars: number;
  /** Longest single passage kept once retrieval has ranked them. */
  passageChars: number;
  /** Passages retrieval may return when the text is over budget. */
  maxPassages: number;
  /** What the passages are ranked against: the questions, or the claim. */
  queries: readonly string[];
};

/**
 * The decision as anchored passages: the AST's blocks when it has one (each
 * block's anchor is what the reader scrolls to), otherwise the stored text as
 * one unanchored passage. Over budget, the passages most relevant to
 * `queries` are retrieved from the corpus index instead.
 */
export const resolveDecisionPassages = async ({
  budgetChars,
  caseLawDb,
  decision,
  maxPassages,
  passageChars,
  queries,
}: ResolveDecisionPassagesOptions): Promise<DecisionTextSource> => {
  const blocks = await readDecisionBlocks(decision);
  const passages: ResearchPassage[] =
    blocks === null
      ? await readDecisionFulltextPassage(decision)
      : blocks.flatMap((block) =>
          block.plainText.trim().length > 0
            ? [{ anchorId: block.anchorId, excerpt: block.plainText.trim() }]
            : [],
        );
  if (passages.length === 0) {
    return { kind: "none" };
  }
  const total = passages.reduce(
    (sum, passage) => sum + passage.excerpt.length,
    0,
  );
  if (total <= budgetChars) {
    return { kind: "passages", passages, retrieved: false };
  }

  const retrieved = await retrieveDecisionPassages({
    caseLawDb,
    decision,
    maxPassages,
    queries,
  });
  const selected = selectPassagesWithinBudget(
    retrieved.length > 0 ? retrieved : passages,
    { budgetChars, passageChars },
  );
  return selected.length === 0
    ? { kind: "none" }
    : { kind: "passages", passages: selected, retrieved: true };
};

/** A row's corpus object, or its Postgres copy when the object is unreadable. */
const readStoredPayload = async <T>({
  decision,
  fallback,
  key,
  read,
  step,
}: {
  decision: DecisionPassageRow;
  key: string | null;
  step: string;
  read: (key: string) => Promise<T>;
  fallback: () => T | null;
}): Promise<T | null> => {
  if (key === null || decision.contentHash === null) {
    return fallback();
  }
  const stored = await Result.tryPromise(
    async () =>
      await readCorpusPayloadOrFallback({
        documentId: decision.id,
        key,
        step,
        read: async () => await read(key),
        fallback: async () => await Promise.resolve(fallback()),
      }),
  );
  return Result.isOk(stored) ? stored.value : null;
};

const readDecisionBlocks = async (
  decision: DecisionPassageRow,
): Promise<{ anchorId: string; plainText: string; type: string }[] | null> => {
  const stored = await readStoredPayload({
    decision,
    key: decision.astS3Key,
    step: "researchAnswers.corpusAst",
    read: readCorpusAst,
    fallback: () => parsePersistedCorpusAst(decision.documentAst),
  });
  const ast = stored === null ? null : parseUsableDocumentAst(stored);
  return ast === null ? null : ast.blocks;
};

const readDecisionFulltextPassage = async (
  decision: DecisionPassageRow,
): Promise<ResearchPassage[]> => {
  const text = await readStoredPayload({
    decision,
    key: decision.textS3Key,
    step: "researchAnswers.corpusText",
    read: readCorpusText,
    fallback: () => decision.fulltext,
  });
  const trimmed = text?.trim() ?? "";
  return trimmed.length === 0 ? [] : [{ anchorId: "text", excerpt: trimmed }];
};

export type RetrieveDecisionPassagesOptions = {
  caseLawDb: CaseLawPublicReadDb;
  decision: Pick<DecisionPassageRow, "country" | "id">;
  maxPassages: number;
  queries: readonly string[];
};

/** The passages of one decision that match `queries`, best first. */
export const retrieveDecisionPassages = async ({
  caseLawDb,
  decision,
  maxPassages,
  queries,
}: RetrieveDecisionPassagesOptions): Promise<ResearchPassage[]> => {
  const freeText = corpusFreeTextClause(queries.join(" "));
  if (freeText === null) {
    return [];
  }
  const searched = await Result.tryPromise(async () => {
    const serving = await caseLawDb(
      async (tx) => await readServingCorpusIndexGenerationTx(tx, "case_law"),
    );
    const { indexId } = corpusIndexRoute(serving.generation, decision.country);
    return await getCorpusIndexClient(serving.cluster).search({
      indexId,
      query: `document_id:${quoteCorpusValue(decision.id)} AND ${freeText}`,
      maxHits: maxPassages,
      sortBy: "_score",
    });
  });
  if (Result.isError(searched) || Result.isError(searched.value)) {
    return [];
  }
  return searched.value.value.hits.flatMap((hit) => {
    const anchorId = hit["anchor_id"];
    const text = hit["text"];
    return typeof anchorId === "string" &&
      anchorId.length > 0 &&
      typeof text === "string"
      ? [{ anchorId, excerpt: text }]
      : [];
  });
};
