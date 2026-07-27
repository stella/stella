/**
 * The public decision read, with the document fetched when it is a
 * reader who gets there before the ingestion queue.
 *
 * This sits between the route and `get.ts` rather than inside it for
 * two reasons. `get.ts` stays a read — it holds the public read-only
 * database boundary, and the fetch is a write. And an import edge added
 * to a module the route tree infers through costs the API typecheck
 * over a million type instantiations (see the typecheck baseline
 * guard), so the read handler keeps the import list it had and reports
 * `documentPending` instead; the fetch is wired in here.
 */

import {
  isDeferredDocumentFetchable,
  readThroughDeferredDocument,
} from "@/api/handlers/case-law/decisions/document-on-demand";
import { onDemandDocumentDeps } from "@/api/handlers/case-law/decisions/document-on-demand-deps";
import {
  readDecisionBySlugHandler,
  readDecisionHandler,
} from "@/api/handlers/case-law/decisions/get";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";

type DecisionRead = Awaited<ReturnType<typeof readDecisionHandler>>;
type ReadableDecision = Extract<DecisionRead, { documentPending: boolean }>;

const hydrate = async (
  decision: ReadableDecision,
): Promise<ReadableDecision> => {
  if (
    !isDeferredDocumentFetchable({
      adapterKey: decision.source.adapterKey,
      documentUrl: decision.documentUrl,
      documentPending: decision.documentPending,
    })
  ) {
    return decision;
  }

  const document = await readThroughDeferredDocument(
    {
      id: decision.id,
      caseNumber: decision.caseNumber,
      ecli: decision.ecli,
      court: decision.court,
      decisionDate: decision.decisionDate,
      decisionType: decision.decisionType,
      documentUrl: decision.documentUrl,
    },
    onDemandDocumentDeps,
  );

  // The fetch did not finish inside the read's budget, or the source
  // had nothing: the decision stays readable as metadata and stays
  // queued, and the next read finds it stored.
  if (!document) {
    return decision;
  }

  return {
    ...decision,
    documentAst: document.documentAst,
    documentPending: false,
    // Mirrors the read: text is the fallback for a decision without a
    // usable AST, and a parsed document always has one.
    fulltext: null,
  };
};

const withDeferredDocument = async (
  read: DecisionRead,
): Promise<DecisionRead> =>
  "documentPending" in read ? await hydrate(read) : read;

export const readDecisionWithDocumentHandler = async (
  decisionId: SafeId<"caseLawDecision">,
  caseLawDb: CaseLawPublicReadDb,
): Promise<DecisionRead> =>
  await withDeferredDocument(await readDecisionHandler(decisionId, caseLawDb));

export const readDecisionBySlugWithDocumentHandler = async (
  slug: string,
  caseLawDb: CaseLawPublicReadDb,
  language?: string,
): Promise<DecisionRead> =>
  await withDeferredDocument(
    await readDecisionBySlugHandler(slug, caseLawDb, language),
  );
