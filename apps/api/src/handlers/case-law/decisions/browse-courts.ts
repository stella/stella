import { Result } from "better-result";

import {
  listBrowseCourtsHandler,
  listBrowseCourtsQuerySchema,
} from "@/api/handlers/case-law/decisions/browse-hubs";
import { browseCourtsResponseSchema } from "@/api/handlers/case-law/public-response-schemas";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { withPublicCountryUnavailable } from "@/api/lib/legal-search/public-law-country";
import { projectResponseText } from "@/api/lib/search/project-response-text";

/** The courts of a jurisdiction's crawlable browse tree. */
export const createBrowseCourtsRoute = (caseLawDb = caseLawPublicReadDb) =>
  createSafeBoundedPublicHandler(
    {
      contract: "patch",
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "public_indexing" },
      cache: { kind: "none" },
      response: withPublicCountryUnavailable(
        safePublicHandlerResponseSchemasWithStatusText(
          browseCourtsResponseSchema,
        ),
      ),
      query: listBrowseCourtsQuerySchema,
    },
    async function* ({ query }) {
      const response = yield* Result.await(
        Result.tryPromise(
          async () => await listBrowseCourtsHandler(query, caseLawDb),
        ),
      );
      return Result.ok(
        projectResponseText(response, browseCourtsResponseSchema),
      );
    },
  );

const listBrowseCourts = createBrowseCourtsRoute();

export default listBrowseCourts;
