import { valibotSchema } from "@ai-sdk/valibot";
import { generateText, Output } from "ai";
import type { FilePart, TextPart } from "ai";
import { Result } from "better-result";

import { getModelForRole, getTemperatureForRole } from "@/api/lib/ai-models";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import { createAIAnalyticsCallbacks } from "@/api/lib/analytics/ai";
import type { SafeId } from "@/api/lib/branded-types";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import {
  buildBatchSchema,
  buildPromptsMessage,
  buildTextInputsMessage,
  WORKFLOW_SYSTEM_PROMPT,
} from "@/api/lib/workflow/ai-prompts";
import type { Answer } from "@/api/lib/workflow/ai-prompts";
import type { TextInput } from "@/api/lib/workflow/generate-batch-shared";
import type { BatchProperty } from "@/api/lib/workflow/get-execution-plan";
import type { JustificationFilenames } from "@/api/lib/workflow/parse-justifications";

type WorkflowFile = {
  content: ArrayBuffer | Uint8Array;
  mimeType: string;
};

type GenerateWorkflowDataProps = {
  files: WorkflowFile[];
  properties: BatchProperty[];
  filenames: JustificationFilenames;
  textInputs: TextInput[];
  abortSignal: AbortSignal;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  entityVersionId: string;
  orgAIConfig?: OrgAIConfig | null;
};

type WorkflowDataOutput = Record<
  string,
  { answer: Answer; justification: string }
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
}: GenerateWorkflowDataProps): Promise<
  Result<WorkflowDataOutput, WorkflowIntegrationError>
> => {
  const schema = buildBatchSchema(properties, filenames);

  const messageContent: (FilePart | TextPart)[] = [];

  for (const file of files) {
    messageContent.push({
      type: "file",
      data: file.content,
      mediaType: file.mimeType,
    });
  }

  if (textInputs.length > 0) {
    messageContent.push({
      type: "text",
      text: buildTextInputsMessage(textInputs),
    });
  }

  messageContent.push({
    type: "text",
    text: buildPromptsMessage(properties),
  });

  const aiAnalytics = createAIAnalyticsCallbacks({
    feature: "workflow.generate-batch",
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
      const result = await generateText({
        model: getModelForRole("pdf", orgAIConfig),
        temperature: getTemperatureForRole("pdf"),
        messages: [{ role: "user", content: messageContent }],
        output: Output.object({ schema: valibotSchema(schema) }),
        system: WORKFLOW_SYSTEM_PROMPT,
        abortSignal,
        ...aiAnalytics.stepCallbacks,
      });

      return result.output;
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
