import { Result } from "better-result";
import { t } from "elysia";

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
import { createTemplateBuffer } from "@/api/lib/create-template-buffer";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";

const createBlankTemplateBodySchema = t.Object({
  name: tDefaultVarchar,
  categoryId: t.Optional(tSafeId("templateCategory")),
});

type CreateBlankTemplateProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  body: {
    name: string;
    categoryId?: SafeId<"templateCategory">;
  };
  recordAuditEvent: AuditRecorder;
};

const createBlankTemplateHandler = async function* ({
  safeDb,
  organizationId,
  userId,
  body: { name, categoryId },
  recordAuditEvent,
}: CreateBlankTemplateProps): SafeHandlerGenerator<CreatedTemplate> {
  const buffer = yield* Result.await(
    Result.tryPromise({
      try: async () => await createTemplateBuffer({ type: "stella" }),
      catch: (cause) =>
        new HandlerError({
          status: 500,
          message: "Could not create the blank template.",
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
    categoryId,
    recordAuditEvent,
  });
};

const config = {
  permissions: { template: ["create"] },
  // Not reachable through save_template (which requires a DOCX on create).
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
