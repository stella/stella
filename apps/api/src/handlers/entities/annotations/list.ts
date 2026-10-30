/**
 * The highlights and comments on one matter document's PDF that the caller
 * can see, while the viewer shows one file of the document.
 */

import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import {
  paginationCursorSchema,
  paginationLimitSchema,
  resourceIdSchema,
  workspaceParams,
} from "@/api/lib/custom-schema";
import { listMatterDocumentAnnotations } from "@/api/lib/legal-search/reader-annotations/matter-document-list";
import { LIMITS } from "@/api/lib/limits";

const config = {
  contract: "patch",
  description:
    "List the highlights and comments on a matter document's PDF that the " +
    "user can see (their own, and those colleagues on the matter shared), " +
    "oldest first with cursor pagination. `fieldId` is the file being read; " +
    "marks placed on the same file of another version are included and name " +
    "the version and the page digest they were placed on.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: { type: "internal", reason: "document_processing" },
  params: workspaceParams({
    entityId: resourceIdSchema("entity"),
    fieldId: resourceIdSchema("field"),
  }),
  query: v.object({
    cursor: v.optional(paginationCursorSchema()),
    limit: v.optional(
      numberFromString(
        paginationLimitSchema(LIMITS.readerAnnotationsPageSizeMax),
      ),
    ),
  }),
} satisfies WorkspaceHandlerConfig;

const listDocumentAnnotations = createSafeHandler(
  config,
  async function* ({
    params: { entityId, fieldId },
    query: { cursor, limit },
    safeDb,
    session,
    user,
    workspaceId,
  }) {
    return yield* listMatterDocumentAnnotations({
      cursor,
      entityId,
      fieldId,
      limit,
      organizationId: session.activeOrganizationId,
      safeDb,
      userId: user.id,
      workspaceId,
    });
  },
);

export default listDocumentAnnotations;
