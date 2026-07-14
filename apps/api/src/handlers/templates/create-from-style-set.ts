import { Result } from "better-result";
import { t } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { readStyleSetBuffer } from "@/api/handlers/style-sets/shared";
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

const bodySchema = t.Object({
  name: tDefaultVarchar,
  styleSetId: tSafeId("styleSet"),
  categoryId: t.Optional(tSafeId("templateCategory")),
});

type CreateTemplateFromStyleSetOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  body: {
    name: string;
    styleSetId: SafeId<"styleSet">;
    categoryId?: SafeId<"templateCategory">;
  };
  recordAuditEvent: AuditRecorder;
};

const createTemplateFromStyleSetHandler = async function* ({
  safeDb,
  organizationId,
  userId,
  body,
  recordAuditEvent,
}: CreateTemplateFromStyleSetOptions): SafeHandlerGenerator<CreatedTemplate> {
  const buffer = yield* Result.await(
    readStyleSetBuffer({
      safeDb,
      organizationId,
      styleSetId: body.styleSetId,
    }),
  );

  return yield* createStoredTemplate({
    safeDb,
    organizationId,
    userId,
    buffer,
    name: body.name,
    fileName: sanitizeFilename(`${body.name}.docx`),
    categoryId: body.categoryId,
    recordAuditEvent,
  });
};

const config = {
  permissions: { template: ["create"], styleSet: ["use"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  body: bodySchema,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, body, recordAuditEvent }) {
    return yield* createTemplateFromStyleSetHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      userId: user.id,
      body,
      recordAuditEvent,
    });
  },
);
