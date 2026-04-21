import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";

import { isMockAI } from "@/api/consts";
import { justifications } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { generateBBoxes } from "@/api/lib/bbox/generate-b-boxes";
import { generateBBoxesMock } from "@/api/lib/bbox/generate-b-boxes-mock";
import { prepareJustificationData } from "@/api/lib/bbox/generate-b-boxes-shared";
import { tUuid } from "@/api/lib/custom-schema";

const config = {
  permissions: { workspace: ["update"] },
  body: t.Object({
    justificationId: tUuid,
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
    const bBoxes = await Promise.all(
      preparedData.pageNumbers.map(
        async (pageNumber) =>
          await generateFn({
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
          }),
      ),
    );

    const boxes = bBoxes.flat();

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

    return Result.ok({ boxes });
  },
);

export default generateBoundingBoxes;
