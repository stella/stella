import { Result } from "better-result";

import type { LegalFileFormatKind } from "@stll/api-contract/legal-file-formats";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import { readLegalFilePreview } from "@/api/lib/files/read-legal-file-preview";

const config = {
  contract: "patch",
  contentDelivery: { type: "audited" },
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: { type: "internal", reason: "upload_mechanics" },
  params: workspaceParams({ fieldId: resourceIdSchema("field") }),
} satisfies WorkspaceHandlerConfig;

export const createArchivePreviewEndpoint = <T>(
  kinds: readonly LegalFileFormatKind[],
  read: (
    source: ScannedFile,
  ) => Promise<Result<T, HandlerError<422 | 500 | 503>>>,
) =>
  createSafeHandler(
    config,
    async function* ({
      params: { fieldId },
      scopedDb,
      workspaceId,
      session,
      recordAuditEvent,
    }) {
      const result = yield* Result.await(
        Result.tryPromise(
          async () =>
            await readLegalFilePreview(
              {
                fieldId,
                scopedDb,
                workspaceId,
                organizationId: session.activeOrganizationId,
                recordAuditEvent,
              },
              kinds,
              read,
            ),
        ),
      );
      return Result.ok(yield* result);
    },
  );
