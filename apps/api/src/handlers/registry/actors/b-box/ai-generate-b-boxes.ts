import { google, type GoogleGenerativeAIProviderOptions } from "@ai-sdk/google";
import { valibotSchema } from "@ai-sdk/valibot";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, Output } from "ai";
import { Result } from "better-result";

import { env } from "@/api/env";
import {
  BBOX_SYSTEM_PROMPT,
  bboxSchema,
  buildBBoxUserMessage,
} from "@/api/handlers/registry/actors/b-box/ai-prompts";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";

type GenerateBBoxDataProps = {
  pdfData: Uint8Array;
  prompt: string;
  fieldContent: string;
  justificationText: string;
  abortSignal: AbortSignal;
};

const getAIModel = () =>
  env.OPENROUTER_API_KEY
    ? createOpenRouter({
        apiKey: env.OPENROUTER_API_KEY,
      }).chat("google/gemini-3-flash-preview")
    : google("gemini-3-flash-preview");

export const generateBBoxData = ({
  pdfData,
  prompt,
  fieldContent,
  justificationText,
  abortSignal,
}: GenerateBBoxDataProps): Promise<
  Result<[number, number, number, number][], WorkflowIntegrationError>
> =>
  Result.tryPromise({
    try: async () => {
      const result = await generateText({
        model: getAIModel(),
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
      });

      return result.output;
    },
    catch: (error) =>
      new WorkflowIntegrationError({
        message: "BBox AI generation failed",
        cause: error,
      }),
  });
