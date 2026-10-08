import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";

import { justifications } from "@/api/db/schema";
import type { BoundingBox } from "@/api/db/schema-validators";
import { workspaceRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { memberAIAccessError } from "@/api/lib/ai-config-response";
import { aiHandlerError } from "@/api/lib/ai-error";
import { captureError } from "@/api/lib/analytics/capture";
import {
  ACCOUNT_ACCESS,
  configuredModelAdmission,
  createSafeHandler,
} from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { generateBBoxes } from "@/api/lib/bbox/generate-b-boxes";
import { generateBBoxesMock } from "@/api/lib/bbox/generate-b-boxes-mock";
import { prepareJustificationData } from "@/api/lib/bbox/generate-b-boxes-shared";
import { tSafeId } from "@/api/lib/custom-schema";
import { mockAnswersForOrganization } from "@/api/lib/tanstack-ai-models";

const config = {
  actionAdmission: { type: "handler", actionKind: "documents.bounding-boxes" },
  contentDelivery: {
    type: "none",
    reason: "Generates document geometry without delivering stored-file bytes.",
  },
  permissions: { workspace: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: workspaceRealtimeUpdates,
  mcp: { type: "internal", reason: "document_processing" },
  body: t.Object({
    justificationId: tSafeId("justification"),
  }),
} satisfies WorkspaceHandlerConfig;

const generateBoundingBoxes = createSafeHandler(
  config,
  async function* ({
    modelAdmission,
    scopedDb,
    safeDb,
    session,
    workspaceId,
    body,
    orgAIConfig,
    managedAIResidency,
    orgAIConfigStatus,
    promptCachingEnabled,
  }) {
    const accessError = memberAIAccessError(orgAIConfigStatus);
    if (accessError) {
      return Result.err(accessError);
    }
    const organizationId = session.activeOrganizationId;
    const { justificationId } = body;

    const preparedDataResult = await prepareJustificationData(
      organizationId,
      workspaceId,
      justificationId,
      scopedDb,
    );

    if (Result.isError(preparedDataResult)) {
      captureError(preparedDataResult.error, {
        method: "POST",
        path: `/workspaces/${workspaceId}/bounding-boxes`,
      });

      return Result.ok({ boxes: [] });
    }

    const preparedData = preparedDataResult.value;

    // Same rule as chat: an organization's own key answers for real.
    const generateFn = mockAnswersForOrganization(orgAIConfig)
      ? generateBBoxesMock
      : generateBBoxes;
    const boxes: BoundingBox[] = [];
    if (preparedData.pageNumbers.length === 0) {
      return Result.ok({ boxes });
    }

    for (const pageNumber of preparedData.pageNumbers) {
      const pageBoxesResult = await generateFn({
        abortSignal: AbortSignal.timeout(60_000),
        admission: configuredModelAdmission({ modelAdmission }),
        justificationId,
        organizationId,
        orgAIConfig: orgAIConfig ?? null,
        managedAIResidency,
        promptCachingEnabled,
        workspaceId,
        data: {
          pdf: preparedData.pdf,
          pageNumber,
          prompt: preparedData.prompt,
          fieldContent: preparedData.fieldContent,
          justificationText: preparedData.justificationText,
        },
      });

      if (Result.isError(pageBoxesResult)) {
        captureError(pageBoxesResult.error, {
          feature: "bbox.generate",
          workspaceId,
          organizationId,
        });
        // `WorkflowIntegrationError.cause` carries the underlying
        // provider failure — classify
        // against that so quota/usage-limit errors map to 429/402 instead of
        // bubbling up as an uncaught Panic and returning 500.
        return Result.err(
          aiHandlerError(pageBoxesResult.error.cause, {
            status: 502,
            message: "Bounding box generation failed",
          }),
        );
      }

      boxes.push(...pageBoxesResult.value);
    }

    yield* Result.await(
      safeDb(async (tx) => {
        // audit: skip — background OCR pipeline persisting computed bounding
        // boxes; derived AI output, not a user mutation.
        await tx
          .update(justifications)
          .set({
            boundingBoxes: {
              version: 1,
              boxes,
            },
          })
          .where(eq(justifications.id, justificationId));
      }),
    );

    return Result.ok({ boxes });
  },
);

export default generateBoundingBoxes;
