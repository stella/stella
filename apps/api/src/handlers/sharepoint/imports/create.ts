import { Result } from "better-result";
import * as v from "valibot";

import { RESOURCE_TYPE } from "@stll/api-contract";
import { SHAREPOINT_IMPORT_MAX_ITEMS } from "@stll/api-contract/sharepoint";

import {
  sharepointDriveIdSchema,
  sharepointFileIdSchema,
} from "@/api/handlers/sharepoint/browse-input";
import {
  importSharepointFile,
  type SharepointImportResult,
} from "@/api/handlers/sharepoint/import-file";
import { withSharepointGraph } from "@/api/handlers/sharepoint/session";
import { captureError, detached } from "@/api/lib/analytics/capture";
import {
  ACCOUNT_ACCESS,
  createSafeHandler,
  type WorkspaceHandlerConfig,
} from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { maybeStartUploadTriggeredFlows } from "@/api/lib/flows/maybe-start-upload-triggered-flows";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { broadcastOrganizationResourceSetUpdated } from "@/api/lib/resource-realtime";

const requestBody = v.object({
  items: v.pipe(
    v.array(
      v.object({
        driveId: sharepointDriveIdSchema,
        itemId: sharepointFileIdSchema,
      }),
    ),
    v.minLength(1),
    v.maxLength(SHAREPOINT_IMPORT_MAX_ITEMS),
    v.description(
      `Files to copy into the matter, at most ${SHAREPOINT_IMPORT_MAX_ITEMS}; folders are not imported`,
    ),
  ),
  parentId: v.optional(
    v.nullable(
      v.pipe(
        resourceIdSchema("entity"),
        v.description("Folder in the matter to put new documents in"),
      ),
    ),
  ),
});

const config = {
  contract: "patch",
  contentDelivery: {
    type: "none",
    reason:
      "Copies SharePoint files into documents without returning stored-file bytes.",
  },
  description:
    "Copy SharePoint or OneDrive files into a matter as documents, read with " +
    "the caller's own Microsoft grant. Each file is a one-way snapshot: " +
    "importing it again adds a version only when it changed in SharePoint. " +
    "Returns one result per file; a failed file does not stop the others.",
  permissions: { workspace: ["read"], entity: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "provider_secret" },
  body: requestBody,
} satisfies WorkspaceHandlerConfig;

const refKey = ({ driveId, itemId }: { driveId: string; itemId: string }) =>
  `${driveId}\u0000${itemId}`;

const importSharepointFiles = createSafeHandler(
  config,
  async function* ({
    body: { items, parentId },
    getWorkspaceAccess,
    memberRole,
    recordAuditEvent,
    safeDb,
    scopedDb,
    session,
    user,
    workspaceId,
  }) {
    const organizationId = session.activeOrganizationId;
    const refs = [...new Map(items.map((ref) => [refKey(ref), ref])).values()];
    const workspace = await getWorkspaceAccess(workspaceId);

    const results = yield* Result.await(
      withSharepointGraph({
        organizationId,
        userId: user.id,
        safeDb,
        call: async (accessToken) =>
          await Result.gen(async function* () {
            const imported: SharepointImportResult[] = [];
            // One file at a time bounds memory to a single document.
            for (const ref of refs) {
              imported.push(
                yield* Result.await(
                  importSharepointFile({
                    accessToken,
                    ref,
                    target: {
                      safeDb,
                      scopedDb,
                      organizationId,
                      workspaceId,
                      workspace,
                      userId: user.id,
                      memberRole,
                      recordAuditEvent,
                      parentId: parentId ?? null,
                    },
                  }),
                ),
              );
            }
            return Result.ok(imported);
          }),
      }),
    );

    for (const result of results) {
      if (result.status !== "created") {
        continue;
      }
      detached(
        async () =>
          maybeStartUploadTriggeredFlows({
            entityId: result.entityId,
            workspaceId,
            organizationId,
            fileName: result.name,
          }).catch((error: unknown) => {
            captureError(
              error,
              handlerErrorContext("sharepointImport.uploadFlows", {
                entityId: result.entityId,
                workspaceId,
              }),
            );
          }),
        "sharepoint-import.maybe-start-upload-triggered-flows",
      );
    }
    if (results.some(({ status }) => status === "created")) {
      broadcastOrganizationResourceSetUpdated(
        organizationId,
        RESOURCE_TYPE.WORKSPACE,
      );
    }

    return Result.ok({ results });
  },
);

declareAggregateMutation(importSharepointFiles, {
  type: "independent",
  reason:
    "Each file is written through the document create and version owners, which lock the rows they change; a repeated import converges on the stored SharePoint ETag.",
});

export default importSharepointFiles;
