import { Result } from "better-result";

import {
  legalCitationLinksBodySchema,
  legalCitationLinksHandler,
  legalCitationLinksSuccessResponseSchema,
} from "@/api/handlers/legal-citation-links/links";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { legislationPublicReadDb } from "@/api/lib/legislation-public-read-db";

/**
 * The links a finished chat answer's legal citations open. A POST only
 * because an answer is too long for a query string: it reads the public
 * corpus and writes nothing.
 */
const legalCitationLinksEndpoint = createSafeBoundedPublicHandler(
  {
    contract: "patch",
    response: safePublicHandlerResponseSchemasWithStatusText(
      legalCitationLinksSuccessResponseSchema,
    ),
    accountAccess: ACCOUNT_ACCESS.sandbox,
    // Links over a rendered chat answer are thread UI; an agent reads the
    // same statutes and decisions through read_statute and the case-law tools.
    mcp: { type: "internal", reason: "chat_thread_ui" },
    cache: { kind: "none" },
    body: legalCitationLinksBodySchema,
  },
  async function* ({ body }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await legalCitationLinksHandler(body, {
            legislationDb: legislationPublicReadDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

declareAggregateMutation(legalCitationLinksEndpoint.handler, {
  type: "independent",
  reason:
    "Read-only: resolves citations against the public corpus and writes nothing.",
});

export default legalCitationLinksEndpoint;
