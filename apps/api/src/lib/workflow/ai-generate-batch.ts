import type { DocumentPart, TextPart } from "@tanstack/ai";
import type {
  AnthropicDocumentMetadata,
  AnthropicTextMetadata,
} from "@tanstack/ai-anthropic";
import { panic, Result } from "better-result";

import { resolveCaching } from "@/api/lib/ai-config";
import type { AIRequestServiceTier, OrgAIConfig } from "@/api/lib/ai-config";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { AIUsageMetering } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import { sanitizeForPrompt, untrustedText } from "@/api/lib/prompt-safety";
import { markTanStackCacheBreakpoint } from "@/api/lib/tanstack-ai-caching";
import { streamTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";
import {
  buildBatchSchema,
  buildDocxBlocksMessage,
  buildExtractedFileMessage,
  buildPromptsMessage,
  buildTextInputsMessage,
  WORKFLOW_SYSTEM_PROMPT,
} from "@/api/lib/workflow/ai-prompts";
import type { Answer } from "@/api/lib/workflow/ai-prompts";
import type { PreparedInputFile } from "@/api/lib/workflow/generate-batch";
import type { TextInput } from "@/api/lib/workflow/generate-batch-shared";
import type { AIBatchProperty } from "@/api/lib/workflow/get-execution-plan";
import type {
  AIJustificationOutput,
  JustificationFilenames,
} from "@/api/lib/workflow/parse-justifications";
import {
  consumePartialAnswers,
  consumeTanStackPartialAnswer,
} from "@/api/lib/workflow/streaming-answer";
import type { PartialAnswerUpdate } from "@/api/lib/workflow/streaming-answer";

type GenerateWorkflowDataProps = {
  files: PreparedInputFile[];
  properties: AIBatchProperty[];
  filenames: JustificationFilenames;
  textInputs: TextInput[];
  abortSignal: AbortSignal;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  entityVersionId: string;
  orgAIConfig?: OrgAIConfig | null;
  promptCachingEnabled: boolean;
  serviceTier: AIRequestServiceTier;
  usageMetering?: AIUsageMetering | undefined;
  onPartialAnswer?:
    | ((update: PartialAnswerUpdate) => Promise<void> | void)
    | undefined;
};

type WorkflowDataOutput = Record<
  string,
  { answer: Answer; justification: AIJustificationOutput }
>;

type WorkflowAIAnalyticsProps = Parameters<
  typeof createTanStackAIAnalyticsCallbacks
>[0];

type BuildWorkflowAIAnalyticsPropsInput = {
  entityVersionId: string;
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  propertyCount: number;
  usageMetering?: AIUsageMetering | undefined;
  workspaceId: SafeId<"workspace">;
};

export const EXTRACTED_TEXT_PROMPT_LIMITS = {
  perFileChars: 40_000,
  totalChars: 100_000,
} as const;

const EXTRACTED_TEXT_TRUNCATION_MARKER =
  "\n\n[… content truncated to fit AI prompt limits …]";

type LimitExtractedTextPromptContentOptions = {
  content: string;
  fileCount: number;
};

export const limitExtractedTextPromptContent = ({
  content,
  fileCount,
}: LimitExtractedTextPromptContentOptions): string => {
  if (fileCount < 1) {
    panic("Extracted-text prompt file count must be positive");
  }
  const fairShare = Math.floor(
    EXTRACTED_TEXT_PROMPT_LIMITS.totalChars / fileCount,
  );
  const maxChars = Math.min(
    EXTRACTED_TEXT_PROMPT_LIMITS.perFileChars,
    fairShare,
  );
  if (content.length <= maxChars) {
    return content;
  }
  if (maxChars <= EXTRACTED_TEXT_TRUNCATION_MARKER.length) {
    return EXTRACTED_TEXT_TRUNCATION_MARKER.slice(0, maxChars);
  }
  return `${content.slice(0, maxChars - EXTRACTED_TEXT_TRUNCATION_MARKER.length)}${EXTRACTED_TEXT_TRUNCATION_MARKER}`;
};

export const buildWorkflowAIAnalyticsProps = ({
  entityVersionId,
  organizationId,
  orgAIConfig,
  propertyCount,
  usageMetering,
  workspaceId,
}: BuildWorkflowAIAnalyticsPropsInput): WorkflowAIAnalyticsProps => ({
  feature: "workflow.generate-batch",
  modelRole: "pdf",
  orgAIConfig,
  properties: {
    entity_version_id: entityVersionId,
    organization_id: organizationId,
    property_count: propertyCount,
    workspace_id: workspaceId,
  },
  sessionId: entityVersionId,
  traceId: Bun.randomUUIDv7(),
  ...(usageMetering ? { usageMetering } : {}),
});

export const generateWorkflowData = async ({
  files,
  properties,
  filenames,
  textInputs,
  abortSignal,
  entityVersionId,
  organizationId,
  workspaceId,
  orgAIConfig,
  promptCachingEnabled,
  serviceTier,
  usageMetering,
  onPartialAnswer,
}: GenerateWorkflowDataProps): Promise<
  Result<WorkflowDataOutput, WorkflowIntegrationError>
> => {
  const schema = buildBatchSchema(properties, filenames);
  const cachingDecision = resolveCaching({
    promptCachingEnabled,
    role: "pdf",
    scopeKey: entityVersionId,
  });

  type WorkflowMessagePart =
    | DocumentPart<AnthropicDocumentMetadata>
    | TextPart<AnthropicTextMetadata>;

  const messageContent: WorkflowMessagePart[] = [];
  const extractedTextFileCount = files.filter(
    (file) => file.kind === "extracted-text",
  ).length;

  for (const file of files) {
    if (file.kind === "pdf") {
      messageContent.push({
        type: "document",
        source: {
          type: "data",
          value: Buffer.from(file.content).toString("base64"),
          mimeType: file.mimeType,
        },
        metadata: { mediaType: file.mimeType },
      });
      continue;
    }
    if (file.kind === "extracted-text") {
      messageContent.push({
        type: "text",
        content: buildExtractedFileMessage({
          content: sanitizeForPrompt(
            untrustedText(
              limitExtractedTextPromptContent({
                content: file.content,
                fileCount: extractedTextFileCount,
              }),
            ),
          ),
          simplifiedName: file.simplifiedName,
        }),
      });
      continue;
    }
    // DOCX: serialise folio blocks inline. The model cites block ids back in
    // `justification.citations` instead of bates stamps.
    messageContent.push({
      type: "text",
      content: buildDocxBlocksMessage({
        simplifiedName: file.simplifiedName,
        blocks: file.blocks,
      }),
    });
  }

  if (textInputs.length > 0) {
    messageContent.push({
      type: "text",
      content: buildTextInputsMessage(textInputs),
    });
  }

  const lastStaticIdx = messageContent.length - 1;
  if (lastStaticIdx >= 0) {
    const lastStatic = messageContent[lastStaticIdx];
    if (lastStatic) {
      messageContent[lastStaticIdx] = markTanStackCacheBreakpoint(lastStatic, {
        decision: cachingDecision,
      });
    }
  }

  messageContent.push({
    type: "text",
    content: buildPromptsMessage(properties),
  });

  const aiAnalytics = createTanStackAIAnalyticsCallbacks(
    buildWorkflowAIAnalyticsProps({
      entityVersionId,
      organizationId,
      orgAIConfig: orgAIConfig ?? null,
      propertyCount: properties.length,
      usageMetering,
      workspaceId,
    }),
  );

  return await Result.tryPromise({
    try: async () => {
      const stream = streamTanStackObjectForRole({
        role: "pdf",
        orgAIConfig,
        organizationId,
        tenantWorkspaceIds: [workspaceId],
        analytics: aiAnalytics,
        caching: cachingDecision,
        serviceTier,
        messages: [{ role: "user", content: messageContent }],
        system: WORKFLOW_SYSTEM_PROMPT,
        abortSignal,
        outputSchema: schema,
      });

      let rawJson = "";
      let output: WorkflowDataOutput | undefined;
      const propertyIds = properties.map((property) => property.id);

      for await (const event of stream) {
        if (event.type === "complete") {
          output = event.object;
          continue;
        }

        if (!onPartialAnswer) {
          continue;
        }

        if (event.type === "partial") {
          await consumePartialAnswers({
            partialOutputs: [event.partial],
            propertyIds,
            onPartialAnswer,
          });
          continue;
        }

        rawJson += event.delta;
        await consumeTanStackPartialAnswer({
          rawJson,
          propertyIds,
          onPartialAnswer,
        });
      }

      if (output === undefined) {
        throw new WorkflowIntegrationError({
          message: "Workflow AI generation did not return structured output",
        });
      }

      return output;
    },
    catch: (error) => {
      aiAnalytics.captureError(error);

      return new WorkflowIntegrationError({
        message: "Workflow AI generation failed",
        cause: error,
      });
    },
  });
};
