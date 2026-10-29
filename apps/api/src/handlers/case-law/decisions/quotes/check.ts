import { Result } from "better-result";

import {
  readsSharedPublicLawCorpus,
  STORED_ONLY_DOCUMENT_HYDRATION,
} from "@/api/handlers/case-law/decisions/get-deferred-document";
import { verifyDecisionQuotation } from "@/api/handlers/case-law/decisions/quotes/verification";
import { status } from "@/api/http/status";
import type { HttpStatusResponse } from "@/api/http/status";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import type {
  PublicHandlerConfig,
  SafeHandlerGenerator,
} from "@/api/lib/api-handlers";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";
import {
  defaultReadGatedDecisionWithDocument,
  isReadCaseLawDecisionSuccess,
} from "@/api/mcp/public-law-handlers";
import { handlerStatusOf } from "@/api/mcp/tool-utils";
import {
  verifyQuoteArgsSchema,
  verifyQuoteOutputSchema,
} from "@/api/mcp/verify-quote-tools";

const config = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "tool", name: "verify_quote" },
  cache: { kind: "none" },
  access: "read",
  body: verifyQuoteArgsSchema,
  response: safePublicHandlerResponseSchemasWithStatusText(
    verifyQuoteOutputSchema,
  ),
} satisfies PublicHandlerConfig;

type VerifyQuotationDependencies = {
  readDecision?: typeof defaultReadGatedDecisionWithDocument;
  readSharedCorpus?: typeof readsSharedPublicLawCorpus;
};

type VerifyQuotationResponse =
  | ReturnType<typeof verifyDecisionQuotation>
  | HttpStatusResponse<404, { message: string }>
  | HttpStatusResponse<503, { message: string }>;

export const createVerifyQuotationHandler = ({
  readDecision = defaultReadGatedDecisionWithDocument,
  readSharedCorpus = readsSharedPublicLawCorpus,
}: VerifyQuotationDependencies = {}) =>
  createSafeBoundedPublicHandler(
    config,
    async function* ({ body }): SafeHandlerGenerator<VerifyQuotationResponse> {
      const read = yield* Result.await(
        Result.tryPromise(
          async () =>
            await readDecision({
              caseLawDb: caseLawPublicReadDb,
              locator: {
                kind: "id",
                id: brandPersistedCaseLawDecisionId(body.decision_id),
              },
              citationsCursor: null,
              caller: "anonymous",
              documentHydration: STORED_ONLY_DOCUMENT_HYDRATION,
              surface: "identity",
            }),
        ),
      );
      if (read === null || handlerStatusOf(read)?.code === 404) {
        return Result.ok(status(404, { message: "Decision not found" }));
      }
      if (!isReadCaseLawDecisionSuccess(read)) {
        return Result.ok(
          status(503, { message: "The stored decision could not be read." }),
        );
      }
      return Result.ok(
        verifyDecisionQuotation({ read, quote: body.text, readSharedCorpus }),
      );
    },
  );

const verifyQuotation = createVerifyQuotationHandler();
export default verifyQuotation;
