import { Result } from "better-result";
import * as v from "valibot";

import {
  defaultVarcharSchema,
  userIdSchema,
  withDescription,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

export const searchHistoryScopeQuery = v.object({
  expectedOrganizationId: withDescription(
    defaultVarcharSchema,
    "The organizationId from search-history.list.scope. A changed active organization rejects the mutation; this never selects another owner.",
  ),
  expectedUserId: withDescription(
    userIdSchema,
    "The userId from search-history.list.scope. A changed signed-in user rejects the mutation; this never selects another owner.",
  ),
});

type SearchHistoryScopePrecondition = {
  query: v.InferOutput<typeof searchHistoryScopeQuery>;
  userId: string;
  organizationId: string;
};

/** Check the originating scope before encryption, persistence or auditing. */
export const assertSearchHistoryScope = ({
  query,
  userId,
  organizationId,
}: SearchHistoryScopePrecondition) => {
  if (
    query.expectedUserId !== userId ||
    query.expectedOrganizationId !== organizationId
  ) {
    return Result.err(
      new HandlerError({
        status: 409,
        message:
          "Your signed-in scope changed. List history again with search-history.list and use its scope for this mutation.",
      }),
    );
  }
  return Result.ok(undefined);
};
