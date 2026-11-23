import { Result } from "better-result";

import type { SignaturePreview } from "@stll/api-contract/signature";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { readSignatureFile } from "@/api/lib/files/read-signature-file";

const config = {
  contract: "patch",
  contentDelivery: { type: "audited" },
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: { type: "internal", reason: "upload_mechanics" },
  params: workspaceParams({ fieldId: resourceIdSchema("field") }),
} satisfies WorkspaceHandlerConfig;

/** Signers, the signed document, and the matter documents it appears to sign. */
export const signaturePreviewEndpoint = createSafeHandler(
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
          await readSignatureFile({
            fieldId,
            scopedDb,
            workspaceId,
            organizationId: session.activeOrganizationId,
            recordAuditEvent,
          }),
      ),
    );
    const read = yield* result;
    const preview: SignaturePreview = "type" in read ? read : read.preview;
    return Result.ok(preview);
  },
);
