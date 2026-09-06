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
import { isFieldMeta } from "@/api/lib/docx/types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import {
  type ClientTemplateManifest,
  type CreatedTemplate,
  createStoredTemplate,
} from "@/api/lib/templates/create-template";
import { isRecord } from "@/api/lib/type-guards";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const createTemplateBodySchema = t.Object({
  file: t.File({ maxSize: FILE_SIZE_LIMITS.document }),
  name: withDescription(tDefaultVarchar, "Template display name"),
  categoryId: t.Optional(tSafeId("templateCategory")),
  // A JSON string over the multipart HTTP body, an object when an MCP
  // invocation calls the handler directly. Accept any and validate in the
  // handler.
  manifest: t.Optional(t.Any()),
});

/** Accept the JSON string an HTTP client sends or the object an MCP
 *  invocation passes straight through. */
const parseClientManifest = (value: unknown): ClientTemplateManifest | null => {
  let parsed: unknown = value;
  if (typeof value === "string") {
    const parseResult = Result.try((): unknown => JSON.parse(value));
    if (Result.isError(parseResult)) {
      return null;
    }
    parsed = parseResult.value;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const fields = parsed["fields"];
  if (!Array.isArray(fields) || !fields.every(isFieldMeta)) {
    return null;
  }
  return { fields };
};

type CreateTemplateProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  body: {
    file: File;
    name: string;
    categoryId?: SafeId<"templateCategory">;
    manifest?: unknown;
  };
  recordAuditEvent: AuditRecorder;
};

const createTemplateHandler = async function* ({
  safeDb,
  organizationId,
  userId,
  body: { file, name, categoryId, manifest: manifestJson },
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

  // A manifest is optional, but a *supplied* one that is malformed JSON or
  // fails field validation must fail fast: the wizard sends the field config
  // (labels, required flags, formulas, input types) here, so silently treating
  // an invalid manifest as "none" would drop those settings. `null` therefore
  // only means "omitted".
  let clientManifest: ClientTemplateManifest | null = null;
  if (manifestJson !== null && manifestJson !== undefined) {
    clientManifest = parseClientManifest(manifestJson);
    if (clientManifest === null) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Invalid template field configuration.",
        }),
      );
    }
  }

  return yield* createStoredTemplate({
    safeDb,
    organizationId,
    userId,
    buffer: Buffer.from(await file.arrayBuffer()),
    name,
    fileName: sanitizeFilename(file.name),
    categoryId,
    clientManifest,
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
  mcp: { type: "tool", name: "save_template" },
  transport: {
    type: "file-input",
    input: { field: "file", required: true, mediaTypes: [DOCX_MIME_TYPE] },
    alternative: {
      type: "mcp-tool",
      name: "save_template",
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
