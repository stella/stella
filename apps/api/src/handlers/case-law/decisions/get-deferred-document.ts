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
  recordDemand: boolean,
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

  const document = await readThroughDeferredDocument({
    decision: {
      id: decision.id,
      caseNumber: decision.caseNumber,
      ecli: decision.ecli,
      court: decision.court,
      country: decision.country,
      decisionDate: decision.decisionDate,
      decisionType: decision.decisionType,
      documentUrl: decision.documentUrl,
    },
    deps: onDemandDocumentDeps,
    recordDemand,
  });

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
  recordDemand: boolean,
): Promise<DecisionRead> =>
  "documentPending" in read ? await hydrate(read, recordDemand) : read;

/**
 * Whether the caller's reads may persist demand. Only a caller we can
 * attribute — a session, an agent token — may steer the ingestion
 * queue; see `recordDemand` in `document-on-demand.ts`.
 */
export type DecisionReadCaller = "anonymous" | "attributed";

export type ReadDecisionWithDocumentOptions = {
  decisionId: SafeId<"caseLawDecision">;
  caseLawDb: CaseLawPublicReadDb;
  caller: DecisionReadCaller;
};

export type ReadDecisionBySlugWithDocumentOptions = {
  slug: string;
  caseLawDb: CaseLawPublicReadDb;
  caller: DecisionReadCaller;
  language: string | undefined;
};

export const readDecisionWithDocumentHandler = async ({
  decisionId,
  caseLawDb,
  caller,
}: ReadDecisionWithDocumentOptions): Promise<DecisionRead> =>
  await withDeferredDocument(
    await readDecisionHandler(decisionId, caseLawDb),
    caller === "attributed",
  );

export const readDecisionBySlugWithDocumentHandler = async ({
  slug,
  caseLawDb,
  caller,
  language,
}: ReadDecisionBySlugWithDocumentOptions): Promise<DecisionRead> =>
  await withDeferredDocument(
    await readDecisionBySlugHandler(slug, caseLawDb, language),
    caller === "attributed",
  );
