import type { GoogleGenerativeAIProviderOptions } from "@ai-sdk/google";
import { valibotSchema } from "@ai-sdk/valibot";
import { generateText, Output } from "ai";
import { Result } from "better-result";

import { getModelForRole, getTemperatureForRole } from "@/api/lib/ai-models";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import { createAIAnalyticsCallbacks } from "@/api/lib/analytics/ai";
import {
  BBOX_SYSTEM_PROMPT,
  bboxSchema,
  buildBBoxUserMessage,
} from "@/api/lib/bbox/ai-prompts";
import type { SafeId } from "@/api/lib/branded-types";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";

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

  return await Result.tryPromise({
    try: async () => {
      const result = await generateText({
        model: getModelForRole("pdf", orgAIConfig, {
          promptCachingEnabled,
          scopeKey: justificationId,
        }),
        temperature: getTemperatureForRole("pdf"),
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
        output: Output.object({ schema: valibotSchema(bboxSchema) }),
        providerOptions: {
          google: {
            thinkingConfig: {
              thinkingLevel: "minimal",
              includeThoughts: false,
            },
          } satisfies GoogleGenerativeAIProviderOptions,
        },
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
};
