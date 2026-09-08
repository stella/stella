import { Result } from "better-result";
import { t } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type {
  HandlerConfig,
  SafeHandlerGenerator,
} from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import {
  tDefaultVarchar,
  tSafeId,
  withDescription,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import {
  type CreatedTemplate,
  createStoredTemplate,
} from "@/api/lib/templates/create-template";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const createTemplateBodySchema = t.Object({
  file: t.File({ maxSize: FILE_SIZE_LIMITS.document }),
  name: withDescription(tDefaultVarchar, "Template display name"),
  categoryId: t.Optional(tSafeId("templateCategory")),
});

type CreateTemplateProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  body: {
    file: File;
    name: string;
    categoryId?: SafeId<"templateCategory">;
  };
  recordAuditEvent: AuditRecorder;
};

const createTemplateHandler = async function* ({
  safeDb,
  organizationId,
  userId,
  body: { file, name, categoryId },
  recordAuditEvent,
}: CreateTemplateProps): SafeHandlerGenerator<CreatedTemplate> {
  if (file.type !== DOCX_MIME_TYPE) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Invalid file type. Expected a DOCX file.",
      }),
    );
  }

  return yield* createStoredTemplate({
    safeDb,
    organizationId,
    userId,
    buffer: Buffer.from(await file.arrayBuffer()),
    name,
    fileName: sanitizeFilename(file.name),
    categoryId,
    recordAuditEvent,
  });
};

const config = {
  description:
    "Create a document template from a DOCX. Pass file and a name; the " +
    "{{field}} markers in the file become the template's fillable fields. " +
    "Read the marker grammar from the template-markers reference resource " +
    "when unsure. Returns the template id and field count.",
  permissions: { template: ["create"] },
  mcp: { type: "tool", name: "create_template" },
  transport: {
    type: "file-input",
    input: { field: "file", required: true, mediaTypes: [DOCX_MIME_TYPE] },
    alternative: {
      type: "mcp-tool",
      name: "create_template",
      note: "Pass the DOCX base64-encoded in docx_base64 and a name.",
    },
  },
  body: createTemplateBodySchema,
} satisfies HandlerConfig;

const createTemplate = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, body, recordAuditEvent }) {
    return yield* createTemplateHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      userId: user.id,
      body,
      recordAuditEvent,
    });
  },
);

export default createTemplate;
