import { Result } from "better-result";

import {
  searchFacetsBodySchema,
  searchFacetsHandler,
} from "@/api/handlers/search/facets";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

/** `POST /v1/search/facets`: one filter's values across the caller's matters. */
const searchFacets = createSafeRootHandler(
  {
    contract: "patch",
    access: "read",
    permissions: { workspace: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "search_ui" },
    body: searchFacetsBodySchema,
  } satisfies HandlerConfig,
  async function* ({ body, getActiveWorkspaceIds, scopedDb, session }) {
    const activeWorkspaceIds = yield* Result.await(
      Result.tryPromise(async () => await getActiveWorkspaceIds()),
    );
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await searchFacetsHandler({
            organizationId: session.activeOrganizationId,
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

export default searchFacets;
