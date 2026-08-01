import type { chatToolMapToArray } from "@/api/lib/chat/chat-tool-types";
import { providerSafeJsonSchemaOptionsForTanStackProvider } from "@/api/lib/provider-safe-json-schema";
import { projectSchemaInputJsonSchema } from "@/api/lib/tanstack-ai-schema";

export const projectChatToolSchemasForProvider = ({
  modelTools,
  provider,
}: {
  modelTools: ReturnType<typeof chatToolMapToArray>;
  provider: string;
}): ReturnType<typeof chatToolMapToArray> => {
  const projectionOptions =
    providerSafeJsonSchemaOptionsForTanStackProvider(provider);
  const projectedTools: ReturnType<typeof chatToolMapToArray> = [];
  for (const tool of modelTools) {
    const projectedTool = { ...tool };
    if (tool.inputSchema !== undefined) {
      const inputSchema = projectSchemaInputJsonSchema(
        tool.inputSchema,
        projectionOptions,
      );
      if (inputSchema !== undefined) {
        projectedTool.inputSchema = inputSchema;
      }
    }
    if (tool.outputSchema !== undefined) {
      const outputSchema = projectSchemaInputJsonSchema(
        tool.outputSchema,
        projectionOptions,
      );
      if (outputSchema !== undefined) {
        projectedTool.outputSchema = outputSchema;
      }
    }
    projectedTools.push(projectedTool);
  }
  return projectedTools;
};
