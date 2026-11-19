import { Result } from "better-result";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { readCadesPdf, readCadesPreview } from "@/api/lib/files/cades-preview";
import { readCadesFile } from "@/api/lib/files/read-cades-file";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { secureDocumentResponse } from "@/api/lib/secure-document-response";

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
      Result.tryPromise(() =>
        readCadesFile(
          {
            fieldId,
            scopedDb,
            workspaceId,
            organizationId: session.activeOrganizationId,
            recordAuditEvent,
          },
          readCadesPreview,
        ),
      ),
    );
    return Result.ok(yield* result);
  },
);

export const cadesContentEndpoint = createSafeHandler(
  config,
  async function* ({
    params: { fieldId },
    scopedDb,
    workspaceId,
    session,
    recordAuditEvent,
  }) {
    const result = yield* Result.await(
      Result.tryPromise(() =>
        readCadesFile(
          {
            fieldId,
            scopedDb,
            workspaceId,
            organizationId: session.activeOrganizationId,
            recordAuditEvent,
          },
          readCadesPdf,
        ),
      ),
    );
    const bytes = yield* result;
    return Result.ok(
      secureDocumentResponse({
        body: new Uint8Array(bytes),
        contentType: "application/pdf",
        contentLength: bytes.byteLength,
        disposition: "inline",
        fileName: sanitizeFilename("document.pdf"),
      }),
    );
  },
);
