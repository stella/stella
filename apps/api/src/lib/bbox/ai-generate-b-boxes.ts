import type { DocumentPart } from "@tanstack/ai";
import type { AnthropicDocumentMetadata } from "@tanstack/ai-anthropic";
import { panic, Result } from "better-result";
import * as v from "valibot";

import { resolveCaching, type OrgAIConfig } from "@/api/lib/ai-config";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import {
  BBOX_ARRAY_DESCRIPTION,
  BBOX_SYSTEM_PROMPT,
  bboxItemSchema,
  buildBBoxUserMessage,
} from "@/api/lib/bbox/ai-prompts";
import type { SafeId } from "@/api/lib/branded-types";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import { markTanStackCacheBreakpoint } from "@/api/lib/tanstack-ai-caching";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";

const bboxOutputSchema = v.strictObject({
  boxes: v.pipe(
    v.array(bboxItemSchema),
    v.minLength(1),
    v.description(BBOX_ARRAY_DESCRIPTION),
  ),
});

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
  const caching = resolveCaching({
    promptCachingEnabled,
    role: "pdf",
    scopeKey: justificationId,
  });
  const aiAnalytics = createTanStackAIAnalyticsCallbacks({
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
      const pdfPart: DocumentPart<AnthropicDocumentMetadata> = {
        type: "document",
        source: {
          type: "data",
          value: Buffer.from(pdfData).toString("base64"),
          mimeType: "application/pdf",
        },
        metadata: { mediaType: "application/pdf" },
      };
      const result = await generateTanStackObjectForRole({
        role: "pdf",
        orgAIConfig,
        organizationId,
        analytics: aiAnalytics,
        caching,
        system: BBOX_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              markTanStackCacheBreakpoint(pdfPart, { decision: caching }),
              {
                type: "text",
                content: buildBBoxUserMessage({
                  prompt,
                  fieldContent,
                  justificationText,
                }),
              },
            ],
          },
        ],
        outputSchema: bboxOutputSchema,
        abortSignal,
      });

      return result.boxes;
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
  if (generated.value.length === 0) {
    const error = new WorkflowIntegrationError({
      message: "BBox AI generation returned no bounding boxes",
    });
    aiAnalytics.captureError(error);
    return Result.err(error);
  }
  return Result.ok(generated.value.map(toBBoxTuple));
};
