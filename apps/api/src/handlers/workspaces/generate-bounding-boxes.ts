import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";

import { isMockAI } from "@/api/consts";
import { justifications } from "@/api/db/schema";
import { aiHandlerError } from "@/api/lib/ai-error";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { generateBBoxes } from "@/api/lib/bbox/generate-b-boxes";
import { generateBBoxesMock } from "@/api/lib/bbox/generate-b-boxes-mock";
import { prepareJustificationData } from "@/api/lib/bbox/generate-b-boxes-shared";
import { tSafeId } from "@/api/lib/custom-schema";
import type { BoundingBox } from "@/api/types";

const config = {
  permissions: { workspace: ["update"] },
  body: t.Object({
    justificationId: tSafeId("justification"),
  }),
} satisfies HandlerConfig;

const generateBoundingBoxes = createSafeHandler(
  config,
  async function* ({
    scopedDb,
    safeDb,
    session,
    workspaceId,
    body,
    orgAIConfig,
  }) {
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

    const generateFn = isMockAI() ? generateBBoxesMock : generateBBoxes;
    const boxes: BoundingBox[] = [];

    for (const pageNumber of preparedData.pageNumbers) {
      const pageBoxesResult = await generateFn({
        abortSignal: AbortSignal.timeout(60_000),
        justificationId,
        organizationId,
        orgAIConfig: orgAIConfig ?? null,
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
        // `WorkflowIntegrationError.cause` carries the underlying AI
        // provider failure (APICallError / RetryError) — classify
        // against that so quota/credits map to 429/402 instead of
        // bubbling up as an uncaught Panic and returning 500.
        return Result.err(
          aiHandlerError(pageBoxesResult.error.cause, {
            status: 502,
            message: "Bounding box generation failed",
          }),
        );
      }

      boxes.push(...pageBoxesResult.value);

      yield* Result.await(
        safeDb((tx) =>
          tx
            .update(justifications)
            .set({
              boundingBoxes: {
                version: 1,
                boxes,
              },
            })
            .where(eq(justifications.id, justificationId)),
        ),
      );
    }

    return Result.ok({ boxes });
  },
);

export default generateBoundingBoxes;
