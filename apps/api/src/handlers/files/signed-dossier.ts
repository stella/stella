import { Result } from "better-result";
import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";
import { SIGNED_DOSSIER_KINDS } from "@stll/api-contract/legal-file-formats";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import {
  readSignedDossierPdf,
  readSignedDossierPreview,
} from "@/api/lib/files/archive-preview";
import { readLegalFilePreview } from "@/api/lib/files/read-legal-file-preview";
import { MAX_DOSSIER_DOCUMENTS } from "@/api/lib/files/signed-dossier";
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

export const signedDossierPreviewEndpoint = createSafeHandler(
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
            SIGNED_DOSSIER_KINDS,
            readSignedDossierPreview,
          ),
      ),
    );
    return Result.ok(yield* result);
  },
);

export const signedDossierContentEndpoint = createSafeHandler(
  {
    ...config,
    query: v.object({
      /** The document's position in the container's preview list. */
      document: numberFromString(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(0),
          v.maxValue(MAX_DOSSIER_DOCUMENTS - 1),
        ),
      ),
    }),
  },
  async function* ({
    params: { fieldId },
    query: { document },
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
            SIGNED_DOSSIER_KINDS,
            async (source) => await readSignedDossierPdf(source, document),
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
