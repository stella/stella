import { t } from "elysia";

import { createDocx, createEmptyDocument } from "@stll/folio/server";

import type { SafeDb } from "@/api/db";
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
import { sanitizeFilename } from "@/api/lib/sanitize-filename";

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
  // A blank template starts from a Folio-native empty document: the user
  // authors the body and adds {{fields}} in the Studio. There's no source
  // filename, so derive one from the name to keep the stored DOCX scannable.
  const buffer = Buffer.from(
    new Uint8Array(await createDocx(createEmptyDocument())),
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
  mcp: { type: "covered", by: "create_template" },
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
