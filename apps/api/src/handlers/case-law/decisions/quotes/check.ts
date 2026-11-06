import { classifyFailure } from "@stll/errors";

import { readDecisionHandler } from "@/api/handlers/case-law/decisions/get";
import {
  hydrateDeferredDocument,
  readsSharedPublicLawCorpus,
  STORED_ONLY_DOCUMENT_HYDRATION,
} from "@/api/handlers/case-law/decisions/get-deferred-document";
import {
  createSafePublicSubjectFollowUpHandler,
  DECISION_NOT_FOUND,
} from "@/api/handlers/case-law/decisions/public-subject";
import { verifyDecisionQuotation } from "@/api/handlers/case-law/decisions/quotes/verification";
import { status } from "@/api/http/status";
import {
  ACCOUNT_ACCESS,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import { observedStatus } from "@/api/lib/observability/server-error-answer";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";
import { projectResponseText } from "@/api/lib/search/project-response-text";
import { isReadCaseLawDecisionSuccess } from "@/api/mcp/public-law-handlers";
import { handlerStatusOf } from "@/api/mcp/tool-utils";
import {
  verifyQuoteArgsSchema,
  verifyQuoteOutputSchema,
} from "@/api/mcp/verify-quote-tools";

const QUOTE_DECISION_UNREADABLE = failureSink({
  event: "case_law.quote_decision_unreadable",
  expected: [],
});

const config = {
  description:
    "Check whether a quotation occurs word for word in one stored decision. Answers with its exact occurrences, the closest passage and differences for an altered quote, or that the text cannot be verified.",
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  // The route serves the public site; agents reach the same check through the
  // curated `verify_quote` tool, as they reach citations through theirs.
  mcp: { type: "internal", reason: "public_indexing" },
  cache: { kind: "none" },
  access: "read",
  body: verifyQuoteArgsSchema,
  response: safePublicHandlerResponseSchemasWithStatusText(
    verifyQuoteOutputSchema,
  ),
} satisfies PublicHandlerConfig;

type VerifyQuotationDependencies = {
  caseLawDb?: CaseLawPublicReadDb;
  readSharedCorpus?: typeof readsSharedPublicLawCorpus;
};

export const createVerifyQuotationHandler = ({
  caseLawDb = caseLawPublicReadDb,
  readSharedCorpus = readsSharedPublicLawCorpus,
}: VerifyQuotationDependencies = {}) =>
  createSafePublicSubjectFollowUpHandler({
    config,
    caseLawDb,
    locate: ({ body }) => ({
      kind: "id",
      id: brandPersistedCaseLawDecisionId(body.decision_id),
    }),
    read: async (subject) =>
      await readDecisionHandler({ subject, citationsCursor: null }),
    // Anonymous and stored-only: no demand is recorded and no publisher is
    // fetched, so this runs nothing beyond what the gated read returned.
    followUp: async (gatedRead, { body }) => {
      const read = await hydrateDeferredDocument(
        gatedRead,
        false,
        STORED_ONLY_DOCUMENT_HYDRATION,
      );
      const readStatus = handlerStatusOf(read);
      // The subject existed moments ago; a redaction can race the read.
      if (readStatus?.code === 404) {
        return status(404, DECISION_NOT_FOUND);
      }
      if (!isReadCaseLawDecisionSuccess(read)) {
        return observedStatus(
          {
            sink: QUOTE_DECISION_UNREADABLE,
            cause: classifyFailure(
              new HandlerError({
                status: 503,
                code: "QUOTE_DECISION_UNREADABLE",
                message: `Decision read answered ${readStatus?.code ?? "without a status"}`,
              }),
              "response_invalid",
            ),
          },
          503,
          { message: "The stored decision could not be read." },
        );
      }
      return projectResponseText(
        verifyDecisionQuotation({
          read,
          quote: body.text,
          readSharedCorpus,
        }),
        verifyQuoteOutputSchema,
      );
    },
  });

const verifyQuotation = createVerifyQuotationHandler();
export default verifyQuotation;
