import { Result } from "better-result";
import * as v from "valibot";

import { sharepointCursorSchema } from "@/api/handlers/sharepoint/browse-input";
import { listSharepointSites } from "@/api/handlers/sharepoint/graph-client";
import { withSharepointGraph } from "@/api/handlers/sharepoint/session";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";

const requestQuery = v.strictObject({
  search: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.minLength(1),
      v.maxLength(200),
      v.description(
        "Words to find sites by name; omit to list the sites the user follows",
      ),
    ),
  ),
  cursor: v.optional(sharepointCursorSchema),
});

const config = {
  contract: "patch",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  description:
    "List the SharePoint sites the caller follows, or find sites by name with search. Read with the caller's own connected Microsoft account, so it shows only sites they can open. Pass a site id to sharepoint.drives.list for its document libraries.",
  mcp: {
    type: "capability",
    reason: "document_processing",
    readClass: "tenant",
    consumesServices: false,
  },
  access: "read",
  query: requestQuery,
} satisfies HandlerConfig;

// SharePoint sites the signed-in person follows, or the sites a search finds,
// read with that person's delegated grant.
const listSharepointSitesHandler = createSafeRootHandler(
  config,
  async function* ({ query, safeDb, session, user }) {
    const page = yield* Result.await(
      withSharepointGraph({
        organizationId: session.activeOrganizationId,
        userId: user.id,
        safeDb,
        call: async (accessToken) =>
          await listSharepointSites({
            accessToken,
            search: query.search ?? null,
            cursor: query.cursor ?? null,
          }),
      }),
    );
    return Result.ok(page);
  },
);

export default listSharepointSitesHandler;
