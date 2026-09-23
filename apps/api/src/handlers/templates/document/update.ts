import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";
import { writeStoredTemplate } from "@/api/lib/templates/write-template";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const saveDocumentBodySchema = t.Object({
  file: t.File({ maxSize: FILE_SIZE_LIMITS.document }),
});

const saveDocumentParamsSchema = t.Object({
  templateId: tSafeId("template"),
});

const config = {
  description:
    "Store an edited DOCX as the template's next version: the file becomes " +
    "the current body, its field configuration is read from the markers it " +
    "carries, and the previous version stays in history. Refused once the " +
    "template holds its maximum number of versions.",
  permissions: { template: ["update"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  transport: {
    type: "file-input",
    input: { field: "file", required: true, mediaTypes: [DOCX_MIME_TYPE] },
    alternative: {
      type: "none",
      reason:
        "the new template version IS the edited DOCX body; no capability accepts that body as JSON",
    },
  },
  params: saveDocumentParamsSchema,
  body: saveDocumentBodySchema,
} satisfies HandlerConfig;

// Persists a Folio-edited template body as a new immutable version. The DOCX
// is the template, so the version's field configuration is whatever its markers
// declare: a marker the editor deleted takes its field with it, and one it
// added arrives configured by the filters written on it.
const saveTemplateDocument = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, params, body, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;
    const { templateId } = params;
    const { file } = body;

    if (file.type !== DOCX_MIME_TYPE) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Invalid file type. Expected a DOCX file.",
        }),
      );
    }

    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.query.templates.findFirst({
          where: {
            id: { eq: templateId },
            organizationId: { eq: organizationId },
          },
          columns: { id: true },
        }),
      ),
    );

    if (!existing) {
      return Result.err(
        new HandlerError({ status: 404, message: "Template not found" }),
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    const written = yield* Result.await(
      Result.gen(() =>
        writeStoredTemplate({
          safeDb,
          organizationId,
          templateId,
          mode: { type: "new-version", userId: user.id },
          recordAuditEvent,
          prepare: () => Result.ok({ bytes: new Uint8Array(buffer) }),
        }),
      ),
    );

    return Result.ok(written.row);
  },
);

export default saveTemplateDocument;
