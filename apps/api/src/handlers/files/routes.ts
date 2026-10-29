import { Result } from "better-result";
import * as v from "valibot";

import type { AUTHORED_DOCUMENT_PROPERTY_KEYS } from "@stll/api-contract";
import { MARKED_PDF_EXPORT_MODES } from "@stll/api-contract/marked-pdf-export";

import { readDocumentProperties } from "@/api/handlers/files/document-properties";
import emailAttachmentEndpoint from "@/api/handlers/files/email-attachment";
import saveEmailAttachmentEndpoint from "@/api/handlers/files/email-attachment/create";
import {
  printPdfHandler,
  readEmailHtmlPreviewHandler,
  STAMPED_DOWNLOAD_METADATA,
  stampedDownloadHandler,
} from "@/api/handlers/files/get";
import { readMarkedDownload } from "@/api/handlers/files/marked-download";
import {
  OCR_EXPORT_FORMATS,
  readOcrExport,
} from "@/api/handlers/files/ocr-export";
import officeCitationEndpoint from "@/api/handlers/files/office-citation";
import { readScrubbedDownload } from "@/api/handlers/files/scrubbed-download";
import readFileThumbnailEndpoint from "@/api/handlers/files/thumbnail";
import { updateDocumentProperties } from "@/api/handlers/files/update-document-properties";
import { routes } from "@/api/http/route";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { ownerSyntheticSessionAuthorityReader } from "@/api/lib/auth";
import { checkDemoAccountOperation } from "@/api/lib/auth/demo-account";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { readFileHandler } from "@/api/lib/files/read-file";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import { callerDownloadSource } from "@/api/lib/s3-presign";

export const readFileEndpoint = createSafeHandler(
  {
    contract: "patch",
    contentDelivery: { type: "audited" },
    permissions: { workspace: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    access: "read",
    mcp: { type: "internal", reason: "upload_mechanics" },
    query: v.object({
      purpose: v.picklist(["download", "display", "native-display"]),
    }),
    params: workspaceParams({ fieldId: resourceIdSchema("field") }),
  } satisfies WorkspaceHandlerConfig,
  async function* ({
    params: { fieldId },
    query: { purpose },
    user,
    scopedDb,
    session,
    workspaceId,
    recordAuditEvent,
  }) {
    if (purpose === "download") {
      yield* checkDemoAccountOperation(user.email);
    }
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readFileHandler({
            fieldId,
            userId: user.id,
            source: callerDownloadSource(session),
            organizationId: session.activeOrganizationId,
            workspaceId,
            purpose,
            scopedDb,
            recordAuditEvent,
            readSessionAuthority: ownerSyntheticSessionAuthorityReader,
          }),
      ),
    );

    return Result.ok(response);
  },
);

