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
import { splitPropertiesForBudget } from "@/api/lib/structured-output-budget";
import { markTanStackCacheBreakpoint } from "@/api/lib/tanstack-ai-caching";
import {
  resolveTanStackTextModel,
  streamTanStackObjectForRole,
  structuredOutputWireJsonSchema,
} from "@/api/lib/tanstack-ai-generate";
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
  // Resolved up front because the schema budget is a property of the provider,
  // not of the batch: the planner groups properties by dependency signature
  // and cannot know how many of them one request may carry.
  const model = Result.try({
    try: () =>
      resolveTanStackTextModel({ role: "pdf", orgAIConfig, organizationId }),
    catch: (error) =>
      new WorkflowIntegrationError({
        message: "Workflow AI model resolution failed",
        cause: error,
      }),
  });
  if (Result.isError(model)) {
    return Result.err(model.error);
  }
  const { provider, modelId } = model.value;

  const chunks = splitPropertiesForBudget({
    provider,
    modelId,
    properties,
    buildSchema: (chunkProperties) =>
      structuredOutputWireJsonSchema({
        outputSchema: buildBatchSchema(chunkProperties, filenames),
        provider,
      }),
  });
  if (Result.isError(chunks)) {
    return Result.err(
      new WorkflowIntegrationError({
        message:
          "A single workflow property does not fit the provider's structured-output budget",
        cause: chunks.error,
      }),
    );
  }

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

  // Every chunk sends the same `messageContent` prefix, so the cache
  // breakpoint above is warmed once and reused; only the prompt list and the
  // output schema narrow to the chunk.
  const runChunk = async (
    chunkProperties: AIBatchProperty[],
  ): Promise<Result<WorkflowDataOutput, WorkflowIntegrationError>> => {
    const aiAnalytics = createTanStackAIAnalyticsCallbacks(
      buildWorkflowAIAnalyticsProps({
        entityVersionId,
        organizationId,
        orgAIConfig: orgAIConfig ?? null,
        propertyCount: chunkProperties.length,
        usageMetering,
        workspaceId,
      }),
    );

    const chunkContent: WorkflowMessagePart[] = [
      ...messageContent,
      { type: "text", content: buildPromptsMessage(chunkProperties) },
    ];

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
          messages: [{ role: "user", content: chunkContent }],
          system: WORKFLOW_SYSTEM_PROMPT,
          abortSignal,
          outputSchema: buildBatchSchema(chunkProperties, filenames),
        });

        let rawJson = "";
        let output: WorkflowDataOutput | undefined;
        const propertyIds = chunkProperties.map((property) => property.id);

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

  // Recursion rather than a loop because the chunks must run strictly in
  // order, and only one at a time: the first chunk writes the shared prompt
  // prefix into the provider's cache and the rest read it, so overlapping
  // them would pay for that prefix once per chunk. Answers from earlier
  // chunks accumulate into `merged`; the first failure ends the batch.
  const chunkBatches = chunks.value;
  const runFromChunk = async (
    index: number,
    merged: WorkflowDataOutput,
  ): Promise<Result<WorkflowDataOutput, WorkflowIntegrationError>> => {
    const chunkProperties = chunkBatches.at(index);
    if (chunkProperties === undefined) {
      return Result.ok(merged);
    }

    const chunkOutput = await runChunk(chunkProperties);
    if (Result.isError(chunkOutput)) {
      return chunkOutput;
    }
    Object.assign(merged, chunkOutput.value);
    return await runFromChunk(index + 1, merged);
  };

  return await runFromChunk(0, {});
};
