import { Result } from "better-result";
import * as v from "valibot";

import {
  SHAREPOINT_DEFAULT_PAGE_SIZE,
  sharepointCursorSchema,
  sharepointLimitSchema,
  sharepointSiteIdSchema,
} from "@/api/handlers/sharepoint/browse-input";
import { listSharepointDrives } from "@/api/handlers/sharepoint/graph-client";
import { withSharepointGraph } from "@/api/handlers/sharepoint/session";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";

const requestQuery = v.strictObject({
  siteId: v.optional(sharepointSiteIdSchema),
  cursor: v.optional(sharepointCursorSchema),
  limit: v.optional(sharepointLimitSchema),
});

const config = {
  contract: "patch",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  description:
    "List the document libraries of a SharePoint site (siteId from sharepoint.sites.list), or the caller's own OneDrive when siteId is omitted. Pass a drive id to sharepoint.drives.items.list to browse it.",
  mcp: {
    type: "capability",
    reason: "document_processing",
    readClass: "tenant",
    consumesServices: false,
  },
  access: "read",
  query: requestQuery,
} satisfies HandlerConfig;

// Drives the signed-in person can see, read with their delegated grant: a
// site's document libraries when `siteId` is given, otherwise their own
// OneDrive.
const listSharepointDrivesHandler = createSafeRootHandler(
  config,
  async function* ({ query, safeDb, session, user }) {
    const page = yield* Result.await(
      withSharepointGraph({
        organizationId: session.activeOrganizationId,
        userId: user.id,
        safeDb,
        call: async (accessToken) =>
          await listSharepointDrives({
            accessToken,
            siteId: query.siteId ?? null,
            cursor: query.cursor ?? null,
            limit: normalizeTenantPageLimit(
              query.limit ?? SHAREPOINT_DEFAULT_PAGE_SIZE,
            ),
          }),
      }),
    );
    return Result.ok(page);
  },
);

export default listSharepointDrivesHandler;
