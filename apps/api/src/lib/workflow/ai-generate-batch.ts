import { valibotSchema } from "@ai-sdk/valibot";
import { Output, streamText } from "ai";
import type { FilePart, TextPart } from "ai";
import { Result } from "better-result";

import { markCacheBreakpoint } from "@/api/lib/ai-caching";
import { getModelForRole, resolveCaching } from "@/api/lib/ai-models";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import { createAIAnalyticsCallbacks } from "@/api/lib/analytics/ai";
import type { SafeId } from "@/api/lib/branded-types";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import {
  buildBatchSchema,
  buildDocxBlocksMessage,
  buildPromptsMessage,
  buildTextInputsMessage,
  WORKFLOW_SYSTEM_PROMPT,
} from "@/api/lib/workflow/ai-prompts";
import type { Answer } from "@/api/lib/workflow/ai-prompts";
import type { PreparedInputFile } from "@/api/lib/workflow/generate-batch";
import type { TextInput } from "@/api/lib/workflow/generate-batch-shared";
import type { BatchProperty } from "@/api/lib/workflow/get-execution-plan";
import type {
  AIJustificationOutput,
  JustificationFilenames,
} from "@/api/lib/workflow/parse-justifications";
import { consumePartialAnswers } from "@/api/lib/workflow/streaming-answer";
import type { PartialAnswerUpdate } from "@/api/lib/workflow/streaming-answer";

type GenerateWorkflowDataProps = {
  files: PreparedInputFile[];
  properties: BatchProperty[];
  filenames: JustificationFilenames;
  textInputs: TextInput[];
  abortSignal: AbortSignal;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  entityVersionId: string;
  orgAIConfig?: OrgAIConfig | null;
  promptCachingEnabled: boolean;
  onPartialAnswer?:
    | ((update: PartialAnswerUpdate) => Promise<void> | void)
    | undefined;
};

type WorkflowDataOutput = Record<
  string,
  { answer: Answer; justification: AIJustificationOutput }
>;

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

  const messageContent: (FilePart | TextPart)[] = [];

  for (const file of files) {
    if (file.kind === "pdf") {
      messageContent.push({
        type: "file",
        data: file.content,
        mediaType: file.mimeType,
      });
      continue;
    }
    // DOCX: serialise folio blocks inline. The model cites block
    // ids back in `justification.citations` instead of bates stamps.
    messageContent.push({
      type: "text",
      text: buildDocxBlocksMessage({
        simplifiedName: file.simplifiedName,
        blocks: file.blocks,
      }),
    });
  }

  if (textInputs.length > 0) {
    messageContent.push({
      type: "text",
      text: buildTextInputsMessage(textInputs),
    });
  }

  const lastStaticIdx = messageContent.length - 1;
  if (lastStaticIdx >= 0) {
    const lastStatic = messageContent[lastStaticIdx];
    if (lastStatic) {
      messageContent[lastStaticIdx] = markCacheBreakpoint(lastStatic, {
        decision: cachingDecision,
      });
    }
  }

  messageContent.push({
    type: "text",
    text: buildPromptsMessage(properties),
  });

  const aiAnalytics = createAIAnalyticsCallbacks({
    feature: "workflow.generate-batch",
    modelRole: "pdf",
    orgAIConfig: orgAIConfig ?? null,
    properties: {
      entity_version_id: entityVersionId,
      organization_id: organizationId,
      property_count: properties.length,
      workspace_id: workspaceId,
    },
    sessionId: entityVersionId,
    traceId: Bun.randomUUIDv7(),
  });

  return await Result.tryPromise({
    try: async () => {
      const result = streamText({
        model: getModelForRole("pdf", orgAIConfig, {
          promptCachingEnabled,
          scopeKey: entityVersionId,
          organizationId,
        }),
        messages: [{ role: "user", content: messageContent }],
        output: Output.object({ schema: valibotSchema(schema) }),
        system: WORKFLOW_SYSTEM_PROMPT,
        abortSignal,
        ...aiAnalytics.stepCallbacks,
      });

      const partialAnswerTask = onPartialAnswer
        ? consumePartialAnswers({
            partialOutputs: result.partialOutputStream,
            propertyIds: properties.map((property) => property.id),
            onPartialAnswer,
          }).catch((error: unknown) => {
            aiAnalytics.captureError(error);
          })
        : Promise.resolve();

      try {
        return await result.output;
      } finally {
        await partialAnswerTask;
      }
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
