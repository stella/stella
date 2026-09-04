import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import {
  entities,
  entityVersions,
  fields,
  pdfAnonymizationRuns,
} from "@/api/db/schema";
import { createPdfAnonymizationRunBodySchema } from "@/api/handlers/pdf-anonymization/schemas";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { PDF_ANONYMIZATION_RUN_ACTIVE_STATUSES } from "@/api/lib/pdf-anonymization/contract";
import { handoffCommittedPdfAnonymizationRun } from "@/api/lib/pdf-anonymization/handoff";
import { brandPersistedUserFileId } from "@/api/lib/safe-id-boundaries";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const config = {
  description:
    "Start a verified image-only PDF anonymization and save its output as a new document.",
  permissions: { entity: ["create"] },
  access: "write",
  mcp: { type: "internal", reason: "document_processing" },
  params: workspaceParams({}),
  body: createPdfAnonymizationRunBodySchema,
} satisfies HandlerConfig;

type CreatePdfAnonymizationRunResult = {
  runId: SafeId<"pdfAnonymizationRun">;
};

const createPdfAnonymizationRun = createSafeHandler<
  typeof config,
  CreatePdfAnonymizationRunResult
>(
  config,
  async function* ({
    body,
    recordAuditEvent,
    safeDb,
    session,
    user,
    workspaceId,
  }) {
    const sources = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            entityVersionId: entityVersions.id,
            content: fields.content,
          })
          .from(entities)
          .innerJoin(
            entityVersions,
            and(
              eq(entityVersions.id, entities.currentVersionId),
              eq(entityVersions.entityId, entities.id),
              eq(entityVersions.workspaceId, workspaceId),
            ),
          )
          .innerJoin(
            fields,
            and(
              eq(fields.id, body.fieldId),
              eq(fields.entityVersionId, entityVersions.id),
            ),
          )
          .where(
            and(
              eq(entities.id, body.entityId),
              eq(entities.workspaceId, workspaceId),
            ),
          )
          .limit(1),
      ),
    );
    const source = sources.at(0);
    if (!source || source.content.type !== "file") {
      return Result.err(
        new HandlerError({ status: 404, message: "Source PDF not found" }),
      );
    }
    if (source.content.mimeType !== PDF_MIME_TYPE) {
      return Result.err(
        new HandlerError({ status: 422, message: "The source must be a PDF" }),
      );
    }
    if (source.content.encrypted) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "Encrypted PDFs cannot be anonymized",
        }),
      );
    }
    const sourceContent = source.content;

    const organizationId = session.activeOrganizationId;
    const sourceFileId = brandPersistedUserFileId(sourceContent.id);
    const runId = createSafeId<"pdfAnonymizationRun">();
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const created = await tx
          .insert(pdfAnonymizationRuns)
          .values({
            id: runId,
            organizationId,
            workspaceId,
            entityId: body.entityId,
            fileFieldId: body.fieldId,
            entityVersionId: source.entityVersionId,
            sourceFileId,
            sourceFileName: sourceContent.fileName,
            sourceMimeType: sourceContent.mimeType,
            sourceSha256Hex: sourceContent.sha256Hex,
            requestedBy: user.id,
          })
          .onConflictDoNothing()
          .returning({ id: pdfAnonymizationRuns.id });
        const inserted = created.at(0);
        if (inserted) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.EXECUTE,
            resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
            resourceId: body.entityId,
            metadata: {
              operation: "pdf_anonymization",
              runId: inserted.id,
              sourceSha256Hex: sourceContent.sha256Hex,
            },
          });
          return inserted.id;
        }
        const active = await tx
          .select({ id: pdfAnonymizationRuns.id })
          .from(pdfAnonymizationRuns)
          .where(
            and(
              eq(pdfAnonymizationRuns.workspaceId, workspaceId),
              eq(pdfAnonymizationRuns.entityId, body.entityId),
              eq(pdfAnonymizationRuns.fileFieldId, body.fieldId),
              inArray(pdfAnonymizationRuns.status, [
                ...PDF_ANONYMIZATION_RUN_ACTIVE_STATUSES,
              ]),
            ),
          )
          .limit(1);
        return active.at(0)?.id ?? null;
      }),
    );
    if (result === null) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "PDF anonymization could not be started",
        }),
      );
    }
    await handoffCommittedPdfAnonymizationRun({
      runId: result,
      organizationId,
      workspaceId,
      userId: user.id,
    });
    return Result.ok({ runId: result });
  },
);

export default createPdfAnonymizationRun;
