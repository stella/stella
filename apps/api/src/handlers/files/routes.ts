import { Result } from "better-result";
import Elysia, { t } from "elysia";

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
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { findCurrentOfficeEvidenceBlock } from "@/api/lib/files/office-evidence";

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

const readOfficeCitationEndpoint = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    mcp: { type: "internal", reason: "upload_mechanics" },
    params: workspaceParams({
      blockId: t.String({
        maxLength: 64,
        pattern: "^(?:pptx|xlsx)-[0-9a-f]{16}$",
      }),
      entityId: tSafeId("entity"),
      fieldId: tSafeId("field"),
    }),
  } satisfies HandlerConfig,
  async function* ({
    params: { blockId, entityId, fieldId },
    scopedDb,
    session,
    workspaceId,
  }) {
    const evidence = yield* Result.await(
      Result.tryPromise(
        async () =>
          await findCurrentOfficeEvidenceBlock({
            blockId,
            entityId,
            fieldId,
            organizationId: session.activeOrganizationId,
            scopedDb,
            workspaceId,
          }),
      ),
    );
    if (!evidence) {
      return yield* Result.err(
        new HandlerError({
          message: "Office citation not found",
          status: 404,
        }),
      );
    }
    return Result.ok({
      locator: evidence.block.locator,
      source: evidence.source,
    });
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
    readOfficeCitationEndpoint.handler,
    {
      params: readOfficeCitationEndpoint.config.params,
      permissions: readOfficeCitationEndpoint.config.permissions,
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
