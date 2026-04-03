import { valibotSchema } from "@ai-sdk/valibot";
import { generateText, Output } from "ai";
import type { FilePart, TextPart } from "ai";
import { Result } from "better-result";

import {
  buildBatchSchema,
  buildPromptsMessage,
  buildTextInputsMessage,
  WORKFLOW_SYSTEM_PROMPT,
} from "@/api/handlers/registry/actors/workflow/ai-prompts";
import type { Answer } from "@/api/handlers/registry/actors/workflow/ai-prompts";
import type { TextInput } from "@/api/handlers/registry/actors/workflow/generate-batch-shared";
import type { BatchProperty } from "@/api/handlers/registry/actors/workflow/get-execution-plan";
import type { JustificationFilenames } from "@/api/handlers/registry/actors/workflow/parse-justifications";
import { getModelForRole } from "@/api/lib/ai-models";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";

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

  return await Result.tryPromise({
    try: async () => {
      const result = await generateText({
        model: getModelForRole("pdf", orgAIConfig),
        messages: [{ role: "user", content: messageContent }],
        output: Output.object({ schema: valibotSchema(schema) }),
        system: WORKFLOW_SYSTEM_PROMPT,
        abortSignal,
      });

      return result.output;
    },
    catch: (error) =>
      new WorkflowIntegrationError({
        message: "Workflow AI generation failed",
        cause: error,
      }),
  });
};
