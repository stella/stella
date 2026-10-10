import type { DocumentPart } from "@tanstack/ai";
import type { AnthropicDocumentMetadata } from "@tanstack/ai-anthropic";
import { Result } from "better-result";

import { resolveCaching, type OrgAIConfig } from "@/api/lib/ai-config";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import {
  BBOX_SYSTEM_PROMPT,
  bboxOutputSchema,
  buildBBoxUserMessage,
  type BBoxItem,
} from "@/api/lib/bbox/ai-prompts";
import type { SafeId } from "@/api/lib/branded-types";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";
import { markTanStackCacheBreakpoint } from "@/api/lib/tanstack-ai-caching";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";

type GenerateBBoxDataProps = {
  pdfData: Uint8Array;
  prompt: string;
  fieldContent: string;
  justificationText: string;
  abortSignal: AbortSignal;
  justificationId: string;
  organizationId: SafeId<"organization">;
  admission: ModelDispatchAdmission;
  pageNumber: number;
  workspaceId: SafeId<"workspace">;
  orgAIConfig?: OrgAIConfig | null;
  managedAIResidency: ManagedAIResidency;
  promptCachingEnabled: boolean;
  /** External model-dispatch boundary; supplied by focused integration tests. */
  generateObjectForRole?: typeof generateTanStackObjectForRole | undefined;
};

export const generateBBoxData = async ({
  pdfData,
  prompt,
  fieldContent,
  justificationText,
  abortSignal,
  justificationId,
  organizationId,
  admission,
  pageNumber,
  workspaceId,
  orgAIConfig,
  managedAIResidency,
  promptCachingEnabled,
  generateObjectForRole = generateTanStackObjectForRole,
}: GenerateBBoxDataProps): Promise<
  Result<BBoxItem[], WorkflowIntegrationError>
> => {
  const caching = resolveCaching({
    promptCachingEnabled,
    role: "pdf",
    scopeKey: justificationId,
  });
  const aiAnalytics = createTanStackAIAnalyticsCallbacks({
    dataClass: "customer",
    feature: "bbox.generate",
    modelRole: "pdf",
    organizationId,
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
      };
      const result = await generateObjectForRole({
        dataClass: "customer",
        role: "pdf",
        serviceTier: "standard",
        orgAIConfig,
        managedAIResidency,
        organizationId,
        admission,
        tenantWorkspaceIds: [workspaceId],
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

  // An empty list is an answer, not a failure: the system prompt asks
  // for the minimum number of boxes, and a cited page whose content
  // the model matches nothing on legitimately yields none. Only the
  // provider call itself can fail here.
  return generated;
};
