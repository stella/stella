import * as v from "valibot";

import { sessionSignInReviewBodySchema } from "@stll/api-contract/session-sign-ins";

import { routeSearchSchema } from "@/route-search-params";

/*
 * The route file and its loader stay in the entry graph, so the search
 * schema lives apart from the page's device logic, which loads with the
 * page.
 */

/**
 * `review` names the sign-in the new-device email asked about; a malformed
 * value falls back to no review rather than failing the page.
 */
export const securitySearchSchema = routeSearchSchema({
  review: v.fallback(
    v.optional(sessionSignInReviewBodySchema.entries.sessionId),
    undefined,
  ),
});
