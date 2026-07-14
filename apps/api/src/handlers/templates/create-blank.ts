import { Result } from "better-result";
import { t } from "elysia";

import {
  createDocx,
  createEmptyDocument,
  createStellaStyleDocumentPreset,
  extractDocumentStyleSetFromDocx,
} from "@stll/folio-core/server";

import type { SafeDb } from "@/api/db/safe-db";
import {
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
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const createBlankTemplateBodySchema = t.Object({
  name: tDefaultVarchar,
  categoryId: t.Optional(tSafeId("templateCategory")),
  styleSource: t.Optional(t.File({ maxSize: FILE_SIZE_LIMITS.document })),
});

type CreateBlankTemplateProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  body: {
    name: string;
    categoryId?: SafeId<"templateCategory">;
    styleSource?: File;
  };
  recordAuditEvent: AuditRecorder;
};

type CreateBlankTemplateBufferOptions =
  | { type: "stella" }
  | { type: "style-source"; buffer: Buffer; name: string };

export const createBlankTemplateBuffer = async (
  options: CreateBlankTemplateBufferOptions,
): Promise<Buffer> => {
  const preset = createStellaStyleDocumentPreset();
  if (options.type === "style-source") {
    preset.styleSet = await extractDocumentStyleSetFromDocx(options.buffer, {
      name: options.name,
    });
  }

  return Buffer.from(
    new Uint8Array(await createDocx(createEmptyDocument({ preset }))),
  );
};

const createBlankTemplateHandler = async function* ({
  safeDb,
  organizationId,
  userId,
  body: { name, categoryId, styleSource },
  recordAuditEvent,
}: CreateBlankTemplateProps): SafeHandlerGenerator<CreatedTemplate> {
  if (styleSource && styleSource.type !== DOCX_MIME_TYPE) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Invalid style source. Expected a DOCX file.",
      }),
    );
  }

  // A style source is parsed only for its sanitized style resources. Folio
  // rebuilds a fresh content-free package, so source text, relationships,
  // media, comments, and revisions cannot enter the stored template.
  const buffer = yield* Result.await(
    Result.tryPromise({
      try: async () =>
        await createBlankTemplateBuffer(
          styleSource
            ? {
                type: "style-source",
                buffer: Buffer.from(await styleSource.arrayBuffer()),
                name,
              }
            : { type: "stella" },
        ),
      catch: (cause) =>
        new HandlerError({
          status: styleSource ? 400 : 500,
          message: styleSource
            ? "Could not extract styles from the DOCX file."
            : "Could not create the blank template.",
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
    fileName: sanitizeFilename(`${name}.docx`),
    categoryId,
    recordAuditEvent,
  });
};

const config = {
  permissions: { template: ["create"] },
  // Not reachable through save_template (which requires a DOCX on create);
  // blank-template creation stays a tracked gap.
  mcp: { type: "capability", reason: "template_authoring_ui" },
  body: createBlankTemplateBodySchema,
} satisfies HandlerConfig;

const createBlankTemplate = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, body, recordAuditEvent }) {
    return yield* createBlankTemplateHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      userId: user.id,
      body,
      recordAuditEvent,
    });
  },
);

export default createBlankTemplate;
