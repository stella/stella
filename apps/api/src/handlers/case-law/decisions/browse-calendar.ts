import { Result } from "better-result";

import {
  readBrowseCalendarHandler,
  readBrowseCalendarQuerySchema,
} from "@/api/handlers/case-law/decisions/browse-hubs";
import { browseCalendarResponseSchema } from "@/api/handlers/case-law/public-response-schemas";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { withPublicCountryUnavailable } from "@/api/lib/legal-search/public-law-country";
import { projectResponseText } from "@/api/lib/search/project-response-text";

/** The periods below one level of a court's crawlable browse tree. */
export const createBrowseCalendarRoute = (caseLawDb = caseLawPublicReadDb) =>
  createSafeBoundedPublicHandler(
    {
      contract: "patch",
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "public_indexing" },
      cache: { kind: "none" },
      response: withPublicCountryUnavailable(
        safePublicHandlerResponseSchemasWithStatusText(
          browseCalendarResponseSchema,
        ),
      ),
      query: readBrowseCalendarQuerySchema,
    },
    async function* ({ query }) {
      const response = yield* Result.await(
        Result.tryPromise(
          async () => await readBrowseCalendarHandler(query, caseLawDb),
        ),
      );
      return Result.ok(
        projectResponseText(response, browseCalendarResponseSchema),
      );
    },
  );

const readBrowseCalendar = createBrowseCalendarRoute();

export default readBrowseCalendar;
