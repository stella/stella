import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";

import { entities, templateFills } from "@/api/db/schema";
import {
  buildAiFieldGenerator,
  buildAiOccurrenceAdapter,
} from "@/api/handlers/docx/ai-field-generator";
import { createEntityFromBuffer } from "@/api/handlers/entities/create-from-buffer";
import { containsNull } from "@/api/handlers/templates/fill";
import { fillStoredTemplateDocx } from "@/api/handlers/templates/template-fill-service";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { DOCX_EXT_RE, sanitizeFilename } from "@/api/lib/sanitize-filename";
import { isRecord } from "@/api/lib/type-guards";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const fillToWorkspaceParamsSchema = workspaceParams({
  templateId: tSafeId("template"),
});

const fillToWorkspaceBodySchema = t.Object({
  /** JSON-encoded field-path → value map, same contract as the fill route. */
  values: t.String(),
  /** Display name for the created document; defaults to the template's
   *  file name. The `.docx` extension is appended when missing. */
  name: t.Optional(t.String({ minLength: 1, maxLength: 255 })),
  /** Target folder inside the workspace; root when absent. */
  parentId: t.Optional(tSafeId("entity")),
});

/** The created document's file name: the caller's name (extension ensured)
 *  or the template's own file name. */
const resolveDocumentFileName = (
  requestedName: string | undefined,
  templateFileName: string,
): string => {
  const trimmed = requestedName?.trim() ?? "";
  if (trimmed === "") {
    return templateFileName;
  }
  const sanitized = sanitizeFilename(trimmed);
  return DOCX_EXT_RE.test(sanitized) ? sanitized : `${sanitized}.docx`;
};

const config = {
  permissions: { template: ["create"], entity: ["create"] },
  params: fillToWorkspaceParamsSchema,
  body: fillToWorkspaceBodySchema,
} satisfies HandlerConfig;

/**
 * Fill a stored template and persist the result as a DOCX document entity in
 * the target matter (instead of streaming the bytes back like the fill
 * route). Workspace access is validated by the route macro; the template is
 * scoped to the caller's organization via RLS.
 */
const fillTemplateToWorkspace = createSafeHandler(
  config,
  async function* ({
    safeDb,
    scopedDb,
    session,
    user,
    workspaceId,
    params,
    body,
    orgAIConfig,
    recordAuditEvent,
  }) {
    const organizationId = session.activeOrganizationId;
    const { templateId } = params;

    const parseResult = Result.try((): unknown => JSON.parse(body.values));
    if (Result.isError(parseResult)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Invalid JSON in 'values' field.",
        }),
      );
    }

    const parsed = parseResult.value;
    if (!isRecord(parsed)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "'values' must be a JSON object (not null or array).",
        }),
      );
    }

    if (Object.values(parsed).some(containsNull)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "'values' must not contain null values.",
        }),
      );
    }

    // Validate the target folder before any fill work happens, so a bad
    // parent rejects fast instead of after the model calls.
    const parentId = body.parentId ?? null;
    if (parentId !== null) {
      const parent = yield* Result.await(
        safeDb((tx) =>
          tx.query.entities.findFirst({
            where: {
              id: { eq: parentId },
              workspaceId: { eq: workspaceId },
            },
            columns: { kind: true },
          }),
        ),
      );
      if (!parent || parent.kind !== "folder") {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Target folder not found in this workspace",
          }),
        );
      }
    }

    const filled = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await fillStoredTemplateDocx({
            templateId,
            values: parsed,
            scopedDb,
            organizationId,
            generateAiValue: buildAiFieldGenerator({
              orgAIConfig,
              organizationId,
            }),
            adaptAiValue: buildAiOccurrenceAdapter({
              orgAIConfig,
              organizationId,
            }),
          }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Template fill failed",
            cause,
          }),
      }),
    );

    if ("error" in filled) {
      return Result.err(
        new HandlerError({ status: 400, message: filled.error }),
      );
    }

    const fileName = resolveDocumentFileName(body.name, filled.fileName);

    const created = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await createEntityFromBuffer({
            scopedDb,
            organizationId,
            workspaceId,
            userId: user.id,
            recordAuditEvent,
            buffer: filled.buffer,
            fileName,
            mimeType: DOCX_MIME_TYPE,
          }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Failed to store the filled document",
            cause,
          }),
      }),
    );

    if (Result.isError(created)) {
      return Result.err(
        new HandlerError({ status: 400, message: created.error.message }),
      );
    }

    const entityId = created.value.entityId;

    if (parentId !== null) {
      // Re-parent after creation (the shared creator always lands at root).
      // The parent was validated above; if it vanished in between, the FK
      // rejects and the document simply stays at the workspace root.
      const reparented = await Result.tryPromise({
        try: async () =>
          await scopedDb(async (tx) => {
            // audit: skip — placement detail of an entity creation that was
            // already audited (createEntityFromBuffer records the CREATE).
            await tx
              .update(entities)
              .set({ parentId })
              .where(eq(entities.id, entityId));
          }),
        catch: (cause) => cause,
      });
      if (Result.isError(reparented)) {
        captureError(reparented.error, { entityId, parentId });
      }
    }

    const fillStatus =
      filled.unmatchedPlaceholders.length > 0 ? "partial" : "success";

    yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await scopedDb(async (tx) => {
            await tx.insert(templateFills).values({
              organizationId,
              templateId,
              userId: user.id,
              format: "docx",
              status: fillStatus,
              unmatchedCount: filled.unmatchedPlaceholders.length,
              unusedCount: filled.unusedValues.length,
              structureErrors:
                filled.structureErrors.length > 0
                  ? filled.structureErrors
                  : null,
            });

            await recordAuditEvent(tx, {
              action: AUDIT_ACTION.EXECUTE,
              resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE,
              resourceId: templateId,
              metadata: {
                entityId,
                status: fillStatus,
                unmatchedCount: filled.unmatchedPlaceholders.length,
              },
            });
          }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Template fill audit failed",
            cause,
          }),
      }),
    );

    return Result.ok({
      entityId,
      fileName: created.value.fileName,
      unmatchedPlaceholders: filled.unmatchedPlaceholders,
      unusedValues: filled.unusedValues,
    });
  },
);

export default fillTemplateToWorkspace;
