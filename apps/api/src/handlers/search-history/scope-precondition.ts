import { Result } from "better-result";
import { t } from "elysia";

import {
  tDefaultVarchar,
  tUserId,
  withDescription,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

export const searchHistoryScopeQuery = t.Object({
  expectedOrganizationId: withDescription(
    tDefaultVarchar,
    "The organizationId from search-history.list.scope. A changed active organization rejects the mutation; this never selects another owner.",
  ),
  expectedUserId: withDescription(
    tUserId,
    "The userId from search-history.list.scope. A changed signed-in user rejects the mutation; this never selects another owner.",
  ),
});

type SearchHistoryScopePrecondition = {
  query: typeof searchHistoryScopeQuery.static;
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
