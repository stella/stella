import { Result } from "better-result";
import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";
import { E_INVOICE_KINDS } from "@stll/api-contract/legal-file-formats";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import {
  readEInvoiceAttachment,
  readEInvoicePreview,
} from "@/api/lib/files/e-invoice-preview";
import { loadLegalFileSource } from "@/api/lib/files/legal-file-source";
import { readLegalFilePreview } from "@/api/lib/files/read-legal-file-preview";
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

// A signed `.xml.p7m` invoice lists the same attachments in its CAdES preview.
const ATTACHMENT_SOURCE_KINDS = [...E_INVOICE_KINDS, "cades"] as const;
const MAX_ATTACHMENT_INDEX = 9999;

const attachmentConfig = {
  ...config,
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
    const loaded = yield* Result.await(
      Result.tryPromise(
        async () =>
          await loadLegalFileSource(
            {
              fieldId,
              scopedDb,
              workspaceId,
              organizationId: session.activeOrganizationId,
              recordAuditEvent,
            },
            ATTACHMENT_SOURCE_KINDS,
          ),
      ),
    );
    const { source, mimeType, deliver } = yield* loaded;
    const attachment = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readEInvoiceAttachment(index)(source.withMimeType(mimeType)),
      ),
    );
    const read = yield* attachment;
    const delivered = yield* Result.await(
      Result.tryPromise(
        async () =>
          await deliver(() => Result.ok(read), {
            disposition: "attachment",
            attachmentIndex: index,
          }),
      ),
    );
    const { bytes, fileName, mimeType: contentType } = yield* delivered;
    return Result.ok(
      secureDocumentResponse({
        body: new Uint8Array(bytes),
        contentType,
        contentLength: bytes.byteLength,
        disposition: "attachment",
        fileName,
      }),
    );
  },
);
