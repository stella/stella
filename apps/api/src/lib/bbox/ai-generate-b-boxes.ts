import { generateText, Output } from "ai";
import { panic, Result } from "better-result";

import { getModelForRole } from "@/api/lib/ai-models";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import { strictOutputSchema } from "@/api/lib/ai-output-schema";
import { createAIAnalyticsCallbacks } from "@/api/lib/analytics/ai";
import {
  BBOX_ARRAY_DESCRIPTION,
  BBOX_SYSTEM_PROMPT,
  bboxItemSchema,
  buildBBoxUserMessage,
} from "@/api/lib/bbox/ai-prompts";
import type { SafeId } from "@/api/lib/branded-types";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";

// `bboxItemSchema` already validated `v.length(4)`; this only narrows
// the static type from `number[]` to the 4-tuple without a cast.
const toBBoxTuple = (item: number[]): [number, number, number, number] => {
  const [yMin, xMin, yMax, xMax] = item;
  if (
    yMin === undefined ||
    xMin === undefined ||
    yMax === undefined ||
    xMax === undefined
  ) {
    panic("BBox element passed length validation but has missing values");
  }
  return [yMin, xMin, yMax, xMax];
};

type GenerateBBoxDataProps = {
  pdfData: Uint8Array;
  prompt: string;
  fieldContent: string;
  justificationText: string;
  abortSignal: AbortSignal;
  justificationId: string;
  organizationId: SafeId<"organization">;
  pageNumber: number;
  workspaceId: SafeId<"workspace">;
  orgAIConfig?: OrgAIConfig | null;
  promptCachingEnabled: boolean;
};

export const generateBBoxData = async ({
  pdfData,
  prompt,
  fieldContent,
  justificationText,
  abortSignal,
  justificationId,
  organizationId,
  pageNumber,
  workspaceId,
  orgAIConfig,
  promptCachingEnabled,
}: GenerateBBoxDataProps): Promise<
  Result<[number, number, number, number][], WorkflowIntegrationError>
> => {
  const aiAnalytics = createAIAnalyticsCallbacks({
    feature: "bbox.generate",
    modelRole: "pdf",
    orgAIConfig: orgAIConfig ?? null,
    properties: {
      justification_id: justificationId,
      organization_id: organizationId,
      page_number: pageNumber,
      workspace_id: workspaceId,
    },
    sessionId: justificationId,
    traceId: Bun.randomUUIDv7(),
  });

  const generated = await Result.tryPromise({
    try: async () => {
      const result = await generateText({
        model: getModelForRole("pdf", orgAIConfig, {
          promptCachingEnabled,
          scopeKey: justificationId,
          organizationId,
          serviceTier: "standard",
        }),
        system: BBOX_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "file",
                data: pdfData,
                mediaType: "application/pdf",
              },
              {
                type: "text",
                text: buildBBoxUserMessage({
                  prompt,
                  fieldContent,
                  justificationText,
                }),
              },
            ],
          },
        ],
        output: Output.array({
          element: strictOutputSchema(bboxItemSchema),
          description: BBOX_ARRAY_DESCRIPTION,
        }),
        abortSignal,
        ...aiAnalytics.stepCallbacks,
      });

      return result.output;
    },
    catch: (error) => {
      aiAnalytics.captureError(error);

      return new WorkflowIntegrationError({
        message: "BBox AI generation failed",
        cause: error,
      });
    },
  });

  if (Result.isError(generated)) {
    return Result.err(generated.error);
  }
  // Previously enforced by `v.nonEmpty()` on the array schema;
  // `Output.array` validates per element, so the emptiness invariant
  // moves here.
  if (generated.value.length === 0) {
    const error = new WorkflowIntegrationError({
      message: "BBox AI generation returned no bounding boxes",
    });
    aiAnalytics.captureError(error);
    return Result.err(error);
  }
  return Result.ok(generated.value.map(toBBoxTuple));
};
