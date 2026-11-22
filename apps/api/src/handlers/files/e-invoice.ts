import { Result } from "better-result";
import * as v from "valibot";

import { FILE_PART_KINDS } from "@stll/api-contract/file-parts";
import { numberFromString } from "@stll/api-contract/http-input";
import { E_INVOICE_KINDS } from "@stll/api-contract/legal-file-formats";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { readEInvoicePreview } from "@/api/lib/files/e-invoice-preview";
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

export const eInvoicePreviewEndpoint = createSafeHandler(
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
            E_INVOICE_KINDS,
            readEInvoicePreview,
          ),
      ),
    );
    return Result.ok(yield* result);
  },
);

const MAX_ATTACHMENT_INDEX = 9999;

const attachmentConfig = {
  contract: "patch",
  contentDelivery: { type: "audited" },
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: { type: "internal", reason: "upload_mechanics" },
  params: workspaceParams({
    fieldId: resourceIdSchema("field"),
    index: numberFromString(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(0),
        v.maxValue(MAX_ATTACHMENT_INDEX),
      ),
    ),
  }),
} satisfies WorkspaceHandlerConfig;

export const eInvoiceAttachmentEndpoint = createSafeHandler(
  attachmentConfig,
  async function* ({
    params: { fieldId, index },
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
            part: { kind: FILE_PART_KINDS.attachment, index },
            disposition: "attachment",
          }),
      ),
    );
    const { bytes, fileName, mimeType: contentType } = yield* result;
    return Result.ok(
      secureDocumentResponse({
        body: new Uint8Array(bytes),
        contentType,
        contentLength: bytes.byteLength,
        disposition: "attachment",
        fileName: sanitizeFilename(fileName),
      }),
    );
  },
);
