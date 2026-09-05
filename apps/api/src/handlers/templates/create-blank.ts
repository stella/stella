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
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import { createTemplateBuffer } from "@/api/lib/docx-authoring/create-template-buffer";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import {
  type CreatedTemplate,
  createStoredTemplate,
} from "@/api/lib/templates/create-template";

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
  description:
    "Create an empty template from the stella base DOCX, with a name and an " +
    "optional category. It carries no fields yet: add markers by editing the " +
    "document and storing it with templates.save-document. Use " +
    "templates.create to upload a DOCX that already has {{field}} markers.",
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
