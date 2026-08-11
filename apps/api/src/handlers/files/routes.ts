import { Result } from "better-result";
import Elysia, { t } from "elysia";

import type { AUTHORED_DOCUMENT_PROPERTY_KEYS } from "@stll/api-contract";

import { readDocumentProperties } from "@/api/handlers/files/document-properties";
import emailAttachmentEndpoint from "@/api/handlers/files/email-attachment";
import saveEmailAttachmentEndpoint from "@/api/handlers/files/email-attachment/create";
import {
  printPdfHandler,
  readEmailHtmlPreviewHandler,
  readFileHandler,
  stampedDownloadHandler,
} from "@/api/handlers/files/get";
import {
  OCR_EXPORT_FORMATS,
  readOcrExport,
} from "@/api/handlers/files/ocr-export";
import officeCitationEndpoint from "@/api/handlers/files/office-citation";
import { readScrubbedDownload } from "@/api/handlers/files/scrubbed-download";
import { updateDocumentProperties } from "@/api/handlers/files/update-document-properties";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { hasMemberPermission } from "@/api/lib/permission-authorization";

const readFileEndpoint = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    mcp: { type: "internal", reason: "upload_mechanics" },
    query: t.Object({
      purpose: t.UnionEnum(["download", "display", "native-display"]),
    }),
    params: workspaceParams({ fieldId: tSafeId("field") }),
  } satisfies HandlerConfig,
  async function* ({
    params: { fieldId },
    query: { purpose },
    scopedDb,
    session,
    workspaceId,
    recordAuditEvent,
  }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readFileHandler({
            fieldId,
            organizationId: session.activeOrganizationId,
            workspaceId,
            purpose,
            scopedDb,
            recordAuditEvent,
          }),
      ),
    );

    return Result.ok(response);
  },
);

const readEmailHtmlPreviewEndpoint = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    mcp: { type: "internal", reason: "upload_mechanics" },
    params: workspaceParams({ fieldId: tSafeId("field") }),
  } satisfies HandlerConfig,
  async function* ({ params: { fieldId }, scopedDb, session, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readEmailHtmlPreviewHandler({
            fieldId,
            organizationId: session.activeOrganizationId,
            workspaceId,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

const printPdfEndpoint = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    mcp: { type: "internal", reason: "upload_mechanics" },
    params: workspaceParams({ fieldId: tSafeId("field") }),
  } satisfies HandlerConfig,
  async function* ({
    params: { fieldId },
    scopedDb,
    session,
    workspaceId,
    recordAuditEvent,
  }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await printPdfHandler({
            fieldId,
            organizationId: session.activeOrganizationId,
            workspaceId,
            scopedDb,
            recordAuditEvent,
          }),
      ),
    );

    return Result.ok(response);
  },
);

const stampedDownloadEndpoint = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    mcp: { type: "internal", reason: "upload_mechanics" },
    params: workspaceParams({ fieldId: tSafeId("field") }),
  } satisfies HandlerConfig,
  async function* ({
    params: { fieldId },
    scopedDb,
    session,
    workspaceId,
    recordAuditEvent,
  }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await stampedDownloadHandler({
            fieldId,
            organizationId: session.activeOrganizationId,
            workspaceId,
            scopedDb,
            recordAuditEvent,
          }),
      ),
    );

    return Result.ok(response);
  },
);

export const readDocumentPropertiesEndpoint = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    mcp: { type: "internal", reason: "upload_mechanics" },
    params: workspaceParams({ fieldId: tSafeId("field") }),
  } satisfies HandlerConfig,
  async function* ({
    memberRole,
    params: { fieldId },
    scopedDb,
    session,
    workspaceId,
    recordAuditEvent,
  }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readDocumentProperties({
            canUpdateEntity: hasMemberPermission(memberRole, {
              entity: ["update"],
            }),
            fieldId,
            organizationId: session.activeOrganizationId,
            recordAuditEvent,
            scopedDb,
            workspaceId,
          }),
      ),
    );

    return Result.ok(response);
  },
);

/** These are labels, not document text. */
const DOCUMENT_PROPERTY_MAX_LENGTH = 1000;

const documentPropertyValue = t.Optional(
  t.String({ maxLength: DOCUMENT_PROPERTY_MAX_LENGTH }),
);

/**
 * Written out rather than derived from the key list, because Elysia infers the
 * handler's body type from this literal and a computed object erases it. The
 * `satisfies` binds it to the contract, so a new authored key fails to compile
 * here instead of silently becoming unwritable.
 */
const AUTHORED_PROPERTY_BODY = {
  title: documentPropertyValue,
  subject: documentPropertyValue,
  description: documentPropertyValue,
  keywords: documentPropertyValue,
  category: documentPropertyValue,
  contentStatus: documentPropertyValue,
  author: documentPropertyValue,
  lastModifiedBy: documentPropertyValue,
  company: documentPropertyValue,
  manager: documentPropertyValue,
} satisfies Record<
  (typeof AUTHORED_DOCUMENT_PROPERTY_KEYS)[number],
  typeof documentPropertyValue
>;

