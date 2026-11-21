import * as v from "valibot";

import { userIdSchema } from "@stll/api-contract/safe-id";
import { parsePlainDate } from "@stll/time";

import { routeSearchSchema } from "@/route-search-params";

/**
 * The approvals page's search: the week by any of its dates, and the person
 * and matter filters. A person is named by their user id, which is an opaque
 * string; a matter is a UUID.
 */
export const timeApprovalsSearchSchema = routeSearchSchema({
  date: v.optional(
    v.pipe(
      v.string(),
      v.check((date) => parsePlainDate(date) !== null),
    ),
  ),
  member: v.optional(userIdSchema),
  matter: v.optional(v.pipe(v.string(), v.uuid())),
});
