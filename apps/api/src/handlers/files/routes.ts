import { Result } from "better-result";
import Elysia, { t } from "elysia";

import emailAttachmentEndpoint from "@/api/handlers/files/email-attachment";
import saveEmailAttachmentEndpoint from "@/api/handlers/files/email-attachment/create";
import { readDocumentProperties } from "@/api/handlers/files/document-properties";
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
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";

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
  .get(
    "/document-properties/:fieldId",
    readDocumentPropertiesEndpoint.handler,
    {
      params: readDocumentPropertiesEndpoint.config.params,
      permissions: readDocumentPropertiesEndpoint.config.permissions,
    },
  )
  .get("/print-pdf/:fieldId", printPdfEndpoint.handler, {
    params: printPdfEndpoint.config.params,
    permissions: printPdfEndpoint.config.permissions,
  })
  .get("/scrubbed/:fieldId", scrubbedDownloadEndpoint.handler, {
    params: scrubbedDownloadEndpoint.config.params,
    permissions: scrubbedDownloadEndpoint.config.permissions,
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
