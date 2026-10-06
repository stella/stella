import { toolDefinition } from "@tanstack/ai";
import { panic } from "better-result";
import type { Result } from "better-result";
import * as v from "valibot";

import {
  generatedVisualInputSchema,
  SHOW_VISUAL_TOOL_NAME,
} from "@stll/api-contract/generated-visual";

import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { raiseChatToolError } from "@/api/handlers/chat/tools/tool-failure";
import { prepareGeneratedVisual } from "@/api/handlers/visual-sandbox/prepare";
import type { PreparedGeneratedVisual } from "@/api/handlers/visual-sandbox/prepare";
import type { VisualResourceOrigin } from "@/api/handlers/visual-sandbox/resource-origin";
import type { SafeId } from "@/api/lib/branded-types";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";

type CreateShowVisualToolsOptions = {
  origin: VisualResourceOrigin;
  store: (
    visual: PreparedGeneratedVisual,
  ) => Promise<Result<SafeId<"userFile">, ChatToolError>>;
};

const showVisualOutputSchema = v.strictObject({
  success: v.literal(true),
  title: generatedVisualInputSchema.entries.title,
});

export const createShowVisualTools = ({
  origin,
  store,
}: CreateShowVisualToolsOptions) => ({
  [SHOW_VISUAL_TOOL_NAME]: toolDefinition({
    name: SHOW_VISUAL_TOOL_NAME,
    description:
      "Display an interactive Generated view in this chat. Supply a short title, HTML and finite JSON data. " +
      "Keep only data fields referenced literally by the page. Read them with stella.data. " +
      "Use stella.drill({court, year}) to offer a user-sent follow-up, stella.openDecision(linkId) for links " +
      "in the supplied links list, and stella.ready() once rendered. External links need user confirmation " +
      "and their complete URL must occur literally in the page. Scripts run locally in an isolated frame; " +
      "network requests, imports, frames, forms, SVG authoring and stylesheets are unavailable. " +
      "Style with stella-stack, stella-row, stella-card, stella-muted, stella-chart and stella-table classes; " +
      "stella-light and stella-dark select a color scheme. " +
      "On refusal, correct the indicated input and call again.",
    inputSchema: toTanStackToolSchema(generatedVisualInputSchema, {
      omitValidationActions: ["check"],
    }),
    outputSchema: toTanStackToolSchema(showVisualOutputSchema),
  }).server(async (input, context) => {
    if (!context?.toolCallId) {
      return panic("A visual tool requires its server execution context");
    }
    const parsed = v.safeParse(generatedVisualInputSchema, input);
    if (!parsed.success) {
      return raiseChatToolError(
        new ChatToolError({
          kind: "invalid-input",
          message:
            "Use a title within 120 characters, a page within 256 KB, and finite JSON data within 1 MB and 32 levels of nesting.",
        }),
      );
    }
    const prepared = prepareGeneratedVisual(parsed.output);
    if (prepared.isErr()) {
      return raiseChatToolError(
        new ChatToolError({
          kind: "invalid-input",
          message: prepared.error.message,
        }),
      );
    }
    const stored = await store(prepared.value);
    if (stored.isErr()) {
      return raiseChatToolError(stored.error);
    }
    const part = origin.issue({
      fileId: stored.value,
      title: prepared.value.title,
      toolCallId: context.toolCallId,
    });
    context.emitCustomEvent("ui-resource", part);
    return { success: true, title: prepared.value.title };
  }),
});