export const updateDocumentPropertiesEndpoint = createSafeHandler(
  {
    permissions: { entity: ["update"] },
    mcp: { type: "internal", reason: "upload_mechanics" },
    params: workspaceParams({ fieldId: tSafeId("field") }),
    // A partial patch: only the named properties change, and an empty string
    // clears one. Omitting a key leaves whatever the document already carried.
    body: t.Object({
      ...AUTHORED_PROPERTY_BODY,
    }),
  } satisfies HandlerConfig,
  async function* ({
    body,
    params: { fieldId },
    safeDb,
    scopedDb,
    session,
    user,
    workspaceId,
    recordAuditEvent,
  }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await updateDocumentProperties({
            fieldId,
            organizationId: session.activeOrganizationId,
            recordAuditEvent,
            safeDb,
            scopedDb,
            userId: user.id,
            values: body,
            workspaceId,
          }),
      ),
    );

    return Result.ok(response);
  },
);

export const scrubbedDownloadEndpoint = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    mcp: { type: "internal", reason: "upload_mechanics" },
    params: workspaceParams({ fieldId: tSafeId("field") }),
  } satisfies HandlerConfig,
  async function* ({
    params: { fieldId },
    scopedDb,
    session,
    workspaceId,
    recordAuditEvent,
  }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readScrubbedDownload({
            fieldId,
            organizationId: session.activeOrganizationId,
            recordAuditEvent,
            scopedDb,
            workspaceId,
          }),
      ),
    );

    return Result.ok(response);
  },
);

export const ocrExportEndpoint = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    mcp: { type: "internal", reason: "upload_mechanics" },
    query: t.Object({ format: t.UnionEnum(OCR_EXPORT_FORMATS) }),
    params: workspaceParams({ fieldId: tSafeId("field") }),
    response: t.Unknown(),
  } satisfies HandlerConfig,
  async function* ({
    params: { fieldId },
    query: { format },
    scopedDb,
    session,
    workspaceId,
    recordAuditEvent,
  }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readOcrExport({
            fieldId,
            format,
            organizationId: session.activeOrganizationId,
            recordAuditEvent,
            scopedDb,
            workspaceId,
          }),
      ),
    );
    return Result.ok(response);
  },
);

export const filesRoute = new Elysia({
  prefix: "/files/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .get("/url/:fieldId", readFileEndpoint.handler, {
    params: readFileEndpoint.config.params,
    permissions: readFileEndpoint.config.permissions,
    query: readFileEndpoint.config.query,
  })
  .get("/email-html/:fieldId", readEmailHtmlPreviewEndpoint.handler, {
    params: readEmailHtmlPreviewEndpoint.config.params,
    permissions: readEmailHtmlPreviewEndpoint.config.permissions,
  })
  .get(
    "/office-citation/:entityId/:fieldId/:blockId",
    officeCitationEndpoint.handler,
    {
      params: officeCitationEndpoint.config.params,
      permissions: officeCitationEndpoint.config.permissions,
    },
  )
  .get("/print-pdf/:fieldId", printPdfEndpoint.handler, {
    params: printPdfEndpoint.config.params,
    permissions: printPdfEndpoint.config.permissions,
  })
  .get("/stamped/:fieldId", stampedDownloadEndpoint.handler, {
    params: stampedDownloadEndpoint.config.params,
    permissions: stampedDownloadEndpoint.config.permissions,
  })
  .get("/ocr-export/:fieldId", ocrExportEndpoint.handler, {
    params: ocrExportEndpoint.config.params,
    permissions: ocrExportEndpoint.config.permissions,
    query: ocrExportEndpoint.config.query,
    response: ocrExportEndpoint.config.response,
  });

// These UI-only endpoints intentionally stay outside the exported Eden
// contract. Elysia still registers them with the same guards and macros above.
filesRoute.get(
  "/document-properties/:fieldId",
  readDocumentPropertiesEndpoint.handler,
  {
    params: readDocumentPropertiesEndpoint.config.params,
    permissions: readDocumentPropertiesEndpoint.config.permissions,
  },
);

filesRoute.patch(
  "/document-properties/:fieldId",
  updateDocumentPropertiesEndpoint.handler,
  {
    body: updateDocumentPropertiesEndpoint.config.body,
    params: updateDocumentPropertiesEndpoint.config.params,
    permissions: updateDocumentPropertiesEndpoint.config.permissions,
  },
);

filesRoute.get("/scrubbed/:fieldId", scrubbedDownloadEndpoint.handler, {
  params: scrubbedDownloadEndpoint.config.params,
  permissions: scrubbedDownloadEndpoint.config.permissions,
});

filesRoute.get(
  "/email-attachment/:fieldId/:attachmentId",
  emailAttachmentEndpoint.handler,
  {
    params: emailAttachmentEndpoint.config.params,
    permissions: emailAttachmentEndpoint.config.permissions,
    query: emailAttachmentEndpoint.config.query,
  },
);

filesRoute.post(
  "/email-attachment/:fieldId/:attachmentId/save",
  saveEmailAttachmentEndpoint.handler,
  {
    body: saveEmailAttachmentEndpoint.config.body,
    params: saveEmailAttachmentEndpoint.config.params,
    permissions: saveEmailAttachmentEndpoint.config.permissions,
  },
);
