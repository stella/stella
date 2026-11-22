import { Result } from "better-result";

import { FILE_PART_KINDS } from "@stll/api-contract/file-parts";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { readCadesPreview } from "@/api/lib/files/cades-preview";
import { readFilePart } from "@/api/lib/files/file-part";
import { readLegalFilePreview } from "@/api/lib/files/read-legal-file-preview";
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
      Result.tryPromise(
        async () =>
          await readFilePart({
            fieldId,
            scopedDb,
            workspaceId,
            organizationId: session.activeOrganizationId,
            recordAuditEvent,
            part: { kind: FILE_PART_KINDS.content, index: 0 },
            disposition: "inline",
          }),
      ),
    );
    const { bytes, fileName, mimeType } = yield* result;
    return Result.ok(
      secureDocumentResponse({
        body: new Uint8Array(bytes),
        contentType: mimeType,
        contentLength: bytes.byteLength,
        disposition: "inline",
        fileName: sanitizeFilename(fileName),
      }),
    );
  },
);