export const readEmailHtmlPreviewEndpoint = createSafeHandler(
  {
    contract: "patch",
    contentDelivery: {
      type: "none",
      reason: "Returns parsed email preview data rather than a file grant.",
    },
    permissions: { workspace: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    access: "read",
    mcp: { type: "internal", reason: "upload_mechanics" },
    params: workspaceParams({ fieldId: resourceIdSchema("field") }),
  } satisfies WorkspaceHandlerConfig,
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
          await readEmailHtmlPreviewHandler({
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

export const printPdfEndpoint = createSafeHandler(
  {
    contract: "patch",
    accountAccess: ACCOUNT_ACCESS.standard,
    contentDelivery: { type: "audited" },
    permissions: { workspace: ["read"] },
    access: "read",
    mcp: { type: "internal", reason: "upload_mechanics" },
    params: workspaceParams({ fieldId: resourceIdSchema("field") }),
  } satisfies WorkspaceHandlerConfig,
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

export const stampedDownloadEndpoint = createSafeHandler(
  {
    contract: "patch",
    accountAccess: ACCOUNT_ACCESS.standard,
    contentDelivery: { type: "audited" },
    permissions: { workspace: ["read"] },
    access: "read",
    mcp: { type: "internal", reason: "upload_mechanics" },
    params: workspaceParams({ fieldId: resourceIdSchema("field") }),
    query: v.object({ metadata: v.picklist(STAMPED_DOWNLOAD_METADATA) }),
  } satisfies WorkspaceHandlerConfig,
  async function* ({
    params: { fieldId },
    query: { metadata },
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
            metadata,
          }),
      ),
    );

    return Result.ok(response);
  },
);

export const readDocumentPropertiesEndpoint = createSafeHandler(
  {
    contract: "patch",
    contentDelivery: {
      type: "none",
      reason: "Returns document metadata rather than file bytes.",
    },
    permissions: { workspace: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "upload_mechanics" },
    access: "read",
    params: workspaceParams({ fieldId: resourceIdSchema("field") }),
  } satisfies WorkspaceHandlerConfig,
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

const documentPropertyValue = v.exactOptional(
  v.pipe(v.string(), v.maxLength(DOCUMENT_PROPERTY_MAX_LENGTH)),
);

/**
 * Written out rather than derived from the key list, because the route infers
 * the handler's body type from this literal and a computed object erases it. The
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
    contract: "patch",
    contentDelivery: {
      type: "none",
      reason: "Updates document metadata without delivering a file.",
    },
    permissions: { entity: ["update"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "upload_mechanics" },
    params: workspaceParams({ fieldId: resourceIdSchema("field") }),
    // A partial patch: only the named properties change, and an empty string
    // clears one. Omitting a key leaves whatever the document already carried.
    body: v.object({ ...AUTHORED_PROPERTY_BODY }),
  } satisfies WorkspaceHandlerConfig,
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
    contract: "patch",
    accountAccess: ACCOUNT_ACCESS.standard,
    contentDelivery: { type: "audited" },
    permissions: { workspace: ["read"] },
    mcp: { type: "internal", reason: "upload_mechanics" },
    access: "read",
    params: workspaceParams({ fieldId: resourceIdSchema("field") }),
  } satisfies WorkspaceHandlerConfig,
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

/**
 * A PDF as uploaded, with the caller's visible marks appended as PDF
 * annotations as `mode` says (highlights alone, or with comments and author
 * names); the stored bytes unchanged when the file cannot take them without
 * harm.
 */
export const markedDownloadEndpoint = createSafeHandler(
  {
    contract: "patch",
    accountAccess: ACCOUNT_ACCESS.sandbox,
    contentDelivery: { type: "audited" },
    permissions: { workspace: ["read"] },
    mcp: { type: "internal", reason: "upload_mechanics" },
    access: "read",
    params: workspaceParams({ fieldId: resourceIdSchema("field") }),
    query: v.object({ mode: v.picklist(MARKED_PDF_EXPORT_MODES) }),
  } satisfies WorkspaceHandlerConfig,
  async function* ({
    params: { fieldId },
    query: { mode },
    recordAuditEvent,
    safeDb,
    scopedDb,
    session,
    user,
    workspaceId,
  }) {
    // The plain Download of a PDF, so the same refusal as the uploaded bytes.
    yield* checkDemoAccountOperation(user.email);
    return yield* readMarkedDownload({
      fieldId,
      mode,
      organizationId: session.activeOrganizationId,
      recordAuditEvent,
      safeDb,
      scopedDb,
      userId: user.id,
      workspaceId,
    });
  },
);

export const ocrExportEndpoint = createSafeHandler(
  {
    contract: "patch",
    accountAccess: ACCOUNT_ACCESS.standard,
    contentDelivery: { type: "audited" },
    permissions: { workspace: ["read"] },
    mcp: { type: "internal", reason: "upload_mechanics" },
    access: "read",
    query: v.object({ format: v.picklist(OCR_EXPORT_FORMATS) }),
    params: workspaceParams({ fieldId: resourceIdSchema("field") }),
  } satisfies WorkspaceHandlerConfig,
  async function* ({
    params: { fieldId },
    query: { format },
    scopedDb,
    session,
    user,
    workspaceId,
    recordAuditEvent,
  }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readOcrExport({
            readSessionAuthority: ownerSyntheticSessionAuthorityReader,
            fieldId,
            format,
            userId: user.id,
            source: callerDownloadSource(session),
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

export const filesRoute = routes(
  {
    "/url/:fieldId": { GET: readFileEndpoint },
    "/email-html/:fieldId": { GET: readEmailHtmlPreviewEndpoint },
    "/office-citation/:entityId/:fieldId/:blockId": {
      GET: officeCitationEndpoint,
    },
    "/print-pdf/:fieldId": { GET: printPdfEndpoint },
    "/stamped/:fieldId": { GET: stampedDownloadEndpoint },
    "/ocr-export/:fieldId": { GET: ocrExportEndpoint },
    "/document-properties/:fieldId": {
      GET: readDocumentPropertiesEndpoint,
      PATCH: updateDocumentPropertiesEndpoint,
    },
    "/scrubbed/:fieldId": { GET: scrubbedDownloadEndpoint },
    "/marked/:fieldId": { GET: markedDownloadEndpoint },
    "/thumbnail/:fieldId": { GET: readFileThumbnailEndpoint },
    "/email-attachment/:fieldId/:attachmentId": {
      GET: emailAttachmentEndpoint,
    },
    "/email-attachment/:fieldId/:attachmentId/save": {
      POST: saveEmailAttachmentEndpoint,
    },
  },
  { prefix: "/files/:workspaceId" },
);
