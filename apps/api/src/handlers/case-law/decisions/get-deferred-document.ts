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

import { envBase } from "@/api/env-base";
import {
  devReparseEnabled,
  reparseForDev,
} from "@/api/handlers/case-law/decisions/dev-reparse";
import {
  isDeferredDocumentFetchable,
  readThroughDeferredDocument,
} from "@/api/handlers/case-law/decisions/document-on-demand";
import { onDemandDocumentDeps } from "@/api/handlers/case-law/decisions/document-on-demand-deps";
import { readDecisionHandler } from "@/api/handlers/case-law/decisions/get";
import type { DecisionSubjectLocator } from "@/api/handlers/case-law/decisions/public-subject";
import { withRedistributableSubject } from "@/api/handlers/case-law/decisions/public-subject";
import { omitDerivablePlainText } from "@/api/handlers/case-law/document-ast";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";

type DecisionRead = Awaited<ReturnType<typeof readDecisionHandler>>;
type ReadableDecision = Extract<DecisionRead, { documentPending: boolean }>;

/**
 * A development process reading a shared corpus shows the parser in this
 * tree rather than the one that ingested the row; see `dev-reparse.ts`.
 */
const reparsedForDev = async (
  decision: ReadableDecision,
): Promise<ReadableDecision> => {
  if (!devReparseEnabled()) {
    return decision;
  }
  const documentAst = await reparseForDev({
    adapterKey: decision.source.adapterKey,
    caseNumber: decision.caseNumber,
    court: decision.court,
    decisionDate: decision.decisionDate,
    decisionType: decision.decisionType,
    documentUrl: decision.documentUrl,
    ecli: decision.ecli,
    id: decision.id,
    metadata: decision.metadata,
  });
  return documentAst === null
    ? decision
    : { ...decision, documentAst, documentPending: false, fulltext: null };
};

const hydrate = async (
  decision: ReadableDecision,
  recordDemand: boolean,
): Promise<ReadableDecision> => {
  // The local shared-corpus mode is strictly read-side. An incomplete remote
  // decision stays metadata-only instead of starting the ingestion path,
  // which would otherwise crawl the publisher and write through the local
  // ingestion database.
  if (envBase.PUBLIC_LAW_DATABASE_URL !== undefined) {
    return await reparsedForDev(decision);
  }

  if (
    !isDeferredDocumentFetchable({
      adapterKey: decision.source.adapterKey,
      documentUrl: decision.documentUrl,
      documentPending: decision.documentPending,
      documentReadFailed: decision.documentReadFailed,
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
    // Same omission the read applies to a stored AST: a document fetched
    // on demand must not answer with a fatter payload than a cached one.
    documentAst: omitDerivablePlainText(document.documentAst),
    documentPending: false,
    // Mirrors the read: text is the fallback for a decision without a
    // usable AST, and a parsed document always has one.
    fulltext: null,
  };
};

/**
 * The read's second phase: fetch the document when a reader arrives before
 * the ingestion queue does. A publisher fetch and an ingestion write, so it
 * runs after the gated read transaction has closed, never inside it.
 */
export const hydrateDeferredDocument = async (
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

export type ReadGatedDecisionOptions = {
  caseLawDb: CaseLawPublicReadDb;
  locator: DecisionSubjectLocator;
  caller: DecisionReadCaller;
  citationsCursor?: string | null | undefined;
};

/**
 * Gate, read, then hydrate — in that order and for that reason.
 *
 * The gate and every row of the read share one transaction, so the content
 * cannot come from a state the gate did not approve. Hydration is a
 * publisher fetch and an ingestion write, which must not hold a read-only
 * transaction open, so it runs once that transaction has closed.
 *
 * Null is "no such decision for the public": it does not exist, or its
 * source may not be redistributed.
 */
export const readGatedDecisionWithDocument = async ({
  caseLawDb,
  locator,
  caller,
  citationsCursor,
}: ReadGatedDecisionOptions): Promise<DecisionRead | null> => {
  const read = await withRedistributableSubject(
    caseLawDb,
    locator,
    async (subject) => await readDecisionHandler({ citationsCursor, subject }),
  );

  return read === null
    ? null
    : await hydrateDeferredDocument(read, caller === "attributed");
};
