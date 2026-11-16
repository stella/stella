import { Result } from "better-result";
import * as v from "valibot";

import {
  SHAREPOINT_DEFAULT_PAGE_SIZE,
  sharepointCursorSchema,
  sharepointDriveIdSchema,
  sharepointFolderIdSchema,
  sharepointLimitSchema,
} from "@/api/handlers/sharepoint/browse-input";
import { listSharepointChildren } from "@/api/handlers/sharepoint/graph-client";
import { withSharepointGraph } from "@/api/handlers/sharepoint/session";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";

const requestParams = v.strictObject({
  driveId: sharepointDriveIdSchema,
  itemId: sharepointFolderIdSchema,
});

const requestQuery = v.strictObject({
  cursor: v.optional(sharepointCursorSchema),
  limit: v.optional(sharepointLimitSchema),
});

const config = {
  contract: "patch",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  description:
    'List the files and folders directly inside one folder of a drive; use itemId "root" for the top level. Not recursive. Items of kind file can be copied into a matter with sharepoint.imports.create.',
  mcp: {
    type: "capability",
    reason: "document_processing",
    readClass: "tenant",
    consumesServices: false,
  },
  access: "read",
  params: requestParams,
  query: requestQuery,
} satisfies HandlerConfig;

// The files and folders directly inside one folder of a drive, read with the
// signed-in person's delegated grant. Not recursive.
const listSharepointDriveItemsHandler = createSafeRootHandler(
  config,
  async function* ({ params, query, safeDb, session, user }) {
    const page = yield* Result.await(
      withSharepointGraph({
        organizationId: session.activeOrganizationId,
        userId: user.id,
        safeDb,
        call: async (accessToken) =>
          await listSharepointChildren({
            accessToken,
            driveId: params.driveId,
            itemId: params.itemId,
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

export default listSharepointDriveItemsHandler;
