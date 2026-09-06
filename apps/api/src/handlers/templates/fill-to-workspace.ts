import { Result } from "better-result";
import { t } from "elysia";

import { templateFills } from "@/api/db/schema";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import {
  assertUsageAvailableForHandler,
  createSafeHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { clauseBodySchema } from "@/api/lib/clauses/body-schema";
import { tJsonObject, tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import {
  buildAiConditionDecider,
  buildAiFieldGenerator,
  buildAiOccurrenceAdapter,
} from "@/api/lib/docx/ai-field-generator";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { DOCX_EXT_RE, sanitizeFilename } from "@/api/lib/sanitize-filename";
import { hasTanStackInstanceProvider } from "@/api/lib/tanstack-ai-models";
import { containsNull } from "@/api/lib/templates/template-data";
import { fillStoredTemplateDocx } from "@/api/lib/templates/template-fill-service";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const fillToWorkspaceParamsSchema = workspaceParams({
  templateId: tSafeId("template"),
});

const fillToWorkspaceBodySchema = t.Object({
  /** Field-path → value map, same contract as the fill route. */
  values: tJsonObject,
  /** Per-fill clause edits keyed by slot patch key (`@clause:Name`), same
   *  contract as the fill route; the override body is inserted for a matching
   *  slot instead of the linked clause's resolved body. */
  clauseOverrides: t.Optional(t.Record(t.String(), clauseBodySchema)),
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
  description:
    "Fill a stored template and save the result as a new document in a " +
    "matter rather than returning bytes. Same values and clauseOverrides " +
    "contract as templates.fill-by-id, plus an optional document name (the " +
    ".docx extension is appended when missing) and a parent folder; the " +
    "created entity is returned.",
  permissions: { template: ["use"], entity: ["create"] },
  access: "write",
  mcp: { type: "covered", by: "save_filled_template" },
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

    if (Object.values(body.values).some(containsNull)) {
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

    // Built only when the manifest declares an AI field: the fill service
    // defers this, so a deterministic fill opens no metered trace.
    const aiCollaborators = () => {
      const aiAnalytics = createTanStackAIAnalyticsCallbacks({
        usageMetering: {
          actionType: "chat",
          organizationId,
          safeDb,
          serviceTier: "standard",
          userId: user.id,
          workspaceId,
        },
        feature: "templates.fill",
        modelRole: "fast",
        orgAIConfig,
        properties: { organization_id: organizationId },
        traceId: Bun.randomUUIDv7(),
      });
      const shared = {
        orgAIConfig,
        organizationId,
        skillContext: { organizationId, safeDb, userId: user.id },
        aiAnalytics,
        tenantWorkspaceIds: [workspaceId],
      };
      return {
        generateAiValue: buildAiFieldGenerator(shared),
        decideAiCondition: buildAiConditionDecider(shared),
        adaptAiValue: buildAiOccurrenceAdapter(shared),
      };
    };

    // The fill service runs this only when the manifest declares AI fields,
    // before any model call, so a deterministic fill never spends AI quota.
    // Gated on a usable provider — org BYOK or the deployment's instance
    // provider — because the generators below run the fast model in either
    // case, so an instance-provider fill must still be quota-checked. A null
    // org config flows through to the metering layer (instance-provider rate).
    const assertUsageAvailable =
      orgAIConfig || hasTanStackInstanceProvider()
        ? async () =>
            await assertUsageAvailableForHandler({
              metering: { actionType: "chat", modelRole: "fast" },
              organizationId,
              orgAIConfig,
              workspaceId,
              userId: user.id,
              safeDb,
            })
        : undefined;

    const filled = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await fillStoredTemplateDocx({
            templateId,
            values: body.values,
            scopedDb,
            organizationId,
            workspaceId,
            requiredFields: "enforce",
            clauseOverrides: body.clauseOverrides,
            assertUsageAvailable,
            aiCollaborators,
          }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Template fill failed",
            cause,
          }),
      }),
    );

    if ("usageRejection" in filled) {
      // The preflight rejected the AI fill (over quota / no entitlement);
      // surface the framework's exact 402/500 error body unchanged.
      return Result.err(filled.usageRejection);
    }

    if ("error" in filled) {
      return Result.err(
        new HandlerError({ status: 400, message: filled.error }),
      );
    }

    if ("requiredFieldsRejection" in filled) {
      const names = filled.requiredFieldsRejection.map(
        (field) => field.label ?? field.path,
      );
      return Result.err(
        new HandlerError({
          status: 400,
          message: `Missing required template values: ${names.join(", ")}`,
          // The message alone loses each field's input type/options; carry
          // the full rejection so a client can render the right control per
          // field and retry with all of them at once.
          requiredFields: filled.requiredFieldsRejection,
        }),
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
            parentId,
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

    // A failed AI draft leaves its field unfilled, so it counts against the
    // fill the same way an unmatched placeholder does.
    const fillStatus =
      filled.unmatchedPlaceholders.length > 0 || filled.aiFieldErrors.length > 0
        ? "partial"
        : "success";

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
      fieldId: created.value.fieldId,
      fileName: created.value.fileName,
      unmatchedPlaceholders: filled.unmatchedPlaceholders,
      unusedValues: filled.unusedValues,
      // Fields whose AI draft failed: unfilled in the saved document, so the
      // person who filled the template has to write them.
      aiFieldErrors: filled.aiFieldErrors,
    });
  },
);

export default fillTemplateToWorkspace;
