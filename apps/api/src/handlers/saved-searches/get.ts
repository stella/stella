import { Result } from "better-result";

import { SAVED_SEARCH_NOT_FOUND_ERROR_CODE } from "@stll/api-contract";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { toSavedSearchResponse } from "./response";
import { savedSearchParamsSchema } from "./schema";

const config = {
  contract: "patch",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: { type: "internal", reason: "search_ui" },
  params: savedSearchParamsSchema,
} satisfies HandlerConfig;

const getSavedSearch = createSafeRootHandler(
  config,
  async function* ({ params, safeDb, session, user }) {
    const savedSearch = yield* Result.await(
      safeDb(async (tx) =>
        tx.query.savedSearches.findFirst({
          where: {
            id: { eq: params.savedSearchId },
            organizationId: { eq: session.activeOrganizationId },
            userId: { eq: user.id },
          },
        }),
      ),
    );
    if (!savedSearch) {
      return Result.err(
        new HandlerError({
          status: 404,
          code: SAVED_SEARCH_NOT_FOUND_ERROR_CODE,
          message: "Saved search not found",
        }),
      );
    }
    return Result.ok(toSavedSearchResponse(savedSearch));
  },
);

export default getSavedSearch;
