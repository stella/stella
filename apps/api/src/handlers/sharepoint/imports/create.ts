import { Result } from "better-result";
import * as v from "valibot";

import { RESOURCE_TYPE } from "@stll/api-contract";
import { SHAREPOINT_IMPORT_MAX_ITEMS } from "@stll/api-contract/sharepoint";
import { Temporal } from "@stll/time";

import {
  sharepointDriveIdSchema,
  sharepointFileIdSchema,
} from "@/api/handlers/sharepoint/browse-input";
import {
  importSharepointFile,
  type SharepointImportResult,
} from "@/api/handlers/sharepoint/import-file";
import { withSharepointGraph } from "@/api/handlers/sharepoint/session";
import { detached } from "@/api/lib/analytics/capture";
import {
  ACCOUNT_ACCESS,
  createSafeHandler,
  type WorkspaceHandlerConfig,
} from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { maybeStartUploadTriggeredFlows } from "@/api/lib/flows/maybe-start-upload-triggered-flows";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
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
    "importing it again adds a version only when its content changed in " +
    "SharePoint, otherwise it is a no-op. Returns one result per file; a " +
    "failed file does not stop the others, and files the request had no " +
    "time left for come back deferred: send those again.",
  permissions: { workspace: ["read"], entity: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "provider_secret" },
  body: requestBody,
} satisfies WorkspaceHandlerConfig;

const uploadFlowsFailure = failureSink({
  event: "sharepoint_import.upload_flows_failed",
  expected: [],
});

const startUploadFlows = (
  args: Parameters<typeof maybeStartUploadTriggeredFlows>[0],
): void => {
  detached(
    async () =>
      maybeStartUploadTriggeredFlows(args).catch((error: unknown) => {
        observeFailure(error, {
          sink: uploadFlowsFailure,
          ctx: { workspaceId: args.workspaceId },
        });
      }),
    "sharepoint-import.maybe-start-upload-triggered-flows",
  );
};

/**
 * How long one request keeps starting files. The load balancer drops a
 * response that stays silent for 60 s, so files not started by then come
 * back `deferred` for the caller to send again; the import is idempotent, so
 * a resend converges.
 */
const SHAREPOINT_IMPORT_TIME_BUDGET_MS = 40_000;

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
    const startedAtMs = Temporal.Now.instant().epochMilliseconds;

    const results = yield* Result.await(
      withSharepointGraph({
        organizationId,
        userId: user.id,
        safeDb,
        call: async (accessToken) =>
          await Result.gen(async function* () {
            const imported: SharepointImportResult[] = [];
            for (const ref of refs) {
              if (
                Temporal.Now.instant().epochMilliseconds - startedAtMs >
                SHAREPOINT_IMPORT_TIME_BUDGET_MS
              ) {
                imported.push({ ...ref, status: "deferred" });
                continue;
              }
              // db-await-in-loop: one file at a time bounds memory to a single document; the request caps files at SHAREPOINT_IMPORT_MAX_ITEMS
              const result = yield* Result.await(
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
              );
              // Started per document as it commits: a later file that ends
              // the request (throttling, a revoked grant) must not skip the
              // flows of documents already created, and a retry reports those
              // as unchanged.
              if (result.status === "created") {
                startUploadFlows({
                  entityId: result.entityId,
                  fileName: result.name,
                  organizationId,
                  workspaceId,
                });
              }
              imported.push(result);
            }
            return Result.ok(imported);
          }),
      }),
    );

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
    "Each file is written through the document create and version owners, which lock the rows they change; a repeated import converges on the stored content digest.",
});

export default importSharepointFiles;
