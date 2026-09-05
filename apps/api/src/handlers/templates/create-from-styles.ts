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
import { tDefaultVarchar } from "@/api/lib/custom-schema";
import { createTemplateBuffer } from "@/api/lib/docx-authoring/create-template-buffer";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import {
  type CreatedTemplate,
  createStoredTemplate,
} from "@/api/lib/templates/create-template";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const createTemplateFromStylesBodySchema = t.Object({
  name: tDefaultVarchar,
  styleSource: t.File({ maxSize: FILE_SIZE_LIMITS.document }),
});

const DOCX_EXTENSION = ".docx";

type CreateTemplateFromStylesProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  body: {
    name: string;
    styleSource: File;
  };
  recordAuditEvent: AuditRecorder;
};

const createTemplateFromStylesHandler = async function* ({
  safeDb,
  organizationId,
  userId,
  body: { name, styleSource },
  recordAuditEvent,
}: CreateTemplateFromStylesProps): SafeHandlerGenerator<CreatedTemplate> {
  if (
    styleSource.type !== DOCX_MIME_TYPE &&
    !styleSource.name.toLowerCase().endsWith(DOCX_EXTENSION)
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Invalid style source. Expected a DOCX file.",
      }),
    );
  }

  // Folio reads only sanitized style resources, then creates a fresh package.
  // Source text, relationships, media, comments, and revisions are excluded.
  const buffer = yield* Result.await(
    Result.tryPromise({
      try: async () =>
        await createTemplateBuffer({
          type: "style-source",
          buffer: Buffer.from(await styleSource.arrayBuffer()),
          name,
        }),
      catch: (cause) =>
        new HandlerError({
          status: 400,
          message: "Could not extract styles from the DOCX file.",
          cause,
        }),
    }),
  );

  return yield* createStoredTemplate({
    safeDb,
    organizationId,
    userId,
    buffer,
    name,
    fileName: sanitizeFilenamePreservingExtension(`${name}.docx`),
    recordAuditEvent,
  });
};

const config = {
  description:
    "Create an empty template that takes its styles from an uploaded DOCX. " +
    "Only sanitized style resources are read and a fresh package is written, " +
    "so the source document's text, images, comments, and revisions never " +
    "enter the template. Any upload whose file name ends in .docx is " +
    "accepted whatever media type it declares.",
  permissions: { template: ["create"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  transport: {
    type: "file-input",
    input: {
      field: "styleSource",
      required: true,
      // Empty because the handler enforces no media type: it accepts any type
      // whose filename ends in `.docx`.
      mediaTypes: [],
    },
    alternative: {
      type: "partial",
      via: ["style-sets.create-from-editor", "templates.create-from-style-set"],
      limitation:
        "the styles must be declared as settings rather than extracted from a DOCX",
    },
  },
  body: createTemplateFromStylesBodySchema,
} satisfies HandlerConfig;

const createTemplateFromStyles = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, body, recordAuditEvent }) {
    return yield* createTemplateFromStylesHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      userId: user.id,
      body,
      recordAuditEvent,
    });
  },
);

export default createTemplateFromStyles;
