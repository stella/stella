import { Result } from "better-result";
import { t } from "elysia";

import type { SafeDb } from "@/api/db";
import { isFieldMeta, isNamedCondition } from "@/api/handlers/docx/types";
import {
  type ClientTemplateManifest,
  type CreatedTemplate,
  createStoredTemplate,
} from "@/api/handlers/templates/create-template-service";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type {
  HandlerConfig,
  SafeHandlerGenerator,
} from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { isRecord } from "@/api/lib/type-guards";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const createTemplateBodySchema = t.Object({
  file: t.File({ maxSize: FILE_SIZE_LIMITS.document }),
  name: tDefaultVarchar,
  categoryId: t.Optional(tSafeId("templateCategory")),
  // Elysia auto-parses JSON strings from FormData, so the
  // manifest may arrive as a string or an already-parsed
  // object depending on transport. Accept any and validate
  // in the handler.
  manifest: t.Optional(t.Any()),
});

/** Accept a string (JSON body) or already-parsed object
 *  (FormData auto-parsed by Elysia). */
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
  const conditions = parsed["conditions"];
  if (
    conditions !== undefined &&
    (!Array.isArray(conditions) || !conditions.every(isNamedCondition))
  ) {
    return null;
  }
  return {
    fields,
    conditions,
  };
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

  const clientManifest =
    manifestJson !== null && manifestJson !== undefined
      ? parseClientManifest(manifestJson)
      : null;

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
  permissions: { template: ["create"] },
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
