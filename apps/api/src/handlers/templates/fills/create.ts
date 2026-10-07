import { Result } from "better-result";
import { t } from "elysia";

import { memberAIAccessError } from "@/api/lib/ai-config-response";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import {
  ACCOUNT_ACCESS,
  authorizeHandlerUsage,
  createSafeHandler,
} from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { clauseBodySchema } from "@/api/lib/clauses/body-schema";
import { tJsonObject, tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import {
  buildAiConditionDecider,
  buildAiFieldGenerator,
  buildAiOccurrenceAdapter,
} from "@/api/lib/docx/ai-field-generator";
import {
  DocumentWriteRefusedError,
  documentWriteRefusalHandlerError,
} from "@/api/lib/entities/authorize-document-write";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { serverBuiltFileEncryption } from "@/api/lib/files/detect-file-encryption";
import {
  DOCX_EXT_RE,
  sanitizeFilename,
  type SanitizedFileName,
} from "@/api/lib/sanitize-filename";
import { hasTanStackInstanceProvider } from "@/api/lib/tanstack-ai-models";
import { recordTemplateFill } from "@/api/lib/templates/record-use";
import { containsNull } from "@/api/lib/templates/template-data";
import {
  fillDiagnosticsOf,
  templateFillStatus,
} from "@/api/lib/templates/template-fill-completion";
import type { AiFillCollaboratorProvider } from "@/api/lib/templates/template-fill-service";
import {
  fillTemplateDocx,
  loadStoredTemplateSource,
} from "@/api/lib/templates/template-fill-service";
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

/** The created document's file name: the caller's sanitized name (extension
 *  ensured) or the template's own file name. */
const resolveDocumentFileName = (
  requestedName: SanitizedFileName | null,
  templateFileName: string,
): string => {
  if (requestedName === null) {
    return templateFileName;
  }
  return DOCX_EXT_RE.test(requestedName)
    ? requestedName
    : `${requestedName}.docx`;
};

const config = {
  contentDelivery: {
    type: "none",
    reason:
      "Processes template content and returns parsed data or saved-document metadata rather than stored-file bytes.",
  },
  description:
    "Fill a stored template and save the result as a new document in a " +
    "matter rather than returning bytes. Same values and clauseOverrides " +
    "contract as templates.fills.download, plus an optional document name (the " +
    ".docx extension is appended when missing) and a parent folder; the " +
    "created entity is returned.",
  permissions: { template: ["use"], entity: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "write",
  mcp: { type: "covered", by: "save_filled_template" },
  params: fillToWorkspaceParamsSchema,
  body: fillToWorkspaceBodySchema,
} satisfies WorkspaceHandlerConfig;

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
    managedAIResidency,
    orgAIConfigStatus,
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
    const buildCollaborators = () => {
      const aiAnalytics = createTanStackAIAnalyticsCallbacks({
        dataClass: "customer",
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
        managedAIResidency,
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
    // before any model call, so a deterministic fill never spends AI quota
    // and stays open to every member. A member the organization does not
    // admit to AI work is refused here, whichever key would serve the
    // fields. The usage check is gated on a usable provider — org BYOK or
    // the deployment's instance provider — because the generators below run
    // the fast model in either case, so an instance-provider fill must still
    // be quota-checked. A null org config flows through to the metering
    // layer (instance-provider rate).
    const aiCollaborators: AiFillCollaboratorProvider<
      HandlerError<402 | 403 | 500>
    > = async () => {
      const accessError = memberAIAccessError(orgAIConfigStatus);
      if (accessError !== null) {
        return Result.err(accessError);
      }
      return await authorizeHandlerUsage({
        metering:
          orgAIConfig || hasTanStackInstanceProvider()
            ? { actionType: "chat", modelRole: "fast" }
            : null,
        organizationId,
        orgAIConfig,
        workspaceId,
        userId: user.id,
        safeDb,
        buildCollaborators,
      });
    };

    // A missing template is a 404, and a stored file the scan refuses (or a
    // scanner outage) answers as it would for an upload: 422 or 503.
    const source = yield* Result.await(
      loadStoredTemplateSource({ templateId, organizationId, scopedDb }),
    );

    const filled = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await fillTemplateDocx({
            source,
            values: body.values,
            scopedDb,
            organizationId,
            thirdPartyOutboundPermit: grantThirdPartyOutboundPermit(),
            workspaceId,
            requiredFields: "enforce",
            clauseOverrides: body.clauseOverrides,
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
      // The preflight rejected the AI fill (over quota / no entitlement, or
      // a member not admitted to AI work); surface the framework's exact
      // 402/403/500 error body unchanged.
      return Result.err(filled.usageRejection);
    }

    if ("error" in filled) {
      return Result.err(
        filled.storedTemplateError ??
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

    const requestedName = body.name?.trim() ?? "";
    const fileName = resolveDocumentFileName(
      requestedName === "" ? null : sanitizeFilename(requestedName),
      filled.fileName,
    );

    const created = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await createEntityFromBuffer({
            scopedDb,
            organizationId,
            workspaceId,
            userId: user.id,
            recordAuditEvent,
            buffer: filled.file.bytes,
            fileName,
            mimeType: DOCX_MIME_TYPE,
            encryption: serverBuiltFileEncryption(),
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
        DocumentWriteRefusedError.is(created.error)
          ? documentWriteRefusalHandlerError(created.error)
          : new HandlerError({ status: 400, message: created.error.message }),
      );
    }

    const entityId = created.value.entityId;

    const diagnostics = fillDiagnosticsOf(filled);
    // The completion decision over every diagnostic: a failed AI draft, an
    // undecided AI condition or an unresolved clause counts against the fill
    // the same way an unmatched placeholder does.
    const fillStatus = templateFillStatus(diagnostics);

    yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await scopedDb(async (tx) => {
            await recordTemplateFill({
              tx,
              templateId,
              organizationId,
              userId: user.id,
              // The handler's own workspace, which its recorder is bound to.
              workspaceId,
              entityId,
              format: "docx",
              diagnostics,
              recordAuditEvent,
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
      // The recorded completion decision: `partial` when any diagnostic
      // below is blocking, so the client reports the document as incomplete
      // instead of as created.
      completionStatus:
        fillStatus === "success" ? ("complete" as const) : ("partial" as const),
      unmatchedPlaceholders: filled.unmatchedPlaceholders,
      unusedValues: filled.unusedValues,
      clauseWarnings: filled.clauseWarnings,
      // Fields whose AI draft failed: unfilled in the saved document, so the
      // person who filled the template has to write them.
      aiFieldErrors: filled.aiFieldErrors,
      // AI-decided conditions nothing settled: their blocks were rendered as
      // if false, so the person who filled the template has to decide them.
      undecidedConditions: diagnostics.undecidedConditions.map(
        ({ path, label, reason }) => ({ path, label, reason }),
      ),
      // Directives the renderer could not apply: the saved document renders
      // them wrong, so the person who filled the template has to fix them.
      structureErrors: diagnostics.structureErrors.map(
        ({ directive, message, paragraphIndex }) => ({
          directive,
          message,
          paragraphIndex,
        }),
      ),
    });
  },
);

export default fillTemplateToWorkspace;
