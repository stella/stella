import { Result } from "better-result";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { readCadesPreview } from "@/api/lib/files/cades-preview";
import {
  readingZipNames,
  readLegalFilePreview,
} from "@/api/lib/files/read-legal-file-preview";

const config = {
  contract: "patch",
  contentDelivery: { type: "audited" },
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: { type: "internal", reason: "upload_mechanics" },
  params: workspaceParams({ fieldId: resourceIdSchema("field") }),
} satisfies WorkspaceHandlerConfig;

export const cadesPreviewEndpoint = createSafeHandler(
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
            ["cades"],
            readingZipNames(readCadesPreview),
          ),
      ),
    );
    return Result.ok(yield* result);
  },
);
