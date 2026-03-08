import { valibotSchema } from "@ai-sdk/valibot";
import { generateText, Output, type FilePart, type TextPart } from "ai";
import { Result } from "better-result";

import {
  buildBatchSchema,
  buildPromptsMessage,
  buildTextInputsMessage,
  WORKFLOW_SYSTEM_PROMPT,
  type Answer,
} from "@/api/handlers/registry/actors/workflow/ai-prompts";
import type { TextInput } from "@/api/handlers/registry/actors/workflow/generate-batch-shared";
import type { BatchProperty } from "@/api/handlers/registry/actors/workflow/get-execution-plan";
import type { JustificationFilenames } from "@/api/handlers/registry/actors/workflow/parse-justifications";
import { getModel, PDF_NATIVE_MODEL } from "@/api/lib/ai-models";
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
};

export type WorkflowDataOutput = Record<
  string,
  { answer: Answer; justification: string }
>;

export const generateWorkflowData = ({
  files,
  properties,
  filenames,
  textInputs,
  abortSignal,
}: GenerateWorkflowDataProps): Promise<
  Result<WorkflowDataOutput, WorkflowIntegrationError>
> => {
  const schema = buildBatchSchema(properties, filenames);

  const messageContent: Array<FilePart | TextPart> = [];

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

  return Result.tryPromise({
    try: async () => {
      const result = await generateText({
        model: getModel(PDF_NATIVE_MODEL),
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
