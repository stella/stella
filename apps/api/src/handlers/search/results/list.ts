import { Result } from "better-result";

import { searchBodySchema, searchHandler } from "@/api/handlers/search/search";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

/** `POST /v1/search`: results across the matters the caller can open. */
const searchResults = createSafeRootHandler(
  {
    contract: "patch",
    description:
      "Search the active organization across the matters you can open, by " +
      "text and filters: matters, result types, editors, file types and an " +
      "update date range. A search needs a query or at least one filter " +
      "besides matters. Pass `cursor` from `nextCursor` for the next page.",
    access: "read",
    permissions: { workspace: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "tool", name: "search" },
    body: searchBodySchema,
  } satisfies HandlerConfig,
  async function* ({ body, getActiveWorkspaceIds, scopedDb, session, user }) {
    const activeWorkspaceIds = yield* Result.await(
      Result.tryPromise(async () => await getActiveWorkspaceIds()),
    );
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await searchHandler({
            organizationId: session.activeOrganizationId,
            userId: user.id,
            accessibleWorkspaceIds: activeWorkspaceIds,
            grantedScopes: session.grantedScopes,
            body,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

export default searchResults;
